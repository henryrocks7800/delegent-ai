// In-app chat API (v1.2.7 — chat goes through Hermes runner).
// Verifies the normalized /api/chat/* endpoints with a fake Supabase
// and a fake runner so the behaviour is exercised end-to-end without
// needing real services.
//
// v1.2.7 reverses the v1.2.1 shortcut: chat now dispatches to the
// user's per-user Hermes runner (the same way Telegram does), so the
// agent has terminal/file/web tools and can actually do work. The
// trade-off is a small cold-start when the runner is sleeping; that
// failure mode is exercised by the runner_not_ready test below.
//
// IMPORTANT: runs against ../dist/index.js. Always `npm test` from the
// worker workspace so the build runs first.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const SERVICE_ROLE = 'service_role_test';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ENV = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_runner_secret_legacy_only_for_other_paths',
  OPENROUTER_API_KEY: 'sk-or-test-fake',
};

function ctxStub() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(Promise.resolve(p).catch(() => {})); },
    async settle() { await Promise.all(promises); },
  };
}

function makeFakeFetch(handlers) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    for (const handler of handlers) {
      const match = handler.match({ url, method, init });
      if (match) {
        const r = await handler.respond({ url, method, init, match });
        return r;
      }
    }
    return new Response(JSON.stringify({ error: 'unmatched', url, method }), { status: 500 });
  };
}

function matchUrl(method, regex) {
  return ({ url, method: m }) => m === method && regex.test(url);
}

