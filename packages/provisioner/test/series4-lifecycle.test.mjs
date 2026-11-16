// Series 4 — lifecycle orchestrator unit tests with fake store + fake provider.
// Covers:
//   - processNextSeries4FlyProvisioningJob: blocked / idle / provisioning /
//     failed (pre-API) / reconcile_required (post-API)
//   - processSeries4SubscriptionSuspension: retention default + override,
//     idle when nothing to suspend
//   - processNextSeries4GraceExpiry: idle / deleted / failed
//   - resolveFlyVolumeRetentionSeconds defaulting + env override
//   - imageRefLabel redaction
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  processNextSeries4FlyProvisioningJob,
  processSeries4SubscriptionSuspension,
  processNextSeries4GraceExpiry,
  processNextAccountDeletionRequest,
  processNextCoworkerReimage,
  processNextSeries4RunnerResize,
  processSeries4StorageUsageSweep,
  processSeries4SuspendedRunnerStop,
  resolveFlyVolumeRetentionSeconds,
  imageRefLabel,
} from '../dist/index.js';

const FLY_TOKEN = 'FlyV1 fm2_test_token_value_that_must_not_leak';
const FLY_ENV = {
  FLY_API_TOKEN: FLY_TOKEN,
  FLY_ORG: 'personal',
  FLY_PRIMARY_REGION: 'lhr',
  SIDEKICK_FLY_RUNNER_IMAGE_REF: 'registry.fly.io/delegent-hermes-runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.test',
};
const USER_A = '00000000-0000-4000-8000-000000000a01';
const USER_B = '00000000-0000-4000-8000-000000000b02';

function defaultJob(overrides = {}) {
  return {
    userId: USER_A,
    tierId: 'studio',
    idempotencyKey: 'idemp-A',
    claimedAt: '2026-05-15T20:00:00.000Z',
    agentName: 'Nova',
    ...overrides,
  };
}

function fakeStore(overrides = {}) {
  const calls = {
    record: [], failed: [], reconcile: [], suspend: [], resume: [], deleted: [], claimProv: 0, claimGrace: 0,
    claimAccountDelete: 0, accountDeleteCompleted: [], accountDeleteFailed: [], accountDeletePhases: [],
    claimReimage: 0, reimageOutcome: [], refreshFlags: [],
    claimResize: 0, resizeOutcome: [],
    listStorageTargets: [], storageUsage: [],
    listSuspendTargets: [],
  };
  const store = {
    async claimNextSeries4FlyProvisioningJob() {
      calls.claimProv += 1;
      return overrides.queuedJob ?? null;
    },
    async recordSeries4FlyProvisioningOutput(job, output) {
      calls.record.push({ job, output });
      if (overrides.recordThrows) throw new Error(overrides.recordThrows);
    },
    async markSeries4FlyProvisioningFailed(job, failure) {
      calls.failed.push({ job, failure });
    },
    async markSeries4FlyProvisioningReconciliationRequired(job, failure) {
      calls.reconcile.push({ job, failure });
    },
    async markSeries4RunnerSuspended(userId, retentionSeconds, msg) {
      calls.suspend.push({ userId, retentionSeconds, msg });
      return overrides.suspendReturns ?? true;
    },
    async markSeries4RunnerResumed(userId, msg) {
      calls.resume.push({ userId, msg });
      return overrides.resumeReturns ?? true;
    },
    async claimNextSeries4GraceExpiredRunner() {
      calls.claimGrace += 1;
      return overrides.graceClaim ?? null;
    },
    async authorizeSeries4GraceDeletion() { return overrides.authorizeGrace ?? true; },
    async recordSeries4RunnerDeleted(claim) {
      calls.deleted.push({ userId: claim.userId, claim });
      if (overrides.deletedThrows) throw new Error(overrides.deletedThrows);
    },
    async claimNextAccountDeletionRequest() {
      calls.claimAccountDelete += 1;
      return overrides.accountDeleteClaim ?? null;
    },
    async recordAccountDeletionPhase(requestId, processingToken, phase) {
      calls.accountDeletePhases.push({ requestId, processingToken, phase });
      return true;
    },
    async recordAccountDeletionRequestCompleted(requestId, processingToken, result) {
      calls.accountDeleteCompleted.push({ requestId, processingToken, result });
      if (overrides.accountDeleteCompletedThrows) throw new Error(overrides.accountDeleteCompletedThrows);
      // The database refuses to complete a request whose other phases are not
      // finished. The fake has to be able to say so, or the test cannot tell
      // the two outcomes apart.
      if (overrides.accountDeleteNotReady) return false;
      return true;
    },
    async recordAccountDeletionRequestFailed(requestId, failure) {
      calls.accountDeleteFailed.push({ requestId, failure });
      if (overrides.accountDeleteFailedThrows) throw new Error(overrides.accountDeleteFailedThrows);
    },
    async refreshCoworkerUpdateFlags(latestDigest) {
      calls.refreshFlags.push(latestDigest);
      if (overrides.refreshThrows) throw new Error(overrides.refreshThrows);
      return overrides.refreshReturns ?? 0;
    },
    async claimCoworkerReimageCandidate() {
      calls.claimReimage += 1;
      return overrides.reimageClaim ?? null;
    },
    async recordCoworkerReimageOutcome(userId, ok, imageRef, imageDigest, error) {
      calls.reimageOutcome.push({ userId, ok, imageRef, imageDigest, error });
      if (overrides.reimageOutcomeThrows) throw new Error(overrides.reimageOutcomeThrows);
    },
    async claimRunnerResizeCandidate(leaseSeconds) {
      calls.claimResize += 1;
      if (overrides.resizeClaimThrows) throw new Error(overrides.resizeClaimThrows);
      return overrides.resizeClaim ?? null;
    },
    async recordRunnerResizeOutcome(userId, ok, appliedTier, error) {
      calls.resizeOutcome.push({ userId, ok, appliedTier, error });
      if (overrides.resizeOutcomeThrows) throw new Error(overrides.resizeOutcomeThrows);
    },
    async listStorageUsageTargets(limit, staleSeconds) {
      calls.listStorageTargets.push({ limit, staleSeconds });
      if (overrides.storageTargetsThrows) throw new Error(overrides.storageTargetsThrows);
      return overrides.storageTargets ?? [];
    },
    async recordStorageUsage(userId, consumedBytes) {
      calls.storageUsage.push({ userId, consumedBytes });
      if (overrides.storageUsageThrows) throw new Error(overrides.storageUsageThrows);
    },
    async listSuspendedRunnerStopTargets(limit) {
      calls.listSuspendTargets.push({ limit });
      if (overrides.suspendTargetsThrows) throw new Error(overrides.suspendTargetsThrows);
      return overrides.suspendTargets ?? [];
    },
  };
  // Let tests exercise the "RPCs not yet applied" branch by dropping the methods.
  if (overrides.dropResizeStoreMethods) {
    delete store.claimRunnerResizeCandidate;
    delete store.recordRunnerResizeOutcome;
  }
  if (overrides.dropStorageStoreMethods) {
    delete store.listStorageUsageTargets;
    delete store.recordStorageUsage;
  }
  if (overrides.dropSuspendStoreMethods) {
    delete store.listSuspendedRunnerStopTargets;
  }
  return { store, calls };
}

