import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  MODEL,
  requireSidekickRunnerAuth,
  signRunnerTokenV1,
} from '../../../apps/worker/dist/index.js';
import {
  cleanupHermesTestRunner,
  processNextHermesProvisioningJob,
  processNextHermesRunnerReadinessCheck,
} from '../../../packages/provisioner/dist/index.js';
import {
  ACKNOWLEDGEMENT_VERSION,
  getPlanTier,
  mapMyProductStateRow,
  resolveSidekickGate,
  resolveStripeBillingDryRunEvent,
} from '../../../packages/shared/dist/index.js';

const USER_ID = '00000000-0000-4000-8000-00000000e2e1';
const RUNNER_SECRET = 'runner_secret_e2e_fixture_32_chars';
const TELEGRAM_SECRET = 'tg_webhook_secret_e2e_fixture';
const SERVICE_ROLE = 'service_role_e2e_fixture_not_real';
const OPENROUTER_KEY = 'or_test_e2e_fixture_not_real';
const SUPABASE_URL = 'https://sidekick-e2e.supabase.co';
const WORKER_URL = 'https://worker.e2e.sidekick.dev';
const RUNNER_URL = 'https://runner.e2e.sidekick.test';
const TELEGRAM_BOT_TOKEN = ['123456', 'telegram_bot_token_fixture_12345'].join(':');
const TELEGRAM_SEND_MESSAGE_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const RUNNER_FILE_ID = 'file_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const workerEnv = {
  OPENROUTER_API_KEY: OPENROUTER_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET,
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  SIDEKICK_TELEGRAM_WEBHOOK_ENABLED: 'true',
  SIDEKICK_TELEGRAM_WEBHOOK_SECRET_TOKEN: TELEGRAM_SECRET,
  SIDEKICK_TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
  SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_secret_e2e_fixture',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestMethod(call) {
  return call.init?.method ?? 'GET';
}

function headerValue(headers, name) {
  return new Headers(headers ?? {}).get(name);
}

