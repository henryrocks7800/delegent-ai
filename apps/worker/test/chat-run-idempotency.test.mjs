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
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_runner_secret_legacy_only_for_other_paths',
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
// Models the atomic RPC contract. SQL-level concurrency is tested separately;
// this suite proves the Worker dispatches only the winning claim.
function handlers(state) {
  const isoNow = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () => new Response(JSON.stringify({ id: USER_ID })) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: isoNow, last_health_at: isoNow, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url), respond: () => new Response(JSON.stringify({ object: 'hermes.api_server.capabilities', available: true, features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } }), { status: 200 }) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/claim_chat_message$/), respond: ({ init }) => {
      if (state.claimFailure) return Response.json({ error: 'database_unavailable' }, { status: 503 });
      const key = JSON.parse(init.body).p_client_run_id;
      if (key && state.byKey[key]) return Response.json([{ ...state.byKey[key], claimed: false }]);
      state.enqueue += 1;
      const row = { conversation_id: USER_ID, user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999', task_run_id: RUN_ID, claimed: true };
      if (key) state.byKey[key] = row;
      return Response.json([row]);
    } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url), respond: () => { state.runs += 1; return new Response(JSON.stringify({ run_id: 'hermes_run_abc', status: 'started' }), { status: 201 }); } },
    // task_runs PATCH: persistHermesRunId (runner_task_id) AND the idempotency store (client_run_id).
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: ({ init }) => {
        const b = init.body ? JSON.parse(String(init.body)) : {};
        assert.equal(b.client_run_id, undefined, 'idempotency must never be written after dispatch');
        return new Response('[]', { status: 200 });
      } },
  ];
}
function send(clientRunId) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'research the 3 best robot vacuums under 300', conversationId: USER_ID, clientRunId }) };
}
async function fire(state, clientRunId) {
  const ctx = ctxStub();
  const resp = await worker.fetch(authedRequest('/api/chat/runs', send(clientRunId)), ENV, ctx);
  await ctx.settle();
  return resp;
}

test('CONTROL: a single chat-run create enqueues once and dispatches /v1/runs once', async () => {
  const state = { enqueue: 0, runs: 0, byKey: {} };
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await fire(state, 'run-A');
    assert.equal(resp.status, 201);
    assert.equal(state.enqueue, 1, 'one enqueue for one send');
    assert.equal(state.runs, 1, 'one /v1/runs dispatch for one send');
  } finally { globalThis.fetch = original; }
});

test('FIXED #1 — two sends with the SAME clientRunId enqueue + dispatch exactly ONCE (idempotent replay)', async () => {
  const state = { enqueue: 0, runs: 0, byKey: {} };
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const r1 = await fire(state, 'dup-key-123');
    assert.equal(r1.status, 201, 'first send dispatches');
    // The retry — identical clientRunId (mobile timeout / re-tap / network replay).
    const r2 = await fire(state, 'dup-key-123');
    assert.ok(r2.status === 200 || r2.status === 201, 'retry returns a run, not an error');
    assert.equal(state.enqueue, 1, 'a repeated clientRunId must NOT create a second user message / task_run');
    assert.equal(state.runs, 1, 'a repeated clientRunId must NOT start a second runner run (no double tokens)');
    const body2 = await r2.json();
    assert.equal(body2.runId, RUN_ID, 'the retry replays the SAME run id');
  } finally { globalThis.fetch = original; }
});

test('a DIFFERENT clientRunId is a genuinely new send (dedup is per-key, not a global lock)', async () => {
  const state = { enqueue: 0, runs: 0, byKey: {} };
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    await fire(state, 'key-1');
    await fire(state, 'key-2');
    assert.equal(state.enqueue, 2, 'distinct keys each enqueue');
    assert.equal(state.runs, 2, 'distinct keys each dispatch');
  } finally { globalThis.fetch = original; }
});

test('sixteen concurrent retries dispatch only the claim winner', async () => {
  const state = { enqueue: 0, runs: 0, byKey: {} };
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const responses = await Promise.all(Array.from({ length: 16 }, () => fire(state, 'concurrent-key')));
    assert.equal(state.enqueue, 1);
    assert.equal(state.runs, 1);
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.ok(bodies.every(b => b.runId === RUN_ID));
  } finally { globalThis.fetch = original; }
});
test('a failed durable claim never dispatches a task', async () => {
  const state = { enqueue: 0, runs: 0, byKey: {}, claimFailure: true };
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const response = await fire(state, 'key');
    assert.equal(response.status, 502);
    assert.equal(state.runs, 0);
  } finally { globalThis.fetch = original; }
});