function fakeProvider(overrides = {}) {
  const calls = { create: [], delete: [], reimage: [], resize: [], storageUsage: [], grow: [], stop: [] };
  const provider = {
    providerId: 'fly_machines',
    preflight: () => ({ providerId: 'fly_machines', ok: true, requiredVariables: [], requiredSecrets: [], missingVariables: [], missingSecrets: [], checks: [] }),
    async createRunner(input) {
      calls.create.push(input);
      if (overrides.createThrows) throw new Error(overrides.createThrows);
      return overrides.createReturns ?? {
        providerId: 'fly_machines',
        userId: input.userId,
        runnerBaseUrl: `https://delegent-runner-${input.userId.slice(-12)}.fly.dev`,
        runnerSharedSecret: input.runnerSharedSecret,
        status: 'ready',
        createdAt: '2026-05-15T20:01:00.000Z',
        lastHealthAt: '2026-05-15T20:01:05.000Z',
        fly: {
          org: 'personal',
          appName: `delegent-runner-${input.userId.slice(-12)}`,
          machineId: `machine_${input.userId.slice(-8)}`,
          volumeId: `vol_${input.userId.slice(-8)}`,
          region: 'lhr',
          imageRef: input.imageRef,
          imageDigest: null,
        },
      };
    },
    async startRunner() { return { ok: true }; },
    async stopRunner(binding) {
      calls.stop.push({ binding });
      if (overrides.stopThrows) throw new Error(overrides.stopThrows);
      if (typeof overrides.stopFor === 'function') return overrides.stopFor(binding);
      return overrides.stopReturns ?? { ok: true };
    },
    async deleteRunner(binding, options) {
      calls.delete.push({ binding, options });
      if (overrides.deleteReturns) return overrides.deleteReturns;
      return { ok: true };
    },
    async getHealth() { return { ok: true, status: 'ready', hermesAvailable: true, workspaceReady: true, hermesVersion: null, lastCheckedAt: new Date().toISOString() }; },
    async reimageRunner(binding, request) {
      calls.reimage.push({ binding, request });
      if (overrides.reimageThrows) throw new Error(overrides.reimageThrows);
      return overrides.reimageReturns ?? {
        ok: true,
        alreadyCurrent: false,
        appliedImageRef: request.targetImageRef,
        appliedImageDigest: request.targetImageRef.includes('@') ? request.targetImageRef.split('@')[1] : null,
        healthy: true,
      };
    },
    async resizeRunner(binding, request) {
      calls.resize.push({ binding, request });
      if (overrides.resizeThrows) throw new Error(overrides.resizeThrows);
      return overrides.resizeReturns ?? {
        ok: true,
        appliedVolumeGb: 100,
        appliedCompute: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
      };
    },
    async getStorageUsage(binding) {
      calls.storageUsage.push({ binding });
      if (overrides.storageUsageThrows) throw new Error(overrides.storageUsageThrows);
      if (typeof overrides.storageUsageFor === 'function') return overrides.storageUsageFor(binding);
      return overrides.storageUsageReturns ?? { ok: true, usedBytes: 257_698_037, capacityBytes: 10_737_418_240, sizeGb: 10 };
    },
    async growStorage(binding, request) {
      calls.grow.push({ binding, request });
      if (overrides.growThrows) throw new Error(overrides.growThrows);
      return overrides.growReturns ?? { ok: true, appliedSizeGb: request.targetSizeGb };
    },
  };
  if (overrides.dropGetStorageUsage) delete provider.getStorageUsage;
  if (overrides.dropGrowStorage) delete provider.growStorage;
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// processNextSeries4FlyProvisioningJob
// ---------------------------------------------------------------------------

test('processNextSeries4FlyProvisioningJob returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processNextSeries4FlyProvisioningJob({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
  assert.ok([...result.missingVariables].includes('FLY_ORG'));
  assert.ok([...result.missingVariables].includes('SIDEKICK_WORKER_PROXY_URL'));
});

test('processNextSeries4FlyProvisioningJob returns idle when no queued job', async () => {
  const { store, calls } = fakeStore();
  const { provider } = fakeProvider();
  const result = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.claimProv, 1);
});

