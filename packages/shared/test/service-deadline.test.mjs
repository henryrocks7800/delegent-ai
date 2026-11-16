import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionAccessAllowed, isSubscriptionEntitled, mapMyProductStateRow } from '../dist/index.js';

test('Apple access uses its verified service deadline for trial, paid and retry rows', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const period = new Date(now - 86_400_000).toISOString();
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.equal(subscriptionAccessAllowed(status, period, now, 'apple', new Date(now + 1).toISOString()), true);
    for (const end of [null, 'invalid', new Date(now).toISOString(), period]) {
      assert.equal(subscriptionAccessAllowed(status, period, now, 'apple', end), false);
    }
  }
  assert.equal(subscriptionAccessAllowed('canceled', period, now, 'apple', new Date(now + 1).toISOString()), false);
  assert.equal(subscriptionAccessAllowed('past_due', period, now, 'stripe'), true);
  assert.equal(subscriptionAccessAllowed('active', period, now, 'stripe'), true);
  assert.equal(subscriptionAccessAllowed('trialing', period, now, 'stripe'), false);
});

test('product state carries Apple grace through to the same access gate', () => {
  const deadline = new Date(Date.now() + 86_400_000).toISOString();
  const state = mapMyProductStateRow({ user_id: 'fixture', subscription_status: 'trialing', billing_provider: 'apple',
    current_period_end: new Date(Date.now() - 86_400_000).toISOString(),
    service_access_until: deadline });
  assert.equal(isSubscriptionEntitled(state.subscription), true);
  assert.equal(state.subscription.serviceAccessUntil, deadline);
  assert.equal(isSubscriptionEntitled({ ...state.subscription, serviceAccessUntil: undefined }), false);
});
