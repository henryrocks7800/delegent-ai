// DEFECT HUNT 2026-06-05 — tool-card mislabel on repeated same-tool calls (#4).
// ---------------------------------------------------------------------------
// In handleChatRunEvents the SSE relay accumulates tool cards for the persisted
// transcript. A tool.completed is merged onto a prior card by TOOL NAME, not by
// toolCallId (index.ts:5707): findIndex(c.tool === tool && (c.summary === '' ||
// summary !== '')). When a completion carries a non-empty summary that predicate
// is always true for the FIRST card of that tool, so a turn that calls the SAME
// tool more than once (very common: several file writes / terminal commands)
// attaches every completion to the first card — overwriting earlier summaries
// and leaving later cards blank. The user sees the wrong / missing tool results.
//
// Trace with two file writes (ids a,b):
//   started a -> [{file,''}]
//   started b -> [{file,''},{file,''}]
//   completed a "alpha" -> idx 0 -> [{file,'alpha'},{file,''}]
//   completed b "beta"  -> idx 0 -> [{file,'beta'},{file,''}]   // 'alpha' LOST
// Fix: match the completion to its started card by toolCallId.
//
// CONTROL (two DIFFERENT tools) passes; the DEFECT test is {todo} (fails today).
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
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret',
  OPENROUTER_API_KEY: 'sk-or-test-fake',
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
function authedRequest(path, init = {}) { return new Request(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${USER_JWT}` } }); }
function readyRunnerBindingHandlers() {
  const iso = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'active' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () => new Response(JSON.stringify([{ monthly_token_quota: 16_000_000, tier_id: 'pro-office' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () => new Response(JSON.stringify([])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ status: 'ready', ready_at: iso, last_health_at: iso, provider: 'fly_machines' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () => new Response(JSON.stringify([{ runner_base_url: 'https://test-app.fly.dev', provider: 'fly_machines', fly_app_name: 'test-app', runner_shared_secret: 'per-user-secret' }])) },
  ];
}
function sseUpstream(events) {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}
async function runEventsWith(events) {
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () => new Response(JSON.stringify({ id: USER_ID })) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\.[^&]+&user_id=eq\./), respond: () => new Response(JSON.stringify([{ id: RUN_ID, runner_task_id: 'hermes_run_xyz' }])) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?task_run_id=eq\./), respond: () => new Response(JSON.stringify([{ id: '99999999-9999-4999-8999-999999999999' }])) },
    ...readyRunnerBindingHandlers(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/runs\/hermes_run_xyz\/events$/.test(url),
      respond: () => new Response(sseUpstream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => { finalizeCalls.push(JSON.parse(String(init.body))); return new Response('true', { status: 200 }); } },
  ];
  const original = globalThis.fetch; globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedRequest(`/api/chat/runs/${RUN_ID}/events`), ENV, ctxStub());
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const { done } = await reader.read(); if (done) break; }
    reader.releaseLock();
    return finalizeCalls;
  } finally { globalThis.fetch = original; }
}

const COMPLETE = 'event: response.completed\ndata: {"output":"done"}\n\n';

test('CONTROL: two DIFFERENT tools in one turn keep their own summaries', async () => {
  const finals = await runEventsWith([
    'event: tool.started\ndata: {"id":"a","tool":"file","summary":""}\n\n',
    'event: tool.started\ndata: {"id":"b","tool":"terminal","summary":""}\n\n',
    'event: tool.completed\ndata: {"id":"a","tool":"file","summary":"wrote alpha.txt"}\n\n',
    'event: tool.completed\ndata: {"id":"b","tool":"terminal","summary":"ran build"}\n\n',
    COMPLETE,
  ]);
  assert.equal(finals.length, 1, 'finalize fired once');
  const s = JSON.stringify(finals[0].p_tool_calls ?? finals[0]);
  assert.ok(s.includes('wrote alpha.txt'), 'file summary present');
  assert.ok(s.includes('ran build'), 'terminal summary present');
});

test('FIXED #4 — two calls to the SAME tool keep their own summaries (merged by toolCallId)',
  async () => {
    const finals = await runEventsWith([
      'event: tool.started\ndata: {"id":"a","tool":"file","summary":""}\n\n',
      'event: tool.started\ndata: {"id":"b","tool":"file","summary":""}\n\n',
      'event: tool.completed\ndata: {"id":"a","tool":"file","summary":"wrote alpha.txt"}\n\n',
      'event: tool.completed\ndata: {"id":"b","tool":"file","summary":"wrote beta.txt"}\n\n',
      COMPLETE,
    ]);
    assert.equal(finals.length, 1, 'finalize fired once');
    const s = JSON.stringify(finals[0].p_tool_calls ?? finals[0]);
    // DESIRED: both file writes are represented, each with its own summary.
    assert.ok(s.includes('wrote alpha.txt'), 'first file write summary must survive (it is overwritten today)');
    assert.ok(s.includes('wrote beta.txt'), 'second file write summary must be present');
  });
