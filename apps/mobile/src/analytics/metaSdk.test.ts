// The property that matters: nothing is collected unless consent was granted.
//
// Every test here is really the same question asked differently, because the
// expensive failure is not "ads did not optimise", it is "we collected an
// advertising identifier from someone who never agreed".
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMetaConsent, setMetaConsent, readMetaConsent, META_CONSENT_KEY } from './metaSdk';

function fakes(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    storage: {
      async getItem(k: string) { return store[k] ?? null; },
      async setItem(k: string, v: string) { store[k] = v; },
    },
    settings: {
      setAutoLogAppEventsEnabled(e: boolean) { calls.push(`autoLog:${e}`); },
      setAdvertiserIDCollectionEnabled(e: boolean) { calls.push(`advId:${e}`); },
      initializeSDK() { calls.push('init'); },
    },
  };
}

test('a fresh install collects nothing and does not initialise the SDK', async () => {
  const f = fakes();
  const state = await applyMetaConsent(f);
  assert.equal(state, 'unasked');
  assert.deepEqual(f.calls, [], 'the SDK must stay inert until someone says yes');
});

test('an explicit refusal collects nothing', async () => {
  const f = fakes({ [META_CONSENT_KEY]: 'denied' });
  await applyMetaConsent(f);
  assert.deepEqual(f.calls, []);
});

test('granted consent enables collection, and sets flags BEFORE init', async () => {
  const f = fakes({ [META_CONSENT_KEY]: 'granted' });
  await applyMetaConsent(f);
  assert.deepEqual(f.calls, ['autoLog:true', 'advId:true', 'init']);
  // If init ran first the SDK would come up with collection disabled and report
  // nothing, which looks exactly like the SDK not being installed at all.
  assert.ok(f.calls.indexOf('init') > f.calls.indexOf('advId:true'));
});

test('withdrawing consent actually turns collection off, not just the prompt', async () => {
  const f = fakes({ [META_CONSENT_KEY]: 'granted' });
  await setMetaConsent(f, false);
  assert.deepEqual(f.calls, ['autoLog:false', 'advId:false']);
  assert.equal(await readMetaConsent(f.storage), 'denied');
});

test('unreadable storage fails CLOSED', async () => {
  const f = fakes();
  f.storage.getItem = async () => { throw new Error('storage unavailable'); };
  assert.equal(await readMetaConsent(f.storage), 'unasked');
  assert.deepEqual((await applyMetaConsent(f), f.calls), [], 'an error must never be read as consent');
});

test('a missing native module does not throw', async () => {
  // The SDK is absent in Expo Go and in any build made without the plugin
  // values. Consent handling must not crash the app in that case.
  const f = fakes({ [META_CONSENT_KEY]: 'granted' });
  const state = await applyMetaConsent({ storage: f.storage, settings: null });
  assert.equal(state, 'granted');
});
