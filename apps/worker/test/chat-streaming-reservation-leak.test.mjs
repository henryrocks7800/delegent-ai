// DEFECT HUNT 2026-06-05 — streaming model-proxy reservation leak (hypothesis #2).
// ---------------------------------------------------------------------------
// proxyChatCompletion() reserves a FULL-estimate `worker_reservation` row
// (reserve_chat_tokens) BEFORE the model call (index.ts ~3024). For stream:true
// it then hands off to proxyChatCompletionStreaming(), which reconciles that
// reservation to the actual usage ONLY when it parses a usage chunk out of the
// SSE (index.ts ~3210-3214, via ctx.waitUntil). Every OTHER exit leaks the
// reservation until the 10-min reclaim sweeper (DEFECT E backstop):
//   - the SSE ends without a usage chunk (a fallback provider that doesn't
//     honour stream_options.include_usage — DeepInfra pin allow_fallbacks=true,
//     and the 06-04 log already saw a fall back to Io Net),
//   - the upstream returns !ok and the proxy early-returns 502 with no release,
//   - the stream breaks mid-flight / the client disconnects before the usage chunk.
// fetchUsageSnapshot sums token_usage_events.total_tokens with NO source filter,
// so a phantom reservation eats the user's quota for up to 10 minutes. The
// non-streaming path always reconciles (index.ts ~3141), so this is streaming-
// specific. Fix: release/reconcile the reservation on EVERY terminal exit of the
// streaming proxy, not just on a usage chunk.
//
// These black-box the REAL worker (worker.fetch) with a mocked OpenRouter + a
// mocked Supabase. The CONTROL test locks the good path; the two DEFECT tests
// are {todo} (they fail today, proving the leak, without reddening `npm test`)
// — drop the todo flag when the fix lands to make them hard regression gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const ENV = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  OPENROUTER_API_KEY: 'or_test',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  SIDEKICK_RUNNER_AUTH_LEGACY: 'true',
};

function jsonRes(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function sseStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}
function streamRes(chunks, { ok = true, status = 200 } = {}) {
  return { ok, status, body: ok ? sseStream(chunks) : null };
}
function makeCtx() {
  const waited = [];
  return { ctx: { waitUntil: (p) => waited.push(Promise.resolve(p)) }, waited };
}
function streamRequest() {
  return new Request('https://worker.sidekick.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
      'x-sidekick-runner-token': ENV.SIDEKICK_RUNNER_SHARED_SECRET,
    },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });
}
// Mock router: records any PATCH to token_usage_events (= reconcile/release of
// the reservation). `openrouter` is a thunk so each test sets the upstream shape.
function installFetch(openrouter) {
  const reconcilePatches = [];
  const settlements = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('openrouter.ai')) return openrouter();
    if (u.includes('/rest/v1/rpc/reserve_chat_tokens')) return jsonRes([{ allowed: true, reservation_id: 'res-1' }]);
    if (u.includes('/rest/v1/rpc/settle_chat_usage')) {
      settlements.push(JSON.parse(init.body));
      return jsonRes(true);
    }
    if (u.includes('/rest/v1/token_usage_events')) {
      if (method === 'PATCH') { reconcilePatches.push({ url: u, body: init.body }); return jsonRes([{ id: 'res-1' }]); }
      return jsonRes([]); // usage snapshot: no prior usage this cycle
    }
    if (u.includes('/rest/v1/usage_quotas')) return jsonRes([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office', billing_cycle_anchor: null }]);
    if (u.includes('/rest/v1/subscriptions')) return jsonRes([{ status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
    return jsonRes([]); // billing guard / subscriptions / debug capture → benign
  };
  return { reconcilePatches, settlements, restore: () => { globalThis.fetch = original; } };
}
async function drain(res, waited) {
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
  }
  await Promise.all(waited);
}

const TEXT_CHUNK = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hi' } }] }) + '\n\n';
const USAGE_CHUNK = 'data: ' + JSON.stringify({
  id: 'x', choices: [],
  usage: { prompt_tokens: 5000, completion_tokens: 200, total_tokens: 5200, prompt_tokens_details: { cached_tokens: 4800 } },
}) + '\n\n';
const DONE = 'data: [DONE]\n\n';

test('CONTROL: a streaming response WITH a usage chunk reconciles the reservation (locks the good path)', async () => {
  const { ctx, waited } = makeCtx();
  const f = installFetch(() => streamRes([TEXT_CHUNK, USAGE_CHUNK, DONE]));
  try {
    const res = await worker.fetch(streamRequest(), ENV, ctx);
    assert.equal(res.status, 200);
    await drain(res, waited);
    assert.equal(f.settlements.length, 1, 'a usage chunk must settle the original reservation once');
    assert.equal(f.settlements[0].p_reservation_id, 'res-1');
    assert.equal(f.settlements[0].p_user_id, 'a0000000-1230-4123-8123-000000000123');
    assert.equal(f.settlements[0].p_prompt_tokens, 5000);
    assert.equal(f.settlements[0].p_completion_tokens, 200);
    assert.equal(f.settlements[0].p_cached_tokens, 4800);
    assert.equal(f.reconcilePatches.length, 0, 'settled usage must not be released');
  } finally { f.restore(); }
});

test('FIXED #2 — a streaming response with NO usage chunk releases the reservation immediately (no phantom quota)',
  async () => {
    const { ctx, waited } = makeCtx();
    const f = installFetch(() => streamRes([TEXT_CHUNK, DONE])); // fallback provider dropped the usage chunk
    try {
      const res = await worker.fetch(streamRequest(), ENV, ctx);
      assert.equal(res.status, 200);
      await drain(res, waited);
      assert.equal(f.reconcilePatches.length, 1, 'a no-usage stream must STILL release the reservation immediately');
    } finally { f.restore(); }
  });

test('FIXED #2b — a streaming upstream error (502) releases the reservation (no leak on the error path)',
  async () => {
    const { ctx, waited } = makeCtx();
    const f = installFetch(() => streamRes([], { ok: false, status: 502 }));
    try {
      const res = await worker.fetch(streamRequest(), ENV, ctx);
      assert.equal(res.status, 502);
      await drain(res, waited);
      assert.equal(f.reconcilePatches.length, 1, 'an upstream error must release the reservation, not leave it phantom');
    } finally { f.restore(); }
  });
