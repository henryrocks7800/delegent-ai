// The agent engine path (src/agent-engine.ts): an allowlisted account's chat,
// files, voice allowance and account deletion reach the engine through the AGENT
// service binding, and every other account is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import worker, { fetchUsageSnapshot } from '../dist/index.js';
import { AGENT_TRIAL_TALK_SECONDS, agentBillableTokens } from '../dist/topups.js';
import { AGENT_PLAN, AGENT_TOP_UP } from '@sidekick/shared';
import {
  AGENT_TALK_SECONDS_PER_CYCLE,
  agentEngineUserIds,
  capAgentTalkAllowance,
  usesAgentEngine,
  verifyAgentFileLinkToken,
} from '../dist/agent-engine.js';
// The engine's own implementation, so the two sides of the link format cannot drift.
import { fileLinkToken } from '../../agent/src/internal.ts';

const BASE = 'https://api.delegantai.test';
const AGENT_USER = '11111111-2222-4333-8444-555555555555';
const RUNNER_USER = '66666666-7777-4888-9999-000000000000';
const SECRET = 'agent-engine-secret-for-tests';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ASSISTANT_ID = '99999999-9999-4999-8999-999999999999';
const USER_MESSAGE_ID = '88888888-8888-4888-8888-888888888888';
const FILE_ID = `file_${'ab'.repeat(16)}`;

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** A fake AGENT service binding that records signed requests. */
function agentBinding(handler) {
  const calls = [];
  return {
    calls,
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const headers = new Headers(init.headers);
      const call = { path: url.pathname, method: (init.method ?? 'GET').toUpperCase(), headers, body: init.body ? String(init.body) : '' };
      calls.push(call);
      return handler(call);
    },
  };
}

function envFor(binding, overrides = {}) {
  return {
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true',
    SUPABASE_URL: 'https://unit.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner-secret-for-tests',
    OPENROUTER_API_KEY: 'sk-or-test-fake',
    OPENAI_API_KEY: 'sk-openai-test-fake',
    AGENT: binding,
    SIDEKICK_AGENT_ENGINE_USER_IDS: `${AGENT_USER}, not-a-uuid`,
    SIDEKICK_AGENT_SHARED_SECRET: SECRET,
    ...overrides,
  };
}

function ctxStub() {
  const pending = [];
  return { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); }, async settle() { await Promise.all(pending); } };
}

/** Supabase and OpenAI, faked; records writes. */
function fakeServices(state) {
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString();
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? String(init.body) : '';
    state.calls.push({ url, method, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/v1/user')) return json({ id: state.userId });
    if (url.includes('/rest/v1/subscriptions')) return json([{ status: state.subscriptionStatus ?? 'active', current_period_end: future, billing_provider: 'stripe', stripe_customer_id: 'cus_agent_1' }]);
    if (url.endsWith('/rest/v1/rpc/settle_usage_top_ups')) {
      state.settles.push(JSON.parse(body));
      return json([{ balance: state.topUpBalance ?? 0, drawn_this_cycle: 0, used_this_cycle: state.usedThisCycle ?? 0 }]);
    }
    if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
      state.stripe.push(body);
      return json({ id: 'cs_test_top_up', url: 'https://checkout.stripe.com/c/pay/cs_test_top_up' });
    }
    if (url.includes('/rest/v1/billing_events') && method === 'POST') {
      const row = JSON.parse(body);
      return json({ id: 'ledger_1', ...row });
    }
    if (url.includes('/rest/v1/billing_events') && method === 'PATCH') { state.ledger.push(JSON.parse(body)); return new Response(null, { status: 204 }); }
    if (url.includes('/rest/v1/usage_top_ups') && method === 'POST') { state.topUps.push(JSON.parse(body)); return new Response(null, { status: 201 }); }
    if (url.includes('api.github.com') || url.includes('api.resend.com') || url.includes('graph.facebook.com')) { state.sideEffects.push(url); return json({}); }
    if (url.includes('/rest/v1/usage_quotas')) {
      return json([{ monthly_token_quota: 19_550_000, tier_id: 'studio', voice_seconds_quota: 3600, consumed_voice_seconds: state.consumedVoiceSeconds ?? 0, billing_cycle_anchor: monthStartIso() }]);
    }
    if (url.includes('/rest/v1/token_usage_events') && method === 'GET') return json(state.usageRows ?? []);
    if (url.includes('/rest/v1/token_usage_events') && method === 'POST') { state.usage.push(JSON.parse(body)); return new Response(null, { status: 201 }); }
    if (url.includes('/rest/v1/profiles')) return json([{ id: state.userId, agent_name: 'Barry' }]);
    if (url.endsWith('/rest/v1/rpc/claim_chat_message')) {
      state.claims += 1;
      return json([{ conversation_id: state.userId, user_message_id: USER_MESSAGE_ID, assistant_message_id: ASSISTANT_ID, task_run_id: RUN_ID, claimed: true }]);
    }
    if (url.includes('/rest/v1/task_runs') && method === 'PATCH') { state.taskRunPatches.push(JSON.parse(body)); return json([]); }
    if (url.includes('/rest/v1/task_runs') && method === 'GET') return json([{ id: RUN_ID, runner_task_id: state.runnerTaskId ?? `agent:${RUN_ID}`, status: 'dispatched', kind: 'chat', created_at: new Date().toISOString() }]);
    if (url.includes('/rest/v1/messages') && method === 'GET') return json([{ id: ASSISTANT_ID }]);
    if (url.endsWith('/rest/v1/rpc/finalize_chat_message')) { state.finalized.push(JSON.parse(body)); return json(state.finalized.length === 1); }
    if (url.endsWith('/rest/v1/rpc/increment_voice_usage')) { state.voiceIncrements.push(JSON.parse(body)); return json(true); }
    if (url.includes('api.openai.com/v1/realtime/client_secrets')) return json({ value: 'ek_test_secret', expires_at: 1_900_000_000 });
    if (url.includes('api.openai.com/v1/audio/transcriptions')) return state.transcribeReply ? json(state.transcribeReply.body, state.transcribeReply.status) : json({ text: 'hello there' });
    if (url.includes('fly.dev')) { state.runnerCalls.push(url); return json({ error: 'runner should not be called' }, 500); }
    if (method === 'GET') return json([]);
    return json({});
  };
}

