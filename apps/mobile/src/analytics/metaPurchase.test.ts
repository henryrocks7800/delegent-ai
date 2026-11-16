import test from 'node:test';
import assert from 'node:assert/strict';

import { META_CONSENT_KEY } from './metaSdk';
import { reportPurchaseToMeta, type MetaPurchaseLogger } from './metaPurchase';

function deps(consent: string | null, logger: MetaPurchaseLogger | null = null) {
  const sent: Array<[number, string, Record<string, string> | undefined]> = [];
  const spy: MetaPurchaseLogger = logger ?? {
    logPurchase: (a, c, p) => { sent.push([a, c, p]); },
  };
  return {
    sent,
    deps: {
      storage: {
        getItem: async (k: string) => (k === META_CONSENT_KEY ? consent : null),
        setItem: async () => {},
      },
      loadLogger: async () => (logger === null ? spy : logger),
      warn: () => {},
    },
  };
}

const FACTS = { amount: 30, currency: 'GBP', tierId: 'studio', source: 'stripe' as const };

test('sends the purchase when consent was granted', async () => {
  const { sent, deps: d } = deps('granted');
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'sent');
  assert.equal(sent.length, 1);
  const [amount, currency, params] = sent[0];
  assert.equal(amount, 30);
  assert.equal(currency, 'GBP');
  assert.equal(params?.fb_content_id, 'studio');
  assert.equal(params?.delegent_source, 'stripe');
});

// The consent card promises we share nothing with Meta unless the user agrees.
// A purchase event is exactly the kind of thing that promise is about.
test('sends NOTHING when consent was refused', async () => {
  const { sent, deps: d } = deps('denied');
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'no_consent');
  assert.equal(sent.length, 0);
});

test('sends NOTHING when the user was never asked', async () => {
  const { sent, deps: d } = deps(null);
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'no_consent');
  assert.equal(sent.length, 0);
});

// Meta optimises toward whatever value we report. A zero would teach it that a
// conversion is worthless, which is worse than reporting nothing at all.
test('refuses a zero, negative or non-finite amount', async () => {
  for (const amount of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { sent, deps: d } = deps('granted');
    assert.equal(await reportPurchaseToMeta(d, { ...FACTS, amount }), 'invalid_amount');
    assert.equal(sent.length, 0, `amount ${amount} must not be sent`);
  }
});

test('refuses an empty currency', async () => {
  const { sent, deps: d } = deps('granted');
  assert.equal(await reportPurchaseToMeta(d, { ...FACTS, currency: '' }), 'invalid_amount');
  assert.equal(sent.length, 0);
});

// Builds before 2.3.0, Expo Go, and anything built without the Meta app id have
// no SDK. That must be an ordinary outcome, never a crash on the screen someone
// sees straight after paying.
test('degrades quietly when the SDK is absent', async () => {
  const d = {
    storage: { getItem: async () => 'granted', setItem: async () => {} },
    loadLogger: async () => null,
    warn: () => {},
  };
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'no_logger');
});

test('never throws when the logger itself throws', async () => {
  const d = {
    storage: { getItem: async () => 'granted', setItem: async () => {} },
    loadLogger: async () => ({ logPurchase: () => { throw new Error('native boom'); } }),
    warn: () => {},
  };
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'failed');
});

test('never throws when storage is unreadable, and does not send', async () => {
  const sent: number[] = [];
  const d = {
    storage: {
      getItem: async () => { throw new Error('storage gone'); },
      setItem: async () => {},
    },
    loadLogger: async () => ({ logPurchase: (a: number) => { sent.push(a); } }),
    warn: () => {},
  };
  // readMetaConsent fails CLOSED, so this is 'no_consent', not a crash.
  assert.equal(await reportPurchaseToMeta(d, FACTS), 'no_consent');
  assert.equal(sent.length, 0);
});
