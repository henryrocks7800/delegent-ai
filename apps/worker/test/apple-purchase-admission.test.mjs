import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const userId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const env = { SUPABASE_URL: 'https://admission.supabase.test', SUPABASE_ANON_KEY: 'anon_fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'service_fixture', STRIPE_SECRET_KEY: 'sk_test_fixture',
  APPLE_IAP_KEY_P8: 'configured_fixture_key', APPLE_IAP_KEY_ID: 'fixture_id', APPLE_IAP_ISSUER_ID: 'fixture_issuer',
  SIDEKICK_APPLE_IAP_ALLOWLIST: userId };
function request(body = { tierId: 'studio' }, path = '/api/apple/iap/intent', auth = true) {
  return new Request('https://fixture.test'+path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer fixture_user' } : {}) },
    body: JSON.stringify(body) });
}
function intent(provider = 'apple') {
  return { id: intentId, user_id: userId, provider, tier_id: 'studio', phase: 'reserved', request: {},
    lease_token: '33333333-3333-4333-8333-333333333333', created_at: new Date().toISOString(),
    expires_at: new Date(Date.now()+3_600_000).toISOString(), prepared_params: null, provider_session_id: null };
}
async function withHttp(handler, run) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push(req.url);
    if (new URL(req.url).pathname === '/auth/v1/user') return Response.json({ id: userId });
    return handler(req);
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test('Apple admission authenticates, checks the allowlist and ignores a body-selected account/provider', async () => {
  const actions = [], pending = intent();
  await withHttp(async req => {
    const body = await req.json();
    assert.equal(req.headers.get('apikey'), env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(body.p_user_id, userId);
    if (req.url.endsWith('/claim_billing_purchase_intent')) {
      assert.equal(body.p_provider, 'apple'); assert.equal(body.p_tier_id, 'studio');
      return Response.json({ kind: 'claimed', action: 'create', intent: pending });
    }
    assert.ok(req.url.endsWith('/update_billing_purchase_intent'));
    assert.equal(body.p_intent_id, intentId); actions.push(body.p_action);
    return Response.json(true);
  }, async calls => {
    assert.equal((await worker.fetch(request(undefined, undefined, false), env)).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await worker.fetch(request(), { ...env, SIDEKICK_APPLE_IAP_ALLOWLIST: '' })).status, 403);
    assert.equal(calls.length, 1);
    const response = await worker.fetch(request({ tierId: 'studio', provider: 'stripe', userId: 'other-account' }), env);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { intentId, expiresAt: pending.expires_at });
    assert.deepEqual(actions, ['authorize_apple','release']);
    assert.equal((await worker.fetch(new Request('https://fixture.test/api/apple/iap/intent'), env)).status, 405);
  });
});

test('unknown admission state, paid conflicts and active Stripe service never authorize the Apple sheet', async () => {
  for (const [kind,status,error] of [['already_entitled',409,'already_subscribed_via_stripe'],
    ['busy',503,'purchase_pending'], ['payment_pending',409,'subscription_payment_pending'],
    ['reconciliation_required',409,'purchase_requires_review'], ['malformed',503,'purchase_coordination_unavailable'],
    ['database_error',503,'purchase_coordination_unavailable']]) {
    await withHttp(async req => {
      assert.ok(req.url.endsWith('/claim_billing_purchase_intent'));
      if (kind === 'database_error') return Response.json({ message: 'unavailable' }, { status: 503 });
      return Response.json({ kind });
    }, async () => {
      const response = await worker.fetch(request(), env);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    });
  }
});

test('switching an open Stripe attempt to Apple requires provider-confirmed expiry', async () => {
  for (const result of ['expired','payment_wins','unknown']) {
    const old = intent('stripe');
    old.prepared_params = {}; old.provider_session_id = 'cs_existing';
    const session = { id: 'cs_existing', status: 'open', client_reference_id: userId,
      metadata: { purchaseIntentId: intentId, sidekickUserId: userId, tierId: 'studio' },
      expires_at: Math.floor(Date.parse(old.expires_at)/1000) };
    const next = { ...intent(), id: '44444444-4444-4444-8444-444444444444' };
    let claims = 0, retrieves = 0, expired = false, authorized = false;
    await withHttp(async req => {
      const path = new URL(req.url).pathname;
      if (path.endsWith('/claim_billing_purchase_intent')) {
        claims++;
        if (claims > 1) assert.equal(expired, true);
        return Response.json({ kind: 'claimed', action: claims === 1 ? 'replace' : 'create', intent: claims === 1 ? old : next });
      }
      if (path.endsWith('/update_billing_purchase_intent')) {
        const body = await req.json();
        if (body.p_action === 'session' && body.p_value.status === 'expired') expired = true;
        if (body.p_action === 'authorize_apple') authorized = true;
        return Response.json(true);
      }
      if (path === '/v1/checkout/sessions/cs_existing') {
        retrieves++;
        return Response.json({ ...session, status: result === 'payment_wins' && retrieves > 1 ? 'complete' : 'open' });
      }
      assert.equal(path, '/v1/checkout/sessions/cs_existing/expire');
      return result === 'expired' ? Response.json({ ...session, status: 'expired' })
        : Response.json({ error: { type: 'invalid_request_error', message: 'expiry not confirmed' } }, { status: 400 });
    }, async () => {
      const response = await worker.fetch(request(), env);
      if (result === 'expired') {
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).intentId, next.id);
        assert.equal(authorized, true);
      } else {
        assert.equal(response.status, result === 'payment_wins' ? 409 : 503);
        assert.equal(authorized, false); assert.equal(claims, 1);
      }
    });
  }
});

test('Apple cancellation is authenticated and owned, survives an allowlist change and refuses paid completion', async () => {
  for (const [outcome,status] of [['canceled',200],['completed',409],['not_found',404],['not_pending',409],['malformed',503]]) {
    await withHttp(async req => {
      assert.ok(req.url.endsWith('/cancel_billing_apple_purchase_intent'));
      assert.deepEqual(await req.json(), { p_user_id: userId, p_intent_id: intentId });
      return Response.json(outcome);
    }, async () => {
      const response = await worker.fetch(request({ intentId, userId: 'ignored' }, '/api/apple/iap/intent/cancel'),
        { ...env, SIDEKICK_APPLE_IAP_ALLOWLIST: '', APPLE_IAP_KEY_P8: undefined, STRIPE_SECRET_KEY: undefined });
      assert.equal(response.status, status);
      if (status === 200) assert.deepEqual(await response.json(), { canceled: true });
    });
  }
});