function telegramWebhookRequest(update) {
  return new Request(`${WORKER_URL}/v1/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': TELEGRAM_SECRET,
    },
    body: JSON.stringify(update),
  });
}

function telegramTextUpdate({ updateId, messageId, chatId, text }) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_777_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: 55_000, is_bot: false, first_name: 'E2E' },
      text,
    },
  };
}

function productStateRow(state, gateKind = 'ready') {
  const usedTokens = state.usageEvents.reduce((sum, event) => sum + event.total_tokens, 0);
  const quota = state.usageQuota?.monthlyTokenQuota ?? 0;
  return {
    user_id: USER_ID,
    email: state.profile.email,
    full_name: state.profile.fullName,
    avatar_url: null,
    region: 'GB',
    profile_created_at: state.profile.createdAt,
    profile_updated_at: state.profile.updatedAt,
    acknowledgement_accepted: Boolean(state.acknowledgement),
    acknowledgement_accepted_at: state.acknowledgement?.acceptedAt ?? null,
    acknowledgement_text_version: state.acknowledgement?.textVersion ?? null,
    subscription_status: state.subscription?.status ?? null,
    tier_id: state.subscription?.tierId ?? null,
    current_period_start: state.subscription?.currentPeriodStart ?? null,
    current_period_end: state.subscription?.currentPeriodEnd ?? null,
    cancel_at_period_end: state.subscription?.cancelAtPeriodEnd ?? null,
    worker_status: state.hermesInstance?.status ?? null,
    last_health_at: state.hermesInstance?.lastHealthAt ?? null,
    ready_at: state.hermesInstance?.readyAt ?? null,
    error_code: state.hermesInstance?.errorCode ?? null,
    public_status_message: state.hermesInstance?.publicStatusMessage ?? null,
    monthly_token_quota: quota,
    used_tokens: usedTokens,
    remaining_tokens: Math.max(0, quota - usedTokens),
    usage_ratio: quota > 0 ? usedTokens / quota : 0,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: state.taskRuns.filter((task) => task.status === 'queued' || task.status === 'running').length,
    telegram_connected: Boolean(state.telegramConnection),
    gate_kind: gateKind,
  };
}

function assertNoPrivateProviderDetails(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /runner\.e2e|railway|stripe|openrouter|service[-_ ]?role|api[-_ ]?key/i);
  assert.doesNotMatch(text, /cus_fake|sub_fake|price_fake|telegram:chat|telegram:update|telegram:message|idempotency|code_hash/i);
  assert.equal(text.includes(RUNNER_SECRET), false);
  assert.equal(text.includes(TELEGRAM_SECRET), false);
  assert.equal(text.includes(SERVICE_ROLE), false);
  assert.equal(text.includes(OPENROUTER_KEY), false);
}

async function withMockedFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls);
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createE2EState() {
  return {
    profile: {
      id: USER_ID,
      email: 'e2e-user@sidekick.local',
      fullName: 'E2E User',
      // Agent name set during onboarding. Surfaces in the Telegram bot's
      // introductory reply via lookupUserAgentNameSafely + buildTelegramConnectedReply.
      agentName: 'Ruben',
      createdAt: '2026-05-06T09:00:00.000Z',
      updatedAt: '2026-05-06T09:00:00.000Z',
    },
    acknowledgement: {
      userId: USER_ID,
      acceptedAt: '2026-05-06T09:01:00.000Z',
      textVersion: ACKNOWLEDGEMENT_VERSION,
    },
    subscription: null,
    usageQuota: null,
    hermesInstance: null,
    provisioningQueue: [],
    telegramConnection: null,
    connectCode: { id: 'connect_code_e2e_1', normalizedCode: 'TGE2E123', consumed: false },
    gatewayTaskEvents: new Map(),
    taskRuns: [],
    messages: [],
    artifacts: [],
    usageEvents: [],
    runnerTasks: [],
    runnerFiles: [],
    telegramMessages: [],
    privateRunnerBaseUrl: null,
    privateRailwayOutput: null,
    greetingProxyResult: null,
    summaryProxyResult: null,
    fileProxyResult: null,
    proxyResult: null,
  };
}

function createProvisioningStore(state) {
  return {
    async claimNextQueuedHermesJob() {
      const job = state.provisioningQueue.shift();
      if (!job) return null;
      state.hermesInstance = {
        userId: USER_ID,
        status: 'provisioning',
        publicStatusMessage: 'Delegent AI is preparing your private workspace.',
        updatedAt: '2026-05-06T09:05:00.000Z',
      };
      return {
        userId: job.userId,
        tierId: job.tierId,
        idempotencyKey: job.idempotencyKey,
        claimedAt: '2026-05-06T09:05:00.000Z',
      };
    },
    async markHermesProvisioningRequested(job, result) {
      assert.equal(job.userId, USER_ID);
      state.privateRailwayOutput = result;
      state.privateRunnerBaseUrl = RUNNER_URL;
      state.hermesInstance = {
        userId: USER_ID,
        status: 'provisioning',
        publicStatusMessage: 'Delegent AI workspace is starting.',
        updatedAt: '2026-05-06T09:06:00.000Z',
      };
    },
    async markHermesProvisioningFailed(_job, failure) {
      state.hermesInstance = {
        userId: USER_ID,
        status: 'error',
        errorCode: failure.errorCode,
        publicStatusMessage: failure.publicStatusMessage,
      };
    },
    async markHermesProvisioningReconciliationRequired(_job, failure) {
      state.hermesInstance = {
        userId: USER_ID,
        status: 'provisioning',
        errorCode: failure.errorCode,
        publicStatusMessage: failure.publicStatusMessage,
      };
    },
    async verifyHermesTestRunnerCleanupTarget(target) {
      assert.equal(target.userId, USER_ID);
      assert.equal(target.railwayProjectId, state.privateRailwayOutput?.railwayProjectId);
    },
    async markHermesTestRunnerCleanedUp(target) {
      assert.equal(target.userId, USER_ID);
      assert.equal(target.railwayProjectId, state.privateRailwayOutput?.railwayProjectId);
      state.privateRailwayOutput = null;
      state.privateRunnerBaseUrl = null;
      state.hermesInstance = {
        userId: USER_ID,
        status: 'queued',
        publicStatusMessage: 'Delegent AI test runner was cleaned up.',
        updatedAt: '2026-05-06T09:30:00.000Z',
      };
      state.provisioningQueue.push({
        userId: USER_ID,
        tierId: state.subscription.tierId,
        idempotencyKey: 'hermes:e2e:queued-after-cleanup',
      });
    },
    async claimNextHermesReadinessCheck() {
      if (state.hermesInstance?.status !== 'provisioning' || !state.privateRunnerBaseUrl) return null;
      return {
        userId: USER_ID,
        runnerBaseUrl: state.privateRunnerBaseUrl,
        runnerSharedSecret: RUNNER_SECRET,
        claimedAt: '2026-05-06T09:10:00.000Z',
      };
    },
    async markHermesRunnerReady(job) {
      assert.equal(job.userId, USER_ID);
      assert.equal(job.runnerBaseUrl, RUNNER_URL);
      const checkedAt = new Date().toISOString();
      state.hermesInstance = {
        userId: USER_ID,
        status: 'ready',
        lastHealthAt: checkedAt,
        readyAt: checkedAt,
        publicStatusMessage: 'Delegent AI is online.',
        updatedAt: checkedAt,
      };
    },
    async markHermesRunnerReadinessFailed(job, failure) {
      assert.equal(job.userId, USER_ID);
      assert.equal(job.runnerBaseUrl, RUNNER_URL);
      state.hermesInstance = {
        userId: USER_ID,
        status: 'provisioning',
        errorCode: failure.errorCode,
        publicStatusMessage: failure.publicStatusMessage,
        updatedAt: new Date().toISOString(),
      };
    },
  };
}

async function fakeRunnerDispatch(call, state) {
  assert.equal(requestMethod(call), 'POST');
  const authenticatedUserId = await requireSidekickRunnerAuth(new Headers(call.init.headers), workerEnv);
  assert.equal(authenticatedUserId, USER_ID);
  assert.equal(headerValue(call.init.headers, 'authorization'), null);

  const task = JSON.parse(call.init.body);
  assert.equal(task.user_id, USER_ID);
  assert.ok([
    'Hi, can you help?',
    'Summarise today\'s orders and draft a reply.',
    'Create a file named test file.txt in my home directory with the text hello from Delegent AI.',
  ].includes(task.instruction));
  state.runnerTasks.push(task);

  const timestamp = Math.floor(Date.now() / 1000);
  const proxyResponse = await worker.fetch(new Request(`${WORKER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidekick-user-id': USER_ID,
      'x-sidekick-runner-timestamp': String(timestamp),
      'x-sidekick-runner-token': await signRunnerTokenV1(RUNNER_SECRET, USER_ID, timestamp),
    },
    body: JSON.stringify({
      model: 'caller-supplied/model-must-be-ignored',
      provider: { name: 'caller-provider-must-be-stripped' },
      max_tokens: 96,
      messages: [
        { role: 'system', content: 'You are Delegent AI.' },
        { role: 'user', content: task.instruction },
      ],
    }),
  }), workerEnv);
  assert.equal(proxyResponse.status, 200);
  const proxyPayload = await proxyResponse.json();
  state.proxyResult = proxyPayload;
  if (task.instruction.includes('test file.txt')) {
    state.fileProxyResult = proxyPayload;
    state.runnerFiles = [{
      id: RUNNER_FILE_ID,
      name: 'test file.txt',
      relativeName: 'test file.txt',
      sizeBytes: 22,
      modifiedAt: 1_777_000_200,
      mimeType: 'text/plain',
      downloadable: true,
      content: 'hello from Delegent AI',
    }];
  } else if (task.instruction === 'Hi, can you help?') {
    state.greetingProxyResult = proxyPayload;
  } else {
    state.summaryProxyResult = proxyPayload;
  }

  return jsonResponse({
    status: 'completed',
    task_id: `runner_task_e2e_${state.runnerTasks.length}`,
    result: proxyPayload.choices[0].message.content,
  });
}

