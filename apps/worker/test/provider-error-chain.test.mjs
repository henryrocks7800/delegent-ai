// 2026-07-04 "model provider failed after retries" incident — regression locks
// for the full failure chain (docs: HANDOVER_2026-07-06.md task B):
//   1. requireSidekickRunnerAuth: a transient Supabase failure of the per-call
//      per-user secret lookup must surface as a retryable 503
//      (RunnerAuthUnavailableError), NOT the generic 401 — and the lookup gets
//      one quick retry so a single dropped request never fails the turn.
//   2. proxyChatCompletion(+Streaming): upstream model failures are logged +
//      shipped to Sentry (they used to be recorded NOWHERE), 429 passes
//      through with retry-after so the runner backs off honestly, everything
//      else stays an opaque 502, and the reservation is released.
//   3. finalizeChatRun: the Hermes gateway's canned provider-error tail is
//      collapsed (incl. the observed duplicate) and translated to Delegent
//      copy — "check gateway logs" must never reach a user bubble.
//   4. createDelegentTranslator: a replayed identical `send` frame must not
//      double the committed text (the duplicate-error mechanism).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  RunnerAuthUnavailableError,
  requireSidekickRunnerAuth,
  signRunnerTokenV1,
  collapseGatewayProviderErrorTail,
  GATEWAY_PROVIDER_ERROR_SAFE_COPY,
  sanitizeAssistantReply,
  DN1_4_01_SAFE_COPY,
  createDelegentTranslator,
} from '../dist/index.js';

const USER_ID = 'a0000000-1230-4123-8123-000000000123';
const NOW = new Date('2026-07-06T12:00:00Z');
const NOW_SECS = Math.floor(NOW.getTime() / 1000);

const V1_ENV = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  OPENROUTER_API_KEY: 'or_test',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret_unused',
  // NO SIDEKICK_RUNNER_AUTH_LEGACY: prod posture — per-user secret only.
};

const LEGACY_ENV = { ...V1_ENV, SIDEKICK_RUNNER_AUTH_LEGACY: 'true' };

function jsonRes(data, { ok = true, status = 200, headers = {} } = {}) {
  // Real Headers: the proxy path hands upstream.headers to debugHeaderPairs
  // during argument evaluation, so a bare {get} stub reroutes the code path.
  return {
    ok,
    status,
    headers: new Headers(headers),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeCtx() {
  const waited = [];
  return { ctx: { waitUntil: (p) => waited.push(Promise.resolve(p).catch(() => {})) }, waited };
}

async function v1Headers(secret, userId = USER_ID, timestamp = NOW_SECS) {
  return new Headers({
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': String(timestamp),
    'x-sidekick-runner-token': await signRunnerTokenV1(secret, userId, timestamp),
  });
}

// ---------------------------------------------------------------------------
// 1. Auth lookup failure classification
// ---------------------------------------------------------------------------

test('auth: secret-lookup infra failure (both attempts) throws RunnerAuthUnavailableError', async () => {
  const original = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/hermes_instance_private')) {
      lookups += 1;
      throw new Error('supabase down');
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      requireSidekickRunnerAuth(await v1Headers('per_user_secret'), V1_ENV, NOW),
      RunnerAuthUnavailableError,
    );
    assert.equal(lookups, 2, 'the lookup must be retried once before giving up');
  } finally {
    globalThis.fetch = original;
  }
});

