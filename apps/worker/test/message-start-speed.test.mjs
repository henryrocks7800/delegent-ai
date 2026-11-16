// QA F16, 2026-09-23: before the coworker starts on a message, the Worker made
// about ten reads in a row. The ones that do not depend on each other now run
// together, and a heavy month's usage pages are asked for together. Same
// results, same billing arithmetic; these tests pin both halves.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { fetchSupabaseRowsPaged } from '../dist/index.js';

const USER = '11111111-2222-4333-8444-555555555555';
const SECRET = 'agent-engine-secret-for-tests';
const env = (binding) => ({
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true',
  OPENROUTER_API_KEY: 'sk-or-test-fake',
  AGENT: binding,
  SIDEKICK_AGENT_ENGINE_USER_IDS: USER,
  SIDEKICK_AGENT_SHARED_SECRET: SECRET,
});

/** A table of `total` rows served by offset/limit, like PostgREST, with a server cap. */
function pagedTable(total, { cap = 1000, delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? cap), cap);
    const counted = /count=exact/.test(String(new Headers(init.headers).get('prefer') ?? ''));
    calls.push({ offset, limit, counted });
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight -= 1;
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ n: offset + i }));
    const headers = { 'content-type': 'application/json' };
    if (counted) headers['content-range'] = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
    return new Response(JSON.stringify(rows), { status: 200, headers });
  };
  return { fetchImpl, calls, stats: () => ({ maxInFlight }) };
}

async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('pages read together come back identical to pages read one at a time', async () => {
  for (const total of [0, 1, 999, 1000, 1001, 3456]) {
    const one = pagedTable(total);
    const sequential = await withFetch(one.fetchImpl, () => fetchSupabaseRowsPaged(env(), 'token_usage_events', { select: 'n' }));
    const many = pagedTable(total, { delayMs: 5 });
    const together = await withFetch(many.fetchImpl, () => fetchSupabaseRowsPaged(env(), 'token_usage_events', { select: 'n' }, { concurrency: 4 }));
    assert.deepEqual(together.rows, sequential.rows, `rows for ${total}`);
    assert.equal(together.complete, true, `complete for ${total}`);
    assert.equal(together.rows.length, total);
    assert.deepEqual(together.rows.map((r) => r.n), Array.from({ length: total }, (_, i) => i), 'in order');
    if (total > 2000) assert.ok(many.stats().maxInFlight > 1, 'later pages were asked for together');
    assert.equal(many.calls.filter((c) => c.counted).length, total ? 1 : 1, 'only the first page asks for the count');
  }
});

test('a server cap below the asked page size does not skip rows', async () => {
  const capped = pagedTable(2500, { cap: 400 });
  const page = await withFetch(capped.fetchImpl, () => fetchSupabaseRowsPaged(env(), 't', { select: 'n' }, { concurrency: 3, pageSize: 1000 }));
  assert.equal(page.rows.length, 2500);
  assert.deepEqual(page.rows.map((r) => r.n), Array.from({ length: 2500 }, (_, i) => i));
  assert.equal(page.complete, true);
});

test('a bound that stops short is still said out loud', async () => {
  const big = pagedTable(5000);
  const page = await withFetch(big.fetchImpl, () => fetchSupabaseRowsPaged(env(), 't', { select: 'n' }, { concurrency: 4, maxPages: 2 }));
  assert.equal(page.rows.length, 2000);
  assert.equal(page.complete, false);
  assert.equal(page.total, 5000);
});

