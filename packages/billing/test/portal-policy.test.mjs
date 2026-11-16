import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalConfiguration } from '../dist/portalPolicy.js';
import { createStripeBillingPortalSession } from '../dist/index.js';
import { portalConfiguration } from '../../../tests/fixtures/portal-configuration.mjs';

test('generic portal requires payment details, invoices and period-end cancellation with plan changes disabled', () => {
  const expected = { id: 'bpc_Generic', livemode: false };
  assert.doesNotThrow(() => assertPortalConfiguration(portalConfiguration(expected.id), expected));
  for (const mutate of [c => c.active = false, c => c.livemode = true, c => c.id = 'bpc_Other',
    c => c.features.subscription_update.enabled = true, c => delete c.features.subscription_update,
    c => c.features.payment_method_update.enabled = false, c => c.features.invoice_history.enabled = false,
    c => c.features.subscription_cancel.mode = 'immediately', c => c.features.subscription_cancel.enabled = false]) {
    const cfg = portalConfiguration(expected.id); mutate(cfg);
    assert.throws(() => assertPortalConfiguration(cfg, expected), /configuration unsafe/);
  }
});

test('targeted portal permits only its exact price with no broader portal actions', () => {
  const expected = { id: 'bpc_Pro', livemode: false, targetPriceId: 'price_pro' };
  assert.doesNotThrow(() => assertPortalConfiguration(portalConfiguration(expected.id, expected.targetPriceId), expected));
  for (const mutate of [c => c.is_default = true, c => c.login_page.enabled = true,
    c => c.features.subscription_update.enabled = false,
    c => c.features.subscription_update.products[0].prices.push('price_studio'),
    c => c.features.subscription_update.products[0].prices[0] = 'price_other',
    c => c.features.subscription_update.products.push({ product: 'prod_Other', prices: ['price_studio'] }),
    c => c.features.subscription_update.default_allowed_updates.push('quantity'),
    c => c.features.subscription_update.default_allowed_updates.push('promotion_code'),
    c => c.features.subscription_update.products[0].adjustable_quantity.enabled = true,
    c => c.features.subscription_update.billing_cycle_anchor = 'now',
    c => c.features.subscription_update.proration_behavior = 'none',
    c => c.features.subscription_update.trial_update_behavior = 'end_trial',
    c => c.features.subscription_update.schedule_at_period_end.conditions.push({ type: 'decreasing_item_amount' }),
    // Stripe will not create an upgrade configuration with this off, so a
    // configuration claiming to have it off is drift, not a tighter setting.
    c => c.features.payment_method_update.enabled = false,
    ...['customer_update', 'invoice_history', 'subscription_cancel']
      .map(feature => c => c.features[feature].enabled = true)]) {
    const cfg = portalConfiguration(expected.id, expected.targetPriceId); mutate(cfg);
    assert.throws(() => assertPortalConfiguration(cfg, expected), /configuration unsafe/);
  }

  // A proposal has no schedule_at_period_end at all, because Stripe refuses an
  // empty array in a create request. Absent and empty mean the same thing and
  // both must pass, or the plan cannot assert its own proposal.
  const proposal = portalConfiguration(expected.id, expected.targetPriceId);
  delete proposal.features.subscription_update.schedule_at_period_end;
  assert.doesNotThrow(() => assertPortalConfiguration(proposal, expected));

  // Stripe does not return subscription_update.products on this account, on any
  // API version tried. Requiring it refused every configuration we can actually
  // create, which is what kept upgrades at 503 on 2026-09-14. Absent must pass;
  // present and wrong must still fail, so the check keeps its teeth wherever
  // Stripe does model the field.
  const unpinned = portalConfiguration(expected.id, expected.targetPriceId);
  delete unpinned.features.subscription_update.products;
  assert.doesNotThrow(() => assertPortalConfiguration(unpinned, expected),
    'a configuration Stripe will actually return must be accepted');
  for (const mutate of [
    c => c.features.subscription_update.products = [],
    c => c.features.subscription_update.products[0].prices[0] = 'price_somewhere_else',
    c => c.features.subscription_update.products.push({ product: 'prod_Other', prices: ['price_other'] }),
  ]) {
    const cfg = portalConfiguration(expected.id, expected.targetPriceId); mutate(cfg);
    assert.throws(() => assertPortalConfiguration(cfg, expected), /configuration unsafe/,
      'products present but not the single expected price is still a refusal');
  }
  for (const unknown of [null, {}, [], 'unavailable']) assert.throws(() => assertPortalConfiguration(unknown, expected));
});

test('upgrade rejects same/lower/unknown source tier before provider reads', async () => {
  const client = { billingPortal: { configurations: { retrieve() { throw Error('unexpected read'); } } }, subscriptions: {} };
  for (const currentTierId of [undefined, 'pro-office', 'enterprise-suite']) {
    await assert.rejects(() => createStripeBillingPortalSession({ configurationId: 'bpc_Pro', livemode: false,
      customerId: 'cus_fixture', returnUrl: 'https://fixture.test/billing', currentTierId, targetTierId: 'pro-office' }, client), /upgrade required/);
  }
});

test('missing or invalid explicit configuration cannot fall back to the default portal', async () => {
  for (const configurationId of [undefined, '', 'bpc_Attacker/path']) {
    let reads = 0, creates = 0;
    const client = { billingPortal: {
      configurations: { retrieve() { reads++; return portalConfiguration('bpc_Generic'); } },
      sessions: { create() { creates++; } },
    } };
    await assert.rejects(() => createStripeBillingPortalSession({ configurationId, livemode: false,
      customerId: 'cus_fixture', returnUrl: 'https://fixture.test/billing' }, client), /configuration required/);
    assert.equal(reads, 0); assert.equal(creates, 0);
  }
});
