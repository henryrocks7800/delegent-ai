// Backend-brokered OAuth connections.
//
// These tests pin the properties that make the broker safe rather than the
// happy path, because the happy path is the part that gets exercised by hand
// anyway. Specifically: the client never receives a token, `state` is
// single-use and server-bound, the post-consent bounce cannot be steered by a
// query parameter, the account a grant lands in is the account that asked for
// it, and a transient provider outage never marks a live connection dead.

// Six providers (Dropbox, Slack, GitHub, Google Drive, Outlook, Teams) moved
// to Composio on 2026-09-03, so the provider-specific tests for them were
// removed with their definitions. FreeAgent is the only native provider left,
// and it now stands in for the shared machinery these tests actually pin.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleConnectionStart,
  handleConnectionCallback,
  handleConnectionComplete,
  handleConnectionList,
  handleConnectionDisconnect,
  handleRunnerConnectionToken,
  revokeAllConnectionsForUser,
  __testing,
} from '../dist/connections-oauth.js';

const USER_ID = '3f1c2a54-9d0b-4c8e-a1f6-7b2e5d4c3a90';
const SUPABASE_URL = 'https://supabase.test';

const ENV = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  // 32 zero bytes, base64. Only ever used in-process by these tests.
  SIDEKICK_CONNECTIONS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  SIDEKICK_FREEAGENT_CLIENT_ID: 'fa-client-id',
  SIDEKICK_FREEAGENT_CLIENT_SECRET: 'fa-client-secret',
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN: 'https://api.delegantai.co.uk',
  SIDEKICK_CONNECTIONS_RETURN_WEB_URL: 'https://delegent-app.web.app/connections',
};

/**
 * Route stubbed responses by URL prefix and record every outbound call, so a
 * test can assert both what we sent and what we never sent.
 */
function stubFetch(routes) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null, headers: init.headers ?? {} });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return typeof handler === 'function' ? handler(url, init) : handler;
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

const authedUser = () => Response.json({ id: USER_ID });
const ok = (body = {}) => Response.json(body);
const authedRequest = (url, init = {}) =>
  new Request(url, { ...init, headers: { authorization: 'Bearer session-token', ...(init.headers ?? {}) } });

// The burst buckets are module state, so without this a file with more than ten
// hand-offs in it starts failing on the rate limit rather than on the thing each
// test is about.
test.beforeEach(() => __testing.resetConnectionBurstLimits());

/**
 * The authenticated half of the hand-off, which is where the exchange happens
 * now. The provider's redirect cannot be authenticated, so the callback hands
 * the state and the code back to the surface and the grant is stored from here,
 * under whichever account is holding the bearer token.
 */
const complete = (providerId, env = ENV, body = { state: 'abc', code: 'xyz' }) =>
  handleConnectionComplete(
    authedRequest(`https://api.delegantai.co.uk/api/connections/oauth/${providerId}/complete`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    env,
    providerId,
  );

/** An unspent, unexpired flow row, as the callback's read-only peek sees it. */
const pendingFlow = (provider, surface = 'app') => ok([{
  provider,
  return_surface: surface,
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  consumed_at: null,
}]);

test('start returns an authorize URL with PKCE S256 and never returns the verifier', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => new Response(null, { status: 201 }),
  });
  try {
    const response = await handleConnectionStart(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth/freeagent/start', {
        method: 'POST',
        body: JSON.stringify({ surface: 'app' }),
      }),
      ENV,
      'freeagent',
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const authorize = new URL(body.authorizeUrl);

    assert.equal(authorize.origin + authorize.pathname, 'https://api.freeagent.com/v2/approve_app');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('client_id'), 'fa-client-id');
    assert.equal(
      authorize.searchParams.get('redirect_uri'),
      'https://api.delegantai.co.uk/oauth/freeagent/callback',
    );
    // FreeAgent declares no extra authorize params, so nothing beyond the
    // standard set may be appended. Dropbox needed token_access_type=offline
    // here; it is brokered by Composio from 2026-09-03 and this assertion
    // moved with it. What matters generically is that authorizeParams are
    // applied verbatim and nothing is invented.
    assert.equal(authorize.searchParams.get('token_access_type'), null);

    const persisted = JSON.parse(stub.calls.find((c) => c.url.includes('connection_oauth_flows')).body);
    assert.equal(persisted.user_id, USER_ID);
    assert.equal(persisted.return_surface, 'app');
    assert.equal(persisted.state, authorize.searchParams.get('state'));

    // The verifier is the whole point of PKCE: it must stay server-side.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(persisted.code_verifier), 'code_verifier must never reach the client');
    assert.ok(!serialized.includes('fa-client-secret'), 'no secret material in the start response');
  } finally {
    stub.restore();
  }
});

