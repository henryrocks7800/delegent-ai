// IMPORTANT: this file imports the built Worker from `../dist/index.js`. Always
// run via `npm test` (which performs `npm run build` first) — invoking
// `node --test` directly may test stale compiled output if the TS source has
// changed since the last build.
import test from 'node:test';
import { portalConfiguration } from '../../../tests/fixtures/portal-configuration.mjs';
import assert from 'node:assert/strict';
import { SIDEKICK_FREE_TRIAL } from '@sidekick/shared';

test('Apple service expiry blocks voice and transcription even when the trial offer is disabled', async () => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = false;
  try {
    for (const status of ['active', 'trialing', 'past_due']) {
      for (const path of ['/api/voice/session', '/api/audio/transcribe']) {
        await withMockedFetch((call) => {
          if (call.url.endsWith('/auth/v1/user')) return jsonResponse({ id: '11111111-1111-4111-8111-111111111111' });
          if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status, billing_provider: 'apple',
            current_period_end: new Date(Date.now() - 86_400_000).toISOString(),
            service_access_until: new Date(Date.now() - 1).toISOString() }]);
          throw new Error('Expired Apple service reached a paid provider');
        }, async () => {
          const response = await worker.fetch(new Request(`https://worker.sidekick.dev${path}`, {
            method: 'POST', headers: { authorization: 'Bearer test_voice_token' },
          }), LIVE_ENV);
          assert.equal(response.status, 402, await response.clone().text());
          assert.equal((await response.json()).error, 'no_active_subscription');
        });
      }
    }
  } finally { SIDEKICK_FREE_TRIAL.enabled = previous; }
});

test('expired trials cannot mint voice sessions or transcribe audio', async () => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = true;
  try {
    for (const path of ['/api/voice/session', '/api/audio/transcribe']) {
      await withMockedFetch((call) => {
        if (call.url.endsWith('/auth/v1/user')) return jsonResponse({ id: '11111111-1111-4111-8111-111111111111' });
        if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'trialing', current_period_end: new Date(Date.now() - 1000).toISOString() }]);
        throw new Error('Expired trial reached a paid service');
      }, async () => {
        const response = await worker.fetch(new Request(`https://worker.sidekick.dev${path}`, {
          method: 'POST', headers: { authorization: 'Bearer test_voice_token' },
        }), LIVE_ENV);
        assert.equal(response.status, 402, await response.clone().text());
        assert.equal((await response.json()).error, 'no_active_subscription');
      });
    }
  } finally { SIDEKICK_FREE_TRIAL.enabled = previous; }
});
import worker, {
  MAX_COMPLETION_TOKENS,
  MAX_REQUEST_MESSAGES,
  MAX_REQUEST_CONTENT_BYTES,
  MODEL,
  ACCOUNT_EXPORT_SOURCES,
  MODEL_PROVIDER_PIN,
  MODEL_PROVIDER_ORDER,
  MODEL_PROVIDER_IGNORE,
  RUNNER_AUTH_MAX_SKEW_SECONDS,
  applyPromptCacheBreakpoints,
  buildOpenRouterPayload,
  createHealthPayload,
  extractUsageEvent,
  isProxyLive,
  preflightCloudflareWorker,
  requireSidekickRunnerAuth,
  signRunnerTokenV1,
  timingSafeEqualBytes,
  verifyRunnerTokenV1,
} from '../dist/index.js';

const TELEGRAM_BOT_TOKEN = ['123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'].join(':');
const TELEGRAM_SEND_MESSAGE_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

// Default test env enables the legacy fallback so historical tests that send
// the bare shared secret as the runner token continue to authenticate. Tests
// that exercise the v1 HMAC path build a fresh env without this flag.
const LIVE_ENV = {
  SIDEKICK_WORKER_PROXY_ENABLED: 'true',
  SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  OPENROUTER_API_KEY: 'or_test_secret',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
  SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  SIDEKICK_RUNNER_AUTH_LEGACY: 'true',
  SIDEKICK_TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
};

const STRIPE_ENV = {
  ...LIVE_ENV,
  STRIPE_SECRET_KEY: 'sk_test_fake_worker_secret',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_Generic',
  STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID: 'bpc_Pro',
  STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID: 'bpc_Enterprise',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake_worker_secret',
  SUPABASE_ANON_KEY: 'anon_test_key',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://worker.sidekick.test',
};

const HMAC_ENV = {
  ...LIVE_ENV,
  SIDEKICK_RUNNER_AUTH_LEGACY: undefined,
};

const TELEGRAM_WEBHOOK_URL = 'https://worker.sidekick.test/v1/telegram/webhook';
const TELEGRAM_CONNECT_CODE_URL = 'https://worker.sidekick.test/api/gateways/telegram/connect-code';
const MESSAGING_DISCONNECT_URL = 'https://worker.sidekick.test/api/gateways/messaging/disconnect';
const RUNNER_FILES_URL = 'https://worker.sidekick.test/api/files/runner';
const ACCOUNT_EXPORT_URL = 'https://worker.sidekick.test/api/account/export';
const ACCOUNT_DELETE_URL = 'https://worker.sidekick.test/api/account/delete';

function chatCompletionRequest(body, headers = {}) {
  return new Request('https://worker.sidekick.test/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
      'x-sidekick-runner-token': LIVE_ENV.SIDEKICK_RUNNER_SHARED_SECRET,
      ...headers,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
      ...body,
    }),
  });
}

function telegramWebhookRequest(update) {
  return new Request(TELEGRAM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
}

function telegramConnectCodeRequest(headers = {}) {
  return new Request(TELEGRAM_CONNECT_CODE_URL, {
    method: 'POST',
    headers,
  });
}

function accountExportRequest(headers = {}) {
  return new Request(ACCOUNT_EXPORT_URL, {
    method: 'POST',
    headers,
  });
}

function accountDeleteRequest(headers = {}) {
  return new Request(ACCOUNT_DELETE_URL, {
    method: 'POST',
    headers,
  });
}

function telegramTextUpdate({ updateId, messageId, chatId, text, date = 1770000000, chatType = 'private' }) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date,
      chat: { id: chatId, type: chatType },
      from: { id: 901, first_name: 'Alex', username: 'alex_sidekick' },
      text,
    },
  };
}

function enabledTelegramDryRunEnv(overrides = {}) {
  return {
    ...LIVE_ENV,
    SIDEKICK_TELEGRAM_WEBHOOK_DRY_RUN_ENABLED: 'true',
    ...overrides,
  };
}

function enabledTelegramLiveEnv(overrides = {}) {
  return {
    ...LIVE_ENV,
    SIDEKICK_TELEGRAM_WEBHOOK_ENABLED: 'true',
    SIDEKICK_TELEGRAM_WEBHOOK_SECRET_TOKEN: 'tg_webhook_secret',
    ...overrides,
  };
}

function telegramLiveWebhookRequest(update, headers = {}) {
  return new Request(TELEGRAM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'tg_webhook_secret',
      ...headers,
    },
    body: JSON.stringify(update),
  });
}

function readyHermesInstance(overrides = {}) {
  return {
    status: 'ready',
    ready_at: new Date(Date.now() - 60_000).toISOString(),
    last_health_at: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 201) {
  return new Response('', { status });
}

function requestMethod(call) {
  return (call.init?.method ?? 'GET').toUpperCase();
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function telegramSendMessageResponse() {
  return jsonResponse({ ok: true, result: { message_id: 9901 } });
}

function assertTelegramSendMessage(call, { chatId, replyToMessageId, text }) {
  assert.equal(call.url, TELEGRAM_SEND_MESSAGE_URL);
  assert.equal(requestMethod(call), 'POST');
  assert.equal(headerValue(call.init.headers, 'content-type'), 'application/json');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, {
    chat_id: String(chatId),
    text,
    disable_web_page_preview: true,
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
  });
}

async function withMockedFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    if (url.includes('/rest/v1/subscriptions?user_id=eq.')) {
      // Since the three-day trial went live the chat gate reads the caller's
      // subscription row on every request. A test that does not model billing
      // gets an ordinary active subscriber, which is what every live customer
      // row looks like; a test that answers this lookup itself keeps its answer.
      try {
        const answered = await handler(call, calls);
        if (answered) return answered;
      } catch {
        // fall through to the default subscriber
      }
      return jsonResponse([{ status: 'active' }]);
    }
    return handler(call, calls);
  };

  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertBodyIsSafe(text) {
  assert.equal(text.includes(LIVE_ENV.OPENROUTER_API_KEY), false);
  assert.equal(text.includes(LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(text.includes(LIVE_ENV.SIDEKICK_RUNNER_SHARED_SECRET), false);
  assert.doesNotMatch(text, /supabase|openrouter|cloudflare|service[-_ ]?role|api[-_ ]?key|provider|runtime|container|hermes/i);
}

test('telegram connect-code endpoint requires app authentication without external calls', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram connect-code must not call fetch without a bearer token');
  }, async (calls) => {
    const response = await worker.fetch(telegramConnectCodeRequest(), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: 'unauthenticated' });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('account export endpoint returns an immediate verifiable data artefact, not an email-only promise', async () => {
  const userId = '33333333-3333-4333-8333-333333333333';
  const exportedTables = [];
  const selects = {};

  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer user_access_token');
      return jsonResponse({
        id: userId,
        email: 'alex@example.test',
        user_metadata: { full_name: 'Alex' },
      });
    }

    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (requestMethod(call) === 'GET') {
        assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
        assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
        // Every source is filtered by the subject on its declared column
        // (user_id for most; the referrals table is read once by who invited
        // and once by who was invited, 2026-09-23).
        const source = ACCOUNT_EXPORT_SOURCES.find((entry) => entry.table === table && url.searchParams.get(entry.column) === `eq.${userId}`);
        assert.ok(source, `${table} must be filtered by the subject on its declared column`);
        exportedTables.push(table);
        selects[`${table}:${source.column}`] = url.searchParams.get('select');
        if (table === 'profiles') return jsonResponse([{ id: userId, email: 'alex@example.test', full_name: 'Alex' }]);
        if (table === 'subscriptions') return jsonResponse([{ user_id: userId, status: 'active', tier_id: 'studio' }]);
        if (table === 'hermes_instances') return jsonResponse([{ user_id: userId, status: 'ready' }]);
        if (table === 'messages') return jsonResponse([{ id: 'msg_1', user_id: userId, role: 'user', content: 'Please save my receipt' }]);
        if (table === 'task_runs') return jsonResponse([{ id: 'run_1', user_id: userId, status: 'succeeded', instruction: 'Please save my receipt' }]);
        if (table === 'artifacts') return jsonResponse([{ id: 'artifact_1', user_id: userId, title: 'receipt.pdf', kind: 'file' }]);
        if (table === 'token_usage_events') return jsonResponse([{ id: 'usage_1', user_id: userId, total_tokens: 42 }]);
        if (table === 'usage_quotas') return jsonResponse([{ user_id: userId, monthly_token_quota: 200000 }]);
        if (table === 'gateway_connections') return jsonResponse([{ id: 'gateway_1', user_id: userId, gateway_id: 'telegram', status: 'connected' }]);
        if (table === 'provisioning_events') return jsonResponse([{ event: 'runner_ready', created_at: '2026-09-01T00:00:00Z' }]);
        if (table === 'scheduled_tasks') return jsonResponse([{ id: 'task_1', user_id: userId, prompt: 'Send me the weekly numbers' }]);
        if (table === 'user_connections') return jsonResponse([{ service: 'freeagent', status: 'connected', account_label: 'Fixture Ltd' }]);
        // Everything else in the source list answers empty; the point of this
        // fixture is the REQUEST shape, not sample rows for twenty tables.
        return jsonResponse([]);
      }

      if (table === 'provisioning_events' && requestMethod(call) === 'POST') {
        const inserted = JSON.parse(call.init.body);
        assert.equal(inserted.user_id, userId);
        assert.equal(inserted.event, 'account_export_generated');
        assert.match(inserted.details.generated_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(inserted.details.export_sha256, /^[a-f0-9]{64}$/);
        assert.equal(inserted.details.table_counts.messages, 1);
        return emptyResponse();
      }
    }

    throw new Error(`unexpected fetch: ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(accountExportRequest({
      authorization: 'Bearer user_access_token',
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assertBodyIsSafe(responseText);
    assert.doesNotMatch(responseText, /receive a download link by email within 1 hour/i);

    const body = JSON.parse(responseText);
    assert.equal(body.ok, true);
    assert.equal(body.artifact.kind, 'account_data_export');
    assert.match(body.artifact.fileName, /^delegent-ai-account-export-33333333-3333-4333-8333-333333333333-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(body.artifact.contentType, 'application/json');
    assert.match(body.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(body.artifact.bundle.schemaVersion, 'account-export.v2');
    assert.equal(body.artifact.bundle.subject.id, userId);
    assert.equal(body.artifact.bundle.tables.profile.email, 'alex@example.test');
    assert.equal(body.artifact.bundle.tables.messages[0].content, 'Please save my receipt');
    assert.equal(body.artifact.bundle.tables.artifacts[0].title, 'receipt.pdf');
    // The tables the export grew to cover. An entry going missing from this
    // list is the defect this test exists for: the product added scheduled
    // tasks, attribution, connector metadata and five billing ledgers, and the
    // export went on returning the original ten with nothing saying so.
    assert.equal(body.artifact.bundle.tables.scheduledTasks[0].prompt, 'Send me the weekly numbers');
    assert.equal(body.artifact.bundle.tables.connections[0].account_label, 'Fixture Ltd');
    assert.deepEqual(exportedTables.sort(), ACCOUNT_EXPORT_SOURCES.map(source => source.table).sort());
    for (const source of ACCOUNT_EXPORT_SOURCES) {
      assert.equal(selects[`${source.table}:${source.column}`], source.select, `${source.table} must be asked for its declared columns`);
    }
    // Never a credential, a lease or an infrastructure identifier, whatever a
    // future migration adds to those tables. `details` goes too: it is written
    // by our own code and can carry machine and volume names.
    for (const select of Object.values(selects)) {
      assert.doesNotMatch(select ?? '', /token|secret|_enc|lease|base_url|snapshot|machine|volume|details/i);
    }
    assert.doesNotMatch(responseText, /_enc|lease_token|teardown_snapshot/);
    // And the bundle says what it does not contain.
    assert.equal(body.artifact.bundle.coverage.complete, true);
    assert.ok(body.artifact.bundle.coverage.omitted.length >= 3);
    assert.match(JSON.stringify(body.artifact.bundle.coverage.omitted), /coworker's own memory/);
    assert.equal(body.artifact.bundle.coverage.tables.messages.rows, 1);
    assert.equal(calls.some((call) => call.url.includes('/hermes_instance_private')), false);
  });
});

test('an export that could not be read to the end is refused, not handed over truncated', async () => {
  // The shared pager stopped at its bound and returned what fitted. A reduced
  // bound returned two of three rows with no error, and the bundle looked
  // exactly like a complete one. Somebody relying on that has no way to know.
  const userId = '33333333-3333-4333-8333-333333333333';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test', user_metadata: { full_name: 'Alex' } });
    }
    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (requestMethod(call) !== 'GET') return emptyResponse();
      if (table !== 'messages') return jsonResponse([]);
      // The server's own exact count says there is more than this page.
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `msg_${offset + i}`, user_id: userId }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-range': `${offset}-${offset + 999}/999999999` },
      });
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(accountExportRequest({ authorization: 'Bearer user_access_token' }), LIVE_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(responseText).error, 'account_export_incomplete');
    assertBodyIsSafe(responseText);
  });
});

test('a source with a declared cap is bounded and said out loud, not refused', async () => {
  // The other half of the rule above. usage_violations reached 457,751 rows on
  // one account after a denial the runner could never satisfy was retried every
  // six seconds for six days. The pager cannot read that, so `complete` was
  // false, so the export refused, so the account could not exercise Article 15
  // at all. A cap is the answer ONLY because the bundle states it: the newest
  // 5,000, the true total, and a sentence in `omitted`.
  const userId = '33333333-3333-4333-8333-333333333333';
  const TOTAL = 457751;
  const orders = {};
  let violationPages = 0;
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test', user_metadata: { full_name: 'Alex' } });
    }
    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (requestMethod(call) !== 'GET') return emptyResponse();
      orders[table] = url.searchParams.get('order');
      if (table !== 'usage_violations') return jsonResponse([]);
      violationPages += 1;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: offset + i, user_id: userId, cap_kind: 'token' }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-range': `${offset}-${offset + 999}/${TOTAL}` },
      });
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(accountExportRequest({ authorization: 'Bearer user_access_token' }), LIVE_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 200);
    assertBodyIsSafe(responseText);
    const { coverage, tables } = JSON.parse(responseText).artifact.bundle;

    // Bounded, and bounded where the source says rather than at the shared bound.
    assert.equal(violationPages, 5);
    assert.equal(tables.usageViolations.length, 5000);
    // Newest first, so the 5,000 kept are the recent ones.
    assert.equal(orders.usage_violations, 'occurred_at.desc');

    // Handed over, not refused.
    assert.equal(coverage.complete, true);
    // And every part of the bundle admits what happened.
    assert.deepEqual(coverage.capped, ['usageViolations']);
    assert.equal(coverage.tables.usageViolations.complete, false);
    assert.equal(coverage.tables.usageViolations.rows, 5000);
    assert.equal(coverage.tables.usageViolations.total, TOTAL);
    assert.match(JSON.stringify(coverage.omitted), /times we blocked a request on your account/);
    assert.match(JSON.stringify(coverage.omitted), /Ask us and we will send you the rest/);
    // The standing omissions are still there; the cap is an addition to them.
    assert.match(JSON.stringify(coverage.omitted), /coworker's own memory/);
  });
});

test('a capped source that fits is complete, and admits to nothing', async () => {
  const userId = '33333333-3333-4333-8333-333333333333';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test', user_metadata: { full_name: 'Alex' } });
    }
    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (requestMethod(call) !== 'GET') return emptyResponse();
      if (table !== 'usage_violations') return jsonResponse([]);
      return new Response(JSON.stringify([{ id: 1, user_id: userId, cap_kind: 'token' }]), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
      });
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(accountExportRequest({ authorization: 'Bearer user_access_token' }), LIVE_ENV);
    assert.equal(response.status, 200);
    const { coverage } = JSON.parse(await response.text()).artifact.bundle;
    assert.deepEqual(coverage.capped, []);
    assert.equal(coverage.tables.usageViolations.complete, true);
    assert.equal(coverage.omitted.length, 3, 'no cap sentence when no cap bit');
  });
});

test('account delete endpoint creates a durable teardown request before promising deletion', async () => {
  const userId = '44444444-4444-4444-8444-444444444444';
  const originProgress = [];

  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer user_access_token');
      return jsonResponse({
        id: userId,
        email: 'alex@example.test',
        user_metadata: { full_name: 'Alex' },
      });
    }

    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/admin/users/${userId}`) {
      assert.equal(requestMethod(call), 'DELETE');
      assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
      assert.equal(JSON.stringify(call).includes('user_access_token'), false);
      return emptyResponse(200);
    }

    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (requestMethod(call) === 'GET') {
        assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
        assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
        assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
        assert.equal(url.searchParams.get('limit'), '1');
        // 2026-09-03: the delete flow now reads the subscription first so it
        // can stop Stripe billing before the cascade destroys the ids.
        if (table === 'subscriptions') return jsonResponse([]);
        if (table === 'hermes_instances') {
          assert.match(url.searchParams.get('select') ?? '', /provider,status,base_url,updated_at/);
          return jsonResponse([{ user_id: userId, provider: 'fly_machines', status: 'ready', base_url: 'https://agent.example.test', updated_at: '2026-05-22T09:00:00.000Z' }]);
        }
        if (table === 'hermes_instance_private') {
          const selected = url.searchParams.get('select') ?? '';
          assert.match(selected, /fly_app_name/);
          assert.match(selected, /fly_machine_id/);
          assert.match(selected, /fly_volume_id/);
          assert.doesNotMatch(selected, /runner_shared_secret/i);
          return jsonResponse([{ provider: 'fly_machines', fly_org: 'personal', fly_app_name: 'delegent-user-4444', fly_machine_id: 'machine_4444', fly_volume_id: 'vol_4444', fly_region: 'lhr' }]);
        }
      }

      if (table === 'rpc/open_account_deletion_request') {
        // The insert became an idempotent open-or-reuse: a retry after a 503
        // used to collide with the open-request unique index before it could
        // reach auth deletion at all, so there was no way through.
        const sent = JSON.parse(call.init.body);
        assert.equal(sent.p_user_id, userId);
        assert.equal(sent.p_user_email, 'alex@example.test');
        assert.equal(sent.p_requested_via, 'mobile_app');
        assert.match(sent.p_teardown_by, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(sent.p_subject_snapshot.full_name, 'Alex');
        assert.equal(sent.p_teardown_snapshot.public_workspace.status, 'ready');
        assert.equal(sent.p_teardown_snapshot.private_teardown_target.fly_app_name, 'delegent-user-4444');
        assert.equal(sent.p_teardown_snapshot.private_teardown_target.fly_machine_id, 'machine_4444');
        assert.equal(sent.p_teardown_snapshot.private_teardown_target.fly_volume_id, 'vol_4444');
        assert.equal('runner_shared_secret' in sent.p_teardown_snapshot.private_teardown_target, false);
        return jsonResponse([{ id: 'delete_req_4444', status: 'requested', requested_at: sent.p_at, teardown_by: sent.p_teardown_by }]);
      }

      if (table === 'rpc/record_account_deletion_origin_progress') {
        const sent = JSON.parse(call.init.body);
        assert.equal(sent.p_request_id, 'delete_req_4444');
        assert.equal(sent.p_user_id, userId);
        originProgress.push(sent);
        return jsonResponse(true);
      }

      if (table === 'provisioning_events' && requestMethod(call) === 'POST') {
        const inserted = JSON.parse(call.init.body);
        assert.equal(inserted.user_id, userId);
        assert.equal(inserted.event, 'account_delete_requested');
        assert.equal(inserted.details.deletion_request_id, 'delete_req_4444');
        return emptyResponse();
      }
    }

    throw new Error(`unexpected fetch: ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(accountDeleteRequest({
      authorization: 'Bearer user_access_token',
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assertBodyIsSafe(responseText);
    const body = JSON.parse(responseText);
    assert.equal(body.ok, true);
    assert.equal(body.deletionRequest.id, 'delete_req_4444');
    assert.equal(body.deletionRequest.status, 'requested');
    assert.match(body.deletionRequest.teardownBy, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.authAccount.deleted, true);
    assert.match(body.authAccount.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
    const durableRequestIndex = calls.findIndex((call) => call.url.includes('/rpc/open_account_deletion_request'));
    const authDeleteIndex = calls.findIndex((call) => call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/admin/users/${userId}` && requestMethod(call) === 'DELETE');
    assert.ok(durableRequestIndex >= 0, 'durable deletion request must be opened');
    assert.ok(authDeleteIndex > durableRequestIndex, 'auth row must be deleted only after the durable teardown request exists');

    // The connector sweep is recorded BEFORE auth deletion, because after it
    // the cascade has taken every other place it could have been written. The
    // old code left the evidence in provisioning_events, which the same
    // cascade deletes.
    const sweepIndex = calls.findIndex((call) => call.url.includes('/rpc/record_account_deletion_origin_progress'));
    assert.ok(sweepIndex >= 0 && sweepIndex < authDeleteIndex,
      'what a broker still owes must be recorded before the account disappears');
    assert.equal(originProgress[0].p_connections_swept, true);
    assert.ok(Array.isArray(originProgress[0].p_pending_cleanup));
    assert.equal(originProgress.at(-1).p_auth_deleted, true, 'and the auth phase is recorded when it succeeds');
    // Never a credential. A Composio revoke needs only the account id, and the
    // one native connector left has no server-side revoke to retry at all.
    assert.doesNotMatch(JSON.stringify(originProgress), /token|secret|_enc/i);
  });
});