test('processNextSeries4FlyProvisioningJob happy path: claims job, calls createRunner, persists binding', async () => {
  const { store, calls } = fakeStore({ queuedJob: defaultJob() });
  const { provider, calls: providerCalls } = fakeProvider();
  let generatedSecret = '';
  // D8 inline readiness loop fetches `<runnerBaseUrl>/healthz` for up to 120s
  // using real network when fetchImpl/sleep/now aren't overridden. Skip the
  // loop with a `now` shim that jumps past the deadline immediately; the
  // result still resolves to `provisioning` with a readinessNote, which is
  // what this test cares about.
  let nowCounter = Date.parse('2026-05-15T20:00:00.000Z');
  const result = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, {
    store,
    provider,
    generateRunnerSharedSecret: () => { generatedSecret = 'rs_' + 'a'.repeat(45); return generatedSecret; },
    fetchImpl: async () => new Response('', { status: 503 }),
    sleep: async () => {},
    now: () => { nowCounter += 200_000; return nowCounter; },
  });
  assert.equal(result.status, 'provisioning');
  assert.equal(result.userId, USER_A);
  assert.match(result.flyAppName, /^delegent-runner-/);

  // createRunner was called with the right per-user input
  assert.equal(providerCalls.create.length, 1);
  assert.equal(providerCalls.create[0].userId, USER_A);
  assert.equal(providerCalls.create[0].runnerSharedSecret, generatedSecret);
  assert.equal(providerCalls.create[0].agentName, 'Nova');
  assert.equal(providerCalls.create[0].imageRef, FLY_ENV.SIDEKICK_FLY_RUNNER_IMAGE_REF);

  // Persistence happened with the binding shape we expected
  assert.equal(calls.record.length, 1);
  const rec = calls.record[0].output;
  assert.match(rec.flyAppName, /^delegent-runner-/);
  assert.equal(rec.flyRegion, 'lhr');
  assert.equal(rec.runnerSharedSecret, generatedSecret);
  assert.equal(rec.imageRef, FLY_ENV.SIDEKICK_FLY_RUNNER_IMAGE_REF);
  assert.equal(rec.imageRefLabel.startsWith('delegent-hermes-runner'), true);
  assert.equal(rec.imageRefLabel.includes('@'), false); // digest stripped
  assert.equal(rec.imageRefLabel.includes('registry.fly.io'), false); // host stripped
  assert.equal(rec.storageQuotaGb, 10); // studio tier default
});

test('processNextSeries4FlyProvisioningJob: createRunner throws -> failed (not reconcile)', async () => {
  const { store, calls } = fakeStore({ queuedJob: defaultJob() });
  const { provider } = fakeProvider({ createThrows: 'fly_create_runner_missing_image_ref' });
  const result = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'fly_create_runner_missing_image_ref');
  assert.equal(calls.failed.length, 1);
  assert.equal(calls.reconcile.length, 0);
  assert.equal(calls.record.length, 0);
});

test('processNextSeries4FlyProvisioningJob: failed binding persistence schedules a bounded retry', async () => {
  const { store, calls } = fakeStore({ queuedJob: defaultJob(), recordThrows: 'supabase_rpc_unavailable' });
  const { provider } = fakeProvider();
  const result = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'supabase_rpc_unavailable');
  assert.equal(calls.failed.length, 1);
  assert.equal(calls.reconcile.length, 0);
});

test('processNextSeries4FlyProvisioningJob: rejects a provider that returns a non-fly binding', async () => {
  const { store, calls } = fakeStore({ queuedJob: defaultJob() });
  const { provider } = fakeProvider({
    createReturns: {
      providerId: 'railway_legacy',
      userId: USER_A,
      runnerBaseUrl: 'https://impostor.example.com',
      runnerSharedSecret: 'rs_imp',
      status: 'ready',
      createdAt: '2026-05-15T20:01:00.000Z',
      lastHealthAt: null,
      railway: { projectId: 'something' },
    },
  });
  const result = await processNextSeries4FlyProvisioningJob({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'reconcile_required');
  assert.equal(result.errorCode, 'fly_provider_returned_non_fly_binding');
  assert.equal(calls.reconcile.length, 1);
});

// ---------------------------------------------------------------------------
// processSeries4SubscriptionSuspension
// ---------------------------------------------------------------------------

test('processSeries4SubscriptionSuspension uses default 60-day retention when env is absent', async () => {
  // 30 -> 60 on 2026-08-04, Alex's call: a churned user's workspace survives
  // two months, so coming back within that window restores everything.
  const { store, calls } = fakeStore({ suspendReturns: true });
  const result = await processSeries4SubscriptionSuspension({ env: {}, userId: USER_A }, { store });
  assert.equal(result.status, 'suspended');
  assert.equal(result.retentionSeconds, 60 * 24 * 60 * 60);
  assert.equal(calls.suspend.length, 1);
  assert.equal(calls.suspend[0].userId, USER_A);
  assert.equal(calls.suspend[0].retentionSeconds, 60 * 24 * 60 * 60);
});

test('processSeries4SubscriptionSuspension honours SIDEKICK_FLY_VOLUME_RETENTION_DAYS env', async () => {
  const { store, calls } = fakeStore({ suspendReturns: true });
  const result = await processSeries4SubscriptionSuspension(
    { env: { SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '7' }, userId: USER_A },
    { store },
  );
  assert.equal(result.status, 'suspended');
  assert.equal(result.retentionSeconds, 7 * 24 * 60 * 60);
  assert.equal(calls.suspend[0].retentionSeconds, 7 * 24 * 60 * 60);
});

test('processSeries4SubscriptionSuspension respects an explicit retentionDays override', async () => {
  const { store, calls } = fakeStore({ suspendReturns: true });
  await processSeries4SubscriptionSuspension(
    { env: { SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '30' }, userId: USER_A, retentionDays: 1 },
    { store },
  );
  assert.equal(calls.suspend[0].retentionSeconds, 1 * 24 * 60 * 60);
});

test('processSeries4SubscriptionSuspension returns no_runner_to_suspend when no row flipped', async () => {
  const { store } = fakeStore({ suspendReturns: false });
  const result = await processSeries4SubscriptionSuspension({ env: {}, userId: USER_B }, { store });
  assert.equal(result.status, 'no_runner_to_suspend');
});

test('resolveFlyVolumeRetentionSeconds clamps to >0 seconds and falls back to 60 on garbage', () => {
  assert.equal(resolveFlyVolumeRetentionSeconds({}), 60 * 24 * 60 * 60);
  assert.equal(resolveFlyVolumeRetentionSeconds({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '7' }), 7 * 24 * 60 * 60);
  assert.equal(resolveFlyVolumeRetentionSeconds({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: 'banana' }), 60 * 24 * 60 * 60);
  assert.equal(resolveFlyVolumeRetentionSeconds({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '-3' }), 60 * 24 * 60 * 60);
  assert.equal(resolveFlyVolumeRetentionSeconds({}, 14), 14 * 24 * 60 * 60);
});

// ---------------------------------------------------------------------------
// processNextSeries4GraceExpiry
// ---------------------------------------------------------------------------

function expiredClaim() {
  return {
    userId: USER_A,
    claimedAt: '2026-06-15T20:00:00.000Z',
    binding: {
      providerId: 'fly_machines',
      userId: USER_A,
      runnerBaseUrl: 'https://delegent-runner-abc123def456.fly.dev',
      runnerSharedSecret: 'rs_test',
      status: 'deleting',
      createdAt: '2026-05-15T20:00:00.000Z',
      lastHealthAt: null,
      fly: {
        org: 'personal',
        appName: 'delegent-runner-abc123def456',
        machineId: 'machine_abc123de',
        volumeId: 'vol_abc123de',
        region: 'lhr',
        imageRef: 'registry.fly.io/delegent-hermes-runner@sha256:abc',
        imageDigest: null,
      },
    },
  };
}

test('processNextSeries4GraceExpiry returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processNextSeries4GraceExpiry({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
});

