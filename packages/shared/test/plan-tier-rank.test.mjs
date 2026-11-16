// Tier ordering used to tell an upgrade (applies immediately) from a downgrade
// (scheduled for the next renewal). Pure, no Stripe/Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlanTierRank, isPlanDowngrade, isPlanUpgrade } from '../dist/index.js';

test('plan tier rank orders studio < pro-office < enterprise-suite', () => {
  assert.equal(getPlanTierRank('studio'), 0);
  assert.equal(getPlanTierRank('pro-office'), 1);
  assert.equal(getPlanTierRank('enterprise-suite'), 2);
});

test('isPlanDowngrade is true only when the target tier is lower', () => {
  assert.equal(isPlanDowngrade('enterprise-suite', 'studio'), true);
  assert.equal(isPlanDowngrade('pro-office', 'studio'), true);
  assert.equal(isPlanDowngrade('enterprise-suite', 'pro-office'), true);
  assert.equal(isPlanDowngrade('studio', 'enterprise-suite'), false); // upgrade
  assert.equal(isPlanDowngrade('studio', 'studio'), false); // same tier
});

test('isPlanUpgrade is true only when the target tier is higher', () => {
  assert.equal(isPlanUpgrade('studio', 'enterprise-suite'), true);
  assert.equal(isPlanUpgrade('studio', 'pro-office'), true);
  assert.equal(isPlanUpgrade('enterprise-suite', 'studio'), false);
  assert.equal(isPlanUpgrade('pro-office', 'pro-office'), false);
});

test('unknown tier id throws rather than silently ranking 0', () => {
  assert.throws(() => getPlanTierRank('bogus'), /Unknown Delegent AI plan tier/);
});
