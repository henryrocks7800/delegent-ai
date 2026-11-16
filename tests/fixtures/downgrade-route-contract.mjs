import assert from 'node:assert/strict';

export const downgradeRouteEnv = {
  STRIPE_SECRET_KEY: 'sk_test_downgrade_route_fixture',
  SUPABASE_URL: 'https://downgrade-fixture.supabase.test',
  SUPABASE_ANON_KEY: 'anon_fixture',
  SUPABASE_SERVICE_ROLE_KEY: 'service_fixture',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://downgrade-fixture.test',
};

// Real route and SDK encoders, with only the external HTTP boundaries replaced.
export async function verifyDowngradeRoute(invoke) {
  const originalFetch = globalThis.fetch;
  const userId = '11111111-1111-4111-8111-111111111111';
  const GB = 1024 ** 3;
  const periodEnd = Math.floor(Date.now() / 1000) + 86_400;
  const subscription = { id: 'sub_fixture', status: 'active', schedule: null,
    items: { data: [{ id: 'si_fixture', price: { id: 'price_enterprise' }, quantity: 1, current_period_end: periodEnd }] },
    discounts: [{ id: 'di_earned', coupon: 'coupon_earned', end: periodEnd + 86_400 }] };
  let usage = [{ consumed_storage_bytes: 0 }], storageStatus = 200, storageThrows = false;
  let stalePrice = false, subscriptionReads = 0;
  const mutations = [], unexpected = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId, email: 'fixture@example.test' });
    if (url.pathname === '/rest/v1/subscriptions') {
      assert.equal(url.searchParams.get('user_id'), 'eq.' + userId);
      return Response.json({ status: 'active', tier_id: 'enterprise-suite', stripe_customer_id: 'cus_fixture',
        stripe_subscription_id: subscription.id, price_id: stalePrice ? 'price_stale' : 'price_enterprise' });
    }
    if (url.pathname === '/rest/v1/usage_quotas') {
      assert.equal(url.searchParams.get('user_id'), 'eq.' + userId);
      assert.equal(request.headers.get('apikey'), downgradeRouteEnv.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(request.headers.get('authorization'), 'Bearer ' + downgradeRouteEnv.SUPABASE_SERVICE_ROLE_KEY);
      assert.ok(init?.signal, 'the storage call explicitly supplies an abort deadline');
      if (storageThrows) throw new Error('fixture storage unavailable');
      return Response.json(usage, { status: storageStatus });
    }
    if (url.pathname === '/v1/prices') return Response.json({ data: [{ id: 'price_studio', active: true,
      lookup_key: 'sidekick_studio_monthly' }], has_more: false });
    if (url.pathname === '/v1/subscriptions/' + subscription.id) {
      subscriptionReads++;
      assert.equal(request.method, 'GET');
      return Response.json(subscription);
    }
    if (url.pathname === '/v1/subscription_schedules' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      mutations.push({ type: 'create', body: Object.fromEntries(body) });
      assert.equal(body.get('from_subscription'), subscription.id);
      return Response.json({ id: 'sub_sched_fixture', status: 'active', phases: [{ start_date: periodEnd - 30 * 86_400 }] });
    }
    if (url.pathname === '/v1/subscription_schedules/sub_sched_fixture' && request.method === 'POST') {
      const body = new URLSearchParams(await request.text());
      mutations.push({ type: 'update', body: Object.fromEntries(body) });
      assert.equal(body.get('proration_behavior'), 'none');
      assert.equal(body.get('end_behavior'), 'release');
      assert.equal(body.get('phases[0][items][0][price]'), 'price_enterprise');
      assert.equal(body.get('phases[0][end_date]'), String(periodEnd));
      assert.equal(body.get('phases[1][items][0][price]'), 'price_studio');
      assert.equal(body.get('phases[1][start_date]'), String(periodEnd));
      assert.equal(body.get('phases[0][discounts][0][discount]'), 'di_earned');
      assert.equal(body.get('phases[1][discounts][0][discount]'), 'di_earned');
      return Response.json({ id: 'sub_sched_fixture', status: 'active' });
    }
    unexpected.push(request.method + ' ' + url.pathname);
    throw new Error('Unexpected downgrade HTTP boundary');
  };
  const call = () => invoke(new Request('https://downgrade-fixture.test/api/stripe/portal', {
    method: 'POST', headers: { authorization: 'Bearer fixture_user', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ targetTierId: 'studio', returnUrl: 'https://downgrade-fixture.test/billing',
      userId: 'untrusted', currentTierId: 'studio', stripeSubscriptionId: 'sub_untrusted', consumedStorageBytes: 0 }),
  }));
  try {
    for (const raw of [0, 10 * GB, String(10 * GB)]) {
      usage = [{ consumed_storage_bytes: raw }];
      const response = await call();
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { scheduled: true, targetTierId: 'studio', currentTierId: 'enterprise-suite',
        effectiveAt: new Date(periodEnd * 1000).toISOString() });
    }
    const previousMutations = mutations.length, previousReads = subscriptionReads;
    assert.equal(previousMutations, 6);
    usage = [{ consumed_storage_bytes: 10 * GB + 1 }];
    let response = await call();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'downgrade_storage_over_limit');
    for (const malformed of [[], {}, null, [{ consumed_storage_bytes: 0 }, { consumed_storage_bytes: 0 }],
      ...[null, undefined, '', ' ', true, false, -1, '-1', 0.5, '1e3', 'NaN', Number.MAX_SAFE_INTEGER + 1]
        .map(consumed_storage_bytes => ({ consumed_storage_bytes })).map(row => [row])]) {
      usage = malformed;
      response = await call();
      assert.equal(response.status, 503, JSON.stringify(malformed));
      assert.deepEqual(await response.json(), { error: 'billing_storage_unavailable' });
    }
    usage = [{ consumed_storage_bytes: 0 }];
    storageStatus = 503;
    assert.equal((await call()).status, 503);
    storageStatus = 200; storageThrows = true;
    assert.equal((await call()).status, 503);
    storageThrows = false;
    assert.equal(mutations.length, previousMutations, 'unknown/over-limit storage cannot write to Stripe');
    assert.equal(subscriptionReads, previousReads, 'storage is checked before provider scheduling work');
    stalePrice = true;
    response = await call();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'stripe_downgrade_schedule_failed' });
    assert.equal(mutations.length, previousMutations, 'stale database price cannot reset the currently paid plan');
    assert.deepEqual(unexpected, [], 'only the expected authenticated reads and schedule writes occur');
  } finally { globalThis.fetch = originalFetch; }
}