test('processNextSeries4GraceExpiry returns idle when nothing is due', async () => {
  const { store, calls } = fakeStore({ graceClaim: null });
  const { provider } = fakeProvider();
  const result = await processNextSeries4GraceExpiry({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.claimGrace, 1);
});

test('grace deletion never reaches Fly after the durable claim is revoked', async () => {
  const { store, calls } = fakeStore({ graceClaim: expiredClaim(), authorizeGrace: false });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processNextSeries4GraceExpiry({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'stale_grace_deletion_claim');
  assert.equal(pcalls.delete.length, 0);
  assert.equal(calls.deleted.length, 0);
});

test('processNextSeries4GraceExpiry happy path: deletes Fly resources + records deleted state', async () => {
  const claim = expiredClaim();
  const { store, calls } = fakeStore({ graceClaim: claim });
  const { provider, calls: providerCalls } = fakeProvider();
  const result = await processNextSeries4GraceExpiry({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'deleted');
  assert.equal(result.userId, USER_A);
  assert.equal(result.flyAppName, claim.binding.fly.appName);
  // deleteRunner was called with force=true
  assert.equal(providerCalls.delete.length, 1);
  assert.equal(providerCalls.delete[0].options.force, true);
  assert.equal(providerCalls.delete[0].binding.fly.appName, claim.binding.fly.appName);
  // recorded deleted
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.deleted[0].userId, USER_A);
});

test('processNextSeries4GraceExpiry: deleteRunner failure does NOT record_deleted', async () => {
  const { store, calls } = fakeStore({ graceClaim: expiredClaim() });
  const { provider } = fakeProvider({ deleteReturns: { ok: false, errorCode: 'fly_app_delete_failed_503' } });
  const result = await processNextSeries4GraceExpiry({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'fly_app_delete_failed_503');
  assert.equal(calls.deleted.length, 0);
});

test('processNextSeries4GraceExpiry: record_deleted failure surfaces as failed', async () => {
  const { store } = fakeStore({ graceClaim: expiredClaim(), deletedThrows: 'supabase_rpc_unavailable' });
  const { provider } = fakeProvider();
  const result = await processNextSeries4GraceExpiry({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'supabase_rpc_unavailable');
});

// ---------------------------------------------------------------------------
// processNextAccountDeletionRequest — durable Article 17 teardown queue
// ---------------------------------------------------------------------------

function accountDeletionClaim(overrides = {}) {
  return {
    id: 'delete_req_abc123',
    userId: USER_A,
    userEmail: 'alex@example.test',
    claimedAt: '2026-05-22T11:00:00.000Z',
    teardownBy: '2026-05-23T10:59:00.000Z',
    // The phases the request arrives with. By default the account itself is
    // already gone and only the workspace is left, which is the ordinary case.
    processingToken: 'token_abc123',
    authDeletedAt: '2026-05-22T10:59:00.000Z',
    connectionsClearedAt: '2026-05-22T10:59:00.000Z',
    infrastructureClearedAt: null,
    pendingCleanup: [],
    ...overrides,
    teardownSnapshot: overrides.teardownSnapshot ?? {
      private_teardown_target: {
        provider: 'fly_machines',
        fly_org: 'personal',
        fly_app_name: 'delegent-user-abc123',
        fly_machine_id: 'machine_abc123',
        fly_volume_id: 'vol_abc123',
        fly_region: 'lhr',
        runner_base_url: 'https://delegent-user-abc123.fly.dev',
      },
    },
  };
}

test('processNextAccountDeletionRequest claims a fresh request immediately and force-deletes the snapshotted Fly workspace', async () => {
  const claim = accountDeletionClaim();
  const { store, calls } = fakeStore({ accountDeleteClaim: claim });
  const { provider, calls: providerCalls } = fakeProvider();
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'completed');
  assert.equal(result.requestId, claim.id);
  assert.equal(result.userId, USER_A);
  assert.equal(result.flyAppName, 'delegent-user-abc123');
  assert.equal(calls.claimAccountDelete, 1);

  assert.equal(providerCalls.delete.length, 1);
  assert.equal(providerCalls.delete[0].options.force, true);
  assert.equal(providerCalls.delete[0].binding.providerId, 'fly_machines');
  assert.equal(providerCalls.delete[0].binding.userId, USER_A);
  assert.equal(providerCalls.delete[0].binding.fly.appName, 'delegent-user-abc123');
  assert.equal(providerCalls.delete[0].binding.fly.machineId, 'machine_abc123');
  assert.equal(providerCalls.delete[0].binding.fly.volumeId, 'vol_abc123');
  assert.equal(providerCalls.delete[0].binding.runnerSharedSecret, '');

  assert.equal(calls.accountDeleteCompleted.length, 1);
  assert.equal(calls.accountDeleteCompleted[0].requestId, claim.id);
  assert.equal(calls.accountDeleteCompleted[0].processingToken, 'token_abc123',
    'completion must carry the claim token, or an expired claimant can finish a newer one');
  assert.deepEqual(calls.accountDeleteCompleted[0].result, {
    provider: 'fly_machines',
    flyAppName: 'delegent-user-abc123',
    flyMachineId: 'machine_abc123',
    flyVolumeId: 'vol_abc123',
  });
  assert.deepEqual(calls.accountDeletePhases, [
    { requestId: claim.id, processingToken: 'token_abc123', phase: 'infrastructure' },
  ], 'the phase is recorded before completion is attempted');
  assert.equal(calls.accountDeleteFailed.length, 0);
});

test('a finished workspace teardown does not report an account erased while the account still exists', async () => {
  // The defect. Fly teardown succeeded, the request was marked completed, and
  // the Supabase auth user was still there because its deletion had 503d.
  const claim = accountDeletionClaim({ authDeletedAt: null });
  const { store, calls } = fakeStore({ accountDeleteClaim: claim, accountDeleteNotReady: true });
  const { provider, calls: providerCalls } = fakeProvider();
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'awaiting');
  assert.deepEqual(result.owed, ['auth'], 'and it names what is still owed');
  assert.equal(providerCalls.delete.length, 1, 'the workspace is still torn down');
  assert.equal(calls.accountDeleteCompleted.length, 1, 'completion was attempted and refused');
  assert.equal(calls.accountDeleteFailed.length, 1, 'so the request goes back to the queue');
  assert.equal(calls.accountDeleteFailed[0].failure.errorCode, 'account_deletion_awaiting_account_erasure');
});

test('a grant still owed at a broker also stops the erasure being called finished', async () => {
  const claim = accountDeletionClaim({
    connectionsClearedAt: null,
    pendingCleanup: [{ broker: 'composio', account_id: 'ca_stuck' }],
  });
  const { store, calls } = fakeStore({ accountDeleteClaim: claim, accountDeleteNotReady: true });
  const { provider } = fakeProvider();
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'awaiting');
  assert.deepEqual(result.owed, ['connections']);
  assert.equal(calls.accountDeleteFailed.length, 1);
});

test('a half-described workspace is not treated as no workspace', async () => {
  // A snapshot with an app and a volume but no machine id used to resolve to
  // no binding at all, and the processor recorded no_fly_teardown_target and
  // reported the account erased. Partial provisioning is a supported failure
  // state, so telling somebody their files are gone on the strength of a
  // missing field is the worst possible answer.
  for (const missing of ['fly_machine_id', 'fly_app_name', 'fly_volume_id']) {
    const target = {
      provider: 'fly_machines', fly_org: 'personal', fly_app_name: 'delegent-user-abc123',
      fly_machine_id: 'machine_abc123', fly_volume_id: 'vol_abc123', fly_region: 'lhr',
    };
    delete target[missing];
    const claim = accountDeletionClaim({ teardownSnapshot: { private_teardown_target: target } });
    const { store, calls } = fakeStore({ accountDeleteClaim: claim });
    const { provider, calls: providerCalls } = fakeProvider();
    const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

    assert.equal(result.status, 'failed', missing);
    assert.equal(result.errorCode, 'account_deletion_partial_teardown_target');
    assert.equal(calls.accountDeleteCompleted.length, 0, 'nothing may be declared erased');
    assert.equal(providerCalls.delete.length, 0, 'and no half-addressed teardown is attempted');
    assert.equal(calls.accountDeleteFailed.length, 1, 'it stays in the queue');
  }
});

test('an account with no workspace at all still completes, once everything else is done', async () => {
  const claim = accountDeletionClaim({ teardownSnapshot: {} });
  const { store, calls } = fakeStore({ accountDeleteClaim: claim });
  const { provider, calls: providerCalls } = fakeProvider();
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'completed');
  assert.equal(result.provider, 'none');
  assert.equal(providerCalls.delete.length, 0);
  assert.deepEqual(calls.accountDeleteCompleted[0].result, { provider: 'none', reason: 'no_fly_teardown_target' });
});

