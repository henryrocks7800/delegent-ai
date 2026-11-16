// Scheduled-tasks waker (migration 0036 / forensic C-POS-07, R-AGENT-05).
//
// Runners use autostop=suspend, so a suspended machine cannot fire its own
// recurring timer — the Worker cron (sweepScheduledTasks) is the external waker
// that claims due tasks and dispatches each to the user's OWN runner. These
// tests drive sweepScheduledTasks + the two HTTP endpoints against a stubbed
// Supabase + runner (global fetch). No network.
//
// What we assert:
//   1. happy path: claim a due task -> resolve the user's runner -> POST to
//      that runner's /tasks (HMAC headers) -> write a task_runs row with
//      kind='scheduled' -> write the assistant message -> record dispatch ok.
//   2. failure path: runner returns 500 -> task_run flips failed -> record ok=false.
//   3. no-binding path: runner not ready -> record ok=false, no /tasks POST.
//   4. POST /api/scheduled-tasks auth (401 without bearer) + validation
//      (interval < 300 rejected) + happy 201.
//   5. POST /internal/scheduled-sweep bearer gate (401 without the service key).

import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { sweepScheduledTasks } from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const SERVICE_ROLE = 'service_role_test_secret';
const FLY_APP = 'delegent-runner-abc123';
const RUNNER_BASE = `https://${FLY_APP}.fly.dev`;
const RUNNER_TASKS_URL = `${RUNNER_BASE}/tasks`;
const PER_USER_SECRET = 'per-user-hmac-secret-xyz';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  // Intentionally a DIFFERENT value from the per-user secret so a test failure
  // would catch the waker signing with the global secret instead of the
  // per-user one resolved from hermes_instance_private.
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret_must_not_be_used_here',
};

function ctxStub() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(Promise.resolve(p).catch(() => {})); },
    async settle() { await Promise.all(promises); },
  };
}

// A fresh-health hermes_instances row so the readiness gate passes without the
// on-demand /healthz probe (last_health_at is within the 10-min window).
function readyHermesInstanceRow() {
  const nowIso = new Date().toISOString();
  return {
    status: 'ready',
    ready_at: nowIso,
    last_health_at: nowIso,
    provider: 'fly_machines',
  };
}

// Build the ordered Supabase + runner handler set fetchTelegramIngressState
// walks: subscriptions(status) -> billing-cycle subscriptions -> usage_quotas
// -> token_usage_events -> hermes_instances -> hermes_instance_private. Then the
// waker writes task_runs (POST + PATCH), the assistant message, and calls the
// two RPCs.
function stubFetch(handlers) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    const headers = init.headers ?? {};
    // Recorded so a test can prove a runner call carries a deadline.
    const hasSignal = typeof AbortSignal !== 'undefined' && init.signal instanceof AbortSignal;
    calls.push({ url: String(url), method, body, headers, hasSignal });
    for (const h of handlers) {
      if (h.match(String(url), method)) {
        const status = typeof h.status === 'function' ? h.status() : (h.status ?? 200);
        const payload = typeof h.rows === 'function' ? h.rows() : (h.rows ?? []);
        return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: 'unmatched', url: String(url), method }), { status: 500 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// Shared readiness handlers (everything fetchTelegramIngressState needs to
// return kind:'ready' with the per-user secret + matching fly host).
function readinessHandlers() {
  return [
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET',
      rows: () => [{ status: 'active', current_period_start: '2026-05-01T00:00:00.000Z' }] },
    { match: (u, m) => u.includes('/rest/v1/usage_quotas') && m === 'GET',
      rows: () => [{ monthly_token_quota: 1_000_000, tier_id: 'studio' }] },
    { match: (u, m) => u.includes('/rest/v1/token_usage_events') && m === 'GET',
      rows: () => [{ total_tokens: 10 }] },
    { match: (u, m) => u.includes('/rest/v1/hermes_instances') && m === 'GET',
      rows: () => [readyHermesInstanceRow()] },
    { match: (u, m) => u.includes('/rest/v1/hermes_instance_private') && m === 'GET',
      rows: () => [{
        runner_base_url: RUNNER_BASE,
        provider: 'fly_machines',
        fly_app_name: FLY_APP,
        runner_shared_secret: PER_USER_SECRET,
      }] },
    // The waker wakes the runner (Fly auto-start) with a /healthz GET before
    // dispatching; a healthy response is what makes it 'reachable', so the warm
    // /tasks dispatch follows. Reachability — not the task outcome — drives the
    // auto-pause counter.
    { match: (u, m) => u === `${RUNNER_BASE}/healthz` && m === 'GET',
      rows: () => ({ ok: true, workspaceReady: true }) },
  ];
}