test('a deletion that cannot erase the auth account leaves the request unfinished rather than claiming success', async () => {
  // The live reproduction: the endpoint answered 503, the durable row said
  // `requested`, and the queue behind it only did workspace teardown and then
  // reported the account erased with the sign-in still working.
  const userId = '44444444-4444-4444-8444-444444444444';
  const originProgress = [];
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test', user_metadata: { full_name: 'Alex' } });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/admin/users/${userId}`) {
      return new Response(JSON.stringify({ message: 'service unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json' } });
    }
    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (table === 'rpc/open_account_deletion_request') {
        const sent = JSON.parse(call.init.body);
        return jsonResponse([{ id: 'delete_req_4444', status: 'requested', requested_at: sent.p_at, teardown_by: sent.p_teardown_by }]);
      }
      if (table === 'rpc/record_account_deletion_origin_progress') {
        originProgress.push(JSON.parse(call.init.body));
        return jsonResponse(true);
      }
      if (requestMethod(call) === 'GET') return jsonResponse([]);
      return emptyResponse();
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(accountDeleteRequest({ authorization: 'Bearer user_access_token' }), LIVE_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 503);
    assertBodyIsSafe(responseText);
    const body = JSON.parse(responseText);
    assert.equal(body.deletionRequest.id, 'delete_req_4444', 'the durable row survives so the cron can finish it');
    // The connector sweep was still recorded; the auth phase was not, because
    // it did not happen.
    assert.equal(originProgress.length, 1);
    assert.equal(originProgress[0].p_connections_swept, true);
    assert.notEqual(originProgress[0].p_auth_deleted, true);
  });
});

test('telegram connect-code endpoint verifies the app user, scaffolds product rows, and stores only a hash', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer user_access_token');
      return jsonResponse({
        id: userId,
        email: 'alex@example.test',
        user_metadata: { full_name: 'Alex' },
      });
    }

    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (['profiles', 'subscriptions', 'hermes_instances', 'usage_quotas'].includes(table)) {
        assert.equal(requestMethod(call), 'POST');
        assert.match(headerValue(call.init.headers, 'prefer') ?? '', /resolution=ignore-duplicates/);
        const inserted = JSON.parse(call.init.body);
        if (table === 'profiles') {
          assert.equal(url.searchParams.get('on_conflict'), 'id');
          assert.equal(inserted.id, userId);
          assert.equal(inserted.email, 'alex@example.test');
          assert.equal(inserted.full_name, 'Alex');
        } else {
          assert.equal(url.searchParams.get('on_conflict'), 'user_id');
          assert.equal(inserted.user_id, userId);
        }
        return emptyResponse();
      }

      if (table === 'gateway_connect_codes') {
        assert.equal(requestMethod(call), 'POST');
        const inserted = JSON.parse(call.init.body);
        assert.equal(inserted.user_id, userId);
        assert.equal(inserted.gateway_id, 'telegram');
        assert.match(inserted.code_hash, /^[a-f0-9]{64}$/);
        assert.equal('code' in inserted, false);
        assert.equal('startParameter' in inserted, false);
        assert.match(inserted.expires_at, /^\d{4}-\d{2}-\d{2}T/);
        return jsonResponse([{ id: '22222222-2222-4222-8222-222222222222' }], 201);
      }
    }

    throw new Error(`unexpected fetch: ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramConnectCodeRequest({
      authorization: 'Bearer user_access_token',
    }), {
      ...LIVE_ENV,
      SIDEKICK_TELEGRAM_BOT_USERNAME: 'CoworkerAI180554Bot',
    });
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    assert.equal(response.status, 200);
    assert.equal(body.gatewayId, 'telegram');
    assert.match(body.code, /^TG [A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.match(body.startParameter, /^TG[A-Z2-9]{6}$/);
    assert.equal(body.botUsername, 'CoworkerAI180554Bot');
    assert.match(body.deepLink, /^https:\/\/t\.me\/CoworkerAI180554Bot\?start=TG[A-Z2-9]{6}$/);
    assert.equal(responseText.includes(userId), false);
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 6);
  });
});

test('messaging disconnect endpoint requires app authentication without external calls', async () => {
  await withMockedFetch(() => {
    throw new Error('messaging disconnect must not call fetch without a bearer token');
  }, async (calls) => {
    const response = await worker.fetch(new Request(MESSAGING_DISCONNECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'telegram' }),
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: 'unauthenticated' });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('messaging disconnect endpoint rejects unsupported provider ids', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    throw new Error(`invalid provider must not call Supabase RPC: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(MESSAGING_DISCONNECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_access_token' },
      body: JSON.stringify({ providerId: 'imessage' }),
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(responseText), { error: 'unsupported_messenger' });
  });
});

test('messaging disconnect endpoint calls disconnect RPC and returns disconnected when a row was active', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/rest/v1/rpc/disconnect_gateway_connection`) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.p_user_id, userId);
      assert.equal(body.p_gateway_id, 'telegram');
      return jsonResponse([{ gateway_id: 'telegram', status: 'disconnected' }]);
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(MESSAGING_DISCONNECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_access_token' },
      body: JSON.stringify({ providerId: 'telegram' }),
    }), LIVE_ENV);
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.providerId, 'telegram');
    assert.equal(body.kind, 'disconnected');
    assert.match(body.publicMessage, /Telegram is disconnected/);
    // The disconnect response intentionally contains `providerId` as a public
    // API field for the mobile UI; that legitimately contains the substring
    // "provider", so the generic assertBodyIsSafe regex doesn't apply here.
    assert.doesNotMatch(responseText, /supabase|openrouter|cloudflare|service[-_ ]?role|api[-_ ]?key|runtime|container|hermes/i);
  });
});

test('messaging disconnect endpoint returns already_disconnected when no row was active', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/rest/v1/rpc/disconnect_gateway_connection`) {
      return jsonResponse([]);
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(MESSAGING_DISCONNECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_access_token' },
      body: JSON.stringify({ providerId: 'telegram' }),
    }), LIVE_ENV);
    const body = JSON.parse(await response.text());

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.providerId, null);
    assert.equal(body.kind, 'already_disconnected');
    assert.match(body.publicMessage, /already disconnected/);
  });
});

const COWORKER_UPDATE_URL = 'https://worker.sidekick.test/api/coworker/update';

test('coworker update endpoint requires app authentication without external calls', async () => {
  await withMockedFetch(() => {
    throw new Error('coworker update must not call fetch without a bearer token');
  }, async (calls) => {
    const response = await worker.fetch(new Request(COWORKER_UPDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: 'unauthenticated' });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('coworker update endpoint queues a re-image when the user has a live coworker', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/rest/v1/rpc/request_coworker_reimage`) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.p_user_id, userId);
      return jsonResponse([{ queued: true }]);
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(COWORKER_UPDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_access_token' },
    }), LIVE_ENV);
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'update_queued');
    assert.match(body.publicMessage, /Update started/);
    assertBodyIsSafe(responseText);
  });
});

// The two tests that stood here pinned the GitHub workflow_dispatch: its URL,
// its ref and its provision-once input. The dispatch was removed on
// 2026-09-20 along with the runners it started, so what needs pinning now is
// its ABSENCE, which apple-iap-instant-provisioning.test.mjs does.

test('coworker update endpoint returns no_live_coworker when nothing is online', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/rest/v1/rpc/request_coworker_reimage`) {
      return jsonResponse([{ queued: false }]);
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(COWORKER_UPDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_access_token' },
    }), LIVE_ENV);
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.kind, 'no_live_coworker');
    assertBodyIsSafe(responseText);
  });
});

test('worker health payload is product-safe and does not expose model/provider internals', () => {
  const payload = createHealthPayload();

  assert.equal(payload.ok, true);
  assert.equal(payload.engine, 'sidekick-worker');
  assert.equal('model' in payload, false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes('openrouter'), false);
});