test('a workspace already torn down and marked deleted is not torn down again (QA E3, 2026-09-23)', async () => {
  // Every runner was destroyed and marked deleted when Fly closed, but the
  // records still name the app. Calling Fly for them worked only while Fly
  // answered "app not found".
  const claim = accountDeletionClaim({ teardownSnapshot: { private_teardown_target: {
    provider: 'fly_machines', fly_org: 'personal', fly_app_name: 'delegent-user-abc123',
    fly_machine_id: 'machine_abc123', fly_volume_id: 'vol_abc123', fly_region: 'lhr',
    deleted_at: '2026-09-18T20:00:00.000Z',
  } } });
  const { store, calls } = fakeStore({ accountDeleteClaim: claim });
  const { provider, calls: providerCalls } = fakeProvider();
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls.delete.length, 0, 'Fly is not called for a workspace that is already gone');
  assert.deepEqual(calls.accountDeleteCompleted[0].result, { provider: 'none', reason: 'no_fly_teardown_target' });
});

test('processNextAccountDeletionRequest records a durable failure when provider teardown fails', async () => {
  const claim = accountDeletionClaim();
  const { store, calls } = fakeStore({ accountDeleteClaim: claim });
  const { provider } = fakeProvider({ deleteReturns: { ok: false, errorCode: 'fly_account_delete_failed_503' } });
  const result = await processNextAccountDeletionRequest({ env: FLY_ENV }, { store, provider });

  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, claim.id);
  assert.equal(result.errorCode, 'fly_account_delete_failed_503');
  assert.equal(calls.accountDeleteCompleted.length, 0);
  assert.equal(calls.accountDeleteFailed.length, 1);
  assert.equal(calls.accountDeleteFailed[0].requestId, claim.id);
  assert.equal(calls.accountDeleteFailed[0].failure.errorCode, 'fly_account_delete_failed_503');
});

// ---------------------------------------------------------------------------
// imageRefLabel
// ---------------------------------------------------------------------------

test('imageRefLabel strips registry host + digest', () => {
  assert.equal(
    imageRefLabel('registry.fly.io/delegent-hermes-runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    'delegent-hermes-runner',
  );
  assert.equal(imageRefLabel('delegent-hermes-runner:1.0.0'), 'delegent-hermes-runner:1.0.0');
  assert.equal(imageRefLabel(''), '');
});

// ---------------------------------------------------------------------------
// processNextCoworkerReimage (Feature 3 — agent upgrade path)
// ---------------------------------------------------------------------------

const REIMAGE_CLAIM = {
  userId: USER_A,
  flyAppName: 'delegent-runner-aaaa1111bbbb',
  flyMachineId: 'machine_aaaa1111',
  flyVolumeId: 'vol_aaaa1111',
  flyRegion: 'lhr',
  currentImageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
};

test('processNextCoworkerReimage returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processNextCoworkerReimage({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
  assert.ok([...result.missingVariables].includes('SIDEKICK_FLY_RUNNER_IMAGE_REF'));
});