// ---------------------------------------------------------------------------
// sweepScheduledTasks — happy path
// ---------------------------------------------------------------------------
test('claims a due task, dispatches to the resolved runner, writes a scheduled task_run + assistant message, records ok=true', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-1', user_id: USER_ID, prompt: 'Summarise my unread email', label: 'Inbox digest' }] },
    ...readinessHandlers(),
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'POST', rows: () => [{ id: 'run-1' }] },
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'PATCH', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'POST', rows: () => [] },
    { match: (u) => u === RUNNER_TASKS_URL,
      rows: () => ({ status: 'completed', result: 'You have 3 unread: two newsletters and a calendar invite.' }) },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 1, failed: 0 });

    // It claimed with a bounded limit.
    const claim = calls.find((c) => c.url.includes('/rpc/claim_due_scheduled_tasks'));
    assert.ok(claim, 'must call claim_due_scheduled_tasks');
    assert.ok(claim.body.p_limit >= 1 && claim.body.p_limit <= 50, 'claim limit must be bounded');

    // It POSTed to the user's OWN runner (the fly-app-matched URL), with the
    // canonical HMAC headers, signed with the PER-USER secret.
    const dispatch = calls.find((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST');
    assert.ok(dispatch, 'must POST to the resolved runner /tasks');
    assert.equal(dispatch.body.user_id, USER_ID);
    assert.equal(dispatch.body.instruction, 'Summarise my unread email');
    assert.equal(dispatch.headers['x-sidekick-user-id'], USER_ID);
    assert.match(dispatch.headers['x-sidekick-runner-token'], /^v1\.[a-f0-9]{64}$/, 'v1 HMAC token');
    assert.ok(dispatch.headers['x-sidekick-runner-timestamp'], 'timestamp header present');

    // task_run row written with kind='scheduled', status dispatched, the prompt
    // as the (NOT NULL) instruction, and no started_at column.
    const insert = calls.find((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'POST');
    assert.ok(insert, 'must insert a task_runs row');
    assert.equal(insert.body.kind, 'scheduled');
    assert.equal(insert.body.status, 'dispatched');
    assert.equal(insert.body.user_id, USER_ID);
    assert.equal(insert.body.instruction, 'Summarise my unread email');
    assert.ok(!('started_at' in insert.body), 'task_runs has no started_at column');

    // task_run finalized succeeded.
    const patch = calls.find((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'PATCH');
    assert.ok(patch, 'must finalize the task_run');
    assert.equal(patch.body.status, 'succeeded');
    assert.equal(patch.body.error_code, null);
    assert.match(decodeURIComponent(patch.url), /id=eq\.run-1/);

    // assistant message written, tied to the task_run id via task_id, content
    // is the product-safe runner output.
    const msg = calls.find((c) => c.url.includes('/rest/v1/messages') && c.method === 'POST');
    assert.ok(msg, 'must write the assistant message');
    assert.equal(msg.body.role, 'assistant');
    assert.equal(msg.body.user_id, USER_ID);
    assert.equal(msg.body.task_id, 'run-1');
    assert.ok(msg.body.content.includes('3 unread'), 'assistant content carries the runner output');

    // record_scheduled_task_dispatch(id, run_id, true)
    const record = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.ok(record, 'must record the dispatch outcome');
    assert.equal(record.body.p_id, 'task-1');
    assert.equal(record.body.p_task_run_id, 'run-1');
    assert.equal(record.body.p_ok, true);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// sweepScheduledTasks — runner reachable but the task itself fails (500)
// ---------------------------------------------------------------------------
test('runner 500 marks the task_run failed but records ok=true (reachable runner; per-run failure must not auto-pause)', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-2', user_id: USER_ID, prompt: 'Do the thing', label: null }] },
    ...readinessHandlers(),
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'POST', rows: () => [{ id: 'run-2' }] },
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'PATCH', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'POST', rows: () => [] },
    { match: (u) => u === RUNNER_TASKS_URL, status: 500, rows: () => ({ error: 'runner exploded' }) },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 0, failed: 1 });

    const patch = calls.find((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'PATCH');
    assert.ok(patch, 'must finalize the task_run even on runner failure');
    assert.equal(patch.body.status, 'failed');
    assert.equal(patch.body.error_code, 'runner_task_failed');

    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/messages') && c.method === 'POST'),
      'no assistant message on failure');

    const record = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.ok(record, 'must record the dispatch');
    assert.equal(record.body.p_id, 'task-2');
    // Reachability (the wake) drives consecutive_failures, NOT the per-run task
    // outcome: a reachable runner whose task failed must NOT advance auto-pause.
    assert.equal(record.body.p_ok, true);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// sweepScheduledTasks — runner unreachable (the /healthz wake fails)
// ---------------------------------------------------------------------------
test('unreachable runner (failed /healthz wake) finalizes failed, records ok=false, never POSTs /tasks', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-4', user_id: USER_ID, prompt: 'Do it', label: null }] },
    // /healthz 503 placed BEFORE readinessHandlers (which carries a healthy
    // /healthz), so the unreachable response matches first.
    { match: (u, m) => u === `${RUNNER_BASE}/healthz` && m === 'GET', status: 503, rows: () => ({ ok: false }) },
    ...readinessHandlers(),
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'POST', rows: () => [{ id: 'run-4' }] },
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'PATCH', rows: () => [] },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 0, failed: 1 });
    assert.ok(!calls.some((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST'),
      'must NOT dispatch to an unreachable runner');
    const patch = calls.find((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'PATCH');
    assert.ok(patch, 'must finalize the task_run as failed');
    assert.equal(patch.body.status, 'failed');
    assert.equal(patch.body.error_code, 'runner_unreachable');
    const record = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.equal(record.body.p_ok, false); // reachability failure advances auto-pause
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// sweepScheduledTasks — owner has no live runner binding
// ---------------------------------------------------------------------------
test('no live runner binding records ok=false and never POSTs to a runner', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-3', user_id: USER_ID, prompt: 'Anything', label: null }] },
    // Subscription is inactive -> fetchTelegramIngressState returns needs_subscription.
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET',
      rows: () => [{ status: 'inactive' }] },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 0, failed: 1 });

    assert.ok(!calls.some((c) => c.url === RUNNER_TASKS_URL), 'must NOT dispatch to a runner without a live binding');
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'POST'),
      'must not create a task_run when there is no binding');

    const record = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.ok(record, 'must still record a failed dispatch so the auto-pause counter advances');
    assert.equal(record.body.p_task_run_id, null);
    assert.equal(record.body.p_ok, false);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// sweepScheduledTasks — credential guard + claim-RPC failure are non-fatal