function newState(userId = AGENT_USER) {
  return { userId, calls: [], usage: [], claims: 0, taskRunPatches: [], finalized: [], voiceIncrements: [], runnerCalls: [], settles: [], stripe: [], ledger: [], topUps: [], sideEffects: [] };
}

async function withServices(state, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeServices(state);
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function authed(path, init = {}) {
  return new Request(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: 'Bearer user.jwt.token' } });
}

function sse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + ': keep-alive\n\ndata: [DONE]\n\n';
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('the allowlist is dark by default and needs both the binding and the secret', async () => {
  const binding = agentBinding(() => new Response('{}'));
  assert.deepEqual([...agentEngineUserIds({ SIDEKICK_AGENT_ENGINE_USER_IDS: ` ${AGENT_USER.toUpperCase()} ,junk,` })], [AGENT_USER]);
  assert.deepEqual([...agentEngineUserIds({ SIDEKICK_AGENT_ENGINE_USER_IDS: `${AGENT_USER},*,-${RUNNER_USER}` })], [AGENT_USER], 'the switch tokens are not ids');
  assert.equal(await usesAgentEngine(envFor(binding), AGENT_USER), true);
  assert.equal(await usesAgentEngine(envFor(binding), RUNNER_USER), false);
  assert.equal(await usesAgentEngine(envFor(binding, { SIDEKICK_AGENT_ENGINE_USER_IDS: undefined }), AGENT_USER), false, 'no list, nobody');
  assert.equal(await usesAgentEngine(envFor(undefined), AGENT_USER), false, 'no binding, nobody');
  assert.equal(await usesAgentEngine(envFor(binding, { SIDEKICK_AGENT_SHARED_SECRET: ' ' }), AGENT_USER), false, 'no secret, nobody');
});

test('for everyone: every account is on the assistant except the exclusions, with no billing lookup', async () => {
  // The assistant release (Alex, 2026-09-15), completed 2026-09-18: every
  // account moves, App Store customers included, because the runners are gone
  // and Fly is closed. Nothing is looked up to decide it.
  const binding = agentBinding(() => new Response('{}'));
  const APPLE_USER = '12121212-3434-4565-8787-909090909090';
  const EXCLUDED = '23232323-4545-4676-8989-010101010101';
  const lookups = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    lookups.push(typeof input === 'string' ? input : input.url);
    return new Response('[]', { status: 200 });
  };
  try {
    // One variable carries it all: the test ids, "*" for everyone, "-<id>" held back.
    const everyone = envFor(binding, { SIDEKICK_AGENT_ENGINE_USER_IDS: `${AGENT_USER}, *, -${EXCLUDED}` });
    assert.equal(await usesAgentEngine(everyone, RUNNER_USER), true, 'a Stripe customer moves');
    assert.equal(await usesAgentEngine(everyone, APPLE_USER), true, 'an App Store customer moves too (2026-09-18, no runner left to hold them on)');
    assert.equal(await usesAgentEngine(everyone, '45454545-6767-4898-9a9a-bcbcbcbcbcbc'), true, 'a new account with no plan starts on the assistant');
    assert.equal(await usesAgentEngine(everyone, EXCLUDED), false, 'an excluded account is still held back');
    assert.equal(await usesAgentEngine(everyone, AGENT_USER), true, 'the allowlist still wins');
    assert.equal(lookups.length, 0, 'the decision is made from the variable alone');
    // Off, nothing changes for anyone but the allowlist.
    assert.equal(await usesAgentEngine(envFor(binding), RUNNER_USER), false);
    assert.equal(lookups.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('an agent account\'s message is claimed as usual and handed to the engine, signed for that user', async () => {
  const state = newState();
  const binding = agentBinding((call) => (call.path === '/runs' ? new Response(JSON.stringify({ ok: true, runId: RUN_ID, status: 'started' }), { status: 201 }) : new Response('{}', { status: 404 })));
  await withServices(state, async () => {
    const ctx = ctxStub();
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Find me a hotel in Bath for Friday', clientRunId: 'client-1', attachments: [{ id: FILE_ID, name: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 1200 }] }),
    }), envFor(binding), ctx);
    await ctx.settle();
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    assert.equal(body.runId, RUN_ID);
    assert.equal(body.eventsUrl, `/api/chat/runs/${RUN_ID}/events`);
    assert.equal(state.claims, 1, 'the display record is written through the same claim');
    const dispatch = binding.calls.find((c) => c.path === '/runs');
    assert.ok(dispatch, 'dispatched to the engine');
    const sent = JSON.parse(dispatch.body);
    assert.equal(sent.runId, RUN_ID, 'the engine run id is the task run id');
    assert.equal(sent.message, 'Find me a hotel in Bath for Friday');
    assert.equal(sent.agentName, 'Barry');
    assert.deepEqual(sent.attachments, [{ id: FILE_ID, name: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 1200 }]);
    const timestamp = dispatch.headers.get('x-sidekick-runner-timestamp');
    assert.equal(dispatch.headers.get('x-sidekick-user-id'), AGENT_USER);
    assert.equal(dispatch.headers.get('x-sidekick-runner-token'), `v1.${createHmac('sha256', SECRET).update(`v1:${AGENT_USER}:${timestamp}`).digest('hex')}`);
    assert.deepEqual(state.taskRunPatches.at(-1), { runner_task_id: `agent:${RUN_ID}`, status: 'dispatched' });
    assert.equal(state.runnerCalls.length, 0, 'no runner is contacted');
  });
});

