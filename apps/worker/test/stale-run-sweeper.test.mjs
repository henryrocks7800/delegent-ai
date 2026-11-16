// Stale chat-run sweeper — the scheduled() reconciler.
// ---------------------------------------------------------------------------
// REWRITTEN 2026-06-05. The old sweeper blind-reaped any run stuck in
// queued/dispatched 10+ min into a "took too long" FAILURE without ever asking
// the runner. Live, that reaped runs the runner had actually COMPLETED (verified:
// a DB-'failed' run returned status=completed with the full answer from
// /v1/runs/{id}). The sweeper now RECONCILES from the runner first
// (reconcileChatRunFromRunner) and only reaps a run that is genuinely hung
// (runner can't tell us the answer AND it has blown past the hard ceiling).
// These tests drive it against a stubbed Supabase + runner (global fetch) — no
// network.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepStaleChatRuns, sweepExpiredConnectCodes, STALE_CHAT_RUN_THRESHOLD_MS, RECONCILE_CHAT_RUN_THRESHOLD_MS } from '../dist/index.js';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-role',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret',
};
const NOW = Date.now(); // real now so the binding's runner-health freshness check passes
const RECENT = new Date(NOW - 2 * 60 * 1000).toISOString();      // in-flight, under the hard ceiling
const OLD = new Date(NOW - 11 * 60 * 1000).toISOString();        // past the 10-min hard ceiling
const USER = 'user-1';
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HERMES = 'hermes_run_xyz';

function matchUrl(method, regex) { return ({ url, method: m }) => m === method && regex.test(url); }
function stub(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    calls.push({ url, method, body });
    for (const h of handlers) if (h.match({ url, method })) return h.respond({ url, method, init });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
// Stale list + everything reconcile needs to resolve a ready runner + finalize.
// `runRow` merges extra fields (kind, created_at) into the id=eq task_runs
// response so the telegram-push age gate can be exercised.
function handlers({ staleRows, runner, runRow = {} }) {
  const iso = new Date().toISOString();
  return [
    // the sweeper's stale-run query (has status=in)
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?.*status=in/), respond: ({ url }) => new Response(JSON.stringify(staleRows), { status: 200, headers: { 'x-q': url } }) },
    // reconcile -> fetchChatRunBindings + the telegram-notify kind/created_at lookup (has id=eq)
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN, runner_task_id: HERMES, ...runRow }])) },
    // telegram-notify -> reply target + Bot API sink
    { match: matchUrl('GET', /\/rest\/v1\/gateway_connections/), respond: () => new Response(JSON.stringify([{ source_conversation_id: 'telegram:chat:12345' }])) },
    { match: matchUrl('POST', /api\.telegram\.org/), respond: () => new Response('{"ok":true}', { status: 200 }) },
    { match: matchUrl('GET', /\/rest\/v1\/messages/), respond: () => new Response(JSON.stringify([{ id: 'msg-1' }])) },
    // reconcile -> fetchChatRunnerBinding
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active', current_period_start: iso }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 99_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: iso, last_health_at: iso, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
    // the runner's authoritative run object
    { match: matchUrl('GET', /test-app\.fly\.dev\/v1\/runs\/hermes_run_xyz$/), respond: () => new Response(JSON.stringify(runner?.body ?? {}), { status: runner?.http ?? 200 }) },
    // finalize sink + reap PATCH sink
    { match: matchUrl('POST', /\/rpc\/finalize_chat_message$/), respond: () => new Response('true', { status: 200 }) },
    { match: matchUrl('PATCH', /\/rest\/v1\/task_runs/), respond: () => new Response('[]', { status: 200 }) },
  ];
}

