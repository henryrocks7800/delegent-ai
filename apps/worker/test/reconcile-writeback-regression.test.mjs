// Exercise the real recovery function. A failed write must never claim the
// user's subscription was repaired or permit a second checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStripeSubscriptionByEmailImpl } from '../dist/stripe.js';
import { handleStripeCheckoutRequest } from '../dist/stripe-flow.js';

const userId = '11111111-1111-4111-8111-111111111111';
const env = { STRIPE_SECRET_KEY: 'sk_test_fixture', SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_ANON_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://app.test' };
function fixture({ writeError, outcome = 'applied', missingEnd = false, readError = false } = {}) {
  const calls = [];
  const deps = {
    stripe: {
      customers: { async list() {
        if (readError) throw new Error('provider unavailable');
        return { has_more: false, data: [{ id: 'cus_recovery', metadata: { sidekickUserId: userId } }] };
      } },
      subscriptions: { async list() { return { has_more: false, data: [{
        id: 'sub_recovery', status: 'active', metadata: { sidekickUserId: userId, tierId: 'studio' },
        cancel_at_period_end: true, items: { data: [{ price: { id: 'price_studio' },
          current_period_start: 1_800_000_000, current_period_end: missingEnd ? undefined : 1_802_592_000 }] },
      }] }; } },
    },
    store: { async applyEntitlement(input) {
      calls.push(input);
      if (writeError) throw new Error('database unavailable');
      return { outcome, resumed: false };
    } },
  };
  return { calls, deps, run: () => reconcileStripeSubscriptionByEmailImpl(env, { userId, email: 'fixture@example.test' }, deps) };
}
test('recovery atomically writes verified period, quota and lifecycle before reporting recovered', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'active');
  assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.equal(request.subscription.current_period_start, new Date(1_800_000_000_000).toISOString());
  assert.equal(request.subscription.current_period_end, new Date(1_802_592_000_000).toISOString());
  assert.equal(request.subscription.cancel_at_period_end, true);
  assert.equal(request.subscription.provider_updated_at, request.quota.provider_updated_at);
  assert.equal(request.quota.monthly_token_quota, 19_550_000);
  assert.equal(request.quota.storage_quota_bytes, 10 * 1024 ** 3);
  assert.equal(request.allowProviderSwitch, false);
  assert.equal(request.retentionSeconds, 60 * 86400);
});
test('recovery rejects a failed write, provider conflict or superseded provider snapshot', async () => {
  for (const options of [{ writeError: true }, { outcome: 'provider_conflict' },
    { outcome: 'ignored_historical' }, { outcome: 'ignored_stale' }, { outcome: 'activation_pending' }]) {
    await assert.rejects(fixture(options).run);
  }
});
test('recovery rejects incomplete provider periods and unavailable inventories before writing', async () => {
  for (const options of [{ missingEnd: true }, { readError: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run);
    assert.equal(f.calls.length, 0);
  }
});
test('checkout returns retryable state on recovery failure without creating another Stripe session', async () => {
  const response = await handleStripeCheckoutRequest(new Request('https://api.test/api/stripe/checkout', {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ tierId: 'studio', successUrl: 'https://app.test/success', cancelUrl: 'https://app.test/cancel' }),
  }), {
    env, async getAuthenticatedUser() { return { id: userId, email: 'fixture@example.test' }; },
    async getCheckoutSubscription() { return null; },
    reconcileStripeSubscriptionByEmail: fixture({ writeError: true }).run,
    createStripeBillingClient() { throw new Error('must not create another session'); },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'subscription_state_unavailable');
});
