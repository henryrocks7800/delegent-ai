import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

const intentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sku = shared.APPLE_IAP_PRODUCT_IDS.studio;
const transactionId = '2000000001234567';
const source = readFileSync(new URL('../../apps/mobile/src/billing/appleIap.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ admissionStatus = 200, admission = { intentId, expiresAt: new Date(Date.now()+3_600_000).toISOString() },
  outcome = 'success', cancelStatus = 200, verifyStatus = 200, verifyError, owned = [], ownedError = false } = {}) {
  const calls = [], timers = new Map();
  let updated, failed, activeToken = 'account_a_token', timerId = 0;
  const store = {
    initConnection: async () => true,
    fetchProducts: async () => [{ id: sku }],
    getAvailablePurchases: async () => { if (ownedError) throw Error('unknown ownership'); return owned; },
    purchaseUpdatedListener: listener => { updated = listener; return { remove() { updated = null; } }; },
    purchaseErrorListener: listener => { failed = listener; return { remove() { failed = null; } }; },
    requestPurchase(input) {
      calls.push(['sheet', input]);
      if (outcome === 'sync_throw') throw Error('native setup failed');
      if (outcome === 'timeout') return Promise.resolve();
      queueMicrotask(() => {
        if (outcome === 'cancel') failed?.({ code: 'user-cancelled' });
        else if (outcome === 'misleading_cancel') failed?.({ code: 'network-error', message: 'Could not cancel pending request' });
        else if (outcome === 'network') failed?.({ code: 'network-error' });
        else {
          if (outcome === 'account_change') activeToken = 'account_b_token';
          if (outcome === 'unrelated') updated?.({ productId: sku, transactionId: '2000000999999999', appAccountToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
          updated?.({ productId: sku, transactionId, appAccountToken: intentId });
        }
      });
      return Promise.resolve({ transactionId: 'wrong_dispatch_return' });
    },
    finishTransaction: async input => { calls.push(['finish', input]); },
  };
  const dependencies = {
    '@sidekick/shared': shared, 'react-native': { Platform: { OS: 'ios' }, Linking: {} },
    '../auth/generatedExpoPublicEnv': { generatedExpoPublicEnv: { EXPO_PUBLIC_IOS_PURCHASE_MODE: 'iap' } },
    '../auth/supabaseClient': { mobileSupabase: {}, getFreshMobileAccessToken: async () => activeToken },
    './mobileCheckout': { mobileCheckoutApiBaseUrl: 'https://fixture.test' },
    '../analytics/reportConfirmedPurchaseClient': { reportConfirmedPurchase: async () => ({ meta: 'sent', analytics: 'sent' }) },
    './appleOffer': {}, '../observability/sentry': {}, 'expo-iap': store,
  };
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push([path, JSON.parse(init.body), init.headers.authorization]);
    if (path === '/api/apple/iap/intent') return Response.json(admission, { status: admissionStatus });
    if (path === '/api/apple/iap/intent/cancel') return Response.json(cancelStatus === 200 ? { canceled: true }
      : { error: 'subscription_payment_pending' }, { status: cancelStatus });
    if (path === '/api/apple/iap/verify') return Response.json(verifyStatus === 200 ? { ok: true, tierId: 'studio',
      expiresAt: new Date(Date.now()+3_600_000).toISOString() } : { error: verifyError }, { status: verifyStatus });
    throw Error('Unexpected client HTTP boundary');
  };
  const exports = {};
  new Function('require','exports','fetch','setTimeout','clearTimeout', code)(name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw Error('Unmocked native dependency: '+name);
  }, exports, fetcher, (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, id => timers.delete(id));
  return { calls, timers, buy: () => exports.purchaseTierWithStoreKit('studio'),
    restore: () => exports.restoreApplePurchases(), listeners: () => [updated, failed] };
}

test('StoreKit is admitted first, carries the server UUID and finishes only after verified delivery', async () => {
  const f = fixture();
  assert.ok((await f.buy()).purchased);
  assert.deepEqual(f.calls.map(call => call[0]), ['/api/apple/iap/intent','sheet','/api/apple/iap/verify','finish']);
  assert.deepEqual(f.calls[1][1], { request: { apple: { sku, appAccountToken: intentId } }, type: 'subs' });
  assert.deepEqual(f.calls[2][1], { transactionId });
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.listeners(), [null, null]);
});

