import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPurchaseParams,
  consentForAdvertisingAnswer,
  createFirebaseTracker,
  isValidFirebaseEventName,
  toFirebaseParams,
  type FirebaseAnalyticsApi,
  type FirebaseConsent,
} from './firebaseAnalytics';

function fakeApi() {
  const calls: { events: Array<[string, Record<string, unknown> | undefined]>; consents: FirebaseConsent[] } = { events: [], consents: [] };
  const api: FirebaseAnalyticsApi = {
    async logEvent(name, params) { calls.events.push([name, params]); },
    async setConsent(consent) { calls.consents.push(consent); },
    async setAnalyticsCollectionEnabled() {},
  };
  return { api, calls };
}

test('event names follow the Firebase contract and reserved prefixes are refused', () => {
  for (const ok of ['sign_in_completed', 'payment_completed', 'purchase', 'screen_view', 'a'.repeat(40)]) assert.equal(isValidFirebaseEventName(ok), true, ok);
  for (const bad of ['', '1st_open', 'has-dash', 'firebase_x', 'google_y', 'ga_z', 'a'.repeat(41)]) assert.equal(isValidFirebaseEventName(bad), false, bad);
});

test('params are shaped to Firebase limits without ever throwing', () => {
  const params = toFirebaseParams({
    tier: 'studio', count: 3, flag: true, gone: null, missing: undefined,
    'bad key!': 'x', long: 'y'.repeat(150), nan: Number.NaN, firebase_reserved: 'no',
  });
  assert.deepEqual(Object.keys(params).sort(), ['bad_key_', 'count', 'flag', 'long', 'tier']);
  assert.equal((params.long as string).length, 100);
  assert.equal(params.count, 3);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, i]));
  assert.equal(Object.keys(toFirebaseParams(many)).length, 25);
});

test('analytics storage is always on; the three advertising signals follow the in-app answer', () => {
  assert.deepEqual(consentForAdvertisingAnswer(true), { analytics_storage: true, ad_storage: true, ad_user_data: true, ad_personalization: true });
  assert.deepEqual(consentForAdvertisingAnswer(false), { analytics_storage: true, ad_storage: false, ad_user_data: false, ad_personalization: false });
});

test('purchase carries the amount that was charged, with the transaction it belongs to', () => {
  // It used to take the tier's CATALOGUE price, so somebody on the 2.99
  // introductory coupon was reported to Google Ads as 9.99, and it carried no
  // transaction id at all, so the same payment could be counted twice.
  assert.deepEqual(
    buildPurchaseParams({ tierId: 'studio', amount: 2.99, currency: 'GBP', transactionId: 'apple:2000000123' }),
    { currency: 'GBP', value: 2.99, transaction_id: 'apple:2000000123', tier: 'studio' },
  );
  assert.equal(buildPurchaseParams({ tierId: 'studio', amount: 0, currency: 'GBP', transactionId: 'x' }), null);
  assert.equal(buildPurchaseParams({ tierId: 'studio', amount: Number.NaN, currency: 'GBP', transactionId: 'x' }), null);
  assert.equal(buildPurchaseParams({ tierId: 'studio', amount: 9.99, currency: 'gbp', transactionId: 'x' }), null,
    'a currency we did not normalise is a currency we did not verify');
  assert.equal(buildPurchaseParams({ tierId: 'studio', amount: 9.99, currency: 'GBP', transactionId: '  ' }), null,
    'no transaction id means no way to deduplicate, which is worse than no event');
});

test('the tracker is fire-and-forget: a rejecting or throwing native API never reaches the caller', async () => {
  const { api, calls } = fakeApi();
  const tracker = createFirebaseTracker(api);
  tracker.trackEvent('viewed_plans', { tier: 'studio' });
  tracker.trackEvent('not valid!', {});
  tracker.applyAdvertisingConsent(false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.events, [['viewed_plans', { tier: 'studio' }]]);
  assert.equal(calls.consents.length, 1);

  const hostile = createFirebaseTracker({
    logEvent: () => Promise.reject(new Error('native down')),
    setConsent: () => { throw new Error('sync throw'); },
    setAnalyticsCollectionEnabled: async () => {},
  });
  assert.doesNotThrow(() => hostile.trackEvent('sign_in_completed'));
  assert.doesNotThrow(() => hostile.applyAdvertisingConsent(true));
  await new Promise((r) => setImmediate(r));
});