test('start refuses an unauthenticated caller before writing any flow row', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: () => new Response('no', { status: 401 }),
  });
  try {
    const response = await handleConnectionStart(
      new Request('https://api.delegantai.co.uk/api/connections/oauth/freeagent/start', { method: 'POST' }),
      ENV,
      'freeagent',
    );
    assert.equal(response.status, 401);
    assert.ok(!stub.calls.some((c) => c.url.includes('connection_oauth_flows')));
  } finally {
    stub.restore();
  }
});

test('a replayed or forged state never reaches the token endpoint', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    // A forged state matches no row, and a spent one is excluded by the same
    // read. The RPC is what enforces single-use on the way through.
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => ok([]),
    [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([]),
  });
  try {
    const bounce = await handleConnectionCallback(
      new Request('https://api.delegantai.co.uk/oauth/freeagent/callback?state=deadbeef&code=abc'),
      ENV,
      'freeagent',
    );
    assert.equal(bounce.status, 302);
    assert.match(bounce.headers.get('location'), /connection_error=invalid_state/);

    const finished = await complete('freeagent', ENV, { state: 'deadbeef', code: 'abc' });
    assert.equal(finished.status, 410);
    assert.equal((await finished.json()).error, 'invalid_state');

    assert.ok(
      !stub.calls.some((c) => c.url.includes('api.freeagent.com')),
      'a bad state must not spend an authorization code',
    );
  } finally {
    stub.restore();
  }
});

// The hole this closes: `connection_oauth_flows.user_id` is whoever STARTED the
// flow, and the callback used to store the grant under it. The callback cannot
// be authenticated, so an attacker could start a flow on their own account, send
// the authorize URL to somebody else, and that person's approved provider
// account would land in the attacker's Delegent account, readable by the
// attacker's coworker. The exchange therefore happens behind a bearer token and
// refuses when the two accounts differ.
test('a hand-off finished by a different account is refused, and the code is never spent', async () => {
  const someoneElse = '9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d';
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: () => Response.json({ id: someoneElse }),
    [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([{
      user_id: USER_ID, provider: 'freeagent', code_verifier: 'verifier', return_surface: 'app',
    }]),
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => new Response(null, { status: 201 }),
    'https://api.freeagent.com/v2/token_endpoint': () => ok({ access_token: 'a', refresh_token: 'r', expires_in: 14400 }),
  });
  try {
    const response = await complete('freeagent');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'wrong_account');
    assert.ok(
      !stub.calls.some((c) => c.url.includes('api.freeagent.com')),
      'a refused hand-off must not exchange the code',
    );
    assert.ok(
      !stub.calls.some((c) => c.url.includes('/user_connections') && c.method === 'POST'),
      'nothing may be stored for either account',
    );
  } finally {
    stub.restore();
  }
});

// Refused or not, the flow is spent. Leaving it alive would let the same
// authorize URL be walked past a second account until one of them happened to be
// the account that started it.
test('the callback hands the code back rather than linking the account itself', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => pendingFlow('freeagent'),
  });
  try {
    const response = await handleConnectionCallback(
      new Request('https://api.delegantai.co.uk/oauth/freeagent/callback?state=abc&code=xyz'),
      ENV,
      'freeagent',
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.protocol, 'sidekick:');
    assert.equal(location.searchParams.get('connection_state'), 'abc');
    assert.equal(location.searchParams.get('connection_code'), 'xyz');
    // Nothing is connected yet, and saying so before the exchange has happened
    // is how the old flow announced links it had not made.
    assert.equal(location.searchParams.get('connected'), null);
    assert.ok(
      !stub.calls.some((c) => c.url.includes('api.freeagent.com')),
      'the unauthenticated callback must not exchange anything',
    );
    assert.ok(
      !stub.calls.some((c) => c.url.includes('consume_connection_oauth_flow')),
      'the flow has to survive the callback or there is nothing left to check the asking account against',
    );
  } finally {
    stub.restore();
  }
});