test('an engine that cannot take the run fails the turn fast, with the retryable message', async () => {
  const state = newState();
  const binding = agentBinding(() => new Response('{"error":"boom"}', { status: 500 }));
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
    }), envFor(binding), ctxStub());
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, 'failed');
    assert.equal(state.finalized.length, 1);
    assert.equal(state.finalized[0].p_succeeded, false);
    assert.equal(state.finalized[0].p_error_code, 'runner_unreachable');
    assert.ok(!state.taskRunPatches.some((p) => String(p.runner_task_id ?? '').startsWith('agent:')), 'no engine run id is stored for a run the engine never took');
  });
});

test('a message longer than the engine reads is refused up front, with the too-long answer, and nothing is written', async () => {
  // QA F15, 2026-09-23: a 56,000-character paste was claimed, refused by the
  // engine and shown as "couldn't reach your coworker".
  const state = newState();
  const binding = agentBinding(() => { throw new Error('the engine must not be called for an over-long message'); });
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(32_001) }),
    }), envFor(binding), ctxStub());
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'content_too_long');
    assert.equal(state.claims, 0, 'no message row is written');
    assert.equal(state.finalized.length, 0);
    assert.equal(binding.calls.length, 0);
  });
  const fits = newState();
  const accepts = agentBinding((call) => (call.path === '/runs' ? new Response(JSON.stringify({ ok: true, runId: RUN_ID, status: 'started' }), { status: 201 }) : new Response('{}', { status: 404 })));
  await withServices(fits, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(32_000) }),
    }), envFor(accepts), ctxStub());
    assert.equal(response.status, 201, 'exactly the limit still goes through');
    assert.equal(fits.claims, 1);
  });
});

test('a runner account never reaches the engine', async () => {
  const state = newState(RUNNER_USER);
  const binding = agentBinding(() => { throw new Error('the engine must not be called for a runner account'); });
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
    }), envFor(binding), ctxStub());
    assert.notEqual(response.status, 201, 'with no runner binding in this fake, the runner path refuses');
    assert.equal(binding.calls.length, 0);
  });
});

test('an app that hangs up on the terminal event still has the reply finalized and billed, through waitUntil', async () => {
  // 2026-09-22, live: a client stopped reading at run.completed, workerd
  // cancelled the request between marking the run done and writing its usage,
  // and the sweeper skips runs already done, so the reply went unbilled.
  const state = newState();
  const usage = { steps: 1, inputTokens: 12_000, outputTokens: 12, cachedTokens: 0, costUsd: 0.0012, toolCalls: 0 };
  const binding = agentBinding(() => sse([
    { type: 'run.started', runId: RUN_ID, sequence: 1, timestamp: 't1' },
    { type: 'assistant.text.delta', runId: RUN_ID, sequence: 2, timestamp: 't2', payload: { delta: '17 x 23 = 391.' } },
    { type: 'run.completed', runId: RUN_ID, sequence: 3, timestamp: 't3', payload: { finalText: '17 x 23 = 391.', usage } },
  ]));
  await withServices(state, async () => {
    const pending = [];
    const ctx = { waitUntil(p) { pending.push(Promise.resolve(p)); } };
    const response = await worker.fetch(authed(`/api/chat/runs/${RUN_ID}/events`), envFor(binding), ctx);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('run.completed')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel('the app hung up on the terminal event');
    assert.ok(pending.length >= 1, 'the finalization was handed to waitUntil, so a hang-up cannot cut it off');
    await Promise.all(pending);
    assert.equal(state.finalized.length, 1);
    assert.equal(state.usage.length, 1, 'usage recorded once despite the hang-up');
    assert.equal(state.usage[0].prompt_tokens, 12_000);
  });
});

test('the engine\'s events reach the app with the app run id, and the reply is finalized with its usage', async () => {
  const state = newState();
  const usage = { steps: 2, inputTokens: 10_000, outputTokens: 200, cachedTokens: 8_000, costUsd: 0.0009, toolCalls: 1 };
  const binding = agentBinding((call) => {
    assert.equal(call.path, `/runs/${RUN_ID}/events`);
    return sse([
      { type: 'run.started', runId: RUN_ID, sequence: 1, timestamp: 't1' },
      { type: 'assistant.text.delta', runId: RUN_ID, sequence: 2, timestamp: 't2', payload: { delta: 'Checking ' } },
      { type: 'tool.started', runId: RUN_ID, sequence: 3, timestamp: 't3', payload: { toolCallId: 'c1', tool: 'hotels', summary: 'Bath' } },
      { type: 'tool.completed', runId: RUN_ID, sequence: 4, timestamp: 't4', payload: { toolCallId: 'c1', tool: 'hotels', summary: 'Done', output: null } },
      { type: 'assistant.text.delta', runId: RUN_ID, sequence: 5, timestamp: 't5', payload: { delta: 'hotels.' } },
      { type: 'run.completed', runId: RUN_ID, sequence: 6, timestamp: 't6', payload: { finalText: 'Checking hotels.', usage } },
    ]);
  });
  await withServices(state, async () => {
    const response = await worker.fetch(authed(`/api/chat/runs/${RUN_ID}/events`), envFor(binding), ctxStub());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    const events = text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(events.map((e) => e.type), ['run.started', 'assistant.text.delta', 'tool.started', 'tool.completed', 'assistant.text.delta', 'run.completed']);
    assert.ok(events.every((e) => e.runId === RUN_ID));
    assert.match(text, /event: run\.completed\ndata: /, 'same SSE framing as the runner relays');
    assert.equal(state.finalized.length, 1);
    assert.equal(state.finalized[0].p_content, 'Checking hotels.');
    assert.equal(state.finalized[0].p_succeeded, true);
    assert.deepEqual(state.finalized[0].p_tool_calls, [{ tool: 'hotels', summary: 'Bath' }]);
    assert.equal(state.usage.length, 1, 'usage recorded once, on the transition');
    assert.equal(state.usage[0].source, 'agent');
    assert.equal(state.usage[0].prompt_tokens, 10_000);
    assert.equal(state.usage[0].completion_tokens, 200);
    assert.equal(state.usage[0].cached_tokens, 8_000);
    assert.equal(state.usage[0].provider_cost_usd, 0.0009);
    // Metered at what the reply cost ($0.0009 at $0.20 a million) plus its one app action.
    assert.equal(state.usage[0].total_tokens, 4_500 + 1_500);
    assert.equal(state.settles.length, 1, 'anything past the allowance is charged to top-ups straight away');
    assert.equal(state.settles[0].p_allowance, AGENT_PLAN.monthlyAllowanceTokens);
  });
});

