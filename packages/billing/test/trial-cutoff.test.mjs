import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVerifiedStripeWebhookEvent, stripeEntitlementStatus, hydrateTrialSubscriptionInvoice, stripeCancellationAtPeriodEnd } from '../dist/index.js';
import { SIDEKICK_FREE_TRIAL, subscriptionAccessAllowed } from '@sidekick/shared';

const metadata = { sidekickUserId: 'trial-user', tierId: 'studio', priceLookupKey: 'sidekick_studio_monthly', introductoryOfferId: SIDEKICK_FREE_TRIAL.offerId };
const sub = {
  id: 'sub_trial', customer: 'cus_trial', metadata,
  current_period_start: 1789000000, current_period_end: 1789259200,
  items: { data: [{ price: { id: 'price_studio', lookup_key: 'sidekick_studio_monthly' } }] },
};
const invoice = {
  id: 'in_trial', customer: 'cus_trial', subscription: 'sub_trial',
  parent: { subscription_details: { subscription: 'sub_trial', metadata } },
  lines: { data: [{ metadata, price: { id: 'price_studio', lookup_key: 'sidekick_studio_monthly' }, period: { start: 1789259200, end: 1791851200 } }] },
};
function resolve(type, object) {
  return resolveVerifiedStripeWebhookEvent({ id: `evt_${type}`, type, created: 1789259200, data: { object } });
}
function statusOf(result) {
  assert.equal(result.kind, 'subscription_patch', JSON.stringify(result));
  return result.subscription.status;
}

test('trial subscription overdue states revoke access without changing legacy paid-customer grace', () => {
  assert.equal(stripeEntitlementStatus('past_due', sub), 'canceled');
  assert.equal(stripeEntitlementStatus('past_due', { metadata: {} }), 'past_due');
  assert.equal(statusOf(resolve('customer.subscription.updated', { ...sub, status: 'past_due' })), 'canceled');
  assert.equal(statusOf(resolve('invoice.payment_failed', invoice)), 'canceled');
  assert.equal(statusOf(resolve('customer.subscription.deleted', { ...sub, status: 'canceled' })), 'canceled');
});

test('cancel during trial preserves only its remaining days; paid renewal restores service', () => {
  const result = resolve('customer.subscription.updated', { ...sub, status: 'trialing', cancel_at_period_end: true });
  assert.equal(statusOf(result), 'trialing');
  assert.equal(result.shouldPrepareCoworker, true, 'a trial must actually start the digital employee');
  assert.equal(result.subscription.cancelAtPeriodEnd, true);
  const end = new Date(sub.current_period_end * 1000).toISOString();
  assert.equal(subscriptionAccessAllowed('trialing', end, sub.current_period_end * 1000 - 1), true);
  assert.equal(subscriptionAccessAllowed('trialing', end, sub.current_period_end * 1000), false);
  assert.equal(subscriptionAccessAllowed('trialing', end, (sub.current_period_end + 86400) * 1000), false);
  assert.equal(subscriptionAccessAllowed('trialing', null), false);
  assert.equal(statusOf(resolve('invoice.paid', { ...invoice, amount_paid: 999, paid: true, billing_reason: 'subscription_cycle' })), 'active');
});

test('zero-value initial trial invoice and unexpanded checkout never count as a paid month', () => {
  assert.equal(statusOf(resolve('invoice.paid', { ...invoice, amount_paid: 0, paid: true, billing_reason: 'subscription_create' })), 'trialing');
  assert.equal(statusOf(resolve('checkout.session.completed', { ...sub, id: 'cs_trial', subscription: 'sub_trial', status: 'complete', payment_status: 'no_payment_required' })), 'trialing');
});

