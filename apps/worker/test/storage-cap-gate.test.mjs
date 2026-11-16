// Storage-cap enforcement (roadmap item 12).
//
// usage_quotas.consumed_storage_bytes has been measured since migration 0044
// but nothing ever acted on it, so the per-tier storage entitlement was a
// number in a table rather than a real limit. These tests pin the gate that
// turns it into one: a user whose private volume is at its cap gets a calm
// 402 telling them to free space or upgrade, instead of a mid-run failure when
// the agent tries to write a file onto a full disk.
//
// The two dangerous directions are covered deliberately:
//   - blocking someone who should not be blocked (no entitlement on file yet,
//     or a reading that was never taken because the 6-hourly sweep is down)
//   - not blocking someone who is genuinely over
//
// IMPORTANT: runs against ../dist/index.js, so `npm test` from the worker
// workspace (which builds first).

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStorageGate, buildStorageBlockedBody, fetchUsageSnapshot } from '../dist/index.js';

const GB = 1024 ** 3;

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
};

function snapshot(overrides = {}) {
  return {
    userId: '11111111-2222-4333-8444-555555555555',
    tierId: 'studio',
    monthlyTokenQuota: 200_000,
    usedTokens: 0,
    remainingTokens: 200_000,
    hardLimited: false,
    periodStart: '2026-07-01T00:00:00.000Z',
    consumedStorageBytes: 1 * GB,
    storageQuotaBytes: 10 * GB,
    storageMeasuredAt: '2026-07-25T06:00:00.000Z',
    storageHardLimited: false,
    ...overrides,
  };
}

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

// ------------------------------------------------------------- resolveStorageGate

test('a user under their storage cap is let through', () => {
  const gate = resolveStorageGate(snapshot());
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, 'allowed');
});

test('a user at their storage cap is stopped with a 402', () => {
  const gate = resolveStorageGate(snapshot({ storageHardLimited: true }));
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 402, 'payment-required is what the client maps to the upgrade prompt');
  assert.equal(gate.reason, 'storage_limit_exceeded');
});

// ------------------------------------------------------- buildStorageBlockedBody

test('the blocked body carries the storage wording, not the token wording', () => {
  const body = buildStorageBlockedBody(snapshot({ storageHardLimited: true, consumedStorageBytes: 10 * GB }));

  assert.equal(body.capKind, 'storage');
  assert.equal(body.reason, 'storage_limit_exceeded');
  assert.equal(body.pause.capKind, 'storage');
  assert.match(body.pause.primary, /cloud space is full/i);
  assert.match(body.pause.secondary, /upgrade/i, 'the user is told how to get more room');
  assert.ok(
    !/assistant time/i.test(`${body.pause.primary} ${body.pause.secondary}`),
    'a full disk must not be described as running out of monthly assistant time',
  );
});

test('the blocked body keeps the legacy error code so shipped clients still render it', () => {
  // Every APK in a user's hands renders `quota_exhausted` by joining
  // pause.primary + pause.secondary. Changing the top-level code would make
  // the storage block show a generic "chat unavailable" on those builds.
  const body = buildStorageBlockedBody(snapshot({ storageHardLimited: true }));
  assert.equal(body.error, 'quota_exhausted');
});

test('the blocked body reports the reading and when it was taken', () => {
  const body = buildStorageBlockedBody(snapshot({
    storageHardLimited: true,
    consumedStorageBytes: 11 * GB,
    storageQuotaBytes: 10 * GB,
    storageMeasuredAt: '2026-07-25T06:00:00.000Z',
  }));

  assert.equal(body.usedBytes, 11 * GB);
  assert.equal(body.limitBytes, 10 * GB);
  assert.equal(body.measuredAt, '2026-07-25T06:00:00.000Z', 'the sweep is 6-hourly, so support needs the reading age');
});

