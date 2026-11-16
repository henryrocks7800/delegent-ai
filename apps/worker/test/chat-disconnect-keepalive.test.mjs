// DEFECT HUNT 2026-06-05 — disconnect durability + C (keepalive).
// ---------------------------------------------------------------------------
// handleChatRunEvents' stream cancel() has been through three iterations:
//   - oldest: ALWAYS finalise FAILED (client_disconnected) -> "took too long"
//             even when the agent had produced an answer.
//   - #3:     finalise the accumulated PARTIAL text as SUCCEEDED -> truncates a
//             still-running answer.
//   - now:    on a mid-run disconnect, write NOTHING — leave the run in-flight
//             so reconcileChatRunFromRunner (status poll + cron) delivers the
//             AUTHORITATIVE full answer from /v1/runs/{id}. We only finalise here
//             when we've actually seen the upstream terminal event.
// C: pull() races the upstream read against a keepalive timer; a long, silent
// C: pull() now races the upstream read against a keepalive timer; a long, silent
// tool call (e.g. ~37s browser cold-start) emits a run.progress heartbeat instead
// of looking dead. (SIDEKICK_CHAT_KEEPALIVE_MS controls the interval; 50ms here.)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const dec = new TextDecoder();
const enc = new TextEncoder();
const baseEnv = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true', SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret', OPENROUTER_API_KEY: 'sk-or-test-fake',
};
function ctxStub() { const p = []; return { waitUntil(x) { p.push(Promise.resolve(x).catch(() => {})); }, async settle() { await Promise.all(p); } }; }
function matchUrl(method, regex) { return ({ url, method: m }) => m === method && regex.test(url); }
function makeFakeFetch(handlers) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    for (const h of handlers) if (h.match({ url, method, init })) return h.respond({ url, method, init });
    return new Response(JSON.stringify({ error: 'unmatched', url, method }), { status: 500 });
  };
}
function authedRequest(path) { return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${USER_JWT}` } }); }
function readyBinding() {
  const iso = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: iso, last_health_at: iso, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
  ];
}
function startEvents(upstream, { keepaliveMs } = {}) {
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () => new Response(JSON.stringify({ id: USER_ID })) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\.[^&]+&user_id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN_ID, runner_task_id: 'hermes_run_xyz' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?task_run_id=eq\./), respond: () => new Response(JSON.stringify([{ id: '99999999-9999-4999-8999-999999999999' }])) },
    ...readyBinding(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/runs\/hermes_run_xyz\/events$/.test(url), respond: () => new Response(upstream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => { finalizeCalls.push(JSON.parse(String(init.body))); return new Response('true', { status: 200 }); } },
  ];
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers);
  const env = { ...baseEnv, ...(keepaliveMs ? { SIDEKICK_CHAT_KEEPALIVE_MS: String(keepaliveMs) } : {}) };
  return { promise: worker.fetch(authedRequest(`/api/chat/runs/${RUN_ID}/events`), env, ctxStub()), finalizeCalls, restore: () => { globalThis.fetch = original; } };
}
const delta = (t) => `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: t })}\n\n`;
const toolStarted = (id, name) => `event: tool.started\ndata: ${JSON.stringify({ id, tool: name })}\n\n`;
const completed = (t) => `event: response.completed\ndata: ${JSON.stringify({ output: t })}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Upstream that emits `events` then STAYS OPEN (so we can cancel mid-stream).
function openUpstream(events) { return new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); } }); }
// Upstream that emits `events` then CLOSES (normal terminal completion).
function closingUpstream(events) { return new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); } }); }
// Upstream that waits `delayMs`, then emits `events` and closes.
function delayedUpstream(delayMs, events) { return new ReadableStream({ start(c) { setTimeout(() => { for (const e of events) c.enqueue(enc.encode(e)); c.close(); }, delayMs); } }); }

test('disconnect mid-reply (no terminal event) leaves the run IN-FLIGHT — does NOT persist a partial', async () => {
  // Superseded #3: the old code finalised the PARTIAL streamed text as
  // SUCCEEDED on disconnect. That truncates a still-running answer. Now we leave
  // the row in-flight so reconcileChatRunFromRunner delivers the AUTHORITATIVE
  // full answer from /v1/runs/{id} on the next status poll / cron tick.
  const { promise, finalizeCalls, restore } = startEvents(openUpstream([delta('Here is your answer.')]), { keepaliveMs: 999_999 });
  try {
    const resp = await promise;
    const reader = resp.body.getReader();
    let got = ''; const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value); if (got.includes('assistant.text.delta')) break; }
    await reader.cancel(); // simulate the mobile client dropping the SSE mid-run
    await sleep(50);
    assert.equal(finalizeCalls.length, 0, 'no finalize on a mid-run disconnect — the row stays in-flight for reconcile');
  } finally { restore(); }
});

test('disconnect with NO reply yet also leaves the run in-flight (no false "took too long")', async () => {
  // This is the EXACT live failure: a research task disconnected at ~8s (only a
  // tool had started) used to be written failed/cancelled even though the runner
  // went on to complete it. It must now stay in-flight for reconcile.
  const { promise, finalizeCalls, restore } = startEvents(openUpstream([toolStarted('t1', 'web')]), { keepaliveMs: 999_999 });
  try {
    const resp = await promise;
    const reader = resp.body.getReader();
    let got = ''; const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value); if (got.includes('tool.started')) break; }
    await reader.cancel();
    await sleep(50);
    assert.equal(finalizeCalls.length, 0, 'a disconnect must not write a terminal state; reconcile resolves it from the runner');
  } finally { restore(); }
});

test('a run that reaches the terminal event STILL finalises SUCCEEDED on normal close', async () => {
  // The flip side: when we DO see the authoritative terminal event, we finalise
  // immediately (this is the happy path the live viewer gets in real time).
  const { promise, finalizeCalls, restore } = startEvents(closingUpstream([delta('Here is your answer.'), completed('Here is your answer.')]), { keepaliveMs: 999_999 });
  try {
    const resp = await promise;
    const reader = resp.body.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }
    await sleep(50);
    assert.equal(finalizeCalls.length, 1, 'finalised on the terminal event');
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.ok(String(finalizeCalls[0].p_content).includes('Here is your answer'), 'the full reply is persisted');
  } finally { restore(); }
});

test('C — a silent upstream gap emits a keepalive heartbeat BEFORE the first real event', async () => {
  const { promise, restore } = startEvents(delayedUpstream(160, [delta('hi'), completed('hi')]), { keepaliveMs: 50 });
  try {
    const resp = await promise;
    const reader = resp.body.getReader();
    let got = ''; const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value); if (got.includes('assistant.text.delta')) break; }
    await reader.cancel();
    const beatIdx = got.indexOf('run.progress');
    const deltaIdx = got.indexOf('assistant.text.delta');
    assert.ok(beatIdx >= 0, 'a keepalive run.progress was emitted during the silent gap');
    assert.ok(deltaIdx >= 0 && beatIdx < deltaIdx, 'the keepalive came before the first real event');
  } finally { restore(); }
});
