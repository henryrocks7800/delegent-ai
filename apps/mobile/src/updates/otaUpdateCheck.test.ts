// Unit tests for checkAndFetchOtaUpdate, the DI core behind the "new version
// ready" banner. Runs under tsx (node --test --import tsx). The core imports
// nothing native, so these inject fake expo-updates deps and assert the
// defensive contract: it reports "ready" ONLY when a new update is downloaded,
// and NEVER throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkAndFetchOtaUpdate, type OtaUpdateCheckDeps } from './otaUpdateCheck';

function makeDeps(over: Partial<OtaUpdateCheckDeps> = {}): OtaUpdateCheckDeps {
  return {
    isEnabled: true,
    checkForUpdate: async () => ({ isAvailable: true }),
    fetchUpdate: async () => ({ isNew: true }),
    ...over,
  };
}

test('reports ready when an update is available and the fetched bundle is new', async () => {
  assert.equal(await checkAndFetchOtaUpdate(makeDeps()), true);
});

test('reports NOT ready (and never fetches) when updates are disabled (dev / Expo Go)', async () => {
  let fetched = 0;
  const ok = await checkAndFetchOtaUpdate(makeDeps({
    isEnabled: false,
    fetchUpdate: async () => { fetched += 1; return { isNew: true }; },
  }));
  assert.equal(ok, false);
  assert.equal(fetched, 0, 'must not even check/fetch when updates are disabled');
});

test('reports NOT ready (and never fetches) when no update is available', async () => {
  let fetched = 0;
  const ok = await checkAndFetchOtaUpdate(makeDeps({
    checkForUpdate: async () => ({ isAvailable: false }),
    fetchUpdate: async () => { fetched += 1; return { isNew: true }; },
  }));
  assert.equal(ok, false);
  assert.equal(fetched, 0, 'must not fetch when nothing is available');
});

test('reports NOT ready when the fetched bundle is not actually new', async () => {
  assert.equal(await checkAndFetchOtaUpdate(makeDeps({ fetchUpdate: async () => ({ isNew: false }) })), false);
});

test('a thrown check error never bubbles to the UI (resolves false)', async () => {
  const ok = await checkAndFetchOtaUpdate(makeDeps({ checkForUpdate: async () => { throw new Error('network'); } }));
  assert.equal(ok, false);
});

test('a thrown fetch error never bubbles to the UI (resolves false)', async () => {
  const ok = await checkAndFetchOtaUpdate(makeDeps({ fetchUpdate: async () => { throw new Error('download failed'); } }));
  assert.equal(ok, false);
});

test('a null/undefined check result is treated as not ready', async () => {
  assert.equal(await checkAndFetchOtaUpdate(makeDeps({ checkForUpdate: async () => null })), false);
  assert.equal(await checkAndFetchOtaUpdate(makeDeps({ checkForUpdate: async () => undefined })), false);
});
