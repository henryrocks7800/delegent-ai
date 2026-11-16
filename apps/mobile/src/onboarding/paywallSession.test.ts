import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppOpenDetector, shouldShowAppOpenPaywall } from './paywallSession';

test('reopens once after background, not initial active or iOS inactive sheets', () => {
  const detect = createAppOpenDetector();
  assert.equal(detect('active'), false);
  detect('inactive');
  assert.equal(detect('active'), false);
  detect('background');
  detect('inactive');
  assert.equal(detect('active'), true);
  assert.equal(detect('active'), false);
});

test('upsell requires known non-payment and cannot interrupt checkout or a dismissal', () => {
  const base = { subscriptionKnown: true, hasActiveSubscription: false, dismissed: false, checkingResume: false, purchaseInFlight: false };
  assert.equal(shouldShowAppOpenPaywall(base), true);
  for (const override of [{ subscriptionKnown: false }, { hasActiveSubscription: true }, { dismissed: true }, { checkingResume: true }, { purchaseInFlight: true }]) {
    assert.equal(shouldShowAppOpenPaywall({ ...base, ...override }), false);
  }
});
