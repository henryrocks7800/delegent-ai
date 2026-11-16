import { DELEGENT_WORKSPACE_RETENTION_DAYS } from '@sidekick/shared';
// Series 4 — Fly Machines provisioning + Option A cancellation lifecycle.
//
// Three orchestrator functions wrap the new RPCs from migration 0021 and
// the FlyMachinesProvider from ./providers/flyMachines:
//
//   processNextSeries4FlyProvisioningJob
//     Claims a queued provisioning job, generates a per-user runner secret,
//     calls FlyMachinesProvider.createRunner, persists the binding via
//     record_hermes_fly_provisioning_output.
//
//   processNextSeries4GraceExpiry
//     Claims one sleeping row whose volume_retention_until has passed,
//     force-deletes the Machine + volume + app, and records the terminal
//     deleted state. Intended to be run by a daily script.
//
//   processSeries4SubscriptionSuspension
//     Stripe-webhook entry point. Sets hermes_instances.status='sleeping'
//     for a user whose subscription went inactive, and stamps the
//     volume_retention_until grace window. Pure DB intent — the Machine is
//     stopped by processSeries4SuspendedRunnerStop on the cron's cadence.
//
//   processSeries4SuspendedRunnerStop
//     The reconciler for the above. Sweeps sleeping rows and calls
//     FlyMachinesProvider.stopRunner on each, so a cancelled subscription
//     stops costing compute. The volume is left alone; the grace-expiry
//     job owns deletion.
//
// The suspension write and the Fly stop are split because the Stripe webhook
// is a hot path that must not block on Fly API latency, and the source of
// truth lives in Supabase either way.
//
// Live Fly API calls only happen inside FlyMachinesProvider, so the
// orchestrators are trivially fakeable for tests.
import { randomBytes } from 'node:crypto';

import {
  createFlyMachinesProvider,
  FLY_PRIMARY_REGION_DEFAULT,
  FLY_RUNNER_APP_PREFIX_DEFAULT,
  FLY_WORKSPACE_MOUNT_PATH,
} from './providers/flyMachines.js';
import type {
  CreateRunnerInput,
  FlyMachinesRunnerBinding,
  ReimageRunnerResult,
  RunnerProvider,
  RunnerProviderActionResult,
} from './providers/runnerProvider.js';
import { nextVolumeSizeGb, storageEntitlementGb } from './providers/runnerProvider.js';

// ---------------------------------------------------------------------------
// Store contract — what Series 4 needs from Supabase
// ---------------------------------------------------------------------------
// Implemented for the live system by createSeries4SupabaseStore (below) +
// existing createSupabaseHermesProvisioningStore (which already provides the
// claim/mark methods we share with the Railway path).

export interface Series4FlyProvisioningOutput {
  flyOrg: string;
  flyAppName: string;
  flyMachineId: string;
  flyVolumeId: string;
  flyRegion: string;
  runnerBaseUrl: string;
  runnerSharedSecret: string;
  imageRef: string;
  imageDigest: string | null;
  imageRefLabel: string;
  regionLabel: string;
  storageQuotaGb: number;
}

export interface Series4ClaimedFlyProvisioningJob {
  userId: string;
  tierId: import('@sidekick/shared').PlanTierId;
  idempotencyKey: string;
  claimedAt: string;
  agentName?: string;
}

export interface Series4StuckReadinessClaim {
  job: Series4ClaimedFlyProvisioningJob;
  runnerBaseUrl: string;
}

export interface Series4GraceExpiredRunner {
  userId: string;
  claimedAt: string;
  binding: FlyMachinesRunnerBinding;
}

export interface AccountDeletionRequestClaim {
  id: string;
  userId: string;
  userEmail?: string;
  claimedAt: string;
  teardownBy: string;
  teardownSnapshot: Record<string, unknown>;
  /**
   * Minted by the claim and required by every terminal write. An expired
   * claimant holds a token that no longer matches, which is what stops it
   * completing a row a newer claimant is in the middle of.
   */
  processingToken: string;
  /** Phases somebody else already finished. Null means still owed. */
  authDeletedAt: string | null;
  connectionsClearedAt: string | null;
  infrastructureClearedAt: string | null;
  /** Grants still owed at a broker, by id. Never credentials. */
  pendingCleanup: readonly Record<string, unknown>[];
}

export type AccountDeletionPhase = 'connections' | 'auth' | 'infrastructure';

export type AccountDeletionCompletion =
  | { provider: 'fly_machines'; flyAppName: string; flyMachineId: string; flyVolumeId: string }
  | { provider: 'none'; reason: 'no_fly_teardown_target' };

export interface AccountDeletionFailure {
  errorCode: string;
  publicStatusMessage: string;
}

