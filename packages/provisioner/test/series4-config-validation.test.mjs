// Comprehensive config/secrets validation for the Series 4 cron entrypoints.
//
// WHY THIS EXISTS (2026-05-29 incident): the provisioning cron failed silently
// for weeks because its GitHub Actions secrets were EMPTY. The fix was to set
// them, but the deeper lesson is that a missing/blank/whitespace/half-set config
// must ALWAYS fail loud (status: 'blocked') BEFORE any claim/teardown runs, and
// must never be silently defaulted. This test pins that contract for every
// required variable, in every way it can go wrong (unset, empty, whitespace),
// across all three Fly-touching cron jobs (provision / grace-expiry /
// account-deletion). If someone drops a preflight check or re-introduces a
// silent default, one of these fails.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  processNextSeries4FlyProvisioningJob,
  processNextSeries4GraceExpiry,
  processNextAccountDeletionRequest,
} from '../dist/index.js';

// A fully-valid env. Each test perturbs exactly one key.
const FLY_ENV = {
  FLY_API_TOKEN: 'FlyV1 fm2_test_token_value_that_must_not_leak',
  FLY_ORG: 'personal',
  FLY_PRIMARY_REGION: 'lhr',
  SIDEKICK_FLY_RUNNER_IMAGE_REF:
    'registry.fly.io/delegent-hermes-runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.test',
};

// Deps whose claim functions THROW — so a passing preflight is the only way the
// call could reach them. If preflight correctly blocks, claim is never invoked.
const blockingDeps = {
  store: {
    async claimNextSeries4FlyProvisioningJob() {
      throw new Error('provision claim ran despite invalid config — preflight failed to block');
    },
    async claimNextSeries4GraceExpiredRunner() {
      throw new Error('grace claim ran despite invalid config — preflight failed to block');
    },
    async claimNextAccountDeletionRequest() {
      throw new Error('account-deletion claim ran despite invalid config — preflight failed to block');
    },
  },
};

// Deps whose claim returns null — proves a VALID config passes preflight and
// reaches the (empty) queue, returning idle rather than blocked.
const idleDeps = {
  store: {
    async claimNextSeries4FlyProvisioningJob() { return null; },
    async claimNextSeries4GraceExpiredRunner() { return null; },
    async claimNextAccountDeletionRequest() { return null; },
  },
};

const BAD_VALUES = [
  ['unset', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['tab/newline only', '\t\n '],
];

function perturb(key, label, value) {
  const env = { ...FLY_ENV };
  if (label === 'unset') delete env[key];
  else env[key] = value;
  return env;
}

function reported(res) {
  return [...(res.missingSecrets ?? []), ...(res.missingVariables ?? [])];
}

// --- provisioning job: needs all five ---------------------------------------
const PROVISION_REQUIRED = [
  'FLY_API_TOKEN',
  'FLY_ORG',
  'FLY_PRIMARY_REGION',
  'SIDEKICK_FLY_RUNNER_IMAGE_REF',
  'SIDEKICK_WORKER_PROXY_URL',
];
for (const key of PROVISION_REQUIRED) {
  for (const [label, value] of BAD_VALUES) {
    test(`provision: blocks (no claim) when ${key} is ${label}`, async () => {
      const env = perturb(key, label, value);
      const res = await processNextSeries4FlyProvisioningJob({ env }, blockingDeps);
      assert.equal(res.status, 'blocked', `${key}=${label} must block`);
      assert.ok(reported(res).includes(key), `${key} must be reported missing (got ${JSON.stringify(reported(res))})`);
    });
  }
}
test('provision: valid env passes preflight (reaches claim -> idle)', async () => {
  const res = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, idleDeps);
  assert.equal(res.status, 'idle');
});

// --- grace-expiry: needs token + org + region (region gap closed v2.0.1) -----
const GRACE_REQUIRED = ['FLY_API_TOKEN', 'FLY_ORG', 'FLY_PRIMARY_REGION'];
for (const key of GRACE_REQUIRED) {
  for (const [label, value] of BAD_VALUES) {
    test(`grace-expiry: blocks (no claim) when ${key} is ${label}`, async () => {
      const env = perturb(key, label, value);
      const res = await processNextSeries4GraceExpiry({ env }, blockingDeps);
      assert.equal(res.status, 'blocked', `${key}=${label} must block`);
      assert.ok(reported(res).includes(key), `${key} must be reported missing`);
    });
  }
}
test('grace-expiry: valid env passes preflight (reaches claim -> idle)', async () => {
  const res = await processNextSeries4GraceExpiry({ env: FLY_ENV }, idleDeps);
  assert.equal(res.status, 'idle');
});

// --- account-deletion: needs token + org + region ---------------------------
const DELETION_REQUIRED = ['FLY_API_TOKEN', 'FLY_ORG', 'FLY_PRIMARY_REGION'];
for (const key of DELETION_REQUIRED) {
  for (const [label, value] of BAD_VALUES) {
    test(`account-deletion: blocks (no claim) when ${key} is ${label}`, async () => {
      const env = perturb(key, label, value);
      const res = await processNextAccountDeletionRequest({ env }, blockingDeps);
      assert.equal(res.status, 'blocked', `${key}=${label} must block`);
      assert.ok(reported(res).includes(key), `${key} must be reported missing`);
    });
  }
}
test('account-deletion: valid env passes preflight (reaches claim -> idle)', async () => {
  const res = await processNextAccountDeletionRequest({ env: FLY_ENV }, idleDeps);
  assert.equal(res.status, 'idle');
});

// --- regression guard: FLY_PRIMARY_REGION must NOT be silently defaulted -----
// This is the exact "silent default masks a config error" risk. With region
// removed, teardown jobs must block, not quietly fall back to a region default.
test('regression: teardown jobs do NOT silently default a missing FLY_PRIMARY_REGION', async () => {
  const env = perturb('FLY_PRIMARY_REGION', 'unset');
  const grace = await processNextSeries4GraceExpiry({ env }, blockingDeps);
  const del = await processNextAccountDeletionRequest({ env }, blockingDeps);
  assert.equal(grace.status, 'blocked', 'grace-expiry must block on missing region, not default to lhr');
  assert.equal(del.status, 'blocked', 'account-deletion must block on missing region, not default to lhr');
});

// --- the original incident, end to end: ALL secrets empty => blocked ---------
test('incident reproduction: ALL Fly/Supabase config empty => blocked, never a silent run', async () => {
  const empty = { FLY_API_TOKEN: '', FLY_ORG: '', FLY_PRIMARY_REGION: '', SIDEKICK_FLY_RUNNER_IMAGE_REF: '', SIDEKICK_WORKER_PROXY_URL: '' };
  const res = await processNextSeries4FlyProvisioningJob({ env: empty }, blockingDeps);
  assert.equal(res.status, 'blocked');
  // Every required key must be named so the operator (or the cron-failure
  // alert issue) knows exactly what to set.
  for (const key of PROVISION_REQUIRED) {
    assert.ok(reported(res).includes(key), `${key} must be named in the blocked report`);
  }
});