test('RECOVERS a completed-but-undelivered run from the runner (does NOT reap it to failed)', async () => {
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: RECENT }],
    runner: { body: { status: 'completed', output: 'Here are the 3 robot vacuums…' } },
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.recovered, 1, 'completed run recovered from the runner');
    assert.equal(res.reaped, 0, 'a completed run is NEVER reaped as failed');
    const fin = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(fin && fin.body.p_succeeded === true, 'finalized SUCCEEDED');
    assert.equal(fin.body.p_content, 'Here are the 3 robot vacuums…', 'the real answer is persisted');
    // The scan must target ALL in-flight statuses + the short reconcile cutoff.
    const q = decodeURIComponent(calls.find((c) => /task_runs\?.*status=in/.test(c.url)).url);
    assert.match(q, /status=in\.\(queued,dispatched,working,streaming\)/);
    // BOTH Route B sources: kind=eq.chat here silently excluded telegram-origin
    // runs, which rot in 'dispatched' forever once followTelegramRunBriefly's
    // ~21s window closes (2026-07-21 live: a 90s turn's reply was generated
    // on-box and never delivered anywhere).
    // ...and 'scheduled' (2026-09-03): the routine waker parks an inconclusive
    // dispatch in 'dispatched' for THIS sweeper to close, which it never did.
    assert.match(q, /kind=in\.\(chat,telegram,scheduled\)/);
  } finally { globalThis.fetch = real; }
});

test('REAPS a bindings-missing (noop) run past the ceiling — the 71-zombie 2026-07-22 fix', async () => {
  // A run whose assistant message row was deleted (test-harness cleanup /
  // account wipe) reconciles as 'noop' — before this fix the sweeper skipped
  // it forever, rescanning the same immortal zombies every tick. Past the
  // hard ceiling it must now close the row directly (no finalize RPC, no
  // Telegram push — there is no message row to write through).
  const real = globalThis.fetch;
  const calls = stub([
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?.*status=in/), respond: () => new Response(JSON.stringify([{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: OLD }])) },
    // fetchChatRunBindings: run row exists, but the assistant message row is GONE.
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN, runner_task_id: HERMES }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages/), respond: () => new Response('[]', { status: 200 }) },
    { match: matchUrl('PATCH', /\/rest\/v1\/task_runs/), respond: () => new Response('[]', { status: 200 }) },
  ]);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 1, 'a bindings-missing run past the ceiling is finally closed');
    const patch = calls.find((c) => c.method === 'PATCH' && /task_runs/.test(c.url));
    assert.ok(patch, 'the row is closed via a direct task_runs PATCH');
    assert.equal(patch.body.status, 'failed');
    assert.equal(patch.body.error_code, 'bindings_missing');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no finalize RPC without a message row');
    assert.ok(!calls.some((c) => c.url.includes('api.telegram.org')), 'no Telegram push from the no-message branch');
  } finally { globalThis.fetch = real; }
});

test('a bindings-missing (noop) run UNDER the ceiling is left alone (retried next tick)', async () => {
  const real = globalThis.fetch;
  const calls = stub([
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?.*status=in/), respond: () => new Response(JSON.stringify([{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: RECENT }])) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN, runner_task_id: HERMES }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages/), respond: () => new Response('[]', { status: 200 }) },
  ]);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 0, 'a fresh noop run may still be settling (message row being written) — no reap');
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no write for a fresh noop run');
  } finally { globalThis.fetch = real; }
});

test('telegram push fires for a FRESH healed run (the promised "the moment it is done" message)', async () => {
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: RECENT, kind: 'telegram' }],
    runner: { body: { status: 'completed', output: 'Here it is.' } },
    runRow: { kind: 'telegram', created_at: RECENT },
  }));
  try {
    const res = await sweepStaleChatRuns({ ...ENV, SIDEKICK_TELEGRAM_BOT_TOKEN: '123456789:AAtest-token_for-the-unit-suite' }, NOW);
    assert.equal(res.recovered, 1);
    const push = calls.find((c) => c.url.includes('api.telegram.org'));
    assert.ok(push, 'a minutes-old healed telegram run must still deliver its Telegram reply');
    assert.equal(push.body.chat_id, '12345');
  } finally { globalThis.fetch = real; }
});

test('telegram push is AGE-GATED: healing an hours-old zombie closes it silently (no ghost apology)', async () => {
  // Live 2026-07-22: the sweeper fix healed a run from the previous evening
  // and the finalize pushed a context-free "couldn't finish that" into the
  // user's Telegram 14 hours later. The row + app mirror must still close,
  // but no Telegram push fires for a run older than the one-hour gate.
  const ANCIENT = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: ANCIENT, kind: 'telegram' }],
    runner: { body: { status: 'completed', output: 'very late answer' } },
    runRow: { kind: 'telegram', created_at: ANCIENT },
  }));
  try {
    const res = await sweepStaleChatRuns({ ...ENV, SIDEKICK_TELEGRAM_BOT_TOKEN: '123456789:AAtest-token_for-the-unit-suite' }, NOW);
    assert.equal(res.recovered, 1, 'the zombie still heals');
    const fin = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(fin && fin.body.p_content === 'very late answer', 'the app mirror still gets the real text');
    assert.ok(!calls.some((c) => c.url.includes('api.telegram.org')), 'NO Telegram push for an hour+ old run');
  } finally { globalThis.fetch = real; }
});