test('customer portal cancellation date disables renewal even when the legacy flag is false', () => {
  // Shape observed from completed sandbox Checkout and customer portal, Dahlia API.
  const portalSub = { ...sub, status: 'trialing', current_period_end: undefined,
    trial_end: 1789293160, cancel_at: 1789293160, cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_studio', lookup_key: 'sidekick_studio_monthly' }, current_period_start: 1789033960, current_period_end: 1789293160 }] } };
  const result = resolve('customer.subscription.updated', portalSub);
  assert.equal(statusOf(result), 'trialing');
  assert.equal(result.subscription.cancelAtPeriodEnd, true);
  assert.equal(subscriptionAccessAllowed(result.subscription.status, result.subscription.currentPeriodEnd, 1789293160 * 1000), false);
  assert.equal(stripeCancellationAtPeriodEnd({ subscription: portalSub }), true);
  assert.equal(stripeCancellationAtPeriodEnd({ ...portalSub, cancel_at: null }), false, 'reactivation restores renewal');
  assert.equal(stripeCancellationAtPeriodEnd({ ...portalSub, cancel_at: 1791971560 }), false, 'a later cancellation does not stop this renewal');
  for (const cancel_at of [0, -1, 'invalid', Infinity]) assert.equal(stripeCancellationAtPeriodEnd({ ...portalSub, cancel_at }), false);
  assert.equal(stripeCancellationAtPeriodEnd({}), null, 'unexpanded invoices must not erase cancellation state');
});

test('trial subscription activation requires its invoice to be settled', () => {
  assert.equal(resolve('customer.subscription.updated', { ...sub, status: 'active', latest_invoice: 'in_trial' }).kind, 'ignored');
  assert.equal(stripeEntitlementStatus('active', { ...sub, latest_invoice: 'in_trial' }), 'canceled', 'reconciliation cannot infer payment from active status');
  for (const latest of [
    { paid: false, status: 'draft' },
    { paid: false, status: 'open' },
    { paid: false, status: 'uncollectible' },
    { paid: true, status: 'paid', billing_reason: 'subscription_create', amount_paid: 0 },
  ]) {
    assert.equal(statusOf(resolve('customer.subscription.updated', { ...sub, status: 'active', latest_invoice: latest })), 'canceled');
  }
  const paid = { status: 'paid', billing_reason: 'subscription_cycle', amount_paid: 999 };
  const result = resolve('customer.subscription.updated', { ...sub, status: 'active', cancel_at_period_end: true, latest_invoice: paid });
  assert.equal(statusOf(result), 'active');
  assert.equal(result.subscription.cancelAtPeriodEnd, true, 'paid customer cancellation must still be recorded');
  assert.equal(statusOf(resolve('invoice.paid', { ...invoice, ...paid, subscription: { ...sub, status: 'active' } })), 'active');
  assert.equal(statusOf(resolve('invoice.paid', { ...invoice, ...paid, amount_paid: 0, billing_reason: 'subscription_create', subscription: { ...sub, status: 'active' } })), 'trialing');
});

test('verified trial activation retrieves exactly the named invoice and fails closed on a read error', async () => {
  const event = { id: 'evt_paid', type: 'customer.subscription.updated', data: { object: { ...sub, status: 'active', latest_invoice: 'in_trial' } } };
  const calls = [];
  const hydrated = await hydrateTrialSubscriptionInvoice(event, async id => {
    calls.push(id);
    return { id, status: 'paid', amount_paid: 999, billing_reason: 'subscription_cycle' };
  });
  assert.deepEqual(calls, ['in_trial']);
  assert.equal(statusOf(resolve(hydrated.type, hydrated.data.object)), 'active');
  await assert.rejects(hydrateTrialSubscriptionInvoice(event), /unavailable/);
  await assert.rejects(hydrateTrialSubscriptionInvoice(event, async () => { throw new Error('network'); }), /network/);
  await assert.rejects(hydrateTrialSubscriptionInvoice(event, async () => ({ id: 'another_invoice' })), /mismatch/);
  const legacy = { ...event, data: { object: { ...event.data.object, metadata: {} } } };
  assert.equal(await hydrateTrialSubscriptionInvoice(legacy, async () => { throw new Error('must not read legacy invoice'); }), legacy);
});
