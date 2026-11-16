// FRESH-CHAT CONTROL 2026-07-23 — the "Start fresh chat" button.
// ---------------------------------------------------------------------------
// The dominant token cost per turn is the RE-SENT context: the durable on-box
// session never auto-resets, so it re-ships the whole running conversation on
// every message. The app now exposes a manual "Start fresh chat" control that
// POSTs a bare reset command ("/new") to /api/chat/runs. handleChatRunCreate
// treats that as a session-control action, not a chat turn, with two reliability
// rules this suite pins:
//   1. It BYPASSES the quota gate — a capped user must still be able to reset to
//      bring their per-turn cost back down (otherwise they are stuck: too capped
//      to send, and the only thing that lowers cost is a reset).
//   2. It is NOT persisted as a visible "/new" user message (no enqueue_chat_message,
//      no /v1/runs) — it is forwarded to the runner's delegent gateway
//      awaiting its native reset acknowledgment before the app adds a divider.
// Any slash text that is NOT a reset alias falls through to the normal path.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseEnv(overrides = {}) {
  return {
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true',
    SUPABASE_URL: 'https://unit.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
    SIDEKICK_RUNNER_SHARED_SECRET: 'global_runner_secret_legacy_only_for_other_paths',
    OPENROUTER_API_KEY: 'sk-or-test-fake',
    ...overrides,
  };
}

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

// `state.capped` flips token_usage_events to report usage over quota, which
// makes fetchUsageSnapshot.hardLimited true so the normal path 402s.
function handlers(state) {
  const isoNow = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () => new Response(JSON.stringify({ id: USER_ID })) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/),
      respond: () => new Response(JSON.stringify(state.capped ? [{ total_tokens: 20_000_000 }] : [])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: isoNow, last_health_at: isoNow, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url), respond: () => new Response(JSON.stringify({ object: 'hermes.api_server.capabilities', available: true, features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } }), { status: 200 }) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () => { state.enqueue += 1; return new Response(JSON.stringify([{ conversation_id: USER_ID, claimed: true, user_message_id: '88888888-8888-4888-8888-888888888888', assistant_message_id: '99999999-9999-4999-8999-999999999999', task_run_id: RUN_ID }])); } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url), respond: () => { state.runs += 1; return new Response(JSON.stringify({ run_id: 'hermes_run_abc', status: 'started' }), { status: 201 }); } },
    // Route B delegent gateway dispatch (the reset target).
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/delegent\/(?:message|control)$/.test(url),
      respond: ({ init }) => {
        const b = init.body ? JSON.parse(String(init.body)) : {};
        state.delegent.push(b);
        if (state.delegentThrow) throw new Error('ECONNREFUSED (runner box unreachable)');
        return new Response(JSON.stringify(state.controlBody ?? { ok: true }), { status: state.controlStatus ?? 200 });
      } },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url), respond: () => new Response('[]', { status: 200 }) },
  ];
}
function post(path, bodyObj, env, state) {
  return async () => {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) }),
      env, ctx,
    );
    await ctx.settle();
    return resp;
  };
}
function freshState(extra = {}) { return { enqueue: 0, runs: 0, delegent: [], capped: false, ...extra }; }

test('reset requires explicit confirmation before contacting the runner', async () => {
  const state = freshState();
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await post('/api/chat/runs', { message: '/new', conversationId: USER_ID }, baseEnv(), state)();
    assert.equal(resp.status, 409);
    assert.equal(state.delegent.length, 0);
    assert.equal(state.enqueue, 0);
  } finally { globalThis.fetch = original; }
});

test('reset rejects missing or failed acknowledgments and never retries an uncertain control', async () => {
  for (const extra of [{controlBody: {accepted: true}}, {controlStatus: 503}, {delegentThrow: true}]) {
    const state = freshState(extra);
    const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
    try {
      const resp = await post('/api/chat/runs', {message: '/new', confirmed: true}, baseEnv(), state)();
      assert.equal(resp.status, 503);
      assert.equal(state.delegent.length, 1);
      assert.equal(state.enqueue, 0);
    } finally { globalThis.fetch = original; }
  }
});