test('a burst of hand-offs is refused rather than filling the flow table', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => new Response(null, { status: 201 }),
  });
  try {
    const start = () => handleConnectionStart(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth/freeagent/start', {
        method: 'POST',
        body: JSON.stringify({ surface: 'app' }),
      }),
      ENV,
      'freeagent',
    );
    for (let attempt = 0; attempt < __testing.CONNECTION_ATTEMPTS_PER_MINUTE; attempt += 1) {
      assert.equal((await start()).status, 200, `attempt ${attempt + 1} should be allowed`);
    }
    const refused = await start();
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'rate_limited');
    const written = stub.calls.filter((c) => c.url.includes('connection_oauth_flows') && c.method === 'POST');
    assert.equal(written.length, __testing.CONNECTION_ATTEMPTS_PER_MINUTE, 'the refused attempt wrote a row anyway');
  } finally {
    stub.restore();
  }
});

test('the callback bounce cannot be steered by a query parameter', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => pendingFlow('freeagent', 'web'),
  });
  try {
    const response = await handleConnectionCallback(
      new Request(
        'https://api.delegantai.co.uk/oauth/freeagent/callback'
        + '?state=abc&code=xyz&redirect_uri=https://evil.example&return=https://evil.example',
      ),
      ENV,
      'freeagent',
    );
    assert.equal(response.status, 302);
    const location = response.headers.get('location');
    assert.ok(location.startsWith('https://delegent-app.web.app/connections'), location);
    assert.ok(!location.includes('evil.example'));
  } finally {
    stub.restore();
  }
});

// Reconnecting is the documented way out of needs_reauth, and the button that
// offers it is on both surfaces. The stub below behaves the way PostgREST
// really does rather than answering 201 to everything: a row for this
// (user, provider) already exists, so the insert only merges if the request
// names the constraint it collides on. Naming nothing targets the primary key,
// which is a defaulted uuid and therefore never conflicts, so the write lands
// as a plain insert and trips `unique (user_id, provider)` instead.
test('reconnecting an existing connection merges the row instead of failing on the unique constraint', async () => {
  const postgrest = (url, init) => {
    if (init.method !== 'POST') return ok([]);
    const target = new URL(url).searchParams.get('on_conflict');
    const merging = (init.headers?.prefer ?? '').includes('merge-duplicates');
    if (merging && target === 'user_id,provider') return new Response(null, { status: 201 });
    return new Response(
      JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "user_connections_user_id_provider_key"' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  };
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([{
      user_id: USER_ID, provider: 'freeagent', code_verifier: 'verifier', return_surface: 'app',
    }]),
    [`${SUPABASE_URL}/rest/v1/rpc/purge_expired_connection_flows`]: () => ok(0),
    [`${SUPABASE_URL}/rest/v1/user_connections`]: postgrest,
    'https://api.freeagent.com/v2/token_endpoint': () => ok({
      access_token: 'access-plaintext', refresh_token: 'refresh-plaintext', expires_in: 14400,
    }),
    'https://api.freeagent.com/v2/company': () => ok({ company: { name: 'Delegent AI' } }),
  });
  try {
    const response = await complete('freeagent');
    assert.equal(response.status, 200, `reconnect should succeed, but it answered ${response.status}`);
    assert.deepEqual(await response.json(), { ok: true, provider: 'freeagent' });
  } finally {
    stub.restore();
  }
});