export interface Series4LifecycleStore {
  /** Claim one queued provisioning row that wants the Fly provider. */
  claimNextSeries4FlyProvisioningJob(): Promise<Series4ClaimedFlyProvisioningJob | null>;
  /** Persist a successful FlyMachinesProvider.createRunner output. */
  recordSeries4FlyProvisioningOutput(
    job: Series4ClaimedFlyProvisioningJob,
    output: Series4FlyProvisioningOutput,
  ): Promise<void>;
  /** Same surface as the Railway path's failure marker; provider-agnostic. */
  markSeries4FlyProvisioningFailed(
    job: Series4ClaimedFlyProvisioningJob,
    failure: { errorCode: string; publicStatusMessage: string },
  ): Promise<void>;
  /** Same surface as the Railway path's reconcile marker. */
  markSeries4FlyProvisioningReconciliationRequired(
    job: Series4ClaimedFlyProvisioningJob,
    failure: { errorCode: string; publicStatusMessage: string },
  ): Promise<void>;
  /**
   * Promote a freshly-provisioned runner to status='ready'. Called from
   * processNextSeries4FlyProvisioningJob once /healthz returns 200 ok so
   * a single provisioner pass takes the user from queued all the way to
   * ready — no separate readiness-once cron required. D8 fix.
   */
  markSeries4FlyRunnerReady(
    job: Series4ClaimedFlyProvisioningJob,
    runnerBaseUrl: string,
  ): Promise<void>;
  /**
   * 2026-06-03 review P0 #4 — claim one runner stuck in status='provisioning'
   * with a recorded Fly binding (its mark-ready failed) so the stuck-readiness
   * pass can re-poll /healthz and promote it in place. Optional: stores/tests
   * that don't implement it simply never reclaim (the pass returns idle).
   */
  claimNextSeries4StuckReadiness?(): Promise<Series4StuckReadinessClaim | null>;
  /** Suspend a user's runner per Option A. Returns true iff the row was flipped. */
  markSeries4RunnerSuspended(
    userId: string,
    retentionSeconds: number,
    publicStatusMessage: string,
  ): Promise<boolean>;
  /** Resume a previously-suspended runner. Returns true iff a sleeping row existed. */
  markSeries4RunnerResumed(
    userId: string,
    publicStatusMessage: string,
  ): Promise<boolean>;
  /**
   * Claim one sleeping runner whose grace window has expired AND return
   * enough binding data to force-delete it. Returns null if nothing is due.
   */
  claimNextSeries4GraceExpiredRunner(): Promise<Series4GraceExpiredRunner | null>;
  /** Final state after force teardown succeeded. */
  recordSeries4RunnerDeleted(claim: Series4GraceExpiredRunner): Promise<void>;
  /** Check the owned claim and entitlement before every destructive request. */
  authorizeSeries4GraceDeletion(claim: Series4GraceExpiredRunner): Promise<boolean>;
  /** Claim one durable GDPR account-deletion request. */
  claimNextAccountDeletionRequest(): Promise<AccountDeletionRequestClaim | null>;
  /** One step finished, by the claimant that finished it. */
  recordAccountDeletionPhase(requestId: string, processingToken: string, phase: AccountDeletionPhase): Promise<boolean>;
  /** Mark a durable account-deletion request completed after teardown. */
  recordAccountDeletionRequestCompleted(requestId: string, processingToken: string, result: AccountDeletionCompletion): Promise<boolean>;
  /** Mark a durable account-deletion request failed so it can be retried/escalated. */
  recordAccountDeletionRequestFailed(requestId: string, failure: AccountDeletionFailure): Promise<void>;
  /**
   * Refresh the public coworker_update_available flags from the latest pinned
   * image digest. Returns the number of rows whose flag changed.
   */
  refreshCoworkerUpdateFlags(latestDigest: string): Promise<number>;
  /**
   * Claim one user-requested reimage candidate (lease-protected) and return the
   * fly identifiers needed to re-image it. Null if nothing is pending.
   */
  claimCoworkerReimageCandidate(
    latestImageRef: string,
    leaseSeconds: number,
  ): Promise<CoworkerReimageClaim | null>;
  /** Record the outcome of a reimage (swaps the private image ref/digest on success). */
  recordCoworkerReimageOutcome(
    userId: string,
    ok: boolean,
    imageRef: string | null,
    imageDigest: string | null,
    error: string | null,
  ): Promise<void>;
  /**
   * Claim one runner whose machine size has drifted from its entitlement tier
   * (lease-protected). Returns the fly identifiers + the target tier to resize
   * to. Null if no runner needs resizing. Optional: stores/tests that don't
   * implement it simply never yield a candidate (the pass returns idle).
   */
  claimRunnerResizeCandidate?(leaseSeconds: number): Promise<RunnerResizeClaim | null>;
  /** Record a resize outcome (stamps the applied tier as sized on success). */
  recordRunnerResizeOutcome?(
    userId: string,
    ok: boolean,
    appliedTier: string | null,
    error: string | null,
  ): Promise<void>;
  /**
   * List live Fly-backed runners whose storage reading is older than
   * `staleSeconds`. Optional: stores that don't implement it yield no targets
   * (the sweep returns idle).
   */
  listStorageUsageTargets?(limit: number, staleSeconds: number): Promise<readonly StorageUsageTarget[]>;
  /** Persist one storage measurement onto usage_quotas. */
  recordStorageUsage?(userId: string, consumedBytes: number): Promise<void>;
  /**
   * List Fly-backed runners sitting in the suspended ('sleeping') state, so
   * their Machine can be stopped. Optional: stores that don't implement it
   * yield no targets (the sweep returns idle).
   */
  listSuspendedRunnerStopTargets?(limit: number): Promise<readonly SuspendedRunnerStopTarget[]>;
}

export interface SuspendedRunnerStopTarget {
  userId: string;
  flyAppName: string;
  flyMachineId: string;
  flyVolumeId: string;
  flyRegion: string;
}

export interface StorageUsageTarget {
  userId: string;
  flyAppName: string;
  flyVolumeId: string;
  /** The user's storage entitlement, and the ceiling auto-grow may grow to. Null when unproven. */
  storageQuotaBytes: number | null;
}

export interface CoworkerReimageClaim {
  userId: string;
  flyAppName: string;
  flyMachineId: string;
  flyVolumeId: string;
  flyRegion: string;
  currentImageDigest: string | null;
}

export interface RunnerResizeClaim {
  userId: string;
  flyAppName: string;
  flyMachineId: string;
  flyVolumeId: string;
  flyRegion: string;
  /** The tier the machine is currently sized for (drifted from entitlement). */
  currentSizedTier: import('@sidekick/shared').PlanTierId;
  /** The entitlement tier the machine should be resized to. */
  targetTier: import('@sidekick/shared').PlanTierId;
}

// ---------------------------------------------------------------------------
// processNextSeries4FlyProvisioningJob
// ---------------------------------------------------------------------------

export interface ProcessSeries4FlyProvisioningInput {
  env: Record<string, string | undefined>;
}

export interface ProcessSeries4FlyProvisioningDeps {
  store: Series4LifecycleStore;
  /** Optional Fly provider override; defaults to one built from env. */
  provider?: RunnerProvider;
  /** Optional shared-secret factory; defaults to 32 random bytes hex. */
  generateRunnerSharedSecret?: () => string;
  /** Optional idempotency-key augmenter for tests. */
  now?: () => Date | number;
  /** D8 — fetch override for inline readiness polling. */
  fetchImpl?: typeof fetch;
  /** D8 — sleep override for inline readiness polling. */
  sleep?: (ms: number) => Promise<void>;
}

export type ProcessSeries4FlyProvisioningResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | { status: 'provisioning'; userId: string; flyAppName: string; flyMachineId: string; flyVolumeId: string; readinessNote?: string }
  | { status: 'ready'; userId: string; flyAppName: string; flyMachineId: string; flyVolumeId: string; runnerBaseUrl: string }
  | { status: 'failed'; userId: string; errorCode: string }
  | { status: 'reconcile_required'; userId: string; errorCode: string };

/**
 * Convert any thrown error into a stable snake_case code (≤64 chars) that's
 * safe to surface in product state without leaking provider internals.
 */
export function sanitizeSeries4ErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return sanitized || 'series4_fly_provisioning_failed';
}