test('RECOVERS a telegram-origin run the same way (the >21s handoff the follower promises)', async () => {
  // followTelegramRunBriefly polls for ~21s then tells the user "I will
  // message you here the moment it is done", relying on this sweeper. A
  // telegram-kind run must therefore be scanned + reconciled exactly like a
  // chat-kind one; finalizeChatRun's notifyTelegramOnChatFinalize handles the
  // exactly-once Telegram push on the terminal transition.
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: RECENT, kind: 'telegram' }],
    runner: { body: { status: 'completed', output: 'Here is your hello world app…' } },
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.recovered, 1, 'a completed telegram-origin run is recovered from the runner');
    assert.equal(res.reaped, 0);
    const fin = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(fin && fin.body.p_succeeded === true, 'finalized SUCCEEDED');
    assert.equal(fin.body.p_content, 'Here is your hello world app…', 'the real answer is persisted');
  } finally { globalThis.fetch = real; }
});

test('leaves a still-running run ALONE when it is under the hard ceiling (no write)', async () => {
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: RECENT }],
    runner: { body: { status: 'running' } },
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.recovered, 0);
    assert.equal(res.reaped, 0, 'a live run under the ceiling must not be reaped');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no finalize for a live run');
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no reap PATCH for a live run');
  } finally { globalThis.fetch = real; }
});

test('does NOT reap a still-running run even past the hard ceiling (trusts the runner deadline)', async () => {
  // A long research/tool task can legitimately run many minutes on a small
  // runner. As long as the runner reports it RUNNING, we must never reap it —
  // reaping a live run is the exact bug we removed. The runner owns its own
  // deadline and will go terminal; reconcile delivers it then.
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: OLD }],
    runner: { body: { status: 'running' } },
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.recovered, 0);
    assert.equal(res.reaped, 0, 'a run the runner says is still RUNNING is never reaped');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no finalize for a live run');
  } finally { globalThis.fetch = real; }
});

test('NEVER reaps a DISPATCHED run even when the runner is unreachable past the ceiling', async () => {
  // The dangerous edge: a heavy task suspends mid-flight, so its wake-up status
  // GET times out => 'unreachable'. We must NOT reap it — the runner may have
  // (or be about to) complete it, and finalize_chat_message can't heal a row once
  // it's 'failed' (it only writes queued/dispatched). So a dispatched run is left
  // in-flight and re-checked next tick, no matter how old.
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: HERMES, created_at: OLD }],
    runner: { http: 500, body: {} }, // runner momentarily unreachable (suspended/pegged)
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 0, 'a dispatched run is never reaped on transient unreachability');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no failure written for a dispatched run');
  } finally { globalThis.fetch = real; }
});

// A DELEGENT run whose record 404s from a REACHABLE runner is the restart case
// (Fly autostop stopped the machine mid-run; the in-memory record is gone and a
// Route B run never auto-resumes). That is definitively LOST, not transiently
// unreachable, so past the ceiling the sweeper finalizes it as failed instead of
// hanging the turn forever. iso/iso. Self-contained stub (delegent record path).
function delegentOrphanStub(delegentRunId, createdAt) {
  const iso = new Date().toISOString();
  const calls = [];
  const bare = delegentRunId.replace(/^delegent:(cmd:)?/, '');
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    calls.push({ url, method, body });
    const ok = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && /\/rest\/v1\/task_runs\?.*status=in/.test(url)) return ok([{ id: RUN, user_id: USER, runner_task_id: delegentRunId, created_at: createdAt }]);
    if (method === 'GET' && /\/rest\/v1\/task_runs\?id=eq\./.test(url)) return ok([{ id: RUN, runner_task_id: delegentRunId }]);
    if (method === 'GET' && /\/rest\/v1\/messages/.test(url)) return ok([{ id: 'msg-1' }]);
    if (method === 'GET' && /\/rest\/v1\/subscriptions\?user_id=eq\./.test(url)) return ok([{ status: 'active', current_period_start: iso }]);
    if (method === 'GET' && /\/rest\/v1\/usage_quotas/.test(url)) return ok([{ monthly_token_quota: 99_000_000, tier_id: 'pro-office' }]);
    if (method === 'GET' && /\/rest\/v1\/token_usage_events/.test(url)) return ok([]);
    if (method === 'GET' && /\/rest\/v1\/hermes_instances\?user_id=eq\./.test(url)) return ok([{ status: 'ready', ready_at: iso, last_health_at: iso, provider: 'fly_machines' }]);
    if (method === 'GET' && /\/rest\/v1\/hermes_instance_private\?user_id=eq\./.test(url)) return ok([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }]);
    // The runner is REACHABLE but has no record of this delegent run -> 404.
    if (method === 'GET' && new RegExp(`test-app\\.fly\\.dev/v1/delegent/runs/${bare}$`).test(url)) return new Response(JSON.stringify({ error: 'run_record_not_found' }), { status: 404 });
    if (method === 'POST' && /\/rpc\/finalize_chat_message$/.test(url)) return new Response('true', { status: 200 });
    if (method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url)) return new Response('[]', { status: 200 });
    return ok([]);
  };
  return calls;
}

