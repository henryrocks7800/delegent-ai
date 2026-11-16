// 2026-07-09 live incident (paying user, 2 consecutive turns) — the Route B
// dispatch fetch (POST runner /v1/delegent/message) had NO timeout. When the
// Fly proxy black-holed the request (machine mid-autostop-transition), the
// dispatch hung indefinitely: the run never bound a runner id, the app showed
// "working..." and the stale sweeper reaped it as runner_timeout 12-15 minutes
// later, surfacing as "took too long and I've stopped waiting".
//
// Contract locked here:
//   1. The dispatch carries an AbortSignal and gives up after the configured
//      timeout (test override: SIDEKICK_DELEGENT_DISPATCH_TIMEOUT_MS).
//   2. On timeout the run is finalized IMMEDIATELY as runner_unreachable with
//      retryable copy — never left queued for the sweeper.
//   3. No legacy /v1/runs fallback on an unreachable box (same black hole,
//      and the legacy path is memory-less for a Route B user).
//   4. A 404 (platform not rolled out) still falls back to legacy /v1/runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ENV = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true',
  SIDEKICK_DELEGENT_DISPATCH_TIMEOUT_MS: '80',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_runner_secret',
  OPENROUTER_API_KEY: 'sk-or-test-fake',
};

function ctxStub() {
  const p = [];
  return { waitUntil(x) { p.push(Promise.resolve(x).catch(() => {})); }, async settle() { await Promise.all(p); } };
}
function matchUrl(method, regex) { return ({ url, method: m }) => m === method && regex.test(url); }
function makeFakeFetch(handlers) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    for (const h of handlers) { if (h.match({ url, method, init })) return h.respond({ url, method, init }); }
    return new Response(JSON.stringify({ error: 'unmatched', url, method }), { status: 500 });
  };
}
function authedRequest(path, init = {}) {
  return new Request(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${USER_JWT}` } });
}

// `mode` shapes the delegent/message endpoint: 'hang' never responds (but
// honors the abort signal, like a real fetch), '404' says platform-not-enabled,
// 'ok' accepts the run.
function handlers(state, mode) {
  const isoNow = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () => new Response(JSON.stringify({ id: USER_ID })) },
    { match: ({ method, url }) => method === 'GET' && /\/rest\/v1\/task_runs\?.*client_run_id=eq\./.test(url), respond: () => new Response('[]') },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: isoNow, last_health_at: isoNow, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url), respond: () => new Response(JSON.stringify({ object: 'hermes.api_server.capabilities', available: true, features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } }), { status: 200 }) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Marcelo' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () => new Response(JSON.stringify([{ conversation_id: USER_ID, claimed: true, user_message_id: '88888888-8888-4888-8888-888888888888', assistant_message_id: '99999999-9999-4999-8999-999999999999', task_run_id: RUN_ID }])) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      state.finalized.push(JSON.parse(String(init.body)));
      return new Response('[]', { status: 200 });
    } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/delegent\/message$/.test(url), respond: ({ init }) => {
      state.delegentPosts += 1;
      if (mode === '404') return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      if (mode === 'ok') return new Response(JSON.stringify({ run_id: 'run_ok123' }), { status: 200 });
      // hang: never respond, but honor the abort signal like a real fetch.
      return new Promise((_resolve, reject) => {
        if (!init.signal) {
          reject(new Error('REGRESSION: dispatch fetch carried no AbortSignal'));
          return;
        }
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation timed out');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url), respond: () => { state.legacyRuns += 1; return new Response(JSON.stringify({ run_id: 'hermes_run_legacy', status: 'started' }), { status: 201 }); } },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url), respond: () => new Response('[]', { status: 200 }) },
  ];
}

async function fire(state, mode) {
  const ctx = ctxStub();
  const original = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers(state, mode));
  // Node quirk: AbortSignal.timeout()'s internal timer is unref'd, so during
  // the hang case NOTHING ref'd remains and node:test cancels the run with
  // "promise resolution is still pending". A ref'd no-op interval keeps the
  // loop alive until the abort fires. (Cloudflare workerd is unaffected.)
  const keepalive = setInterval(() => {}, 20);
  try {
    const resp = await worker.fetch(authedRequest('/api/chat/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'have you done it?', conversationId: USER_ID }),
    }), ENV, ctx);
    await ctx.settle();
    return resp;
  } finally {
    clearInterval(keepalive);
    globalThis.fetch = original;
  }
}

test('a black-holed delegent dispatch fails FAST as runner_unreachable (no sweeper rot, no legacy fallback)', async () => {
  const state = { delegentPosts: 0, legacyRuns: 0, finalized: [] };
  const started = Date.now();
  const resp = await fire(state, 'hang');
  const elapsed = Date.now() - started;

  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.runId, RUN_ID);
  assert.ok(elapsed < 5_000, `dispatch must give up at the configured timeout, took ${elapsed}ms`);
  assert.equal(state.delegentPosts, 1);
  assert.equal(state.legacyRuns, 0, 'an unreachable box must NOT trigger the legacy fallback');
  assert.equal(state.finalized.length, 1, 'the run must be finalized immediately');
  assert.equal(state.finalized[0].p_succeeded, false);
  assert.equal(state.finalized[0].p_error_code, 'runner_unreachable');
  assert.match(state.finalized[0].p_content, /coworker just now|waking up/i);
});

test('a missing Route B endpoint fails without bypassing durable memory', async () => {
  const state = { delegentPosts: 0, legacyRuns: 0, finalized: [] };
  const resp = await fire(state, '404');
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.status, 'failed');
  assert.equal(state.delegentPosts, 1);
  assert.equal(state.legacyRuns, 0, 'no stateless fallback for a Route B workspace');
  assert.equal(state.finalized.length, 1);
});

test('CONTROL: a healthy delegent dispatch starts the run with no legacy call and no finalize', async () => {
  const state = { delegentPosts: 0, legacyRuns: 0, finalized: [] };
  const resp = await fire(state, 'ok');
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.status, 'started');
  assert.equal(state.delegentPosts, 1);
  assert.equal(state.legacyRuns, 0);
  assert.equal(state.finalized.length, 0);
});