test('stored tokens are encrypted, and the account label is read back from the provider', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([{
      user_id: USER_ID, provider: 'freeagent', code_verifier: 'verifier', return_surface: 'app',
    }]),
    [`${SUPABASE_URL}/rest/v1/rpc/purge_expired_connection_flows`]: () => ok(0),
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => new Response(null, { status: 201 }),
    'https://api.freeagent.com/v2/token_endpoint': () => ok({
      access_token: 'access-plaintext', refresh_token: 'refresh-plaintext', expires_in: 14400,
    }),
    'https://api.freeagent.com/v2/company': () => ok({ company: { name: 'Delegent AI' } }),
  });
  try {
    const response = await complete('freeagent');
    assert.equal(response.status, 200);

    const write = stub.calls.find((c) => c.url.includes('/user_connections') && c.method === 'POST');
    const row = JSON.parse(write.body);
    assert.equal(row.status, 'connected');
    assert.equal(row.account_label, 'Delegent AI');
    assert.ok(!write.body.includes('access-plaintext'), 'access token must never be stored in the clear');
    assert.ok(!write.body.includes('refresh-plaintext'), 'refresh token must never be stored in the clear');
    assert.match(row.access_token_enc, /^v1\./);
    assert.match(row.refresh_token_enc, /^v1\./);
    assert.match(row.credential_version, /^[a-f0-9-]{36}$/);
    assert.equal(row.refresh_attempt_id, null);
    assert.equal(row.refresh_attempt_state, null);
    assert.equal(row.refresh_lease_until, null);

    const exchange = stub.calls.find((c) => c.url === 'https://api.freeagent.com/v2/token_endpoint');
    const form = new URLSearchParams(exchange.body);
    // Dropbox's own guide says to send code_verifier INSTEAD of client_id.
    // That is wrong and the exchange fails without both.
    assert.equal(form.get('client_id'), 'fa-client-id');
    assert.equal(form.get('code_verifier'), 'verifier');
  } finally {
    stub.restore();
  }
});