test('auth: secret lookup failing once then succeeding authenticates normally', async () => {
  const original = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/hermes_instance_private')) {
      lookups += 1;
      if (lookups === 1) throw new Error('supabase blip');
      return new Response(JSON.stringify([{ runner_shared_secret: 'per_user_secret' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const userId = await requireSidekickRunnerAuth(await v1Headers('per_user_secret'), V1_ENV, NOW);
    assert.equal(userId, USER_ID);
    assert.equal(lookups, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('auth: a genuinely wrong token stays a generic 401-class error, not unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/hermes_instance_private')) {
      return new Response(JSON.stringify([{ runner_shared_secret: 'per_user_secret' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      requireSidekickRunnerAuth(await v1Headers('the_wrong_secret'), V1_ENV, NOW),
      (err) => err instanceof Error && !(err instanceof RunnerAuthUnavailableError)
        && /valid Sidekick runner token required/.test(err.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('auth: full path — lookup outage returns 503 with retryable copy (was a silent 401)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/hermes_instance_private')) throw new Error('supabase down');
    return jsonRes([]);
  };
  const { ctx } = makeCtx();
  try {
    // Signed against the REAL clock: the router's skew check runs before the
    // lookup, so a stale fixture timestamp would 401 out early.
    const freshHeaders = await v1Headers('per_user_secret', USER_ID, Math.floor(Date.now() / 1000));
    const request = new Request('https://worker.sidekick.test/v1/chat/completions', {
      method: 'POST',
      headers: Object.fromEntries(freshHeaders.entries()),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = await worker.fetch(request, V1_ENV, ctx);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'authorization is temporarily unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 2. Upstream failure mapping + observability
// ---------------------------------------------------------------------------

function chatRequest(stream) {
  return new Request('https://worker.sidekick.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidekick-user-id': USER_ID,
      'x-sidekick-runner-token': LEGACY_ENV.SIDEKICK_RUNNER_SHARED_SECRET,
    },
    body: JSON.stringify({ stream, messages: [{ role: 'user', content: 'hello' }] }),
  });
}

// Mock Supabase gate chain + OpenRouter + Sentry. Returns recorded state.
function installFetch(openrouter) {
  const state = { sentryEnvelopes: 0, releases: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('openrouter.ai')) return openrouter();
    if (u.includes('errors.sentry.test')) { state.sentryEnvelopes += 1; return jsonRes({}); }
    if (u.includes('/rest/v1/rpc/reserve_chat_tokens')) return jsonRes([{ allowed: true, reservation_id: 'res-1' }]);
    if (u.includes('/rest/v1/token_usage_events')) {
      if (method === 'PATCH') { state.releases += 1; return jsonRes([{ id: 'res-1' }]); }
      return jsonRes([]);
    }
    if (u.includes('/rest/v1/usage_quotas')) return jsonRes([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office', billing_cycle_anchor: null }]);
    if (u.includes('/rest/v1/subscriptions')) return jsonRes([{ status: 'active' }]);
    return jsonRes([]);
  };
  return { state, restore: () => { globalThis.fetch = original; } };
}

const SENTRY_ENV = { ...LEGACY_ENV, SENTRY_DSN: 'https://k1@errors.sentry.test/42' };

test('proxy: upstream 429 passes through with retry-after and releases the reservation', async () => {
  const { ctx, waited } = makeCtx();
  const f = installFetch(() => jsonRes({ error: { code: 429, message: 'rate limited' } }, { ok: false, status: 429, headers: { 'retry-after': '7' } }));
  try {
    const res = await worker.fetch(chatRequest(false), SENTRY_ENV, ctx);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '7');
    const body = await res.json();
    assert.equal(body.error, 'model request failed');
    await Promise.all(waited);
    assert.equal(f.state.releases, 1, 'reservation must be released on upstream failure');
    assert.equal(f.state.sentryEnvelopes, 1, 'the failure must reach Sentry');
  } finally { f.restore(); }
});

test('proxy: upstream 500 maps to opaque 502 and reaches Sentry', async () => {
  const { ctx, waited } = makeCtx();
  const f = installFetch(() => jsonRes({ error: { code: 500, message: 'internal' } }, { ok: false, status: 500 }));
  try {
    const res = await worker.fetch(chatRequest(false), SENTRY_ENV, ctx);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'model request failed');
    await Promise.all(waited);
    assert.equal(f.state.sentryEnvelopes, 1);
  } finally { f.restore(); }
});

test('proxy: streaming upstream 429 passes through with retry-after', async () => {
  const { ctx, waited } = makeCtx();
  const f = installFetch(() => jsonRes({ error: { code: 429, message: 'rate limited' } }, { ok: false, status: 429, headers: { 'retry-after': '11' } }));
  try {
    const res = await worker.fetch(chatRequest(true), SENTRY_ENV, ctx);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '11');
    await Promise.all(waited);
    assert.equal(f.state.releases, 1);
    assert.equal(f.state.sentryEnvelopes, 1);
  } finally { f.restore(); }
});

async function drainStream(res, waited) {
  const reader = res.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  await Promise.all(waited);
}

test('proxy: an upstream 200 stream with ZERO data frames is captured to Sentry (the invisible 2026-07-04 shape)', async () => {
  const { ctx, waited } = makeCtx();
  const enc = new TextEncoder();
  const emptyBody = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode(': keepalive only\n\n')); controller.close(); },
  });
  const f = installFetch(() => ({ ok: true, status: 200, body: emptyBody, headers: { get: () => null } }));
  try {
    const res = await worker.fetch(chatRequest(true), SENTRY_ENV, ctx);
    assert.equal(res.status, 200);
    await drainStream(res, waited);
    assert.equal(f.state.sentryEnvelopes, 1, 'empty stream must be visible to operators');
  } finally { f.restore(); }
});

test('proxy: a [DONE]-only stream (no completion content) still trips the empty-stream telemetry', async () => {
  const { ctx, waited } = makeCtx();
  const enc = new TextEncoder();
  const doneOnlyBody = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode('data: [DONE]\n\n')); controller.close(); },
  });
  const f = installFetch(() => ({ ok: true, status: 200, body: doneOnlyBody, headers: { get: () => null } }));
  try {
    const res = await worker.fetch(chatRequest(true), SENTRY_ENV, ctx);
    assert.equal(res.status, 200);
    await drainStream(res, waited);
    assert.equal(f.state.sentryEnvelopes, 1, 'a [DONE]-only stream is still an empty completion');
  } finally { f.restore(); }
});

test('proxy: a stream WITH content frames does not false-positive the empty-stream telemetry', async () => {
  const { ctx, waited } = makeCtx();
  const enc = new TextEncoder();
  const okBody = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + '\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const f = installFetch(() => ({ ok: true, status: 200, body: okBody, headers: { get: () => null } }));
  try {
    const res = await worker.fetch(chatRequest(true), SENTRY_ENV, ctx);
    assert.equal(res.status, 200);
    await drainStream(res, waited);
    assert.equal(f.state.sentryEnvelopes, 0, 'healthy streams must not spam Sentry');
  } finally { f.restore(); }
});

// ---------------------------------------------------------------------------
// 3. Gateway provider-error tail collapse + translation
// ---------------------------------------------------------------------------

const GATEWAY_FAILED_TAIL = '⚠️ The model provider failed after retries. I kept raw provider details out of chat; check gateway logs for diagnostics.';
const GATEWAY_RATE_TAIL = '⏱️ The model provider is rate-limiting requests. Please wait a moment and try again.';

test('collapse: the observed incident shape — narration + DOUBLED error tail → narration + one Delegent line', () => {
  const narration = '📋 Updating tasks planning 4 task(s)\n💻 Running uvicorn app:app --host 0.0.0.0';
  const out = collapseGatewayProviderErrorTail(`${narration}${GATEWAY_FAILED_TAIL}${GATEWAY_FAILED_TAIL}`);
  assert.equal(out.collapsed, true);
  assert.equal(out.text, `${narration}\n\n${GATEWAY_PROVIDER_ERROR_SAFE_COPY}`);
  assert.doesNotMatch(out.text, /gateway|provider/i);
});

test('collapse: a single tail and a rate-limit tail both translate', () => {
  const single = collapseGatewayProviderErrorTail(`hello${GATEWAY_FAILED_TAIL}`);
  assert.equal(single.collapsed, true);
  assert.match(single.text, /^hello\n\n/);
  const rate = collapseGatewayProviderErrorTail(`hi ${GATEWAY_RATE_TAIL}`);
  assert.equal(rate.collapsed, true);
  assert.doesNotMatch(rate.text, /rate-limiting/);
});

test('collapse: a tail-only bubble becomes exactly the Delegent copy', () => {
  const out = collapseGatewayProviderErrorTail(GATEWAY_FAILED_TAIL);
  assert.equal(out.text, GATEWAY_PROVIDER_ERROR_SAFE_COPY);
});

test('collapse: ordinary content (even mentioning providers mid-text) is untouched', () => {
  const content = 'The model provider failed after retries is an error some apps show. Anyway, here is your answer: 42.';
  const out = collapseGatewayProviderErrorTail(content);
  assert.equal(out.collapsed, false);
  assert.equal(out.text, content);
});

test('sanitize: gateway canned copy now trips the short-reply banner sanitizer too', () => {
  const out = sanitizeAssistantReply(GATEWAY_FAILED_TAIL);
  assert.equal(out.replaced, true);
  assert.equal(out.text, DN1_4_01_SAFE_COPY);
});

// ---------------------------------------------------------------------------
// 4. Translator replay guard
// ---------------------------------------------------------------------------

test('translator: a replayed identical send frame does not double the text', () => {
  const t = createDelegentTranslator('run-1');
  t.push({ kind: 'send', text: 'first bubble', final: true });
  const replay = t.push({ kind: 'send', text: 'first bubble', final: true });
  assert.deepEqual(replay, []);
  assert.equal(t.finalText, 'first bubble');
  // A genuinely new bubble still commits the prior one (2026-07-22: with the
  // blank-line bubble separator).
  const next = t.push({ kind: 'send', text: 'second bubble', final: true });
  assert.equal(t.finalText, 'first bubble\n\nsecond bubble');
  assert.equal(next.length, 1);
});
