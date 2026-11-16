// Series 4 — provider-agnostic runner contract.
//
// The shared control plane (Worker, provisioner orchestration, Supabase
// writes, mobile-facing product state) talks to runners through this
// interface only. The active implementation in Series 4 is
// FlyMachinesProvider (./flyMachines); the legacy RailwayProvider is kept
// around behind SIDEKICK_RUNNER_PROVIDER=railway_legacy only during cutover
// and is disabled by default.
//
// Per-user isolation guarantee
//   The interface is shaped so the same RunnerBinding cannot be reused for
//   two different users: every binding carries its own userId, its own
//   runnerSharedSecret, and provider-specific fields (Fly app/Machine/volume
//   ids) that are unique per call to createRunner. Callers MUST NOT mutate
//   a RunnerBinding to point at a different user.
//
// Secret handling
//   - runnerSharedSecret is a per-user HMAC key. Never log it, never return
//     it through any product-state surface. The Worker reads it from
//     hermes_instance_private via service-role only.
//   - Provider tokens (FLY_API_TOKEN, etc.) live in env; the interface
//     never passes them through.
import type { PlanTierId } from '@sidekick/shared';

export type RunnerProviderId = 'fly_machines' | 'railway_legacy';

/** A runner's lifecycle state, projected to mobile-safe public status. */
export type RunnerStatus =
  | 'provisioning'
  | 'ready'
  | 'sleeping'
  | 'error'
  | 'deleting'
  | 'deleted';

/** Input to RunnerProvider.createRunner. Everything in here is per-user. */
export interface CreateRunnerInput {
  userId: string;
  tierId: PlanTierId;
  /** User's chosen agent name, e.g. "Nova". Cosmetic; surfaced to Hermes via env. */
  agentName?: string | null;
  /** Cloudflare Worker URL the runner's local OpenAI adapter calls for chat completions. */
  workerProxyUrl: string;
  /** Per-user HMAC key. Must be a fresh secret per runner, ≥32 chars. */
  runnerSharedSecret: string;
  /**
   * Provider-specific image reference. For Fly: the golden image registry ref
   * (e.g. registry.fly.io/delegent-hermes-runner@sha256:...). For Railway:
   * the legacy bootstrap source URL.
   */
  imageRef?: string | null;
  /**
   * Optional volume size override (GB). Provider may clamp to its minimum.
   * If null/undefined the provider picks a tier-appropriate default.
   */
  volumeSizeGb?: number | null;
  /** Provider region override; provider falls back to its configured default. */
  region?: string | null;
  /**
   * Idempotency key. Two calls with the same key must produce the same
   * binding (provider-side dedup) or, at minimum, never produce two
   * runners for the same user.
   */
  idempotencyKey: string;
}

/**
 * What the provisioner persists per user. The shape is intentionally a
 * discriminated union by providerId so a stale Railway binding cannot
 * accidentally be passed to FlyMachinesProvider methods.
 */
export type RunnerBinding =
  | FlyMachinesRunnerBinding
  | RailwayLegacyRunnerBinding;

export interface RunnerBindingCommon {
  userId: string;
  /** Provider-issued public URL (https://...). Never includes secret query strings. */
  runnerBaseUrl: string;
  /** Per-user HMAC secret. Service-role only — never persisted client-side. */
  runnerSharedSecret: string;
  /** Last lifecycle state recorded by the provisioner. */
  status: RunnerStatus;
  /** When createRunner returned. ISO-8601. */
  createdAt: string;
  /** Last time getHealth wrote back. ISO-8601 or null. */
  lastHealthAt: string | null;
}

export interface FlyMachinesRunnerBinding extends RunnerBindingCommon {
  providerId: 'fly_machines';
  fly: {
    org: string;
    appName: string;
    machineId: string;
    volumeId: string;
    region: string;
    imageRef: string;
    imageDigest?: string | null;
  };
}

export interface RailwayLegacyRunnerBinding extends RunnerBindingCommon {
  providerId: 'railway_legacy';
  railway: {
    projectId: string;
    serviceId?: string | null;
    volumeId?: string | null;
    environmentId?: string | null;
  };
}

/** Health snapshot returned by RunnerProvider.getHealth. */
export interface RunnerHealth {
  /** True iff the runner returned a 2xx and ok=true. */
  ok: boolean;
  /** Lifecycle state derived from the probe + provider state. */
  status: RunnerStatus;
  /** True iff the runner reports Hermes is callable in the image. */
  hermesAvailable: boolean;
  /** True iff the per-user workspace volume is mounted and writable. */
  workspaceReady: boolean;
  /** Pinned Hermes version, e.g. "v2026.5.7". Null if unknown. */
  hermesVersion: string | null;
  /** ISO timestamp the probe was made. */
  lastCheckedAt: string;
  /** Machine-readable error code if !ok. Snake_case, ≤64 chars. */
  errorCode?: string | null;
  /** Product-safe error message if !ok. */
  errorMessage?: string | null;
}

