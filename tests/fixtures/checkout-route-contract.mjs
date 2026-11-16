import assert from 'node:assert/strict';

export const checkoutRouteEnv = {
  STRIPE_SECRET_KEY: 'sk_test_checkout_route_fixture',
  SUPABASE_URL: 'https://checkout-fixture.supabase.test',
  SUPABASE_ANON_KEY: 'anon_fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'service_fixture',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://checkout-fixture.test',
};

// Exercise each runtime's real route, Supabase SDK and Stripe request encoder.
// Only external HTTP boundaries are replaced; PostgreSQL locking is covered by
// the separate disposable database suite.
export async function verifyCheckoutRoute(invoke) {
  const originalFetch = globalThis.fetch;
  const userId = '11111111-1111-4111-8111-111111111111';
  const intentId = '22222222-2222-4222-8222-222222222222';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const intent = {
    id: intentId, user_id: userId, provider: 'stripe', tier_id: 'studio', phase: 'reserved',
    request: { successUrl: 'https://checkout-fixture.test/success', cancelUrl: 'https://checkout-fixture.test/cancel',
      customerEmail: 'checkout@example.test', existingStripeCustomerId: null, hasPriorSubscription: false },
    lease_token: '33333333-3333-4333-8333-333333333333', created_at: new Date().toISOString(),
    expires_at: expiresAt, prepared_params: null, provider_session_id: null,
  };
  const session = { id: 'cs_fixture_purchase', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_fixture_purchase',
    client_reference_id: userId, metadata: { purchaseIntentId: intentId, sidekickUserId: userId, tierId: 'studio' },
    expires_at: Math.floor(Date.parse(expiresAt) / 1000) };
  let mode = 'fresh';
  let creates = 0, retrieves = 0, lists = 0, claims = 0, prepares = 0;
  const unexpected = [];
  const json = (body, status = 200) => Response.json(body, { status });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/auth/v1/user') return json({ id: userId, email: 'checkout@example.test' });
    if (url.pathname === '/rest/v1/subscriptions') {
      assert.match(url.searchParams.get('select'), /billing_provider/);
      assert.match(url.searchParams.get('select'), /service_access_until/);
      // An old Apple receipt marked active must not block after service expiry.
      return json({ status: 'active', billing_provider: 'apple', tier_id: 'studio',
        current_period_end: '2020-01-01T00:00:00Z', service_access_until: '2020-01-01T00:00:00Z' });
    }
    if (url.pathname === '/v1/customers') return json(mode === 'provider_failure' ? { data: [] } : { data: [], has_more: false });
    if (url.pathname === '/rest/v1/rpc/claim_billing_purchase_intent') {
      claims++;
      const body = await request.json();
      assert.equal(request.headers.get('apikey'), checkoutRouteEnv.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(body.p_user_id, userId);
      assert.equal(body.p_provider, 'stripe');
      assert.equal(body.p_tier_id, 'studio');
      assert.equal(body.p_request.purchaseIntentId, undefined);
      if (mode === 'database_failure') return json({ message: 'unavailable' }, 503);
      if (['busy', 'payment_pending', 'reconciliation_required'].includes(mode)) return json({ kind: mode });
      return json({ kind: 'claimed', action: mode === 'fresh' ? 'create' : 'resume', intent });
    }
    if (url.pathname === '/rest/v1/rpc/update_billing_purchase_intent') {
      const body = await request.json();
      assert.equal(body.p_user_id, userId);
      assert.equal(body.p_intent_id, intentId);
      assert.equal(body.p_lease_token, intent.lease_token);
      if (body.p_action === 'prepare') {
        prepares++;
        intent.prepared_params = body.p_value;
        assert.equal(body.p_value.subscription_data.metadata.purchaseIntentId, intentId);
      }
      if (body.p_action === 'session') intent.provider_session_id = body.p_value.id;
      return json(true);
    }
    if (url.pathname === '/v1/prices') return json({ data: [{ id: 'price_fixture_studio', active: true,
      lookup_key: 'sidekick_studio_monthly' }], has_more: false });
    if (url.pathname === '/v1/checkout/sessions' && request.method === 'POST') {
      creates++;
      assert.equal(prepares, 1, 'provider creation follows durable parameter preparation');
      const body = new URLSearchParams(await request.text());
      assert.equal(request.headers.get('idempotency-key'), 'purchase-intent:' + intentId);
      assert.equal(body.get('metadata[purchaseIntentId]'), intentId);
      assert.equal(body.get('subscription_data[metadata][purchaseIntentId]'), intentId);
      assert.equal(body.get('client_reference_id'), userId);
      assert.equal(body.get('expires_at'), String(session.expires_at));
      return json(session);
    }
    if (url.pathname === '/v1/checkout/sessions/' + session.id) { retrieves++; return json(session); }
    if (url.pathname === '/v1/checkout/sessions' && request.method === 'GET') {
      lists++;
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('created[lte]'), String(session.expires_at));
      return json({ data: [session], has_more: false });
    }
    unexpected.push(request.method + ' ' + request.url);
    throw new Error('Unexpected fixture HTTP boundary');
  };
  const call = async () => invoke(new Request('https://checkout-fixture.test/api/stripe/checkout', {
    method: 'POST', headers: { authorization: 'Bearer fixture_user', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ tierId: 'studio', successUrl: intent.request.successUrl, cancelUrl: intent.request.cancelUrl,
      userId: 'untrusted-user', purchaseIntentId: 'untrusted-intent', provider: 'apple' }),
  }));
  try {
    for (mode of ['fresh', 'resume', 'recover_unbound']) {
      if (mode === 'recover_unbound') intent.provider_session_id = null;
      const response = await call();
      assert.equal(response.status, 200, JSON.stringify({ body: await response.clone().text(), unexpected, claims, prepares, creates, retrieves, lists }));
      assert.deepEqual(await response.json(), { url: session.url });
    }
    assert.equal(creates, 1, 'all retries return the original provider purchase');
    assert.equal(retrieves, 2);
    assert.equal(lists, 1);
    for (const [kind, status, error] of [
      ['busy', 503, 'purchase_pending'], ['payment_pending', 409, 'subscription_payment_pending'],
      ['reconciliation_required', 409, 'purchase_requires_review'], ['database_failure', 503, 'stripe_checkout_failed'],
      ['provider_failure', 503, 'subscription_state_unavailable'],
    ]) {
      mode = kind;
      const response = await call();
      assert.equal(response.status, status, await response.clone().text());
      assert.deepEqual(await response.json(), { error });
    }
    assert.equal(claims, 7);
    assert.equal(creates, 1, 'blocked or unknown database state never creates another checkout');
    assert.deepEqual(unexpected, []);
  } finally { globalThis.fetch = originalFetch; }
}
