// One completed purchase, reported once, for the amount that was charged.
//
// The GA4 side used to bypass this file entirely: the checkout callback built a
// `purchase` event from the tier's CATALOGUE price, with no receipt, no
// currency from the biller and no transaction id. So a customer on the 2.99
// introductory coupon was reported to Google Ads as 9.99, a returning
// subscriber whose checkout was refused for already being active was reported
// as a purchase, and a second call reported the same money again.
import assert from 'node:assert/strict';
import test from 'node:test';

import { reportConfirmedPurchaseWith, REPORTED_PURCHASES_STORAGE_KEY } from './reportConfirmedPurchase';

function fixture({ storageFails = false } = {}) {
  const store = new Map<string, string>();
  const events: { name: string; props: Record<string, string | number | boolean> }[] = [];
  const metaCalls: unknown[] = [];
  return {
    store, events, metaCalls,
    deps: {
      storage: {
        async getItem(key: string) {
          if (storageFails) throw new Error('storage unavailable');
          return store.has(key) ? store.get(key)! : null;
        },
        async setItem(key: string, value: string) {
          if (storageFails) throw new Error('storage unavailable');
          store.set(key, value);
        },
      },
      trackEvent(name: string, props: Record<string, string | number | boolean>) { events.push({ name, props }); },
      async meta(facts: unknown) { metaCalls.push(facts); return 'sent' as const; },
    },
  };
}

test('a confirmed purchase reports the charged amount with its transaction id', async () => {
  const f = fixture();
  const result = await reportConfirmedPurchaseWith(f.deps, 'studio', 'apple',
    { amount: 2.99, currency: 'gbp', transactionId: '2000000123' });

  assert.equal(result.analytics, 'sent');
  assert.equal(result.meta, 'sent');
  assert.deepEqual(f.events, [{ name: 'purchase', props: {
    currency: 'GBP', value: 2.99, transaction_id: 'apple:2000000123', tier: 'studio' } }]);
  assert.deepEqual(f.metaCalls, [{ amount: 2.99, currency: 'GBP', tierId: 'studio', source: 'apple' }]);
  assert.match(f.store.get(REPORTED_PURCHASES_STORAGE_KEY) ?? '', /apple:2000000123/);
});

test('the same payment is never reported twice, including after a restart', async () => {
  const f = fixture();
  const facts = { amount: 9.99, currency: 'GBP', transactionId: '2000000999' };
  await reportConfirmedPurchaseWith(f.deps, 'studio', 'apple', facts);
  assert.equal(f.events.length, 1);

  // A restore, a retry, or a second foreground. The ledger is on disk, so a
  // fresh process reaches the same answer.
  const second = await reportConfirmedPurchaseWith(f.deps, 'studio', 'apple', facts);
  assert.equal(second.analytics, 'duplicate');
  assert.equal(f.events.length, 1, 'the money may only be counted once');
});

test('a payment with no transaction id reports nothing to analytics', async () => {
  // There would be nothing to deduplicate against, and an event that can be
  // emitted twice is worse than a missing one.
  const f = fixture();
  const result = await reportConfirmedPurchaseWith(f.deps, 'studio', 'stripe', { amount: 9.99, currency: 'GBP' });
  assert.equal(result.analytics, 'no_transaction_id');
  assert.deepEqual(f.events, []);
  // Meta's own rule is unchanged: it deduplicates its own way and still wants
  // the payment facts.
  assert.equal(result.meta, 'sent');
});

test('a trial, a restore and an unknown tier all report no purchase at all', async () => {
  for (const payment of [
    undefined,
    { amount: 0, currency: 'GBP', transactionId: 'x' },
    { amount: null, currency: 'GBP', transactionId: 'x' },
    { amount: 9.99, currency: null, transactionId: 'x' },
    { amount: 9.99, currency: 'pounds', transactionId: 'x' },
  ] as const) {
    const f = fixture();
    const result = await reportConfirmedPurchaseWith(f.deps, 'studio', 'apple', payment as never);
    assert.equal(result.analytics, 'invalid_amount', JSON.stringify(payment));
    assert.equal(result.meta, 'invalid_amount');
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.metaCalls, []);
  }

  const unknownTier = fixture();
  const result = await reportConfirmedPurchaseWith(unknownTier.deps, 'not-a-tier' as never, 'apple',
    { amount: 9.99, currency: 'GBP', transactionId: 'x' });
  assert.equal(result.analytics, 'invalid_amount');
  assert.deepEqual(unknownTier.events, []);
});

test('a ledger we cannot read fails closed rather than reporting again', async () => {
  const f = fixture({ storageFails: true });
  const result = await reportConfirmedPurchaseWith(f.deps, 'studio', 'apple',
    { amount: 9.99, currency: 'GBP', transactionId: 'unreadable' });
  assert.equal(result.analytics, 'duplicate');
  assert.deepEqual(f.events, [], 'a storage failure must not become a second report of the same money');
});
