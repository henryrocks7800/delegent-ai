// The install-referrer capture. Runs under tsx with injected fakes, matching
// ga4.test.ts, so no device or native module is needed.
//
// What these hold: the referrer is readable ONCE, for 90 days, and never again.
// So the rules that matter are "do not mark done before the server has it" and
// "never let a failure here disturb the user".
import test from 'node:test';
import assert from 'node:assert/strict';

import { captureInstallReferrerWith } from './installReferrer';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
  };
}

test('a referrer is posted and then marked done', async () => {
  const storage = fakeStorage();
  const posted: unknown[] = [];
  const result = await captureInstallReferrerWith({
    getInstallReferrer: async () => 'utm_source=fb4a&utm_content=%7B%7D',
    post: async (body) => { posted.push(body); return true; },
    storage,
  });
  assert.equal(result.status, 'captured');
  assert.deepEqual(posted, [{ referrer: 'utm_source=fb4a&utm_content=%7B%7D' }]);
  assert.equal(storage.map.size, 1, 'the done-flag should be written');
});

test('it never asks twice', async () => {
  const storage = fakeStorage({ 'delegent.installReferrer.captured.v1': '2026-08-06T00:00:00Z' });
  let asked = false;
  const result = await captureInstallReferrerWith({
    getInstallReferrer: async () => { asked = true; return 'x'; },
    post: async () => true,
    storage,
  });
  assert.equal(result.status, 'already-done');
  assert.equal(asked, false, 'the native call should not even be made once we have a flag');
});

test('a FAILED post does NOT mark done, so the next launch retries', async () => {
  // This is the important one. Marking done on read would throw away the only
  // copy of the attribution if the network hiccuped, and there is no second
  // chance after 90 days.
  const storage = fakeStorage();
  const result = await captureInstallReferrerWith({
    getInstallReferrer: async () => 'utm_source=fb4a',
    post: async () => false,
    storage,
  });
  assert.equal(result.status, 'failed');
  assert.equal(storage.map.size, 0, 'nothing should be marked done when the server did not take it');
});

test('an empty referrer IS marked done, because it will never become non-empty', async () => {
  // Sideloads, some OEM stores and the emulator return nothing. Retrying for
  // ever would be pointless work on every single launch.
  const storage = fakeStorage();
  const result = await captureInstallReferrerWith({
    getInstallReferrer: async () => '',
    post: async () => { throw new Error('should not post an empty referrer'); },
    storage,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(storage.map.size, 1);
});

test('a throwing native module never escapes as an error', async () => {
  const storage = fakeStorage();
  const result = await captureInstallReferrerWith({
    getInstallReferrer: async () => { throw new TypeError('module missing'); },
    post: async () => true,
    storage,
  });
  assert.equal(result.status, 'failed');
  assert.equal((result as { reason: string }).reason, 'TypeError');
});