export interface RunnerProviderPreflightCheck {
  id: string;
  ok: boolean;
  severity: 'blocking' | 'warning';
  requiredNames: readonly string[];
  missingNames: readonly string[];
  reason: string;
}

export interface RunnerProviderPreflight {
  providerId: RunnerProviderId;
  ok: boolean;
  requiredVariables: readonly string[];
  requiredSecrets: readonly string[];
  missingVariables: readonly string[];
  missingSecrets: readonly string[];
  checks: readonly RunnerProviderPreflightCheck[];
}

export interface RunnerProviderActionResult {
  ok: boolean;
  /** Machine-readable code if !ok. Snake_case, ≤64 chars. */
  errorCode?: string;
  /** Product-safe message if !ok. Must not contain provider tokens/ids. */
  errorMessage?: string;
}

export interface RunnerProvider {
  readonly providerId: RunnerProviderId;
  preflight(env: Record<string, string | undefined>): RunnerProviderPreflight;
  createRunner(input: CreateRunnerInput): Promise<RunnerBinding>;
  startRunner(binding: RunnerBinding): Promise<RunnerProviderActionResult>;
  stopRunner(binding: RunnerBinding): Promise<RunnerProviderActionResult>;
  /**
   * Tear down the runner.
   *
   * Per Series 4 cancellation policy (Option A): the Fly provider stops the
   * Machine + retains the volume for the grace period. `options.force=true`
   * is required to actually destroy the volume; defaults to false so an
   * accidental call cannot delete user workspace data.
   */
  deleteRunner(
    binding: RunnerBinding,
    options?: DeleteRunnerOptions,
  ): Promise<RunnerProviderActionResult>;
  getHealth(binding: RunnerBinding): Promise<RunnerHealth>;
  /**
   * Apply a plan-tier change in place. The provider:
   *   - Extends the persistent volume to the new tier's storage cap. Fly
   *     volumes cannot SHRINK in place — downgrades that need less storage
   *     return `{ ok: true, deferred: 'shrink_on_renewal' }` so the caller
   *     can persist the intent and run the shrink during the next renewal
   *     window (via snapshot + recreate).
   *   - Resizes the Machine's compute (cpus + memory) to the new tier.
   *
   * Optional — providers that don't support resize return
   * `{ ok: false, deferred: 'unsupported' }`.
   */
  resizeRunner?(
    binding: RunnerBinding,
    request: ResizeRunnerRequest,
  ): Promise<ResizeRunnerResult>;
  /**
   * Re-image the runner in place onto a newer golden image, PRESERVING the
   * user's persistent volume (their workspace files) and every per-user env
   * var (shared secret, agent identity, worker proxy URL). This is the
   * platform-driven upgrade path: the user TRIGGERS a move to the vetted
   * latest image; the runner never self-updates its own runtime.
   *
   * Implementations must round-trip the full machine config and change only
   * the image reference — providers whose update API replaces the config
   * wholesale would otherwise drop the mounts/env/health-checks. Idempotent:
   * if the runner is already on the target image, returns
   * `{ ok: true, alreadyCurrent: true }` without mutating anything.
   *
   * Optional — providers that don't support re-image return
   * `{ ok: false, reason: '...', deferred: 'unsupported' }`.
   */
  reimageRunner?(
    binding: RunnerBinding,
    request: ReimageRunnerRequest,
  ): Promise<ReimageRunnerResult>;
  /**
   * Read how much of the runner's persistent volume is actually in use. Read
   * only: it must never start, stop, or reconfigure the machine, so it is safe
   * to call against a sleeping runner or a user who is mid-session.
   *
   * Optional — providers without a usage API return `{ ok: false, reason }`.
   */
  getStorageUsage?(binding: RunnerBinding): Promise<StorageUsageResult>;
  /**
   * Grow the persistent volume to `targetSizeGb`, in place and online. Verified
   * against Fly on 2026-07-25: the mounted filesystem reports the new size
   * within seconds and the machine is NEVER restarted, so this is safe to run
   * while the user is mid-session. Growth only; shrinking is not possible in
   * place and is not attempted here.
   *
   * Optional — providers without an online extend return `{ ok: false, reason }`.
   */
  growStorage?(binding: RunnerBinding, request: { targetSizeGb: number }): Promise<GrowStorageResult>;
}

export type StorageUsageResult =
  | { ok: true; usedBytes: number; capacityBytes: number; sizeGb: number }
  | { ok: false; reason: string };

export type GrowStorageResult =
  | { ok: true; appliedSizeGb: number }
  | { ok: false; reason: string };

export interface ResizeRunnerRequest {
  /** The new plan tier the user is moving to. */
  targetTierId: PlanTierId;
}

