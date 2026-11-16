// v1.2.8 — Regression test for the gap Alex caught.
//
// Lesson learned: v1.2.7 shipped with the chat dispatch happily
// short-circuiting to runner_not_ready for every paying user because
// no hermes_instance had been provisioned. The tests asserted the
// dispatch CODE handled an unready runner gracefully — they did NOT
// assert that any paying user actually HAS a ready runner.
//
// This file is a contract test on the v1.2.7+ chat architecture:
//
//   GIVEN a user has an active subscription
//   THEN fetchChatRunnerBinding must return 'ready' for them.
//
// Mocked Supabase rows simulate the post-provisioner state. If a
// future refactor regresses readiness ordering, this catches it before
// production.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'jwt.user.token';
const SERVICE_ROLE = 'service_role_test';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_runner_secret_unused_in_v127',
  OPENROUTER_API_KEY: 'sk-or-test-fake',
};

function ctxStub() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(Promise.resolve(p).catch(() => {})); },
    async settle() { await Promise.all(promises); },
  };
}

function authedRequest(path, init = {}) {
  return new Request(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${USER_JWT}` },
  });
}

function makeFakeFetch(handlers) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    for (const handler of handlers) {
      if (handler.match({ url, method, init })) {
        return handler.respond({ url, method, init });
      }
    }
    return new Response(JSON.stringify({ error: 'unmatched', url, method }), { status: 500 });
  };
}

function matchUrl(method, regex) {
  return ({ url, method: m }) => m === method && regex.test(url);
}

test('REGRESSION GUARD v1.2.8: A paying user with a provisioned Fly runner reaches the runner — not the OpenRouter fallback', async () => {
  // Simulates the production state post-`npm run series4:provision-once`
  // and post-`npm run series4:readiness-once`: subscription active,
  // hermes_instances.status='ready', hermes_instance_private has the
  // Fly URL and per-user shared secret. The full chat path should
  // dispatch to the runner /tasks endpoint, NOT the OpenRouter
  // fallback. This was the silent gap behind Alex's v1.2.7 regression.
  const isoNow = new Date().toISOString();
  const openRouterCalls = [];
  const runnerCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/enqueue_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ monthly_token_quota: 1000000, tier_id: 'studio' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () =>
      Promise.resolve(new Response('[]')) },
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
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Harry' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response('[]')) },
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: () => {
      openRouterCalls.push(true);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }},
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: ({ init }) => {
        runnerCalls.push({ body: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(JSON.stringify({
          task_id: 't-1',
          status: 'completed',
          result: 'Hi Alex — Harry here, ready to help.',
          tool_calls: [],
        })));
    }},
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
        body: JSON.stringify({ content: 'Create a file called test.txt with content hello' }),
      }),
      ENV,
      ctx,
    );
    await ctx.settle();

    assert.equal(runnerCalls.length, 1, 'Runner /tasks must be called when binding is ready');
    assert.equal(openRouterCalls.length, 0, 'OpenRouter fallback must NOT fire when binding is ready');
    assert.equal(runnerCalls[0].body.agent_name, 'Harry');
    assert.match(runnerCalls[0].body.instruction, /test\.txt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REGRESSION GUARD Cycle 39: A freshly-paid user with a ready runner but no seeded quota row still reaches the workspace', async () => {
  // Stripe/provisioning can temporarily leave usage_quotas unseeded while the
  // subscription and runner are already ready. The core usage gate treats a
  // missing/zero quota as "unconfigured, do not lock out"; readiness must not
  // reclassify that same first-run state as hard_limited and route the user to
  // generic fallback instead of their private workspace.
  const isoNow = new Date().toISOString();
  const openRouterCalls = [];
  const runnerCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/enqueue_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([]))) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () =>
      Promise.resolve(new Response('[]')) },
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
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Harry' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response('[]')) },
    { match: matchUrl('POST', /openrouter\.ai\/api\/v1\/chat\/completions$/), respond: ({ init }) => {
      openRouterCalls.push({ body: JSON.parse(String(init.body)) });
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback should not answer this first-run workspace task' } }],
        usage: { total_tokens: 12 },
      }), { status: 200 }));
    }},
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: ({ init }) => {
        runnerCalls.push({ body: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(JSON.stringify({
          task_id: 't-1',
          status: 'completed',
          result: 'Created first-run.txt in your workspace.',
          tool_calls: [{ tool: 'write_file', summary: 'created first-run.txt' }],
        })));
    }},
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
        body: JSON.stringify({ content: 'Create first-run.txt in my workspace' }),
      }),
      ENV,
      ctx,
    );
    await ctx.settle();

    assert.equal(runnerCalls.length, 1, 'a ready paid workspace must still receive work while quota seeding catches up');
    assert.equal(openRouterCalls.length, 0, 'unseeded quota rows must not force the generic OpenRouter fallback');
    assert.match(runnerCalls[0].body.instruction, /first-run\.txt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REGRESSION GUARD 2026-06-05: a cold/suspended runner is woken + retried so the FIRST message reaches it (no runner_not_ready)', async () => {
  // Alex's brand-new-user test: the first two messages ("Yo", "Hi") failed with
  // runner_not_ready because the autostop-suspended Fly runner had stale health
  // and the single 8s /healthz probe timed out before the box finished booting;
  // the 3rd message worked once it had woken. The probe now wakes + retries, so
  // the FIRST message reaches the runner instead of failing closed.
  const isoNow = new Date().toISOString();
  const staleHealth = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min > 10 min max-age -> probe runs
  let healthzCalls = 0;
  const runnerCalls = [];
  const handlers = [
    { match: matchUrl('GET', /\/auth\/v1\/user$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify({ id: USER_ID }))) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/enqueue_chat_message$/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        conversation_id: USER_ID,
        user_message_id: '88888888-8888-4888-8888-888888888888',
        assistant_message_id: '99999999-9999-4999-8999-999999999999',
        task_run_id: RUN_ID,
      }]))) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/task_runs/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    { match: ({ method, url }) => method === 'PATCH' && /\/rest\/v1\/hermes_instances/.test(url),
      respond: () => Promise.resolve(new Response('[]')) },
    { match: matchUrl('GET', /\/rest\/v1\/subscriptions\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ status: 'active' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/usage_quotas/), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ monthly_token_quota: 1000000, tier_id: 'studio' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/token_usage_events/), respond: () =>
      Promise.resolve(new Response('[]')) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instances\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        status: 'ready',
        ready_at: isoNow,
        last_health_at: staleHealth,
        provider: 'fly_machines',
      }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/hermes_instance_private\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{
        runner_base_url: 'https://test-app.fly.dev',
        provider: 'fly_machines',
        fly_app_name: 'test-app',
        runner_shared_secret: 'per-user-secret',
      }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/profiles\?id=eq\./), respond: () =>
      Promise.resolve(new Response(JSON.stringify([{ id: USER_ID, agent_name: 'Harry' }]))) },
    { match: matchUrl('GET', /\/rest\/v1\/messages\?user_id=eq\./), respond: () =>
      Promise.resolve(new Response('[]')) },
    // The runner is cold: /healthz fails the first two probes (boot in progress),
    // then serves once the autostart finishes.
    { match: ({ method, url }) => method === 'GET' && /test-app\.fly\.dev\/healthz$/.test(url),
      respond: () => {
        healthzCalls += 1;
        if (healthzCalls < 3) return Promise.resolve(new Response('cold', { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, hermesApiServerAvailable: true }), { status: 200 }));
      } },
    { match: ({ method, url }) => method === 'POST' && /test-app\.fly\.dev\/tasks$/.test(url),
      respond: ({ init }) => {
        runnerCalls.push({ body: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(JSON.stringify({
          task_id: 't-1', status: 'completed', result: 'Awake and ready.', tool_calls: [],
        })));
      } },
    { match: ({ method, url }) => method === 'POST' && /\/rest\/v1\/token_usage_events/.test(url),
      respond: () => Promise.resolve(new Response('[]', { status: 201 })) },
    { match: matchUrl('POST', /\/rest\/v1\/rpc\/finalize_chat_message$/), respond: () =>
      Promise.resolve(new Response('true')) },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(handlers);
  try {
    const ctx = ctxStub();
    // Fast wake interval so the test doesn't sleep seconds between probes.
    await worker.fetch(
      authedRequest(`/api/chat/conversations/${USER_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Hi' }),
      }),
      { ...ENV, RUNNER_WAKE_PROBE_INTERVAL_MS: '5' },
      ctx,
    );
    await ctx.settle();

    assert.ok(healthzCalls >= 3, `cold runner must be re-probed until it wakes (got ${healthzCalls} probes)`);
    assert.equal(runnerCalls.length, 1, 'the first message must reach the runner once it has woken (no runner_not_ready fail)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