export async function processNextSeries4FlyProvisioningJob(
  input: ProcessSeries4FlyProvisioningInput,
  deps: ProcessSeries4FlyProvisioningDeps,
): Promise<ProcessSeries4FlyProvisioningResult> {
  // Preflight — every Phase 0 secret/var that the FlyMachinesProvider needs.
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  const flyImageRef = (input.env.SIDEKICK_FLY_RUNNER_IMAGE_REF ?? '').trim();
  const workerProxyUrl = (input.env.SIDEKICK_WORKER_PROXY_URL ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (!flyImageRef) missingVariables.push('SIDEKICK_FLY_RUNNER_IMAGE_REF');
  if (!workerProxyUrl) missingVariables.push('SIDEKICK_WORKER_PROXY_URL');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  const job = await deps.store.claimNextSeries4FlyProvisioningJob();
  if (!job) return { status: 'idle' };

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: flyRegion,
    appPrefix: (input.env.FLY_RUNNER_APP_PREFIX ?? '').trim() || FLY_RUNNER_APP_PREFIX_DEFAULT,
    defaultImageRef: flyImageRef,
  });

  const generateSecret = deps.generateRunnerSharedSecret ?? (() => randomBytes(32).toString('hex'));
  const runnerSharedSecret = generateSecret();
  const tierId = job.tierId;
  const createInput: CreateRunnerInput = {
    userId: job.userId,
    tierId,
    agentName: job.agentName ?? null,
    workerProxyUrl,
    runnerSharedSecret,
    imageRef: flyImageRef,
    idempotencyKey: job.idempotencyKey,
  };
  // The user's entitlement, NOT the size the volume is created at: the volume
  // starts small and auto-grows toward this number.
  const storageQuotaGb = storageEntitlementGb(tierId);

  let binding: FlyMachinesRunnerBinding;
  let createReached = false;
  try {
    const created = await provider.createRunner(createInput);
    createReached = true;
    if (created.providerId !== 'fly_machines') {
      // The Fly provider returned a non-Fly binding — strictly impossible
      // unless the runtime got mis-wired. Refuse rather than persist nonsense.
      throw new Error('fly_provider_returned_non_fly_binding');
    }
    binding = created;
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    const failure = {
      errorCode,
      publicStatusMessage: createReached
        ? 'Delegent AI setup needs a manual Fly check before continuing.'
        : 'Delegent AI setup paused because the workspace could not be prepared. We will check it before continuing.',
    };
    if (createReached || errorCode.includes('resource_reconciliation_required')) {
      await safeMark(() => deps.store.markSeries4FlyProvisioningReconciliationRequired(job, failure));
      return { status: 'reconcile_required', userId: job.userId, errorCode };
    }
    await safeMark(() => deps.store.markSeries4FlyProvisioningFailed(job, failure));
    return { status: 'failed', userId: job.userId, errorCode };
  }

  try {
    await deps.store.recordSeries4FlyProvisioningOutput(job, {
      flyOrg: binding.fly.org,
      flyAppName: binding.fly.appName,
      flyMachineId: binding.fly.machineId,
      flyVolumeId: binding.fly.volumeId,
      flyRegion: binding.fly.region,
      runnerBaseUrl: binding.runnerBaseUrl,
      runnerSharedSecret: binding.runnerSharedSecret,
      imageRef: binding.fly.imageRef,
      imageDigest: binding.fly.imageDigest ?? null,
      // Public-safe labels — never the full registry digest or app name.
      imageRefLabel: imageRefLabel(binding.fly.imageRef),
      regionLabel: binding.fly.region.slice(0, 32),
      storageQuotaGb,
    });
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    await safeMark(() => deps.store.markSeries4FlyProvisioningFailed(job, {
      errorCode,
      publicStatusMessage: 'Workspace setup will retry shortly.',
    }));
    return { status: 'failed', userId: job.userId, errorCode };
  }

  // D8 — poll the freshly-provisioned runner's /healthz endpoint with
  // backoff and promote hermes_instances to 'ready' the moment it
  // responds. Before this fix, /healthz could be passing for minutes
  // (sometimes forever) while the public row stayed in 'provisioning'
  // because the separate readiness-once cron was missing from the
  // operator's schedule. Inline-readiness here means one provisioner
  // pass takes the user from queued → ready end-to-end.
  const readiness = await pollRunnerReadiness(
    binding.runnerBaseUrl,
    job.userId,
    binding.runnerSharedSecret,
    deps.fetchImpl ?? globalThis.fetch,
    () => {
      const v = deps.now ? deps.now() : Date.now();
      return v instanceof Date ? v.getTime() : v;
    },
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );

  if (readiness === 'ready') {
    try {
      await deps.store.markSeries4FlyRunnerReady(job, binding.runnerBaseUrl);
      return {
        status: 'ready',
        userId: job.userId,
        flyAppName: binding.fly.appName,
        flyMachineId: binding.fly.machineId,
        flyVolumeId: binding.fly.volumeId,
        runnerBaseUrl: binding.runnerBaseUrl,
      };
    } catch (err) {
      // Best-effort: if the mark-ready RPC fails, leave the row in
      // 'provisioning'. The next provisioner pass / readiness-once cron
      // (if enabled) will pick it up. Don't fail the whole provision
      // since we already have a healthy runner.
      const errorCode = sanitizeSeries4ErrorCode(err);
      return {
        status: 'provisioning',
        userId: job.userId,
        flyAppName: binding.fly.appName,
        flyMachineId: binding.fly.machineId,
        flyVolumeId: binding.fly.volumeId,
        readinessNote: `mark_ready_failed:${errorCode}`,
      };
    }
  }

  return {
    status: 'provisioning',
    userId: job.userId,
    flyAppName: binding.fly.appName,
    flyMachineId: binding.fly.machineId,
    flyVolumeId: binding.fly.volumeId,
    readinessNote: readiness === 'timed_out' ? 'healthz_did_not_pass_within_window' : 'healthz_unreachable',
  };
}

// D8 — readiness polling helper. Polls <runnerBaseUrl>/healthz every 4s
// for up to 120s. Returns 'ready' the first time the response is ok=true
// and hermesApiServerAvailable=true, 'timed_out' otherwise.
async function pollRunnerReadiness(
  runnerBaseUrl: string,
  _userId: string,
  _runnerSharedSecret: string,
  fetchImpl: typeof fetch,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<'ready' | 'timed_out' | 'unreachable'> {
  const healthUrl = `${runnerBaseUrl.replace(/\/+$/, '')}/healthz`;
  const deadline = now() + 120_000;
  let lastError: 'unreachable' | 'timed_out' = 'timed_out';
  while (now() < deadline) {
    try {
      const response = await fetchImpl(healthUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; hermesApiServerAvailable?: boolean }
          | null;
        if (payload && payload.ok === true && payload.hermesApiServerAvailable !== false) {
          return 'ready';
        }
      }
    } catch {
      lastError = 'unreachable';
    }
    await sleep(4_000);
  }
  return lastError;
}

// ---------------------------------------------------------------------------
// processSeries4SubscriptionSuspension
// ---------------------------------------------------------------------------

export interface ProcessSeries4SubscriptionSuspensionDeps {
  store: Series4LifecycleStore;
}

export interface ProcessSeries4SubscriptionSuspensionInput {
  env: Record<string, string | undefined>;
  userId: string;
  /** Optional override; defaults to env.SIDEKICK_FLY_VOLUME_RETENTION_DAYS, then
   * to the published promise in @sidekick/shared. */
  retentionDays?: number | null;
  /** Optional product-safe message override. */
  publicStatusMessage?: string | null;
}

export type ProcessSeries4SubscriptionSuspensionResult =
  | { status: 'suspended'; userId: string; retentionSeconds: number }
  | { status: 'no_runner_to_suspend'; userId: string };

export function resolveFlyVolumeRetentionSeconds(env: Record<string, string | undefined>, override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override * 24 * 60 * 60);
  }
  const raw = (env.SIDEKICK_FLY_VOLUME_RETENTION_DAYS ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  // Default raised 30 -> 60 on 2026-08-04 (Alex's call): a lapsed subscriber's
  // workspace is kept for two months before deletion, so a churned user who
  // returns inside that window gets their coworker back with everything
  // intact. Cost of the wait is only the stopped runner's volume, ~$1.50/mo.
  // The env var still overrides for tests and any future policy change.
  //
  // The number itself now comes from the PUBLISHED PROMISE rather than living
  // here, because on 2026-09-13 the privacy policy said nothing about this
  // window at all while the fleet ran on it. One definition means changing the
  // retention changes the sentence customers read, in the same commit.
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DELEGENT_WORKSPACE_RETENTION_DAYS;
  return days * 24 * 60 * 60;
}

