import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRunnerConnectionToken } from '../dist/connections-oauth.js';

const USER = '11111111-2222-4333-8444-555555555555';
const VERSION = '44444444-2222-4333-8444-555555555555';
const ENV = {
  SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-role',
  SIDEKICK_CONNECTIONS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  SIDEKICK_FREEAGENT_CLIENT_ID: 'test-client', SIDEKICK_FREEAGENT_CLIENT_SECRET: 'test-secret',
};

async function encrypt(value) {
  const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(cipher).toString('base64')}`;
}

async function decrypt(value) {
  const [, iv, ciphertext] = value.split('.');
  const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, key, Buffer.from(ciphertext, 'base64'));
  return new TextDecoder().decode(bytes);
}

async function fixture(t, options = {}) {
  const state = {
    row: { status: 'connected', credential_version: VERSION, scopes: [],
      access_token_enc: await encrypt('old-access'), refresh_token_enc: await encrypt('old-refresh'),
      access_expires_at: '2020-01-01T00:00:00Z', refresh_attempt_state: null },
    claims: [], finishes: [], providerCalls: 0,
  };
  state.store = body => {
    state.row.refresh_attempt_id = body.p_attempt_id;
    state.row.refresh_attempt_state = body.p_outcome;
    if (body.p_outcome === 'succeeded') {
      Object.assign(state.row, { credential_version: body.p_attempt_id, access_token_enc: body.p_access_token_enc,
        refresh_token_enc: body.p_refresh_token_enc, access_expires_at: body.p_expires_at });
    }
  };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === 'https://api.freeagent.com') {
      state.providerCalls++;
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'old-refresh');
      assert.equal(state.claims.length > 0, true);
      if (options.provider) return options.provider(state, init);
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    assert.equal(url.origin, ENV.SUPABASE_URL);
    if (url.pathname === '/rest/v1/user_connections') {
      assert.equal(init.method, 'GET');
      assert.equal(url.searchParams.get('user_id'), `eq.${USER}`);
      assert.equal(url.searchParams.get('provider'), 'eq.freeagent');
      return Response.json([state.row]);
    }
    const body = JSON.parse(init.body);
    assert.equal(body.p_user_id, USER);
    assert.equal(body.p_provider, 'freeagent');
    assert.equal(body.p_version, VERSION);
    assert.match(body.p_attempt_id, /^[a-f0-9-]{36}$/);
    if (url.pathname.endsWith('/claim_native_connection_refresh')) {
      state.claims.push(body);
      return options.claim ? options.claim(state, body) : Response.json('claimed');
    }
    assert.ok(url.pathname.endsWith('/finish_native_connection_refresh'));
    state.finishes.push(body);
    assert.equal(body.p_attempt_id, state.claims[0].p_attempt_id);
    if (options.finish) return options.finish(state, body);
    state.store(body);
    return Response.json('stored');
  });
  return state;
}

async function request() {
  const response = await handleRunnerConnectionToken(new Request('https://worker.test/api/runner/connections/token', {
    method: 'POST', body: JSON.stringify({ provider: 'freeagent' }),
  }), ENV, USER);
  return { status: response.status, body: await response.json() };
}

test('success persists both encrypted replacement tokens before returning access and the next read uses that pair', async t => {
  const state = await fixture(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.body.accessToken, 'new-access');
  assert.equal(await decrypt(state.finishes[0].p_access_token_enc), 'new-access');
  assert.equal(await decrypt(state.finishes[0].p_refresh_token_enc), 'new-refresh');
  assert.equal(JSON.stringify(state.finishes).includes('new-refresh'), false);
  assert.equal((await request()).body.accessToken, 'new-access');
  assert.equal(state.providerCalls, 1);
  assert.equal(state.finishes.length, 1);
});

for (const kind of ['HTTP 503', 'lost response after commit', 'malformed success']) {
  test(`${kind} retries the identical encrypted pair without repeating provider refresh`, async t => {
    const state = await fixture(t, { finish: (state, body) => {
      if (state.finishes.length === 1) {
        if (kind === 'HTTP 503') return new Response(null, { status: 503 });
        if (kind === 'malformed success') return Response.json({ ok: true });
        state.store(body);
        throw new Error('lost response');
      }
      state.store(body);
      return Response.json('stored');
    } });
    assert.equal((await request()).status, 200);
    assert.equal(state.providerCalls, 1);
    assert.equal(state.finishes.length, 2);
    assert.deepEqual(state.finishes[0], state.finishes[1]);
  });
}

test('persistent write failure never returns a token or retries the provider', async t => {
  const state = await fixture(t, { finish: () => new Response(null, { status: 503 }) });
  assert.deepEqual(await request(), { status: 503, body: { error: 'refresh_persistence_failed' } });
  assert.equal(state.providerCalls, 1);
  assert.equal(state.finishes.length, 3);
  assert.deepEqual(state.finishes[0], state.finishes[2]);
});

test('all write acknowledgements can be lost while a precise read-back still proves the stored replacement pair', async t => {
  const state = await fixture(t, { finish: (state, body) => {
    state.store(body);
    state.row.access_expires_at = body.p_expires_at.replace('Z', '+00:00');
    return new Response(null, { status: 503 });
  } });
  assert.equal((await request()).status, 200);
  assert.equal(state.finishes.length, 3);
  assert.equal(state.providerCalls, 1);
  assert.equal((await request()).body.accessToken, 'new-access');
  assert.equal(state.providerCalls, 1);
});

test('claim acknowledgement loss is retried with the same id before one provider request', async t => {
  const state = await fixture(t, { claim: state => {
    if (state.claims.length === 1) throw new Error('claim response lost');
    return Response.json('claimed');
  } });
  assert.equal((await request()).status, 200);
  assert.deepEqual(state.claims[0], state.claims[1]);
  assert.equal(state.providerCalls, 1);
});

test('an unverifiable claim never contacts the provider', async t => {
  const state = await fixture(t, { claim: () => Response.json({ claimed: true }) });
  assert.deepEqual(await request(), { status: 503, body: { error: 'refresh_store_unavailable' } });
  assert.equal(state.providerCalls, 0);
  assert.equal(state.finishes.length, 0);
  assert.equal(state.claims.length, 2);
});

test('a superseded refresh cannot return old-account tokens or clear the new grant', async t => {
  const state = await fixture(t, { finish: () => Response.json('changed') });
  assert.deepEqual(await request(), { status: 503, body: { error: 'connection_changed' } });
  assert.equal(state.providerCalls, 1);
  assert.equal(state.finishes.length, 1);
});

for (const [name, provider, outcome, error] of [
  ['explicit invalid_grant', () => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'terminal', 'needs_reauth'],
  ['HTTP 503', () => new Response(null, { status: 503 }), 'uncertain', 'refresh_recovery_required'],
  ['transport failure', () => { throw new Error('connection lost'); }, 'uncertain', 'refresh_recovery_required'],
  ['non-JSON invalid_grant text', () => new Response('page quotes invalid_grant', { status: 400 }), 'uncertain', 'refresh_recovery_required'],
  ['invalid_request', () => Response.json({ error: 'invalid_request' }, { status: 400 }), 'uncertain', 'refresh_recovery_required'],
  ['missing replacement refresh token', () => Response.json({ access_token: 'new-access', expires_in: 3600 }), 'uncertain', 'refresh_recovery_required'],
  ['unusable expiry', () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: -1 }), 'uncertain', 'refresh_recovery_required'],
]) {
  test(`${name} is durably classified without guessing an old token is reusable`, async t => {
    const state = await fixture(t, { provider });
    assert.deepEqual(await request(), { status: 409, body: { error } });
    assert.equal(state.providerCalls, 1);
    assert.equal(state.finishes[0].p_outcome, outcome);
    assert.equal(state.finishes[0].p_access_token_enc, undefined);
  });
}

test('an unresolved earlier attempt requires recovery without another provider call', async t => {
  const state = await fixture(t, { claim: () => Response.json('refresh_recovery_required') });
  assert.deepEqual(await request(), { status: 409, body: { error: 'refresh_recovery_required' } });
  assert.equal(state.providerCalls, 0);
});

test('a corrupt encrypted refresh credential is an unreadable store, not a lapsed grant', async t => {
  const state = await fixture(t);
  state.row.refresh_token_enc = 'v1.corrupt.ciphertext';
  assert.deepEqual(await request(), { status: 503, body: { error: 'credentials_unreadable' } });
  assert.equal(state.providerCalls, 0);
});

for (const status of [400, 503]) {
  test(`failed persistence of a provider ${status} outcome is reported as unconfirmed storage`, async t => {
    const state = await fixture(t, {
      provider: () => Response.json({ error: status === 400 ? 'invalid_grant' : 'unavailable' }, { status }),
      finish: () => new Response(null, { status: 503 }),
    });
    assert.deepEqual(await request(), { status: 503, body: { error: 'refresh_persistence_failed' } });
    assert.equal(state.providerCalls, 1);
    assert.equal(state.finishes.length, 3);
  });
}

test('a stalled provider body and failed outcome writes stay within the token request budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const state = await fixture(t, {
    provider: () => new Response(new ReadableStream({ start() {} })),
    finish: () => new Promise(() => {}),
  });
  let result;
  const pending = request().then(value => { result = value; });
  // Advance each boundary after asynchronous crypto/fetch/JSON work settles.
  while (!state.providerCalls) await new Promise(resolve => setImmediate(resolve));
  for (let elapsed = 0; elapsed <= 18_000 && !result; elapsed += 100) {
    t.mock.timers.tick(100);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(result, { status: 503, body: { error: 'refresh_persistence_failed' } });
  await pending;
  assert.equal(state.providerCalls, 1);
  assert.ok(state.finishes.length <= 3);
});
