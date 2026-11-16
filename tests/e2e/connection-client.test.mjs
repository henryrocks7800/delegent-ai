import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

// Execute both complete client modules and the browser's real apiFetch.
// Replace only auth, environment and HTTP boundaries, never source excerpts.
function loadClient(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  const require = name => {
    if (name === '@sidekick/shared') return shared;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error('Unmocked dependency: ' + name);
  };
  new Function('require', 'exports', ...Object.keys(globals), code)(require, exports, ...Object.values(globals));
  return exports;
}

const protocol = loadClient('apps/mobile/src/connections/connectionProtocol.ts');
const native = { connections: [{ provider: 'freeagent', status: 'connected', accountLabel: 'Fixture Ltd', connectedAt: null }], available: ['freeagent'] };
const composio = { available: true, offered: ['gmail'], connections: [{ id: 'gmail', toolkit: 'gmail', connectedAccountId: 'ca_fixture' }] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(surface, { respond = () => Response.json(native), authenticate = async () => 'fixture_token', customProtocol = protocol } = {}) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, ...init }); return respond(url, init); };
  let client;
  if (surface === 'mobile') {
    client = loadClient('apps/mobile/src/connections/connectionsApi.ts', {
      '../auth/supabaseClient': { mobileSupabase: {}, getFreshMobileAccessToken: authenticate, getRememberedMobileAccessToken: () => 'fixture_remembered' },
      '../gateways/telegramConnect': { mobileSidekickApiBaseUrl: 'https://fixture.test', normalizePublicApiBaseUrl: v => v },
      './connectionProtocol': customProtocol,
    }, { fetch });
  } else {
    const api = loadClient('apps/webapp/src/lib/api.ts', {
      './env': { apiOrigin: 'https://fixture.test' }, './supabase': { getFreshAccessToken: authenticate },
    }, { fetch });
    client = loadClient('apps/webapp/src/features/connections/connectionsApi.ts', {
      '../../lib/api': api, '@mobile-logic/connections/connectionProtocol': customProtocol,
    });
  }
  return { client, calls };
}
const failed = result => result.ok === false || Boolean(result.error);
const message = result => result.message ?? result.error?.message;