export async function processSeries4SubscriptionSuspension(
  input: ProcessSeries4SubscriptionSuspensionInput,
  deps: ProcessSeries4SubscriptionSuspensionDeps,
): Promise<ProcessSeries4SubscriptionSuspensionResult> {
  const retentionSeconds = resolveFlyVolumeRetentionSeconds(input.env, input.retentionDays);
  const message = (input.publicStatusMessage ?? '').trim() || 'Delegent AI is paused while your subscription is inactive.';
  const flipped = await deps.store.markSeries4RunnerSuspended(input.userId, retentionSeconds, message);
  return flipped
    ? { status: 'suspended', userId: input.userId, retentionSeconds }
    : { status: 'no_runner_to_suspend', userId: input.userId };
}

// ---------------------------------------------------------------------------
// processNextSeries4GraceExpiry
// ---------------------------------------------------------------------------

export interface ProcessSeries4GraceExpiryInput {
  env: Record<string, string | undefined>;
}

export interface ProcessSeries4GraceExpiryDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
}

export type ProcessSeries4GraceExpiryResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | { status: 'deleted'; userId: string; flyAppName: string; flyMachineId: string; flyVolumeId: string }
  | { status: 'failed'; userId: string; errorCode: string };

export async function processNextSeries4GraceExpiry(
  input: ProcessSeries4GraceExpiryInput,
  deps: ProcessSeries4GraceExpiryDeps,
): Promise<ProcessSeries4GraceExpiryResult> {
  // Force teardown talks to the Fly API; preflight the same env the
  // provisioning job needs. v2.0.1: require FLY_PRIMARY_REGION explicitly
  // instead of silently defaulting to 'lhr' — a misconfigured region must fail
  // loud (blocked), never quietly target the wrong region.
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  const claim = await deps.store.claimNextSeries4GraceExpiredRunner();
  if (!claim) return { status: 'idle' };

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: (input.env.FLY_PRIMARY_REGION ?? '').trim() || FLY_PRIMARY_REGION_DEFAULT,
  });

  let action: RunnerProviderActionResult;
  try {
    const authorize = () => deps.store.authorizeSeries4GraceDeletion(claim);
    if (!await authorize()) return { status: 'failed', userId: claim.userId, errorCode: 'stale_grace_deletion_claim' };
    action = await provider.deleteRunner(claim.binding, { force: true, beforeDelete: authorize });
  } catch (err) {
    return { status: 'failed', userId: claim.userId, errorCode: sanitizeSeries4ErrorCode(err) };
  }
  if (!action.ok) {
    return { status: 'failed', userId: claim.userId, errorCode: action.errorCode ?? 'series4_fly_force_delete_failed' };
  }

  try {
    await deps.store.recordSeries4RunnerDeleted(claim);
  } catch (err) {
    return { status: 'failed', userId: claim.userId, errorCode: sanitizeSeries4ErrorCode(err) };
  }

  return {
    status: 'deleted',
    userId: claim.userId,
    flyAppName: claim.binding.fly.appName,
    flyMachineId: claim.binding.fly.machineId,
    flyVolumeId: claim.binding.fly.volumeId,
  };
}

// ---------------------------------------------------------------------------
// processNextSeries4StuckReadiness — 2026-06-03 review P0 #4
// ---------------------------------------------------------------------------
// A runner whose Fly binding was recorded but never promoted to 'ready' (its
// mark-ready failed: /healthz timed out, or the RPC threw) sits in
// status='provisioning' forever — the normal claim skips it (a binding exists,
// re-creating would orphan the Machine). This pass re-polls the EXISTING
// runner's /healthz and promotes it in place. Self-heals the support sink.

export interface ProcessSeries4StuckReadinessInput {
  env: Record<string, string | undefined>;
}
export interface ProcessSeries4StuckReadinessDeps {
  store: Series4LifecycleStore;
  fetchImpl?: typeof fetch;
  now?: () => number | Date;
  sleep?: (ms: number) => Promise<void>;
}
export type ProcessSeries4StuckReadinessResult =
  | { status: 'idle' }
  | { status: 'promoted'; userId: string }
  | { status: 'still_unready'; userId: string; readiness: 'timed_out' | 'unreachable' }
  | { status: 'failed'; userId: string; errorCode: string };

export async function processNextSeries4StuckReadiness(
  _input: ProcessSeries4StuckReadinessInput,
  deps: ProcessSeries4StuckReadinessDeps,
): Promise<ProcessSeries4StuckReadinessResult> {
  if (typeof deps.store.claimNextSeries4StuckReadiness !== 'function') return { status: 'idle' };
  // Unknown inventory is an operational failure, never evidence of no work.
  const claim = await deps.store.claimNextSeries4StuckReadiness();
  if (!claim) return { status: 'idle' };

  const readiness = await pollRunnerReadiness(
    claim.runnerBaseUrl,
    claim.job.userId,
    '',
    deps.fetchImpl ?? globalThis.fetch,
    () => {
      const v = deps.now ? deps.now() : Date.now();
      return v instanceof Date ? v.getTime() : v;
    },
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );

  if (readiness === 'ready') {
    try {
      await deps.store.markSeries4FlyRunnerReady(claim.job, claim.runnerBaseUrl);
      return { status: 'promoted', userId: claim.job.userId };
    } catch (err) {
      return { status: 'failed', userId: claim.job.userId, errorCode: sanitizeSeries4ErrorCode(err) };
    }
  }
  return { status: 'still_unready', userId: claim.job.userId, readiness };
}

// ---------------------------------------------------------------------------
// processNextAccountDeletionRequest
// ---------------------------------------------------------------------------

export interface ProcessAccountDeletionRequestInput {
  env: Record<string, string | undefined>;
}

export interface ProcessAccountDeletionRequestDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
}

export type ProcessAccountDeletionRequestResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | { status: 'completed'; requestId: string; userId: string; provider: AccountDeletionCompletion['provider']; flyAppName?: string; flyMachineId?: string; flyVolumeId?: string }
  /** Infrastructure is gone; something else on the account is not, so this run
   * cannot declare it erased. Returned to the queue for the next pass. */
  | { status: 'awaiting'; requestId: string; userId: string; owed: readonly AccountDeletionPhase[] }
  | { status: 'failed'; requestId: string; userId: string; errorCode: string };

/** What a claim still owes, from the phases it came back with. */
export function outstandingAccountDeletionPhases(
  claim: Pick<AccountDeletionRequestClaim, 'authDeletedAt' | 'connectionsClearedAt' | 'infrastructureClearedAt'>,
): readonly AccountDeletionPhase[] {
  const owed: AccountDeletionPhase[] = [];
  if (!claim.authDeletedAt) owed.push('auth');
  if (!claim.connectionsClearedAt) owed.push('connections');
  if (!claim.infrastructureClearedAt) owed.push('infrastructure');
  return owed;
}