test('processNextCoworkerReimage returns idle when nothing is pending, but still refreshes the badges', async () => {
  const { store, calls } = fakeStore();
  const { provider } = fakeProvider();
  const result = await processNextCoworkerReimage({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.claimReimage, 1);
  assert.equal(calls.refreshFlags.length, 1);
  assert.match(calls.refreshFlags[0], /^sha256:/, 'refresh receives the digest portion of the latest ref');
});

test('processNextCoworkerReimage happy path: re-images the claimed runner + records success', async () => {
  const { store, calls } = fakeStore({ reimageClaim: REIMAGE_CLAIM });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processNextCoworkerReimage({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'reimaged');
  assert.equal(result.userId, USER_A);
  assert.equal(result.healthy, true);
  assert.equal(pcalls.reimage.length, 1);
  assert.equal(pcalls.reimage[0].request.targetImageRef, FLY_ENV.SIDEKICK_FLY_RUNNER_IMAGE_REF);
  assert.equal(pcalls.reimage[0].binding.fly.appName, REIMAGE_CLAIM.flyAppName);
  assert.equal(pcalls.reimage[0].binding.runnerBaseUrl, `https://${REIMAGE_CLAIM.flyAppName}.fly.dev`);
  assert.equal(calls.reimageOutcome.length, 1);
  assert.equal(calls.reimageOutcome[0].ok, true);
  assert.equal(calls.reimageOutcome[0].imageRef, FLY_ENV.SIDEKICK_FLY_RUNNER_IMAGE_REF);
});

test('processNextCoworkerReimage records a durable failure when the provider reimage fails', async () => {
  const { store, calls } = fakeStore({ reimageClaim: REIMAGE_CLAIM });
  const { provider } = fakeProvider({ reimageReturns: { ok: false, reason: 'fly_machine_reimage_failed_422' } });
  const result = await processNextCoworkerReimage({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.match(result.errorCode, /fly_machine_reimage_failed_422/);
  assert.equal(calls.reimageOutcome.length, 1);
  assert.equal(calls.reimageOutcome[0].ok, false);
});

test('processNextCoworkerReimage fails closed when the provider cannot re-image', async () => {
  const { store, calls } = fakeStore({ reimageClaim: REIMAGE_CLAIM });
  const { provider } = fakeProvider();
  delete provider.reimageRunner;
  const result = await processNextCoworkerReimage({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'reimage_unsupported');
  assert.equal(calls.reimageOutcome[0].error, 'reimage_unsupported');
});

// ---------------------------------------------------------------------------
// processNextSeries4RunnerResize (auto right-size after a tier change)
// ---------------------------------------------------------------------------

const RESIZE_CLAIM = {
  userId: USER_A,
  flyAppName: 'delegent-runner-aaaa1111bbbb',
  flyMachineId: 'machine_aaaa1111',
  flyVolumeId: 'vol_aaaa1111',
  flyRegion: 'lhr',
  currentSizedTier: 'studio',
  targetTier: 'enterprise-suite',
};

test('processNextSeries4RunnerResize returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processNextSeries4RunnerResize({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
  assert.ok([...result.missingVariables].includes('FLY_ORG'));
});

test('processNextSeries4RunnerResize returns idle when no runner has drifted', async () => {
  const { store, calls } = fakeStore();
  const { provider } = fakeProvider();
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.claimResize, 1);
});

test('processNextSeries4RunnerResize is idle (never throws) before the RPCs are applied', async () => {
  const { store, calls } = fakeStore({ dropResizeStoreMethods: true });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.claimResize, 0, 'no claim attempted when the store lacks the method');
  assert.equal(pcalls.resize.length, 0);
});

test('processNextSeries4RunnerResize happy path: resizes the drifted runner to its entitlement + records success', async () => {
  const { store, calls } = fakeStore({ resizeClaim: RESIZE_CLAIM });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'resized');
  assert.equal(result.userId, USER_A);
  assert.equal(result.targetTier, 'enterprise-suite');
  assert.equal(pcalls.resize.length, 1);
  assert.equal(pcalls.resize[0].request.targetTierId, 'enterprise-suite', 'resize targets the entitlement tier, not the drifted one');
  assert.equal(pcalls.resize[0].binding.fly.appName, RESIZE_CLAIM.flyAppName);
  assert.equal(pcalls.resize[0].binding.fly.volumeId, RESIZE_CLAIM.flyVolumeId);
  assert.equal(pcalls.resize[0].binding.runnerSharedSecret, '', 'the HMAC secret is never loaded for a resize');
  assert.equal(calls.resizeOutcome.length, 1);
  assert.equal(calls.resizeOutcome[0].ok, true);
  assert.equal(calls.resizeOutcome[0].appliedTier, 'enterprise-suite');
});

test('processNextSeries4RunnerResize surfaces a deferred volume shrink on downgrade', async () => {
  const downgradeClaim = { ...RESIZE_CLAIM, currentSizedTier: 'enterprise-suite', targetTier: 'studio' };
  const { store, calls } = fakeStore({ resizeClaim: downgradeClaim });
  const { provider } = fakeProvider({
    resizeReturns: { ok: true, appliedVolumeGb: 100, appliedCompute: { cpuKind: 'shared', cpus: 2, memoryMb: 2048 }, deferred: 'shrink_on_renewal' },
  });
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'resized');
  assert.equal(result.deferred, 'shrink_on_renewal');
  // The tier is still stamped as sized so the row stops being re-claimed even
  // though the disk stays large until a renewal-window recreate.
  assert.equal(calls.resizeOutcome[0].ok, true);
  assert.equal(calls.resizeOutcome[0].appliedTier, 'studio');
});

test('processNextSeries4RunnerResize records a durable failure when the provider resize fails', async () => {
  const { store, calls } = fakeStore({ resizeClaim: RESIZE_CLAIM });
  const { provider } = fakeProvider({ resizeReturns: { ok: false, reason: 'fly_machine_resize_failed_422' } });
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.match(result.errorCode, /fly_machine_resize_failed_422/);
  assert.equal(calls.resizeOutcome.length, 1);
  assert.equal(calls.resizeOutcome[0].ok, false);
});