test('the relay logs how long the first words took from the engine to the Worker, once per reply (QA 2026-09-23)', async () => {
  const state = newState();
  const written = new Date(Date.now() - 250).toISOString();
  const binding = agentBinding(() => sse([
    { type: 'run.started', runId: RUN_ID, sequence: 1, timestamp: written },
    { type: 'assistant.text.delta', runId: RUN_ID, sequence: 2, timestamp: written, payload: { delta: 'Hello ' } },
    { type: 'assistant.text.delta', runId: RUN_ID, sequence: 3, timestamp: written, payload: { delta: 'there.' } },
    { type: 'run.completed', runId: RUN_ID, sequence: 4, timestamp: written, payload: { finalText: 'Hello there.' } },
  ]));
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await withServices(state, async () => {
      const response = await worker.fetch(authed(`/api/chat/runs/${RUN_ID}/events`), envFor(binding), ctxStub());
      await response.text();
    });
  } finally {
    console.log = original;
  }
  const relay = lines.filter((l) => l.includes('"agent_relay":"first_text"')).map((l) => JSON.parse(l));
  assert.equal(relay.length, 1, 'one line per reply, for the first words only');
  assert.equal(relay[0].run, RUN_ID);
  assert.ok(relay[0].relay_ms >= 250 && relay[0].relay_ms < 10_000, `relay_ms ${relay[0].relay_ms}`);
  assert.equal(relay[0].written_before_stream_opened, true);
  assert.equal(typeof relay[0].stream_open_to_first_text_ms, 'number');
  assert.ok(!JSON.stringify(relay[0]).includes('Hello'), 'no reply text in the log');
});

test('reconcile reads the engine\'s run record: finished, still working, or gone', async () => {
  for (const [record, status, expectFinalized] of [
    [{ status: 'succeeded', finalText: 'All done.', toolCalls: [{ tool: 'email', summary: '' }], usage: { inputTokens: 100, outputTokens: 10 } }, 200, true],
    [{ status: 'working', finalText: 'Chec' }, 200, false],
    [{ error: 'run_not_found' }, 404, false],
  ]) {
    const state = newState();
    const binding = agentBinding((call) => { assert.equal(call.path, `/runs/${RUN_ID}`); return new Response(JSON.stringify(record), { status }); });
    await withServices(state, async () => {
      const response = await worker.fetch(authed(`/api/chat/runs/${RUN_ID}`), envFor(binding), ctxStub());
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(state.finalized.length, expectFinalized ? 1 : 0, JSON.stringify(record));
      if (expectFinalized) {
        assert.equal(state.finalized[0].p_content, 'All done.');
        assert.equal(state.usage.length, 1);
      }
      assert.equal(state.runnerCalls.length, 0);
    });
  }
});

test('stopping keeps what was already written and marks the reply stopped', async () => {
  const state = newState();
  const binding = agentBinding((call) => {
    if (call.path === `/runs/${RUN_ID}/stop`) return new Response(JSON.stringify({ ok: true, runId: RUN_ID, status: 'cancelled' }));
    if (call.path === `/runs/${RUN_ID}`) return new Response(JSON.stringify({ status: 'working', finalText: 'Here are three hotels' }));
    return new Response('{}', { status: 404 });
  });
  await withServices(state, async () => {
    const response = await worker.fetch(authed(`/api/chat/runs/${RUN_ID}/stop`, { method: 'POST' }), envFor(binding), ctxStub());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'stopping');
    assert.equal(state.finalized.length, 1);
    assert.equal(state.finalized[0].p_error_code, 'cancelled');
    assert.equal(state.finalized[0].p_content, 'Here are three hotels\n\n(Stopped.)');
  });
});

test('"Start a fresh chat" resets the engine conversation', async () => {
  const state = newState();
  const binding = agentBinding((call) => (call.path === '/control/reset' ? new Response(JSON.stringify({ ok: true, archived: 3 })) : new Response('{}', { status: 404 })));
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '/new', confirmed: true }),
    }), envFor(binding), ctxStub());
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, command: 'reset' });
    assert.equal(state.claims, 0, 'a reset is not a chat turn');
  });
});

test('chat attachments go to the engine, which serves the runner /files contract', async () => {
  const state = newState();
  const binding = agentBinding((call) => {
    if (call.path === '/files' && call.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, file: { id: FILE_ID, name: 'receipt.jpg', relativeName: 'receipt.jpg', mimeType: 'image/jpeg', sizeBytes: 3, modifiedAt: 1_789_000_000, downloadable: true } }));
    }
    return new Response('{}', { status: 404 });
  });
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/files/runner', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'receipt.jpg', mimeType: 'image/jpeg', contentBase64: 'AAEC' }),
    }), envFor(binding, { SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file-link-secret' }), ctxStub());
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.file.id, FILE_ID);
    assert.match(body.file.downloadUrl, new RegExp(`/api/files/runner/${FILE_ID}\\?token=v1\\.`));
    const upload = binding.calls.find((c) => c.path === '/files');
    assert.equal(upload.headers.get('x-sidekick-user-id'), AGENT_USER);
    assert.equal(state.runnerCalls.length, 0);
  });
});