test('REAPS an orphaned DELEGENT run (404 record from a live runner) past the ceiling — restart safety-net', async () => {
  const real = globalThis.fetch;
  const calls = delegentOrphanStub('delegent:run_orphan', OLD);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 1, 'an orphaned (404) dispatched run past the ceiling is reaped');
    const fin = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(fin, 'the orphaned run is finalized so the turn stops hanging');
    assert.equal(fin.body.p_succeeded, false, 'finalized as FAILED (the run is lost), never a fabricated success');
    assert.equal(fin.body.p_error_code, 'runner_restarted', 'error code marks the restart cause');
  } finally { globalThis.fetch = real; }
});

test('does NOT reap an orphaned DELEGENT run still UNDER the ceiling (only reaps past the hard max)', async () => {
  const real = globalThis.fetch;
  const calls = delegentOrphanStub('delegent:run_fresh', RECENT);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 0, 'a fresh orphaned run under the ceiling is left in-flight');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no finalize under the ceiling');
  } finally { globalThis.fetch = real; }
});

test('reaps a never-dispatched run (no hermes_run_id) past the ceiling without calling the runner', async () => {
  const real = globalThis.fetch;
  const calls = stub(handlers({
    staleRows: [{ id: RUN, user_id: USER, runner_task_id: null, created_at: OLD }],
    runner: { body: { status: 'completed', output: 'should not be fetched' } },
  }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 1);
    assert.ok(!calls.some((c) => /\/v1\/runs\//.test(c.url)), 'no runner call without a hermes_run_id');
    const fin = calls.find((c) => c.url.includes('/rpc/finalize_chat_message'));
    assert.ok(fin && fin.body.p_error_code === 'runner_timeout');
  } finally { globalThis.fetch = real; }
});

test('no-ops (no writes) when nothing is stale', async () => {
  const real = globalThis.fetch;
  const calls = stub(handlers({ staleRows: [], runner: { body: {} } }));
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.deepEqual({ reaped: res.reaped, recovered: res.recovered }, { reaped: 0, recovered: 0 });
    assert.ok(!calls.some((c) => c.method === 'PATCH' || c.url.includes('finalize_chat_message')), 'no writes when nothing stale');
  } finally { globalThis.fetch = real; }
});

test('skips safely when Supabase creds are missing (no fetch attempted)', async () => {
  const real = globalThis.fetch;
  let touched = false;
  globalThis.fetch = async () => { touched = true; return new Response('[]'); };
  try {
    const res = await sweepStaleChatRuns({}, NOW);
    assert.deepEqual(res, { reaped: 0, recovered: 0, scanned: 0 });
    assert.equal(touched, false, 'must not hit the network without creds');
  } finally { globalThis.fetch = real; }
});

test('reconcile cutoff is short and the hard ceiling stays generous', () => {
  assert.ok(RECONCILE_CHAT_RUN_THRESHOLD_MS <= 2 * 60 * 1000, 'reconcile should kick in promptly so dropped runs deliver fast');
  assert.ok(STALE_CHAT_RUN_THRESHOLD_MS >= 5 * 60 * 1000, 'hard ceiling too aggressive — could give up on a live run');
  assert.ok(RECONCILE_CHAT_RUN_THRESHOLD_MS < STALE_CHAT_RUN_THRESHOLD_MS, 'reconcile must precede the hard-max reap');
});

// Audit F6: connect-code TTL sweep (same cron) — unchanged behavior.
test('sweepExpiredConnectCodes deletes only already-expired gateway_connect_codes', async () => {
  const real = globalThis.fetch;
  const calls = stub([
    { match: matchUrl('DELETE', /\/rest\/v1\/gateway_connect_codes/), respond: () => new Response('[]') },
  ]);
  try {
    const res = await sweepExpiredConnectCodes(ENV, Date.parse('2026-05-29T15:00:00.000Z'));
    assert.equal(res.ok, true);
    const del = calls.find((c) => c.url.includes('/rest/v1/gateway_connect_codes') && c.method === 'DELETE');
    assert.ok(del, 'must issue a DELETE on gateway_connect_codes');
    assert.match(decodeURIComponent(del.url), /expires_at=lt\.2026-05-29T15:00:00/, 'only deletes codes expired at now');
  } finally { globalThis.fetch = real; }
});

test('sweepExpiredConnectCodes skips safely when Supabase creds are missing', async () => {
  const real = globalThis.fetch;
  let touched = false;
  globalThis.fetch = async () => { touched = true; return new Response('[]'); };
  try {
    const res = await sweepExpiredConnectCodes({}, NOW);
    assert.equal(res.ok, false);
    assert.equal(touched, false, 'must not hit the network without creds');
  } finally { globalThis.fetch = real; }
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03: scheduled (routine) runs are swept too.
// ---------------------------------------------------------------------------
// sweepScheduledTasks parks an inconclusive dispatch in status 'dispatched'
// with a comment saying THIS sweeper finalizes it. The sweeper's kind filter
// only ever listed chat + telegram, so those rows were immortal. A scheduled
// run has no runner_task_id and no queued assistant placeholder, so it must
// take the direct-PATCH path: runner_timeout past the ceiling, untouched
// before it, and never a runner call or a Telegram push.
test('a scheduled run past the hard ceiling is closed as runner_timeout via a direct task_runs PATCH', async () => {
  const real = globalThis.fetch;
  const calls = stub([
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?.*status=in/), respond: ({ url }) => new Response(JSON.stringify([{ id: RUN, user_id: USER, runner_task_id: null, created_at: OLD }]), { status: 200, headers: { 'x-q': url } }) },
    // a routine's assistant message is written terminal by the waker, so the
    // reap helper's queued-placeholder lookup finds nothing
    { match: matchUrl('GET', /\/rest\/v1\/messages/), respond: () => new Response('[]', { status: 200 }) },
    { match: matchUrl('PATCH', /\/rest\/v1\/task_runs/), respond: () => new Response('[]', { status: 200 }) },
  ]);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 1, 'a stale scheduled run is finally closed');
    assert.equal(res.recovered, 0);
    const patch = calls.find((c) => c.method === 'PATCH' && /task_runs/.test(c.url));
    assert.ok(patch, 'closed via a direct task_runs PATCH');
    assert.equal(patch.body.status, 'failed');
    assert.equal(patch.body.error_code, 'runner_timeout');
    assert.ok(patch.url.includes(`id=eq.${RUN}`), 'patches exactly this run');
    assert.ok(!calls.some((c) => c.url.includes('/rpc/finalize_chat_message')), 'no finalize RPC without a placeholder');
    assert.ok(!calls.some((c) => c.url.includes('api.telegram.org')), 'no Telegram push');
    assert.ok(!calls.some((c) => /fly\.dev|\/tasks$|\/v1\/delegent/.test(c.url)), 'nothing on a runner to recover, so no runner call');
  } finally { globalThis.fetch = real; }
});

test('a scheduled run UNDER the ceiling is left alone (the waker may still be mid-dispatch)', async () => {
  const real = globalThis.fetch;
  const calls = stub([
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?.*status=in/), respond: () => new Response(JSON.stringify([{ id: RUN, user_id: USER, runner_task_id: null, created_at: RECENT }])) },
  ]);
  try {
    const res = await sweepStaleChatRuns(ENV, NOW);
    assert.equal(res.reaped, 0);
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'no write for a fresh scheduled run');
  } finally { globalThis.fetch = real; }
});