test('reset command: "/new" forwards to the gateway, does NOT enqueue or start a run, returns 200', async () => {
  const state = freshState();
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await post('/api/chat/runs', { message: '/new', confirmed: true, conversationId: USER_ID }, baseEnv(), state)();
    assert.equal(resp.status, 200, 'reset returns 200');
    const body = await resp.json();
    assert.equal(body.command, 'reset', 'response is tagged as a reset');
    assert.equal(state.enqueue, 0, 'a reset must NOT be persisted as a chat message');
    assert.equal(state.runs, 0, 'a reset must NOT start a legacy /v1/runs turn');
    assert.equal(state.delegent.length, 1, 'the reset is forwarded to the gateway exactly once');
    assert.equal(state.delegent[0].action, 'reset', 'the canonical /new alias reaches the gateway');
    assert.equal(state.delegent[0].confirmed, true, 'explicit confirmation is forwarded');
  } finally { globalThis.fetch = original; }
});

test('alias mapping: "/reset" and "/clear" both dispatch the canonical "/new"', async () => {
  for (const alias of ['/reset', '/clear', '/NEW', '  /new  ']) {
    const state = freshState();
    const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
    try {
      const resp = await post('/api/chat/runs', { message: alias, confirmed: true, conversationId: USER_ID }, baseEnv(), state)();
      assert.equal(resp.status, 200, `${alias} resets`);
      assert.equal(state.delegent[0]?.action, 'reset', `${alias} dispatches canonical /new`);
      assert.equal(state.enqueue, 0, `${alias} does not enqueue`);
    } finally { globalThis.fetch = original; }
  }
});

test('quota bypass: a capped user is 402 on a normal message but CAN still reset (200)', async () => {
  const state = freshState({ capped: true });
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    // Self-validating: prove the gate is actually live for this user first.
    const normal = await post('/api/chat/runs', { message: 'do some expensive work', conversationId: USER_ID }, baseEnv(), state)();
    assert.equal(normal.status, 402, 'a normal message from a capped user is gated');
    assert.equal(state.enqueue, 0, 'the gated normal message never enqueued');

    // The reset must slip past the same gate.
    const reset = await post('/api/chat/runs', { message: '/new', confirmed: true, conversationId: USER_ID }, baseEnv(), state)();
    assert.equal(reset.status, 200, 'the SAME capped user can still start a fresh chat');
    assert.equal(state.delegent.length, 1, 'the capped reset reached the gateway');
  } finally { globalThis.fetch = original; }
});

test('honest failure: runner unreachable -> 503 (not a false success)', async () => {
  const state = freshState({ delegentThrow: true });
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await post('/api/chat/runs', { message: '/new', confirmed: true, conversationId: USER_ID }, baseEnv(), state)();
    // A network throw makes tryDispatchDelegentRun return 'unreachable': the reset
    // reports 503 (retryable) rather than pretending it worked.
    assert.equal(resp.status, 503, 'an unreachable runner is reported honestly');
    assert.equal(state.enqueue, 0, 'still no chat rows on failure');
  } finally { globalThis.fetch = original; }
});

test('route B off: reset is reported unsupported (409), not silently swallowed', async () => {
  const state = freshState();
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await post('/api/chat/runs', { message: '/new', confirmed: true, conversationId: USER_ID }, baseEnv({ SIDEKICK_CHAT_ROUTE_B_ENABLED: 'false' }), state)();
    assert.equal(resp.status, 409, 'without Route B there is no session to reset — report it');
    assert.equal(state.delegent.length, 0, 'nothing dispatched when Route B is off');
    assert.equal(state.enqueue, 0, 'nothing enqueued');
  } finally { globalThis.fetch = original; }
});

test('non-reset slash text falls through to the normal path (enqueues + dispatches)', async () => {
  const state = freshState();
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers(state));
  try {
    const resp = await post('/api/chat/runs', { message: '/summarise my week', conversationId: USER_ID }, baseEnv(), state)();
    assert.equal(state.enqueue, 1, 'a non-reset message is a normal turn: it enqueues');
    assert.ok(resp.status === 200 || resp.status === 201, 'normal path returns a run');
  } finally { globalThis.fetch = original; }
});