test('the blocked body never leaks provider internals', () => {
  const serialised = JSON.stringify(buildStorageBlockedBody(snapshot({ storageHardLimited: true })));
  for (const leak of ['fly', 'volume', 'machine', 'supabase', 'openrouter']) {
    assert.ok(!serialised.toLowerCase().includes(leak), `blocked body leaked "${leak}"`);
  }
});

// --------------------------------------------------------- fetchUsageSnapshot

function rows(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
}

function supabaseStub(quotaRow) {
  return async (url) => {
    const target = String(url);
    if (target.includes('usage_quotas')) return rows(quotaRow ? [quotaRow] : []);
    return rows([]);
  };
}

async function storageStateFor(quotaRow) {
  return withFetch(supabaseStub(quotaRow), async () => {
    const snap = await fetchUsageSnapshot('user-1', ENV, new Date('2026-07-25T12:00:00.000Z'));
    return snap;
  });
}

test('usage over the cap sets the storage hard limit', async () => {
  const snap = await storageStateFor({
    monthly_token_quota: 200_000,
    tier_id: 'studio',
    consumed_storage_bytes: 10 * GB,
    storage_quota_bytes: 10 * GB,
    storage_measured_at: '2026-07-25T06:00:00.000Z',
  });
  assert.equal(snap.storageHardLimited, true, 'at the cap counts as full, not "one byte to go"');
  assert.equal(snap.consumedStorageBytes, 10 * GB);
});

test('a volume that has never been measured never blocks the user', async () => {
  // If the 6-hourly sweep stops running, a null reading must fail open. The
  // alternative locks out every user we have simply not looked at yet.
  const snap = await storageStateFor({
    monthly_token_quota: 200_000,
    tier_id: 'studio',
    consumed_storage_bytes: 50 * GB,
    storage_quota_bytes: 10 * GB,
    storage_measured_at: null,
  });
  assert.equal(snap.storageHardLimited, false);
  assert.equal(resolveStorageGate(snap).ok, true);
});

test('a zero storage entitlement means unknown, not a cap of nothing', async () => {
  // Mirrors the D2 token rule: a user whose Stripe webhook has not yet written
  // usage_quotas would otherwise be blocked on their very first byte.
  const snap = await storageStateFor({
    monthly_token_quota: 200_000,
    tier_id: 'studio',
    consumed_storage_bytes: 1 * GB,
    storage_quota_bytes: 0,
    storage_measured_at: '2026-07-25T06:00:00.000Z',
  });
  assert.equal(snap.storageHardLimited, false);
});

test('a user with no usage_quotas row at all is not blocked', async () => {
  const snap = await storageStateFor(null);
  assert.equal(snap.storageHardLimited, false);
  assert.equal(snap.storageQuotaBytes, 0);
  assert.equal(snap.storageMeasuredAt, null);
});

test('a garbage storage reading is treated as zero rather than crashing the turn', async () => {
  const snap = await storageStateFor({
    monthly_token_quota: 200_000,
    tier_id: 'studio',
    consumed_storage_bytes: 'not-a-number',
    storage_quota_bytes: 10 * GB,
    storage_measured_at: '2026-07-25T06:00:00.000Z',
  });
  assert.equal(snap.consumedStorageBytes, 0);
  assert.equal(snap.storageHardLimited, false);
});

test('the storage columns are actually requested from Supabase', async () => {
  // The gate is only as real as the select. A dropped column would silently
  // read 0 for everyone and enforce nothing.
  let quotaUrl = '';
  await withFetch(async (url) => {
    const target = String(url);
    if (target.includes('usage_quotas')) quotaUrl = decodeURIComponent(target);
    return rows([]);
  }, () => fetchUsageSnapshot('user-1', ENV, new Date('2026-07-25T12:00:00.000Z')));

  assert.match(quotaUrl, /consumed_storage_bytes/);
  assert.match(quotaUrl, /storage_quota_bytes/);
  assert.match(quotaUrl, /storage_measured_at/);
});