function authedRequest(path, init = {}) {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${USER_JWT}` },
  });
}

// Derived from now rather than pinned: the usage anchor rolls forward once a stored
// billing period has demonstrably ended, so a hardcoded period would silently drift
// out of the live window and turn these voice tests into anchor-drift tests instead.
const DAY_MS = 86_400_000;
const CYCLE_START = new Date(Date.now() - 5 * DAY_MS).toISOString();
const CYCLE_END = new Date(Date.now() + 25 * DAY_MS).toISOString();
const PREVIOUS_CYCLE_START = new Date(Date.now() - 40 * DAY_MS).toISOString();

function authedVoiceTranscribeRequest({ durationSeconds = 5 } = {}) {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/m4a' }), 'voice.m4a');
  form.append('duration_seconds', String(durationSeconds));
  return authedRequest('/api/audio/transcribe', {
    method: 'POST',
    body: form,
  });
}

// ---------------------------------------------------------------------------
// POST /api/audio/transcribe
// ---------------------------------------------------------------------------
test('GIVEN voice minutes are exhausted WHEN transcribing audio THEN respond 402 before provider spend and record a voice violation', async () => {
  const providerCalls = [];
  const violationCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active', current_period_start: CYCLE_START, current_period_end: CYCLE_END }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        tier_id: 'studio',
        voice_seconds_quota: 60,
        consumed_voice_seconds: 60,
        billing_cycle_anchor: CYCLE_START,
      }]))) },
    { match: matchUrl('POST', /\/rest\/v1\/usage_violations/), respond: ({ init }) => {
      violationCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('', { status: 201 }));
    }},
    { match: matchUrl('POST', /\/audio\/transcriptions$/), respond: () => {
      providerCalls.push(true);
      return Promise.resolve(new Response(JSON.stringify({ text: 'Should not be called' }), { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedVoiceTranscribeRequest({ durationSeconds: 5 }), ENV, ctxStub());
    assert.equal(resp.status, 402);
    const body = await resp.json();
    assert.equal(body.error, 'quota_exhausted');
    assert.equal(body.pause?.capKind, 'voice');
    assert.equal(body.requested, 5);
    assert.equal(body.remaining, 0);
    assert.equal(providerCalls.length, 0, 'voice quota must be checked before the transcription provider is called');
    assert.equal(violationCalls.length, 1, 'voice quota denial should write an audit row');
    assert.equal(violationCalls[0].cap_kind, 'voice');
    assert.equal(violationCalls[0].requested, 5);
    assert.equal(violationCalls[0].available, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN voice minutes remain WHEN transcription succeeds THEN consumed_voice_seconds advances for the same billing cycle', async () => {
  // Defect hunt 2026-06-10 (L5): same-period settlement now goes through the
  // atomic increment_voice_usage RPC (migration 0042) instead of an absolute
  // read-modify-write PATCH that lost a debit under concurrency.
  const rpcCalls = [];
  const providerCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active', current_period_start: CYCLE_START, current_period_end: CYCLE_END }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        tier_id: 'studio',
        voice_seconds_quota: 60,
        consumed_voice_seconds: 10,
        billing_cycle_anchor: CYCLE_START,
      }]))) },
    { match: matchUrl('POST', /\/audio\/transcriptions$/), respond: () => {
      providerCalls.push(true);
      return Promise.resolve(new Response(JSON.stringify({ text: 'Book the dentist tomorrow' }), { status: 200 }));
    }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/increment_voice_usage$/), respond: ({ init }) => {
      rpcCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('15', { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedVoiceTranscribeRequest({ durationSeconds: 5 }), ENV, ctxStub());
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.text, 'Book the dentist tomorrow');
    assert.equal(providerCalls.length, 1);
    assert.equal(rpcCalls.length, 1, 'successful voice transcription must settle through the atomic RPC');
    assert.equal(rpcCalls[0].p_user_id, USER_ID);
    assert.equal(rpcCalls[0].p_seconds, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN a NEW billing period (anchor drift) WHEN transcription succeeds THEN the counter resets absolutely and re-anchors', async () => {
  const quotaPatchCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active', current_period_start: CYCLE_START, current_period_end: CYCLE_END }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        tier_id: 'studio',
        voice_seconds_quota: 60,
        consumed_voice_seconds: 59,
        billing_cycle_anchor: PREVIOUS_CYCLE_START,
      }]))) },
    { match: matchUrl('POST', /\/audio\/transcriptions$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ text: 'Fresh month' }), { status: 200 })) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/usage_quotas\?user_id=eq\./.test(url), respond: ({ init }) => {
      quotaPatchCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{ consumed_voice_seconds: 5 }]), { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedVoiceTranscribeRequest({ durationSeconds: 5 }), ENV, ctxStub());
    assert.equal(resp.status, 200);
    assert.equal(quotaPatchCalls.length, 1, 'anchor drift settles via the absolute reset PATCH');
    assert.equal(quotaPatchCalls[0].consumed_voice_seconds, 5, 'last period consumption must not carry into the new period');
    assert.equal(quotaPatchCalls[0].billing_cycle_anchor, CYCLE_START);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations
// ---------------------------------------------------------------------------
test('GIVEN a signed-in user WHEN they list conversations THEN they get exactly one — their own — with their agent name', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID, email: 'h@example.com' }))) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\.[^&]+&select=/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova', updated_at: '2026-05-16T12:00:00Z' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\.[^&]+&select=/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ created_at: '2026-05-16T11:00:00Z' }]))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(authedRequest('/api/chat/conversations'), ENV, ctx);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.conversations.length, 1);
    assert.equal(body.conversations[0].id, USER_ID);
    assert.equal(body.conversations[0].agentName, 'Nova');
    assert.equal(body.conversations[0].lastMessageAt, '2026-05-16T11:00:00Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN no Authorization header WHEN listing conversations THEN respond 401 unauthenticated', async () => {
  const resp = await worker.fetch(new Request(`${BASE}/api/chat/conversations`), ENV, ctxStub());
  assert.equal(resp.status, 401);
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/messages
// ---------------------------------------------------------------------------
test('GIVEN user A signed in WHEN listing user B conversation messages THEN respond 403 forbidden (cross-tenant isolation)', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID, email: 'h@example.com' }))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/conversations/99999999-9999-4999-8999-999999999999/messages'),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN a user with prior chat history WHEN they list their messages THEN the rows come back in normalized shape', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\.[^&]+&select=/), respond: () =>
      // Supabase is queried newest-first (order=created_at.desc); the worker
      // reverses to ascending for the chat. Return rows desc here to match real
      // PostgREST behaviour for that order.
      Promise.resolve(new Response(JSON.stringify([
        { id: 'msg-2', conversation_id: USER_ID, claimed: true, role: 'assistant', content: 'Hello, my name is Nova.', status: 'complete', task_run_id: RUN_ID, attachment_metadata: [], created_at: '2026-05-16T12:00:01Z', updated_at: '2026-05-16T12:00:05Z' },
        { id: 'msg-1', conversation_id: USER_ID, claimed: true, role: 'user', content: 'hi', status: 'complete', task_run_id: null, attachment_metadata: [], created_at: '2026-05-16T12:00:00Z', updated_at: '2026-05-16T12:00:00Z' },
      ]))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.conversationId, USER_ID);
    assert.equal(body.messages.length, 2);
    // Rendered ascending (oldest at top) after the worker's reverse.
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, 'hi');
    assert.equal(body.messages[0].status, 'complete');
    assert.deepEqual(body.messages[0].attachments, []);
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].taskRunId, RUN_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REGRESSION: messages list fetches NEWEST-first (created_at.desc) so a long history is not frozen at its oldest window', async () => {
  // The bug: order=created_at.asc + limit returned the OLDEST N rows, so once a
  // conversation grew past the limit the chat froze at its start and never
  // showed recent turns ("history reverts to an old message / loses yesterday").
  let capturedUrl = '';
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\.[^&]+&select=/), respond: ({ url }) => {
      capturedUrl = url;
      // newest-first, as real PostgREST returns for order=created_at.desc
      return Promise.resolve(new Response(JSON.stringify([
        { id: 'm-new', conversation_id: USER_ID, claimed: true, role: 'assistant', content: 'newest', status: 'complete', task_run_id: null, attachment_metadata: [], created_at: '2026-06-14T07:00:00Z', updated_at: '2026-06-14T07:00:00Z' },
        { id: 'm-old', conversation_id: USER_ID, claimed: true, role: 'assistant', content: 'older', status: 'complete', task_run_id: null, attachment_metadata: [], created_at: '2026-06-13T07:00:00Z', updated_at: '2026-06-13T07:00:00Z' },
      ])));
    } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages?limit=50`),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    // Must page from the NEWEST end so the window holds recent turns.
    assert.match(capturedUrl, /order=created_at\.desc/, 'must fetch newest-first, not created_at.asc (the frozen-at-start bug)');
    // Rendered ascending: the newest message is LAST (bottom of the chat).
    assert.equal(body.messages[0].id, 'm-old');
    assert.equal(body.messages[body.messages.length - 1].id, 'm-new');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/messages
