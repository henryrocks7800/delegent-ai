import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  handleMessagingProviderDisconnectRequest,
  type AuthenticatedMessagingUser,
  type MessagingConnectionServerEnv,
  type MessagingProviderConnectionStore,
} from '../lib/server/messagingConnectionFlow';

const userId = '11111111-1111-4111-8111-111111111111';
const readyEnv: MessagingConnectionServerEnv = {
  SUPABASE_URL: 'https://sidekick-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon_test_key',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_key',
};

function disconnectRequest(body: unknown = { providerId: 'telegram' }, headers: Record<string, string> = { authorization: 'Bearer access_token' }) {
  return new Request('https://dashboard.sidekick.example/api/gateways/messaging/disconnect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

class InMemoryMessagingConnectionStore implements MessagingProviderConnectionStore {
  readonly disconnects: Array<{ userId: string; providerId: 'telegram' | 'whatsapp' | 'signal' | null }> = [];
  nextProviderId: 'telegram' | 'whatsapp' | 'signal' | null = 'telegram';
  fail = false;

  async disconnectActiveProvider(input: { userId: string; providerId?: 'telegram' | 'whatsapp' | 'signal' | null }) {
    if (this.fail) throw new Error('disconnect failed');
    const providerId = input.providerId ?? null;
    this.disconnects.push({ userId: input.userId, providerId });
    return this.nextProviderId ? { providerId: this.nextProviderId } : { providerId: null };
  }
}

function assertResponseSafe(text: string) {
  assert.doesNotMatch(text, /anon_test_key|service_role_test_key|access_token|11111111-1111-4111-8111-111111111111|source_conversation|chat:/i);
}

async function authenticatedUser(token: string): Promise<AuthenticatedMessagingUser | null> {
  assert.equal(token, 'access_token');
  return { id: userId };
}

test('messaging disconnect route requires server config and app authentication before service-role writes', async () => {
  const store = new InMemoryMessagingConnectionStore();
  const missingConfig = await handleMessagingProviderDisconnectRequest(disconnectRequest(), {
    env: { ...readyEnv, SUPABASE_SERVICE_ROLE_KEY: '' },
    store,
    async getAuthenticatedUser() {
      throw new Error('auth should not run before readiness passes');
    },
  });
  const missingConfigText = await missingConfig.text();
  assert.equal(missingConfig.status, 503);
  assert.deepEqual(JSON.parse(missingConfigText), {
    error: 'messenger_disconnect_unavailable',
    missing: ['SUPABASE_SERVICE_ROLE_KEY'],
  });
  assert.deepEqual(store.disconnects, []);
  assertResponseSafe(missingConfigText);

  const unauthenticated = await handleMessagingProviderDisconnectRequest(disconnectRequest({ providerId: 'telegram' }, {}), {
    env: readyEnv,
    store,
    async getAuthenticatedUser() {
      throw new Error('auth should not run without bearer token');
    },
  });
  const unauthenticatedText = await unauthenticated.text();
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(JSON.parse(unauthenticatedText), { error: 'unauthenticated' });
  assert.deepEqual(store.disconnects, []);
  assertResponseSafe(unauthenticatedText);
});

test('messaging disconnect route disconnects Telegram through a narrow provider RPC and returns consumer-safe copy', async () => {
  const store = new InMemoryMessagingConnectionStore();
  const response = await handleMessagingProviderDisconnectRequest(disconnectRequest({ providerId: 'telegram' }), {
    env: readyEnv,
    store,
    getAuthenticatedUser: authenticatedUser,
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(store.disconnects, [{ userId, providerId: 'telegram' }]);
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    providerId: 'telegram',
    kind: 'disconnected',
    publicMessage: 'Telegram is disconnected. You can reconnect it whenever you are ready.',
  });
  assertResponseSafe(text);
});

test('messaging disconnect route handles already-disconnected and invalid provider cases without private fields', async () => {
  const store = new InMemoryMessagingConnectionStore();
  store.nextProviderId = null;

  const none = await handleMessagingProviderDisconnectRequest(disconnectRequest({}), {
    env: readyEnv,
    store,
    getAuthenticatedUser: authenticatedUser,
  });
  const noneText = await none.text();
  assert.equal(none.status, 200);
  assert.deepEqual(JSON.parse(noneText), {
    ok: true,
    providerId: null,
    kind: 'already_disconnected',
    publicMessage: 'No messenger is connected right now.',
  });
  assert.deepEqual(store.disconnects, [{ userId, providerId: null }]);
  assertResponseSafe(noneText);

  const invalid = await handleMessagingProviderDisconnectRequest(disconnectRequest({ providerId: 'email' }), {
    env: readyEnv,
    store,
    getAuthenticatedUser: authenticatedUser,
  });
  const invalidText = await invalid.text();
  assert.equal(invalid.status, 400);
  assert.deepEqual(JSON.parse(invalidText), { error: 'unsupported_messenger' });
  assertResponseSafe(invalidText);
});

test('messaging switch RPC migration checks destination ownership before disconnecting the current provider', () => {
  // Normalise separators before the suffix test: on Windows process.cwd() ends
  // with "\apps\web", so a literal '/apps/web' check fails and the migration is
  // looked up under apps/web/supabase/... which does not exist.
  const cwdPosix = process.cwd().replace(/\\/g, '/');
  const migrationPath = resolve(process.cwd(), cwdPosix.endsWith('/apps/web') ? '../../supabase/migrations/0012_generic_messaging_provider_foundation.sql' : 'supabase/migrations/0012_generic_messaging_provider_foundation.sql');
  const migrationSource = readFileSync(migrationPath, 'utf8');
  const functionStartIndex = migrationSource.indexOf('create or replace function public.set_active_gateway_connection');
  const ownershipCheckMatch = /select\s+(?:public\.gateway_connections\.)?user_id\s+into\s+v_existing_user_id/.exec(
    migrationSource.slice(functionStartIndex),
  );
  const ownershipCheckIndex = ownershipCheckMatch
    ? functionStartIndex + ownershipCheckMatch.index
    : -1;
  const disconnectUpdateIndex = migrationSource.indexOf("update public.gateway_connections set status = 'disconnected'", ownershipCheckIndex);
  assert.notEqual(functionStartIndex, -1);
  assert.notEqual(ownershipCheckIndex, -1);
  assert.notEqual(disconnectUpdateIndex, -1);
  assert.equal(ownershipCheckIndex < disconnectUpdateIndex, true);
  assert.match(migrationSource, /create or replace function public\.disconnect_gateway_connection/);
  assert.match(migrationSource, /grant execute on function public\.disconnect_gateway_connection\(uuid, text\) to service_role/);
});