export async function processNextAccountDeletionRequest(
  input: ProcessAccountDeletionRequestInput,
  deps: ProcessAccountDeletionRequestDeps,
): Promise<ProcessAccountDeletionRequestResult> {
  // Account erasure is a destructive workspace teardown. Preflight before
  // claiming so a missing provider token cannot strand a request in
  // `processing` until the stale-lease reclaimer runs.
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  const claim = await deps.store.claimNextAccountDeletionRequest();
  if (!claim) return { status: 'idle' };

  const target = accountDeletionTeardownTarget(claim);
  if (target.kind === 'partial') {
    // ⚠️ NOT "nothing to do". A snapshot naming an app or a volume but no
    // machine used to resolve to no binding at all, and the processor recorded
    // `no_fly_teardown_target` and reported the account erased. Partial
    // provisioning is a supported failure state (PASS4-6), so an incomplete
    // binding means resources probably exist and we cannot see all of them.
    // Failing keeps the request in the queue instead of closing it on a guess.
    const errorCode = 'account_deletion_partial_teardown_target';
    await safeMark(() => deps.store.recordAccountDeletionRequestFailed(claim.id, accountDeletionFailure(errorCode)));
    return { status: 'failed', requestId: claim.id, userId: claim.userId, errorCode };
  }
  if (target.kind === 'none') {
    // Positively nothing to tear down: no private target at all. That IS a
    // finished infrastructure phase, but it is not a finished erasure.
    return finishAccountDeletion(deps, claim, { provider: 'none', reason: 'no_fly_teardown_target' });
  }
  const binding = target.binding;

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: (input.env.FLY_PRIMARY_REGION ?? '').trim() || FLY_PRIMARY_REGION_DEFAULT,
  });

  let action: RunnerProviderActionResult;
  try {
    action = await provider.deleteRunner(binding, { force: true });
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    await safeMark(() => deps.store.recordAccountDeletionRequestFailed(claim.id, accountDeletionFailure(errorCode)));
    return { status: 'failed', requestId: claim.id, userId: claim.userId, errorCode };
  }
  if (!action.ok) {
    const errorCode = action.errorCode ?? 'account_deletion_fly_force_delete_failed';
    await safeMark(() => deps.store.recordAccountDeletionRequestFailed(claim.id, accountDeletionFailure(errorCode)));
    return { status: 'failed', requestId: claim.id, userId: claim.userId, errorCode };
  }

  return finishAccountDeletion(deps, claim, {
    provider: 'fly_machines',
    flyAppName: binding.fly.appName,
    flyMachineId: binding.fly.machineId,
    flyVolumeId: binding.fly.volumeId,
  });
}

/**
 * Record the infrastructure phase, then complete ONLY if the whole account is
 * gone.
 *
 * This is the line the old code did not have. Fly teardown finishing meant the
 * request was marked completed, so a 503 on Supabase auth deletion left an
 * account that could still be signed in to, filed as erased.
 */
async function finishAccountDeletion(
  deps: ProcessAccountDeletionRequestDeps,
  claim: AccountDeletionRequestClaim,
  completion: AccountDeletionCompletion,
): Promise<ProcessAccountDeletionRequestResult> {
  try {
    await deps.store.recordAccountDeletionPhase(claim.id, claim.processingToken, 'infrastructure');
    const completed = await deps.store.recordAccountDeletionRequestCompleted(claim.id, claim.processingToken, completion);
    if (completed) {
      const flyCompletion = completion.provider === 'fly_machines' ? completion : null;
      return {
        status: 'completed',
        requestId: claim.id,
        userId: claim.userId,
        provider: completion.provider,
        ...(flyCompletion ? {
          flyAppName: flyCompletion.flyAppName,
          flyMachineId: flyCompletion.flyMachineId,
          flyVolumeId: flyCompletion.flyVolumeId,
        } : {}),
      };
    }
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    await safeMark(() => deps.store.recordAccountDeletionRequestFailed(claim.id, accountDeletionFailure(errorCode)));
    return { status: 'failed', requestId: claim.id, userId: claim.userId, errorCode };
  }
  // The workspace is gone and something else is not. Back to the queue rather
  // than a terminal state either way, so the half that is still owed gets
  // another run at it.
  const owed = outstandingAccountDeletionPhases({ ...claim, infrastructureClearedAt: claim.claimedAt });
  await safeMark(() => deps.store.recordAccountDeletionRequestFailed(
    claim.id, accountDeletionFailure('account_deletion_awaiting_account_erasure')));
  return { status: 'awaiting', requestId: claim.id, userId: claim.userId, owed };
}

// ---------------------------------------------------------------------------
// processNextCoworkerReimage (Feature 3 — agent upgrade path)
// ---------------------------------------------------------------------------

/** Lease window for an in-flight reimage; long enough for the machine restart. */
export const COWORKER_REIMAGE_LEASE_SECONDS = 600;

export interface ProcessCoworkerReimageInput {
  env: Record<string, string | undefined>;
}

export interface ProcessCoworkerReimageDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
}

export type ProcessCoworkerReimageResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | { status: 'reimaged'; userId: string; imageDigest: string | null; healthy: boolean }
  | { status: 'failed'; userId: string; errorCode: string };

/**
 * Process one user-requested coworker re-image. Mirrors the grace-expiry /
 * account-deletion lifecycle: preflight env, refresh the public update flags,
 * claim one leased candidate, re-image it in place (volume preserved), and
 * record the outcome. Request-driven: a runner is only re-imaged after the user
 * taps "Update my coworker" (the worker calls request_coworker_reimage).
 */
