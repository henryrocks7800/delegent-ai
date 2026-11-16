import test from 'node:test';
import assert from 'node:assert/strict';
import { applePlanOffer, productOffersFreeMonth, productOffersThreeDayTrial } from './appleOffer.ts';

const product = {
  id: 'studio', displayPrice: 'CA$12.99', introductoryPricePaymentModeIOS: 'free-trial',
  introductoryPriceSubscriptionPeriodIOS: 'day', introductoryPriceNumberOfPeriodsIOS: '3',
};

test('confirmed eligibility gives the firm trial line, preserving the local price', () => {
  const quote = applePlanOffer(product, true);
  assert.equal(quote.hasThreeDayTrial, true);
  assert.equal(quote.offersThreeDayTrial, true);
  assert.match(quote.priceLine, /^3 days free, then CA\$12.99 per month/);
  assert.doesNotMatch(quote.priceLine, /new subscribers/);
});

// The first price must not imply a free start when the native sheet charges
// the monthly price. Still explain the possible offer, covering the reverse
// disagreement seen on 12 September without asserting the user qualifies.
test('unknown or negative eligibility leads with the monthly price and an explicitly conditional trial', () => {
  for (const eligible of [null, false] as const) {
    const quote = applePlanOffer(product, eligible);
    assert.equal(quote.hasThreeDayTrial, false, 'button and caption stay on the confirmed case');
    assert.equal(quote.offersThreeDayTrial, true);
    assert.match(quote.priceLine, /^CA\$12.99 per month\./);
    assert.match(quote.priceLine, /3-day free trial only applies if Apple offers it on the next screen/);
    assert.match(quote.priceLine, /billing starts automatically after the trial/);
    assert.match(quote.priceLine, /at least 24 hours before the trial ends/);
    assert.doesNotMatch(quote.priceLine, /3 days free for new subscribers/);
  }
});

test('no three-day free offer on the product means no trial claim at all', () => {
  for (const [candidate, eligible] of [
    [{ ...product, introductoryPricePaymentModeIOS: 'pay-as-you-go' }, true],
    [{ ...product, introductoryPricePaymentModeIOS: 'empty' }, null],
    [{ ...product, introductoryPriceNumberOfPeriodsIOS: '7' }, true],
    [{ ...product, introductoryPriceSubscriptionPeriodIOS: 'month' }, true],
    [{ id: 'studio', displayPrice: 'CA$12.99' }, true],
  ] as const) {
    const result = applePlanOffer(candidate, eligible);
    assert.equal(productOffersThreeDayTrial(candidate), false);
    assert.equal(result.hasThreeDayTrial, false);
    assert.equal(result.offersThreeDayTrial, false);
    assert.doesNotMatch(result.priceLine, /3 days free/);
    assert.match(result.priceLine, /CA\$12.99 per month\. Apple confirms any eligible offer/);
  }
});

// The assistant plan (2026-09-16): £3.99 with the first month free. Same rule
// as the three-day trial: firm wording only once Apple has confirmed eligibility.
test('the assistant plan quotes its free first month only when Apple confirms it', () => {
  const assistant = { id: 'com.sidekick.v2.assistant.monthly', displayPrice: '£3.99', introductoryPricePaymentModeIOS: 'free-trial', introductoryPriceSubscriptionPeriodIOS: 'month', introductoryPriceNumberOfPeriodsIOS: '1' };
  assert.equal(productOffersFreeMonth(assistant), true);
  const firm = applePlanOffer(assistant, true);
  assert.equal(firm.hasFreeMonth, true);
  assert.equal(firm.hasThreeDayTrial, false);
  assert.match(firm.priceLine, /^First month free, then £3.99 a month\./);
  assert.ok(firm.priceLine.length < 120, 'kept short for the phone (Alex, 2026-09-16)');
  for (const eligible of [null, false] as const) {
    const quote = applePlanOffer(assistant, eligible);
    assert.equal(quote.hasFreeMonth, false);
    assert.equal(quote.offersFreeMonth, true);
    assert.match(quote.priceLine, /^£3.99 a month\. New subscribers get the first month free if Apple offers it on the next screen\./);
    assert.ok(quote.priceLine.length < 150, 'kept short for the phone (Alex, 2026-09-16)');
  }
  assert.equal(applePlanOffer(product, true).offersFreeMonth, false, 'a three-day product is not a free month');
});

test('a product without a price never quotes the trial, whatever the offer fields say', () => {
  const result = applePlanOffer({ ...product, displayPrice: '' }, true);
  assert.equal(result.hasThreeDayTrial, false);
  assert.equal(result.offersThreeDayTrial, false);
  assert.doesNotMatch(result.priceLine, /3 days free/);
  assert.match(result.priceLine, /See your local price/);
});
