// DURABLE DELIVERY 2026-06-05 — reconcileChatRunFromRunner.
// ---------------------------------------------------------------------------
// Root cause of the live "eternal spinner / wrongly-failed" defect: the reply
// was finalized ONLY by the live SSE consumer, so a dropped stream (screen-off,
// the 120s client timeout, or a Fly autostop=suspend mid-task) left the run
// unfinalized — and the blind cron then reaped a run the runner had actually
// COMPLETED. Proven live: a run the DB called 'failed' returned status=completed
// with the full answer from GET /v1/runs/{id} minutes later.
//
// reconcileChatRunFromRunner makes the runner the source of truth: it asks
// GET /v1/runs/{hermesRunId} and finalizes from that authoritative answer (and
// the GET also wakes a suspended runner). These tests pin each status mapping
// against a stubbed Supabase + runner (global fetch) — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChatRunFromRunner } from '../dist/index.js';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-role',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret',
};
const USER = 'user-1';
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HERMES = 'hermes_run_xyz';

function matchUrl(method, regex) { return ({ url, method: m }) => m === method && regex.test(url); }
function makeFakeFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    calls.push({ url, method, body });
    for (const h of handlers) if (h.match({ url, method })) return h.respond({ url, method, init });
    return new Response(JSON.stringify({ error: 'unmatched', url, method }), { status: 500 });
  };
  return calls;
}
// Everything needed for fetchChatRunBindings + fetchChatRunnerBinding to resolve
// a READY runner, plus a finalize sink. Override the runner /v1/runs handler per test.
function baseHandlers({ runnerTaskId = HERMES, runner } = {}) {
  const iso = new Date().toISOString();
  const finalizeCalls = [];
  const handlers = [
    // fetchChatRunBindings
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN, runner_task_id: runnerTaskId }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?task_run_id=eq\./), respond: () => new Response(JSON.stringify([{ id: 'msg-1' }])) },
    // fetchChatRunnerBinding -> fetchTelegramIngressState
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active', current_period_start: iso }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 99_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: iso, last_health_at: iso, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
    // finalize sink
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => { finalizeCalls.push(JSON.parse(String(init.body))); return new Response('true', { status: 200 }); } },
  ];
  // runner status object (the authoritative source). $ so we don't catch /events or /stop.
  if (runner) handlers.push({ match: matchUrl('GET', /test-app\.fly\.dev\/v1\/runs\/hermes_run_xyz$/), respond: () => new Response(JSON.stringify(runner.body), { status: runner.http ?? 200 }) });
  return { handlers, finalizeCalls };
}

test('completed run -> finalizes SUCCEEDED with the runner output (recovers the answer)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'completed', output: 'The answer is 391.' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'completed');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.equal(finalizeCalls[0].p_content, 'The answer is 391.');
    assert.equal(finalizeCalls[0].p_task_run_id, RUN);
    assert.equal(finalizeCalls[0].p_assistant_message_id, 'msg-1');
  } finally { globalThis.fetch = real; }
});

test('failed run -> finalizes a failure (runner_failed)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'failed' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'failed');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, false);
    assert.equal(finalizeCalls[0].p_error_code, 'runner_failed');
  } finally { globalThis.fetch = real; }
});

test('cancelled run -> finalizes cancelled', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'cancelled' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'cancelled');
    assert.equal(finalizeCalls[0].p_error_code, 'cancelled');
  } finally { globalThis.fetch = real; }
});

test('still-running run -> pending, writes NOTHING (never reaps a live run)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'running' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'pending');
    assert.equal(finalizeCalls.length, 0, 'a still-running run must not be finalized');
  } finally { globalThis.fetch = real; }
});

test('runner unreachable (HTTP 500) -> unreachable, writes nothing', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { http: 500, body: {} } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'unreachable');
    assert.equal(finalizeCalls.length, 0);
  } finally { globalThis.fetch = real; }
});

// Defect hunt 2026-06-10 (M2): the embedded Hermes api_server reports terminal
// states under synonyms; the runner-side poller treats succeeded/done/error as
// terminal, so the Worker must too or a finished run loops pending forever
// (dispatched runs are deliberately never reaped).
test('runner status "succeeded" finalizes as completed (synonym vocabulary)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'succeeded', output: 'done deal' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'completed');
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.equal(finalizeCalls[0].p_content, 'done deal');
  } finally { globalThis.fetch = real; }
});

test('runner status "done" finalizes as completed (synonym vocabulary)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'done', output: 'wrapped' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'completed');
    assert.equal(finalizeCalls[0].p_succeeded, true);
  } finally { globalThis.fetch = real; }
});

test('runner status "error" finalizes as failed (synonym vocabulary)', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'error' } } });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'failed');
    assert.equal(finalizeCalls[0].p_succeeded, false);
    assert.equal(finalizeCalls[0].p_error_code, 'runner_failed');
  } finally { globalThis.fetch = real; }
});

test('no hermes_run_id (never dispatched) -> noop, no runner call, no finalize', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runnerTaskId: null });
  const calls = makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'noop');
    assert.equal(finalizeCalls.length, 0);
    assert.ok(!calls.some((c) => /\/v1\/runs\//.test(c.url)), 'must not call the runner without a hermes_run_id');
  } finally { globalThis.fetch = real; }
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03: reconcile must not be gated on the token cap.
// ---------------------------------------------------------------------------
// The binding lookup reconcile shares with chat dispatch hard-limits a user
// whose usage has reached their quota. Reconcile then answered 'unreachable'
// for ever, so the run whose model calls pushed them over the cap (already
// paid for, already finished on the box) was never delivered: the sweeper
// left it in-flight, the app polled it out, and the record expired. Reading
// an in-flight run's outcome spends nothing, so the cap must not apply.
test('a HARD-LIMITED user still gets a completed run reconciled and delivered', async () => {
  const real = globalThis.fetch;
  const { handlers, finalizeCalls } = baseHandlers({ runner: { body: { status: 'completed', output: 'The reply that pushed them over the cap.' } } });
  // Override the usage read: consumed >= quota (99_000_000) => hardLimited.
  handlers.unshift({
    match: matchUrl('GET', /\/rest\/v1\/token_usage_events/),
    respond: () => new Response(JSON.stringify([{ total_tokens: 99_000_000 }])),
  });
  makeFakeFetch(handlers);
  try {
    const out = await reconcileChatRunFromRunner(ENV, USER, RUN);
    assert.equal(out, 'completed', 'a capped user\'s finished run must still reconcile');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.equal(finalizeCalls[0].p_content, 'The reply that pushed them over the cap.');
  } finally { globalThis.fetch = real; }
});