// ---------------------------------------------------------------------------
function readyRunnerBindingHandlers() {
  const isoNow = new Date().toISOString();
  return [
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ monthly_token_quota: 1000000, tier_id: 'studio' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        status: 'ready',
        ready_at: isoNow,
        last_health_at: isoNow,
        provider: 'fly_machines',
      }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        runner_base_url: 'https://test-app.fly.dev',
        provider: 'fly_machines',
        fly_app_name: 'test-app',
        runner_shared_secret: 'per-user-secret',
      }]))) },
  ];
}

function readyStreamingCapabilitiesHandler() {
  return {
    match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url),
    respond: () => Promise.resolve(new Response(JSON.stringify({
      object: 'hermes.api_server.capabilities',
      available: true,
      features: {
        run_submission: true,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
      },
    }), { status: 200 })),
  };
}

test('v1.2.7 GIVEN active sub + ready runner WHEN sending a chat message THEN dispatch goes through the runner /tasks (NOT OpenRouter)', async () => {
  const openRouterCalls = [];
  const runnerCalls = [];
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 200 })) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: () => {
      openRouterCalls.push(true);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }},
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: ({ init }) => {
        runnerCalls.push({ body: JSON.parse(String(init.body)), headers: init.headers });
        // Regression guard (runner_empty_reply, 2026-05-30): real runners
        // return the assistant text in `stdout`; the optional `result` field is
        // only present when the runner extracts a distinct final-answer block,
        // which it does NOT for a plain greeting. The worker must therefore
        // read `stdout` when `result` is absent. Before the fix it read only
        // `result` and finalised every ordinary reply as runner_empty_reply.
        return Promise.resolve(new Response(JSON.stringify({
          task_id: 'task-1',
          status: 'completed',
          stdout: 'Hi! I am Nova — what shall we work on?',
          stderr: '',
          tool_calls: [
            { tool: 'file', summary: 'created test.txt' },
          ],
        }), { status: 200 }));
    }},
    { match: ({ method, url }) => method === 'POST' && /\/rest\/v1\/token_usage_events/.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 201 })) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true', { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello agent' }),
      }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 202);
    const body = await resp.json();
    assert.equal(body.userMessage.role, 'user');
    assert.equal(body.userMessage.content, 'hello agent');
    assert.equal(body.assistantPlaceholder.status, 'queued');
    assert.equal(body.taskRunId, RUN_ID);

    await ctx.settle();

    assert.equal(openRouterCalls.length, 0, 'v1.2.7 must NOT call OpenRouter directly');
    assert.equal(runnerCalls.length, 1, 'runner /tasks must be called once');
    const runnerBody = runnerCalls[0].body;
    assert.equal(runnerBody.user_id, USER_ID);
    assert.equal(runnerBody.instruction, 'hello agent');
    assert.equal(runnerBody.agent_name, 'Nova');
    assert.equal(runnerCalls[0].headers['x-sidekick-user-id'], USER_ID);
    assert.match(runnerCalls[0].headers['x-sidekick-runner-token'], /^v1\./);

    assert.equal(finalizeCalls.length, 1, 'finalize_chat_message must be called once');
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.match(finalizeCalls[0].p_content, /Nova/);
    assert.ok(Array.isArray(finalizeCalls[0].p_tool_calls), 'p_tool_calls must be an array');
    assert.equal(finalizeCalls[0].p_tool_calls.length, 1);
    assert.equal(finalizeCalls[0].p_tool_calls[0].tool, 'file');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN active sub + ready runner WHEN POST /api/chat/warm THEN respond 200 warmed:true and fire a best-effort /healthz wake (no dispatch)', async () => {
  const healthzCalls = [];
  const runnerTaskCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/healthz$/.test(url),
      respond: ({ url }) => { healthzCalls.push(url); return Promise.resolve(new Response('{"ok":true}', { status: 200 })); } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: () => { runnerTaskCalls.push(true); return Promise.resolve(new Response('{}', { status: 200 })); } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest('/api/chat/warm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, warmed: true });

    await ctx.settle();

    assert.equal(healthzCalls.length, 1, 'warm must fire exactly one /healthz wake');
    assert.match(healthzCalls[0], /test-app\.fly\.dev\/healthz$/);
    assert.equal(runnerTaskCalls.length, 0, 'warm must NOT dispatch a task (no runner spend)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN no active subscription WHEN POST /api/chat/warm THEN respond 200 warmed:false and never touch the runner', async () => {
  const healthzCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'canceled' }]))) },
    { match: ({ method, url }) => method === 'GET' && /fly\.dev\/healthz$/.test(url),
      respond: ({ url }) => { healthzCalls.push(url); return Promise.resolve(new Response('{}', { status: 200 })); } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest('/api/chat/warm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, warmed: false });
    await ctx.settle();
    assert.equal(healthzCalls.length, 0, 'no runner wake when there is no live runner');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN no Authorization header WHEN POST /api/chat/warm THEN respond 401 unauthenticated', async () => {
  const resp = await worker.fetch(
    new Request(`${BASE}/api/chat/warm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ENV,
    ctxStub(),
  );
  assert.equal(resp.status, 401);
});

test('GIVEN the user has no active subscription WHEN they send a message THEN respond 402 no_active_subscription', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ message: 'no_active_subscription' }), { status: 500 })) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 402);
    const body = await resp.json();
    assert.equal(body.error, 'no_active_subscription');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN monthly assistant time is exhausted WHEN sending a chat message THEN respond with quota recovery details before enqueueing work', async () => {
  const enqueueCalls = [];
  const runnerCalls = [];
  const violationCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ current_period_start: '2026-05-01T00:00:00.000Z' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        monthly_token_quota: 100,
        tier_id: 'studio',
      }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ total_tokens: 100 }]))) },
    { match: matchUrl('POST', /\/rest\/v1\/usage_violations/), respond: ({ init }) => {
      violationCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('', { status: 201 }));
    }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: ({ init }) => {
      enqueueCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }])));
    }},
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url), respond: () => {
      runnerCalls.push(true);
      return Promise.resolve(new Response(JSON.stringify({ status: 'completed', result: 'should not run' })));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'please write a file' }),
      }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 402);
    const body = await resp.json();
    assert.equal(body.error, 'quota_exhausted');
    assert.equal(body.reason, 'tier_limit_exceeded');
    assert.equal(body.tierId, 'studio');
    assert.equal(body.used, 100);
    assert.equal(body.limit, 100);
    assert.equal(body.remaining, 0);
    assert.equal(body.requested, 0);
    assert.equal(body.pause?.capKind, 'token');
    assert.equal(body.pause?.reason, 'tier_limit_exceeded');
    assert.match(body.pause?.primary ?? '', /included assistant time/);
    assert.match(body.pause?.secondary ?? '', /upgrade/i);
    assert.equal(enqueueCalls.length, 0, 'quota-blocked sends must not create chat rows or task runs');
    assert.equal(runnerCalls.length, 0, 'quota-blocked sends must not reach the runner');
    assert.equal(violationCalls.length, 1, 'quota-blocked sends should be auditable');
    assert.equal(violationCalls[0].cap_kind, 'token');
    assert.equal(violationCalls[0].requested, 0);
    assert.equal(violationCalls[0].available, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v1.2.9 GIVEN ready runner binding but runner fetch throws WHEN sending a chat THEN fail closed and never bypass through OpenRouter', async () => {
  // Contract hardening for per-user isolation: once a user is marked
  // ready and we have their dedicated runner binding, a transport error
  // to /tasks must NOT silently route the same request through the shared
  // OpenRouter fallback path. That bypass would sever the user's private
  // workspace/tool context while still returning a seemingly-successful
  // assistant reply.
  const openRouterCalls = [];
  const finalizeCalls = [];
  const runnerCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: () => {
        runnerCalls.push(true);
        return Promise.reject(new Error('runner network down'));
      }},
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: () => {
      openRouterCalls.push(true);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'this should never be used in ready-runner mode' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })));
    }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true'));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'write hello.txt in home/' }),
      }),
      // Boot-transition retry off (2026-09-06): with it on, a dropped
      // connection is retried for 20 s before failing closed, which is right in
      // production and beside the point here. runner-boot-retry.test.mjs pins
      // the retry itself; this test pins the fail-closed contract.
      { ...ENV, SIDEKICK_RUNNER_BOOT_RETRY_BUDGET_MS: '0' },
      ctx,
    );
    assert.equal(resp.status, 202);
    await ctx.settle();

    assert.equal(runnerCalls.length, 1, 'ready binding must still attempt runner /tasks first');
    assert.equal(openRouterCalls.length, 0, 'ready binding failure must not bypass to OpenRouter fallback');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, false, 'ready-runner transport failure must finalize as failed');
    assert.equal(finalizeCalls[0].p_error_code, 'runner_unreachable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v1.2.10 GIVEN runner-binding lookup fails WHEN sending a chat THEN fail closed and never fall back through shared OpenRouter', async () => {
  // Trust-boundary hardening: if we cannot resolve the user's runner binding
  // (Supabase outage / control-plane error), we must fail closed. Falling back
  // to shared OpenRouter here would bypass per-user workspace dispatch and can
  // fabricate successful replies for file/terminal asks that never touched the
  // user's dedicated workspace.
  const openRouterCalls = [];
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    // fetchUsageSnapshot in the send path is best-effort and swallows this
    // error; the dispatch path then hits the same lookup and currently decides
    // whether to fail closed or use fallback.
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'db_unavailable' }), { status: 500 })) },
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: () => {
      openRouterCalls.push(true);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'this should never be used when binding lookup fails' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })));
    }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true'));
    }},
    { match: ({ method, url }) => method === 'POST' && /\/rest\/v1\/token_usage_events/.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 201 })) },
    // Fallback path may still attempt best-effort profile/history reads.
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'create hello.txt in my home folder' }),
      }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 202);
    await ctx.settle();

    assert.equal(openRouterCalls.length, 0, 'binding lookup failures must not bypass through shared fallback');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, false);
    assert.equal(finalizeCalls[0].p_error_code, 'chat_unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v2.0.1 GIVEN runner not yet provisioned WHEN sending a chat THEN fail closed with runner_not_ready and NEVER call OpenRouter', async () => {
  // v2.0.1 (operator request): the old v1.2.8 OpenRouter fallback was REMOVED.
  // A not-ready runner must NOT silently answer via a tool-less OpenRouter call
  // (that hid real provisioning defects and made tool-only asks fake-succeed).
  // It must fail closed with an honest runner_not_ready status and ZERO
  // OpenRouter calls, so a real response always means the real runner answered.
  const openRouterCalls = [];
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/(token_usage_events|usage_quotas)/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'provisioning' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: ({ init }) => {
      openRouterCalls.push({ body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hi Alex — my workspace is still spinning up.' } }],
        usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      })));
    }},
    { match: ({ method, url }) => method === 'POST' && /\/rest\/v1\/token_usage_events/.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 201 })) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true'));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      }),
      ENV,
      ctx,
    );
    assert.equal(resp.status, 202);
    await ctx.settle();

    assert.equal(openRouterCalls.length, 0, 'no OpenRouter fallback: a not-ready runner must never be silently answered by a direct OpenRouter call');
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0].p_succeeded, false, 'a not-ready runner fails closed, not a fake success');
    assert.equal(finalizeCalls[0].p_error_code, 'runner_not_ready', 'honest runner_not_ready status so we know the real runner was not reached');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN an empty content WHEN sending a chat message THEN respond 400 content_required', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '   ' }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'content_required');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN a message with attachments WHEN sent THEN attachments are sanitized + bounded to 4 entries', async () => {
  const enqueueBodies = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: ({ init }) => {
      enqueueBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }])));
    }},
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Nova' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: () => Promise.resolve(new Response(JSON.stringify({
        task_id: 'task-attached', status: 'completed', result: 'ok', tool_calls: [],
      }))) },
    { match: ({ method, url }) => method === 'POST' && /\/rest\/v1\/token_usage_events/.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 201 })) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: () =>
      Promise.resolve(new Response('true')) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'check this out',
          attachments: [
            { id: 'att_1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 12 },
            { id: 'att_2', name: 'b.md', mimeType: 'text/markdown', sizeBytes: 34 },
            { id: 'att_3', name: 'c.json', mimeType: 'application/json', sizeBytes: 56 },
            { id: 'att_4', name: 'd.csv', mimeType: 'text/csv', sizeBytes: 78 },
            { id: 'att_5_overflow', name: 'overflow.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
            { name: 'missing-id', mimeType: 'text/plain', sizeBytes: 1 }, // dropped — no id
            'not-an-object', // dropped
          ],
        }),
      }),
      ENV,
      ctx,
    );
    await ctx.settle();
    assert.equal(enqueueBodies.length, 1);
    const enqueued = enqueueBodies[0].p_attachment_metadata;
    assert.equal(enqueued.length, 4, 'attachments must be capped at 4');
    assert.deepEqual(enqueued.map((x) => x.id), ['att_1', 'att_2', 'att_3', 'att_4']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/runs/:runId
// ---------------------------------------------------------------------------
test('GIVEN a queued run WHEN polled THEN status=queued with no assistant message yet', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\.[^&]+/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: RUN_ID, status: 'queued', error_code: null, kind: 'chat', created_at: '...', completed_at: null }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedRequest(`/api/chat/runs/${RUN_ID}`), ENV, ctxStub());
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.runId, RUN_ID);
    assert.equal(body.status, 'queued');
    assert.equal(body.assistantMessage, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN a completed run WHEN polled THEN the assistant message comes back with content', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: RUN_ID, status: 'succeeded', kind: 'chat', error_code: null, completed_at: '2026-05-16T12:00:05Z' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        id: 'msg-asst',
        conversation_id: USER_ID, claimed: true,
        role: 'assistant',
        content: 'Hello, my name is Nova.',
        status: 'complete',
        task_run_id: RUN_ID,
        attachment_metadata: [],
        created_at: '2026-05-16T12:00:00Z',
        updated_at: '2026-05-16T12:00:05Z',
      }]))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedRequest(`/api/chat/runs/${RUN_ID}`), ENV, ctxStub());
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.status, 'succeeded');
    assert.equal(body.assistantMessage.role, 'assistant');
    assert.equal(body.assistantMessage.content, 'Hello, my name is Nova.');
    assert.equal(body.assistantMessage.taskRunId, RUN_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GIVEN an invalid run id WHEN polled THEN respond 400 invalid_run_id', async () => {
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedRequest('/api/chat/runs/not-a-uuid'), ENV, ctxStub());
    assert.equal(resp.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D38 GIVEN listMessages WHEN messages share a created_at THEN the user bubble still renders above its assistant placeholder', async () => {
  // enqueue_chat_message inserts the user message AND the assistant placeholder
  // with the same p_now. We fetch NEWEST-first (created_at.desc,role.asc) so the
  // limit keeps recent turns, then reverse to ascending for the chat — which
  // turns the tie-break into created_at.asc,role.desc, i.e. user before assistant.
  const orderParams = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: ({ method, url }) => method === 'GET' && /\/rest\/v1\/messages\?/.test(url),
      respond: ({ url }) => {
        const u = new URL(url);
        orderParams.push(u.searchParams.get('order'));
        // Real PostgREST for order=created_at.desc,role.asc: on a shared
        // created_at, 'assistant' sorts before 'user'.
        return Promise.resolve(new Response(JSON.stringify([
          { id: 'a', conversation_id: USER_ID, claimed: true, role: 'assistant', content: '', status: 'queued', task_run_id: RUN_ID, attachment_metadata: [], created_at: '2026-05-16T12:00:00Z', updated_at: '2026-05-16T12:00:00Z' },
          { id: 'u', conversation_id: USER_ID, claimed: true, role: 'user', content: 'hi', status: 'complete', task_run_id: null, attachment_metadata: [], created_at: '2026-05-16T12:00:00Z', updated_at: '2026-05-16T12:00:00Z' },
        ]), { status: 200 }));
      } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, { method: 'GET' }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 200);
    assert.equal(orderParams.length, 1, 'one upstream messages query');
    assert.equal(orderParams[0], 'created_at.desc,role.asc,id.desc',
      'fetch newest-first (created_at.desc) so the limit keeps recent turns; role.asc makes the post-reverse order user-before-assistant');
    const body = await resp.json();
    assert.equal(body.messages[0].role, 'user', 'user bubble renders above its assistant placeholder on a shared created_at');
    assert.equal(body.messages[1].role, 'assistant');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/runs — D36 streaming path must inject agent identity
// ---------------------------------------------------------------------------
test('D36 GIVEN a streaming run POST WHEN the runner accepts /v1/runs THEN payload.instructions names the agent and bans Hermes identity leak', async () => {
  const runsPayloads = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }]))) },
    // 2026-06-03 amnesia fix: the streaming path now loads recent history. No prior
    // turns in this test, so return an empty conversation.
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url),
      respond: ({ init }) => {
        runsPayloads.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ run_id: 'hermes_run_abc', status: 'started' }), { status: 201 }));
      }},
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 200 })) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'who are you?', conversationId: USER_ID }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 201);
    assert.equal(runsPayloads.length, 1, '/v1/runs must be called exactly once');
    const payload = runsPayloads[0];
    // 2026-06-03 amnesia fix: the streaming path renders the message into a
    // "Current request from user: ..." input (with prior history prepended when it
    // exists). No prior turns here, so it is just the current request — and it MUST
    // carry the user's message so the agent acts on it.
    assert.ok(payload.input.includes('who are you?'), 'the new message must be present in the run input');
    assert.equal(payload.input, 'Current request from user: who are you?');
    assert.equal(typeof payload.instructions, 'string', 'instructions must be a string');
    const instructions = payload.instructions;
    assert.ok(instructions.includes('Barry'), 'instructions must include the configured agent name');
    assert.ok(/never .*Hermes/i.test(instructions), 'instructions must explicitly ban "Hermes" identity');
    assert.ok(!/Nous Research/i.test(instructions), 'instructions must not name Nous Research');
    assert.ok(!/em.?dash/i.test(instructions) || /never use em.?dash/i.test(instructions),
      'either no mention of em-dashes or the rule explicitly forbids them');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D39 GIVEN a streaming run POST with attachments WHEN enqueued THEN attachment metadata is sanitized and persisted like the legacy chat path', async () => {
  const enqueueBodies = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }]))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: ({ init }) => {
      enqueueBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }])));
    }},
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url),
      respond: () => Promise.resolve(new Response(JSON.stringify({ run_id: 'hermes_run_with_attachments', status: 'started' }), { status: 201 })) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 200 })) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'summarise these attachments',
          conversationId: USER_ID,
          attachments: [
            { id: 'att_1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 12 },
            { id: 'att_2', name: 'b.md', mimeType: 'text/markdown', sizeBytes: 34 },
            { id: 'att_3', name: 'c.json', mimeType: 'application/json', sizeBytes: 56 },
            { id: 'att_4', name: 'd.csv', mimeType: 'text/csv', sizeBytes: 78 },
            { id: 'att_5_overflow', name: 'overflow.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
            { name: 'missing-id', mimeType: 'text/plain', sizeBytes: 1 },
            'not-an-object',
          ],
        }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 201);
    assert.equal(enqueueBodies.length, 1, 'streaming path must enqueue exactly once');
    const enqueued = enqueueBodies[0].p_attachment_metadata;
    assert.equal(enqueued.length, 4, 'streaming attachments must be capped at 4 like /messages');
    assert.deepEqual(enqueued.map((x) => x.id), ['att_1', 'att_2', 'att_3', 'att_4']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D44 GIVEN runner is ready but streaming capabilities are unavailable WHEN creating a run THEN return fallback signal without persisting a ghost chat', async () => {
  const capabilityCalls = [];
  const enqueueCalls = [];
  const runCreateCalls = [];
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url),
      respond: ({ init }) => {
        capabilityCalls.push(init.headers);
        return Promise.resolve(new Response(JSON.stringify({
          object: 'hermes.api_server.capabilities',
          available: false,
          reason: 'starting',
          features: {
            run_submission: false,
            run_status: false,
            run_events_sse: false,
            run_stop: false,
          },
        }), { status: 200 }));
      }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: ({ init }) => {
      enqueueCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }])));
    }},
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }]))) },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url),
      respond: ({ init }) => {
        runCreateCalls.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ detail: 'hermes_api_server_unavailable:starting' }), { status: 503 }));
      }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true', { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'please draft my invoice follow-up', conversationId: USER_ID }),
      }),
      // Boot-transition retry off: this pins the "give up cleanly" contract.
      // The retry itself is pinned by the test right after this one.
      { ...ENV, SIDEKICK_RUNNER_BOOT_RETRY_BUDGET_MS: '0' },
      ctxStub(),
    );
    assert.equal(resp.status, 503);
    const body = await resp.json();
    assert.equal(body.error, 'streaming_unavailable');
    assert.equal(capabilityCalls.length, 1, 'Worker must check /v1/capabilities before deciding whether to stream');
    assert.equal(enqueueCalls.length, 0, 'fallback should not persist a failed streaming user/assistant pair before legacy chat retries');
    assert.equal(runCreateCalls.length, 0, 'fallback should not call /v1/runs after capabilities say SSE is unavailable');
    assert.equal(finalizeCalls.length, 0, 'no ghost assistant row means there is nothing to finalize as failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2026-09-06 GIVEN the runner is still warming after a Fly restart WHEN creating a run THEN the capabilities check is retried until it is ready, not failed on the first answer', async () => {
  // Live on 2026-09-06 21:18 UTC: the first chat after Barry slept got
  // `available: false, reason: starting` from a machine that had booted two
  // seconds earlier, and the Worker answered 503 straight away. The retry
  // budget here is 5 s: two 1.5 s waits, then the third answer is ready.
  const capabilityCalls = [];
  const enqueueCalls = [];
  const runCreateCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/capabilities$/.test(url),
      respond: () => {
        capabilityCalls.push(Date.now());
        const ready = capabilityCalls.length >= 3;
        return Promise.resolve(new Response(JSON.stringify({
          object: 'hermes.api_server.capabilities',
          available: ready,
          reason: ready ? undefined : 'starting',
          features: { run_submission: ready, run_status: ready, run_events_sse: ready, run_stop: ready },
        }), { status: 200 }));
      }},
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: ({ init }) => {
      enqueueCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }])));
    }},
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('GET', /\/rest\/v1\/user_connections/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    // Whatever the run does after the pre-flight is not under test here; a
    // 503 from run creation is the shortest honest path to a response, and
    // reaching it at all proves the pre-flight let the chat through.
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/(runs|delegent\/message)$/.test(url),
      respond: ({ url }) => { runCreateCalls.push(url); return Promise.resolve(new Response(JSON.stringify({ detail: 'hermes_api_server_unavailable:starting' }), { status: 503 })); } },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: () =>
      Promise.resolve(new Response('true', { status: 200 })) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello after a nap', conversationId: USER_ID }),
      }),
      { ...ENV, SIDEKICK_RUNNER_BOOT_RETRY_BUDGET_MS: '5000' },
      ctxStub(),
    );
    assert.equal(capabilityCalls.length, 3, 'two not-ready answers must be retried, the third is ready');
    assert.ok(capabilityCalls[2] - capabilityCalls[0] >= 2_500, 'retries wait between attempts rather than hammering the runner');
    assert.equal(enqueueCalls.length, 1, 'once the runner is ready the chat proceeds to enqueue');
    assert.ok(runCreateCalls.length >= 1, 'the run must reach run creation, i.e. the pre-flight let it through');
    assert.ok(resp.status === 503 || resp.status === 201, `response comes from run creation, not the pre-flight, got ${resp.status}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D37 GIVEN an SSE stream that emits run.completed but stays open THEN finalize_chat_message fires immediately and downstream closes', async () => {
  const finalizeCalls = [];
  // Build an upstream SSE that emits one delta + one run.completed, then
  // *stays open* (a pending promise that resolves with `done:true` only
  // after the Worker cancels the reader). This is the failure mode the
  // user hit: upstream forgets to close, Worker would wait forever.
  let upstreamCancelled = false;
  // Upstream Hermes API server emits raw events (NOT pre-normalised).
  // The Worker's normaliseHermesEvent reads `data.output` for run.completed
  // text and `data.delta` for streaming text. Match that real shape so the
  // accumulator picks up the final text just like in production.
  const upstream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(
        'event: response.output_text.delta\ndata: {"delta":"Hello "}\n\n',
      ));
      controller.enqueue(encoder.encode(
        'event: response.completed\ndata: {"output":"Hello from Nova."}\n\n',
      ));
      // Intentionally do NOT close the controller; we let the Worker
      // detect the terminal event and cancel us.
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('GET', /\/rest\/v1\/task_runs\?id=eq\.[^&]+&user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: RUN_ID, runner_task_id: 'hermes_run_xyz' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?task_run_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: '99999999-9999-4999-8999-999999999999' }]))) },
    ...readyRunnerBindingHandlers(),
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/v1\/runs\/hermes_run_xyz\/events$/.test(url),
      respond: () => Promise.resolve(new Response(upstream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('true', { status: 200 }));
    }},
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(authedRequest(`/api/chat/runs/${RUN_ID}/events`), ENV, ctxStub());
    assert.equal(resp.status, 200);
    // Drain the downstream so the Worker pulls upstream chunks. Must
    // resolve within a bounded time; without the D37 fix this hangs.
    const reader = resp.body.getReader();
    let chunks = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += new TextDecoder().decode(value);
      if (chunks.includes('"type":"run.completed"')) {
        // Give the Worker one more tick to flush its finalize call,
        // then verify the downstream eventually closes.
        const more = await reader.read();
        if (more.done) break;
        chunks += new TextDecoder().decode(more.value);
      }
    }
    reader.releaseLock();
    assert.ok(chunks.includes('"type":"assistant.text.delta"'), 'delta forwarded');
    assert.ok(chunks.includes('"type":"run.completed"'), 'run.completed forwarded');
    assert.equal(finalizeCalls.length, 1, 'finalize_chat_message fired exactly once');
    assert.equal(finalizeCalls[0].p_succeeded, true);
    assert.equal(finalizeCalls[0].p_content, 'Hello from Nova.');
    assert.equal(upstreamCancelled, true, 'Worker cancelled the upstream reader on terminal event');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D36 GIVEN a streaming run POST WHEN the profile has no agent_name THEN fallback name is used and identity still framed', async () => {
  const runsPayloads = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url),
      respond: ({ init }) => {
        runsPayloads.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ run_id: 'hermes_run_def', status: 'started' }), { status: 201 }));
      }},
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 200 })) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello', conversationId: USER_ID }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 201);
    assert.equal(runsPayloads.length, 1);
    const instructions = runsPayloads[0].instructions;
    assert.equal(typeof instructions, 'string');
    assert.ok(instructions.length > 50, 'fallback identity prompt is still substantive');
    assert.ok(/never .*Hermes/i.test(instructions), 'fallback prompt still bans Hermes identity');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-06-07: slash commands are no longer special-cased. The app does not
