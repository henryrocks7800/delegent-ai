import test from 'node:test';
import assert from 'node:assert/strict';
import { appleEntitlementStatus, applePaidAmount } from '../dist/apple-iap.js';

test('Apple free trials stay entitled without being labeled paid; cancellation and billing retry still win', () => {
  assert.equal(appleEntitlementStatus('active', { offerDiscountType: 'FREE_TRIAL' }), 'trialing');
  assert.equal(appleEntitlementStatus('active', { offerDiscountType: 'PAY_AS_YOU_GO' }), 'active');
  assert.equal(appleEntitlementStatus('active', {}), 'active');
  assert.equal(appleEntitlementStatus('canceled', { offerDiscountType: 'FREE_TRIAL' }), 'canceled');
  assert.equal(appleEntitlementStatus('past_due', { offerDiscountType: 'FREE_TRIAL' }), 'canceled');
  assert.equal(appleEntitlementStatus('past_due', { offerDiscountType: 'PAY_AS_YOU_GO' }), 'canceled');
});

test('Apple paid amount uses transaction milliunits; sandbox, free trial and absent price never count as revenue', () => {
  assert.equal(applePaidAmount({ environment: 'Production', price: 2990 }), 2.99);
  assert.equal(applePaidAmount({ environment: 'Production', price: 9990, currency: 'USD' }), 9.99);
  for (const info of [
    { environment: 'Sandbox', price: 9990 },
    { environment: 'Production', price: 0, offerDiscountType: 'FREE_TRIAL' },
    { environment: 'Production', price: 9990, offerDiscountType: 'FREE_TRIAL' },
    { environment: 'Production', price: null },
    { environment: 'Production', price: NaN },
    { environment: 'Production', price: -9990 },
  ]) assert.equal(applePaidAmount(info), null);
});