test('a file link the coworker shared opens without a session, and only with a valid token', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await fileLinkToken(SECRET, AGENT_USER, FILE_ID, nowSeconds + 3600);
  assert.deepEqual(await verifyAgentFileLinkToken(token, FILE_ID, SECRET, nowSeconds), { userId: AGENT_USER }, 'engine and Worker agree on the format');
  const binding = agentBinding((call) => {
    assert.equal(call.headers.get('x-sidekick-user-id'), AGENT_USER);
    return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="invoice-001.pdf"', 'content-length': '4' } });
  });
  const ok = await worker.fetch(new Request(`${BASE}/api/files/agent/${FILE_ID}?token=${encodeURIComponent(token)}`), envFor(binding), ctxStub());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal(ok.headers.get('content-disposition'), 'inline; filename="invoice-001.pdf"');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const forged = await worker.fetch(new Request(`${BASE}/api/files/agent/${FILE_ID}?token=${encodeURIComponent(token.slice(0, -2) + '00')}`), envFor(binding), ctxStub());
  assert.equal(forged.status, 404);
  const htmlBinding = agentBinding(() => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html', 'content-disposition': 'inline; filename="x.html"' } }));
  const html = await worker.fetch(new Request(`${BASE}/api/files/agent/${FILE_ID}?token=${encodeURIComponent(token)}`), envFor(htmlBinding), ctxStub());
  assert.equal(html.headers.get('content-type'), 'application/octet-stream', 'never served as a page from the API domain');
  assert.match(html.headers.get('content-disposition') ?? '', /^attachment;/);
});

test('Talk is capped at 15 minutes a cycle for an agent account, and a session ends with the allowance', async () => {
  assert.equal(AGENT_TALK_SECONDS_PER_CYCLE, 900);
  assert.deepEqual(
    capAgentTalkAllowance({ voiceSecondsQuota: 3600, consumedVoiceSeconds: 423, remainingVoiceSeconds: 3177, hardLimited: false }),
    { voiceSecondsQuota: 900, consumedVoiceSeconds: 423, remainingVoiceSeconds: 477, hardLimited: false },
  );
  const binding = agentBinding(() => new Response('{}'));
  for (const [consumed, expectStatus, expectMax] of [[423, 200, 477], [100, 200, 600], [880, 402, null]]) {
    const state = { ...newState(), consumedVoiceSeconds: consumed };
    await withServices(state, async () => {
      const response = await worker.fetch(authed('/api/voice/session', { method: 'POST' }), envFor(binding), ctxStub());
      assert.equal(response.status, expectStatus, `${consumed}s used: ${await response.clone().text()}`);
      if (expectMax !== null) assert.equal((await response.json()).maxSeconds, expectMax);
      else assert.equal((await response.json()).error, 'quota_exhausted');
    });
  }
  // A runner account keeps its plan allowance and the 10-minute session.
  const state = { ...newState(RUNNER_USER), consumedVoiceSeconds: 880 };
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/voice/session', { method: 'POST' }), envFor(binding), ctxStub());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).maxSeconds, 600);
  });
});

test('dictation is not counted against an agent account\'s Talk allowance', async () => {
  const binding = agentBinding(() => new Response('{}'));
  for (const [userId, expectCounted] of [[AGENT_USER, false], [RUNNER_USER, true]]) {
    const state = { ...newState(userId), consumedVoiceSeconds: 890 };
    await withServices(state, async () => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/m4a' }), 'voice.m4a');
      form.append('duration_seconds', '5');
      const response = await worker.fetch(authed('/api/audio/transcribe', { method: 'POST', body: form }), envFor(binding), ctxStub());
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(state.voiceIncrements.length > 0, expectCounted, userId);
    });
  }
});

test('a recording the provider cannot read is a 422 to say again, while a provider outage stays a 503', async () => {
  // QA F17, 2026-09-23: unreadable audio came back as a 503, so the app said
  // "try again in a moment" and monitoring saw a service failure.
  const binding = agentBinding(() => new Response('{}'));
  const cases = [
    [{ status: 400, body: { error: { message: 'Audio file might be corrupted or unsupported', param: 'file', code: 'invalid_value' } } }, 422, 'transcribe_unreadable'],
    [{ status: 400, body: { error: { message: 'Invalid model', param: 'model' } } }, 503, 'transcribe_upstream_error'],
    [{ status: 500, body: { error: { message: 'The server had an error processing your file' } } }, 503, 'transcribe_upstream_error'],
  ];
  for (const [reply, status, error] of cases) {
    const state = { ...newState(AGENT_USER), transcribeReply: reply };
    await withServices(state, async () => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/m4a' }), 'voice.m4a');
      form.append('duration_seconds', '5');
      const response = await worker.fetch(authed('/api/audio/transcribe', { method: 'POST', body: form }), envFor(binding), ctxStub());
      assert.equal(response.status, status, JSON.stringify(reply));
      assert.equal((await response.json()).error, error);
    });
  }
});

