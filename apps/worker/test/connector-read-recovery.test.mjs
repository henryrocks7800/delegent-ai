import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConnectionList, handleConnectionDisconnect, handleRunnerConnectionList, handleRunnerConnectionToken, listBrokeredConnections } from '../dist/connections-oauth.js';
import { buildDelegentDispatchText, buildHermesRunInstructions } from '../dist/index.js';

const USER = '3f1c2a54-9d0b-4c8e-a1f6-7b2e5d4c3a90';
const ENV = { SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-role', SIDEKICK_CONNECTIONS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), SIDEKICK_FREEAGENT_CLIENT_ID: 'test-client', SIDEKICK_FREEAGENT_CLIENT_SECRET: 'test-secret' };
const COMPOSIO = { provider: 'gmail', displayName: 'Gmail', status: 'connected', accountLabel: null, backend: 'composio', toolkit: 'gmail' };
const tokenRequest = () => new Request('https://worker.test/api/runner/connections/token', { method: 'POST', body: JSON.stringify({ provider: 'freeagent' }) });

function storage(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.pathname === '/auth/v1/user') return Response.json({ id: USER });
    assert.equal(url.origin, ENV.SUPABASE_URL);
    assert.equal(url.searchParams.get('user_id'), `eq.${USER}`);
    return reply();
  });
  return calls;
}

for (const [name, reply] of [
  ['HTTP 503', () => new Response(null, { status: 503 })],
  ['transport error', () => { throw new Error('network failure'); }],
  ['invalid JSON', () => new Response('{')],
  ['wrong envelope', () => Response.json({ data: [] })],
  ['invalid row', () => Response.json([null])],
  ['unknown status', () => Response.json([{ provider: 'freeagent', status: 'surprise' }])],
]) {
  test(`${name} remains unknown across native list, token, chat instructions and disconnect`, async (t) => {
    const calls = storage(t, reply);
    const native = await listBrokeredConnections(ENV, USER);
    assert.equal(native, null);
    const runner = await handleRunnerConnectionList(ENV, USER, { connections: [COMPOSIO], unavailable: false });
    assert.equal(runner.status, 200);
    assert.deepEqual(await runner.json(), { connections: [COMPOSIO], nativeUnavailable: true });
    const token = await handleRunnerConnectionToken(tokenRequest(), ENV, USER);
    assert.equal(token.status, 503);
    assert.deepEqual(await token.json(), { error: 'connections_unreadable' });
    const authed = new Request('https://worker.test/api/connections/oauth', { headers: { authorization: 'Bearer test' } });
    assert.equal((await handleConnectionList(authed, ENV)).status, 502);
    assert.equal((await handleConnectionDisconnect(authed, ENV, 'freeagent')).status, 502);
    assert.ok(calls.every(c => c.method === 'GET'), 'unknown state must not refresh, revoke or delete');
    for (const text of [buildDelegentDispatchText('check my accounts', new Date(), native).text, buildHermesRunInstructions('Ruben', native)]) {
      assert.match(text, /temporary read failure/);
      assert.match(text, /Do not ask the user to reconnect because of this read failure/);
      assert.match(text, /continue independent work/);
    }
  });
}

test('confirmed absence, revocation and lapsed sign-in remain different from an outage', async (t) => {
  let rows = [];
  storage(t, () => Response.json(rows));
  assert.deepEqual(await listBrokeredConnections(ENV, USER), []);
  assert.deepEqual(await (await handleRunnerConnectionList(ENV, USER)).json(), { connections: [] });
  for (const [value, status, error] of [[[], 404, 'not_connected'], [[{ status: 'revoked' }], 404, 'not_connected'], [[{ status: 'needs_reauth' }], 409, 'needs_reauth']]) {
    rows = value;
    const response = await handleRunnerConnectionToken(tokenRequest(), ENV, USER);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(buildDelegentDispatchText('/stop', new Date(), null).text, '/stop');
});

test('a Composio outage retains the verified native inventory and marks only Composio unknown', async (t) => {
  storage(t, () => Response.json([{ provider: 'freeagent', status: 'connected', account_label: 'Company' }]));
  const response = await handleRunnerConnectionList(ENV, USER, { connections: [], unavailable: true });
  const body = await response.json();
  assert.equal(body.composioUnavailable, true);
  assert.equal(body.nativeUnavailable, undefined);
  assert.deepEqual(body.connections, [{ provider: 'freeagent', displayName: 'FreeAgent', status: 'connected', accountLabel: 'Company', backend: 'native' }]);
});

test('a failed re-read while another call owns refresh is unknown, not missing', async (t) => {
  const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
  const iv = Buffer.alloc(12, 5);
  const encrypted = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from('test-refresh')));
  const token = `v1.${iv.toString('base64')}.${encrypted.toString('base64')}`;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/claim_native_connection_refresh')) return Response.json('busy');
    assert.equal(url.pathname, '/rest/v1/user_connections');
    if (++reads > 1) return new Response(null, { status: 503 });
    return Response.json([{ status: 'connected', credential_version: USER, refresh_token_enc: token, access_expires_at: '2020-01-01T00:00:00Z' }]);
  });
  const response = await handleRunnerConnectionToken(tokenRequest(), ENV, USER);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'connections_unreadable' });
  assert.equal(reads, 2);
});

test('a stalled database response body reaches a bounded unknown outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  storage(t, () => new Response(new ReadableStream({ start() {} })));
  const pending = handleRunnerConnectionList(ENV, USER);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_001);
  const response = await pending;
  assert.deepEqual(await response.json(), { connections: [], nativeUnavailable: true });
});
