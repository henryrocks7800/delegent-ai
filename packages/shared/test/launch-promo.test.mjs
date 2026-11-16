// The launch promo had no shared test at all, which is how it came to quote half
// price to a customer the server was always going to charge in full (2026-07-30,
// reported on Alex's own account after his plan lapsed). The rule these tests
// hold is narrow: the price on the card is the price Stripe takes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEKICK_FREE_TRIAL,
  SIDEKICK_LAUNCH_PROMO,
  SIDEKICK_PLAN_TIERS,
  formatGbp,
  isLaunchPromoLive,
  launchPromoTermsLine,
  promoPriceGbpMonthly,
  shouldQuotePromoPrice,
} from '../dist/index.js';

const STUDIO = SIDEKICK_PLAN_TIERS.find((tier) => tier.id === 'studio');

test('the live three-day trial replaces the promo quote everywhere the promo would have shown', () => {
  // Shipped state since 2026-09-11. A first-timer is offered the trial, never
  // the struck-through promo price, so the two offers can never both appear.
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = true;
  try {
    assert.equal(shouldQuotePromoPrice(null), false);
    assert.equal(shouldQuotePromoPrice({ status: 'inactive' }), false);
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});

// The rest of this file pins the promo path with the trial off, which is the
// configuration the promo rules were written against and still guard.
SIDEKICK_FREE_TRIAL.enabled = false;

test('the promo is live, so these rules are load-bearing rather than dormant', () => {
  // If this ever goes false the rest of the file still passes but proves nothing,
  // so say so out loud instead of letting the suite go quietly green.
  assert.equal(isLaunchPromoLive(), true);
  assert.ok(SIDEKICK_LAUNCH_PROMO.stripeCouponId.length > 0);
});

test('shouldQuotePromoPrice: a reader Stripe has never seen is quoted the discount', () => {
  assert.equal(shouldQuotePromoPrice(null), true);
  assert.equal(shouldQuotePromoPrice(undefined), true);
  assert.equal(shouldQuotePromoPrice({ status: 'inactive' }), true);
});

test('shouldQuotePromoPrice: a customer who subscribed, cancelled and lapsed is NOT', () => {
  // Alex's case. The row reads 'inactive' exactly like a first-timer, and the old
  // status-only check quoted him half price while checkout charged him £75,
  // because the server refuses the coupon to any customer who has had it.
  assert.equal(
    shouldQuotePromoPrice({ status: 'inactive', currentPeriodEnd: '2026-07-29T10:57:56.000Z' }),
    false,
  );
});

test('shouldQuotePromoPrice: no current subscriber of any status is quoted the discount', () => {
  for (const status of ['active', 'trialing', 'past_due', 'canceled']) {
    assert.equal(shouldQuotePromoPrice({ status }), false, status);
    assert.equal(
      shouldQuotePromoPrice({ status, currentPeriodEnd: '2026-08-29T10:57:56.000Z' }),
      false,
      status,
    );
  }
});

test('shouldQuotePromoPrice: nothing is quoted while the promo is not live', () => {
  const dead = { ...SIDEKICK_LAUNCH_PROMO, stripeCouponId: '' };
  assert.equal(shouldQuotePromoPrice(null, dead), false);
  assert.equal(shouldQuotePromoPrice({ status: 'inactive' }, dead), false);
});

test('the quoted promo price is the tier price less the advertised percentage, floored to the penny', () => {
  // Stripe rounds the coupon's discount to the nearest penny, and the card is
  // derived with the same arithmetic from the same percent, so the two agree.
  // Proven live on 2026-09-08 with delegent_launch_7003_2mo: three throwaway
  // Checkout Sessions read 299, 749 and 1798 pence due today.
  const live = { studio: 2.99, 'pro-office': 7.49, 'enterprise-suite': 17.98 };
  for (const tier of SIDEKICK_PLAN_TIERS) {
    const pricePence = Math.round(tier.priceGbpMonthly * 100);
    const expected = (pricePence - Math.round(pricePence * SIDEKICK_LAUNCH_PROMO.stripeCouponPercentOff / 100)) / 100;
    assert.equal(promoPriceGbpMonthly(tier), expected, tier.id);
    assert.equal(promoPriceGbpMonthly(tier), live[tier.id], `${tier.id}: the card must show what Stripe charged live`);
    // Never a rounding artefact a reader would query on their statement.
    assert.equal(Number.isFinite(promoPriceGbpMonthly(tier)), true, tier.id);
  }
  // The adverts say £2.99, and that is the number that must never move.
  assert.equal(promoPriceGbpMonthly(STUDIO), 2.99);
});

test('the terms name the exact price the discount reverts to, not "the usual price"', () => {
  // The vague wording is the one a reader can claim they were not told about.
  const line = launchPromoTermsLine(STUDIO);
  assert.match(line, new RegExp(`${SIDEKICK_LAUNCH_PROMO.percentOff}% off`));
  assert.ok(line.includes(formatGbp(STUDIO.priceGbpMonthly)), line);
  assert.match(line, /automatically/);
  assert.match(line, /Cancel anytime/);
  assert.doesNotMatch(line, /usual monthly price/);
});