test('an engine account\'s export carries what the coworker remembers, and says so when it cannot (QA F39, 2026-09-23)', async () => {
  const exportFor = async (binding) => {
    const state = newState();
    return withServices(state, async () => {
      const response = await worker.fetch(authed('/api/account/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), envFor(binding), ctxStub());
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).artifact.bundle;
    });
  };
  const remembering = agentBinding((call) => (call.path === '/ops/diagnostics'
    ? new Response(JSON.stringify({ agentName: 'Barry', memory: 'Runs Brew Bros cafe in Leeds. Prefers short replies.', liveMessages: 4 }), { status: 200 })
    : new Response('{}', { status: 404 })));
  const bundle = await exportFor(remembering);
  assert.deepEqual(bundle.coworker, { memory: 'Runs Brew Bros cafe in Leeds. Prefers short replies.' }, 'the memory, and only the memory');
  assert.doesNotMatch(JSON.stringify(bundle.coverage.omitted), /coworker's own memory|remembers about you/, 'no longer listed as missing');
  assert.equal(remembering.calls.filter((c) => c.path === '/ops/diagnostics').length, 1);
  assert.equal(remembering.calls[0].headers.get('x-sidekick-user-id'), AGENT_USER, 'asked for this account, signed');

  const down = agentBinding(() => new Response('{"error":"boom"}', { status: 500 }));
  const without = await exportFor(down);
  assert.equal(without.coworker, undefined);
  assert.match(JSON.stringify(without.coverage.omitted), /What your coworker remembers about you.*could not be read just now/, 'a failure is said, not hidden');
  assert.equal(without.coverage.complete, true, 'and the rest of the export still arrives');
});

test('an admin can reset only their own coworker: engine wiped, chat cleared, nothing else touched (2026-09-23)', async () => {
  const binding = agentBinding((call) => (call.path === '/account' && call.method === 'DELETE'
    ? new Response(JSON.stringify({ ok: true }), { status: 200 })
    : new Response('{}', { status: 404 })));
  const state = newState();
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/admin/reset-own-coworker', { method: 'POST' }),
      envFor(binding, { SIDEKICK_ADMIN_USER_IDS: AGENT_USER }), ctxStub());
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, engineReset: true, chatCleared: true });
  });
  const wipe = binding.calls.find((c) => c.path === '/account');
  assert.equal(wipe?.method, 'DELETE');
  assert.equal(wipe.headers.get('x-sidekick-user-id'), AGENT_USER, 'the engine copy of the signed-in account, signed for it');
  const deletes = state.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1, 'one delete, of the chat display record');
  assert.match(deletes[0].url, new RegExp(`/rest/v1/messages\\?conversation_id=eq\\.${AGENT_USER}$`));

  // Not an admin: refused, and nothing is wiped or deleted.
  const outsider = newState();
  const untouched = agentBinding(() => { throw new Error('the engine must not be called for a non-admin'); });
  await withServices(outsider, async () => {
    const response = await worker.fetch(authed('/api/admin/reset-own-coworker', { method: 'POST' }),
      envFor(untouched, { SIDEKICK_ADMIN_USER_IDS: RUNNER_USER }), ctxStub());
    assert.equal(response.status, 403);
  });
  assert.equal(untouched.calls.length, 0);
  assert.equal(outsider.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('the app can ask which engine its account is on', async () => {
  const binding = agentBinding(() => new Response('{}'));
  for (const [userId, engine] of [[AGENT_USER, 'agent'], [RUNNER_USER, 'runner']]) {
    const state = newState(userId);
    await withServices(state, async () => {
      const response = await worker.fetch(authed('/api/account/engine'), envFor(binding), ctxStub());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { engine });
    });
  }
  const unauthenticated = await worker.fetch(new Request(`${BASE}/api/account/engine`), envFor(binding), ctxStub());
  assert.equal(unauthenticated.status, 401);
});

test('an assistant account checks out on the assistant plan, decided by the server, and nobody else does', async () => {
  const binding = agentBinding(() => new Response('{}'));
  const claimOf = (state) => {
    const call = state.calls.find((c) => c.url.endsWith('/rest/v1/rpc/claim_billing_purchase_intent'));
    return call ? JSON.parse(call.body) : null;
  };
  // Asking for another plan makes no difference: an assistant account buys its plan.
  const agent = newState();
  agent.subscriptionStatus = 'inactive';
  await withServices(agent, async () => {
    await worker.fetch(authed('/api/stripe/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro-office', successUrl: 'https://delegentai.co.uk/ok', cancelUrl: 'https://delegentai.co.uk/no' }),
    }), envFor(binding, { STRIPE_SECRET_KEY: 'sk_test_unit', SUPABASE_ANON_KEY: 'anon_test', SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://delegentai.co.uk' }), ctxStub());
  });
  const agentClaim = claimOf(agent);
  assert.ok(agentClaim, 'the purchase was claimed');
  assert.equal(agentClaim.p_tier_id, AGENT_PLAN.tierId);
  assert.equal(agentClaim.p_request.plan, 'assistant');
  // A workspace account's request is what it always was.
  const runner = newState(RUNNER_USER);
  runner.subscriptionStatus = 'inactive';
  await withServices(runner, async () => {
    await worker.fetch(authed('/api/stripe/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro-office', successUrl: 'https://delegentai.co.uk/ok', cancelUrl: 'https://delegentai.co.uk/no' }),
    }), envFor(binding, { STRIPE_SECRET_KEY: 'sk_test_unit', SUPABASE_ANON_KEY: 'anon_test', SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://delegentai.co.uk' }), ctxStub());
  });
  const runnerClaim = claimOf(runner);
  assert.ok(runnerClaim, 'the purchase was claimed');
  assert.equal(runnerClaim.p_tier_id, 'pro-office');
  assert.equal(runnerClaim.p_request.plan, undefined);
});

test('an agent reply is metered at what it cost, whatever its mix, plus each app action', () => {
  assert.equal(agentBillableTokens({ costUsd: 0.0024, toolCalls: 2 }), 12_000 + 3_000);
  assert.equal(agentBillableTokens({ inputTokens: 10_000, cachedTokens: 8_000, outputTokens: 200, toolCalls: 0 }), 2_000 + 800 + 1_200,
    'no reported cost: the model\'s own price ratios');
  assert.equal(agentBillableTokens({ costUsd: -1, toolCalls: 'x' }), 0);
});