// advertise them and the worker does not intercept them — a "/message" is
// dispatched to the agent like any other text. Hermes owns command semantics;
// it only implements them on its messaging adapters, not the REST api_server we
// use. This guards against re-adding a canned server-side slash registry.
test('streaming /api/chat/runs does NOT special-case slash commands — "/help" is dispatched to the agent like any message', async () => {
  const runsPayloads = [];
  const finalizeCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    ...readyRunnerBindingHandlers(),
    readyStreamingCapabilitiesHandler(),
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Barry' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/(?:enqueue|claim)_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID, claimed: true, user_message_id: 'u-slash', assistant_message_id: 'a-slash', task_run_id: RUN_ID,
      }]))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: ({ init }) => {
      finalizeCalls.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('[]', { status: 200 }));
    } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/v1\/runs$/.test(url),
      respond: ({ init }) => { runsPayloads.push(JSON.parse(String(init.body))); return Promise.resolve(new Response(JSON.stringify({ run_id: 'hermes_run_abc', status: 'started' }), { status: 201 })); } },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs\?id=eq\./.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 200 })) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const resp = await worker.fetch(
      authedRequest('/api/chat/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '/help', conversationId: USER_ID }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(resp.status, 201);
    assert.equal(runsPayloads.length, 1, 'a slash command is dispatched to the agent like any message (no inline special-casing)');
    assert.ok(runsPayloads[0].input.includes('/help'), 'the "/help" text is sent through to the agent verbatim');
    assert.equal(finalizeCalls.length, 0, 'no canned server-side slash reply is finalized');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
