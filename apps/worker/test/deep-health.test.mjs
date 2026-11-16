// IMPORTANT: imports the built Worker from `../dist/index.js`. Run via `npm test`
// (which builds first) — `node --test` alone may test stale output.
//
// Covers the `/health?deep=1` dependency probe (createDeepHealthPayload). The
// plain `/health` is a liveness stub; the deep probe must return ok=false (the
// route maps that to 503) when a dependency that would fail every chat is down —
// Supabase unreachable, or OpenRouter effective spendable at 0 (the run-dry
// condition that otherwise only surfaces via the hourly runway Sentry alert).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepHealthPayload, redactDeepHealthPayload, opsHealthAuthorized } from '../dist/index.js';

// The coworker engine is reached through a service binding, not global fetch.
// Each test gets its own binding object, because the Worker reuses an engine
// result for 30 seconds per binding.
function engineBinding(status = 200, body = { ok: true, storage: true, modelKey: true }) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}
const envWith = (agent) => ({
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  OPENROUTER_API_KEY: 'sk-or-test',
  SIDEKICK_AGENT_SHARED_SECRET: 'agent-secret',
  AGENT: agent,
});
const ENV = envWith(engineBinding());

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [needle, resp] of routes) {
      if (u.includes(needle)) return resp();
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return () => { globalThis.fetch = original; };
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('deep health: all dependencies healthy → ok', async () => {
  const restore = mockFetch([
    ['/rest/v1/', () => jsonRes(200, {})],
    ['/auth/key', () => jsonRes(200, { data: { limit: 20, usage: 5 } })],
    ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 5 } })],
  ]);
  try {
    const p = await createDeepHealthPayload(ENV);
    assert.equal(p.ok, true);
    assert.equal(p.checks.supabase.ok, true);
    assert.equal(p.checks.openrouter.ok, true);
    assert.equal(typeof p.checkedAt, 'string');
  } finally { restore(); }
});

test('deep health: OpenRouter dry → not ok (would 402 every chat)', async () => {
  const restore = mockFetch([
    ['/rest/v1/', () => jsonRes(200, {})],
    ['/auth/key', () => jsonRes(200, { data: { limit: 20, usage: 20 } })],
    ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 20 } })],
  ]);
  try {
    const p = await createDeepHealthPayload(ENV);
    assert.equal(p.checks.openrouter.ok, false);
    assert.equal(p.ok, false);
  } finally { restore(); }
});

test('deep health: key cap binds even when account has money → not ok', async () => {
  // Account has $18 but the per-key cap is exhausted — chats still 402.
  const restore = mockFetch([
    ['/rest/v1/', () => jsonRes(200, {})],
    ['/auth/key', () => jsonRes(200, { data: { limit: 10, usage: 10 } })],
    ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 2 } })],
  ]);
  try {
    const p = await createDeepHealthPayload(ENV);
    assert.equal(p.checks.openrouter.ok, false);
    assert.equal(p.ok, false);
  } finally { restore(); }
});

test('deep health: Supabase down → not ok', async () => {
  const restore = mockFetch([
    ['/rest/v1/', () => jsonRes(500, {})],
    ['/auth/key', () => jsonRes(200, { data: { limit: 20, usage: 1 } })],
    ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 1 } })],
  ]);
  try {
    const p = await createDeepHealthPayload(ENV);
    assert.equal(p.checks.supabase.ok, false);
    assert.equal(p.ok, false);
  } finally { restore(); }
});

test('deep health: missing env → fails closed without throwing', async () => {
  const p = await createDeepHealthPayload({});
  assert.equal(p.ok, false);
  assert.equal(p.checks.supabase.ok, false);
  assert.equal(p.checks.openrouter.ok, false);
  assert.equal(p.checks.agent_engine.ok, false);
  assert.equal(p.checks.agent_engine.detail, 'agent_engine_not_configured');
});

// 2026-09-23: nothing automatic noticed a broken coworker engine. The probe now
// signs a request as the ops-probe identity to the engine's /ops/health.
const healthyRoutes = () => mockFetch([
  ['/rest/v1/', () => jsonRes(200, {})],
  ['/auth/key', () => jsonRes(200, { data: { limit: 20, usage: 5 } })],
  ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 5 } })],
]);

test('deep health: the engine is asked as the ops-probe identity, signed', async () => {
  const agent = engineBinding();
  const restore = healthyRoutes();
  try {
    const p = await createDeepHealthPayload(envWith(agent));
    assert.equal(p.ok, true);
    assert.equal(p.checks.agent_engine.ok, true);
    assert.equal(agent.calls.length, 1);
    assert.match(agent.calls[0].url, /\/ops\/health$/);
    assert.equal(agent.calls[0].headers.get('x-sidekick-user-id'), 'ops-probe', 'never a customer instance');
    assert.match(agent.calls[0].headers.get('x-sidekick-runner-token') ?? '', /^v1\.[0-9a-f]{64}$/);
  } finally { restore(); }
});