test('an agent account\'s allowance is its plan\'s, smaller in the free month, and top-ups extend it', async () => {
  const binding = agentBinding(() => new Response('{}'));
  const paid = { ...newState(), usedThisCycle: 17_000_000, topUpBalance: 2_000_000 };
  await withServices(paid, async () => {
    const snapshot = await fetchUsageSnapshot(AGENT_USER, envFor(binding));
    assert.equal(snapshot.monthlyTokenQuota, AGENT_PLAN.monthlyAllowanceTokens);
    assert.equal(snapshot.usedTokens, 17_000_000);
    assert.equal(snapshot.remainingTokens, 2_000_000, 'past the allowance, living on top-up credit');
    assert.equal(snapshot.hardLimited, false);
    assert.equal(snapshot.topUpBalanceTokens, 2_000_000);
    assert.equal(snapshot.storageHardLimited, false);
  });
  const spent = { ...newState(), usedThisCycle: AGENT_PLAN.monthlyAllowanceTokens, topUpBalance: 0 };
  await withServices(spent, async () => {
    assert.equal((await fetchUsageSnapshot(AGENT_USER, envFor(binding))).hardLimited, true);
  });
  const trial = { ...newState(), subscriptionStatus: 'trialing', usedThisCycle: 1_000_000 };
  await withServices(trial, async () => {
    const snapshot = await fetchUsageSnapshot(AGENT_USER, envFor(binding));
    assert.equal(snapshot.monthlyTokenQuota, AGENT_PLAN.trialAllowanceTokens);
    assert.equal(snapshot.trialing, true);
    assert.equal(snapshot.remainingTokens, AGENT_PLAN.trialAllowanceTokens - 1_000_000);
  });
  const runner = { ...newState(RUNNER_USER), usedThisCycle: 1 };
  await withServices(runner, async () => {
    const snapshot = await fetchUsageSnapshot(RUNNER_USER, envFor(binding));
    assert.equal(snapshot.monthlyTokenQuota, 19_550_000, 'a workspace account keeps its tier quota');
    assert.equal(runner.settles.length, 0);
  });
});

test('a used-up agent account is offered a top-up, not an upgrade', async () => {
  const state = { ...newState(), usedThisCycle: AGENT_PLAN.monthlyAllowanceTokens + 10, topUpBalance: 0 };
  const binding = agentBinding(() => new Response('{}', { status: 500 }));
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/chat/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Plan my weekend', clientRunId: 'client-cap' }),
    }), envFor(binding), ctxStub());
    assert.equal(response.status, 402);
    const body = await response.json();
    assert.equal(body.error, 'quota_exhausted');
    assert.match(body.pause.primary, /used this month's allowance/);
    assert.match(body.pause.secondary, /Top up from £1\.00/);
    assert.equal(body.pause.actions[0].label, 'Top up');
    assert.equal(binding.calls.length, 0, 'the engine is not asked');
  });
});

test('top-ups: agent accounts only, whole packs, cards only, and metadata no sign-up code reads', async () => {
  const binding = agentBinding(() => new Response('{}'));
  const env = envFor(binding, { STRIPE_SECRET_KEY: 'sk_test_unit' });
  const runner = newState(RUNNER_USER);
  await withServices(runner, async () => {
    const response = await worker.fetch(authed('/api/billing/top-up', { method: 'POST', body: JSON.stringify({ packs: 1 }) }), env, ctxStub());
    assert.equal(response.status, 404);
  });
  const state = newState();
  await withServices(state, async () => {
    const bad = await worker.fetch(authed('/api/billing/top-up', { method: 'POST', body: JSON.stringify({ packs: 0 }) }), env, ctxStub());
    assert.equal(bad.status, 400);
    const response = await worker.fetch(authed('/api/billing/top-up', { method: 'POST', body: JSON.stringify({ packs: 3 }) }), env, ctxStub());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_top_up' });
    const form = new URLSearchParams(state.stripe[0]);
    assert.equal(form.get('mode'), 'payment');
    assert.equal(form.get('customer'), 'cus_agent_1');
    assert.equal(form.getAll('payment_method_types[]').join(), 'card');
    assert.equal(form.get('line_items[0][price_data][currency]'), 'gbp');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), String(AGENT_TOP_UP.pricePence));
    assert.equal(form.get('line_items[0][quantity]'), '3');
    assert.equal(form.get('line_items[0][adjustable_quantity][maximum]'), String(AGENT_TOP_UP.maxPacksPerPurchase));
    assert.equal(form.get('metadata[kind]'), 'usage_top_up');
    assert.equal(form.get('metadata[topUpUserId]'), AGENT_USER);
    assert.equal(form.get('metadata[tokensPerPack]'), String(AGENT_TOP_UP.tokens));
    assert.equal(form.get('client_reference_id'), null);
    assert.equal(form.get('metadata[sidekickUserId]'), null);
    assert.match(form.get('custom_text[submit][message]'), /give up the 14-day right to cancel/);
    assert.equal(form.get('success_url'), `${BASE}/account/billing?top_up=1`);
  });
});

test('the app can read its allowance, top-up credit and Talk left', async () => {
  const binding = agentBinding(() => new Response('{}'));
  const state = { ...newState(), usedThisCycle: 4_000_000, topUpBalance: 6_000_000, consumedVoiceSeconds: 120 };
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/account/allowance'), envFor(binding), ctxStub());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.engine, 'agent');
    assert.equal(body.allowanceTokens, AGENT_PLAN.monthlyAllowanceTokens);
    assert.equal(body.allowanceUsedRatio, 4_000_000 / AGENT_PLAN.monthlyAllowanceTokens);
    assert.equal(body.topUpBalanceTokens, 6_000_000);
    assert.equal(body.hardLimited, false);
    assert.deepEqual(body.talk, { quotaSeconds: AGENT_TALK_SECONDS_PER_CYCLE, usedSeconds: 120 });
    assert.equal(body.topUp.pricePence, AGENT_TOP_UP.pricePence);
    assert.ok(body.nextResetAt);
  });
  const runner = newState(RUNNER_USER);
  await withServices(runner, async () => {
    const response = await worker.fetch(authed('/api/account/allowance'), envFor(binding), ctxStub());
    assert.deepEqual(await response.json(), { engine: 'runner' });
  });
});

