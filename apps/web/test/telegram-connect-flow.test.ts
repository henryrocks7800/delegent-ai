import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTelegramConnectCode,
  handleTelegramConnectCodeRequest,
  type TelegramConnectCodeInsert,
  type TelegramConnectCodeStore,
  type TelegramConnectServerEnv,
} from '../lib/server/telegramConnectFlow';

const userId = '11111111-1111-4111-8111-111111111111';
const readyEnv: TelegramConnectServerEnv = {
  SUPABASE_URL: 'https://sidekick-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon_test_key',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_key',
  SIDEKICK_TELEGRAM_BOT_USERNAME: '@coworker_ai_bot',
  SIDEKICK_TELEGRAM_CONNECT_CODE_TTL_MINUTES: '15',
};

function postRequest(headers: Record<string, string> = {}) {
  return new Request('https://dashboard.sidekick.example/api/gateways/telegram/connect-code', {
    method: 'POST',
    headers,
  });
}

class InMemoryTelegramConnectCodeStore implements TelegramConnectCodeStore {
  readonly inserts: TelegramConnectCodeInsert[] = [];
  fail = false;

  async createConnectCode(input: TelegramConnectCodeInsert) {
    if (this.fail) throw new Error('insert failed');
    this.inserts.push({ ...input });
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertResponseSafe(text: string) {
  assert.doesNotMatch(text, /anon_test_key|service_role_test_key|access_token|11111111-1111-4111-8111-111111111111/i);
}

test('telegram connect-code route fails closed before auth when server config is incomplete', async () => {
  const store = new InMemoryTelegramConnectCodeStore();
  const response = await handleTelegramConnectCodeRequest(postRequest({ authorization: 'Bearer access_token' }), {
    env: { ...readyEnv, SUPABASE_SERVICE_ROLE_KEY: '' },
    store,
    async getAuthenticatedUser() {
      throw new Error('auth should not run before readiness passes');
    },
  });
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(store.inserts, []);
  assert.deepEqual(JSON.parse(text), {
    error: 'telegram_connect_unavailable',
    missing: ['SUPABASE_SERVICE_ROLE_KEY'],
  });
  assertResponseSafe(text);
});

test('telegram connect-code route requires an authenticated app user before issuing a code', async () => {
  const store = new InMemoryTelegramConnectCodeStore();
  const response = await handleTelegramConnectCodeRequest(postRequest(), {
    env: readyEnv,
    store,
    async getAuthenticatedUser() {
      throw new Error('auth should not run without a bearer token');
    },
  });
  const text = await response.text();

  assert.equal(response.status, 401);
  assert.deepEqual(store.inserts, []);
  assert.deepEqual(JSON.parse(text), { error: 'unauthenticated' });
  assertResponseSafe(text);
});

test('telegram connect-code route stores only a hash and returns a safe short-lived display code', async () => {
  const store = new InMemoryTelegramConnectCodeStore();
  const response = await handleTelegramConnectCodeRequest(postRequest({ authorization: 'Bearer access_token' }), {
    env: readyEnv,
    store,
    createCode: () => 'tg abc-123',
    now: () => 0,
    async getAuthenticatedUser(token) {
      assert.equal(token, 'access_token');
      return { id: userId };
    },
  });
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.deepEqual(store.inserts, [{
    user_id: userId,
    gateway_id: 'telegram',
    code_hash: sha256Hex('TGABC123'),
    expires_at: '1970-01-01T00:15:00.000Z',
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(store.inserts[0], 'code'), false);
  assert.deepEqual(body, {
    gatewayId: 'telegram',
    code: 'TG ABC-123',
    startParameter: 'TGABC123',
    expiresAt: '1970-01-01T00:15:00.000Z',
    botUsername: 'coworker_ai_bot',
    deepLink: 'https://t.me/coworker_ai_bot?start=TGABC123',
    instructions: 'Open Telegram and send /start TG ABC-123 to @coworker_ai_bot.',
  });
  assertResponseSafe(text);
});

test('telegram connect-code route does not return a code if private persistence fails', async () => {
  const store = new InMemoryTelegramConnectCodeStore();
  store.fail = true;
  const response = await handleTelegramConnectCodeRequest(postRequest({ authorization: 'Bearer access_token' }), {
    env: readyEnv,
    store,
    createCode: () => 'TGXYZ789',
    now: () => 0,
    async getAuthenticatedUser() {
      return { id: userId };
    },
  });
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(text), { error: 'telegram_connect_unavailable' });
  assert.equal(text.includes('TG XYZ-789'), false);
  assertResponseSafe(text);
});

test('telegram connect code generator emits normalized Telegram-safe codes', () => {
  for (let index = 0; index < 20; index += 1) {
    assert.match(createTelegramConnectCode(), /^TG[A-Z0-9]{6}$/);
  }
});