test('worker serves Stripe checkout route at the mobile API base and fails closed without auth', async () => {
  await withMockedFetch(() => {
    throw new Error('unauthenticated checkout must not call Supabase or Stripe');
  }, async (calls) => {
    const response = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        tierId: 'studio',
        successUrl: 'https://worker.sidekick.test/checkout/success',
        cancelUrl: 'https://worker.sidekick.test/checkout/cancel',
      }),
    }), STRIPE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: 'unauthenticated' });
    assert.equal(calls.length, 0);
    assertBodyIsSafe(responseText);
    assert.equal(responseText.includes(STRIPE_ENV.STRIPE_SECRET_KEY), false);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('worker checkout identifies plan changes instead of creating duplicate subscriptions', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${STRIPE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }

    if (call.url.includes('/rest/v1/subscriptions')) {
      assert.equal(requestMethod(call), 'GET');
      assert.match(call.url, /tier_id/);
      return jsonResponse({
        status: 'active',
        tier_id: 'studio',
        stripe_customer_id: 'cus_existing_worker',
        stripe_subscription_id: 'sub_existing_worker',
        price_id: 'price_current_studio',
      });
    }

    throw new Error(`plan-change checkout must not call Stripe: ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer user_access_token',
      },
      body: JSON.stringify({
        tierId: 'pro-office',
        successUrl: 'https://worker.sidekick.test/checkout/success',
        cancelUrl: 'https://worker.sidekick.test/checkout/cancel',
      }),
    }), STRIPE_ENV);

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'subscription_change_required',
      currentTierId: 'studio',
      requestedTierId: 'pro-office',
    });
    assert.equal(calls.length, 2);
  });
});

test('worker billing portal deep-links active subscribers into a target plan change', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch((call) => {
    if (call.url === `${STRIPE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }

    if (call.url.includes('/rest/v1/subscriptions')) {
      assert.equal(requestMethod(call), 'GET');
      return jsonResponse({
        status: 'active',
        tier_id: 'studio',
        stripe_customer_id: 'cus_existing_worker',
        stripe_subscription_id: 'sub_existing_worker',
        price_id: 'price_current_studio',
      });
    }

    if (call.url.startsWith('https://api.stripe.com/v1/prices')) {
      assert.equal(requestMethod(call), 'GET');
      assert.match(decodeURIComponent(call.url), /lookup_keys/);
      assert.match(decodeURIComponent(call.url), /sidekick_pro_office_monthly/);
      return jsonResponse({
        data: [{
          id: 'price_worker_pro',
          lookup_key: 'sidekick_pro_office_monthly',
          active: true,
        }],
      });
    }

    if (call.url.startsWith('https://api.stripe.com/v1/subscriptions/sub_existing_worker')) {
      assert.equal(requestMethod(call), 'GET');
      assert.match(decodeURIComponent(call.url), /items\.data\.price/);
      return jsonResponse({
        id: 'sub_existing_worker',
        status: 'active', customer: 'cus_existing_worker',
        items: {
          data: [{
            id: 'si_worker_studio',
            price: { id: 'price_current_studio' },
            quantity: 1,
          }],
        },
      });
    }

    if (call.url === 'https://api.stripe.com/v1/billing_portal/configurations/bpc_Pro') {
      assert.equal(requestMethod(call), 'GET');
      return jsonResponse(portalConfiguration('bpc_Pro', 'price_worker_pro'));
    }
    if (call.url === 'https://api.stripe.com/v1/billing_portal/sessions') {
      assert.equal(requestMethod(call), 'POST');
      const body = new URLSearchParams(String(call.init.body ?? ''));
      assert.equal(body.get('customer'), 'cus_existing_worker');
      assert.equal(body.get('configuration'), 'bpc_Pro');
      assert.equal(body.get('return_url'), 'https://worker.sidekick.test/account/billing');
      assert.equal(body.get('flow_data[type]'), 'subscription_update_confirm');
      assert.equal(body.get('flow_data[after_completion][type]'), 'redirect');
      assert.equal(body.get('flow_data[after_completion][redirect][return_url]'), 'https://worker.sidekick.test/account/billing');
      assert.equal(body.get('flow_data[subscription_update_confirm][subscription]'), 'sub_existing_worker');
      assert.equal(body.get('flow_data[subscription_update_confirm][items][0][id]'), 'si_worker_studio');
      assert.equal(body.get('flow_data[subscription_update_confirm][items][0][price]'), 'price_worker_pro');
      assert.equal(body.get('flow_data[subscription_update_confirm][items][0][quantity]'), '1');
      return jsonResponse({
        id: 'bps_worker_upgrade',
        url: 'https://billing.stripe.com/p/session/bps_worker_upgrade',
      });
    }

    throw new Error(`unexpected billing portal fetch: ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/portal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer user_access_token',
      },
      body: JSON.stringify({
        returnUrl: 'https://worker.sidekick.test/account/billing',
        targetTierId: 'pro-office',
      }),
    }), STRIPE_ENV);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: 'https://billing.stripe.com/p/session/bps_worker_upgrade' });
  });
});

test('worker Stripe routes are POST-only and webhook signature-gated before external calls', async () => {
  await withMockedFetch(() => {
    throw new Error('method/signature failures must not call Supabase or Stripe');
  }, async (calls) => {
    const checkoutGet = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/checkout'), STRIPE_ENV);
    assert.equal(checkoutGet.status, 405);
    assert.deepEqual(await checkoutGet.json(), { error: 'POST required' });

    const portalGet = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/portal'), STRIPE_ENV);
    assert.equal(portalGet.status, 405);
    assert.deepEqual(await portalGet.json(), { error: 'POST required' });

    const webhookMissingSignature = await worker.fetch(new Request('https://worker.sidekick.test/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), STRIPE_ENV);
    assert.equal(webhookMissingSignature.status, 400);
    assert.deepEqual(await webhookMissingSignature.json(), { error: 'missing_stripe_signature' });
    assert.equal(calls.length, 0);
  });
});

test('worker serves checkout and billing landing pages for Stripe redirects', async () => {
  const success = await worker.fetch(new Request('https://worker.sidekick.test/checkout/success'), STRIPE_ENV);
  const successHtml = await success.text();
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(success.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  assert.match(success.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);
  // A return URL alone proves neither payment nor an active subscription.
  assert.match(successHtml, /Return to Delegent AI/);
  assert.doesNotMatch(successHtml, /Your plan is active|Payment received/);
  assert.match(successHtml, /Delegent AI/);
  assert.match(successHtml, /sidekick:\/\/checkout\/success/);
  assert.match(successHtml, /Open Delegent AI/);
  assert.equal(successHtml.includes(STRIPE_ENV.STRIPE_SECRET_KEY), false);

  const cancel = await worker.fetch(new Request('https://worker.sidekick.test/checkout/cancel'), STRIPE_ENV);
  const cancelHtml = await cancel.text();
  assert.equal(cancel.status, 200);
  assert.equal(cancel.headers.get('content-type'), 'text/html; charset=utf-8');
  // 2026-05-15 copy pass: cancel page reads "No charge. Checkout cancelled".
  assert.match(cancelHtml, /No charge. Checkout cancelled/);
  assert.match(cancelHtml, /Nothing was billed/);
  assert.match(cancelHtml, /sidekick:\/\/checkout\/cancel/);

  const billing = await worker.fetch(new Request('https://worker.sidekick.test/account/billing'), STRIPE_ENV);
  const billingHtml = await billing.text();
  assert.equal(billing.status, 200);
  assert.equal(billing.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(billingHtml, /Billing updated/);
  assert.match(billingHtml, /sidekick:\/\/billing\/return/);
  assert.equal(billingHtml.includes(STRIPE_ENV.STRIPE_SECRET_KEY), false);
});

test('worker runner files route requires app auth before private lookups or runner calls', async () => {
  await withMockedFetch(() => {
    throw new Error('unauthenticated runner files request must not call external services');
  }, async (calls) => {
    const response = await worker.fetch(new Request(RUNNER_FILES_URL), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const responseText = await response.text();

    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(responseText), { error: 'unauthenticated' });
    assert.equal(calls.length, 0);
    assert.equal(responseText.includes('file_link_signing_secret'), false);
    assert.equal(responseText.includes(LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  });
});

test('worker runner files route reassures canceled users when retained workspace files are paused', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const retentionUntil = '2099-06-22T09:00:00.000Z';
  const tableRequests = [];

  await withMockedFetch(async (call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer app_access_token');
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }

    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      tableRequests.push(url.pathname.replace('/rest/v1/', ''));
      assert.equal(requestMethod(call), 'GET');
      assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);

      if (url.pathname.endsWith('/hermes_instances')) {
        assert.match(url.searchParams.get('select') ?? '', /status/);
        assert.match(url.searchParams.get('select') ?? '', /volume_retention_until/);
        return jsonResponse([{
          status: 'sleeping',
          suspended_at: '2026-05-22T09:00:00.000Z',
          volume_retention_until: retentionUntil,
          deleted_at: null,
        }]);
      }

      if (url.pathname.endsWith('/hermes_instance_private')) {
        assert.match(url.searchParams.get('select') ?? '', /runner_base_url/);
        assert.match(url.searchParams.get('select') ?? '', /runner_shared_secret/);
        return jsonResponse([{ runner_base_url: null, runner_shared_secret: 'runner_private_file_secret' }]);
      }
    }

    throw new Error(`retained workspace files request must not call runner services: ${requestMethod(call)} ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      headers: { authorization: 'Bearer app_access_token' },
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const responseText = await response.text();
    const payload = JSON.parse(responseText);

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.storageStatus, 'not_ready');
    assert.deepEqual(payload.files, []);
    assert.equal(payload.truncated, false);
    assert.equal(payload.retentionUntil, retentionUntil);
    assert.match(payload.publicMessage, /files stay saved/i);
    assert.match(payload.publicMessage, /resume/i);
    // 2026-09-03: the binding read now checks the workspace row alongside the
    // private row (in parallel), and a sleeping row ends the lookup before the
    // private row is even parsed; the retained-state read follows.
    assert.deepEqual(tableRequests, ['hermes_instances', 'hermes_instance_private', 'hermes_instances']);
    assertBodyIsSafe(responseText);
  });
});

test('worker runner files route signs private runner file list and download requests', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const fileId = 'file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const privateRunnerSecret = 'runner_private_file_secret';
  const runnerRequests = [];

  await withMockedFetch(async (call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer app_access_token');
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }

    // 2026-09-03: the binding is gated on the workspace row being 'ready'
    // (files used to wake a paused user's stopped machine).
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([{ status: 'ready', deleted_at: null }]);

    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
      const parsed = new URL(call.url);
      assert.equal(parsed.searchParams.get('user_id'), `eq.${userId}`);
      // provider + fly_app_name joined the select so the files path can apply
      // the same host gate the chat dispatch path does (Fable 5 pickup 7).
      assert.equal(parsed.searchParams.get('select'), 'runner_base_url,runner_shared_secret,provider,fly_app_name');
      return jsonResponse([{
        runner_base_url: 'https://runner.sidekick.dev',
        runner_shared_secret: privateRunnerSecret,
      }]);
    }

    if (call.url === 'https://runner.sidekick.dev/files') {
      assert.equal(requestMethod(call), 'GET');
      runnerRequests.push(call);
      const timestamp = Number(headerValue(call.init.headers, 'x-sidekick-runner-timestamp'));
      const token = headerValue(call.init.headers, 'x-sidekick-runner-token');
      assert.equal(headerValue(call.init.headers, 'x-sidekick-user-id'), userId);
      assert.equal(await verifyRunnerTokenV1(privateRunnerSecret, userId, timestamp, token), true);
      return jsonResponse({
        ok: true,
        truncated: false,
        files: [
          {
            id: fileId,
            name: 'test file.txt',
            relativeName: 'test file.txt',
            sizeBytes: 19,
            modifiedAt: 1770000100,
            mimeType: 'text/plain',
            downloadable: true,
            path: '/data/hermes/workspace/test file.txt',
          },
          {
            id: 'file_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            name: 'large research pack.zip',
            relativeName: 'documents/large research pack.zip',
            sizeBytes: 30 * 1024 * 1024,
            modifiedAt: 1770000200,
            mimeType: 'application/zip',
            downloadable: true,
            path: '/data/hermes/workspace/documents/large research pack.zip',
          },
          {
            id: 'not-safe',
            name: '.env',
            sizeBytes: 10,
            modifiedAt: 1770000100,
            mimeType: 'text/plain',
          },
        ],
      });
    }

    if (call.url === `https://runner.sidekick.dev/files/${fileId}`) {
      assert.equal(requestMethod(call), 'GET');
      runnerRequests.push(call);
      const timestamp = Number(headerValue(call.init.headers, 'x-sidekick-runner-timestamp'));
      const token = headerValue(call.init.headers, 'x-sidekick-runner-token');
      assert.equal(await verifyRunnerTokenV1(privateRunnerSecret, userId, timestamp, token), true);
      if (headerValue(call.init.headers, 'range') === 'bytes=0-7') {
        return new Response('hello fr', {
          status: 206,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="test file.txt"',
            'content-length': '8',
            'content-range': 'bytes 0-7/19',
            'cache-control': 'public, max-age=86400',
          },
        });
      }
      return new Response('hello from telegram', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="test file.txt"',
          'content-length': '19',
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    throw new Error(`unexpected runner files fetch: ${requestMethod(call)} ${call.url}`);
  }, async () => {
    const listResponse = await worker.fetch(new Request(RUNNER_FILES_URL, {
      headers: { authorization: 'Bearer app_access_token' },
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const listText = await listResponse.text();
    const listPayload = JSON.parse(listText);

    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.storageStatus, 'ready');
    assert.equal(listPayload.files.length, 2, 'safe oversized files must stay visible in Files instead of disappearing');
    assert.deepEqual({
      id: listPayload.files[0].id,
      name: listPayload.files[0].name,
      relativeName: listPayload.files[0].relativeName,
      sizeBytes: listPayload.files[0].sizeBytes,
      mimeType: listPayload.files[0].mimeType,
      downloadable: listPayload.files[0].downloadable,
    }, {
      id: fileId,
      name: 'test file.txt',
      relativeName: 'test file.txt',
      sizeBytes: 19,
      mimeType: 'text/plain',
      downloadable: true,
    });
    assert.match(listPayload.files[0].downloadUrl, /^https:\/\/worker\.sidekick\.test\/api\/files\/runner\/file_[a-f0-9]{32}\?token=v1\./);
    assert.deepEqual({
      id: listPayload.files[1].id,
      name: listPayload.files[1].name,
      relativeName: listPayload.files[1].relativeName,
      sizeBytes: listPayload.files[1].sizeBytes,
      mimeType: listPayload.files[1].mimeType,
      downloadable: listPayload.files[1].downloadable,
    }, {
      id: 'file_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'large research pack.zip',
      relativeName: 'documents/large research pack.zip',
      sizeBytes: 30 * 1024 * 1024,
      mimeType: 'application/zip',
      downloadable: false,
    });
    assert.match(listPayload.files[1].downloadUrl, /^https:\/\/worker\.sidekick\.test\/api\/files\/runner\/file_b{32}\?token=v1\./);
    assert.equal(listText.includes('file_link_signing_secret'), false);
    assert.equal(listText.includes(privateRunnerSecret), false);
    assert.equal(listText.includes('/data/hermes'), false);

    const downloadResponse = await worker.fetch(new Request(listPayload.files[0].downloadUrl), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const downloadText = await downloadResponse.text();

    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadText, 'hello from telegram');
    // Full "Download to phone" forces octet-stream so the browser SAVES it to
    // Downloads instead of rendering it inline (Alex, 2026-07-18). The range
    // preview below keeps the true text/plain type.
    assert.equal(downloadResponse.headers.get('content-type'), 'application/octet-stream');
    assert.equal(downloadResponse.headers.get('content-disposition'), 'attachment; filename="test file.txt"');
    assert.equal(downloadResponse.headers.get('cache-control'), 'private, no-store');

    const previewResponse = await worker.fetch(new Request(listPayload.files[0].downloadUrl, {
      headers: { range: 'bytes=0-7' },
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const previewText = await previewResponse.text();

    assert.equal(previewResponse.status, 206);
    assert.equal(previewText, 'hello fr');
    // Range requests (the inline preview) keep the true content-type so the
    // preview still works; only full downloads are forced to octet-stream.
    assert.equal(previewResponse.headers.get('content-type'), 'text/plain');
    assert.equal(previewResponse.headers.get('content-range'), 'bytes 0-7/19');
    assert.equal(previewResponse.headers.get('accept-ranges'), 'bytes');
    assert.equal(previewResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(runnerRequests.length, 3);
    assert.equal(headerValue(runnerRequests[2].init.headers, 'range'), 'bytes=0-7');
  });
});

test('worker runner files upload signs the runner POST and returns a downloadable record', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const fileId = 'file_cccccccccccccccccccccccccccccccc';
  const privateRunnerSecret = 'runner_private_file_secret';
  const contentBase64 = Buffer.from('hello upload from mobile').toString('base64');
  const runnerRequests = [];

  await withMockedFetch(async (call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'authorization'), 'Bearer app_access_token');
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }

    // 2026-09-03: the binding is gated on the workspace row being 'ready'
    // (files used to wake a paused user's stopped machine).
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([{ status: 'ready', deleted_at: null }]);

    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      assert.equal(requestMethod(call), 'GET');
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
      const parsed = new URL(call.url);
      assert.equal(parsed.searchParams.get('user_id'), `eq.${userId}`);
      // provider + fly_app_name joined the select so the files path can apply
      // the same host gate the chat dispatch path does (Fable 5 pickup 7).
      assert.equal(parsed.searchParams.get('select'), 'runner_base_url,runner_shared_secret,provider,fly_app_name');
      return jsonResponse([{
        runner_base_url: 'https://runner.sidekick.dev',
        runner_shared_secret: privateRunnerSecret,
      }]);
    }

    if (call.url === 'https://runner.sidekick.dev/files') {
      assert.equal(requestMethod(call), 'POST');
      runnerRequests.push(call);
      const timestamp = Number(headerValue(call.init.headers, 'x-sidekick-runner-timestamp'));
      const token = headerValue(call.init.headers, 'x-sidekick-runner-token');
      assert.equal(headerValue(call.init.headers, 'x-sidekick-user-id'), userId);
      assert.equal(headerValue(call.init.headers, 'content-type'), 'application/json');
      assert.equal(await verifyRunnerTokenV1(privateRunnerSecret, userId, timestamp, token), true);

      const forwarded = JSON.parse(call.init.body);
      assert.equal(forwarded.name, 'notes.txt');
      assert.equal(forwarded.mimeType, 'text/plain');
      assert.equal(forwarded.contentBase64, contentBase64);

      return jsonResponse({
        ok: true,
        file: {
          id: fileId,
          name: 'notes.txt',
          relativeName: 'notes.txt',
          sizeBytes: 24,
          modifiedAt: 1770000300,
          mimeType: 'text/plain',
          downloadable: true,
          path: '/data/hermes/workspace/notes.txt',
        },
      });
    }

    throw new Error(`unexpected runner files upload fetch: ${requestMethod(call)} ${call.url}`);
  }, async () => {
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer app_access_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain', contentBase64 }),
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const responseText = await response.text();
    const payload = JSON.parse(responseText);

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.file.id, fileId);
    assert.equal(payload.file.name, 'notes.txt');
    assert.equal(payload.file.relativeName, 'notes.txt');
    assert.equal(payload.file.sizeBytes, 24);
    assert.equal(payload.file.mimeType, 'text/plain');
    assert.match(payload.file.downloadUrl, /^https:\/\/worker\.sidekick\.test\/api\/files\/runner\/file_[a-f0-9]{32}\?token=v1\./);
    assert.equal(typeof payload.file.downloadToken, 'string');
    assert.match(payload.file.downloadToken, /^v1\./);
    assert.equal(runnerRequests.length, 1);
    assert.equal(responseText.includes('file_link_signing_secret'), false);
    assert.equal(responseText.includes(privateRunnerSecret), false);
    assert.equal(responseText.includes('/data/hermes'), false);
    assertBodyIsSafe(responseText);
  });
});

