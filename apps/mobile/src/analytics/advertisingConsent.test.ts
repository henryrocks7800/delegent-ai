import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvertisingConsent, advertisingConsentKey, type AdvertisingLease } from './advertisingConsent';
import { captureInstallReferrerWith } from './installReferrer';
import { reportPurchaseToMeta } from './metaPurchase';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
function fixture() {
  const store = new Map<string, string>();
  const flags: boolean[] = []; const captures: AdvertisingLease[] = [];
  const requests: Array<{ user: string; granted: boolean; revision: number }> = [];
  let respond = async () => true;
  const storage = { getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => { store.set(key, value); } };
  const consent = createAdvertisingConsent({ storage, newDeviceId: () => 'fixture-device',
    apply: (value) => flags.push(value),
    report: async (user, granted, _device, revision, valid) => {
      assert.equal(valid(), true); requests.push({ user, granted, revision }); return respond();
    },
    capture: async (permission) => { captures.push(permission); },
  });
  return { consent, store, storage, flags, captures, requests, response: (fn: () => Promise<boolean>) => { respond = fn; } };
}

test('legacy global consent is not inherited; capture waits for account grant and server acknowledgement', async () => {
  const f = fixture(); f.store.set('delegent.metaAdsConsent.v1', 'granted');
  await f.consent.activate('A');
  assert.equal(await f.consent.state(), 'unasked');
  assert.equal(f.consent.lease(), null); assert.equal(f.captures.length, 0);
  assert.deepEqual(f.requests, [{ user: 'A', granted: false, revision: 1 }]);
  const response = deferred<boolean>(); f.response(() => response.promise);
  const pending = f.consent.decide(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(f.store.get(advertisingConsentKey('A'))!).state, 'granted');
  assert.equal(f.consent.lease(), null);
  response.resolve(true); await pending;
  assert.equal(f.consent.lease()?.valid(), true); assert.equal(f.captures.length, 1);
});

test('offline withdrawal is saved, disables immediately, and retries on next launch', async () => {
  const f = fixture(); await f.consent.activate('A'); await f.consent.decide(true);
  const old = f.consent.lease()!; f.response(async () => false);
  const pending = f.consent.decide(false);
  assert.equal(old.valid(), false); assert.equal(f.flags.at(-1), false);
  await pending;
  assert.equal(JSON.parse(f.store.get(advertisingConsentKey('A'))!).state, 'denied');
  await f.consent.activate(null); f.response(async () => true); await f.consent.activate('A');
  assert.equal(f.requests.at(-1)?.granted, false);
  assert.equal(f.requests.at(-1)?.revision, 3, 'retry same durable intent, never create a new grant');
  assert.equal(f.consent.lease(), null);
});

test('delayed grant response cannot re-enable after withdrawal or change of account', async () => {
  for (const action of ['withdraw', 'switch'] as const) {
    const f = fixture(); await f.consent.activate('A');
    const response = deferred<boolean>(); f.response(() => response.promise);
    const grant = f.consent.decide(true); await new Promise((r) => setImmediate(r));
    const newer = action === 'withdraw' ? f.consent.decide(false) : f.consent.activate('B');
    response.resolve(true); await Promise.all([grant, newer]);
    assert.equal(f.consent.lease(), null); assert.equal(f.captures.length, 0);
    assert.equal(f.flags.includes(true), false);
    assert.equal(f.requests.at(-1)?.granted, false);
  }
});

test('an unanswered ATT prompt cannot override a later refusal', async () => {
  const f = fixture(); await f.consent.activate('A');
  const att = deferred<boolean>();
  const grant = f.consent.decide(true, () => att.promise);
  await new Promise((r) => setImmediate(r));
  await f.consent.decide(false); att.resolve(true); await grant;
  assert.equal(await f.consent.state(), 'denied'); assert.equal(f.flags.includes(true), false);
});

test('stored account choices do not leak between users and a stale lease never revives', async () => {
  const f = fixture(); await f.consent.activate('A'); await f.consent.decide(true);
  const first = f.consent.lease()!;
  await f.consent.activate('B'); assert.equal(await f.consent.state(), 'unasked');
  await f.consent.activate('A'); assert.equal(f.consent.lease()?.valid(), true);
  assert.equal(first.valid(), false);
});

test('a referrer still being read when consent is withdrawn is neither posted nor marked done', async () => {
  const raw = deferred<string>(); let allowed = true; let writes = 0; let posts = 0;
  const capture = captureInstallReferrerWith({ allowed: () => allowed,
    storage: { getItem: async () => null, setItem: async () => { writes++; } },
    getInstallReferrer: () => raw.promise, post: async () => { posts++; return true; } });
  await new Promise((r) => setImmediate(r)); allowed = false; raw.resolve('fbclid=secretclick');
  assert.deepEqual(await capture, { status: 'skipped', reason: 'no_consent' });
  assert.equal(posts, 0); assert.equal(writes, 0);
});

test('declined consent never even reads the device referrer', async () => {
  let reads = 0;
  const result = await captureInstallReferrerWith({ allowed: () => false,
    storage: { getItem: async () => null, setItem: async () => undefined },
    getInstallReferrer: async () => { reads++; return 'anything'; }, post: async () => true });
  assert.equal(result.status, 'skipped'); assert.equal(reads, 0);
});

test('purchase waiting on native SDK load is discarded after withdrawal', async () => {
  let allowed = true; let sends = 0;
  const logger = deferred<{ logPurchase: () => void }>();
  const purchase = reportPurchaseToMeta({ canSend: () => allowed,
    storage: { getItem: async () => 'granted', setItem: async () => undefined },
    loadLogger: () => logger.promise }, { amount: 9.99, currency: 'GBP', tierId: 'studio', source: 'stripe' });
  await new Promise((r) => setImmediate(r)); allowed = false; logger.resolve({ logPurchase: () => { sends++; } });
  assert.equal(await purchase, 'no_consent'); assert.equal(sends, 0);
});