test('processNextSeries4RunnerResize fails closed when the provider cannot resize', async () => {
  const { store, calls } = fakeStore({ resizeClaim: RESIZE_CLAIM });
  const { provider } = fakeProvider();
  delete provider.resizeRunner;
  const result = await processNextSeries4RunnerResize({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'resize_unsupported');
  assert.equal(calls.resizeOutcome[0].error, 'resize_unsupported');
});

// ---------------------------------------------------------------------------
// processSeries4StorageUsageSweep (measure consumed_storage_bytes)
// ---------------------------------------------------------------------------

const GB = 1024 * 1024 * 1024;
// Both sit at their 10 GB entitlement, so the measure-only tests never grow.
const STORAGE_TARGETS = [
  { userId: USER_A, flyAppName: 'delegent-runner-aaaa1111', flyVolumeId: 'vol_aaaa1111', storageQuotaBytes: 10 * GB },
  { userId: USER_B, flyAppName: 'delegent-runner-bbbb2222', flyVolumeId: 'vol_bbbb2222', storageQuotaBytes: 10 * GB },
];
// One headroom-having target: a 10 GB volume against a 40 GB (pro-office) entitlement.
const GROWABLE_TARGET = {
  userId: USER_A,
  flyAppName: 'delegent-runner-aaaa1111',
  flyVolumeId: 'vol_aaaa1111',
  storageQuotaBytes: 40 * GB,
};
const NEARLY_FULL = { ok: true, usedBytes: Math.round(8.5 * GB), capacityBytes: 10 * GB, sizeGb: 10 };

test('processSeries4StorageUsageSweep returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processSeries4StorageUsageSweep({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
  assert.ok([...result.missingVariables].includes('FLY_ORG'));
});

test('processSeries4StorageUsageSweep is idle when nothing is stale', async () => {
  const { store, calls } = fakeStore({ storageTargets: [] });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.listStorageTargets.length, 1);
  assert.equal(pcalls.storageUsage.length, 0);
});

test('processSeries4StorageUsageSweep is idle (never throws) before the RPCs are applied', async () => {
  const { store } = fakeStore({ dropStorageStoreMethods: true });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(pcalls.storageUsage.length, 0);
});

test('processSeries4StorageUsageSweep measures every stale runner and records the reading', async () => {
  const { store, calls } = fakeStore({ storageTargets: STORAGE_TARGETS });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.equal(result.measured, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(pcalls.storageUsage.length, 2);
  assert.equal(pcalls.storageUsage[0].binding.fly.volumeId, 'vol_aaaa1111');
  assert.equal(pcalls.storageUsage[0].binding.runnerSharedSecret, '', 'the HMAC secret is never loaded for a measurement');
  assert.deepEqual(calls.storageUsage.map((c) => c.userId), [USER_A, USER_B]);
  assert.equal(calls.storageUsage[0].consumedBytes, 257_698_037);
});

test('processSeries4StorageUsageSweep skips a volume with no block accounting yet', async () => {
  const { store, calls } = fakeStore({ storageTargets: STORAGE_TARGETS });
  const { provider } = fakeProvider({
    storageUsageFor: (binding) => (binding.fly.volumeId === 'vol_aaaa1111'
      ? { ok: false, reason: 'fly_volume_usage_unavailable' }
      : { ok: true, usedBytes: 1024, capacityBytes: 10_737_418_240 }),
  });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.equal(result.measured, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.length, 0, 'a never-mounted volume is not a fault');
  assert.deepEqual(calls.storageUsage.map((c) => c.userId), [USER_B]);
});

test('processSeries4StorageUsageSweep keeps going when one runner fails to read', async () => {
  const { store, calls } = fakeStore({ storageTargets: STORAGE_TARGETS });
  const { provider } = fakeProvider({
    storageUsageFor: (binding) => (binding.fly.volumeId === 'vol_aaaa1111'
      ? { ok: false, reason: 'fly_volume_usage_failed_404' }
      : { ok: true, usedBytes: 4096, capacityBytes: 10_737_418_240 }),
  });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.equal(result.measured, 1, 'the healthy runner is still measured');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].userId, USER_A);
  assert.match(result.failures[0].errorCode, /fly_volume_usage_failed_404/);
  assert.deepEqual(calls.storageUsage.map((c) => c.userId), [USER_B]);
});

test('processSeries4StorageUsageSweep does not grow a volume that is not full enough', async () => {
  const { store } = fakeStore({ storageTargets: [GROWABLE_TARGET] });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.measured, 1);
  assert.equal(pcalls.grow.length, 0, '2.4% full must not trigger a grow');
  assert.equal(result.grown.length, 0);
});

test('processSeries4StorageUsageSweep doubles a volume that crosses 75% full', async () => {
  const { store } = fakeStore({ storageTargets: [GROWABLE_TARGET] });
  const { provider, calls: pcalls } = fakeProvider({ storageUsageFor: () => NEARLY_FULL });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.measured, 1, 'the reading is still recorded before growing');
  assert.equal(pcalls.grow.length, 1);
  assert.equal(pcalls.grow[0].request.targetSizeGb, 20);
  assert.deepEqual([...result.grown], [{ userId: USER_A, fromGb: 10, toGb: 20 }]);
});

test('processSeries4StorageUsageSweep never grows past the user entitlement', async () => {
  const { store } = fakeStore({
    storageTargets: [{ ...GROWABLE_TARGET, storageQuotaBytes: 15 * GB }],
  });
  const { provider, calls: pcalls } = fakeProvider({ storageUsageFor: () => NEARLY_FULL });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(pcalls.grow[0].request.targetSizeGb, 15, 'doubling is clamped to the cap');
  assert.deepEqual([...result.grown], [{ userId: USER_A, fromGb: 10, toGb: 15 }]);
});

test('processSeries4StorageUsageSweep refuses to grow a user with no proven entitlement', async () => {
  const { store } = fakeStore({
    storageTargets: [{ ...GROWABLE_TARGET, storageQuotaBytes: null }],
  });
  const { provider, calls: pcalls } = fakeProvider({ storageUsageFor: () => NEARLY_FULL });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.measured, 1, 'measuring is still safe without an entitlement');
  assert.equal(pcalls.grow.length, 0);
});