test('worker runner files upload requires app auth before any fetch', async () => {
  await withMockedFetch(() => {
    throw new Error('unauthenticated runner files upload must not call external services');
  }, async (calls) => {
    const missingBearer = await worker.fetch(new Request(RUNNER_FILES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'notes.txt', contentBase64: Buffer.from('hello').toString('base64') }),
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const missingBearerText = await missingBearer.text();

    assert.equal(missingBearer.status, 401);
    assert.deepEqual(JSON.parse(missingBearerText), { error: 'unauthenticated' });
    assert.equal(calls.length, 0);
    assert.equal(missingBearerText.includes('file_link_signing_secret'), false);
    assert.equal(missingBearerText.includes(LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  });
});

test('worker runner files upload rejects oversized payloads before any runner fetch', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  await withMockedFetch(async (call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'alex@example.test' });
    }
    throw new Error(`oversized upload must not call runner services: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    // 26 MB of decoded bytes -> base64 string is ~34.7 MB, comfortably over the
    // 25 MB cap. We only need the encoded length to exceed the cap; the bytes
    // themselves never reach the runner.
    const oversizedBase64 = 'A'.repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3));
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer app_access_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'huge.bin', mimeType: 'application/octet-stream', contentBase64: oversizedBase64 }),
    }), {
      ...LIVE_ENV,
      SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
    });
    const responseText = await response.text();

    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(responseText), { error: 'file_too_large' });
    // Only the Supabase auth lookup may have fired — never the runner POST.
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/files'), false);
  });
});

test('worker proxy is fail-closed until auth, quota, and required secrets are explicitly ready', async () => {
  assert.equal(isProxyLive({ SIDEKICK_WORKER_PROXY_ENABLED: 'true' }), false);
  assert.equal(isProxyLive({
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  }), true);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  try {
    const response = await worker.fetch(new Request('https://worker.sidekick.test/v1/chat/completions', { method: 'POST' }), {
      SIDEKICK_WORKER_PROXY_ENABLED: 'true',
      SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    });
    const responseText = await response.text();
    assert.equal(response.status, 501);
    assert.deepEqual(JSON.parse(responseText), { error: 'Delegent AI is not available yet.' });
    assertBodyIsSafe(responseText);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telegram webhook fails closed when dry-run flag is missing and never fetches externally', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch when disabled');
  }, async (calls) => {
    const response = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 1101,
      messageId: 2201,
      chatId: 3301,
      text: 'Draft the agenda for tomorrow.',
    })), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 501);
    assert.deepEqual(JSON.parse(responseText), { error: 'Telegram handoff is not available yet.' });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('telegram webhook dry-run turns a private text message into a safe task handoff without external fetch', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch for task handoff');
  }, async (calls) => {
    const update = telegramTextUpdate({
      updateId: 1102,
      messageId: 2202,
      chatId: 3302,
      text: 'Book train tickets for Thursday and draft a short itinerary.',
    });
    const response = await worker.fetch(telegramWebhookRequest(update), enabledTelegramDryRunEnv({
      SIDEKICK_TELEGRAM_DRY_RUN_USER_ID: 'user_tg_123',
    }));
    const responseText = await response.text();

    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      mode: 'dry_run',
      gatewayId: 'telegram',
      kind: 'task_handoff',
      publicReply: "Got it. I'm on it.",
      task: {
        title: 'Book train tickets for Thursday and draft a short itinerary.',
        receivedAt: new Date(update.message.date * 1000).toISOString(),
      },
    });
    assert.equal(responseText.includes('user_tg_123'), false);
    assert.equal(responseText.includes('"instruction"'), false);
    assert.equal(responseText.includes('"sourceEventId"'), false);
    assert.equal(responseText.includes('"message_id"'), false);
    assert.equal(responseText.includes('"idempotencyKey"'), false);
    assert.equal(responseText.includes('telegram:1102:2202'), false);
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('telegram webhook dry-run recognizes a start connect code with no linked user', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch for connect code');
  }, async (calls) => {
    const response = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 1103,
      messageId: 2203,
      chatId: 3303,
      text: '/start TG ABC-123',
    })), enabledTelegramDryRunEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      mode: 'dry_run',
      gatewayId: 'telegram',
      kind: 'connect_code',
      publicReply: 'Almost connected. Finish the link in the Delegent AI app.',
    });
    assert.equal(responseText.includes('TGABC123'), false);
    assert.equal(responseText.includes('telegram:1103:2203:connect'), false);
    assert.equal(responseText.includes('"idempotencyKey"'), false);
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('telegram webhook dry-run maps needs_connection and ignored outcomes to safe route responses', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch for safe resolver outcomes');
  }, async (calls) => {
    const needsConnectionResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 1104,
      messageId: 2204,
      chatId: 3304,
      text: 'Please summarize the notes I send next.',
    })), enabledTelegramDryRunEnv());
    const needsConnectionText = await needsConnectionResponse.text();

    assert.equal(needsConnectionResponse.status, 200);
    assert.deepEqual(JSON.parse(needsConnectionText), {
      ok: false,
      mode: 'dry_run',
      gatewayId: 'telegram',
      kind: 'needs_connection',
      publicReply: 'Connect Telegram in the Delegent AI app first, then resend this task.',
    });
    assert.equal(needsConnectionText.includes('"idempotencyKey"'), false);
    assertBodyIsSafe(needsConnectionText);

    const ignoredResponse = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
      updateId: 1105,
      messageId: 2205,
      chatId: 3305,
      chatType: 'group',
      text: 'This group chat should be ignored.',
    })), enabledTelegramDryRunEnv({ SIDEKICK_TELEGRAM_DRY_RUN_USER_ID: 'user_tg_123' }));
    const ignoredText = await ignoredResponse.text();

    assert.equal(ignoredResponse.status, 202);
    assert.deepEqual(JSON.parse(ignoredText), {
      ok: true,
      mode: 'dry_run',
      gatewayId: 'telegram',
      kind: 'ignored',
      reason: 'unsupported_chat',
    });
    assert.equal(ignoredText.includes('This group chat should be ignored.'), false);
    assertBodyIsSafe(ignoredText);
    assert.equal(calls.length, 0);
  });
});

test('telegram webhook dry-run returns safe errors for invalid JSON and non-POST requests without external fetch', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch for invalid requests');
  }, async (calls) => {
    const invalidJsonResponse = await worker.fetch(new Request(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    }), enabledTelegramDryRunEnv());
    const invalidJsonText = await invalidJsonResponse.text();

    assert.equal(invalidJsonResponse.status, 400);
    assert.deepEqual(JSON.parse(invalidJsonText), { error: 'Invalid Telegram update JSON.' });
    assertBodyIsSafe(invalidJsonText);

    const methodResponse = await worker.fetch(new Request(TELEGRAM_WEBHOOK_URL, { method: 'GET' }), enabledTelegramDryRunEnv());
    const methodText = await methodResponse.text();

    assert.equal(methodResponse.status, 405);
    assert.deepEqual(JSON.parse(methodText), { error: 'POST required' });
    assertBodyIsSafe(methodText);
    assert.equal(calls.length, 0);
  });
});

test('telegram webhook dry-run returns safe error for valid JSON malformed Telegram updates without external fetch', async () => {
  await withMockedFetch(() => {
    throw new Error('telegram webhook dry-run must not call fetch for malformed Telegram updates');
  }, async (calls) => {
    let response;
    await assert.doesNotReject(async () => {
      response = await worker.fetch(telegramWebhookRequest(telegramTextUpdate({
        updateId: 1106,
        messageId: 2206,
        chatId: 3306,
        text: 'This valid JSON update has an invalid Telegram timestamp.',
        date: 1e20,
      })), enabledTelegramDryRunEnv({
        SIDEKICK_TELEGRAM_DRY_RUN_USER_ID: 'user_tg_123',
      }));
    });
    const responseText = await response.text();

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(responseText), { error: 'Invalid Telegram update.' });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 0);
  });
});

test('telegram live webhook rejects unbound chats before creating tasks or dispatching to runners', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4101,
        replyToMessageId: 3101,
        text: 'Connect Telegram in the Delegent AI app first, then resend this task.',
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected Telegram live fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2101,
      messageId: 3101,
      chatId: 4101,
      text: 'Please summarize this note.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'needs_connection',
      publicReply: 'Connect Telegram in the Delegent AI app first, then resend this task.',
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.length, 2);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assert.equal(calls.some((call) => call.url.includes('runner.sidekick.dev')), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/task_runs')), false);
  });
});

test('telegram live webhook binds a connect code to the posting chat without exposing code or user IDs', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connect_codes')) {
      if (requestMethod(call) === 'GET') return jsonResponse([{ id: 'code_row_1', user_id: 'user_bound' }]);
      if (requestMethod(call) === 'PATCH') return jsonResponse([{ id: 'code_row_1' }]);
    }
    if (call.url.includes('/rest/v1/gateway_connections')) {
      if (requestMethod(call) === 'GET') return jsonResponse([]);
    }
    if (call.url.includes('/rest/v1/rpc/set_active_gateway_connection')) {
      assert.equal(requestMethod(call), 'POST');
      assert.deepEqual(JSON.parse(call.init.body), {
        p_user_id: 'user_bound',
        p_gateway_id: 'telegram',
        p_source_conversation_id: 'telegram:chat:4102',
        p_source_event_id: 'telegram:update:2102',
      });
      return jsonResponse([{ connection_id: 'connection_1', gateway_id: 'telegram', status: 'connected' }]);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4102,
        replyToMessageId: 3102,
        text: 'Telegram is connected to Delegent AI. Send a task here whenever you are ready.',
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected Telegram binding fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2102,
      messageId: 3102,
      chatId: 4102,
      text: '/start TG ABC-123',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      gatewayId: 'telegram',
      kind: 'connected',
      publicReply: 'Telegram is connected to Delegent AI. Send a task here whenever you are ready.',
    });
    assert.equal(responseText.includes('TGABC123'), false);
    assert.equal(responseText.includes('user_bound'), false);
    assert.equal(responseText.includes('4102'), false);
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => requestMethod(call) === 'POST' && call.url.includes('/rest/v1/gateway_connections')), false);
    assert.equal(calls.some((call) => requestMethod(call) === 'POST' && call.url.includes('/rest/v1/rpc/set_active_gateway_connection')), true);
    assert.equal(calls.some((call) => requestMethod(call) === 'PATCH' && call.url.includes('/rest/v1/gateway_connect_codes')), true);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook refuses to rebind a chat already connected to a different user', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connect_codes') && requestMethod(call) === 'GET') {
      return jsonResponse([{ id: 'code_row_2', user_id: 'new_user' }]);
    }
    if (call.url.includes('/rest/v1/gateway_connections') && requestMethod(call) === 'GET') {
      return jsonResponse([{ id: 'connection_existing', user_id: 'existing_user' }]);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4103,
        replyToMessageId: 3103,
        text: "This chat is already linked. Send a task whenever you're ready.",
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected Telegram rebind fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2103,
      messageId: 3103,
      chatId: 4103,
      text: '/start TG DEF-456',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'already_connected',
      publicReply: "This chat is already linked. Send a task whenever you're ready.",
    });
    assert.equal(responseText.includes('existing_user'), false);
    assert.equal(responseText.includes('new_user'), false);
    assert.equal(calls.some((call) => requestMethod(call) !== 'GET' && call.url !== TELEGRAM_SEND_MESSAGE_URL), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assertBodyIsSafe(responseText);
  });
});

test('telegram live webhook treats a same-user reconnect code as connected without rewriting the existing chat', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connect_codes')) {
      if (requestMethod(call) === 'GET') return jsonResponse([{ id: 'code_row_same_user', user_id: 'same_user' }]);
      if (requestMethod(call) === 'PATCH') {
        const body = JSON.parse(call.init.body);
        assert.equal(typeof body.consumed_at, 'string');
        return jsonResponse([{ id: 'code_row_same_user' }]);
      }
    }
    if (call.url.includes('/rest/v1/gateway_connections') && requestMethod(call) === 'GET') {
      return jsonResponse([{ id: 'connection_same_user', user_id: 'same_user' }]);
    }
    if (call.url.includes('/rest/v1/rpc/set_active_gateway_connection')) {
      throw new Error('same-user reconnect should not rewrite the existing Telegram connection');
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4114,
        replyToMessageId: 3114,
        text: 'Telegram is connected to Delegent AI. Send a task here whenever you are ready.',
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected Telegram same-user reconnect fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2114,
      messageId: 3114,
      chatId: 4114,
      text: '/start TG GHI-789',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      gatewayId: 'telegram',
      kind: 'connected',
      publicReply: 'Telegram is connected to Delegent AI. Send a task here whenever you are ready.',
    });
    assert.equal(responseText.includes('same_user'), false);
    assert.equal(responseText.includes('4114'), false);
    assert.equal(responseText.includes('TGGHI789'), false);
    assert.equal(calls.some((call) => requestMethod(call) === 'POST' && call.url.includes('/rest/v1/rpc/set_active_gateway_connection')), false);
    assert.equal(calls.some((call) => requestMethod(call) === 'PATCH' && call.url.includes('/rest/v1/gateway_connect_codes')), true);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assertBodyIsSafe(responseText);
  });
});

test('telegram live webhook atomically claims bound tasks and sends HMAC task headers to the private runner exactly once', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      assert.equal(requestMethod(call), 'POST');
      assert.deepEqual(JSON.parse(call.init.body), {
        p_user_id: 'user_bound',
        p_gateway_id: 'telegram',
        p_source_event_id: 'telegram:update:2104',
        p_source_conversation_id: 'telegram:chat:4104',
        p_source_message_id: 'telegram:message:3104',
        p_idempotency_key: 'telegram:2104:3104',
        p_instruction: 'Plan tomorrow morning.',
      });
      return jsonResponse([{
        kind: 'accepted',
        task_run_id: 'task_run_1',
        message_id: 'message_1',
        gateway_task_event_id: 'gateway_event_1',
      }], 200);
    }
    if (call.url.includes('/rest/v1/messages') && requestMethod(call) === 'POST') {
      const body = JSON.parse(call.init.body);
      assert.equal(body.role, 'assistant');
      assert.equal(body.task_id, 'task_run_1');
      return jsonResponse([{ id: 'assistant_message_1' }], 201);
    }
    if (call.url.includes('/rest/v1/task_runs') && requestMethod(call) === 'PATCH') return jsonResponse([{ id: 'task_run_1' }]);
    if (call.url.includes('/rest/v1/artifacts') && requestMethod(call) === 'POST') return jsonResponse([{ id: 'artifact_1' }], 201);
    if (call.url === 'https://runner.sidekick.dev/tasks') {
      assert.equal(requestMethod(call), 'POST');
      const body = JSON.parse(call.init.body);
      // 2026-07-16: dispatch carries the coworker's name so the runner's task
      // path never falls back to the library default identity ("Ruben").
      // This mock's profiles lookup returns nothing, so the worker-side
      // fallback name is expected here.
      assert.deepEqual(body, { user_id: 'user_bound', instruction: 'Plan tomorrow morning.', agent_name: 'Ruben' });
      assert.equal(headerValue(call.init.headers, 'authorization'), undefined);
      const timestamp = Number(headerValue(call.init.headers, 'x-sidekick-runner-timestamp'));
      const token = headerValue(call.init.headers, 'x-sidekick-runner-token');
      assert.equal(headerValue(call.init.headers, 'x-sidekick-user-id'), 'user_bound');
      assert.equal(Number.isInteger(timestamp), true);
      assert.match(token, /^v1\.[a-f0-9]{64}$/);
      assert.equal(await verifyRunnerTokenV1(LIVE_ENV.SIDEKICK_RUNNER_SHARED_SECRET, 'user_bound', timestamp, token), true);
      return jsonResponse({
        task_id: 'runner_task_1',
        status: 'completed',
        stdout: 'Hermes terminal banner that should not be sent to Telegram.',
        result: 'Done — your morning is planned.',
      }, 200);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4104,
        replyToMessageId: 3104,
        text: 'Done — your morning is planned.',
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected Telegram task fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const update = telegramTextUpdate({
      updateId: 2104,
      messageId: 3104,
      chatId: 4104,
      text: 'Plan tomorrow morning.',
    });
    const response = await worker.fetch(telegramLiveWebhookRequest(update), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      gatewayId: 'telegram',
      kind: 'task_dispatched',
      publicReply: "Got it. I'm on it.",
      task: {
        title: 'Plan tomorrow morning.',
        receivedAt: new Date(update.message.date * 1000).toISOString(),
      },
    });
    assert.equal(responseText.includes('runner.sidekick.dev'), false);
    assert.equal(responseText.includes('user_bound'), false);
    assert.equal(responseText.includes('Plan tomorrow morning.'), true);
    assertBodyIsSafe(responseText);
    assert.equal(calls.filter((call) => call.url === 'https://runner.sidekick.dev/tasks').length, 1);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assert.equal(calls.some((call) => requestMethod(call) === 'PATCH' && call.url.includes('/rest/v1/task_runs')), true);
  });
});

for (const subscriptionStatus of ['trialing', 'past_due']) {
  test(`telegram live webhook dispatches for ${subscriptionStatus} subscriptions that still retain workspace entitlement`, async () => {
    await withMockedFetch(async (call) => {
      if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
      if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: subscriptionStatus, current_period_end: new Date(Date.now() + 86400000).toISOString() }]);
      if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
      if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
      if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance()]);
      if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
      if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
        return jsonResponse([{ kind: 'accepted', task_run_id: `task_run_${subscriptionStatus}` }]);
      }
      if (call.url === 'https://runner.sidekick.dev/tasks') {
        return jsonResponse({ status: 'completed', result: 'Done — your task is ready.' });
      }
      if (call.url.includes('/rest/v1/task_runs') || call.url.includes('/rest/v1/messages') || call.url.includes('/rest/v1/artifacts')) {
        return jsonResponse([{ id: 'opaque' }], 201);
      }
      if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
      throw new Error(`unexpected ${subscriptionStatus} entitlement fetch: ${requestMethod(call)} ${call.url}`);
    }, async (calls) => {
      const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
        updateId: subscriptionStatus === 'trialing' ? 2121 : 2122,
        messageId: subscriptionStatus === 'trialing' ? 3121 : 3122,
        chatId: subscriptionStatus === 'trialing' ? 4121 : 4122,
        text: `Run this while my subscription is ${subscriptionStatus}.`,
      })), enabledTelegramLiveEnv());
      const responseText = await response.text();

      assert.equal(response.status, 202);
      const body = JSON.parse(responseText);
      assert.equal(body.kind, 'task_dispatched');
      assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), true);
      assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), true);
      assert.equal(responseText.includes('needs_subscription'), false);
      assert.equal(responseText.includes('no_active_subscription'), false);
      assertBodyIsSafe(responseText);
    });
  });
}

test('an expired trial cannot start a Telegram task even if its ending webhook has not arrived', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'trialing', current_period_end: new Date(Date.now() - 1000).toISOString() }]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error('Expired trial must not reach task, quota, or runner endpoints');
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2199, messageId: 3199, chatId: 4199, text: 'Run after my trial ended.',
    })), enabledTelegramLiveEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
  });
});

test('telegram live webhook treats duplicate Telegram updates as already accepted without runner redispatch', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      assert.equal(requestMethod(call), 'POST');
      return jsonResponse([{ kind: 'duplicate', task_run_id: 'task_run_existing', gateway_task_event_id: 'gateway_event_existing' }]);
    }
    throw new Error(`duplicate Telegram update must not write public rows or dispatch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2105,
      messageId: 3105,
      chatId: 4105,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(responseText), {
      ok: true,
      gatewayId: 'telegram',
      kind: 'duplicate_task',
      publicReply: 'I already picked up that one.',
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 0);
    assert.equal(calls.filter((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')).length, 1);
    assert.equal(calls.some((call) => requestMethod(call) !== 'GET'
      && !call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
  });
});

test('telegram live webhook blocks hard-limited users before task claims or runner dispatch', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 10, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([{ total_tokens: 10 }]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4107,
        replyToMessageId: 3107,
        text: "You've used this month's included assistant time, so I've paused new tasks for now. You can upgrade to keep going today, or wait until your next billing cycle starts. Open the Delegent AI app to upgrade.",
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`hard-limited Telegram task must not claim, read private runner state, or dispatch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2107,
      messageId: 3107,
      chatId: 4107,
      text: 'Please run one more task.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'hard_limited',
      publicReply: "You've used this month's included assistant time, so I've paused new tasks for now. You can upgrade to keep going today, or wait until your next billing cycle starts. Open the Delegent AI app to upgrade.",
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/hermes_instance_private')), false);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook tells an agent-engine account the coworker is in the app now, and claims or dispatches nothing', async () => {
  // QA F21, 2026-09-23: with the runners gone, every message got "I'm still warming up" for ever.
  const MOVED = "I work in the Delegent AI app now, so I can't take tasks here any more. Open the app and send me this there, and I'll get straight on it.";
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: '11111111-2222-4333-8444-555555555555' }]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, { chatId: 4111, replyToMessageId: 3111, text: MOVED });
      return telegramSendMessageResponse();
    }
    throw new Error(`an agent-engine Telegram task must not read runner state, claim or dispatch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2111,
      messageId: 3111,
      chatId: 4111,
      text: 'Can you check my inbox?',
    })), enabledTelegramLiveEnv({
      AGENT: { fetch() { throw new Error('the engine is not called from Telegram'); } },
      SIDEKICK_AGENT_SHARED_SECRET: 'agent-secret',
      SIDEKICK_AGENT_ENGINE_USER_IDS: '*',
    }));
    const responseText = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), { ok: false, gatewayId: 'telegram', kind: 'moved_to_app', publicReply: MOVED });
    assertBodyIsSafe(responseText);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
  });
});

