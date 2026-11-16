import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEKICK_INSPIRATION_STARTERS,
  planTierIdForStripeLookupKey,
  resolveLiveProviderReadiness,
  resolveProvisioningReadiness,
  resolveStripeBillingDryRunEvent,
} from '../dist/index.js';

test('Stripe checkout dry-run maps canonical plan lookup key to subscription and quota', () => {
  const result = resolveStripeBillingDryRunEvent({
    id: 'evt_test_checkout_1',
    type: 'checkout.session.completed',
    mode: 'dry_run',
    userId: 'user_123',
    customerId: 'cus_test_123',
    subscriptionId: 'sub_test_123',
    priceId: 'price_test_123',
    priceLookupKey: 'sidekick_pro_office_monthly',
    status: 'active',
    currentPeriodStart: '2026-05-05T00:00:00.000Z',
    currentPeriodEnd: '2026-06-05T00:00:00.000Z',
    occurredAt: '2026-05-05T13:45:00.000Z',
  });

  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.provider, 'stripe');
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.eventId, 'evt_test_checkout_1');
  assert.equal(result.idempotencyKey, 'stripe:evt_test_checkout_1');
  assert.equal(result.subscription.userId, 'user_123');
  assert.equal(result.subscription.tierId, 'pro-office');
  assert.equal(result.subscription.status, 'active');
  assert.equal(result.subscription.priceId, 'price_test_123');
  assert.equal(result.usageQuota.monthlyTokenQuota, 48_000_000);
  assert.equal(result.shouldPrepareCoworker, true);
  assert.equal(result.publicMessage, "Plan active. Your coworker's cloud computer is being set up.");
  assert.doesNotMatch(JSON.stringify(result), /sk_|whsec_|bearer|secret|api key|service-role|railway|cloudflare|openrouter|container|runtime|\bworker\b/i);
});

test('Stripe dry-run fails closed when active entitlement fields would violate the subscription data model', () => {
  const baseEvent = {
    id: 'evt_test_incomplete_entitlement',
    type: 'customer.subscription.updated',
    mode: 'dry_run',
    userId: 'user_123',
    customerId: 'cus_test_123',
    subscriptionId: 'sub_test_123',
    priceId: 'price_test_123',
    priceLookupKey: 'sidekick_pro_office_monthly',
    status: 'active',
    currentPeriodStart: '2026-05-05T00:00:00.000Z',
    currentPeriodEnd: '2026-06-05T00:00:00.000Z',
    occurredAt: '2026-05-05T13:45:00.000Z',
  };

  for (const input of [
    { ...baseEvent, customerId: undefined },
    { ...baseEvent, subscriptionId: undefined },
    { ...baseEvent, priceId: undefined },
    { ...baseEvent, currentPeriodStart: undefined },
    { ...baseEvent, currentPeriodEnd: undefined },
    { ...baseEvent, currentPeriodStart: '2026-06-05T00:00:00.000Z', currentPeriodEnd: '2026-05-05T00:00:00.000Z' },
  ]) {
    const result = resolveStripeBillingDryRunEvent(input);
    assert.deepEqual(
      { kind: result.kind, reason: result.reason },
      { kind: 'ignored', reason: 'incomplete_provider_entitlement' },
    );
    assert.equal('subscription' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /cus_test_123|sub_test_123|price_test_123/i);
  }
});

test('Stripe dry-run fails closed for unknown plans, unsupported events, and inactive states', () => {
  assert.equal(planTierIdForStripeLookupKey('sidekick_enterprise_suite_monthly'), 'enterprise-suite');
  assert.equal(planTierIdForStripeLookupKey('price_live_123'), null);

  const unknownPlan = resolveStripeBillingDryRunEvent({
    id: 'evt_test_unknown_plan',
    type: 'checkout.session.completed',
    mode: 'dry_run',
    userId: 'user_123',
    priceLookupKey: 'price_live_123',
    status: 'active',
    occurredAt: '2026-05-05T13:45:00.000Z',
  });
  assert.deepEqual({ kind: unknownPlan.kind, reason: unknownPlan.reason }, { kind: 'ignored', reason: 'unknown_price_lookup_key' });

  const inactive = resolveStripeBillingDryRunEvent({
    id: 'evt_test_past_due',
    type: 'customer.subscription.updated',
    mode: 'dry_run',
    userId: 'user_123',
    customerId: 'cus_test_past_due',
    subscriptionId: 'sub_test_past_due',
    priceId: 'price_test_past_due',
    priceLookupKey: 'sidekick_studio_monthly',
    status: 'past_due',
    currentPeriodStart: '2026-05-05T00:00:00.000Z',
    currentPeriodEnd: '2026-06-05T00:00:00.000Z',
    occurredAt: '2026-05-05T13:45:00.000Z',
  });
  assert.equal(inactive.kind, 'subscription_patch');
  assert.equal(inactive.subscription.status, 'past_due');
  assert.equal(inactive.subscription.priceId, 'price_test_past_due');
  assert.equal(inactive.shouldPrepareCoworker, false);

  // A paid renewal invoice is what carries the NEW period, so it has to produce a
  // patch. It used to be dropped as unsupported, which left the usage window
  // anchored to the previous cycle for good.
  const renewal = resolveStripeBillingDryRunEvent({
    id: 'evt_test_invoice',
    type: 'invoice.paid',
    mode: 'dry_run',
    userId: 'user_123',
    customerId: 'cus_test_renewal',
    subscriptionId: 'sub_test_renewal',
    priceId: 'price_test_renewal',
    priceLookupKey: 'sidekick_studio_monthly',
    status: 'active',
    currentPeriodStart: '2026-06-05T00:00:00.000Z',
    currentPeriodEnd: '2026-07-05T00:00:00.000Z',
    occurredAt: '2026-06-05T13:45:00.000Z',
  });
  assert.equal(renewal.kind, 'subscription_patch');
  assert.equal(renewal.subscription.status, 'active');
  assert.equal(renewal.subscription.currentPeriodStart, '2026-06-05T00:00:00.000Z');
  assert.equal(renewal.subscription.currentPeriodEnd, '2026-07-05T00:00:00.000Z');

  // A one-off invoice carries no subscription, so it must still be dropped rather
  // than writing an entitlement nobody bought.
  const oneOff = resolveStripeBillingDryRunEvent({
    id: 'evt_test_one_off_invoice',
    type: 'invoice.payment_succeeded',
    mode: 'dry_run',
    userId: 'user_123',
    priceLookupKey: 'sidekick_studio_monthly',
    status: 'active',
    occurredAt: '2026-05-05T13:45:00.000Z',
  });
  assert.deepEqual(
    { kind: oneOff.kind, reason: oneOff.reason },
    { kind: 'ignored', reason: 'incomplete_provider_entitlement' },
  );
});