export type ResizeRunnerResult =
  | { ok: true; appliedVolumeGb: number; appliedCompute: ComputeTier; deferred?: 'shrink_on_renewal' }
  | { ok: false; reason: string; deferred?: 'unsupported' };

export interface ReimageRunnerRequest {
  /**
   * Target golden-image ref the runner should boot from, e.g.
   * `registry.fly.io/delegent-runner-images@sha256:...`. Should be
   * digest-pinned so the re-image is reproducible.
   */
  targetImageRef: string;
}

export type ReimageRunnerResult =
  | {
      ok: true;
      /** True iff the runner was already on the target image (no-op). */
      alreadyCurrent: boolean;
      /** The image ref the runner is now pinned to. */
      appliedImageRef: string;
      /** The sha256 digest portion of appliedImageRef, or null if untagged. */
      appliedImageDigest: string | null;
      /** True iff /healthz passed after the re-image restart. */
      healthy: boolean;
    }
  | { ok: false; reason: string; deferred?: 'unsupported' };

export interface DeleteRunnerOptions {
  /** Durable ownership/entitlement fence, rechecked before each provider delete. */
  beforeDelete?: () => Promise<boolean>;
  /**
   * When true: also destroy the persistent volume + Fly app. When false
   * (default): stop the Machine only, retain the volume for renewal.
   *
   * In production this maps to operator intent — `false` for routine
   * cancellation handling, `true` only for explicit account deletion or
   * test teardown gated by SIDEKICK_ALLOW_FLY_TEST_DESTROY=true.
   */
  force?: boolean;
}

// -----------------------------------------------------------------------------
// Helpers shared across provider implementations (and tests)
// -----------------------------------------------------------------------------

/**
 * Provider-agnostic deterministic suffix used in resource names. Never
 * embeds raw email, UUID, or any field that could leak PII into Fly app
 * names that appear in provider dashboards or DNS.
 *
 * Uses the first 12 hex chars of SHA-256(userId + idempotencyKey). Same
 * input → same suffix; cross-user collision is cryptographically unlikely
 * (1 in 2^48 across the keyspace).
 */
export async function deriveRunnerResourceSuffix(
  userId: string,
  idempotencyKey: string,
): Promise<string> {
  const input = `${userId}:${idempotencyKey}`;
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 6; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex; // 12 chars
}

/**
 * Per-tier defaults the providers can fall back to when CreateRunnerInput
 * doesn't specify volumeSizeGb. Internal provisioning sizing only; kept in
 * lockstep with @sidekick/shared PlanTier.storageGb. These numbers are never
 * shown to users (per-tier storage is presented as "grows with your plan").
 */
export const DEFAULT_VOLUME_SIZE_GB_BY_TIER: Readonly<Record<PlanTierId, number>> = Object.freeze({
  studio: 10,
  'pro-office': 40,
  'enterprise-suite': 100,
});

/** The plan's storage cap. This is what usage_quotas records and what growth stops at. */
export function storageEntitlementGb(tierId: PlanTierId): number {
  return DEFAULT_VOLUME_SIZE_GB_BY_TIER[tierId] ?? DEFAULT_VOLUME_SIZE_GB_BY_TIER.studio;
}

/**
 * A new runner's volume starts here rather than at the plan's full entitlement.
 * We pay for provisioned GB, not used GB, and a fresh workspace holds well under
 * a gigabyte, so allocating the full cap up front bought nothing. Auto-grow
 * (STORAGE_GROW_AT_FRACTION) is what makes this safe: the disk expands online
 * before it fills. Never lower this without auto-grow running.
 */
export const START_VOLUME_SIZE_GB = 3;

/** The size a runner's volume is CREATED at. The cap is storageEntitlementGb. */
export function chooseVolumeSizeGb(input: CreateRunnerInput): number {
  if (typeof input.volumeSizeGb === 'number' && Number.isFinite(input.volumeSizeGb) && input.volumeSizeGb > 0) {
    return Math.floor(input.volumeSizeGb);
  }
  // A plan whose entitlement is somehow below the start size gets the smaller of the two.
  return Math.min(START_VOLUME_SIZE_GB, storageEntitlementGb(input.tierId));
}

/**
 * Grow a volume once it is this full. 75% leaves a full quarter of the disk
 * free while the (online, seconds-long) extend runs, so a user cannot hit a
 * full disk between two sweep ticks unless they write >25% of their volume in
 * that window.
 */
export const STORAGE_GROW_AT_FRACTION = 0.75;

/**
 * Growth is a doubling, so the interval between grows widens as the disk gets
 * bigger and a heavy user converges on their cap in a handful of steps rather
 * than dozens of 1 GB nudges. Fly volumes only grow in whole GB.
 */