test('telegram live webhook treats unconfigured quota as first-run setup, not monthly capacity exhaustion', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 0, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4110,
        replyToMessageId: 3110,
        text: "I'm still warming up. Try again once the Delegent AI app says I'm online.",
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unconfigured-quota Telegram task must not claim or dispatch before runner readiness is proven: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2110,
      messageId: 3110,
      chatId: 4110,
      text: 'Try a task while quota is still being seeded.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'worker_not_ready',
      publicReply: "I'm still warming up. Try again once the Delegent AI app says I'm online.",
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/hermes_instances')), true);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/hermes_instance_private')), false);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook with stale runner health probes /healthz on demand and refuses when the probe fails', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({
      last_health_at: '2020-01-01T00:00:00.000Z',
    })]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url === 'https://runner.sidekick.dev/healthz') {
      return new Response('upstream unavailable', { status: 503 });
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4108,
        replyToMessageId: 3108,
        text: "I'm still warming up. Try again once the Delegent AI app says I'm online.",
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`failed on-demand probe must not claim, refresh health, or dispatch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2108,
      messageId: 3108,
      chatId: 4108,
      text: 'Summarize the last meeting.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'worker_not_ready',
      publicReply: "I'm still warming up. Try again once the Delegent AI app says I'm online.",
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/healthz'), true);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'PATCH'), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/rpc/claim_gateway_task_event')), false);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook with stale runner health probes /healthz and dispatches when the runner is alive', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({
      last_health_at: '2020-01-01T00:00:00.000Z',
    })]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'PATCH') {
      const body = JSON.parse(call.init.body);
      assert.match(body.last_health_at, /^\d{4}-\d{2}-\d{2}T/);
      return jsonResponse([{ user_id: 'user_bound' }]);
    }
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url === 'https://runner.sidekick.dev/healthz') {
      return jsonResponse({ ok: true, service: 'sidekick-hermes-runner' });
    }
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_stale_probe_ok' }]);
    }
    if (call.url === 'https://runner.sidekick.dev/tasks') {
      return jsonResponse({ status: 'completed', stdout: 'all good' });
    }
    if (call.url.includes('/rest/v1/task_runs') || call.url.includes('/rest/v1/messages') || call.url.includes('/rest/v1/artifacts')) {
      return jsonResponse([{ id: 'opaque' }], 201);
    }
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') return jsonResponse([], 201);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2208,
      messageId: 3208,
      chatId: 4208,
      text: 'Summarize the last meeting.',
    })), enabledTelegramLiveEnv());

    assert.equal(response.status, 202);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/healthz'), true);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'PATCH'), true);
    assert.equal(calls.some((call) => call.url === 'https://runner.sidekick.dev/tasks'), true);
  });
});

// ---------------------------------------------------------------------------
// Series 4 — per-user Fly Machines routing (Phase 4)
// ---------------------------------------------------------------------------
// hermes_instances.provider tells the Worker whether the runner was
// provisioned on Fly or on the legacy Railway template. Once
// FLY_REQUIRE_DEDICATED_RUNNER=true the Worker must fail closed on anything
// that isn't 'fly_machines', and for a Fly binding the URL host must match
// hermes_instance_private.fly_app_name (defence-in-depth — a stale or
// admin-mutated row that no longer matches the user's app must not dispatch).

test('series4 telegram live: provider=fly_machines + matching fly_app_name dispatches via the per-user app URL', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_fly_a' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({ provider: 'fly_machines' })]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      return jsonResponse([{ runner_base_url: 'https://delegent-runner-aaaaaaaaaaaa.fly.dev', provider: 'fly_machines', fly_app_name: 'delegent-runner-aaaaaaaaaaaa' }]);
    }
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_fly_a' }]);
    }
    if (call.url === 'https://delegent-runner-aaaaaaaaaaaa.fly.dev/tasks') {
      return jsonResponse({ status: 'completed', stdout: 'all good' });
    }
    if (call.url.includes('/rest/v1/task_runs') || call.url.includes('/rest/v1/messages') || call.url.includes('/rest/v1/artifacts')) {
      return jsonResponse([{ id: 'opaque' }], 201);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 4001,
      messageId: 5001,
      chatId: 6001,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv());
    assert.equal(response.status, 202);
    // Dispatched to the per-user Fly app, never to a shared URL.
    assert.equal(calls.some((c) => c.url === 'https://delegent-runner-aaaaaaaaaaaa.fly.dev/tasks'), true);
    assert.equal(calls.some((c) => c.url.includes('runner.sidekick.dev')), false);
  });
});

test('series4 telegram live: provider=fly_machines but fly_app_name missing -> runner_unavailable, no dispatch', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_fly_b' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({ provider: 'fly_machines' })]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      // public says fly_machines but private is missing the binding fields
      return jsonResponse([{ runner_base_url: 'https://delegent-runner-bbbbbbbbbbbb.fly.dev', provider: 'fly_machines', fly_app_name: null }]);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 4002,
      messageId: 5002,
      chatId: 6002,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv());
    const body = JSON.parse(await response.text());
    assert.equal(body.kind, 'runner_unavailable');
    assert.equal(calls.some((c) => c.url.endsWith('/tasks')), false);
    assert.equal(calls.some((c) => c.url.includes('claim_gateway_task_event')), false);
  });
});

test('series4 telegram live: provider=fly_machines URL host does NOT match fly_app_name -> runner_unavailable (defence-in-depth)', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_fly_c' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({ provider: 'fly_machines' })]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      // user_fly_c is bound to fly_app_name=delegent-runner-cccccccccccc, but
      // the runner_base_url points at a DIFFERENT app's host. This is the
      // exact "stale/admin-mutated URL pointing at the wrong tenant" case
      // the host check is meant to catch.
      return jsonResponse([{ runner_base_url: 'https://delegent-runner-ddddddddDDDD.fly.dev', provider: 'fly_machines', fly_app_name: 'delegent-runner-cccccccccccc' }]);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 4003,
      messageId: 5003,
      chatId: 6003,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv());
    const body = JSON.parse(await response.text());
    assert.equal(body.kind, 'runner_unavailable');
    // NEVER dispatched to the mismatched host.
    assert.equal(calls.some((c) => c.url.includes('delegent-runner-ddddddddDDDD')), false);
    assert.equal(calls.some((c) => c.url.endsWith('/tasks')), false);
  });
});

test('series4 telegram live: FLY_REQUIRE_DEDICATED_RUNNER=true blocks provider=railway_legacy with no shared fallback', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_legacy_d' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({ provider: 'railway_legacy' })]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`dedicated-required mode must not query hermes_instance_private or dispatch on a railway_legacy provider: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 4004,
      messageId: 5004,
      chatId: 6004,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv({ FLY_REQUIRE_DEDICATED_RUNNER: 'true' }));
    const body = JSON.parse(await response.text());
    assert.equal(body.kind, 'worker_not_ready');
    // Worker never touched the private binding or any runner URL.
    assert.equal(calls.some((c) => c.url.includes('hermes_instance_private')), false);
    assert.equal(calls.some((c) => c.url.endsWith('/tasks')), false);
  });
});

test('series4 telegram live: cutover mode (FLY_REQUIRE_DEDICATED_RUNNER not set) lets a railway_legacy runner keep working', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_legacy_e' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances') && requestMethod(call) === 'GET') return jsonResponse([readyHermesInstance({ provider: 'railway_legacy' })]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      // legacy row — fly_app_name is null because it's not a Fly runner.
      return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev', provider: 'railway_legacy', fly_app_name: null }]);
    }
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_legacy_e' }]);
    }
    if (call.url === 'https://runner.sidekick.dev/tasks') return jsonResponse({ status: 'completed', stdout: 'ok' });
    if (call.url.includes('/rest/v1/task_runs') || call.url.includes('/rest/v1/messages') || call.url.includes('/rest/v1/artifacts')) {
      return jsonResponse([{ id: 'opaque' }], 201);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    // No FLY_REQUIRE_DEDICATED_RUNNER override -> default cutover behaviour
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 4005,
      messageId: 5005,
      chatId: 6005,
      text: 'Plan tomorrow morning.',
    })), enabledTelegramLiveEnv());
    assert.equal(response.status, 202);
    assert.equal(calls.some((c) => c.url === 'https://runner.sidekick.dev/tasks'), true);
  });
});

test('telegram live webhook sanitizes runner output before writing mobile-visible artifacts and messages', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_sanitize' }]);
    }
    if (call.url.includes('/rest/v1/task_runs') && requestMethod(call) === 'PATCH') {
      const body = JSON.parse(call.init.body);
      assert.equal(body.runner_task_id, null);
      assert.doesNotMatch(JSON.stringify(body), /runner\.sidekick\.dev|token|secret|openrouter|hermes|provider|api[-_ ]?key/i);
      return jsonResponse([{ id: 'task_run_sanitize' }]);
    }
    if ((call.url.includes('/rest/v1/artifacts') || call.url.includes('/rest/v1/messages')) && requestMethod(call) === 'POST') {
      const body = JSON.parse(call.init.body);
      const visible = `${body.detail ?? ''} ${body.content ?? ''}`;
      assert.doesNotMatch(visible, /runner\.sidekick\.dev|openrouter|service_role|authorization|bearer|secret|token|x-sidekick-runner-token|v1\.[a-f0-9]{32,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|hermes|provider|api[-_ ]?key/i);
      return jsonResponse([{ id: call.url.includes('/rest/v1/artifacts') ? 'artifact_sanitize' : 'message_sanitize' }], 201);
    }
    if (call.url === 'https://runner.sidekick.dev/tasks') {
      return jsonResponse({
        task_id: 'https://runner.sidekick.dev/v1.private-token',
        status: 'completed',
        stdout: 'Done. Internal: https://runner.sidekick.dev/tasks OpenRouter SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature Authorization: Bearer sk-or-v1-secret x-sidekick-runner-token v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa hermes provider api_key.',
      }, 200);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.chat_id, '4109');
      assert.equal(body.reply_to_message_id, 3109);
      assert.match(body.text, /^Done\./);
      assert.doesNotMatch(body.text, /runner\.sidekick\.dev|openrouter|service_role|authorization|bearer|secret|token|x-sidekick-runner-token|v1\.[a-f0-9]{32,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|hermes|provider|api[-_ ]?key/i);
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected sanitizer test fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2109,
      messageId: 3109,
      chatId: 4109,
      text: 'Write a safe summary.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 202);
    assert.equal(JSON.parse(responseText).kind, 'task_dispatched');
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/artifacts') && requestMethod(call) === 'POST'), true);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/messages') && requestMethod(call) === 'POST'), true);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook treats provider-error runner transcripts as failed instead of sending terminal output', async () => {
  await withMockedFetch(async (call) => {
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_provider_error' }]);
    }
    if (call.url.includes('/rest/v1/task_runs') && requestMethod(call) === 'PATCH') {
      const body = JSON.parse(call.init.body);
      assert.equal(body.status, 'failed');
      assert.equal(body.error_code, 'runner_task_failed');
      return jsonResponse([{ id: 'task_run_provider_error' }]);
    }
    if ((call.url.includes('/rest/v1/artifacts') || call.url.includes('/rest/v1/messages')) && requestMethod(call) === 'POST') {
      throw new Error('provider-error runner transcripts must not be written as assistant-visible output');
    }
    if (call.url === 'https://runner.sidekick.dev/tasks') {
      return jsonResponse({
        task_id: 'runner_task_provider_error',
        status: 'completed',
        stdout: 'Hermes banner\\nAPI call failed: PermissionDeniedError [HTTP 403]\\nNon-retryable client error.\\nResume this session with: hermes --resume abc',
      }, 200);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4111,
        replyToMessageId: 3111,
        text: "I couldn't finish that. Try sending it again or check the Delegent AI app.",
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`unexpected provider-error test fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2111,
      messageId: 3111,
      chatId: 4111,
      text: 'Please run a provider-error task.',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'runner_task_failed',
      publicReply: "I couldn't finish that. Try sending it again or check the Delegent AI app.",
    });
    assertBodyIsSafe(responseText);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/artifacts') && requestMethod(call) === 'POST'), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/messages') && requestMethod(call) === 'POST'), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
  });
});

test('telegram live webhook does not bind when a connect code was already consumed by a concurrent delivery', async () => {
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/gateway_connect_codes')) {
      if (requestMethod(call) === 'GET') return jsonResponse([{ id: 'code_row_race', user_id: 'user_bound' }]);
      if (requestMethod(call) === 'PATCH') return jsonResponse([]);
    }
    if (call.url.includes('/rest/v1/gateway_connections') && requestMethod(call) === 'GET') return jsonResponse([]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) {
      assertTelegramSendMessage(call, {
        chatId: 4106,
        replyToMessageId: 3106,
        text: 'Connect Telegram in the Delegent AI app first, then resend this task.',
      });
      return telegramSendMessageResponse();
    }
    throw new Error(`consumed Telegram code must not create a connection: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2106,
      messageId: 3106,
      chatId: 4106,
      text: '/start TG RACE-12',
    })), enabledTelegramLiveEnv());
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(responseText), {
      ok: false,
      gatewayId: 'telegram',
      kind: 'needs_connection',
      publicReply: 'Connect Telegram in the Delegent AI app first, then resend this task.',
    });
    assert.equal(calls.some((call) => requestMethod(call) === 'POST' && call.url.includes('/rest/v1/gateway_connections')), false);
    assert.equal(calls.filter((call) => call.url === TELEGRAM_SEND_MESSAGE_URL).length, 1);
    assertBodyIsSafe(responseText);
  });
});


test('Cloudflare Worker preflight returns missing names only and never secret values', () => {
  const report = preflightCloudflareWorker({
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missingSecrets, []);
  assert.deepEqual(report.missingVariables, ['SUPABASE_URL']);
  assert.equal(report.checks.some((check) => check.id === 'required-env' && !check.ok), true);
  assert.doesNotMatch(JSON.stringify(report), /or_test_secret|service_role_test_secret|runner_secret/i);

  const ready = preflightCloudflareWorker({
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.missingSecrets, []);
  assert.deepEqual(ready.missingVariables, []);
});

test('worker requires a signed Sidekick runner token before proxying model traffic (legacy fallback)', async () => {
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({ 'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123' }), {
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
    SIDEKICK_RUNNER_AUTH_LEGACY: 'true',
  }), /valid Sidekick runner token required/);

  // Legacy mode (opt-in) accepts the bare shared secret using a constant-time compare.
  assert.equal(await requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': 'runner_secret',
  }), {
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
    SIDEKICK_RUNNER_AUTH_LEGACY: 'true',
  }), 'a0000000-1230-4123-8123-000000000123');

  // With legacy disabled (default), the bare shared secret is rejected — only
  // v1 HMAC tokens authenticate.
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': 'runner_secret',
  }), {
    SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret',
  }), /valid Sidekick runner token required/);
});