export async function processNextCoworkerReimage(
  input: ProcessCoworkerReimageInput,
  deps: ProcessCoworkerReimageDeps,
): Promise<ProcessCoworkerReimageResult> {
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  const latestImageRef = (input.env.SIDEKICK_FLY_RUNNER_IMAGE_REF ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (!latestImageRef) missingVariables.push('SIDEKICK_FLY_RUNNER_IMAGE_REF');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  const latestDigest = latestImageRef.includes('@') ? latestImageRef.split('@')[1] : latestImageRef;

  // Keep the public "update available" badges fresh. Best-effort: a failure
  // here must not strand a pending reimage request.
  await safeMark(async () => { await deps.store.refreshCoworkerUpdateFlags(latestDigest); });

  const claim = await deps.store.claimCoworkerReimageCandidate(latestImageRef, COWORKER_REIMAGE_LEASE_SECONDS);
  if (!claim) return { status: 'idle' };

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: flyRegion || FLY_PRIMARY_REGION_DEFAULT,
  });

  const reimage = provider.reimageRunner;
  if (typeof reimage !== 'function') {
    await safeMark(() => deps.store.recordCoworkerReimageOutcome(claim.userId, false, null, null, 'reimage_unsupported'));
    return { status: 'failed', userId: claim.userId, errorCode: 'reimage_unsupported' };
  }

  // Minimal binding — reimageRunner only needs the fly app/machine + base URL
  // for the post-restart health probe. The shared secret is intentionally not
  // loaded (re-image never touches it).
  const binding: FlyMachinesRunnerBinding = {
    providerId: 'fly_machines',
    userId: claim.userId,
    runnerBaseUrl: `https://${claim.flyAppName}.fly.dev`,
    runnerSharedSecret: '',
    status: 'ready',
    createdAt: new Date().toISOString(),
    lastHealthAt: null,
    fly: {
      org: flyOrg,
      appName: claim.flyAppName,
      machineId: claim.flyMachineId,
      volumeId: claim.flyVolumeId,
      region: claim.flyRegion || flyRegion,
      imageRef: latestImageRef,
      imageDigest: claim.currentImageDigest,
    },
  };

  let result: ReimageRunnerResult;
  try {
    result = await reimage(binding, { targetImageRef: latestImageRef });
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    await safeMark(() => deps.store.recordCoworkerReimageOutcome(claim.userId, false, null, null, errorCode));
    return { status: 'failed', userId: claim.userId, errorCode };
  }

  if (!result.ok || !result.healthy) {
    const errorCode = sanitizeSeries4ErrorCode(result.ok ? 'coworker_reimage_health_unavailable' : result.reason ?? 'coworker_reimage_failed');
    await safeMark(() => deps.store.recordCoworkerReimageOutcome(claim.userId, false, null, null, errorCode));
    return { status: 'failed', userId: claim.userId, errorCode };
  }

  try {
    await deps.store.recordCoworkerReimageOutcome(claim.userId, true, result.appliedImageRef, result.appliedImageDigest, null);
  } catch (err) {
    return { status: 'failed', userId: claim.userId, errorCode: sanitizeSeries4ErrorCode(err) };
  }

  return { status: 'reimaged', userId: claim.userId, imageDigest: result.appliedImageDigest, healthy: result.healthy };
}

// ---------------------------------------------------------------------------
// processNextSeries4RunnerResize — auto right-size a runner after a tier change
// ---------------------------------------------------------------------------
// A Stripe upgrade updates subscriptions.tier_id + the token quota but never
// resizes the Fly Machine (enqueueHermesProvisioning no-ops a 'ready' runner),
// so upgraders kept running on their old tier's compute + volume. This pass
// claims one runner whose machine size has drifted from its entitlement and
// drives provider.resizeRunner (extend volume + PATCH machine guest) in place.
// Request-free: driven purely by the subscription-vs-sized-tier drift the claim
// RPC detects. Mirrors the coworker-reimage lifecycle.

/** Lease window for an in-flight resize; covers the volume-extend + guest PATCH restart. */
export const RUNNER_RESIZE_LEASE_SECONDS = 300;

export interface ProcessRunnerResizeInput {
  env: Record<string, string | undefined>;
}

export interface ProcessRunnerResizeDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
}

export type ProcessRunnerResizeResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | { status: 'resized'; userId: string; targetTier: string; deferred?: 'shrink_on_renewal' }
  | { status: 'failed'; userId: string; errorCode: string };

/**
 * Process one runner whose plan tier drifted from its machine size. Preflights
 * the Fly env, claims one leased candidate, calls resizeRunner (idempotent volume
 * extend + guest PATCH), and records the outcome. The volume can only GROW in
 * place; a downgrade returns `deferred: 'shrink_on_renewal'` from the provider —
 * compute is still reduced immediately and we stamp the tier as sized so the row
 * stops being re-claimed (the disk shrink is a separate renewal-window concern).
 */
export async function processNextSeries4RunnerResize(
  input: ProcessRunnerResizeInput,
  deps: ProcessRunnerResizeDeps,
): Promise<ProcessRunnerResizeResult> {
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  if (typeof deps.store.claimRunnerResizeCandidate !== 'function'
    || typeof deps.store.recordRunnerResizeOutcome !== 'function') {
    // RPCs not yet applied (rollout order) — treat as idle so this never fails
    // the cron or opens a spurious alert before migration 0043 lands.
    return { status: 'idle' };
  }

  const claim = await deps.store.claimRunnerResizeCandidate(RUNNER_RESIZE_LEASE_SECONDS);
  if (!claim) return { status: 'idle' };

  const recordOutcome = deps.store.recordRunnerResizeOutcome.bind(deps.store);

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: flyRegion || FLY_PRIMARY_REGION_DEFAULT,
  });

  const resize = provider.resizeRunner;
  if (typeof resize !== 'function') {
    await safeMark(() => recordOutcome(claim!.userId, false, null, 'resize_unsupported'));
    return { status: 'failed', userId: claim.userId, errorCode: 'resize_unsupported' };
  }

  // Minimal binding — resizeRunner only needs the fly app/machine/volume ids.
  // The shared secret is intentionally not loaded (resize never touches it).
  const binding: FlyMachinesRunnerBinding = {
    providerId: 'fly_machines',
    userId: claim.userId,
    runnerBaseUrl: `https://${claim.flyAppName}.fly.dev`,
    runnerSharedSecret: '',
    status: 'ready',
    createdAt: new Date().toISOString(),
    lastHealthAt: null,
    fly: {
      org: flyOrg,
      appName: claim.flyAppName,
      machineId: claim.flyMachineId,
      volumeId: claim.flyVolumeId,
      region: claim.flyRegion || flyRegion,
      imageRef: '',
      imageDigest: null,
    },
  };

  let result: Awaited<ReturnType<NonNullable<RunnerProvider['resizeRunner']>>>;
  try {
    result = await resize(binding, { targetTierId: claim.targetTier });
  } catch (err) {
    const errorCode = sanitizeSeries4ErrorCode(err);
    await safeMark(() => recordOutcome(claim!.userId, false, null, errorCode));
    return { status: 'failed', userId: claim.userId, errorCode };
  }

  if (!result.ok) {
    const errorCode = sanitizeSeries4ErrorCode(result.reason ?? 'runner_resize_failed');
    await safeMark(() => recordOutcome(claim!.userId, false, null, errorCode));
    return { status: 'failed', userId: claim.userId, errorCode };
  }

  try {
    await recordOutcome(claim.userId, true, claim.targetTier, null);
  } catch (err) {
    return { status: 'failed', userId: claim.userId, errorCode: sanitizeSeries4ErrorCode(err) };
  }

  return {
    status: 'resized',
    userId: claim.userId,
    targetTier: claim.targetTier,
    ...(result.deferred ? { deferred: result.deferred } : {}),
  };
}

// ---------------------------------------------------------------------------
// processSeries4StorageUsageSweep — measure what each user actually stores
// ---------------------------------------------------------------------------
// usage_quotas.consumed_storage_bytes has been read by the Worker's downgrade
// guard since 0026 but never written, so it is 0 for everyone. Nothing in
// docs/DYNAMIC_RESOURCE_SIZING.md (small-start volumes, auto-grow at 75%, the
// fair-use cap) can ship until we can measure usage.
//
// The reading comes from the Fly volume API's ext4 block accounting rather than
// a runner endpoint: no golden-image rebuild, no --release gate, and it works
// while the machine is stopped or the user is mid-session. It also keeps
// FLY_API_TOKEN in the provisioner cron, which is the only place allowed to
// hold it.
//
// Unlike the other passes this one sweeps a BATCH rather than claiming a single
// row: it is read-only against Fly, so a partial failure costs nothing and the
// whole fleet fits comfortably in one tick.

