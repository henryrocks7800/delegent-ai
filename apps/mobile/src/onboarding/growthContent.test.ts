import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIDEKICK_PLAN_TIERS, SIDEKICK_FREE_TRIAL, formatGbp, promoPriceGbpMonthly } from '@sidekick/shared';
import { paywallPriceLine, isOnboardingGoal, ONBOARDING_CHOICES, GOAL_LABELS, PAYWALL_REVIEWS, pickReviews, reviewCredit } from './growthContent';

test('intro price comes from shared configuration, with renewal amount visible', () => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = false;
  try {
    const studio = SIDEKICK_PLAN_TIERS.find((t) => t.id === 'studio')!;
    const text = paywallPriceLine('studio', 'inactive', null);
    assert.ok(text.includes(formatGbp(promoPriceGbpMonthly(studio))));
    assert.ok(text.includes(`then ${formatGbp(studio.priceGbpMonthly)}`));
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});
test('lapsed and active subscribers are not promised a new introductory price', () => {
  for (const status of ['inactive', 'active', 'canceled'] as const) {
    assert.doesNotMatch(paywallPriceLine('studio', status, '2026-08-01T00:00:00Z'), /first|then/);
  }
});

test('trial paywall names its automatic renewal price and excludes returning customers', () => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = true;
  try {
    for (const tier of SIDEKICK_PLAN_TIERS) {
      const line = paywallPriceLine(tier.id, 'inactive', null);
      assert.match(line, /3 days free/);
      assert.ok(line.includes(`${formatGbp(tier.priceGbpMonthly)} per month automatically`));
      assert.match(line, /Cancel before the trial ends/);
      assert.doesNotMatch(paywallPriceLine(tier.id, 'inactive', '2026-08-01T00:00:00Z'), /free/);
      assert.doesNotMatch(paywallPriceLine(tier.id, 'canceled', null), /free/);
    }
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});
test('only predefined goals may reach profile storage or analytics', () => {
  assert.equal(isOnboardingGoal('inbox'), true);
  assert.equal(isOnboardingGoal('private email text'), false);
  assert.equal(isOnboardingGoal(null), false);
});

test('the picker leads with connections and retires Admin without invalidating saved profiles', () => {
  assert.deepEqual(ONBOARDING_CHOICES, ['something_else', 'receipts', 'inbox']);
  assert.equal(GOAL_LABELS[ONBOARDING_CHOICES[0]], 'Everyday connections');
  for (const goal of [...ONBOARDING_CHOICES, 'admin']) assert.equal(isOnboardingGoal(goal), true);
  assert.equal(isOnboardingGoal('everyday_connections'), false, 'do not send an unsupported new database value');
});

test('store reviews are real, attributed and varied (2026-09-28)', () => {
  assert.ok(PAYWALL_REVIEWS.length >= 10, 'every review with words in it, not the same two');
  for (const review of PAYWALL_REVIEWS) {
    assert.ok(review.quote.trim().length > 0);
    assert.ok(review.stars >= 1 && review.stars <= 5);
    assert.ok(review.store === 'App Store' || review.store === 'Google Play');
    assert.ok(!/\u2014/.test(review.quote), 'quotes are excerpts, not reworded copy');
  }
  assert.equal(new Set(PAYWALL_REVIEWS.map((review) => review.quote)).size, PAYWALL_REVIEWS.length);
  assert.ok(PAYWALL_REVIEWS.some((review) => review.stars === 4), 'a four-star review keeps its four stars');
});

test('pickReviews returns a varied handful without repeats', () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const first = pickReviews(PAYWALL_REVIEWS, 5, random);
  const second = pickReviews(PAYWALL_REVIEWS, 5, random);
  assert.equal(first.length, 5);
  assert.equal(new Set(first.map((review) => review.quote)).size, 5);
  assert.notDeepEqual(first.map((review) => review.quote), second.map((review) => review.quote));
  assert.equal(reviewCredit({ quote: 'x', author: '', store: 'Google Play', stars: 5 }), 'Google Play review');
  assert.equal(reviewCredit({ quote: 'x', author: 'RachDC123', store: 'App Store', stars: 5 }), 'RachDC123, App Store');
});