test('an incomplete new authorization cannot inherit another account refresh token', async () => {
  for (const tokens of [
    { access_token: 'new-account-access', expires_in: 3600 },
    { access_token: 'new-account-access', refresh_token: 'new-account-refresh', expires_in: -1 },
  ]) {
    const stub = stubFetch({
      [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
      [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([{
        user_id: USER_ID, provider: 'freeagent', code_verifier: 'verifier', return_surface: 'app',
      }]),
      'https://api.freeagent.com/v2/token_endpoint': () => ok(tokens),
      'https://api.freeagent.com/v2/company': () => ok({ company: { name: 'Another account' } }),
    });
    try {
      const response = await complete('freeagent');
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error, 'store_failed');
      assert.ok(!stub.calls.some(call => call.url.includes('/user_connections')));
    } finally { stub.restore(); }
  }
});

// Dropbox is the only public client we have. Once the broker learned to send a
// client_secret for the confidential providers, the risk became that it starts
// sending an empty one here: several providers reject a PKCE exchange that
// carries a blank client_secret, which would break the one connection that
// already works, in production, for a reason invisible from the code.
test('a confidential client sends its OWN secret and never another provider secret', async () => {
  // This was "a PKCE public client sends no client_secret at all" while Dropbox
  // was ours. Dropbox is brokered by Composio from 2026-09-03 and every
  // remaining native provider is confidential, so there is no public client
  // left to exercise. The property worth keeping is the second half: a secret
  // belonging to a DIFFERENT provider must never reach this exchange.
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/rpc/consume_connection_oauth_flow`]: () => ok([{
      user_id: USER_ID, provider: 'freeagent', code_verifier: 'verifier', return_surface: 'app',
    }]),
    [`${SUPABASE_URL}/rest/v1/rpc/purge_expired_connection_flows`]: () => ok(0),
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => new Response(null, { status: 201 }),
    'https://api.freeagent.com/v2/token_endpoint': () => ok({ access_token: 'a', refresh_token: 'r', expires_in: 14400 }),
    'https://api.freeagent.com/v2/company': () => ok({ company: { name: 'Delegent AI' } }),
  });
  try {
    await complete('freeagent', { ...ENV, SIDEKICK_SLACK_CLIENT_SECRET: 'slack-secret' });
    const exchange = stub.calls.find((c) => c.url === 'https://api.freeagent.com/v2/token_endpoint');
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get('client_secret'), 'fa-client-secret', 'a confidential client must send its own secret');
    assert.ok(!exchange.body.includes('slack-secret'), 'one provider must never send another provider secret');
  } finally {
    stub.restore();
  }
});

test('the list endpoint returns a projection with no token columns in it', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => ok([
      { provider: 'freeagent', status: 'connected', account_label: 'Delegent AI', connected_at: '2026-07-28T00:00:00Z' },
      { provider: 'slack', status: 'revoked', account_label: null, connected_at: '2026-07-01T00:00:00Z' },
    ]),
  });
  try {
    const response = await handleConnectionList(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth'),
      ENV,
    );
    const body = await response.json();
    assert.deepEqual(body.connections, [{
      provider: 'freeagent',
      status: 'connected',
      accountLabel: 'Delegent AI',
      connectedAt: '2026-07-28T00:00:00Z',
    }]);

    // The select itself must not even ask for the token columns.
    const query = stub.calls.find((c) => c.url.includes('/user_connections')).url;
    assert.ok(!query.includes('token_enc'), query);
  } finally {
    stub.restore();
  }
});

test('disconnect deletes the row, and says so, for a provider with no revoke endpoint', async () => {
  // FreeAgent publishes no revocation endpoint, so `revoke` is null for it.
  // The row must still go, and we must not invent a call we cannot make.
  const encrypted = await encryptForTest('access-plaintext');
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: (url, init) =>
      (init.method === 'DELETE' ? new Response(null, { status: 204 }) : ok([{
        status: 'connected', access_token_enc: encrypted, refresh_token_enc: encrypted, scopes: [],
      }])),
  });
  try {
    const response = await handleConnectionDisconnect(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth/freeagent', { method: 'DELETE' }),
      ENV,
      'freeagent',
    );
    assert.equal(response.status, 200);
    assert.ok(stub.calls.some((c) => c.url.includes('/user_connections') && c.method === 'DELETE'));
    assert.ok(!stub.calls.some((c) => c.url.includes('token/revoke')), 'no revoke endpoint exists to call');
  } finally {
    stub.restore();
  }
});

// Deleting the account used to leave live grants sitting at the provider. The
// user saw Delegent gone and reasonably assumed its access went with it, when
// the only way to withdraw it was to find our entry in the provider's own app
// settings. Since 2026-09-03 the only native provider is FreeAgent, which
// publishes no revocation endpoint, so the sweep's job here is to delete every
// row for the user in one scoped call and report honestly what it could not
// withdraw. The brokered connections are swept separately, in index.ts.
test('deleting the account deletes every native row in one scoped call', async () => {
  const encrypted = await encryptForTest('access-plaintext');
  const stub = stubFetch({
    [`${SUPABASE_URL}/rest/v1/user_connections`]: (url, init) =>
      (init.method === 'DELETE' ? new Response(null, { status: 204 }) : ok([
        { provider: 'freeagent', access_token_enc: encrypted },
      ])),
  });
  try {
    const result = await revokeAllConnectionsForUser(ENV, USER_ID);
    assert.equal(result.rowsDeleted, true);
    assert.deepEqual(result.failed, []);
    const deletes = stub.calls.filter((c) => c.url.includes('/user_connections') && c.method === 'DELETE');
    assert.equal(deletes.length, 1, 'one delete for the whole account, scoped to the user');
    assert.match(deletes[0].url, new RegExp(`user_id=eq.${USER_ID}`));
  } finally {
    stub.restore();
  }
});


// Reading nothing is not the same as having nothing connected, and deleting rows
// we never saw would destroy the only record that a grant was ever there.
test('an unreadable connection list is reported as un-swept rather than as nothing to do', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => new Response('nope', { status: 500 }),
  });
  try {
    const sweep = await revokeAllConnectionsForUser(ENV, USER_ID);
    assert.equal(sweep.rowsDeleted, false);
    assert.deepEqual(sweep.revoked, []);
    assert.ok(!stub.calls.some((c) => c.method === 'DELETE'), 'nothing is deleted on a failed read');
  } finally {
    stub.restore();
  }
});

// Refresh failure and persistence cases execute the current RPC protocol in
// connector-refresh-recovery.test.mjs, with the actual SQL races in database-gate.

test('a still-valid access token is served without touching the provider', async () => {
  const fresh = await encryptForTest('live-access');
  const stub = stubFetch({
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => ok([{
      status: 'connected',
      access_token_enc: fresh,
      refresh_token_enc: fresh,
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['files.content.read'],
    }]),
  });
  try {
    const response = await handleRunnerConnectionToken(
      new Request('https://api.delegantai.co.uk/api/runner/connections/token', {
        method: 'POST', body: JSON.stringify({ provider: 'freeagent' }),
      }),
      ENV,
      USER_ID,
    );
    const body = await response.json();
    assert.equal(body.accessToken, 'live-access');
    assert.deepEqual(body.scopes, ['files.content.read']);
    assert.ok(!stub.calls.some((c) => c.url.includes('dropboxapi.com')));
  } finally {
    stub.restore();
  }
});

// A provider whose console registration has not happened yet has no
// credentials, and offering it would hand the reader a failure the moment they
// tapped it. The list endpoint is what the surfaces filter on.
test('the list endpoint reports only the providers we hold credentials for', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => ok([]),
  });
  try {
    const response = await handleConnectionList(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth'),
      ENV,
    );
    const { available } = await response.json();
    assert.ok(available.includes('freeagent'), 'FreeAgent has credentials in ENV, so it is offered');
    // Everything else is brokered by Composio since 2026-09-03 and must never
    // appear on the native list, whatever is left in the environment.
    for (const gone of ['dropbox', 'slack', 'github', 'google_drive', 'google_calendar', 'microsoft_outlook', 'microsoft_teams']) {
      assert.equal(available.includes(gone), false, `${gone} is brokered, not native`);
    }
  } finally {
    stub.restore();
  }
});


// Half a confidential client is worse than none: the user would approve at the
// provider and only then hit a failure they cannot do anything about.
test('a confidential client with an id but no secret is not offered and cannot be started', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => ok([]),
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => new Response(null, { status: 201 }),
  });
  const halfConfigured = { ...ENV, SIDEKICK_FREEAGENT_CLIENT_SECRET: '' };
  try {
    const listed = await handleConnectionList(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth'),
      halfConfigured,
    );
    assert.equal((await listed.json()).available.includes('freeagent'), false);

    const started = await handleConnectionStart(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth/freeagent/start', { method: 'POST' }),
      halfConfigured,
      'freeagent',
    );
    assert.equal(started.status, 503);
    assert.equal((await started.json()).error, 'provider_not_configured');
    assert.ok(!stub.calls.some((c) => c.url.includes('connection_oauth_flows')), 'no flow row for a dead provider');
  } finally {
    stub.restore();
  }
});

// A read that did not happen and an account with nothing connected are the same
// empty list. Both surfaces use this reply to decide whether a hand-off that
// just came back actually stored a grant, so answering 200 on a failed read
// tells someone who did connect that nothing was connected.
test('a read the broker could not do is not reported as an account with nothing connected', async () => {
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => new Response('upstream timeout', { status: 504 }),
  });
  try {
    const response = await handleConnectionList(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth'),
      ENV,
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'connections_unreadable');
    assert.equal(body.connections, undefined, 'a failed read must not carry a connections list at all');
  } finally {
    stub.restore();
  }
});









test('an unknown provider is rejected everywhere', async () => {
  for (const [handler, args] of [
    [handleConnectionStart, ['not_a_provider']],
    [handleConnectionCallback, ['not_a_provider']],
    [handleConnectionComplete, ['not_a_provider']],
    [handleConnectionDisconnect, ['not_a_provider']],
  ]) {
    const response = await handler(
      new Request('https://api.delegantai.co.uk/x', { method: 'POST' }),
      ENV,
      ...args,
    );
    assert.equal(response.status, 404);
  }
});

/** Mirror of the module's own AES-256-GCM envelope, so a test can seed a row
 *  that the module will actually be able to decrypt. */
async function encryptForTest(plaintext) {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(ENV.SIDEKICK_CONNECTIONS_ENC_KEY, 'base64'),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(ciphertext).toString('base64')}`;
}

test('a row for a provider we no longer broker is not reported as connected', async () => {
  // 2026-09-03: six providers moved to Composio and their user_connections rows
  // stayed behind. The client list reported them as connected, so the
  // Connections screen would have shown Dropbox and Google Drive as live on a
  // native route that no longer exists.
  const stub = stubFetch({
    [`${SUPABASE_URL}/auth/v1/user`]: authedUser,
    [`${SUPABASE_URL}/rest/v1/user_connections`]: () => ok([
      { provider: 'freeagent', status: 'connected', account_label: 'Delegent AI', connected_at: '2026-08-05T00:00:00Z' },
      { provider: 'dropbox', status: 'connected', account_label: 'alex@example.com', connected_at: '2026-09-03T00:00:00Z' },
      { provider: 'google_drive', status: 'connected', account_label: null, connected_at: '2026-09-03T00:00:00Z' },
      { provider: 'slack', status: 'connected', account_label: null, connected_at: '2026-09-03T00:00:00Z' },
    ]),
  });
  try {
    const body = await (await handleConnectionList(
      authedRequest('https://api.delegantai.co.uk/api/connections/oauth'), ENV,
    )).json();
    assert.deepEqual(body.connections.map((c) => c.provider), ['freeagent']);
  } finally {
    stub.restore();
  }
});