async function fakeFetch(call, state) {
  if (call.url === `${SUPABASE_URL}/auth/v1/user`) {
    assert.equal(requestMethod(call), 'GET');
    assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer app_access_token_e2e');
    return jsonResponse({
      id: USER_ID,
      email: state.profile.email,
      user_metadata: { full_name: state.profile.fullName },
    });
  }

  if (call.url.includes('/rest/v1/gateway_connect_codes')) {
    if (requestMethod(call) === 'GET') {
      assert.equal(call.url.includes(state.connectCode.normalizedCode), false);
      assert.match(call.url, /code_hash=eq\.[a-f0-9]{64}/);
      return jsonResponse(state.connectCode.consumed ? [] : [{ id: state.connectCode.id, user_id: USER_ID }]);
    }
    if (requestMethod(call) === 'PATCH') {
      assert.match(call.url, /consumed_at=is\.null/);
      state.connectCode.consumed = true;
      return jsonResponse([{ id: state.connectCode.id }]);
    }
  }

  if (call.url.includes('/rest/v1/gateway_connections')) {
    if (requestMethod(call) === 'GET') {
      return jsonResponse(state.telegramConnection ? [{ id: 'gateway_connection_e2e_1', user_id: USER_ID }] : []);
    }
    if (requestMethod(call) === 'POST') {
      const inserted = JSON.parse(call.init.body);
      assert.equal(inserted.user_id, USER_ID);
      assert.equal(inserted.gateway_id, 'telegram');
      assert.equal(inserted.source_conversation_id, 'telegram:chat:44001');
      state.telegramConnection = inserted;
      return jsonResponse([{ id: 'gateway_connection_e2e_1' }], 201);
    }
  }

  if (call.url.includes('/rest/v1/rpc/set_active_gateway_connection')) {
    assert.equal(requestMethod(call), 'POST');
    const body = JSON.parse(call.init.body);
    assert.equal(body.p_user_id, USER_ID);
    assert.equal(body.p_gateway_id, 'telegram');
    assert.equal(body.p_source_conversation_id, 'telegram:chat:44001');
    assert.equal(body.p_source_event_id, 'telegram:update:7001');
    state.telegramConnection = {
      user_id: USER_ID,
      gateway_id: 'telegram',
      source_conversation_id: 'telegram:chat:44001',
      status: 'connected',
    };
    return jsonResponse([{ connection_id: 'gateway_connection_e2e_1', status: 'connected' }]);
  }

  if (call.url.includes('/rest/v1/profiles')) {
    // Worker reads the agent_name from the profile row to introduce the bot
    // by the name the user chose during onboarding. The fakeFetch returns
    // exactly the agent_name to mirror what Supabase would emit.
    assert.equal(requestMethod(call), 'GET');
    assert.match(call.url, new RegExp(`id=eq\\.${USER_ID}`));
    return jsonResponse([{ agent_name: state.profile.agentName }]);
  }

  if (call.url.includes('/rest/v1/subscriptions')) {
    return jsonResponse(state.subscription ? [{ status: state.subscription.status }] : []);
  }

  if (call.url.includes('/rest/v1/hermes_instances')) {
    return jsonResponse(state.hermesInstance ? [{
      status: state.hermesInstance.status,
      ready_at: state.hermesInstance.readyAt ?? null,
      last_health_at: state.hermesInstance.lastHealthAt ?? null,
    }] : []);
  }

  if (call.url.includes('/rest/v1/hermes_instance_private')) {
    return jsonResponse(state.privateRunnerBaseUrl ? [{
      runner_base_url: state.privateRunnerBaseUrl,
      runner_shared_secret: RUNNER_SECRET,
    }] : []);
  }

  if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
    assert.equal(requestMethod(call), 'POST');
    const body = JSON.parse(call.init.body);
    assert.equal(body.p_user_id, USER_ID);
    assert.equal(body.p_gateway_id, 'telegram');
    assert.equal(body.p_source_conversation_id, 'telegram:chat:44001');
    assert.ok([
      'Hi, can you help?',
      'Summarise today\'s orders and draft a reply.',
      'Create a file named test file.txt in my home directory with the text hello from Delegent AI.',
    ].includes(body.p_instruction));
    if (state.gatewayTaskEvents.has(body.p_idempotency_key)) {
      return jsonResponse([{ kind: 'duplicate', task_run_id: state.gatewayTaskEvents.get(body.p_idempotency_key).taskRunId }]);
    }
    const taskRunId = `task_run_e2e_${state.gatewayTaskEvents.size + 1}`;
    state.gatewayTaskEvents.set(body.p_idempotency_key, { taskRunId });
    state.messages.push({ user_id: USER_ID, role: 'user', content: body.p_instruction, task_id: taskRunId });
    state.taskRuns.push({ id: taskRunId, user_id: USER_ID, status: 'running', source: 'telegram' });
    return jsonResponse([{ kind: 'accepted', task_run_id: taskRunId, gateway_task_event_id: 'gateway_event_e2e_1' }]);
  }

  if (call.url.includes('/rest/v1/task_runs') && requestMethod(call) === 'PATCH') {
    const patch = JSON.parse(call.init.body);
    const idFilter = new URL(call.url).searchParams.get('id');
    const taskId = idFilter?.startsWith('eq.') ? idFilter.slice(3) : null;
    const task = state.taskRuns.find((item) => item.id === taskId);
    assert.ok(task, `expected task run ${taskId} to exist before patch`);
    Object.assign(task, patch);
    return jsonResponse([{ id: task.id }]);
  }

  if (call.url.includes('/rest/v1/artifacts') && requestMethod(call) === 'POST') {
    const inserted = JSON.parse(call.init.body);
    state.artifacts.push(inserted);
    return jsonResponse([{ id: 'artifact_e2e_1' }], 201);
  }

  if (call.url.includes('/rest/v1/messages') && requestMethod(call) === 'POST') {
    state.messages.push(JSON.parse(call.init.body));
    return jsonResponse([{ id: `message_e2e_${state.messages.length}` }], 201);
  }

  if (call.url.includes('/rest/v1/usage_quotas')) {
    assert.equal(requestMethod(call), 'GET');
    return jsonResponse([{ monthly_token_quota: state.usageQuota.monthlyTokenQuota, tier_id: state.usageQuota.tierId }]);
  }

  if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') {
    return jsonResponse(state.usageEvents.map((event) => ({ total_tokens: event.total_tokens })));
  }

  if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') {
    const inserted = JSON.parse(call.init.body);
    assert.equal(inserted.user_id, USER_ID);
    assert.equal(inserted.source, 'worker');
    assert.equal(inserted.model, MODEL);
    state.usageEvents.push(inserted);
    return jsonResponse([{ id: 'usage_event_e2e_1' }], 201);
  }

  if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
    assert.equal(requestMethod(call), 'POST');
    assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${OPENROUTER_KEY}`);
    const body = JSON.parse(call.init.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, 96);
    // Reply to the LATEST user turn. The worker sends the user content either as
    // a plain string OR as a structured parts array
    // ([{type:'text', text, cache_control}]) since Kimi prompt-caching added a
    // cache_control breakpoint — flatten to text, then match by substring
    // (rebuilt history / framing may wrap the bare message).
    const contentToText = (c) => Array.isArray(c)
      ? c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ')
      : String(c ?? '');
    const userMessages = body.messages.filter((message) => message.role === 'user');
    const userText = contentToText(userMessages[userMessages.length - 1]?.content);
    const assistantContent = userText.includes('Hi, can you help?')
      ? 'Hi - how can I help?'
      : userText.includes('test file.txt')
      ? 'Created test file.txt in your workspace.'
      : 'Draft ready: today\'s order summary is attached and the customer reply is prepared.';
    return jsonResponse({
      id: 'chatcmpl_e2e_1',
      model: MODEL,
      provider: { name: 'openrouter', leaked: OPENROUTER_KEY },
      choices: [{
        message: {
          role: 'assistant',
          content: assistantContent,
          provider: { name: 'nested-provider' },
          model: 'nested-model',
        },
      }],
      usage: { prompt_tokens: 33, completion_tokens: 67, total_tokens: 100 },
    });
  }

  if (call.url === `${RUNNER_URL}/tasks`) {
    return fakeRunnerDispatch(call, state);
  }

  if (call.url === `${RUNNER_URL}/files`) {
    assert.equal(requestMethod(call), 'GET');
    const authenticatedUserId = await requireSidekickRunnerAuth(new Headers(call.init.headers), workerEnv);
    assert.equal(authenticatedUserId, USER_ID);
    return jsonResponse({
      ok: true,
      truncated: false,
      files: state.runnerFiles.map(({ content: _content, ...file }) => file),
    });
  }

  if (call.url === `${RUNNER_URL}/files/${RUNNER_FILE_ID}`) {
    assert.equal(requestMethod(call), 'GET');
    const authenticatedUserId = await requireSidekickRunnerAuth(new Headers(call.init.headers), workerEnv);
    assert.equal(authenticatedUserId, USER_ID);
    const file = state.runnerFiles.find((item) => item.id === RUNNER_FILE_ID);
    if (!file) return jsonResponse({ error: 'file_not_found' }, 404);
    return new Response(file.content, {
      status: 200,
      headers: {
        'content-type': file.mimeType,
        'content-disposition': `attachment; filename="${file.name}"`,
        'content-length': String(file.content.length),
      },
    });
  }

  if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
    assert.equal(requestMethod(call), 'POST');
    assert.equal(headerValue(call.init.headers, 'content-type'), 'application/json');
    const body = JSON.parse(call.init.body);
    assert.equal(body.chat_id, '44001');
    assert.equal(body.disable_web_page_preview, true);
    state.telegramMessages.push(body);
    return jsonResponse({ ok: true, result: { message_id: 9900 + state.telegramMessages.length } });
  }

  throw new Error(`unexpected E2E fetch: ${requestMethod(call)} ${call.url}`);
}

test('credential-free happy path composes signup, Stripe, Railway, Telegram, runner, and OpenRouter proxy contracts', async () => {
  const state = createE2EState();
  const tier = getPlanTier('pro-office');

  const signedInSnapshot = mapMyProductStateRow(productStateRow(state, 'needs_subscription'));
  assert.equal(resolveSidekickGate(signedInSnapshot).kind, 'needs_subscription');
  assertNoPrivateProviderDetails(signedInSnapshot);

  const billing = resolveStripeBillingDryRunEvent({
    id: 'evt_dry_run_e2e_active',
    type: 'checkout.session.completed',
    mode: 'dry_run',
    userId: USER_ID,
    customerId: 'cus_fake_e2e_customer',
    subscriptionId: 'sub_fake_e2e_subscription',
    priceId: 'price_fake_e2e_pro_office',
    priceLookupKey: tier.stripePriceLookupKey,
    status: 'active',
    currentPeriodStart: '2026-05-01T00:00:00.000Z',
    currentPeriodEnd: '2026-06-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    occurredAt: '2026-05-06T09:02:00.000Z',
  });
  assert.equal(billing.kind, 'subscription_patch');
  assert.equal(billing.shouldPrepareCoworker, true);
  state.subscription = billing.subscription;
  state.usageQuota = billing.usageQuota;
  state.hermesInstance = {
    userId: USER_ID,
    status: 'queued',
    publicStatusMessage: 'Delegent AI is queued for setup.',
    updatedAt: '2026-05-06T09:03:00.000Z',
  };
  state.provisioningQueue.push({
    userId: USER_ID,
    tierId: billing.subscription.tierId,
    idempotencyKey: 'hermes:e2e:queued-1',
  });

  const queuedSnapshot = mapMyProductStateRow(productStateRow(state, 'subscribed_pending_worker'));
  assert.equal(resolveSidekickGate(queuedSnapshot).kind, 'subscribed_pending_worker');
  assertNoPrivateProviderDetails(queuedSnapshot);

  const provisioningStore = createProvisioningStore(state);
  const provisioning = await processNextHermesProvisioningJob({
    env: {
      RAILWAY_API_TOKEN: 'railway_e2e_token_not_real',
      RAILWAY_WORKSPACE_ID: 'workspace_e2e',
      RAILWAY_PROJECT_ID: 'project_parent_e2e',
      RAILWAY_ENVIRONMENT_ID: 'environment_e2e',
      HERMES_ADMIN_USERNAME: 'admin',
      HERMES_ADMIN_PASSWORD: '[REDACTED_TEST_PASSWORD]',
      SIDEKICK_RUNNER_IMAGE: 'ghcr.io/sidekick/hermes-runner:e2e',
      SIDEKICK_WORKER_PROXY_URL: `${WORKER_URL}/v1/chat/completions`,
      SIDEKICK_RUNNER_SERVER_URL: `${WORKER_URL}/runner/server.py`,
      SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET,
    },
  }, {
    store: provisioningStore,
    railway: {
      async templateDeployV2(deployInput, railwayToken) {
        assert.equal(railwayToken, 'railway_e2e_token_not_real');
        assert.equal(deployInput.templateId.length > 0, true);
        assert.equal(JSON.stringify(deployInput).includes('OPENROUTER_API_KEY'), false);
        return { projectId: 'railway_project_fake_e2e', workflowId: 'railway_workflow_fake_e2e' };
      },
    },
  });
  assert.equal(provisioning.status, 'provisioning');
  assert.equal(state.provisioningQueue.length, 0);
  assert.equal(state.privateRunnerBaseUrl, RUNNER_URL);

  const readiness = await processNextHermesRunnerReadinessCheck({}, {
    store: provisioningStore,
    runnerHealth: {
      async fetchHealth(request) {
        assert.deepEqual(request, {
          url: `${RUNNER_URL}/health`,
          userId: USER_ID,
          runnerSharedSecret: RUNNER_SECRET,
        });
        return { ok: true, engine: 'hermes-agent' };
      },
    },
  });
  assert.deepEqual(readiness, { status: 'ready' });

  const readySnapshot = mapMyProductStateRow(productStateRow(state, 'ready'));
  assert.equal(resolveSidekickGate(readySnapshot).kind, 'ready');
  assertNoPrivateProviderDetails(readySnapshot);

  await withMockedFetch((call) => fakeFetch(call, state), async () => {
    const connectResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 7001,
      messageId: 8001,
      chatId: 44001,
      text: '/start TG-E2E123',
    })), workerEnv);
    assert.equal(connectResponse.status, 200);
    assert.deepEqual(await connectResponse.json(), {
      ok: true,
      gatewayId: 'telegram',
      kind: 'connected',
      publicReply: "Hello, my name is Ruben. I'm now connected to your Telegram. Send a task here whenever you're ready.",
    });
    assert.deepEqual(state.telegramMessages[0], {
      chat_id: '44001',
      text: "Hello, my name is Ruben. I'm now connected to your Telegram. Send a task here whenever you're ready.",
      disable_web_page_preview: true,
      reply_to_message_id: 8001,
      allow_sending_without_reply: true,
    });

    const telegramGreetingResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 7002,
      messageId: 8002,
      chatId: 44001,
      text: 'Hi, can you help?',
    })), workerEnv);
    assert.equal(telegramGreetingResponse.status, 202);
    const telegramGreetingBody = await telegramGreetingResponse.json();
    assert.equal(telegramGreetingBody.kind, 'task_dispatched');
    assert.equal(telegramGreetingBody.publicReply, "Got it. I'm on it.");
    assertNoPrivateProviderDetails(telegramGreetingBody);
    assert.equal(state.runnerTasks.length, 1);
    assert.deepEqual(state.telegramMessages[1], {
      chat_id: '44001',
      text: 'Hi - how can I help?',
      disable_web_page_preview: true,
      reply_to_message_id: 8002,
      allow_sending_without_reply: true,
    });

    const telegramTaskResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 7003,
      messageId: 8003,
      chatId: 44001,
      text: 'Summarise today\'s orders and draft a reply.',
    })), workerEnv);
    assert.equal(telegramTaskResponse.status, 202);
    const telegramTaskBody = await telegramTaskResponse.json();
    assert.equal(telegramTaskBody.kind, 'task_dispatched');
    assert.equal(telegramTaskBody.publicReply, "Got it. I'm on it.");
    assertNoPrivateProviderDetails(telegramTaskBody);
    assert.equal(state.runnerTasks.length, 2);
    assert.deepEqual(state.telegramMessages[2], {
      chat_id: '44001',
      text: 'Draft ready: today\'s order summary is attached and the customer reply is prepared.',
      disable_web_page_preview: true,
      reply_to_message_id: 8003,
      allow_sending_without_reply: true,
    });

    const telegramFileTaskResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 7004,
      messageId: 8004,
      chatId: 44001,
      text: 'Create a file named test file.txt in my home directory with the text hello from Delegent AI.',
    })), workerEnv);
    assert.equal(telegramFileTaskResponse.status, 202);
    const telegramFileTaskBody = await telegramFileTaskResponse.json();
    assert.equal(telegramFileTaskBody.kind, 'task_dispatched');
    assert.equal(telegramFileTaskBody.publicReply, "Got it. I'm on it.");
    assertNoPrivateProviderDetails(telegramFileTaskBody);
    assert.equal(state.runnerFiles.length, 1);
    assert.deepEqual(state.telegramMessages[3], {
      chat_id: '44001',
      text: 'Created test file.txt in your workspace.',
      disable_web_page_preview: true,
      reply_to_message_id: 8004,
      allow_sending_without_reply: true,
    });

    const filesResponse = await worker.fetch(new Request(`${WORKER_URL}/api/files/runner`, {
      method: 'GET',
      headers: { authorization: 'Bearer app_access_token_e2e' },
    }), workerEnv);
    assert.equal(filesResponse.status, 200);
    const filesPayload = await filesResponse.json();
    assert.equal(filesPayload.storageStatus, 'ready');
    assert.equal(filesPayload.files.length, 1);
    assert.equal(filesPayload.files[0].name, 'test file.txt');
    assert.equal(filesPayload.files[0].relativeName, 'test file.txt');
    assert.equal(filesPayload.files[0].downloadable, true);
    assert.match(filesPayload.files[0].downloadUrl, /^https:\/\/worker\.e2e\.sidekick\.dev\/api\/files\/runner\/file_[a-f0-9]{32}\?token=v1\./);
    assertNoPrivateProviderDetails(filesPayload);

    const fileDownload = await worker.fetch(new Request(filesPayload.files[0].downloadUrl), workerEnv);
    assert.equal(fileDownload.status, 200);
    assert.equal(await fileDownload.text(), 'hello from Delegent AI');
    assert.equal(fileDownload.headers.get('cache-control'), 'private, no-store');

    const duplicateTelegramTaskResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 7003,
      messageId: 8003,
      chatId: 44001,
      text: 'Summarise today\'s orders and draft a reply.',
    })), workerEnv);
    assert.equal(duplicateTelegramTaskResponse.status, 202);
    const duplicateTelegramTaskBody = await duplicateTelegramTaskResponse.json();
    assert.equal(duplicateTelegramTaskBody.kind, 'duplicate_task');
    assert.equal(duplicateTelegramTaskBody.publicReply, 'I already picked up that one.');
    assertNoPrivateProviderDetails(duplicateTelegramTaskBody);
    assert.equal(state.runnerTasks.length, 3);
  });

  assert.equal(state.connectCode.consumed, true);
  assert.equal(state.telegramConnection.user_id, USER_ID);
  assert.equal(state.gatewayTaskEvents.size, 3);
  assert.equal(state.runnerTasks.length, 3);
  assert.equal(state.telegramMessages.length, 4);
  assert.equal(state.taskRuns.every((task) => task.status === 'succeeded'), true);
  assert.equal(state.taskRuns[0].runner_task_id, null);
  assert.equal(state.taskRuns[1].runner_task_id, null);
  assert.equal(state.taskRuns[2].runner_task_id, null);
  assert.equal(state.usageEvents.length, 3);
  // The Worker records the cost-proportional billable total, not the raw upstream
  // count: prompt + output*4.7 = 33 + 67*4.7 = 348 (cache-aware billing, shipped
  // 2026-06-05 — output is ~4.7x the input cost on Kimi, so it's weighted).
  assert.deepEqual(state.usageEvents.map((event) => event.total_tokens), [348, 348, 348]);
  // The Worker keeps a generic `model` label on the response so that
  // openai-python's ChatCompletion validator inside the Hermes runner accepts
  // it. The actual upstream model identifier is still scrubbed.
  assert.equal(typeof state.summaryProxyResult.model, 'string');
  assert.ok(state.summaryProxyResult.model.length > 0);
  const proxyResultWithoutModel = { ...state.summaryProxyResult };
  delete proxyResultWithoutModel.model;
  assert.deepEqual(proxyResultWithoutModel, {
    id: 'chatcmpl_e2e_1',
    choices: [{ message: { role: 'assistant', content: 'Draft ready: today\'s order summary is attached and the customer reply is prepared.' } }],
    usage: { prompt_tokens: 33, completion_tokens: 67, total_tokens: 100 },
  });
  assert.equal(state.greetingProxyResult.choices[0].message.content, 'Hi - how can I help?');
  assert.equal(state.fileProxyResult.choices[0].message.content, 'Created test file.txt in your workspace.');
  assert.equal(state.runnerFiles[0].name, 'test file.txt');
  assert.equal(state.artifacts.length, 3);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 3);

  const finalSnapshot = mapMyProductStateRow(productStateRow(state, 'ready'));
  assert.equal(resolveSidekickGate(finalSnapshot).kind, 'ready');
  assert.equal(finalSnapshot.connections.find((connection) => connection.id === 'telegram')?.status, 'live');
  assert.equal(finalSnapshot.usage.usedTokens, 1044); // 3 turns x 348 cost-proportional tokens (see above)
  assertNoPrivateProviderDetails(finalSnapshot);

  const cleanupCalls = [];
  const cleanup = await cleanupHermesTestRunner({
    userId: USER_ID,
    railwayProjectId: provisioning.railwayProjectId,
    railwayToken: 'railway_e2e_token_not_real',
    allowRailwayDelete: true,
  }, {
    store: provisioningStore,
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy another runner');
      },
      async projectDelete(projectId, railwayToken) {
        cleanupCalls.push({ projectId, railwayToken });
        return true;
      },
    },
  });
  assert.deepEqual(cleanup, { status: 'deleted', railwayProjectId: 'railway_project_fake_e2e' });
  assert.deepEqual(cleanupCalls, [{ projectId: 'railway_project_fake_e2e', railwayToken: 'railway_e2e_token_not_real' }]);
  assert.equal(state.privateRailwayOutput, null);
  assert.equal(state.privateRunnerBaseUrl, null);
  assert.equal(state.hermesInstance.status, 'queued');
  assert.equal(state.provisioningQueue.length, 1);
});