test('admission refusals, malformed responses and expired intents never open StoreKit', async () => {
  for (const options of [
    { admissionStatus: 401 }, { admissionStatus: 403 },
    { admissionStatus: 409, admission: { error: 'already_subscribed_via_stripe' } },
    { admissionStatus: 503, admission: { error: 'purchase_pending' } },
    { admissionStatus: 409, admission: { error: 'purchase_requires_review' } },
    { admission: null }, { admission: { intentId: 'forged', expiresAt: '2099-01-01' } },
    { admission: { intentId, expiresAt: '2020-01-01' } }, { ownedError: true },
  ]) {
    const f = fixture(options);
    assert.ok((await f.buy()).error);
    assert.equal(f.calls.filter(call => call[0] === 'sheet').length, 0);
  }
});

test('only definite cancellation releases admission, and a completed/cancel-failed attempt stays pending', async () => {
  for (const cancelStatus of [200,409,503]) {
    const f = fixture({ outcome: 'cancel', cancelStatus });
    const result = await f.buy();
    assert.equal(result.error.reason, cancelStatus === 200 ? 'cancelled' : 'purchase_pending');
    assert.deepEqual(f.calls.find(call => call[0].endsWith('/cancel'))?.slice(1), [{ intentId }, 'Bearer account_a_token']);
    assert.equal(f.calls.filter(call => call[0] === 'finish').length, 0);
  }
  for (const outcome of ['network','misleading_cancel','sync_throw']) {
    const f = fixture({ outcome });
    assert.equal((await f.buy()).error.reason, 'purchase_pending');
    assert.equal(f.calls.some(call => call[0].endsWith('/cancel')), false);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.listeners(), [null, null]);
  }
});

test('an uncertain native timeout keeps admission and blocks a simultaneous second sheet', async () => {
  const f = fixture({ outcome: 'timeout' });
  const first = f.buy();
  assert.equal((await f.buy()).error.reason, 'purchase_pending');
  for (let tick=0; tick<100 && !f.calls.some(call => call[0] === 'sheet'); tick++) await Promise.resolve();
  const deadline = [...f.timers.values()].find(timer => timer.delay === 300_000);
  assert.ok(deadline, 'the actual native outcome deadline was registered');
  deadline.callback();
  assert.equal((await first).error.reason, 'purchase_pending');
  assert.equal(f.calls.filter(call => call[0] === 'sheet').length, 1);
  assert.equal(f.calls.some(call => call[0].endsWith('/cancel')), false);
  assert.deepEqual(f.listeners(), [null, null]);
});

test('post-payment verification stays with the admitted account and ignores unrelated native events', async () => {
  for (const outcome of ['account_change','unrelated']) {
    const f = fixture({ outcome });
    assert.ok((await f.buy()).purchased);
    const verification = f.calls.find(call => call[0].endsWith('/verify'));
    assert.equal(verification[2], 'Bearer account_a_token');
    assert.deepEqual(verification[1], { transactionId });
  }
});

test('a paid conflict stays unfinished with review copy, while an existing purchase restores without admission', async () => {
  const conflict = fixture({ verifyStatus: 503, verifyError: 'billing_purchase_conflict' });
  assert.equal((await conflict.buy()).error.reason, 'purchase_requires_review');
  assert.equal(conflict.calls.some(call => call[0] === 'finish'), false);
  for (const verifyStatus of [200,503]) {
    const f = fixture({ owned: [{ productId: sku, transactionId }], verifyStatus });
    const result = await f.buy();
    assert.equal(Boolean(result.purchased), verifyStatus === 200);
    assert.deepEqual(f.calls.map(call => call[0]), ['/api/apple/iap/verify']);
  }
});
