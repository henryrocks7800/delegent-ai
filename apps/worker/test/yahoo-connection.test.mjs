// Yahoo Mail on our own broker: ships inert until Yahoo approves the app, shows
// our own connect screen built only from the stored flow, and gives the agent
// engine a token only over the signed internal route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleConnectionStart, handleConnectionInterstitial, __testing } from '../dist/connections-oauth.js';
import { handleEngineConnectionToken } from '../dist/engine-connection-token.js';
import { connectionTokenHeaders } from '../../agent/src/connectionToken.ts';

const USER_ID = '3f1c2a54-9d0b-4c8e-a1f6-7b2e5d4c3a90';
const SUPABASE_URL = 'https://supabase.test';
const STATE = 'a'.repeat(64);
const BASE = {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SIDEKICK_CONNECTIONS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN: 'https://api.delegantai.co.uk',
  SIDEKICK_CONNECTIONS_RETURN_WEB_URL: 'https://delegent-app.web.app/connections',
};
const ENV = { ...BASE, SIDEKICK_YAHOO_CLIENT_ID: 'yahoo-client', SIDEKICK_YAHOO_CLIENT_SECRET: 'yahoo-secret' };

function stubFetch(routes) {
  const calls = []; const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method ?? 'GET' });
    for (const [prefix, handler] of Object.entries(routes)) if (url.startsWith(prefix)) return typeof handler === 'function' ? handler(url, init) : handler;
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}
test.beforeEach(() => __testing.resetConnectionBurstLimits());

test('until Yahoo approves us (no client id), nothing starts and no screen is shown', async () => {
  const f = stubFetch({});
  try {
    const start = await handleConnectionStart(new Request('https://w/api/connections/oauth/yahoo_mail/start', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' }), BASE, 'yahoo_mail');
    assert.equal(start.status, 503);
    assert.deepEqual(await start.json(), { error: 'provider_not_configured' });
    const screen = await handleConnectionInterstitial(new Request(`https://w/connect/yahoo_mail?state=${STATE}`), BASE, 'yahoo_mail');
    assert.equal(screen.status, 503);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('starting hands the app our connect screen, not Yahoo directly', async () => {
  const f = stubFetch({ [`${SUPABASE_URL}/auth/v1/user`]: () => Response.json({ id: USER_ID }),
    [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => new Response(null, { status: 201 }) });
  try {
    const response = await handleConnectionStart(new Request('https://w/api/connections/oauth/yahoo_mail/start', { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ surface: 'app' }) }), ENV, 'yahoo_mail');
    assert.equal(response.status, 200);
    const { authorizeUrl } = await response.json();
    assert.match(authorizeUrl, /^https:\/\/api\.delegantai\.co\.uk\/connect\/yahoo_mail\?state=[0-9a-f]{64}$/);
  } finally { f.restore(); }
});

test('the connect screen is built from the stored flow, continues to Yahoo with PKCE and read-only scope, and cannot redirect elsewhere', async () => {
  const flow = { provider: 'yahoo_mail', code_verifier: 'v'.repeat(43), return_surface: 'app', expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null };
  const f = stubFetch({ [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => Response.json([flow]) });
  try {
    const response = await handleConnectionInterstitial(new Request(`https://w/connect/yahoo_mail?state=${STATE}&next=https://evil.example`), ENV, 'yahoo_mail');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const html = await response.text();
    assert.match(html, /Connect Yahoo Mail to Delegent AI/);
    assert.match(html, /never sees your password/);
    assert.match(html, /cannot send, move or delete/);
    assert.doesNotMatch(html, /evil\.example/);
    const next = new URL(html.match(/class="btn go" href="([^"]+)"/)[1].replace(/&#38;/g, '&'));
    assert.equal(next.origin + next.pathname, 'https://api.login.yahoo.com/oauth2/request_auth');
    assert.equal(next.searchParams.get('scope'), 'openid email mail-r');
    assert.equal(next.searchParams.get('state'), STATE);
    assert.equal(next.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(next.searchParams.get('redirect_uri'), 'https://api.delegantai.co.uk/oauth/yahoo_mail/callback');
    assert.match(html, /sidekick:\/\/connections\/return\?provider=yahoo_mail&#38;connection_error=declined/);
  } finally { f.restore(); }
});

test('an expired, spent, foreign or malformed flow never shows the screen', async () => {
  for (const [state, row] of [
    ['bad', null],
    [STATE, { provider: 'yahoo_mail', code_verifier: 'v', return_surface: 'app', expires_at: new Date(Date.now() - 1).toISOString(), consumed_at: null }],
    [STATE, { provider: 'yahoo_mail', code_verifier: 'v', return_surface: 'app', expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: new Date().toISOString() }],
    [STATE, { provider: 'freeagent', code_verifier: 'v', return_surface: 'app', expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null }],
  ]) {
    const f = stubFetch({ [`${SUPABASE_URL}/rest/v1/connection_oauth_flows`]: () => Response.json(row ? [row] : []) });
    try {
      const response = await handleConnectionInterstitial(new Request(`https://w/connect/yahoo_mail?state=${state}`), ENV, 'yahoo_mail');
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location'), /connection_error=invalid_state/);
    } finally { f.restore(); }
  }
});

test('the engine token route needs a valid signature over the exact body, and only for allowed providers', async () => {
  const env = { ...ENV, SIDEKICK_AGENT_SHARED_SECRET: 'engine-secret', SIDEKICK_AGENT_ENGINE_USER_IDS: USER_ID, AGENT: { fetch() { throw new Error('not called'); } } };
  const call = async (body, secret = 'engine-secret', tamper = false) => {
    const headers = await connectionTokenHeaders(secret, USER_ID, body);
    return handleEngineConnectionToken(new Request('https://w/internal/connection-token', { method: 'POST', headers, body: tamper ? body.replace('yahoo', 'yaho0') : body }), env);
  };
  assert.equal((await call('{"provider":"yahoo_mail"}', 'wrong-secret')).status, 401);
  assert.equal((await call('{"provider":"yahoo_mail"}', 'engine-secret', true)).status, 401, 'body is bound by the signature');
  assert.equal((await call('{"provider":"freeagent"}')).status, 404, 'only engine-allowed providers');
  assert.equal((await call('{"provider":"yahoo_mail","extra":1}')).status, 400);
});