test('worker accepts v1 HMAC runner tokens, binds them per user, and rejects skewed timestamps', async () => {
  const now = new Date('2026-05-05T12:00:00Z');
  const ts = Math.floor(now.getTime() / 1000);
  const token = await signRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', ts);

  // #30 — the global-secret V1 path is now LEGACY-gated (per-user is primary),
  // so this exercises the global path via the flag. (Per-user V1 is covered by
  // the proxy tests that mock the hermes_instance_private secret.)
  const env = { SIDEKICK_RUNNER_SHARED_SECRET: 'runner_secret', SIDEKICK_RUNNER_AUTH_LEGACY: 'true' };

  // Happy path.
  assert.equal(await requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': token,
    'x-sidekick-runner-timestamp': String(ts),
  }), env, now), 'a0000000-1230-4123-8123-000000000123');

  // Token signed for user_A is rejected when presented as user_B.
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-4560-4456-8456-000000000456',
    'x-sidekick-runner-token': token,
    'x-sidekick-runner-timestamp': String(ts),
  }), env, now), /valid Sidekick runner token required/);

  // Beyond the skew window, the token is rejected.
  const skewed = new Date(now.getTime() + (RUNNER_AUTH_MAX_SKEW_SECONDS + 1) * 1000);
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': token,
    'x-sidekick-runner-timestamp': String(ts),
  }), env, skewed), /valid Sidekick runner token required/);

  // Missing timestamp header is rejected for v1 tokens.
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': token,
  }), env, now), /valid Sidekick runner token required/);

  // Tampered token (last hex char flipped) is rejected.
  const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-1230-4123-8123-000000000123',
    'x-sidekick-runner-token': tampered,
    'x-sidekick-runner-timestamp': String(ts),
  }), env, now), /valid Sidekick runner token required/);
});

test('verifyRunnerTokenV1 round-trips with signRunnerTokenV1 and rejects malformed inputs', async () => {
  const token = await signRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000, token), true);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-4560-4456-8456-000000000456', 1_770_000_000, token), false);
  assert.equal(await verifyRunnerTokenV1('different_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000, token), false);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_001, token), false);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000, 'not-a-v1-token'), false);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000, 'v1.notHex'), false);
  assert.equal(await verifyRunnerTokenV1('runner_secret', 'a0000000-1230-4123-8123-000000000123', 1_770_000_000, 'v1.'), false);
});

test('timingSafeEqualBytes returns false on length mismatch and correctly compares equal-length buffers', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  const c = new Uint8Array([1, 2, 3, 5]);
  const d = new Uint8Array([1, 2, 3]);
  assert.equal(timingSafeEqualBytes(a, b), true);
  assert.equal(timingSafeEqualBytes(a, c), false);
  assert.equal(timingSafeEqualBytes(a, d), false);
});

test('worker forces the configured hosted model, strips unsafe knobs, and passes streaming through with usage accounting', () => {
  // Streaming is no longer an "unsafe knob": the token-by-token rollout makes
  // the Worker pass stream:true THROUGH to OpenRouter (and adds stream_options
  // so the final SSE chunk still carries usage for billing). The model pin and
  // the other unsafe-knob handling — client model override ignored, provider
  // PINNED server-side (the client's hint is replaced, never honoured), oversized
  // max_tokens clamped, out-of-range temperature clamped — are unchanged below.
  const payload = buildOpenRouterPayload({
    model: 'user-selected-model',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
    provider: { order: ['provider-a'] },
    max_tokens: MAX_COMPLETION_TOKENS + 1_000,
    temperature: 2,
  });

  assert.equal(payload.model, MODEL);
  // Passed through (was hard-forced to false before the streaming rollout).
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.deepEqual(payload.reasoning, { effort: 'none', exclude: true });
  assert.equal(payload.max_tokens, MAX_COMPLETION_TOKENS);
  assert.equal(payload.temperature, 1);
  // Provider is pinned SERVER-SIDE for prompt-cache reliability; the client's
  // 'provider-a' hint is replaced by the DeepInfra pin, never honoured upstream.
  assert.deepEqual(payload.provider,
    { order: [...MODEL_PROVIDER_ORDER], allow_fallbacks: true, ignore: [...MODEL_PROVIDER_IGNORE], data_collection: 'deny' });
});

test('worker keeps stream:false (and omits stream_options) for the non-streaming proxy path', () => {
  // The sync callers (sync /tasks, Telegram, the runner's non-streaming loop)
  // must NOT get streaming injected — a regression that started streaming this
  // path would break their single-shot JSON parsing. Lock the default.
  const payload = buildOpenRouterPayload({
    model: 'user-selected-model',
    messages: [{ role: 'user', content: 'Hello' }],
    // no stream field requested
  });

  assert.equal(payload.model, MODEL);
  assert.equal(payload.stream, false);
  assert.equal('stream_options' in payload, false);
});

test('the pinned hosted model is GPT-5.6 Luna (one model for every user, always)', () => {
  // The test above proves a client cannot override the model. This one pins the
  // VALUE so a silent swap to a different model is caught in regression.
  // If we ever deliberately change models again, update this literal +
  // docs/COST_MODEL.md, and CHECK VISION FIRST.
  //
  // 2026-08-04 carried TWO deliberate changes: deepseek-v4-flash out in the
  // morning (the whole DeepSeek family is text-only and camera-to-chat failed
  // on every photo, found by Alex on-device), gemini-2.5-flash-lite as the
  // fix, then the luna tier the same evening on Alex's judgement that a
  // lite-tier model is not smart enough for the agentic coworker work; then
  // 2026-08-05, luna-pro -> luna (the non-pro variant) after Alex reported
  // slow web research: same brain, same price, but pro's heavy default
  // reasoning budget cost ~3x the latency per agent-loop step (measured
  // 6.7s vs 2.4s on an identical tool-choice probe, 312 vs 21 reasoning
  // tokens). The luna tier kept
  // the warm cost (~$0.014/M blended, 8x cheaper than the kimi-k2.6
  // benchmark) while stepping up capability; vision, exact tool-calls, a
  // strict word cap, and ZDR routing on the EU Azure endpoint were all
  // verified live before the switch.
  assert.equal(MODEL, 'openai/gpt-6-luna');
  const payload = buildOpenRouterPayload({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(payload.model, 'openai/gpt-6-luna');
});

test('worker preserves OpenAI-compatible tool calling fields for Hermes runners', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a workspace file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  }];

  const payload = buildOpenRouterPayload({
    messages: [{ role: 'user', content: 'Create a file' }],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  });

  assert.equal(payload.model, MODEL);
  assert.deepEqual(payload.tools, tools);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.parallel_tool_calls, false);
});

test('worker extracts usage into Sidekick token usage event shape without exposing provider model names', () => {
  const usage = extractUsageEvent('a0000000-1230-4123-8123-000000000123', {
    model: MODEL,
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    },
  });

  assert.deepEqual(usage, {
    userId: 'a0000000-1230-4123-8123-000000000123',
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
    // cost-proportional (2026-06-05): uncached 12 + cached 0 + output 8*4.7 = 49.6 -> 50
    billableTokens: 50,
    source: 'worker',
  });
});

test('extractUsageEvent discounts cached prompt tokens against the quota (cache-aware billing)', () => {
  // Kimi caching + cost-proportional quota (2026-06-05): 10000 prompt (8000 cached)
  // + 500 completion. billable = uncached 2000 + cached 8000*0.21 + output 500*4.7
  // = 2000 + 1680 + 2350 = 6030 (cached input heavily discounted; output weighted).
  const usage = extractUsageEvent('u1', {
    usage: {
      prompt_tokens: 10000,
      completion_tokens: 500,
      total_tokens: 10500,
      prompt_tokens_details: { cached_tokens: 8000 },
    },
  });
  assert.equal(usage.cachedTokens, 8000);
  assert.equal(usage.totalTokens, 10500, 'raw total preserved');
  assert.equal(usage.billableTokens, 6030, 'uncached x1 + cached x0.21 + output x4.7');
  assert.ok(usage.billableTokens < usage.totalTokens, 'a cache-heavy (input-dominated) call still bills under raw total');
});

test('extractUsageEvent clamps a bogus cached value and never bills below zero or above total', () => {
  const usage = extractUsageEvent('u1', {
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 999999 } },
  });
  assert.equal(usage.cachedTokens, 100, 'cached clamped to prompt_tokens');
  // uncached 0 + cached 100*0.21 + output 10*4.7 = 21 + 47 = 68
  assert.equal(usage.billableTokens, 68, 'uncached 0 + cached x0.21 + output x4.7');
  assert.ok(usage.billableTokens >= 0, 'never bills below zero');
});

test('applyPromptCacheBreakpoints marks ONLY the first user message (a trailing breakpoint collapses the cache)', () => {
  // OpenRouter/Moonshot only caches with an explicit cache_control breakpoint
  // placed AFTER the tools (a system breakpoint does NOT cover the tools field).
  // Crucially, Moonshot reads at the LAST breakpoint's position, so a second,
  // advancing breakpoint on the tool-result tail collapses cached_tokens to 0
  // (verified live: single first-user breakpoint -> warm cached=3872/3900). So we
  // mark exactly ONE breakpoint, on the first user message (the only byte-stable
  // point across the loop), and DELIBERATELY leave the last message untouched.
  const out = applyPromptCacheBreakpoints([
    { role: 'system', content: 'You are Thais.' },
    { role: 'user', content: 'Build me a spreadsheet.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', content: 'done' },
  ]);
  assert.equal(out[0].content, 'You are Thais.', 'system untouched');
  assert.ok(Array.isArray(out[1].content), 'first user message becomes a content array');
  assert.equal(out[1].content.at(-1).cache_control.type, 'ephemeral', 'first user message gets the breakpoint');
  assert.equal(out[2].content, null, 'content-less assistant tool-call is left alone');
  // The last message must NOT be converted/marked — that is what kills the cache.
  assert.equal(out[3].content, 'done', 'last message is left as-is (no trailing breakpoint)');
});

test('buildOpenRouterPayload injects cache_control into the outgoing messages (caching enabled)', () => {
  const payload = buildOpenRouterPayload({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  });
  const serialized = JSON.stringify(payload.messages);
  assert.ok(serialized.includes('"cache_control"'), 'payload must carry a cache_control breakpoint');
  assert.ok(serialized.includes('"ephemeral"'));
});

test('applyPromptCacheBreakpoints is a safe no-op when nothing is cacheable', () => {
  const input = [{ role: 'assistant', content: null, tool_calls: [] }];
  assert.deepEqual(applyPromptCacheBreakpoints(input), input);
});

