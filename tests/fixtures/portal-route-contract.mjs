import assert from 'node:assert/strict';
import { portalConfiguration } from './portal-configuration.mjs';

export const portalRouteEnv = {
  STRIPE_SECRET_KEY: 'sk_test_portal_fixture', SUPABASE_URL: 'https://portal-fixture.supabase.test',
  SUPABASE_ANON_KEY: 'anon_fixture', SUPABASE_SERVICE_ROLE_KEY: 'service_fixture',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://portal-fixture.test',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_Generic', STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID: 'bpc_Pro',
  STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID: 'bpc_Enterprise',
};

export async function verifyPortalRoute(invoke) {
  const originalFetch = globalThis.fetch;
  let mode = 'valid', target, confirmation;
  const calls = [], writes = [], unexpected = [];
  const userId = '11111111-1111-4111-8111-111111111111';
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    calls.push(request.method + ' ' + url.pathname);
    const authenticatedUser = mode === 'schedule_other_user' ? '22222222-2222-4222-8222-222222222222' : userId;
    if (url.pathname === '/auth/v1/user') return Response.json({ id: authenticatedUser });
    if (url.pathname === '/rest/v1/subscriptions') {
      assert.equal(url.searchParams.get('user_id'), 'eq.' + authenticatedUser);
      return Response.json({ status: 'active', tier_id: mode === 'schedule_higher_tier' ? 'enterprise-suite'
        : mode === 'schedule_same_tier' ? 'pro-office' : 'studio', stripe_customer_id: 'cus_fixture',
        stripe_subscription_id: 'sub_fixture', price_id: 'price_studio' });
    }
    if (url.pathname === '/v1/prices') return Response.json({ data: [{ id: target === 'pro-office' ? 'price_pro' : 'price_enterprise',
      active: true, lookup_key: target === 'pro-office' ? 'sidekick_pro_office_monthly' : 'sidekick_enterprise_suite_monthly' }], has_more: false });
    if (url.pathname === '/v1/subscriptions/sub_fixture') return Response.json({
      id: 'sub_fixture', status: mode === 'canceled' ? 'canceled' : 'active',
      customer: mode === 'other_customer' ? 'cus_other' : 'cus_fixture',
      schedule: mode === 'schedule_removed' ? null : mode === 'schedule_replaced' ? 'sub_sched_other'
        : mode.includes('schedule') ? 'sub_sched_fixture' : null,
      items: { data: [{ id: 'si_fixture', price: { id: mode === 'stale_price' ? 'price_changed' : 'price_studio' },
        quantity: mode === 'quantity' ? 2 : 1 }] },
    });
    if (url.pathname.startsWith('/v1/billing_portal/configurations/')) {
      const id = url.pathname.split('/').at(-1);
      const cfg = portalConfiguration(id, id === 'bpc_Pro' ? 'price_pro' : id === 'bpc_Enterprise' ? 'price_enterprise' : undefined);
      if (mode === 'configuration_failure') return Response.json({ error: { message: 'fixture unavailable' } }, { status: 400 });
      if (mode === 'generic_updates') cfg.features.subscription_update.enabled = true;
      if (mode === 'extra_price' || mode === 'schedule_bad_configuration') cfg.features.subscription_update.products[0].prices.push('price_studio');
      if (mode === 'wrong_mode') cfg.livemode = true;
      if (mode === 'inactive') cfg.active = false;
      return Response.json(cfg);
    }
    if (url.pathname === '/v1/subscription_schedules/sub_sched_fixture/release') {
      writes.push('release');
      assert.ok(calls.some(c => c.includes('/configurations/bpc_Pro')), 'policy is checked before a schedule release');
      if (mode === 'schedule_release_failure') return Response.json({ error: { message: 'fixture unavailable' } }, { status: 400 });
      return Response.json({ id: 'sub_sched_fixture', status: 'released' });
    }
    if (url.pathname === '/v1/billing_portal/sessions') {
      writes.push('portal');
      const params = new URLSearchParams(await request.text());
      const upgrade = target && target !== 'studio';
      assert.equal(params.get('configuration'), upgrade ? target === 'pro-office' ? 'bpc_Pro' : 'bpc_Enterprise' : 'bpc_Generic');
      assert.equal(params.get('customer'), 'cus_fixture');
      assert.equal(params.get('return_url'), 'https://portal-fixture.test/billing');
      if (upgrade) {
        assert.equal(params.get('flow_data[type]'), 'subscription_update_confirm');
        assert.equal(params.get('flow_data[after_completion][type]'), 'redirect');
        assert.equal(params.get('flow_data[after_completion][redirect][return_url]'), 'https://portal-fixture.test/billing');
        assert.equal(params.get('flow_data[subscription_update_confirm][subscription]'), 'sub_fixture');
        assert.equal(params.get('flow_data[subscription_update_confirm][items][0][price]'), target === 'pro-office' ? 'price_pro' : 'price_enterprise');
        assert.equal(params.get('flow_data[subscription_update_confirm][items][0][quantity]'), '1');
      } else assert.equal(params.get('flow_data[type]'), null);
      return Response.json({ id: 'bps_fixture', url: 'https://billing.stripe.com/p/session/bps_fixture' });
    }
    unexpected.push(request.method + ' ' + url.pathname);
    throw new Error('Unexpected portal boundary');
  };
  const call = () => invoke(new Request('https://portal-fixture.test/api/stripe/portal', {
    method: 'POST', headers: { authorization: 'Bearer fixture_user', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ returnUrl: 'https://portal-fixture.test/billing', targetTierId: target,
      ...(confirmation ? { scheduledChangeConfirmation: confirmation } : {}),
      configuration: 'bpc_Attacker', customer: 'cus_other', currentTierId: 'enterprise-suite' }),
  }));
  try {
    for (target of [undefined, 'studio', 'pro-office', 'enterprise-suite']) {
      const response = await call();
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { url: 'https://billing.stripe.com/p/session/bps_fixture' });
    }
    for (const scenario of ['generic_updates', 'extra_price', 'configuration_failure', 'wrong_mode', 'inactive',
      'other_customer', 'stale_price', 'canceled', 'quantity', 'schedule_bad_configuration']) {
      mode = scenario; target = scenario === 'generic_updates' ? undefined : 'pro-office';
      const before = writes.length;
      const response = await call();
      assert.equal(response.status, 503, mode);
      assert.deepEqual(await response.json(), { error: 'stripe_billing_portal_failed' });
      assert.equal(writes.length, before, 'no provider writes for ' + mode);
    }
    mode = 'schedule_valid'; target = 'pro-office';
    const beforeConfirmation = writes.length;
    const challenge = await call();
    assert.equal(challenge.status, 409);
    const challengeBody = await challenge.json();
    assert.equal(challengeBody.error, 'billing_scheduled_change_confirmation_required');
    confirmation = challengeBody.confirmation;
    assert.match(confirmation.token, /^[a-f0-9]{64}$/);
    assert.equal(writes.length, beforeConfirmation, 'opening the prompt cannot remove the scheduled choice');
    for (mode of ['schedule_other_user', 'schedule_higher_tier', 'schedule_same_tier', 'schedule_removed', 'schedule_replaced']) {
      const response = await call();
      assert.equal(response.status, 409, mode);
      assert.deepEqual(await response.json(), { error: 'billing_scheduled_change_changed' });
      assert.equal(writes.length, beforeConfirmation, mode + ' cannot apply an old acknowledgement');
    }
    mode = 'schedule_valid';
    assert.equal((await call()).status, 200);
    assert.deepEqual(writes.slice(-2), ['release', 'portal']);
    mode = 'schedule_release_failure';
    const before = writes.length;
    assert.equal((await call()).status, 503);
    assert.deepEqual(writes.slice(before), ['release'], 'failed release cannot open a blocked upgrade flow');
    assert.deepEqual(unexpected, []);
  } finally { globalThis.fetch = originalFetch; }
}