export function nextVolumeSizeGb(input: {
  /** Provisioned size from the volume record. */
  currentGb: number;
  usedBytes: number;
  /** Formatted filesystem capacity, which is a few % under currentGb. */
  capacityBytes: number;
  /** The plan's storage cap. Growth never crosses it. */
  capGb: number;
}): number | null {
  const { currentGb, usedBytes, capacityBytes, capGb } = input;
  if (!Number.isFinite(currentGb) || currentGb <= 0) return null;
  if (!Number.isFinite(capGb) || capGb <= 0) return null;
  if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) return null;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return null;
  if (currentGb >= capGb) return null;                                   // already at the plan's cap
  if (usedBytes < capacityBytes * STORAGE_GROW_AT_FRACTION) return null; // not full enough yet
  return Math.min(Math.floor(capGb), currentGb * 2);
}

/**
 * Per-tier compute sizing — picked so each plan's price comfortably covers
 * the Fly Machine cost (compute + volume + bandwidth) with margin left over
 * for OpenRouter usage. See OPERATIONS.md §9 for the cost model.
 *
 * Prices are the 2026-09-07 ones (Studio £9.99, Pro Office £24.99, Enterprise
 * Suite £59.99); read SIDEKICK_PLAN_TIERS rather than this comment. The RAM
 * figures are the live ladder in `computeTierFor` below (1024 / 2048 / 4096 MB),
 * and the reasoning for each step is on that function, not here.
 *
 * Studio: shared-1x — fine for drafts, summaries, light research. Runners
 *                  sleep after idle so the real-world cost is ~£1.40/month.
 * Pro Office: shared-2x — runs longer jobs without swap; can hold a richer
 *                  working memory between requests.
 * Enterprise Suite: performance-2x — guaranteed CPU cores and the headroom
 *                  for multi-step jobs / larger files.
 */
export interface ComputeTier {
  cpuKind: 'shared' | 'performance';
  cpus: number;
  memoryMb: number;
}

// Fly memory minimums by CPU class (see fly.io/docs/machines/guides-examples/machine-sizing):
//   - shared-cpu-Nx:       min  256 MB per CPU
//   - performance-Nx:      min 2048 MB per CPU
// The enterprise-suite tier used to ask for 2 performance CPUs with
// 2048 MB total, which Fly rejects with "invalid_config_guest_memory"
// because performance-2x's minimum is 4096 MB. Bumped to 4 GB.
//
// 2026-08-06: THE CHROMIUM FLOOR IS GONE, so the RAM ladder comes down.
//
// The previous ladder (2 / 3 / 4 GB) existed for one reason: headless Chromium
// needs 1.5-2 GB to render a page, so every tier was raised to stop the browser
// toolset OOMing. That toolset was then never used. Checked before changing
// this, across every assistant message the product has ever produced: **zero**
// browser_* invocations. Chromium was removed from Dockerfile.fly the same day,
// and verify-golden-image.sh now fails if it reappears.
//
// The proof this is safe was already running in production: Alex's own runner
// sat on 1024 MB for months, predating the 2 GB floor, and nothing ever hit a
// memory problem on it.
//
// The floor is now 1 GB. What still sets each tier apart is CPU class, token
// allowance and storage cap.
//
// Fly's minimums constrain the bottom of this ladder, so do not "simplify" it:
//   - shared-cpu-Nx:  min  256 MB per CPU  -> 2 shared CPUs can go to 512 MB
//   - performance-Nx: min 2048 MB per CPU  -> 2 performance CPUs CANNOT go
//     below 4096 MB, which is why enterprise-suite stays there. Lowering it
//     gets "invalid_config_guest_memory" from Fly.
export const DEFAULT_COMPUTE_TIER_BY_PLAN: Readonly<Record<PlanTierId, ComputeTier>> = Object.freeze({
  // 2026-06-05: studio bumped 1 -> 2 shared CPUs. A single shared core starved
  // web_extract (Firecrawl returns a page in ~1s, but a 1-CPU runner took ~37s of
  // local overhead); 2 cores brings research to seconds, matching the higher tiers.
  // The cores stay; it is the RAM that was only ever there for the browser.
  studio: Object.freeze({ cpuKind: 'shared', cpus: 2, memoryMb: 1024 }) as ComputeTier,
  'pro-office': Object.freeze({ cpuKind: 'shared', cpus: 2, memoryMb: 2048 }) as ComputeTier,
  // Held at 4096 by Fly's performance-CPU minimum, not by choice.
  'enterprise-suite': Object.freeze({ cpuKind: 'performance', cpus: 2, memoryMb: 4096 }) as ComputeTier,
});

export function chooseComputeTier(input: CreateRunnerInput): ComputeTier {
  return DEFAULT_COMPUTE_TIER_BY_PLAN[input.tierId] ?? DEFAULT_COMPUTE_TIER_BY_PLAN.studio;
}