/** Max runners measured per tick. Each is one Fly GET. */
export const STORAGE_USAGE_BATCH_LIMIT = 25;
/** Skip users measured more recently than this. */
export const STORAGE_USAGE_STALE_SECONDS = 3600;
/** Fly bills and sizes volumes in binary GB, which is what storage_quota_bytes counts in too. */
const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface ProcessStorageUsageInput {
  env: Record<string, string | undefined>;
}

export interface ProcessStorageUsageDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
  limit?: number;
  staleSeconds?: number;
}

export type ProcessStorageUsageResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | {
      status: 'swept';
      measured: number;
      skipped: number;
      grown: readonly { userId: string; fromGb: number; toGb: number }[];
      failures: readonly { userId: string; errorCode: string }[];
    };

/**
 * Measure every stale runner's volume usage, write it to usage_quotas, and grow
 * the volume when it crosses STORAGE_GROW_AT_FRACTION of its current size.
 * Growing is online (verified 2026-07-25: the mounted filesystem reports the new
 * size within seconds, no restart), so it never interrupts a session. A user
 * whose volume cannot be read is left with their previous reading and reported
 * in `failures` so the cron surfaces it without failing the whole tick.
 */
export async function processSeries4StorageUsageSweep(
  input: ProcessStorageUsageInput,
  deps: ProcessStorageUsageDeps,
): Promise<ProcessStorageUsageResult> {
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  if (typeof deps.store.listStorageUsageTargets !== 'function'
    || typeof deps.store.recordStorageUsage !== 'function') {
    // RPCs not yet applied (rollout order) — idle rather than fail the cron.
    return { status: 'idle' };
  }

  const limit = deps.limit ?? STORAGE_USAGE_BATCH_LIMIT;
  const staleSeconds = deps.staleSeconds ?? STORAGE_USAGE_STALE_SECONDS;

  const targets = await deps.store.listStorageUsageTargets(limit, staleSeconds);
  if (targets.length === 0) return { status: 'idle' };

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: flyRegion || FLY_PRIMARY_REGION_DEFAULT,
  });

  const readUsage = provider.getStorageUsage;
  if (typeof readUsage !== 'function') {
    return { status: 'swept', measured: 0, skipped: targets.length, grown: [], failures: [] };
  }
  const growVolume = provider.growStorage;
  const recordUsage = deps.store.recordStorageUsage.bind(deps.store);

  let measured = 0;
  let skipped = 0;
  const grown: { userId: string; fromGb: number; toGb: number }[] = [];
  const failures: { userId: string; errorCode: string }[] = [];

  for (const target of targets) {
    const binding: FlyMachinesRunnerBinding = {
      providerId: 'fly_machines',
      userId: target.userId,
      runnerBaseUrl: `https://${target.flyAppName}.fly.dev`,
      runnerSharedSecret: '',
      status: 'ready',
      createdAt: new Date().toISOString(),
      lastHealthAt: null,
      fly: {
        org: flyOrg,
        appName: target.flyAppName,
        machineId: '',
        volumeId: target.flyVolumeId,
        region: flyRegion,
        imageRef: '',
        imageDigest: null,
      },
    };

    let usage: Awaited<ReturnType<NonNullable<RunnerProvider['getStorageUsage']>>>;
    try {
      usage = await readUsage(binding);
    } catch (err) {
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(err) });
      continue;
    }
    if (!usage.ok) {
      // A volume with no block accounting yet (never mounted) is expected, not
      // a fault: skip it and let the next tick pick it up.
      if (usage.reason === 'fly_volume_usage_unavailable') { skipped += 1; continue; }
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(usage.reason) });
      continue;
    }

    try {
      await recordUsage(target.userId, usage.usedBytes);
      measured += 1;
    } catch (err) {
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(err) });
      continue;
    }

    if (typeof growVolume !== 'function' || target.storageQuotaBytes === null) continue;
    const targetSizeGb = nextVolumeSizeGb({
      currentGb: usage.sizeGb,
      usedBytes: usage.usedBytes,
      capacityBytes: usage.capacityBytes,
      capGb: target.storageQuotaBytes / BYTES_PER_GB,
    });
    if (targetSizeGb === null) continue;

    try {
      const outcome = await growVolume(binding, { targetSizeGb });
      if (outcome.ok) {
        grown.push({ userId: target.userId, fromGb: usage.sizeGb, toGb: outcome.appliedSizeGb });
      } else {
        failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(outcome.reason) });
      }
    } catch (err) {
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(err) });
    }
  }

  return { status: 'swept', measured, skipped, grown, failures };
}

// ---------------------------------------------------------------------------
// processSeries4SuspendedRunnerStop — stop the machine a cancelled user left
// ---------------------------------------------------------------------------
// processSeries4SubscriptionSuspension flips the row to 'sleeping' and starts
// the retention clock, but nothing ever called stopRunner, so a cancelled
// customer's Machine kept running 24/7 at full price for the whole 30-day
// grace window before the expiry job deleted it. This is that missing pass.
//
// Only the Machine is stopped. The volume is deliberately left in place: the
// grace window exists so the user's workspace survives a resubscribe, and
// claimNextSeries4GraceExpiredRunner owns deletion.
//
// A sweep rather than a single-row claim, and no lease: stopping a stopped
// Machine is a no-op, so a concurrent tick or a repeat call costs one wasted
// Fly POST and nothing else. If a user resubscribes in the window between the
// list read and the stop, mark_hermes_runner_resumed has already put the row
// back into 'provisioning', and the provisioning pass starts the Machine again
// on its next tick.

/** Max runners stopped per tick. Each is one Fly POST. */
export const SUSPENDED_STOP_BATCH_LIMIT = 25;

export interface ProcessSuspendedRunnerStopInput {
  env: Record<string, string | undefined>;
}

export interface ProcessSuspendedRunnerStopDeps {
  store: Series4LifecycleStore;
  provider?: RunnerProvider;
  limit?: number;
}

export type ProcessSuspendedRunnerStopResult =
  | { status: 'idle' }
  | { status: 'blocked'; missingVariables: readonly string[]; missingSecrets: readonly string[] }
  | {
      status: 'swept';
      stopped: readonly string[];
      failures: readonly { userId: string; errorCode: string }[];
    };

/**
 * Stop the Fly Machine behind every suspended runner. Idempotent, read-cheap,
 * and safe to run on any cadence: a machine that is already stopped simply
 * returns ok.
 */