test('deep health: a failing engine fails the probe even with the database and model fine', async () => {
  const restore = healthyRoutes();
  try {
    const p = await createDeepHealthPayload(envWith(engineBinding(503, { ok: false, storage: true, modelKey: false })));
    assert.equal(p.checks.supabase.ok, true);
    assert.equal(p.checks.openrouter.ok, true);
    assert.equal(p.checks.agent_engine.ok, false);
    assert.equal(p.checks.agent_engine.status, 503);
    assert.match(p.checks.agent_engine.detail, /model_key=false/);
    assert.equal(p.ok, false, 'the route answers 503 and the uptime monitor alerts');
  } finally { restore(); }
});

test('deep health: an engine that answers 200 without ok=true is not healthy', async () => {
  const restore = healthyRoutes();
  try {
    const p = await createDeepHealthPayload(envWith(engineBinding(200, { error: 'not_found' })));
    assert.equal(p.checks.agent_engine.ok, false);
    assert.equal(p.ok, false);
  } finally { restore(); }
});

test('deep health: an engine that throws fails the check instead of the probe', async () => {
  const restore = healthyRoutes();
  try {
    const p = await createDeepHealthPayload(envWith({ async fetch() { throw new Error('binding down'); } }));
    assert.equal(p.checks.agent_engine.ok, false);
    assert.equal(p.checks.agent_engine.detail, 'binding down');
    assert.equal(p.ok, false);
  } finally { restore(); }
});

test('deep health: the engine result is reused for 30 seconds, so the public probe cannot load the engine', async () => {
  const agent = engineBinding();
  const env = envWith(agent);
  const restore = healthyRoutes();
  try {
    await createDeepHealthPayload(env);
    await createDeepHealthPayload(env);
    await createDeepHealthPayload(env);
    assert.equal(agent.calls.length, 1);
  } finally { restore(); }
});

test('deep health: unauthenticated body names no provider and quotes no balance', async () => {
  const restore = mockFetch([
    ['/rest/v1/', () => jsonRes(200, {})],
    ['/auth/key', () => jsonRes(200, { data: { limit: 20, usage: 5 } })],
    ['/credits', () => jsonRes(200, { data: { total_credits: 20, total_usage: 5 } })],
  ]);
  try {
    const redacted = redactDeepHealthPayload(await createDeepHealthPayload(ENV));
    assert.equal(redacted.ok, true);
    assert.deepEqual(Object.keys(redacted.checks).sort(), ['coworker_engine', 'datastore', 'model_provider']);
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes('openrouter'), 'the provider name must not appear');
    assert.ok(!serialized.includes('spendable'), 'the balance must not appear');
    assert.ok(!serialized.includes('$'), 'no dollar figure at all');
    assert.equal(redacted.checks.model_provider.ok, true);
    assert.equal(redacted.checks.model_provider.status, null);
    assert.equal(typeof redacted.checks.model_provider.latencyMs, 'number');
    assert.equal('detail' in redacted.checks.model_provider, false);
  } finally { restore(); }
});

// Reading a diagnostic used to require presenting SUPABASE_SERVICE_ROLE_KEY, so
// the only way to let an uptime monitor see the detail was to hand it the key to
// the whole database. The ops token unlocks a read-only status body and nothing
// else, and the service-role key must no longer open this door at all.
const healthRequest = (bearer) => new Request('https://api.example/health?deep=1', {
  headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
});

test('deep health: the ops token unlocks the detail and the service-role key does not', () => {
  const env = { SIDEKICK_OPS_HEALTH_TOKEN: 'ops-token', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' };
  assert.equal(opsHealthAuthorized(healthRequest('ops-token'), env), true);
  assert.equal(opsHealthAuthorized(healthRequest('service-role-key'), env), false);
  assert.equal(opsHealthAuthorized(healthRequest('ops-toke'), env), false, 'a prefix is not a match');
  assert.equal(opsHealthAuthorized(healthRequest(''), env), false);
  assert.equal(opsHealthAuthorized(healthRequest(undefined), env), false);
});

test('deep health: an unset ops token authorizes nobody rather than everybody', () => {
  // An empty expected value compared against an empty supplied value is equal,
  // which is exactly the wrong answer, so the unset case is checked first.
  assert.equal(opsHealthAuthorized(healthRequest(''), { SUPABASE_SERVICE_ROLE_KEY: 'k' }), false);
  assert.equal(opsHealthAuthorized(healthRequest(undefined), {}), false);
  assert.equal(opsHealthAuthorized(healthRequest('anything'), { SIDEKICK_OPS_HEALTH_TOKEN: '   ' }), false);
});