test('processSeries4StorageUsageSweep still measures when the provider cannot grow', async () => {
  const { store, calls } = fakeStore({ storageTargets: [GROWABLE_TARGET] });
  const { provider } = fakeProvider({ storageUsageFor: () => NEARLY_FULL, dropGrowStorage: true });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.measured, 1);
  assert.equal(result.grown.length, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(calls.storageUsage[0].consumedBytes, NEARLY_FULL.usedBytes);
});

test('processSeries4StorageUsageSweep reports a failed grow without losing the reading', async () => {
  const { store, calls } = fakeStore({ storageTargets: [GROWABLE_TARGET] });
  const { provider } = fakeProvider({
    storageUsageFor: () => NEARLY_FULL,
    growReturns: { ok: false, reason: 'fly_volume_grow_failed_422' },
  });
  const result = await processSeries4StorageUsageSweep({ env: FLY_ENV }, { store, provider });
  assert.equal(result.measured, 1);
  assert.equal(calls.storageUsage.length, 1, 'the measurement is persisted even though the grow failed');
  assert.equal(result.grown.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].errorCode, /fly_volume_grow_failed_422/);
});

// ---------------------------------------------------------------------------
// processSeries4SuspendedRunnerStop
// ---------------------------------------------------------------------------

const SUSPEND_TARGET_A = {
  userId: USER_A,
  flyAppName: 'delegent-runner-aaaaaaaaaaaa',
  flyMachineId: 'machine_aaaaaaaa',
  flyVolumeId: 'vol_aaaaaaaa',
  flyRegion: 'lhr',
};
const SUSPEND_TARGET_B = {
  userId: USER_B,
  flyAppName: 'delegent-runner-bbbbbbbbbbbb',
  flyMachineId: 'machine_bbbbbbbb',
  flyVolumeId: 'vol_bbbbbbbb',
  flyRegion: 'lhr',
};

test('processSeries4SuspendedRunnerStop returns blocked when env is missing', async () => {
  const { store } = fakeStore();
  const result = await processSeries4SuspendedRunnerStop({ env: {} }, { store });
  assert.equal(result.status, 'blocked');
  assert.ok([...result.missingSecrets].includes('FLY_API_TOKEN'));
  assert.ok([...result.missingVariables].includes('FLY_ORG'));
});

test('processSeries4SuspendedRunnerStop is idle when the store cannot list targets', async () => {
  const { store, calls } = fakeStore({ dropSuspendStoreMethods: true });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.listSuspendTargets.length, 0);
  assert.equal(pcalls.stop.length, 0);
});

test('processSeries4SuspendedRunnerStop fails when the listing throws', async () => {
  const { store } = fakeStore({ suspendTargetsThrows: 'relation missing' });
  const { provider, calls: pcalls } = fakeProvider();
  await assert.rejects(processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider }), /relation missing/);
  assert.equal(pcalls.stop.length, 0);
});

test('processSeries4SuspendedRunnerStop is idle when nothing is suspended', async () => {
  const { store, calls } = fakeStore({ suspendTargets: [] });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'idle');
  assert.equal(calls.listSuspendTargets.length, 1);
  assert.equal(pcalls.stop.length, 0);
});

test('processSeries4SuspendedRunnerStop stops every suspended machine', async () => {
  const { store } = fakeStore({ suspendTargets: [SUSPEND_TARGET_A, SUSPEND_TARGET_B] });
  const { provider, calls: pcalls } = fakeProvider();
  const result = await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.deepEqual([...result.stopped], [USER_A, USER_B]);
  assert.equal(result.failures.length, 0);
  assert.equal(pcalls.stop.length, 2);
  assert.equal(pcalls.stop[0].binding.fly.appName, SUSPEND_TARGET_A.flyAppName);
  assert.equal(pcalls.stop[0].binding.fly.machineId, SUSPEND_TARGET_A.flyMachineId);
  assert.equal(pcalls.stop[1].binding.fly.machineId, SUSPEND_TARGET_B.flyMachineId);
});

test('processSeries4SuspendedRunnerStop never loads the runner shared secret', async () => {
  const { store } = fakeStore({ suspendTargets: [SUSPEND_TARGET_A] });
  const { provider, calls: pcalls } = fakeProvider();
  await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(pcalls.stop[0].binding.runnerSharedSecret, '', 'stopping a machine must not need the HMAC secret');
});

test('processSeries4SuspendedRunnerStop leaves the volume alone', async () => {
  const { store, calls } = fakeStore({ suspendTargets: [SUSPEND_TARGET_A] });
  const { provider, calls: pcalls } = fakeProvider();
  await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(pcalls.delete.length, 0, 'the grace window owns deletion, not this sweep');
  assert.equal(calls.deleted.length, 0);
});

test('processSeries4SuspendedRunnerStop keeps going when one stop fails', async () => {
  const { store } = fakeStore({ suspendTargets: [SUSPEND_TARGET_A, SUSPEND_TARGET_B] });
  const { provider, calls: pcalls } = fakeProvider({
    stopFor: (binding) => (binding.userId === USER_A
      ? { ok: false, errorCode: 'fly_machine_stop_failed_502' }
      : { ok: true }),
  });
  const result = await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.deepEqual([...result.stopped], [USER_B], 'the healthy machine is still stopped');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].userId, USER_A);
  assert.match(result.failures[0].errorCode, /fly_machine_stop_failed_502/);
  assert.equal(pcalls.stop.length, 2);
});

test('processSeries4SuspendedRunnerStop records a thrown stop as a failure without leaking the token', async () => {
  const { store } = fakeStore({ suspendTargets: [SUSPEND_TARGET_A] });
  const { provider } = fakeProvider({ stopThrows: `fly api rejected ${FLY_TOKEN}` });
  const result = await processSeries4SuspendedRunnerStop({ env: FLY_ENV }, { store, provider });
  assert.equal(result.status, 'swept');
  assert.equal(result.stopped.length, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(!result.failures[0].errorCode.includes(FLY_TOKEN), 'the Fly token must never reach an error code');
});