test('Inspirations starter catalogue is ordered, user-safe, and not a fake action model', () => {
  assert.equal(SIDEKICK_INSPIRATION_STARTERS.length, 3);
  assert.deepEqual(SIDEKICK_INSPIRATION_STARTERS.map((starter) => starter.id), [
    'tidy-admin-notes',
    'compare-options',
    'draft-reply',
  ]);
  assert.equal(new Set(SIDEKICK_INSPIRATION_STARTERS.map((starter) => starter.id)).size, 3);

  for (const starter of SIDEKICK_INSPIRATION_STARTERS) {
    assert.match(starter.request, /\[paste/i);
    assert.equal('actionUrl' in starter, false);
    assert.equal('provider' in starter, false);
    assert.equal('endpoint' in starter, false);
  }

  const copy = JSON.stringify(SIDEKICK_INSPIRATION_STARTERS);
  assert.doesNotMatch(copy, /supabase|oauth|railway|cloudflare|openrouter|hermes|service-role|api key|secret|container|runtime|\bworker\b|token/i);
});

test('live provider readiness stays blocked until account setup is explicitly complete', () => {
  const telegram = resolveLiveProviderReadiness('telegram', ['bot_name']);
  assert.equal(telegram.ready, false);
  assert.deepEqual(telegram.missingRequirementIds, ['bot_token_saved', 'webhook_url_ready']);
  assert.equal(telegram.publicSummary, 'Telegram is not live yet. A few setup steps still need finishing.');

  const readyStripe = resolveLiveProviderReadiness('stripe', ['account_ready', 'products_ready', 'server_keys_saved', 'webhook_secret_saved']);
  assert.equal(readyStripe.ready, true);
  assert.deepEqual(readyStripe.missingRequirementIds, []);
  assert.equal(readyStripe.publicSummary, 'Stripe is ready for a live test.');

  assert.doesNotMatch(JSON.stringify(readyStripe), /sk_|whsec_|secret value|api key value|token value/i);
});

test('offline provisioning readiness combines workspace and model-access setup without leaking backend names', () => {
  const blocked = resolveProvisioningReadiness({
    railwayCompletedRequirementIds: ['account_ready'],
    cloudflareCompletedRequirementIds: ['account_ready', 'route_ready'],
  });

  assert.equal(blocked.ready, false);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.requiredProviderIds, ['railway', 'cloudflare']);
  assert.deepEqual(blocked.missingProviderIds, ['railway', 'cloudflare']);
  assert.deepEqual(blocked.missingRequirementIdsByProvider, {
    railway: ['project_ready', 'server_keys_saved'],
    cloudflare: ['server_keys_saved'],
  });
  assert.equal(blocked.publicTitle, 'Setup is waiting');
  assert.equal(blocked.nextActionLabel, 'Finish setup');
  assert.doesNotMatch([blocked.publicTitle, blocked.publicSummary, blocked.nextActionLabel].join(' '), /railway|cloudflare|openrouter|hermes|service-role|api key value|secret value|container|runtime|\bworker\b|gateway/i);

  const ready = resolveProvisioningReadiness({
    railwayCompletedRequirementIds: ['account_ready', 'project_ready', 'server_keys_saved'],
    cloudflareCompletedRequirementIds: ['account_ready', 'route_ready', 'server_keys_saved'],
  });

  assert.equal(ready.ready, true);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.missingProviderIds, []);
  assert.equal(ready.publicTitle, 'Ready to set up your coworker');
  assert.equal(ready.nextActionLabel, 'Set up your coworker');
  assert.doesNotMatch([ready.publicTitle, ready.publicSummary, ready.nextActionLabel].join(' '), /railway|cloudflare|openrouter|hermes|service-role|api key value|secret value|container|runtime|\bworker\b|gateway/i);
});