for (const surface of ['mobile', 'web']) {
  test(`${surface}: valid inventories preserve status and every grant, including multiple accounts for one service`, async () => {
    const f = fixture(surface, { respond: url => Response.json(url.endsWith('/composio')
      ? { ...composio, connections: [...composio.connections, { id: 'gmail', connectedAccountId: 'ca_second' }] } : native) });
    const a = await f.client.fetchConnectionStates();
    assert.equal(failed(a), false); assert.equal(a.states[0].status, 'connected');
    assert.equal(a.states[0].accountLabel, 'Fixture Ltd'); assert.deepEqual(a.available, ['freeagent']);
    const b = await f.client.fetchComposioConnections();
    assert.equal(failed(b), false); assert.deepEqual(b.ids, ['gmail']); assert.deepEqual(b.offered, ['gmail']);
    assert.deepEqual(b.connectedAccounts.map(row => row.connectedAccountId), ['ca_fixture', 'ca_second']);
    assert.ok(f.calls.every(call => call.headers.authorization === 'Bearer fixture_token' && call.signal instanceof AbortSignal));
  });

  test(`${surface}: only valid empty inventories prove there are no connections`, async () => {
    const f = fixture(surface, { respond: url => Response.json(url.endsWith('/composio')
      ? { available: true, offered: ['gmail'], connections: [] } : { available: [], connections: [] }) });
    assert.deepEqual((await f.client.fetchConnectionStates()).states, []);
    assert.deepEqual((await f.client.fetchComposioConnections()).ids, []);
  });

  test(`${surface}: unavailable and malformed HTTP replies never become empty success`, async () => {
    for (const request of ['fetchConnectionStates', 'fetchComposioConnections']) {
      for (const payload of [null, [], {}, { connections: [] }, { available: true }, { connections: 'bad', available: true }]) {
        // A native reply predating the availability field is explicitly supported.
        if (request === 'fetchConnectionStates' && payload?.connections?.length === 0) continue;
        const f = fixture(surface, { respond: () => Response.json(payload) });
        assert.equal(failed(await f.client[request]()), true, request + JSON.stringify(payload));
      }
      for (const status of [404, 502, 503]) {
        const f = fixture(surface, { respond: () => Response.json({ error: 'connections_unavailable' }, { status }) });
        assert.equal(failed(await f.client[request]()), true, request + status);
      }
      const malformed = fixture(surface, { respond: () => new Response('not JSON', { status: 200 }) });
      assert.equal(failed(await malformed.client[request]()), true);
    }
    const disabled = fixture(surface, { respond: () => Response.json({ available: false, offered: [], connections: [] }) });
    assert.equal(failed(await disabled.client.fetchComposioConnections()), true);
  });

  test(`${surface}: malformed rows invalidate the entire read instead of skipping a possibly connected account`, async () => {
    for (const row of [null, {}, { provider: 'freeagent', status: 'unexpected' }, { provider: 'freeagent', status: 'connected', accountLabel: {} }]) {
      const f = fixture(surface, { respond: () => Response.json({ ...native, connections: [native.connections[0], row] }) });
      assert.equal(failed(await f.client.fetchConnectionStates()), true);
    }
    for (const row of [null, {}, { id: 'gmail' }, { id: 'gmail', connectedAccountId: 12 }, { id: 'gmail', connectedAccountId: 'ca_fixture' }]) {
      const f = fixture(surface, { respond: () => Response.json({ ...composio, connections: [composio.connections[0], row] }) });
      assert.equal(failed(await f.client.fetchComposioConnections()), true);
    }
    for (const available of [null, true, ['freeagent', 42]]) {
      const f = fixture(surface, { respond: () => Response.json({ ...native, available }) });
      assert.equal(failed(await f.client.fetchConnectionStates()), true);
    }
    const f = fixture(surface, { respond: () => Response.json({ ...composio, offered: ['gmail', 42] }) });
    assert.equal(failed(await f.client.fetchComposioConnections()), true);
  });

  test(`${surface}: historical availability fallback still offers cards without inventing connected accounts`, async () => {
    const f = fixture(surface, { respond: url => Response.json(url.endsWith('/composio')
      ? { available: true, connections: [] } : { connections: [] }) });
    assert.equal((await f.client.fetchConnectionStates()).available, null);
    const b = await f.client.fetchComposioConnections();
    assert.ok(b.offered.includes('gmail')); assert.deepEqual(b.ids, []);
  });

  test(`${surface}: explicit setup and workspace codes differ from generic outages and rate limits`, async () => {
    for (const [status, code, expected] of [
      [503, 'provider_not_configured', shared.CONNECTIONS_NOT_TURNED_ON],
      [503, 'not_configured', shared.CONNECTIONS_NOT_TURNED_ON],
      [503, 'not_ready', shared.CONNECTIONS_WORKSPACE_STARTING],
      [503, 'upstream_failed', shared.CONNECTIONS_UNREACHABLE],
      [404, 'not_found', shared.CONNECTIONS_UNREACHABLE],
      [401, 'unauthenticated', shared.CONNECTIONS_SIGN_IN_AGAIN],
      [403, 'forbidden', shared.CONNECTIONS_SIGN_IN_AGAIN],
      [402, 'no_plan', shared.CONNECTIONS_NO_PLAN],
      [429, 'rate_limited', shared.CONNECTIONS_RATE_LIMITED],
    ]) {
      const f = fixture(surface, { respond: () => Response.json({ error: code }, { status }) });
      assert.equal(message(await f.client.startConnection('freeagent')), expected);
      assert.equal(message(await f.client.startComposioConnection('gmail')), expected);
    }
  });

  test(`${surface}: start requests retain the surface and reject malformed browser destinations`, async () => {
    const f = fixture(surface, { respond: url => Response.json(url.endsWith('/initiate')
      ? { redirectUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_started' } : { authorizeUrl: 'https://provider.fixture.test/path' }) });
    assert.equal((await f.client.startConnection('freeagent')).authorizeUrl, 'https://provider.fixture.test/path');
    const started = await f.client.startComposioConnection('gmail');
    assert.equal(started.authorizeUrl, 'https://connect.fixture.test/path');
    assert.equal(started.connectedAccountId, 'ca_started');
    assert.deepEqual(f.calls.map(call => JSON.parse(call.body).surface), [surface === 'mobile' ? 'app' : 'web', surface === 'mobile' ? 'app' : 'web']);
    for (const url of ['https://', 'http://fixture.test', 'javascript:bad', 'https://user:password@fixture.test', null]) {
      const invalid = fixture(surface, { respond: () => Response.json({ authorizeUrl: url, redirectUrl: url }) });
      assert.equal(failed(await invalid.client.startConnection('freeagent')), true);
      assert.equal(failed(await invalid.client.startComposioConnection('gmail')), true);
    }
  });

  test(`${surface}: a Composio handoff requires a valid initiated account id, not just a URL`, async () => {
    for (const connectedAccountId of [undefined, null, '', 12, 'bad/account', 'x'.repeat(129)]) {
      const f = fixture(surface, { respond: () => Response.json({ redirectUrl: 'https://connect.fixture.test/path', connectedAccountId }) });
      assert.equal(failed(await f.client.startComposioConnection('gmail')), true);
      assert.equal(f.calls.length, 1);
    }
  });

  test(`${surface}: completion and disconnect require their actual server acknowledgements`, async () => {
    for (const body of [null, {}, [], { ok: false }, { ok: true, provider: 'wrong_provider' }]) {
      const f = fixture(surface, { respond: () => Response.json(body) });
      assert.equal((await f.client.completeConnection('freeagent', 'fixture_state', 'fixture_code')).code, 'complete_unconfirmed');
      assert.equal(failed(await f.client.disconnectConnection('freeagent')), true);
      assert.equal(failed(await f.client.disconnectComposioService('gmail')), true);
      assert.equal(f.calls.length, 3, 'unknown mutations are never automatically replayed');
    }
    const good = fixture(surface, { respond: url => Response.json(url.includes('/composio/') ? { disconnected: true } : { ok: true, provider: 'freeagent' }) });
    assert.equal((await good.client.completeConnection('freeagent', 'fixture_state', 'fixture_code')).ok, true);
    assert.equal((await good.client.disconnectConnection('freeagent')).ok, true);
    assert.equal((await good.client.disconnectComposioService('gmail')).ok, true);
    for (const code of ['wrong_account', 'invalid_state', 'exchange_failed']) {
      const f = fixture(surface, { respond: () => Response.json({ error: code }, { status: 403 }) });
      assert.equal((await f.client.completeConnection('freeagent', 'state', 'code')).code, code);
    }
  });

  test(`${surface}: disconnect is addressed by service, and a partial removal is not a success`, async () => {
    // The card says access stops. Both codes below mean it may not have, so
    // neither may come back as the generic "try again in a moment", which reads
    // as though the disconnect simply had not happened yet.
    const addressed = fixture(surface, { respond: () => Response.json({ disconnected: true }) });
    await addressed.client.disconnectComposioService('gmail');
    assert.match(addressed.calls[0].url, /\/api\/connections\/composio\/service\/gmail$/);
    assert.equal(addressed.calls[0].method, 'DELETE');

    for (const [code, expected] of [
      ['partial_disconnect', /still connected/],
      ['disconnect_unconfirmed', /could not confirm that was disconnected/],
    ]) {
      const f = fixture(surface, { respond: () => Response.json({ error: code, removed: 1, failed: 1 }, { status: 502 }) });
      const result = await f.client.disconnectComposioService('gmail');
      assert.equal(failed(result), true);
      assert.match(surface === 'web' ? result.message : result.error.message, expected);
    }
  });

  test(`${surface}: deadline includes authentication and blocks any late mutation`, async () => {
    const auth = deferred();
    const f = fixture(surface, { authenticate: () => auth.promise });
    const result = await f.client.startConnection('freeagent', { timeoutMs: 5 });
    assert.equal(failed(result), true); assert.equal(f.calls.length, 0);
    auth.resolve('late_account_token'); await flush(); assert.equal(f.calls.length, 0);
  });

  test(`${surface}: deadline includes headers and response bodies, aborts and never replays a completion`, async () => {
    for (const stage of ['headers', 'body']) {
      const blocked = deferred();
      const f = fixture(surface, { respond: () => stage === 'headers' ? blocked.promise
        : { ok: true, status: 200, json: () => blocked.promise, text: () => blocked.promise } });
      const result = await f.client.completeConnection('freeagent', 'state', 'code', { timeoutMs: 5 });
      assert.equal(result.code, 'complete_unconfirmed'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
      blocked.resolve(stage === 'headers' ? Response.json({ ok: true, provider: 'freeagent' }) : JSON.stringify({ ok: true, provider: 'freeagent' }));
      await flush(); assert.equal(f.calls.length, 1);
    }
  });

  test(`${surface}: explicit cancellation before or during authentication does not send a request`, async () => {
    for (const before of [true, false]) {
      const auth = deferred(); const controller = new AbortController();
      const f = fixture(surface, { authenticate: () => auth.promise });
      if (before) controller.abort();
      const pending = f.client.startComposioConnection('gmail', { signal: controller.signal });
      if (!before) { await flush(); controller.abort(); }
      assert.equal(failed(await pending), true); auth.resolve('fixture_token'); await flush(); assert.equal(f.calls.length, 0);
    }
  });

  test(`${surface}: the production default deadline is finite and its timer is cleared after success`, async () => {
    const timers = [];
    const customProtocol = loadClient('apps/mobile/src/connections/connectionProtocol.ts', {}, {
      setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; },
    });
    const f = fixture(surface, { customProtocol });
    assert.equal(failed(await f.client.fetchConnectionStates()), false);
    assert.equal(timers.length, 1); assert.equal(timers[0].ms, 15_000); assert.equal(timers[0].cleared, true);
  });
}

test('inventory projections omit unrelated fields, including credentials accidentally returned by an upstream', () => {
  const projected = protocol.parseNativeConnectionInventory({ ...native, connections: [{ ...native.connections[0], access_token: 'fixture-secret' }] });
  assert.deepEqual(Object.keys(projected.states[0]).sort(), ['accountLabel', 'connectedAt', 'provider', 'status']);
  assert.doesNotMatch(JSON.stringify(projected), /fixture-secret/);
  const brokered = protocol.parseComposioConnectionInventory({ ...composio, connections: [{ ...composio.connections[0], token: 'fixture-secret' }] });
  assert.doesNotMatch(JSON.stringify(brokered), /fixture-secret/);
});