test('buildOpenRouterPayload pins the upstream provider for cache reliability, ignoring client input', () => {
  // Caching is worthless without this: a model on OpenRouter is served by many
  // providers each with an instance-local cache, so an unpinned (load-balanced)
  // request scatters the loop's calls across providers and the cache misses
  // (verified live for the previous pins: flaky 1/3 unpinned). For
  // gpt-5.6-luna (2026-08-04/05) the pin prefers the EU-region Azure
  // endpoint for data residency, verified live with the production payload
  // shape (image included) under the ZDR-enforced key. The pin is server-side
  // and REPLACES any client-supplied provider hint.
  assert.equal(MODEL_PROVIDER_PIN, 'openai');
  // The chain after the pin must only contain endpoints that actually serve
  // the pinned MODEL, from its own endpoint list, all at the full 1,050,000
  // context so no fallback can silently truncate a long chat.
  assert.deepEqual([...MODEL_PROVIDER_ORDER], ['openai']);
  assert.deepEqual([...MODEL_PROVIDER_IGNORE], ['amazon-bedrock']);
  const withClientHint = buildOpenRouterPayload({
    messages: [{ role: 'user', content: 'hi' }],
    provider: { order: ['some-other-provider'], allow_fallbacks: false },
  });
  const pinned = { order: [...MODEL_PROVIDER_ORDER], allow_fallbacks: true, ignore: ['amazon-bedrock'], data_collection: 'deny' };
  assert.deepEqual(withClientHint.provider, pinned);
  const noHint = buildOpenRouterPayload({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(noHint.provider, pinned);
});

test('every model request carries the no-training promise the privacy policy makes', () => {
  // The policy tells customers no provider trains on their content (zero
  // retention was dropped with the move to gpt-6-luna on 2026-09-22; OpenAI
  // keeps API data up to 30 days for abuse checks). These are OpenRouter's
  // documented request-level controls, additive to the account settings.
  for (const body of [
    { messages: [{ role: 'user', content: 'hi' }] },
    { messages: [{ role: 'user', content: 'hi' }], stream: true },
    // A caller asking to turn the protection OFF is ignored, like every other
    // provider hint. The Worker is the trust boundary, not the runner.
    { messages: [{ role: 'user', content: 'hi' }], provider: { zdr: false, data_collection: 'allow', allow_fallbacks: false } },
  ]) {
    const payload = buildOpenRouterPayload(body);
    assert.equal(payload.provider.zdr, undefined);
    assert.equal(payload.provider.data_collection, 'deny');
    assert.deepEqual(payload.provider.ignore, ['amazon-bedrock']);
    // Fallbacks stay on, and the restriction applies to them too: a fallback
    // that retained content would be a hole in the promise rather than a
    // graceful degradation.
    assert.equal(payload.provider.allow_fallbacks, true);
  }
});

test('live proxy checks quota before model traffic, persists usage, and returns product-safe JSON', async () => {
  await withMockedFetch((call) => {
    // [Batch 4a §2.5.3] The Worker now also reads subscriptions
    // (for the Stripe-aware billing-cycle anchor) and delegent_billing_guard
    // (for the org-wide spend pause). Both return safely-empty in this test
    // so the gate falls back to calendar-month + no-guard behaviour and the
    // rest of the test's assertions apply unchanged.
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/delegent_billing_guard')) return jsonResponse([]);

    if (call.url.includes('/rest/v1/usage_quotas')) {
      assert.equal(requestMethod(call), 'GET');
      assert.match(call.url, /user_id=eq\.a0000000-1230-4123-8123-000000000123/);
      assert.match(call.url, /select=monthly_token_quota/);
      // 1M quota so the happy path clears the cost-weighted budget (output x4.7).
      return jsonResponse([{ monthly_token_quota: 1_000_000 }]);
    }

    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') {
      assert.match(call.url, /user_id=eq\.a0000000-1230-4123-8123-000000000123/);
      assert.match(call.url, /created_at=gte\./);
      assert.match(call.url, /select=total_tokens/);
      return jsonResponse([{ total_tokens: 100 }, { total_tokens: 50 }]);
    }

    if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
      assert.equal(requestMethod(call), 'POST');
      const upstreamPayload = JSON.parse(call.init.body);
      assert.equal(upstreamPayload.model, MODEL);
      assert.equal(upstreamPayload.max_tokens, 300);
      return jsonResponse({
        id: 'chatcmpl_1',
        model: MODEL,
        provider: { name: 'openrouter', leaked: LIVE_ENV.OPENROUTER_API_KEY },
        choices: [{
          message: {
            role: 'assistant',
            content: 'done',
            provider: { name: 'nested-provider' },
            model: 'nested-model',
          },
        }],
        usage: { prompt_tokens: 25, completion_tokens: 75, total_tokens: 100 },
      });
    }

    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') {
      const inserted = JSON.parse(call.init.body);
      assert.equal(inserted.user_id, 'a0000000-1230-4123-8123-000000000123');
      assert.equal(inserted.prompt_tokens, 25);
      assert.equal(inserted.completion_tokens, 75);
      // cost-proportional billable: uncached 25 + cached 0 + output 75*4.7 = 377.5 -> 378
      assert.equal(inserted.total_tokens, 378);
      assert.equal(inserted.source, 'worker');
      return jsonResponse([{ id: 'usage_1' }], 201);
    }

    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(chatCompletionRequest({ max_tokens: 300 }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 200);
    // [Batch 4a §2.5.3] Worker now also reads subscriptions + delegent_billing_guard
    // and writes nothing extra on the happy path. Assert specific call shapes
    // rather than exact length, so future additional cycle-aware reads don't
    // require a churn-update here.
    assert.equal(
      calls.filter((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions').length,
      1,
      'OpenRouter is called exactly once on the happy path',
    );
    assert.ok(
      calls.some((c) => /\/rest\/v1\/usage_quotas/.test(c.url) && requestMethod(c) === 'GET'),
      'usage_quotas is read pre-call',
    );
    assert.ok(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'GET'),
      'token_usage_events is read pre-call',
    );
    assert.ok(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'POST'),
      'token_usage_events insert fires post-call',
    );

    // Service-role auth on every Supabase call.
    for (const call of calls.filter((c) => /\/rest\/v1\//.test(c.url))) {
      assert.equal(headerValue(call.init.headers, 'apikey'), LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
    }

    assert.equal(responseText.includes('"provider"'), false);
    assert.equal(responseText.includes(MODEL), false);
    assertBodyIsSafe(responseText);
    const parsed = JSON.parse(responseText);
    // The Worker must keep `model` as a non-empty public string so that the
    // openai-python ChatCompletion validator inside Hermes accepts the response.
    assert.equal(typeof parsed.model, 'string');
    assert.ok(parsed.model.length > 0);
    assert.notEqual(parsed.model, MODEL);
    delete parsed.model;
    assert.deepEqual(parsed, {
      id: 'chatcmpl_1',
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 25, completion_tokens: 75, total_tokens: 100 },
    });
  });
});

test('worker proxied response is openai-python ChatCompletion compatible (regression: P0 runner/model path)', async () => {
  // Real, deployed-Worker capture (2026-05-10) showed the Worker stripping
  // `model` from OpenRouter responses, which broke openai-python's
  // ChatCompletion.model_validate inside Hermes. The Worker must:
  //   - keep top-level `id`, `object`, `created`, `model`, `choices`, `usage`
  //   - replace the upstream provider model with a generic public label so the
  //     internal model identity does not leak
  //   - still strip `provider` and any nested `model` fields
  await withMockedFetch((call) => {
    if (call.url.includes('/rest/v1/usage_quotas')) {
      return jsonResponse([{ monthly_token_quota: 1_000, tier_id: 'studio' }]);
    }
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') {
      return jsonResponse([]);
    }
    if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
      // Mirrors the actual OpenRouter response shape captured against the
      // deployed Worker (id, object, created, model, provider, choices, usage,
      // system_fingerprint, plus nested provider/model fields the Worker has
      // historically tried to scrub).
      return jsonResponse({
        id: 'gen-or-1',
        object: 'chat.completion',
        created: 1_770_000_000,
        model: MODEL,
        provider: { name: 'openrouter', leaked: LIVE_ENV.OPENROUTER_API_KEY },
        system_fingerprint: 'fp-or-1',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'pong',
            // Defensive: nested `model` and `provider` keys must still be scrubbed.
            model: 'nested-model',
            provider: { name: 'nested-provider' },
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') {
      return jsonResponse([{ id: 'usage_1' }], 201);
    }
    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async () => {
    const response = await worker.fetch(chatCompletionRequest({ max_tokens: 64 }), LIVE_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 200);

    // Top-level OpenAI ChatCompletion required fields must all be present so
    // openai-python (used by Hermes) accepts the response.
    const parsed = JSON.parse(responseText);
    for (const key of ['id', 'object', 'created', 'model', 'choices', 'usage']) {
      assert.ok(key in parsed, `missing required ChatCompletion field: ${key}`);
    }
    assert.equal(typeof parsed.id, 'string');
    assert.equal(parsed.object, 'chat.completion');
    assert.equal(typeof parsed.created, 'number');

    // `model` must be present and non-empty (openai-python requires str), but
    // must NOT be the upstream provider's model identifier.
    assert.equal(typeof parsed.model, 'string');
    assert.ok(parsed.model.length > 0);
    assert.notEqual(parsed.model, MODEL);
    assert.equal(responseText.includes(MODEL), false);

    // `provider` and any nested `model`/`provider` fields are still stripped.
    assert.equal('provider' in parsed, false);
    assert.equal(responseText.includes('"provider"'), false);
    assert.equal(responseText.includes('nested-model'), false);
    assert.equal(responseText.includes('nested-provider'), false);

    // Choice and message shape match what the openai-python ChatCompletion
    // validator expects.
    assert.ok(Array.isArray(parsed.choices));
    assert.equal(parsed.choices.length, 1);
    const choice = parsed.choices[0];
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, 'pong');
    assert.equal('model' in choice.message, false);
    assert.equal('provider' in choice.message, false);

    assertBodyIsSafe(responseText);
  });
});

test('worker debug capture redacts provider, service, and runner secrets before sending to a sink', async () => {
  const captureUrl = 'https://capture.sidekick.test/events';
  const captureBodies = [];
  await withMockedFetch((call) => {
    if (call.url === captureUrl) {
      captureBodies.push(JSON.parse(call.init.body));
      return emptyResponse(204);
    }

    if (call.url.includes('/rest/v1/usage_quotas')) {
      return jsonResponse([{ monthly_token_quota: 1_000, tier_id: 'studio' }]);
    }

    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') {
      return jsonResponse([{ total_tokens: 25 }]);
    }

    if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
      assert.equal(headerValue(call.init.headers, 'authorization'), `Bearer ${LIVE_ENV.OPENROUTER_API_KEY}`);
      return jsonResponse({
        id: 'chatcmpl_capture',
        provider: { leaked: LIVE_ENV.OPENROUTER_API_KEY },
        choices: [{ message: { role: 'assistant', content: 'done', model: MODEL } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') {
      return jsonResponse([{ id: 'usage_capture' }], 201);
    }

    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async () => {
    const response = await worker.fetch(chatCompletionRequest({
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `debug capture must redact ${LIVE_ENV.OPENROUTER_API_KEY}, ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}, and ${LIVE_ENV.SIDEKICK_RUNNER_SHARED_SECRET}`,
      }],
    }), {
      ...LIVE_ENV,
      SIDEKICK_DEBUG_CAPTURE_URL: captureUrl,
      // Capture is fail-closed: only explicitly-marked dev/staging
      // environments may ship payloads to the sink (2026-06-10 #34).
      SIDEKICK_ENVIRONMENT: 'dev',
    });
    const responseText = await response.text();

    assert.equal(response.status, 200);
    assert.equal(captureBodies.length, 3);
    const captureText = JSON.stringify(captureBodies);
    assert.equal(captureText.includes(LIVE_ENV.OPENROUTER_API_KEY), false);
    assert.equal(captureText.includes(LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY), false);
    assert.equal(captureText.includes(LIVE_ENV.SIDEKICK_RUNNER_SHARED_SECRET), false);
    assert.match(captureText, /\[REDACTED\]/);

    const inboundCapture = captureBodies.find((body) => body.stage === 'worker_inbound_adapter_request');
    assert.equal(inboundCapture.request.headers.some(([key, value]) => key === 'x-sidekick-runner-token' && value === '[REDACTED]'), true);
    const outboundCapture = captureBodies.find((body) => body.stage === 'worker_outbound_openrouter_request');
    assert.equal(outboundCapture.request.headers.some(([key, value]) => key === 'authorization' && value === '[REDACTED]'), true);
    assertBodyIsSafe(responseText);
  });
});

test('worker debug capture is fail-closed: production and UNMARKED environments never ship payloads (#34)', async () => {
  const captureUrl = 'https://capture.sidekick.test/events';
  for (const environment of ['production', undefined]) {
    const captureBodies = [];
    await withMockedFetch((call) => {
      if (call.url === captureUrl) {
        captureBodies.push(JSON.parse(call.init.body));
        return emptyResponse(204);
      }
      if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 1_000, tier_id: 'studio' }]);
      if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse([{ total_tokens: 25 }]);
      if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
        return jsonResponse({
          id: 'chatcmpl_capture_gate',
          choices: [{ message: { role: 'assistant', content: 'done', model: MODEL } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      }
      if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') return jsonResponse([{ id: 'usage_capture_gate' }], 201);
      throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
    }, async () => {
      const response = await worker.fetch(chatCompletionRequest({ max_tokens: 20 }), {
        ...LIVE_ENV,
        SIDEKICK_DEBUG_CAPTURE_URL: captureUrl,
        ...(environment === undefined ? {} : { SIDEKICK_ENVIRONMENT: environment }),
      });
      assert.equal(response.status, 200);
      assert.equal(captureBodies.length, 0,
        `capture must stay OFF when SIDEKICK_ENVIRONMENT is ${environment ?? 'unset'} even with the sink URL configured`);
    });
  }
});

test('worker returns 402 before model traffic when monthly capacity is reached or request exceeds remaining capacity', async () => {
  const scenarios = [
    {
      name: 'hard-limited studio snapshot',
      quotaRows: [{ monthly_token_quota: 100, tier_id: 'studio' }],
      eventRows: [{ total_tokens: 100 }],
      maxTokens: 10,
      expectedBody: {
        error: "You've used this month's included assistant time, so I've paused new tasks for now.",
        reason: 'tier_limit_exceeded',
        tier: 'studio',
        used: 100,
        limit: 100,
        remaining: 0,
        requested: 49,
      },
    },
    {
      name: 'pro-office request exceeds remaining capacity',
      quotaRows: [{ monthly_token_quota: 100, tier_id: 'pro-office' }],
      eventRows: [{ total_tokens: 85 }],
      maxTokens: 16,
      expectedBody: {
        error: "You've used this month's included assistant time, so I've paused new tasks for now.",
        reason: 'tier_limit_exceeded',
        tier: 'pro-office',
        used: 85,
        limit: 100,
        remaining: 15,
        requested: 77,
      },
    },
    {
      name: 'unsafe provider-like tier is not echoed',
      quotaRows: [{ monthly_token_quota: 100, tier_id: 'openrouter' }],
      eventRows: [{ total_tokens: 100 }],
      maxTokens: 10,
      expectedBody: {
        error: "You've used this month's included assistant time, so I've paused new tasks for now.",
        reason: 'tier_limit_exceeded',
        tier: null,
        used: 100,
        limit: 100,
        remaining: 0,
        requested: 49,
      },
    },
    {
      name: 'absent tier is reported as null',
      quotaRows: [{ monthly_token_quota: 100 }],
      eventRows: [{ total_tokens: 100 }],
      maxTokens: 10,
      expectedBody: {
        error: "You've used this month's included assistant time, so I've paused new tasks for now.",
        reason: 'tier_limit_exceeded',
        tier: null,
        used: 100,
        limit: 100,
        remaining: 0,
        requested: 49,
      },
    },
    {
      name: 'non-string tier is reported as null',
      quotaRows: [{ monthly_token_quota: 100, tier_id: { provider: 'openrouter' } }],
      eventRows: [{ total_tokens: 100 }],
      maxTokens: 10,
      expectedBody: {
        error: "You've used this month's included assistant time, so I've paused new tasks for now.",
        reason: 'tier_limit_exceeded',
        tier: null,
        used: 100,
        limit: 100,
        remaining: 0,
        requested: 49,
      },
    },
  ];

  for (const scenario of scenarios) {
    await withMockedFetch((call) => {
      // [Batch 4a §2.5.3] subscriptions (cycle anchor) + delegent_billing_guard
      // (org pause) return safely-empty so this test exercises the per-user
      // 402 path unchanged. usage_violations POST is best-effort audit; let
      // it succeed silently.
      if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
      if (call.url.includes('/rest/v1/delegent_billing_guard')) return jsonResponse([]);
      if (call.url.includes('/rest/v1/usage_violations') && requestMethod(call) === 'POST') {
        return new Response(null, { status: 201 });
      }
      if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse(scenario.quotaRows);
      if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse(scenario.eventRows);
      throw new Error(`${scenario.name} should not call ${requestMethod(call)} ${call.url}`);
    }, async (calls) => {
      const response = await worker.fetch(chatCompletionRequest({ max_tokens: scenario.maxTokens }), LIVE_ENV);
      const responseText = await response.text();

      assert.equal(response.status, 402, scenario.name);
      const parsed = JSON.parse(responseText);
      // Strip the QuotaPauseResponse `pause` envelope (Batch 4a addition)
      // before deep-equal so the per-tier expectedBody assertions remain
      // tight on the legacy fields. The pause envelope is validated
      // separately below.
      const { pause, ...legacyFields } = parsed;
      assert.deepEqual(legacyFields, scenario.expectedBody, scenario.name);
      assert.ok(pause, `${scenario.name}: pause envelope present`);
      assert.equal(pause.capKind, 'token', scenario.name);
      assert.equal(pause.reason, 'tier_limit_exceeded', scenario.name);
      assert.ok(
        calls.some((c) => /\/rest\/v1\/usage_quotas/.test(c.url) && /select=monthly_token_quota,tier_id/.test(decodeURIComponent(c.url))),
        `${scenario.name}: usage_quotas read with expected select`,
      );
      assert.ok(
        calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'GET'),
        `${scenario.name}: token_usage_events read pre-call`,
      );
      assert.equal(
        calls.some((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions'),
        false,
        `${scenario.name}: never reaches OpenRouter`,
      );
      assert.equal(
        calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'POST'),
        false,
        `${scenario.name}: never persists a usage event for a blocked send`,
      );
      assertBodyIsSafe(responseText);
    });
  }
});

test('worker fails closed before model traffic when the usage snapshot cannot be fetched', async () => {
  await withMockedFetch((call) => {
    // [Batch 4a §2.5.3] subscriptions read for the cycle anchor may run
    // before usage_quotas; let it return safely-empty so the 503 path
    // proven below is specifically the usage_quotas failure, not a
    // cascading subscriptions failure.
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) {
      return jsonResponse({ error: `Supabase ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}` }, 500);
    }
    throw new Error(`usage snapshot failure should not call ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(chatCompletionRequest({ max_tokens: 10 }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 503);
    assert.ok(calls.some((c) => /\/rest\/v1\/usage_quotas/.test(c.url)));
    assert.equal(
      calls.some((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions'),
      false,
      'usage-snapshot failure must NOT reach OpenRouter',
    );
    assertBodyIsSafe(responseText);
  });
});

test('worker skips malformed usage-event rows and proceeds with the snapshot rather than locking the user out', async () => {
  // One bad row should not fail-closed the entire user. We assert the snapshot
  // tolerates malformed rows by skipping them and using the valid rows' totals.
  // The request is then either allowed (proceeds to OpenRouter) or 402'd by
  // quota math, never 503'd by the snapshot itself.
  const scenarios = [
    { name: 'non-numeric total_tokens string', eventRows: [{ total_tokens: 'not-a-number' }, { total_tokens: 100 }] },
    { name: 'missing total_tokens field', eventRows: [{}, { total_tokens: 100 }] },
    { name: 'non-record usage row', eventRows: ['not-a-row', { total_tokens: 100 }] },
    { name: 'all rows malformed (treated as zero used)', eventRows: [{}, ['x'], { total_tokens: -1 }] },
  ];

  for (const scenario of scenarios) {
    await withMockedFetch((call) => {
      if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100, tier_id: 'studio' }]);
      if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse(scenario.eventRows);
      // The snapshot tolerated the bad rows, so we expect to hit either OpenRouter or the 402 gate.
      // In this test we put the request right at the gate so the test stays hermetic without OpenRouter mocks.
      throw new Error(`${scenario.name} should not reach ${requestMethod(call)} ${call.url}`);
    }, async () => {
      // max_tokens=200 + non-trivial prompt > remaining 0 in the all-malformed case but
      // strictly within remaining for the others (total used = 100, remaining = 0; budget > 0 -> 402).
      const response = await worker.fetch(chatCompletionRequest({
        max_tokens: 200,
        messages: [{ role: 'user', content: 'capacity probe' }],
      }), LIVE_ENV);
      assert.notEqual(response.status, 503, `${scenario.name} should not 503 due to malformed rows`);
      // 402 is the expected outcome here because the request budget exceeds remaining capacity.
      assert.equal(response.status, 402, scenario.name);
      const responseText = await response.text();
      assert.equal(responseText.includes('not-a-number'), false, scenario.name);
      assertBodyIsSafe(responseText);
    });
  }
});

test('buildOpenRouterPayload rejects oversized message arrays before any quota or model fetch', () => {
  // Too many messages. Derived from the constant so a cap re-size can't
  // silently turn this into a pass-through.
  const tooMany = Array.from({ length: MAX_REQUEST_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }));
  assert.throws(() => buildOpenRouterPayload({ messages: tooMany }), /messages array too large/);

  // Total content size exceeded (one giant message).
  const huge = 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1024);
  assert.throws(() => buildOpenRouterPayload({ messages: [{ role: 'user', content: huge }] }), /messages content too large/);

  // Total content size exceeded across many small parts.
  const partBytes = 64 * 1024;
  const manyParts = Array.from({ length: Math.ceil(MAX_REQUEST_CONTENT_BYTES / partBytes) + 1 }, () => ({
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(partBytes) }],
  }));
  assert.throws(() => buildOpenRouterPayload({ messages: manyParts }), /messages content too large/);
});

test('2026-07-04 REGRESSION: a long-lived coworker session (300 msgs, ~75K tokens) passes shape validation', () => {
  // The exact incident shape: a durable Route B session that crossed the OLD
  // 256-message cap mid-task and bricked every subsequent turn. The caps are
  // DoS bounds and must sit above Hermes' context-compressor trigger, never
  // below a session the compressor has not yet compacted.
  const incidentShaped = Array.from({ length: 300 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(1_000), // ~250 estimated tokens each, ~75K total
  }));
  const payload = buildOpenRouterPayload({ messages: incidentShaped });
  assert.equal(Array.isArray(payload.messages), true);
});

test('worker rejects oversized requests with a 400 before the quota or model fetch runs', async () => {
  await withMockedFetch(() => {
    throw new Error('oversized requests must not reach Supabase or OpenRouter');
  }, async (calls) => {
    const huge = 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1024);
    const response = await worker.fetch(chatCompletionRequest({
      messages: [{ role: 'user', content: huge }],
    }), LIVE_ENV);
    assert.equal(response.status, 400);
    const responseText = await response.text();
    assert.match(responseText, /messages content too large/);
    assert.equal(calls.length, 0);
    assertBodyIsSafe(responseText);
  });
});

test('worker includes a conservative prompt estimate in the monthly capacity gate', async () => {
  await withMockedFetch((call) => {
    // [Batch 4a §2.5.3] safely-empty cycle/guard reads + accept the
    // best-effort usage_violations POST.
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/delegent_billing_guard')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/usage_violations') && requestMethod(call) === 'POST') {
      return new Response(null, { status: 201 });
    }
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100, tier_id: 'enterprise-suite' }]);
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse([{ total_tokens: 50 }]);
    throw new Error(`prompt-budget gate should not call ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(chatCompletionRequest({
      max_tokens: 50,
      messages: [{ role: 'user', content: 'This prompt has a nonzero estimated token cost.' }],
    }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 402);
    const parsed = JSON.parse(responseText);
    const { pause, ...legacyFields } = parsed;
    assert.deepEqual(legacyFields, {
      error: "You've used this month's included assistant time, so I've paused new tasks for now.",
      reason: 'tier_limit_exceeded',
      tier: 'enterprise-suite',
      used: 50,
      limit: 100,
      remaining: 50,
      requested: 247,
    });
    assert.ok(pause, 'pause envelope present');
    assert.equal(pause.capKind, 'token');
    assert.ok(
      calls.some((c) => /\/rest\/v1\/usage_quotas/.test(c.url) && /select=monthly_token_quota,tier_id/.test(decodeURIComponent(c.url))),
    );
    assert.ok(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'GET'),
    );
    assert.equal(calls.some((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions'), false);
    assert.equal(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'POST'),
      false,
      'no usage event persisted for a blocked send',
    );
    assertBodyIsSafe(responseText);
  });
});

test('worker returns a safe 503 when usage persistence fails after a successful model response', async () => {
  await withMockedFetch((call) => {
    // [Batch 4a §2.5.3] safely-empty cycle/guard reads.
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/delegent_billing_guard')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 1_000 }]);
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse([{ total_tokens: 100 }]);

    if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
      return jsonResponse({
        id: 'chatcmpl_persist_failure',
        model: MODEL,
        provider: { name: 'openrouter', leaked: LIVE_ENV.OPENROUTER_API_KEY },
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'POST') {
      return jsonResponse({ error: `Supabase ${LIVE_ENV.SUPABASE_SERVICE_ROLE_KEY}` }, 500);
    }

    throw new Error(`unexpected fetch: ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(chatCompletionRequest({ max_tokens: 100 }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 503);
    assert.equal(
      calls.filter((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions').length,
      1,
      'OpenRouter was called exactly once before persistence failed',
    );
    assert.ok(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'POST'),
      'usage-event insert was attempted post-call',
    );
    assert.equal(responseText.includes('chatcmpl_persist_failure'), false);
    assert.equal(responseText.includes(MODEL), false);
    assertBodyIsSafe(responseText);
  });
});

test('worker returns a safe 502 when the upstream model fetch rejects', async () => {
  await withMockedFetch((call) => {
    // [Batch 4a §2.5.3] safely-empty cycle/guard reads.
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/delegent_billing_guard')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 1_000 }]);
    if (call.url.includes('/rest/v1/token_usage_events') && requestMethod(call) === 'GET') return jsonResponse([{ total_tokens: 100 }]);

    if (call.url === 'https://openrouter.ai/api/v1/chat/completions') {
      throw new Error(`OpenRouter transport failed ${LIVE_ENV.OPENROUTER_API_KEY}`);
    }

    throw new Error(`upstream rejection should not call ${requestMethod(call)} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(chatCompletionRequest({ max_tokens: 100 }), LIVE_ENV);
    const responseText = await response.text();

    assert.equal(response.status, 502);
    assert.equal(
      calls.filter((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions').length,
      1,
      'upstream reach attempted exactly once',
    );
    assert.equal(
      calls.some((c) => /\/rest\/v1\/token_usage_events/.test(c.url) && requestMethod(c) === 'POST'),
      false,
      'no usage event persisted when upstream rejects',
    );
    assertBodyIsSafe(responseText);
  });
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03: a Route B placeholder is never orphaned.
// ---------------------------------------------------------------------------
// The runner advertised run submission, so the webhook queued an assistant
// placeholder, but /v1/delegent/message answered 404 (plugin not rolled out on
// that box). The legacy /tasks path then wrote its OWN reply, and the queued
// placeholder sat in the app's chat as an empty "thinking" bubble forever:
// nothing finalizes it, and the sweeper never sees it because the task_runs
// row completes via legacy. The webhook must delete it, filtered on
// status=queued, before falling through.
test('telegram live webhook finalizes a refused Route B run without stateless fallback', async () => {
  await withMockedFetch(async (call) => {
    const method = requestMethod(call);
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/profiles')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) {
      return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_rb', message_id: 'message_rb', gateway_task_event_id: 'gateway_event_rb' }]);
    }
    if (call.url === 'https://runner.sidekick.dev/v1/capabilities') {
      return jsonResponse({ available: true, features: { run_submission: true, run_events_sse: true } });
    }
    if (call.url.includes('/rest/v1/messages') && method === 'POST') {
      const body = JSON.parse(call.init.body);
      // the Route B placeholder (queued, keyed on task_run_id) vs the legacy reply
      if (body.status === 'queued' && body.task_run_id === 'task_run_rb') return jsonResponse([{ id: 'placeholder_rb' }], 201);
      return jsonResponse([{ id: 'legacy_reply_rb' }], 201);
    }
    if (call.url.includes('/rest/v1/messages') && method === 'DELETE') return jsonResponse([], 204);
    if (call.url === 'https://runner.sidekick.dev/v1/delegent/message') {
      // Capabilities said yes, the endpoint says no: the plugin is not live on this box.
      return jsonResponse({ error: 'not_found' }, 404);
    }
    if (call.url.includes('/rest/v1/task_runs') && method === 'PATCH') return jsonResponse([{ id: 'task_run_rb' }]);
    if (call.url.includes('/rest/v1/artifacts') && method === 'POST') return jsonResponse([{ id: 'artifact_rb' }], 201);
    if (call.url === 'https://runner.sidekick.dev/tasks') {
      return jsonResponse({ task_id: 'runner_task_rb', status: 'completed', result: 'Done via legacy.' }, 200);
    }
    if (call.url.includes('/rpc/finalize_chat_message')) return jsonResponse(true);
    if (call.url.includes('/rest/v1/task_runs') && method === 'GET') return jsonResponse([]);
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected Route B fallback fetch: ${method} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2190,
      messageId: 3190,
      chatId: 4190,
      text: 'Plan my week.',
    })), enabledTelegramLiveEnv({ SIDEKICK_CHAT_ROUTE_B_ENABLED: 'true' }));
    const responseText = await response.text();

    assert.equal(response.status, 200, responseText);
    assert.equal(JSON.parse(responseText).kind, 'runner_unreachable');
    assert.equal(calls.filter(c => c.url === 'https://runner.sidekick.dev/v1/delegent/message').length, 1);
    assert.equal(calls.some(c => c.url === 'https://runner.sidekick.dev/tasks'), false);
    const finalize = calls.find(c => c.url.includes('/rpc/finalize_chat_message'));
    assert.equal(JSON.parse(finalize.init.body).p_succeeded, false);
    assert.equal(JSON.parse(finalize.init.body).p_error_code, 'runner_unreachable');
    assertBodyIsSafe(responseText);
  });
});

test('telegram live webhook with Route B OFF never probes capabilities or queues a placeholder', async () => {
  await withMockedFetch(async (call) => {
    const method = requestMethod(call);
    if (call.url.includes('/rest/v1/gateway_connections')) return jsonResponse([{ user_id: 'user_bound' }]);
    if (call.url.includes('/rest/v1/subscriptions')) return jsonResponse([{ status: 'active' }]);
    if (call.url.includes('/rest/v1/usage_quotas')) return jsonResponse([{ monthly_token_quota: 100_000, tier_id: 'studio' }]);
    if (call.url.includes('/rest/v1/token_usage_events')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/hermes_instances')) return jsonResponse([readyHermesInstance()]);
    if (call.url.includes('/rest/v1/hermes_instance_private')) return jsonResponse([{ runner_base_url: 'https://runner.sidekick.dev' }]);
    if (call.url.includes('/rest/v1/profiles')) return jsonResponse([]);
    if (call.url.includes('/rest/v1/rpc/claim_gateway_task_event')) return jsonResponse([{ kind: 'accepted', task_run_id: 'task_run_off' }]);
    if (call.url === 'https://runner.sidekick.dev/tasks') return jsonResponse({ status: 'completed', result: 'Done.' });
    if (call.url.includes('/rest/v1/task_runs') || call.url.includes('/rest/v1/messages') || call.url.includes('/rest/v1/artifacts')) {
      if (call.url.includes('/rest/v1/messages') && method === 'POST' && JSON.parse(call.init.body).status === 'queued') {
        throw new Error('no placeholder may be queued while Route B is off');
      }
      return jsonResponse([{ id: 'opaque' }], 201);
    }
    if (call.url === TELEGRAM_SEND_MESSAGE_URL) return telegramSendMessageResponse();
    throw new Error(`unexpected Route B OFF fetch: ${method} ${call.url}`);
  }, async (calls) => {
    const response = await worker.fetch(telegramLiveWebhookRequest(telegramTextUpdate({
      updateId: 2191, messageId: 3191, chatId: 4191, text: 'Plan my week.',
    })), enabledTelegramLiveEnv());
    assert.equal(response.status, 202);
    assert.equal(calls.some((c) => c.url === 'https://runner.sidekick.dev/v1/capabilities'), false, 'no capabilities probe');
    assert.equal(calls.some((c) => c.url === 'https://runner.sidekick.dev/v1/delegent/message'), false);
    assert.equal(calls.some((c) => requestMethod(c) === 'DELETE'), false, 'nothing to clean up');
  });
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03 (D1): account deletion stops the billing too.
// ---------------------------------------------------------------------------
// The auth user is deleted in the same request and profiles cascades to
// subscriptions, so the Stripe ids were gone the moment anyone could have
// used them, and a deleted customer kept being charged. The handler now reads
// the subscription FIRST, cancels at Stripe immediately for Stripe customers,
// aborts the whole deletion if Stripe refuses, and tells App Store customers
// where to cancel because we cannot do it for them.
function accountDeleteFlowMock({ userId, subscriptionRow, stripe }) {
  const stripeCalls = [];
  const handler = (call) => {
    const method = requestMethod(call);
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: userId, email: 'leaver@example.test', user_metadata: { full_name: 'Leaver' } });
    }
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/admin/users/${userId}`) {
      assert.equal(method, 'DELETE');
      return emptyResponse(200);
    }
    if (call.url.startsWith('https://api.stripe.com/v1/subscriptions/')) {
      stripeCalls.push(call);
      assert.equal(method, 'DELETE', 'an immediate cancel is a DELETE on the subscription');
      return stripe(call);
    }
    const url = new URL(call.url);
    if (url.origin === LIVE_ENV.SUPABASE_URL && url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '');
      if (method === 'GET') {
        if (table === 'subscriptions') {
          assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
          assert.match(url.searchParams.get('select') ?? '', /billing_provider/);
          assert.match(url.searchParams.get('select') ?? '', /stripe_subscription_id/);
          return jsonResponse(subscriptionRow ? [subscriptionRow] : []);
        }
        if (table === 'hermes_instances') return jsonResponse([{ user_id: userId, provider: 'fly_machines', status: 'ready' }]);
        if (table === 'hermes_instance_private') return jsonResponse([{ provider: 'fly_machines', fly_app_name: 'delegent-user-leaver' }]);
      }
      if (table === 'rpc/open_account_deletion_request') {
        const sent = JSON.parse(call.init.body);
        return jsonResponse([{ id: 'delete_req_leaver', status: 'requested', requested_at: sent.p_at, teardown_by: sent.p_teardown_by }]);
      }
      if (table === 'rpc/record_account_deletion_origin_progress') return jsonResponse(true);
      if (table === 'provisioning_events' && method === 'POST') return emptyResponse();
    }
    throw new Error(`unexpected fetch: ${method} ${call.url}`);
  };
  return { handler, stripeCalls };
}

const DELETE_FLOW_ENV = { ...STRIPE_ENV };

test('account delete cancels a Stripe subscription immediately, before the auth user goes, and says so', async () => {
  const userId = '55555555-5555-4555-8555-555555555555';
  const { handler, stripeCalls } = accountDeleteFlowMock({
    userId,
    subscriptionRow: { billing_provider: 'stripe', provider: 'stripe', status: 'active', stripe_subscription_id: 'sub_leaver_1' },
    stripe: () => jsonResponse({ id: 'sub_leaver_1', object: 'subscription', status: 'canceled' }),
  });
  await withMockedFetch(handler, async (calls) => {
    const response = await worker.fetch(accountDeleteRequest({ authorization: 'Bearer user_access_token' }), DELETE_FLOW_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const body = JSON.parse(responseText);
    assert.equal(body.ok, true);
    assert.deepEqual(body.billing, { source:'stripe', cancelled: true });
    assert.match(body.message, /subscription has been cancelled/);
    assert.ok(body.message.length <= 220, 'the app drops the payload past 220 chars');

    assert.equal(stripeCalls.length, 1);
    assert.equal(stripeCalls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_leaver_1');
    const stripeIdx = calls.findIndex((c) => c.url.startsWith('https://api.stripe.com/'));
    const requestIdx = calls.findIndex((c) => c.url.includes('/rpc/open_account_deletion_request'));
    const authDeleteIdx = calls.findIndex((c) => c.url.endsWith(`/auth/v1/admin/users/${userId}`));
    assert.ok(stripeIdx >= 0 && stripeIdx < requestIdx, 'billing is released before any deletion write');
    assert.ok(authDeleteIdx > stripeIdx, 'the auth user is removed only after Stripe has stopped billing');

    const audit = calls.find((c) => c.url.includes('/rest/v1/provisioning_events') && requestMethod(c) === 'POST');
    assert.ok(audit, 'the deletion audit row is written');
    assert.deepEqual(JSON.parse(audit.init.body).details.billing, { provider: 'stripe', stripe_cancelled: true });
    assertBodyIsSafe(responseText);
  });
});

test('account delete for an App Store subscriber never calls Stripe and tells them where to cancel', async () => {
  const userId = '56565656-5656-4565-8565-565656565656';
  const { handler, stripeCalls } = accountDeleteFlowMock({
    userId,
    subscriptionRow: { billing_provider: 'apple', provider: 'stripe', status: 'active', stripe_subscription_id: null },
    stripe: () => { throw new Error('Stripe must not be called for an Apple subscriber'); },
  });
  await withMockedFetch(handler, async () => {
    const response = await worker.fetch(accountDeleteRequest({ authorization: 'Bearer user_access_token' }), DELETE_FLOW_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const body = JSON.parse(responseText);
    assert.deepEqual(body.billing, { source:'apple', cancelled: false });
    assert.match(body.message, /App Store subscription is not cancelled automatically/);
    assert.match(body.message, /Apple ID/);
    assert.ok(body.message.length <= 220, 'the app drops the payload past 220 chars');
    assert.equal(stripeCalls.length, 0);
    assertBodyIsSafe(responseText);
  });
});

test('account delete ABORTS with 503 and deletes nothing when Stripe refuses the cancel', async () => {
  const userId = '57575757-5757-4575-8575-575757575757';
  const { handler } = accountDeleteFlowMock({
    userId,
    subscriptionRow: { billing_provider: 'stripe', status: 'active', stripe_subscription_id: 'sub_leaver_3' },
    // A rotated key: Stripe answers 401, which the SDK does not retry.
    stripe: () => jsonResponse({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, 401),
  });
  await withMockedFetch(handler, async (calls) => {
    const response = await worker.fetch(accountDeleteRequest({ authorization: 'Bearer user_access_token' }), DELETE_FLOW_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 503, responseText);
    assert.deepEqual(JSON.parse(responseText), { error: 'account_delete_unavailable', reason: 'billing_release_failed' });
    assert.equal(calls.some((c) => c.url.includes('/rpc/open_account_deletion_request')), false, 'no deletion request opened');
    assert.equal(calls.some((c) => c.url.endsWith(`/auth/v1/admin/users/${userId}`)), false, 'the auth user is untouched');
    assertBodyIsSafe(responseText);
  });
});

test('account delete treats a subscription Stripe already cancelled as nothing left to stop', async () => {
  const userId = '58585858-5858-4585-8585-585858585858';
  const { handler, stripeCalls } = accountDeleteFlowMock({
    userId,
    subscriptionRow: { billing_provider: 'stripe', status: 'active', stripe_subscription_id: 'sub_leaver_4' },
    stripe: () => jsonResponse({ error: { type: 'invalid_request_error', message: 'This subscription is already canceled.' } }, 400),
  });
  await withMockedFetch(handler, async (calls) => {
    const response = await worker.fetch(accountDeleteRequest({ authorization: 'Bearer user_access_token' }), DELETE_FLOW_ENV);
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const body = JSON.parse(responseText);
    assert.deepEqual(body.billing, { source:'stripe', cancelled: false });
    assert.match(body.message, /^Your account has been deleted\. Your workspace/);
    assert.equal(stripeCalls.length, 1);
    assert.equal(calls.some((c) => c.url.endsWith(`/auth/v1/admin/users/${userId}`)), true, 'deletion proceeds');
  });
});

// ---------------------------------------------------------------------------
// Defect hunt 2026-09-03 (D7): the Files API never wakes a paused workspace.
// ---------------------------------------------------------------------------
// The binding used to be built from the private row alone, so a sleeping
// (suspended) workspace whose runner_base_url was still on file produced a
// signed request to the runner. Fly auto-starts a stopped machine on the
// first request, so opening the Files tab woke a lapsed user's machine. The
// binding is now gated on hermes_instances.status === 'ready', the same rule
// the chat dispatch path applies.
function pausedWorkspaceFetch(userId, retentionUntil) {
  return async (call) => {
    if (call.url === `${LIVE_ENV.SUPABASE_URL}/auth/v1/user`) return jsonResponse({ id: userId, email: 'alex@example.test' });
    if (call.url.includes('/rest/v1/hermes_instances')) {
      return jsonResponse([{ status: 'sleeping', suspended_at: '2026-08-01T00:00:00.000Z', volume_retention_until: retentionUntil, deleted_at: null }]);
    }
    if (call.url.includes('/rest/v1/hermes_instance_private')) {
      // Everything the host gate wants is present and consistent: only the
      // workspace status stands between this row and a runner call.
      return jsonResponse([{
        runner_base_url: 'https://delegent-runner-paused.fly.dev',
        runner_shared_secret: 'runner_private_file_secret',
        provider: 'fly_machines',
        fly_app_name: 'delegent-runner-paused',
      }]);
    }
    throw new Error(`a paused workspace must not be woken: ${requestMethod(call)} ${call.url}`);
  };
}

test('worker runner files list on a PAUSED workspace never touches the runner even though the private row is live', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const retentionUntil = '2099-06-22T09:00:00.000Z';
  await withMockedFetch(pausedWorkspaceFetch(userId, retentionUntil), async (calls) => {
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      headers: { authorization: 'Bearer app_access_token' },
    }), { ...LIVE_ENV, SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret' });
    const responseText = await response.text();
    const payload = JSON.parse(responseText);
    assert.equal(response.status, 200, responseText);
    assert.equal(payload.ok, true);
    assert.equal(payload.storageStatus, 'not_ready');
    assert.equal(payload.retentionUntil, retentionUntil);
    assert.match(payload.publicMessage, /paused/i);
    assert.equal(calls.some((c) => c.url.includes('fly.dev')), false, 'no request reaches the runner host');
    assertBodyIsSafe(responseText);
  });
});

test('worker runner files upload on a PAUSED workspace never wakes the runner', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  await withMockedFetch(pausedWorkspaceFetch(userId, '2099-06-22T09:00:00.000Z'), async (calls) => {
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer app_access_token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'notes.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }),
    }), { ...LIVE_ENV, SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret' });
    const responseText = await response.text();
    const payload = JSON.parse(responseText);
    assert.equal(response.status, 200, responseText);
    assert.equal(payload.storageStatus, 'not_ready');
    assert.equal(calls.some((c) => c.url.includes('fly.dev')), false, 'no request reaches the runner host');
    assertBodyIsSafe(responseText);
  });
});