// ---------------------------------------------------------------------------
test('skips safely when Supabase creds are missing (no fetch attempted)', async () => {
  const real = globalThis.fetch;
  let touched = false;
  globalThis.fetch = async () => { touched = true; return new Response('[]'); };
  try {
    const res = await sweepScheduledTasks({});
    assert.deepEqual(res, { dispatched: 0, failed: 0 });
    assert.equal(touched, false, 'must not hit the network without creds');
  } finally { globalThis.fetch = real; }
});

test('a failing claim RPC is swallowed (waker never throws)', async () => {
  const { restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'), status: 500, rows: () => ({ error: 'boom' }) },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 0, failed: 0 });
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// POST /api/scheduled-tasks — auth + validation + happy path
// ---------------------------------------------------------------------------
function createTaskRequest(bodyObj, { withAuth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (withAuth) headers.authorization = `Bearer ${USER_JWT}`;
  return new Request(`${BASE}/api/scheduled-tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });
}

test('POST /api/scheduled-tasks returns 401 without a bearer token', async () => {
  const { restore } = stubFetch([]);
  try {
    const resp = await worker.fetch(createTaskRequest({ prompt: 'x', interval_seconds: 600 }, { withAuth: false }), ENV, ctxStub());
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error, 'unauthenticated');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks rejects an interval below 300s', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
  ]);
  try {
    const resp = await worker.fetch(createTaskRequest({ prompt: 'Ping me', interval_seconds: 120 }), ENV, ctxStub());
    assert.equal(resp.status, 422);
    const body = await resp.json();
    assert.equal(body.error, 'invalid_interval');
    // Must reject before any scheduled_tasks INSERT.
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/scheduled_tasks')), 'no insert on validation failure');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks rejects a caller without an active subscription (402)', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET', rows: () => [{ status: 'inactive' }] },
  ]);
  try {
    const resp = await worker.fetch(createTaskRequest({ prompt: 'Ping me daily', interval_seconds: 3600 }), ENV, ctxStub());
    assert.equal(resp.status, 402);
    const body = await resp.json();
    assert.equal(body.error, 'no_active_subscription');
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/scheduled_tasks')), 'no insert without entitlement');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks creates the row and returns 201 with the id', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET', rows: () => [{ status: 'active' }] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'GET', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'POST', rows: () => [{ id: 'sched-1' }] },
  ]);
  try {
    const resp = await worker.fetch(createTaskRequest({ prompt: 'Daily standup summary', interval_seconds: 86400, label: 'Standup' }), ENV, ctxStub());
    assert.equal(resp.status, 201);
    const body = await resp.json();
    assert.equal(body.id, 'sched-1');

    const insert = calls.find((c) => c.url.includes('/rest/v1/scheduled_tasks') && c.method === 'POST');
    assert.ok(insert, 'must insert the scheduled_tasks row');
    assert.equal(insert.body.user_id, USER_ID);
    assert.equal(insert.body.prompt, 'Daily standup summary');
    assert.equal(insert.body.schedule_kind, 'interval');
    assert.equal(insert.body.interval_seconds, 86400);
    assert.equal(insert.body.status, 'active');
    assert.ok(typeof insert.body.next_run_at === 'string' && insert.body.next_run_at.length > 0, 'next_run_at set');
    // A caller that sends no zone still gets a valid one, so migration 0046's
    // whole-day advance always has something to anchor to.
    assert.equal(insert.body.timezone, 'UTC');
    // The response must not leak any infra detail beyond the id.
    assert.deepEqual(Object.keys(body), ['id']);
  } finally { restore(); }
});

test('POST /api/scheduled-tasks stores the caller timezone so a daily routine keeps its local hour', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET', rows: () => [{ status: 'active' }] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'GET', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'POST', rows: () => [{ id: 'sched-tz' }] },
  ]);
  try {
    const resp = await worker.fetch(createTaskRequest({
      prompt: 'Morning brief',
      interval_seconds: 86400,
      timezone: 'Europe/London',
    }), ENV, ctxStub());
    assert.equal(resp.status, 201);
    const insert = calls.find((c) => c.url.includes('/rest/v1/scheduled_tasks') && c.method === 'POST');
    assert.equal(insert.body.timezone, 'Europe/London');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks refuses a junk timezone rather than writing it to the row', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
  ]);
  try {
    for (const timezone of ['Europe/London; drop table', '../../etc', 'x'.repeat(65), 42]) {
      const resp = await worker.fetch(createTaskRequest({
        prompt: 'Morning brief',
        interval_seconds: 86400,
        timezone,
      }), ENV, ctxStub());
      assert.equal(resp.status, 422, `${String(timezone)} should be rejected`);
      assert.equal((await resp.json()).error, 'invalid_timezone');
    }
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/scheduled_tasks')), 'no insert on a bad zone');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks refuses a 51st standing routine (422, no insert)', async () => {
  // Fifty standing rows already exist (paused ones count; cancelled do not).
  // Nothing in the UI can reach this, but nothing else stops a scripted client
  // inserting rows without bound, so the ceiling is enforced at create time.
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET', rows: () => [{ status: 'active' }] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'GET',
      rows: () => Array.from({ length: 50 }, (_, i) => ({ id: `sched-${i}` })) },
  ]);
  try {
    const resp = await worker.fetch(createTaskRequest({ prompt: 'One more', interval_seconds: 3600 }), ENV, ctxStub());
    assert.equal(resp.status, 422);
    assert.equal((await resp.json()).error, 'routine_limit_reached');
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/scheduled_tasks') && c.method === 'POST'),
      'no insert at the ceiling');
    const countRead = calls.find((c) => c.url.includes('/rest/v1/scheduled_tasks') && c.method === 'GET');
    assert.ok(countRead, 'must read the standing count before deciding');
    assert.ok(countRead.url.includes('status=neq.cancelled'), 'cancelled rows must not count against the ceiling');
  } finally { restore(); }
});

test('POST /api/scheduled-tasks allows a one-shot task with no interval', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.endsWith('/auth/v1/user'), rows: () => ({ id: USER_ID }) },
    { match: (u, m) => u.includes('/rest/v1/subscriptions') && m === 'GET', rows: () => [{ status: 'active' }] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'GET', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/scheduled_tasks') && m === 'POST', rows: () => [{ id: 'sched-once' }] },
  ]);
  try {
    const firstRunAt = new Date(Date.now() + 3_600_000).toISOString();
    const resp = await worker.fetch(createTaskRequest({ prompt: 'Remind me once', schedule_kind: 'once', first_run_at: firstRunAt }), ENV, ctxStub());
    assert.equal(resp.status, 201);
    const insert = calls.find((c) => c.url.includes('/rest/v1/scheduled_tasks') && c.method === 'POST');
    assert.equal(insert.body.schedule_kind, 'once');
    assert.equal(insert.body.interval_seconds, null);
    assert.equal(insert.body.next_run_at, firstRunAt, 'next_run_at honours first_run_at');
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// POST /internal/scheduled-sweep — bearer gate
// ---------------------------------------------------------------------------
test('POST /internal/scheduled-sweep returns 401 without the service-role bearer', async () => {
  const { restore } = stubFetch([]);
  try {
    const resp = await worker.fetch(new Request(`${BASE}/internal/scheduled-sweep`, { method: 'POST' }), ENV, ctxStub());
    assert.equal(resp.status, 401);
  } finally { restore(); }
});

test('POST /internal/scheduled-sweep returns 401 for a wrong bearer (user JWT, not the service key)', async () => {
  const { restore } = stubFetch([]);
  try {
    const resp = await worker.fetch(new Request(`${BASE}/internal/scheduled-sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_JWT}` },
    }), ENV, ctxStub());
    assert.equal(resp.status, 401);
  } finally { restore(); }
});

test('POST /internal/scheduled-sweep with the service-role bearer runs the sweep and returns counts', async () => {
  const { calls, restore } = stubFetch([
    // No due tasks -> the sweep no-ops with zero counts.
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'), rows: () => [] },
  ]);
  try {
    const resp = await worker.fetch(new Request(`${BASE}/internal/scheduled-sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_ROLE}` },
    }), ENV, ctxStub());
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.dispatched, 0);
    assert.equal(body.failed, 0);
    assert.ok(calls.some((c) => c.url.includes('/rpc/claim_due_scheduled_tasks')), 'sweep must have run');
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03: both runner calls in the sweep carry a deadline.
// ---------------------------------------------------------------------------
// Neither the /healthz wake nor the /tasks dispatch had a timeout, so one
// machine that accepted the connection and never answered held the whole
// tick, and every other user's routine queued behind it. The wake reuses the
// chat path's 8s probe budget; the dispatch is bounded to the runner's own
// longest ceiling (10 minutes) so a genuinely long routine is never cut short.
test('the /healthz wake and the /tasks dispatch both carry an abort deadline', async () => {
  const { calls, restore } = stubFetch([
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-9', user_id: USER_ID, prompt: 'Morning brief', label: null }] },
    ...readinessHandlers(),
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'POST', rows: () => [{ id: 'run-9' }] },
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'PATCH', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'POST', rows: () => [] },
    { match: (u) => u === RUNNER_TASKS_URL, rows: () => ({ status: 'completed', result: 'Brief ready.' }) },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ]);
  try {
    const res = await sweepScheduledTasks(ENV);
    assert.deepEqual(res, { dispatched: 1, failed: 0 });
    const wake = calls.find((c) => c.url === `${RUNNER_BASE}/healthz` && c.method === 'GET');
    assert.ok(wake, 'the wake probe must run');
    assert.equal(wake.hasSignal, true, 'the /healthz wake must carry an abort signal');
    const dispatch = calls.find((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST');
    assert.ok(dispatch, 'the dispatch must run');
    assert.equal(dispatch.hasSignal, true, 'the /tasks dispatch must carry an abort signal');
  } finally { restore(); }
});

test('the dispatch deadline is the runner\'s own ten-minute ceiling, not the 150s chat budget', async () => {
  const { SCHEDULED_TASK_DISPATCH_TIMEOUT_MS } = await import('../dist/index.js');
  assert.equal(SCHEDULED_TASK_DISPATCH_TIMEOUT_MS, 10 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03 (D9): routines run through Route B, like chat.
// ---------------------------------------------------------------------------
// The legacy /tasks path is a stateless single-shot session with no tools and
// none of the memory the user built up in chat. With the Route B flag on and
// a runner that advertises run submission, the waker now queues an assistant
// placeholder, submits the routine to the durable on-box session with an
// unattended-run framing, records the dispatch as ok (reachability drives the
// auto-pause counter), and the reply lands in the placeholder through the
// brief follower or, later, the stale-run sweeper. Legacy stays the fallback.
const ROUTE_B_ENV = { ...ENV, SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true', SIDEKICK_RUN_FOLLOW_INTERVAL_MS: '1' };
const CAPABILITIES_URL = `${RUNNER_BASE}/v1/capabilities`;
const DELEGENT_MESSAGE_URL = `${RUNNER_BASE}/v1/delegent/message`;

function routeBHandlers({ capabilities, dispatch, record, legacy }) {
  return [
    { match: (u) => u.includes('/rpc/claim_due_scheduled_tasks'),
      rows: () => [{ id: 'task-rb', user_id: USER_ID, prompt: 'Summarise my inbox', label: 'Inbox digest' }] },
    ...readinessHandlers(),
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'POST', rows: () => [{ id: 'run-rb' }] },
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'PATCH', rows: () => [] },
    // the follower's reconcile reads the run and its placeholder back
    { match: (u, m) => u.includes('/rest/v1/task_runs') && m === 'GET',
      rows: () => [{ id: 'run-rb', runner_task_id: 'delegent:rb123', kind: 'scheduled', created_at: new Date().toISOString() }] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'POST', rows: () => [{ id: 'ph-rb' }] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'GET', rows: () => [{ id: 'ph-rb' }] },
    { match: (u, m) => u.includes('/rest/v1/messages') && m === 'DELETE', rows: () => [] },
    { match: (u, m) => u.includes('/rest/v1/profiles') && m === 'GET', rows: () => [] },
    { match: (u, m) => u === CAPABILITIES_URL && m === 'GET', rows: capabilities },
    { match: (u, m) => u === DELEGENT_MESSAGE_URL && m === 'POST', rows: dispatch.rows, status: dispatch.status },
    { match: (u, m) => u === `${RUNNER_BASE}/v1/delegent/runs/rb123` && m === 'GET', rows: record.rows, status: record.status },
    { match: (u) => u.includes('/rpc/finalize_chat_message'), rows: () => true },
    { match: (u) => u === RUNNER_TASKS_URL, rows: legacy },
    { match: (u) => u.includes('/rpc/record_scheduled_task_dispatch'), rows: () => [] },
  ];
}

const STREAMING_CAPABILITIES = () => ({ available: true, features: { run_submission: true, run_events_sse: true } });

test('Route B routine: placeholder queued, run submitted with the unattended framing, dispatch recorded ok, reply lands via the follower, legacy never called', async () => {
  const { calls, restore } = stubFetch(routeBHandlers({
    capabilities: STREAMING_CAPABILITIES,
    dispatch: { rows: () => ({ run_id: 'rb123' }) },
    record: { rows: () => ({ done: true, outcome: 'success', text: 'Inbox: 3 unread, nothing urgent.' }) },
    legacy: () => { throw new Error('legacy /tasks must not be called when Route B takes the run'); },
  }));
  try {
    const ctx = ctxStub();
    const res = await sweepScheduledTasks(ROUTE_B_ENV, ctx);
    assert.deepEqual(res, { dispatched: 1, failed: 0 });
    await ctx.settle();

    const placeholder = calls.find((c) => c.url.includes('/rest/v1/messages') && c.method === 'POST');
    assert.ok(placeholder, 'an assistant placeholder is queued');
    assert.equal(placeholder.body.role, 'assistant');
    assert.equal(placeholder.body.status, 'queued');
    assert.equal(placeholder.body.channel, 'system', 'keeps the routine reply rendering as the legacy path did');
    assert.equal(placeholder.body.task_run_id, 'run-rb');

    const submit = calls.find((c) => c.url === DELEGENT_MESSAGE_URL);
    assert.ok(submit, 'the routine is submitted to the durable session');
    assert.equal(submit.body.message_id, 'ph-rb');
    assert.match(submit.body.text, /Scheduled routine "Inbox digest" is running now/);
    assert.match(submit.body.text, /The user is not in the chat, so do not ask them anything/);
    assert.match(submit.body.text, /Summarise my inbox/);
    assert.match(submit.headers['x-sidekick-runner-token'], /^v1\.[a-f0-9]{64}$/);

    const persisted = calls.find((c) => c.url.includes('/rest/v1/task_runs') && c.method === 'PATCH' && c.body?.runner_task_id);
    assert.ok(persisted, 'the delegent run id is persisted on the run');
    assert.equal(persisted.body.runner_task_id, 'delegent:rb123');

    const recorded = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.deepEqual(recorded.body, { p_id: 'task-rb', p_task_run_id: 'run-rb', p_ok: true });

    const finalize = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(finalize, 'the follower reconciles and finalizes the placeholder');
    assert.equal(finalize.body.p_assistant_message_id, 'ph-rb');
    assert.equal(finalize.body.p_task_run_id, 'run-rb');
    assert.equal(finalize.body.p_succeeded, true);
    assert.equal(finalize.body.p_content, 'Inbox: 3 unread, nothing urgent.');

    assert.equal(calls.some((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST'), false, 'no legacy dispatch');
  } finally { restore(); }
});

test('Route B routine: a refused run fails without stateless dispatch', async () => {
  const { calls, restore } = stubFetch(routeBHandlers({
    capabilities: STREAMING_CAPABILITIES,
    dispatch: { rows: () => ({ error: 'not_found' }), status: 404 },
    record: { rows: () => ({}), status: 404 },
    legacy: () => ({ status: 'completed', result: 'Legacy brief.' }),
  }));
  try {
    const res = await sweepScheduledTasks(ROUTE_B_ENV, ctxStub());
    assert.deepEqual(res, { dispatched: 0, failed: 1 });
    assert.equal(calls.some((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST'), false);
    const finalize = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.equal(finalize.body.p_succeeded, false);
    assert.equal(finalize.body.p_error_code, 'runner_unreachable');
  } finally { restore(); }
});

test('Route B routine: an unreachable run submission closes the placeholder honestly and counts toward auto-pause', async () => {
  const { calls, restore } = stubFetch(routeBHandlers({
    capabilities: STREAMING_CAPABILITIES,
    dispatch: { rows: () => { throw new TypeError('fetch failed'); } },
    record: { rows: () => ({}), status: 404 },
    legacy: () => { throw new Error('legacy must not run after an unreachable Route B submission'); },
  }));
  try {
    const res = await sweepScheduledTasks(ROUTE_B_ENV, ctxStub());
    assert.deepEqual(res, { dispatched: 0, failed: 1 });
    const finalize = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(finalize, 'the placeholder is finalized as a failure');
    assert.equal(finalize.body.p_succeeded, false);
    assert.equal(finalize.body.p_error_code, 'runner_unreachable');
    const recorded = calls.find((c) => c.url.includes('/rpc/record_scheduled_task_dispatch'));
    assert.deepEqual(recorded.body, { p_id: 'task-rb', p_task_run_id: null, p_ok: false });
  } finally { restore(); }
});

test('Route B routine: a runner without run submission takes the legacy path with no placeholder', async () => {
  const { calls, restore } = stubFetch(routeBHandlers({
    capabilities: () => ({ available: true, features: { run_submission: false, run_events_sse: false } }),
    dispatch: { rows: () => { throw new Error('must not submit to a runner without the capability'); } },
    record: { rows: () => ({}), status: 404 },
    legacy: () => ({ status: 'completed', result: 'Legacy brief.' }),
  }));
  try {
    const res = await sweepScheduledTasks(ROUTE_B_ENV, ctxStub());
    assert.deepEqual(res, { dispatched: 1, failed: 0 });
    const queued = calls.filter((c) => c.url.includes('/rest/v1/messages') && c.method === 'POST' && c.body?.status === 'queued');
    assert.equal(queued.length, 0, 'no placeholder without Route B');
    assert.equal(calls.some((c) => c.url === RUNNER_TASKS_URL && c.method === 'POST'), true, 'legacy dispatch ran');
  } finally { restore(); }
});