test('opening a reply stream reads the run and its message together, and a run that is not yours is still not found', async () => {
  const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER = '66666666-7777-4888-9999-000000000000';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const sse = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'run.completed', payload: { finalText: 'ok' } })}\n\ndata: [DONE]\n\n`)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const run = async (asUser) => {
    const t = {};
    const fetchImpl = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/auth/v1/user')) return json({ id: asUser });
      if (url.includes('/rest/v1/task_runs?id=')) {
        t.taskStart = performance.now();
        await new Promise((r) => setTimeout(r, 60));
        t.taskEnd = performance.now();
        return json(url.includes(`user_id=eq.${USER}`) ? [{ id: RUN, runner_task_id: `agent:${RUN}` }] : []);
      }
      if (url.includes('/rest/v1/messages?task_run_id=')) { t.msgStart = performance.now(); return json([{ id: '99999999-9999-4999-8999-999999999999' }]); }
      return json([]);
    };
    const binding = { calls: 0, async fetch() { this.calls += 1; return sse(); } };
    const response = await withFetch(fetchImpl, () => worker.fetch(new Request(`https://api.test/api/chat/runs/${RUN}/events`, {
      headers: { authorization: 'Bearer user.jwt' },
    }), { ...env(binding), SIDEKICK_AGENT_ENGINE_USER_IDS: `${USER},${OTHER}` }, { waitUntil() {} }));
    await response.text();
    return { status: response.status, t, engineCalls: binding.calls };
  };
  const mine = await run(USER);
  assert.equal(mine.status, 200);
  assert.ok(mine.t.msgStart < mine.t.taskEnd, 'the message read ran alongside the run read');
  assert.ok(mine.engineCalls > 0, 'and the stream was opened');
  const theirs = await run(OTHER);
  assert.equal(theirs.status, 404, 'a run that is not yours is still not found');
  assert.equal(theirs.engineCalls, 0, 'and nothing is opened for it');
});

test('a message on the engine: the subscription and name reads start before the usage read finishes', async () => {
  const started = {};
  const finished = {};
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const key = url.includes('/token_usage_events') ? 'usage'
      : url.includes('/profiles') ? 'profile'
      : url.includes('/subscriptions') && url.includes('service_access_until') ? 'subscriptionCheck'
      : null;
    if (key && !(key in started)) started[key] = performance.now();
    if (url.endsWith('/auth/v1/user')) return json({ id: USER });
    if (key === 'usage') {
      await new Promise((r) => setTimeout(r, 60));
      finished.usage = performance.now();
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } });
    }
    if (url.includes('/rest/v1/subscriptions')) return json([{ status: 'active', current_period_start: new Date(Date.now() - 86_400_000).toISOString(), current_period_end: future, billing_provider: 'stripe' }]);
    if (url.includes('/rest/v1/usage_quotas')) return json([{ monthly_token_quota: 1000, tier_id: 'studio' }]);
    if (url.endsWith('/rest/v1/rpc/settle_usage_top_ups')) return json([{ balance: 0, drawn_this_cycle: 0, used_this_cycle: 0 }]);
    if (url.includes('/rest/v1/profiles')) return json([{ id: USER, agent_name: 'Barry' }]);
    if (url.endsWith('/rest/v1/rpc/claim_chat_message')) {
      return json([{ conversation_id: USER, user_message_id: 'u1', assistant_message_id: '99999999-9999-4999-8999-999999999999', task_run_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', claimed: true }]);
    }
    if (method === 'GET') return json([]);
    return json({});
  };
  const binding = { calls: [], async fetch(input, init = {}) { const u = new URL(typeof input === 'string' ? input : input.url); this.calls.push({ path: u.pathname, body: init.body ? String(init.body) : '' }); return new Response(JSON.stringify({ ok: true, runId: 'x', status: 'started' }), { status: 201 }); } };
  const response = await withFetch(fetchImpl, () => worker.fetch(new Request('https://api.test/api/chat/runs', {
    method: 'POST', headers: { authorization: 'Bearer user.jwt', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
  }), env(binding), { waitUntil() {} }));
  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(started.subscriptionCheck < finished.usage, 'the subscription check ran alongside the usage read');
  assert.ok(started.profile < finished.usage, 'the coworker name was read alongside the usage read');
  const dispatch = binding.calls.find((c) => c.path === '/runs');
  assert.equal(JSON.parse(dispatch.body).agentName, 'Barry', 'and the name still reaches the engine');
});