test('the free month has 5 minutes of Talk', async () => {
  assert.equal(AGENT_TRIAL_TALK_SECONDS, 300);
  assert.deepEqual(
    capAgentTalkAllowance({ voiceSecondsQuota: 3600, consumedVoiceSeconds: 100, remainingVoiceSeconds: 3500, hardLimited: false }, AGENT_TRIAL_TALK_SECONDS),
    { voiceSecondsQuota: 300, consumedVoiceSeconds: 100, remainingVoiceSeconds: 200, hardLimited: false },
  );
  const binding = agentBinding(() => new Response('{}'));
  const state = { ...newState(), subscriptionStatus: 'trialing', consumedVoiceSeconds: 100 };
  await withServices(state, async () => {
    const response = await worker.fetch(authed('/api/voice/session', { method: 'POST', body: '{}' }), envFor(binding), ctxStub());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.maxSeconds, 200);
  });
});

test('a paid top-up from the signed webhook is recorded, with none of the sign-up follow-ups', async () => {
  const binding = agentBinding(() => new Response('{}'));
  const secret = 'whsec_top_up_unit';
  const event = {
    id: 'evt_top_up_worker', type: 'checkout.session.completed', created: 1_789_473_600,
    data: { object: {
      id: 'cs_live_worker_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', currency: 'gbp', amount_total: 200,
      customer: 'cus_agent_1', payment_intent: 'pi_worker_1',
      metadata: { kind: 'usage_top_up', topUpUserId: AGENT_USER, pricePence: '100', tokensPerPack: String(AGENT_TOP_UP.tokens), validMonths: '12' },
    } },
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const state = newState();
  await withServices(state, async () => {
    const ctx = ctxStub();
    const response = await worker.fetch(new Request(`${BASE}/api/stripe/webhook`, {
      method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body: payload,
    }), envFor(binding, { STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: 'sk_test_unit', GITHUB_DISPATCH_TOKEN: 'ghp_unit', RESEND_API_KEY: 're_unit' }), ctx);
    await ctx.settle();
    assert.equal(response.status, 200);
    assert.equal(state.topUps.length, 1);
    assert.equal(state.topUps[0].user_id, AGENT_USER);
    assert.equal(state.topUps[0].tokens, AGENT_TOP_UP.tokens * 2);
    assert.equal(state.topUps[0].stripe_checkout_session_id, 'cs_live_worker_1');
    assert.equal(state.topUps[0].expires_at, '2027-09-15T12:00:00.000Z');
    assert.deepEqual(state.sideEffects, [], 'no provisioning dispatch, welcome email or advert event');
  });
});

test('a plan bought by an assistant account never queues a workspace; everyone else still gets one', async () => {
  const { withoutAssistantWorkspaces } = await import('../dist/stripe.js');
  const queued = [];
  const store = { enqueueHermesProvisioning: async (job) => { queued.push(job.user_id); }, other: () => 'kept' };
  const guarded = withoutAssistantWorkspaces(store, { isAssistantAccount: async (id) => id === AGENT_USER });
  await guarded.enqueueHermesProvisioning({ user_id: AGENT_USER, tier_id: 'studio' });
  await guarded.enqueueHermesProvisioning({ user_id: RUNNER_USER, tier_id: 'studio' });
  assert.deepEqual(queued, [RUNNER_USER]);
  assert.equal(guarded.other(), 'kept', 'the rest of the store is untouched');
  assert.equal(withoutAssistantWorkspaces(store), store, 'no list, no change');
});

test('an applied Stripe entitlement for an assistant account releases the runner the RPC queued', async () => {
  // apply_billing_entitlement queues or resumes a hermes_instances row on every
  // activation, so the release has to follow the write (2026-09-16).
  const { withoutAssistantWorkspaces } = await import('../dist/stripe.js');
  const released = [];
  const store = {
    enqueueHermesProvisioning: async () => {},
    applyEntitlement: async (input) => ({ outcome: input.eventKey === 'stripe:dup' ? 'duplicate' : 'applied', resumed: true }),
  };
  const guarded = withoutAssistantWorkspaces(store, {
    isAssistantAccount: async (id) => id === AGENT_USER,
    releaseRunner: async (id) => { released.push(id); return 'released'; },
  });
  const assistant = await guarded.applyEntitlement({ subscription: { user_id: AGENT_USER }, eventKey: 'stripe:evt_1' });
  assert.deepEqual(assistant, { outcome: 'applied', resumed: false }, 'no workspace to reattach');
  const runner = await guarded.applyEntitlement({ subscription: { user_id: RUNNER_USER }, eventKey: 'stripe:evt_2' });
  assert.deepEqual(runner, { outcome: 'applied', resumed: true }, 'workspace accounts are untouched');
  await guarded.applyEntitlement({ subscription: { user_id: AGENT_USER }, eventKey: 'stripe:dup' });
  assert.deepEqual(released, [AGENT_USER], 'released once, only on an applied outcome');
});

test('an account moved to the assistant mid-month is measured on the assistant usage alone', async () => {
  // The test account arrived at 93% of the allowance on its workspace usage
  // from earlier in the month (2026-09-15).
  const binding = agentBinding(() => new Response('{}'));
  const state = {
    ...newState(),
    usageRows: [{ total_tokens: 14_000_000, source: 'worker' }, { total_tokens: 600_000, source: 'agent' }, { total_tokens: 400_000, source: 'agent' }],
    usedThisCycle: 15_000_000,
  };
  await withServices(state, async () => {
    const snapshot = await fetchUsageSnapshot(AGENT_USER, envFor(binding));
    assert.equal(snapshot.usedTokens, 1_000_000, 'only the assistant usage');
    assert.equal(snapshot.remainingTokens, AGENT_PLAN.monthlyAllowanceTokens - 1_000_000);
    assert.equal(snapshot.hardLimited, false);
    assert.equal(state.settles[0].p_allowance, AGENT_PLAN.monthlyAllowanceTokens + 14_000_000,
      'settlement sees the workspace usage as already covered, so it draws only for assistant overage');
  });
});