export async function processSeries4SuspendedRunnerStop(
  input: ProcessSuspendedRunnerStopInput,
  deps: ProcessSuspendedRunnerStopDeps,
): Promise<ProcessSuspendedRunnerStopResult> {
  const missingSecrets: string[] = [];
  const missingVariables: string[] = [];
  const flyToken = (input.env.FLY_API_TOKEN ?? '').trim();
  const flyOrg = (input.env.FLY_ORG ?? '').trim();
  const flyRegion = (input.env.FLY_PRIMARY_REGION ?? '').trim();
  if (!flyToken) missingSecrets.push('FLY_API_TOKEN');
  if (!flyOrg) missingVariables.push('FLY_ORG');
  if (!flyRegion) missingVariables.push('FLY_PRIMARY_REGION');
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    return { status: 'blocked', missingSecrets, missingVariables };
  }

  if (typeof deps.store.listSuspendedRunnerStopTargets !== 'function') {
    return { status: 'idle' };
  }

  const targets = await deps.store.listSuspendedRunnerStopTargets(deps.limit ?? SUSPENDED_STOP_BATCH_LIMIT);
  if (targets.length === 0) return { status: 'idle' };

  const provider: RunnerProvider = deps.provider ?? createFlyMachinesProvider({
    apiToken: flyToken,
    org: flyOrg,
    primaryRegion: flyRegion || FLY_PRIMARY_REGION_DEFAULT,
  });

  const stopped: string[] = [];
  const failures: { userId: string; errorCode: string }[] = [];

  for (const target of targets) {
    // Minimal binding — stopRunner only needs the fly app + machine id. The
    // shared secret is intentionally not loaded (stopping never uses it).
    const binding: FlyMachinesRunnerBinding = {
      providerId: 'fly_machines',
      userId: target.userId,
      runnerBaseUrl: `https://${target.flyAppName}.fly.dev`,
      runnerSharedSecret: '',
      status: 'sleeping',
      createdAt: new Date().toISOString(),
      lastHealthAt: null,
      fly: {
        org: flyOrg,
        appName: target.flyAppName,
        machineId: target.flyMachineId,
        volumeId: target.flyVolumeId,
        region: target.flyRegion || flyRegion,
        imageRef: '',
        imageDigest: null,
      },
    };

    let result: RunnerProviderActionResult;
    try {
      result = await provider.stopRunner(binding);
    } catch (err) {
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(err) });
      continue;
    }
    if (result.ok) {
      stopped.push(target.userId);
    } else {
      failures.push({ userId: target.userId, errorCode: sanitizeSeries4ErrorCode(result.errorCode ?? 'fly_machine_stop_failed') });
    }
  }

  return { status: 'swept', stopped, failures };
}

function accountDeletionFailure(errorCode: string): AccountDeletionFailure {
  return {
    errorCode: sanitizeSeries4ErrorCode(errorCode),
    publicStatusMessage: 'Delegent AI account deletion needs an operator check before continuing.',
  };
}

export type AccountDeletionTeardownTarget =
  | { kind: 'fly'; binding: FlyMachinesRunnerBinding }
  /** Positively nothing provisioned: no private target recorded at all. */
  | { kind: 'none' }
  /** Something was provisioned and the snapshot does not describe all of it. */
  | { kind: 'partial'; missing: readonly string[] };

/**
 * Absence of a complete binding is not evidence that nothing exists.
 *
 * The old resolver answered null for both cases, and the caller treated null as
 * "no teardown target" and reported the account erased. A snapshot with an app
 * name and a volume but no machine id is a half-provisioned workspace, which is
 * a supported failure state, and telling somebody their files are destroyed
 * because we could not see the machine id is the worst possible answer.
 */
export function accountDeletionTeardownTarget(claim: AccountDeletionRequestClaim): AccountDeletionTeardownTarget {
  const snapshot = recordFromUnknown(claim.teardownSnapshot);
  const target = recordFromUnknown(snapshot.private_teardown_target);
  // A workspace already torn down and marked deleted has nothing left to tear
  // down. Every runner was destroyed and marked on 2026-09-18 when Fly closed,
  // but their records still name the app, so deleting one of those former
  // customers called Fly for it: harmless while Fly answers "app not found",
  // and a failure every hour, for ever, once the Fly token stops working
  // (QA E3, 2026-09-23).
  if (stringFromRecord(target, 'deleted_at')) return { kind: 'none' };
  const flyAppName = stringFromRecord(target, 'fly_app_name');
  const flyMachineId = stringFromRecord(target, 'fly_machine_id');
  const flyVolumeId = stringFromRecord(target, 'fly_volume_id');
  const named = [flyAppName, flyMachineId, flyVolumeId].filter(Boolean).length;
  if (stringFromRecord(target, 'provider') !== 'fly_machines') {
    // A snapshot that names infrastructure without naming its provider is
    // still infrastructure somebody has to account for.
    return named > 0 ? { kind: 'partial', missing: ['provider'] } : { kind: 'none' };
  }
  if (named === 0) return { kind: 'none' };
  if (!flyAppName || !flyMachineId || !flyVolumeId) {
    return {
      kind: 'partial',
      missing: [
        ...(flyAppName ? [] : ['fly_app_name']),
        ...(flyMachineId ? [] : ['fly_machine_id']),
        ...(flyVolumeId ? [] : ['fly_volume_id']),
      ],
    };
  }
  return { kind: 'fly', binding: flyBindingFromAccountDeletionClaim(claim, flyAppName, flyMachineId, flyVolumeId) };
}

function flyBindingFromAccountDeletionClaim(
  claim: AccountDeletionRequestClaim,
  flyAppName: string,
  flyMachineId: string,
  flyVolumeId: string,
): FlyMachinesRunnerBinding {
  const target = recordFromUnknown(recordFromUnknown(claim.teardownSnapshot).private_teardown_target);
  return {
    providerId: 'fly_machines',
    userId: claim.userId,
    runnerBaseUrl: stringFromRecord(target, 'runner_base_url') ?? '',
    // The Worker intentionally excludes runner_shared_secret from the durable
    // deletion snapshot. Fly teardown does not need it, so keep the binding
    // structurally valid without reintroducing secret persistence.
    runnerSharedSecret: '',
    status: 'deleting',
    createdAt: '1970-01-01T00:00:00.000Z',
    lastHealthAt: null,
    fly: {
      org: stringFromRecord(target, 'fly_org') ?? '',
      appName: flyAppName,
      machineId: flyMachineId,
      volumeId: flyVolumeId,
      region: stringFromRecord(target, 'fly_region') ?? '',
      imageRef: stringFromRecord(target, 'image_ref') ?? '',
      imageDigest: null,
    },
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Public-safe image label. Strips the registry host + digest so mobile only
 * sees something like "delegent-hermes-runner:1.0.0".
 */
export function imageRefLabel(imageRef: string): string {
  if (!imageRef) return '';
  const withoutDigest = imageRef.split('@', 1)[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const suffix = lastSlash >= 0 ? withoutDigest.slice(lastSlash + 1) : withoutDigest;
  return suffix.slice(0, 64);
}

async function safeMark(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Marking is best-effort; the next reconciliation loop will pick this
    // row up again if we couldn't persist the failure state.
  }
}

export { FLY_PRIMARY_REGION_DEFAULT, FLY_RUNNER_APP_PREFIX_DEFAULT, FLY_WORKSPACE_MOUNT_PATH };
