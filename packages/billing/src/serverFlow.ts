// Shared checkout, portal and webhook orchestration for Worker and Next.js.
// Provider SDK construction stays in each runtime adapter.
import {
  createStripeBillingPortalSession,
  resolveVerifiedStripeWebhookEvent,
  hydrateTrialSubscriptionInvoice,
  scheduleSubscriptionDowngradeAtPeriodEnd,
  type StripeBillingClient,
  type StripeVerifiedWebhookEvent,
} from './index.js';
import { coordinatePurchase, purchaseStripeClientFromBilling, type PurchaseIntentStore } from './purchaseIntents.js';
import { ScheduledChangeConfirmationRequired, ScheduledChangeChanged } from './scheduledChange.js';
import { AGENT_PLAN, SIDEKICK_FREE_TRIAL, subscriptionAccessAllowed } from '@sidekick/shared';
import { getPlanTier, isPlanDowngrade, type PlanTierId, type StripeBillingDryRunResolution, type SubscriptionStatus } from '@sidekick/shared';
import { processStripeReversal, type StripeReversalInput, type StripeReversalTarget } from './stripeReversals.js';
import { isUsageTopUpSession, usageTopUpGrantFromSession, type UsageTopUpGrant } from './usageTopUp.js';

export interface StripeServerEnv {
  STRIPE_SECRET_KEY?: string | null;
  STRIPE_PORTAL_CONFIGURATION_ID?: string | null;
  STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID?: string | null;
  STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID?: string | null;
  STRIPE_WEBHOOK_SECRET?: string | null;
  SUPABASE_URL?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS?: string | null;
  /**
   * Series 4 — Option A volume retention window after cancellation. Days,
   * positive integer. Used by the Stripe webhook to compute the
   * volume_retention_until value when marking a user's runner sleeping.
   * Defaults to 30 when absent or invalid.
   */
  SIDEKICK_FLY_VOLUME_RETENTION_DAYS?: string | null;
}

export interface AuthenticatedCheckoutUser {
  id: string;
  email?: string | null;
}

export interface CheckoutSubscriptionState {
  paymentRequired?: boolean;
  currentPeriodEnd?: string | null;
  billingProvider?: string | null;
  serviceAccessUntil?: string | null;
  status?: SubscriptionStatus | null;
  tierId?: PlanTierId | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  priceId?: string | null;
}

export interface StripeCheckoutRouteDeps {
  purchaseIntentStore?: PurchaseIntentStore;
  env: StripeServerEnv;
  createStripeBillingClient(secretKey: string): StripeBillingClient;
  getAuthenticatedUser(token: string, env: StripeServerEnv): Promise<AuthenticatedCheckoutUser | null>;
  getCheckoutSubscription?(userId: string, token: string, env: StripeServerEnv): Promise<CheckoutSubscriptionState | null>;
  /**
   * Stripe-side reconciliation. Called when Supabase says inactive but
   * Stripe might still hold an active subscription tied to this email
   * (missed webhook). Implementations write the recovered state back
   * to Supabase and return it so the route can 409 with
   * `subscription_recovered`. Catches the Supabase↔Stripe drift class
   * that strands users on Stripe's "You're all done here" screen.
   */
  reconcileStripeSubscriptionByEmail?(input: {
    userId: string;
    email: string;
    env: StripeServerEnv;
  }): Promise<CheckoutSubscriptionState | null>;
  /**
   * True when the account is on the assistant engine, so its checkout is the
   * assistant plan (AGENT_PLAN: its own price and a free month). Omitted, every
   * checkout is a workspace plan, as before.
   */
  isAssistantPlanAccount?(userId: string): boolean | Promise<boolean>;
  now?: () => number;
}

export interface StripeBillingPortalRouteDeps {
  env: StripeServerEnv;
  createStripeBillingClient(secretKey: string): StripeBillingClient;
  getAuthenticatedUser(token: string, env: StripeServerEnv): Promise<AuthenticatedCheckoutUser | null>;
  getBillingPortalSubscription(userId: string, token: string, env: StripeServerEnv): Promise<CheckoutSubscriptionState | null>;
}

export interface StripeWebhookRouteDeps {
  retrieveStripeCharge?(id: string): Promise<Record<string, unknown>>;
  retrieveStripeDispute?(id: string): Promise<Record<string, unknown>>;
  retrieveStripeSubscription?(id: string): Promise<Record<string, unknown>>;
  listStripeInvoicePayments?(paymentIntentId: string, startingAfter?: string): Promise<{ data: unknown[]; has_more: boolean }>;
  retrieveStripeInvoice?(id: string): Promise<Record<string, unknown>>;
  env: StripeServerEnv;
  store: StripeBillingStore;
  verifyStripeWebhookEvent(rawBody: string, signature: string, webhookSecret: string): StripeVerifiedWebhookEvent | Promise<StripeVerifiedWebhookEvent>;
  /**
   * Cloudflare `ctx.waitUntil` bridge. When present, work scheduled through
   * it runs after the webhook response is returned (the resume-reattach fast
   * path). When absent (Node tests, legacy callers) the reattach is skipped
   * entirely: the cron sweep remains the safety net.
   */
  waitUntil?(promise: Promise<unknown>): void;
  fetchImpl?: typeof fetch;
  /**
   * Records a paid usage top-up (usageTopUp.ts), idempotent on the Checkout
   * session id. Absent, a top-up event fails retryably rather than being
   * dropped, so Stripe redelivers it once the store can take it.
   */
  recordUsageTopUp?(grant: UsageTopUpGrant): Promise<void>;
}

export interface StripeBillingEventInsert {
  provider: 'stripe';
  provider_event_id: string;
  event_type: string;
  idempotency_key: string;
  payload_hash: string;
  user_id?: string | null;
}

export interface StripeBillingEventRecord {
  id: string;
  provider: 'stripe';
  provider_event_id: string;
  event_type: string;
  idempotency_key: string;
  payload_hash: string | null;
  status: 'received' | 'processing' | 'processed' | 'ignored' | 'failed';
  user_id?: string | null;
  error_code?: string | null;
  processed_at?: string | null;
  processing_started_at?: string | null;
  processing_expires_at?: string | null;
}

export interface StripeBillingEventClaim {
  state: 'claimed' | 'duplicate_terminal' | 'busy' | 'payload_mismatch';
  event: StripeBillingEventRecord;
}

export interface StripeBillingEventUpdate {
  status: 'processed' | 'ignored' | 'failed';
  processed_at: string;
  error_code?: string | null;
  user_id?: string | null;
}

export interface StripeBillingStore {
  getStripeReversalTarget?(customerId: string, subscriptionId: string): Promise<StripeReversalTarget | null>;
  applyStripeReversal?(input: StripeReversalInput): Promise<'applied' | 'duplicate' | 'ignored_historical_subscription'>;
  applyEntitlement(input: AtomicStripeEntitlementInput): Promise<BillingEntitlementResult>;
  claimBillingEvent(input: StripeBillingEventInsert): Promise<StripeBillingEventClaim>;
  updateBillingEvent(id: string, patch: StripeBillingEventUpdate): Promise<void>;
  upsertSubscription(patch: SubscriptionPatchRecord): Promise<boolean>;
  upsertUsageQuota(patch: UsageQuotaPatchRecord): Promise<boolean>;
  enqueueHermesProvisioning(job: HermesProvisioningJobRecord): Promise<void>;
  /**
   * D10 — reverse-lookup the Sidekick user from a Stripe customer id.
   * Used when a webhook event lands with empty metadata (e.g. some
   * customer.subscription.created shapes) so we can still resolve the
   * user from our own ledger. Optional so legacy fakes need not
   * implement it.
   */
  findUserIdByStripeCustomer?(stripeCustomerId: string): Promise<string | null>;
  /**
   * Series 4 — Option A cancellation hook. Called when a Stripe webhook
   * resolves the user's subscription to a non-active terminal status
   * (canceled, unpaid, incomplete_expired). Wraps the
   * mark_hermes_runner_suspended RPC. Optional so existing test fakes
   * don't have to implement it.
   *
   * Returns true iff the user's runner row was flipped to sleeping.
   */
  markSeries4RunnerSuspended?(input: { userId: string; retentionSeconds: number; publicStatusMessage: string }): Promise<boolean>;
  /**
   * Series 4 — when a previously-cancelled subscription becomes active
   * again (renewal), call mark_hermes_runner_resumed so the sleeping
   * runner is requeued for re-provisioning.
   */
  markSeries4RunnerResumed?(input: { userId: string; publicStatusMessage: string }): Promise<boolean>;
  /**
   * Resume-reattach (2026-07-30 defect: resubscribe left the runner stuck on
   * "Preparing workspace" for hours). A resumed user still has their private
   * binding — keeping the volume is the whole point of Option A — but
   * claim_next_hermes_provisioning_job EXCLUDES users with a live binding, so
   * the 'provisioning' row set by mark_hermes_runner_resumed is unclaimable by
   * the normal provisioning cron. There is nothing to provision: the Machine
   * still exists and Fly autostart wakes it on the first /healthz. These two
   * methods let the webhook reattach in place.
   *
   * Returns the runner base URL iff the user has a non-deleted private
   * binding AND their hermes_instances row is currently 'provisioning'.
   */
  getResumedRunnerReattachTarget?(userId: string): Promise<string | null>;
  /**
   * Flip the still-'provisioning' row straight to ready. Guarded on
   * status='provisioning' so it can never clobber a row another path
   * (provisioner cron, reimage) has since moved on. Returns whether a row
   * actually flipped.
   */
  promoteResumedRunnerReady?(userId: string, runnerBaseUrl: string): Promise<boolean>;
  /**
   * R-OBS-04 — write an audit row to provisioning_events when a webhook
   * resolved as "should prepare a coworker" but the storage upserts did
   * not both land. Lets operators trace silent-skip scenarios via
   * `wrangler tail` + a Supabase SELECT. Optional so test fakes don't
   * have to implement it.
   */
  recordProvisioningEvent?(input: {
    userId: string;
    event: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Stripe statuses that should trigger Option A suspension (Series 4).
 * 'past_due' is intentionally NOT here — past_due retains entitlement so
 * the user can recover via a retry; we keep their Machine running. The
 * shared SubscriptionStatus model collapses unpaid/incomplete_expired
 * into 'canceled', so a single status check is enough.
 */
export function shouldSuspendSeries4Runner(status: SubscriptionStatus | null | undefined): boolean {
  return status === 'canceled';
}

export interface ResumeReattachOptions {
  /**
   * Max healthz attempts. Defaults keep the worst case near the ~30s
   * post-response waitUntil budget; if the runtime cuts an overrun short the
   * cron sweep (sweepStuckResumedRunners) promotes the row instead.
   */
  attempts?: number;
  /** Delay between attempts in ms. Default 2000. */
  intervalMs?: number;
  /** Per-probe timeout in ms. Default 2000. */
  probeTimeoutMs?: number;
  sleep?(ms: number): Promise<void>;
}

export type ResumeReattachResult = 'promoted' | 'no_target' | 'unready';

/**
 * Fast path for the resubscribe flow: the runner Machine still exists (the
 * volume was retained while sleeping), so instead of waiting for the stuck-
 * readiness cron (30-min age gate + hourly-ish GH Actions cadence — the
 * "8 minutes and counting" Alex saw was on its way to hours), probe the
 * runner's /healthz until Fly autostart brings it up, then flip the row to
 * ready in place. Never throws: callers run this via ctx.waitUntil and the
 * cron sweep remains the safety net for anything this misses.
 */
export async function reattachResumedSeries4Runner(
  store: StripeBillingStore,
  userId: string,
  fetchImpl: typeof fetch,
  options: ResumeReattachOptions = {},
): Promise<ResumeReattachResult> {
  if (typeof store.getResumedRunnerReattachTarget !== 'function' || typeof store.promoteResumedRunnerReady !== 'function') {
    return 'no_target';
  }
  let runnerBaseUrl: string | null = null;
  try {
    runnerBaseUrl = await store.getResumedRunnerReattachTarget(userId);
  } catch {
    return 'no_target';
  }
  if (!runnerBaseUrl) return 'no_target';

  let probeUrl: string;
  try {
    const parsed = new URL(runnerBaseUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return 'no_target';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/healthz`.replace(/\/+/g, '/');
    probeUrl = parsed.toString();
  } catch {
    return 'no_target';
  }

  const attempts = Math.max(1, options.attempts ?? 8);
  const intervalMs = Math.max(0, options.intervalMs ?? 2000);
  const probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? 2000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    // The first probe against a stopped Machine is what triggers Fly
    // autostart; later attempts give the boot time to finish.
    if (attempt > 0) await sleep(intervalMs);
    let healthy = false;
    try {
      const response = await fetchImpl(probeUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { ok?: unknown; hermesApiServerAvailable?: unknown } | null;
        healthy = body?.ok === true && body?.hermesApiServerAvailable !== false;
      }
    } catch {
      healthy = false;
    }
    if (healthy) {
      try {
        return (await store.promoteResumedRunnerReady(userId, runnerBaseUrl)) ? 'promoted' : 'no_target';
      } catch {
        return 'unready';
      }
    }
  }
  return 'unready';
}

/**
 * Days the Fly volume + app are retained after Option A suspension before
 * the daily grace-expiry script force-destroys them. Operator can override
 * via SIDEKICK_FLY_VOLUME_RETENTION_DAYS.
 *
 * The default is 60, and it has to be the SAME 60 as
 * resolveFlyVolumeRetentionSeconds in packages/provisioner (raised from 30 on
 * 2026-08-04, Alex's call). Until 2026-09-03 this said 30 while the
 * provisioner said 60, and stripeServerEnvFromWorker never passed the env var
 * through, so every cancellation that arrived by Stripe webhook was given a
 * 30-day window and one that the daily dunning sweep caught got 60: the same
 * customer's files were deleted on two different schedules depending on which
 * path noticed them lapse first.
 */
export function resolveSeries4SuspendRetentionSeconds(env: StripeServerEnv): number {
  const raw = nonEmptyString(env.SIDEKICK_FLY_VOLUME_RETENTION_DAYS) ?? '';
  const parsed = Number.parseInt(raw, 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return days * 24 * 60 * 60;
}

// D10 — pull the Stripe customer id off any webhook event shape we know.
// Used when the resolver couldn't find sidekickUserId in metadata; we then
// look the user up by customer id in our own subscriptions ledger.
function extractStripeCustomerIdLoose(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const object = (data as { object?: unknown }).object;
  if (!object || typeof object !== 'object') return null;
  const direct = (object as { customer?: unknown }).customer;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (direct && typeof direct === 'object') {
    const nested = (direct as { id?: unknown }).id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  // Some shapes nest the customer on a sub-object.
  const sub = (object as { subscription?: unknown }).subscription;
  if (sub && typeof sub === 'object') {
    const subCust = (sub as { customer?: unknown }).customer;
    if (typeof subCust === 'string' && subCust.length > 0) return subCust;
  }
  return null;
}

// D10 — clone the event and stamp `sidekickUserId` into the subscription
// (or session) metadata so resolveVerifiedStripeWebhookEvent can pick it
// up on a re-resolve. We do NOT mutate the original event object so a
// caller holding a reference doesn't see unexpected shape changes.
function injectSidekickUserId(event: unknown, userId: string): unknown {
  if (!event || typeof event !== 'object') return event;
  const cloned = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  const data = cloned.data && typeof cloned.data === 'object' ? cloned.data as Record<string, unknown> : null;
  if (!data) return event;
  const object = data.object && typeof data.object === 'object' ? data.object as Record<string, unknown> : null;
  if (!object) return event;
  const meta = (object.metadata && typeof object.metadata === 'object'
    ? object.metadata
    : (object.metadata = {})) as Record<string, unknown>;
  meta.sidekickUserId = userId;
  // For checkout.session.completed the resolver also looks at
  // client_reference_id; set it too as belt-and-braces.
  if (typeof object.client_reference_id !== 'string') {
    object.client_reference_id = userId;
  }
  return cloned;
}

export interface SubscriptionPatchRecord {
  user_id: string;
  status: SubscriptionStatus;
  tier_id: PlanTierId;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  price_id?: string;
  stripe_entitlement_invoice_id?: string;
  purchase_intent_id?: string;
  current_period_start?: string;
  current_period_end?: string;
  cancel_at_period_end?: boolean;
  updated_at: string;
  provider_updated_at: string;
}

export interface AtomicStripeEntitlementInput {
  subscription: SubscriptionPatchRecord;
  quota: UsageQuotaPatchRecord;
  eventKey: string;
  allowProviderSwitch: boolean;
  retentionSeconds: number;
}

export interface BillingEntitlementResult {
  outcome: 'applied' | 'duplicate' | 'ignored_stale' | 'ignored_historical' | 'ignored_reversed_payment' | 'provider_conflict' | 'activation_pending' | 'purchase_conflict';
  resumed: boolean;
}

export function parseBillingEntitlementResult(value: unknown): BillingEntitlementResult {
  const row = recordOrNull(value);
  if (!row || !['applied','duplicate','ignored_stale','ignored_historical','ignored_reversed_payment','provider_conflict','activation_pending','purchase_conflict'].includes(String(row.outcome))
    || typeof row.resumed !== 'boolean') throw new Error('billing_entitlement_result_invalid');
  return row as unknown as BillingEntitlementResult;
}

export interface UsageQuotaPatchRecord {
  user_id: string;
  tier_id: PlanTierId;
  monthly_token_quota: number;
  /**
   * Per-tier storage cap in bytes. Added by Batch 4b of
   * AGENT_TODO_CHECKLIST §2.5.4 so a tier change writes the new storage
   * cap alongside the token quota — without this, an upgrade from Studio
   * to Pro Office would raise the token cap but leave the storage cap
   * at the old 10 GB default until the next 0026-style migration ran.
   */
  storage_quota_bytes: number;
  /**
   * Per-tier voice-transcription cap in seconds (matches the schema's
   * voice_seconds_quota column added in migration 0026). Same rationale
   * as storage_quota_bytes above — written on every tier change so the
   * cap travels with the tier.
   */
  voice_seconds_quota: number;
  updated_at: string;
  provider_updated_at: string;
}

export interface HermesProvisioningJobRecord {
  user_id: string;
  tier_id: PlanTierId;
  billing_event_id: string;
  provider_event_id: string;
  idempotency_key: string;
  requested_at: string;
  public_status_message: string;
}

interface ReadinessResult {
  ok: boolean;
  missing: string[];
}

export async function handleStripeCheckoutRequest(request: Request, deps: StripeCheckoutRouteDeps): Promise<Response> {
  const readiness = resolveReadiness(deps.env, [
    'STRIPE_SECRET_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  if (!readiness.ok) return safeJson({ error: 'stripe_checkout_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  let user: AuthenticatedCheckoutUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return safeJson({ error: 'unauthenticated' }, 401);
  }

  if (!user || !isUuid(user.id)) return safeJson({ error: 'unauthenticated' }, 401);

  const body = await readJsonObject(request);
  if (!body) return safeJson({ error: 'invalid_checkout_request' }, 400);

  // The assistant plan is decided by the server from the account, never by the
  // request: an account on it can only buy it, and nobody else can.
  const assistantPlan = deps.isAssistantPlanAccount ? await deps.isAssistantPlanAccount(user.id) : false;
  const tierId = assistantPlan ? AGENT_PLAN.tierId : parsePlanTierId(body.tierId);
  if (!tierId) return safeJson({ error: 'unknown_tier' }, 400);

  const successUrl = requireAllowedCheckoutRedirectUrl(body.successUrl, deps.env);
  const cancelUrl = requireAllowedCheckoutRedirectUrl(body.cancelUrl, deps.env);
  if (!successUrl || !cancelUrl) return safeJson({ error: 'invalid_redirect_url' }, 400);

  let checkoutSubscription: CheckoutSubscriptionState | null = null;
  if (deps.getCheckoutSubscription) {
    try {
      checkoutSubscription = await deps.getCheckoutSubscription(user.id, token, deps.env);
    } catch {
      return safeJson({ error: 'subscription_state_unavailable' }, 503);
    }
  }

  if (subscriptionAccessAllowed(checkoutSubscription?.status, checkoutSubscription?.currentPeriodEnd,
    deps.now?.() ?? Date.now(), checkoutSubscription?.billingProvider, checkoutSubscription?.serviceAccessUntil)) {
    const currentTierId = checkoutSubscription?.tierId ?? null;
    if (currentTierId && currentTierId !== tierId) {
      return safeJson({ error: 'subscription_change_required', currentTierId, requestedTierId: tierId }, 409);
    }
    return safeJson({ error: 'subscription_already_active', currentTierId, requestedTierId: tierId }, 409);
  }

  // Supabase ↔ Stripe drift recovery: if our DB says inactive but
  // Stripe holds an active subscription for this user (missed webhook),
  // repair Supabase before opening Checkout. Without this the user
  // lands on Stripe's "You're all done here" screen because Stripe
  // refuses to create a duplicate subscription on the same customer.
  // Diagnosed 2026-05-21 emulator test.
  if (deps.reconcileStripeSubscriptionByEmail && user.email) {
    try {
      const recovered = await deps.reconcileStripeSubscriptionByEmail({
        userId: user.id,
        email: user.email,
        env: deps.env,
      });
      if (recovered?.paymentRequired) {
        return safeJson({ error: 'subscription_payment_required', currentTierId: recovered.tierId, requestedTierId: tierId }, 409);
      }
      if (recovered && isProviderBackedEntitlementStatus(recovered.status)) {
        const recoveredTier = recovered.tierId ?? null;
        if (recoveredTier && recoveredTier !== tierId) {
          return safeJson({
            error: 'subscription_change_required',
            currentTierId: recoveredTier,
            requestedTierId: tierId,
            recovered: true,
          }, 409);
        }
        return safeJson({
          error: 'subscription_recovered',
          currentTierId: recoveredTier,
          requestedTierId: tierId,
          recovered: true,
        }, 409);
      }
    } catch {
      // Unknown provider state must not open another paid subscription.
      return safeJson({ error: 'subscription_state_unavailable' }, 503);
    }
  }

  let sessionUrl: string;
  try {
    if (!deps.purchaseIntentStore) return safeJson({ error: 'purchase_coordination_unavailable' }, 503);
    const checkout = await coordinatePurchase({
      userId: user.id, provider: 'stripe', tierId,
      customerEmail: nonEmptyString(user.email),
      existingStripeCustomerId: nonEmptyString(checkoutSubscription?.stripeCustomerId),
      successUrl, cancelUrl,
      ...(assistantPlan ? { plan: 'assistant' as const } : {}),
    }, deps.purchaseIntentStore, purchaseStripeClientFromBilling(deps.createStripeBillingClient(deps.env.STRIPE_SECRET_KEY!)), deps.now);
    if (checkout.kind !== 'checkout') {
      const error = checkout.kind === 'already_entitled' ? 'subscription_already_active'
        : checkout.kind === 'reconciliation_required' ? 'purchase_requires_review'
        : checkout.kind === 'payment_pending' ? 'subscription_payment_pending' : 'purchase_pending';
      return safeJson({ error }, checkout.kind === 'busy' ? 503 : 409);
    }
    sessionUrl = checkout.url;
  } catch {
    // PREOP-C05 — a Stripe session-creation failure is an upstream-dependency
    // outage, not a gateway error. Use 503 (temporary, retry) to match the
    // rest of this file (subscription_state_unavailable etc.) instead of 502.
    // The mobile client echoes the status into the user-facing diagnostic
    // suffix; a bare "502" reads to users as a hard infra failure, whereas 503
    // correctly signals "try again in a moment". Always structured JSON, never
    // a raw passthrough.
    return safeJson({ error: 'stripe_checkout_failed' }, 503);
  }

  if (!isStripeCheckoutUrl(sessionUrl)) return safeJson({ error: 'stripe_checkout_failed' }, 503);

  return externalCheckoutUrlResponse(request, sessionUrl);
}

/**
 * Read the user's consumed storage (bytes) from usage_quotas via the service
 * role, for the downgrade storage gate. Unknown usage is retryable and must
 * never authorize a lower storage allowance.
 */
async function fetchConsumedStorageBytes(env: StripeServerEnv, userId: string): Promise<number | null> {
  const url = nonEmptyString(env.SUPABASE_URL);
  const key = nonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/usage_quotas?user_id=eq.${encodeURIComponent(userId)}&select=consumed_storage_bytes`,
      { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const row = rows[0];
    const raw = row && typeof row === 'object' ? (row as Record<string, unknown>).consumed_storage_bytes : null;
    // PostgREST can represent bigint as a decimal string. Do not coerce null,
    // booleans, empty strings or malformed counters into a successful zero.
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export async function handleStripeBillingPortalRequest(request: Request, deps: StripeBillingPortalRouteDeps): Promise<Response> {
  const readiness = resolveReadiness(deps.env, [
    'STRIPE_SECRET_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  if (!readiness.ok) return safeJson({ error: 'stripe_billing_portal_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  let user: AuthenticatedCheckoutUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return safeJson({ error: 'unauthenticated' }, 401);
  }

  if (!user || !isUuid(user.id)) return safeJson({ error: 'unauthenticated' }, 401);

  const body = await readJsonObject(request);
  if (!body) return safeJson({ error: 'invalid_billing_portal_request' }, 400);

  const returnUrl = requireAllowedCheckoutRedirectUrl(body.returnUrl, deps.env);
  if (!returnUrl) return safeJson({ error: 'invalid_return_url' }, 400);
  const rawTargetTierId = body.targetTierId;
  const targetTierId = rawTargetTierId === null || rawTargetTierId === undefined ? null : parsePlanTierId(rawTargetTierId);
  if (rawTargetTierId !== null && rawTargetTierId !== undefined && !targetTierId) return safeJson({ error: 'unknown_tier' }, 400);

  let subscription: CheckoutSubscriptionState | null;
  try {
    subscription = await deps.getBillingPortalSubscription(user.id, token, deps.env);
  } catch {
    return safeJson({ error: 'billing_state_unavailable' }, 503);
  }

  const stripeCustomerId = nonEmptyString(subscription?.stripeCustomerId);
  if (!stripeCustomerId) return safeJson({ error: 'billing_customer_required' }, 409);
  const currentTierId = subscription?.tierId ?? null;
  const targetTierRequiresSubscriptionUpdate = Boolean(targetTierId && targetTierId !== currentTierId);
  // An acknowledgement from a previous account/plan must never enter the
  // ordinary portal or downgrade branches after the client changed accounts.
  if (body.scheduledChangeConfirmation !== undefined && body.scheduledChangeConfirmation !== null
    && (!targetTierRequiresSubscriptionUpdate || !currentTierId || !targetTierId || isPlanDowngrade(currentTierId, targetTierId))) {
    return safeJson({ error: 'billing_scheduled_change_changed' }, 409);
  }
  const stripeSubscriptionId = nonEmptyString(subscription?.stripeSubscriptionId);
  if (targetTierRequiresSubscriptionUpdate && !isProviderBackedEntitlementStatus(subscription?.status)) {
    return safeJson({ error: 'billing_subscription_required' }, 409);
  }
  if (targetTierRequiresSubscriptionUpdate && !stripeSubscriptionId) {
    return safeJson({ error: 'billing_subscription_required' }, 409);
  }

  const billingClient = deps.createStripeBillingClient(deps.env.STRIPE_SECRET_KEY!);

  // DOWNGRADES defer to the end of the paid period. The user keeps every part of
  // their paid tier (compute, token/voice/storage caps) until renewal, then it
  // steps down together — no mid-cycle lockout. UPGRADES still apply immediately
  // (the portal path below). See docs/BILLING downgrade-timing.
  if (
    targetTierRequiresSubscriptionUpdate &&
    targetTierId &&
    currentTierId &&
    stripeSubscriptionId &&
    isPlanDowngrade(currentTierId, targetTierId)
  ) {
    // Storage gate (option 1): block a downgrade while the user is over the
    // target plan's storage allowance. We never auto-shrink or delete their
    // files. Unknown usage must be retried before scheduling a smaller plan.
    const targetStorageBytes = getPlanTier(targetTierId).storageGb * 1024 * 1024 * 1024;
    const consumedStorageBytes = await fetchConsumedStorageBytes(deps.env, user.id);
    if (consumedStorageBytes === null) return safeJson({ error: 'billing_storage_unavailable' }, 503);
    if (consumedStorageBytes > targetStorageBytes) {
      return safeJson(
        {
          error: 'downgrade_storage_over_limit',
          targetTierId,
          currentTierId,
          currentStorageBytes: consumedStorageBytes,
          targetStorageBytes,
        },
        409,
      );
    }
    try {
      const scheduled = await scheduleSubscriptionDowngradeAtPeriodEnd(
        {
          currentSubscriptionId: stripeSubscriptionId,
          currentPriceId: nonEmptyString(subscription?.priceId),
          targetTierId,
        },
        billingClient,
      );
      return safeJson(
        {
          scheduled: true,
          targetTierId,
          currentTierId,
          effectiveAt: new Date(scheduled.effectiveAt * 1000).toISOString(),
        },
        200,
      );
    } catch (err) {
      console.error(
        `[stripe] schedule downgrade failed userId=${user.id} target=${targetTierId} detail=${err instanceof Error ? err.message : String(err)}`,
      );
      return safeJson({ error: 'stripe_downgrade_schedule_failed' }, 503);
    }
  }

  let portalUrl: string;
  try {
    const portal = await createStripeBillingPortalSession(
      {
        scheduledChangeContext: { userId: user.id, secretKey: deps.env.STRIPE_SECRET_KEY!, confirmation: body.scheduledChangeConfirmation },
        configurationId: nonEmptyString(targetTierRequiresSubscriptionUpdate
          ? targetTierId === 'pro-office' ? deps.env.STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID
            : targetTierId === 'enterprise-suite' ? deps.env.STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID : null
          : deps.env.STRIPE_PORTAL_CONFIGURATION_ID) ?? '',
        livemode: deps.env.STRIPE_SECRET_KEY!.startsWith('sk_live_'),
        currentTierId,
        customerId: stripeCustomerId,
        returnUrl,
        targetTierId: targetTierRequiresSubscriptionUpdate ? targetTierId : null,
        currentSubscriptionId: targetTierRequiresSubscriptionUpdate ? stripeSubscriptionId : null,
        currentPriceId: targetTierRequiresSubscriptionUpdate ? nonEmptyString(subscription?.priceId) : null,
      },
      billingClient,
    );
    portalUrl = portal.url;
  } catch (err) {
    if (err instanceof ScheduledChangeConfirmationRequired) {
      return safeJson({ error: 'billing_scheduled_change_confirmation_required', confirmation: err.confirmation }, 409);
    }
    if (err instanceof ScheduledChangeChanged) return safeJson({ error: 'billing_scheduled_change_changed' }, 409);
    // PREOP-C05 — see checkout path above. A Stripe billing-portal creation
    // failure is a temporary upstream outage (503), not a bare gateway 502.
    // 2026-07-14: log Stripe's actual words server-side (the live
    // portal-config upgrade outage was invisible without this); the user
    // copy stays generic.
    console.error(`[stripe] billing portal session failed userId=${user.id} targetTier=${targetTierId ?? 'none'} detail=${err instanceof Error ? err.message : String(err)}`);
    return safeJson({ error: 'stripe_billing_portal_failed' }, 503);
  }

  if (!isStripeBillingPortalUrl(portalUrl)) return safeJson({ error: 'stripe_billing_portal_failed' }, 503);

  return externalCheckoutUrlResponse(request, portalUrl);
}

export async function handleStripeWebhookRequest(request: Request, deps: StripeWebhookRouteDeps): Promise<Response> {
  const readiness = resolveReadiness(deps.env, ['STRIPE_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'stripe_webhook_unavailable', missing: readiness.missing }, 503);

  const signature = nonEmptyString(request.headers.get('stripe-signature'));
  if (!signature) return safeJson({ error: 'missing_stripe_signature' }, 400);

  const rawBody = await request.text();
  let event: StripeVerifiedWebhookEvent;
  try {
    event = await deps.verifyStripeWebhookEvent(rawBody, signature, deps.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return safeJson({ error: 'invalid_stripe_signature' }, 400);
  }

  const eventId = nonEmptyString((event as { id?: unknown }).id);
  const eventType = nonEmptyString((event as { type?: unknown }).type);
  if (!eventId || !eventType) return safeJson({ error: 'invalid_stripe_event' }, 400);

  const payloadHash = await sha256Hex(rawBody);
  try {
    event = await hydrateTrialSubscriptionInvoice(event, deps.retrieveStripeInvoice);
  } catch {
    return safeJson({ error: 'trial_invoice_verification_unavailable' }, 503);
  }
  let resolution = resolveVerifiedStripeWebhookEvent(event);
  const eventObject = (event as { data?: { object?: unknown } }).data?.object;
  // A top-up is a one-off payment, not a subscription: it never reaches the
  // subscription resolver below or the owner recovery beside it.
  const usageTopUp = eventType === 'checkout.session.completed' && isUsageTopUpSession(eventObject);

  // D10 — Stripe delivers customer.subscription.created with empty
  // metadata in some paths (we saw this with a Checkout-mode session
  // on 2026-05-20: subscription_data.metadata not propagated to the
  // resulting subscription object). The default resolver gives up with
  // missing_user. Recover by looking the userId up via the Stripe
  // customer id in our own subscriptions ledger — that row gets seeded
  // when the Checkout session is created so the customer→user mapping
  // is already known.
  if (!usageTopUp && resolution.kind === 'ignored' && resolution.reason === 'missing_user') {
    const customerId = extractStripeCustomerIdLoose(event);
    if (customerId) {
      let recoveredUserId: string | null;
      try { recoveredUserId = await deps.store.findUserIdByStripeCustomer?.(customerId) ?? null; }
      catch { return safeJson({ error: 'billing_owner_lookup_unavailable' }, 503); }
      if (recoveredUserId) {
        const augmented = injectSidekickUserId(event, recoveredUserId) as StripeVerifiedWebhookEvent;
        resolution = resolveVerifiedStripeWebhookEvent(augmented);
      }
    }
  }

  const ledgerUserId = resolution.kind === 'subscription_patch' ? resolution.subscription.userId : null;

  let claim: StripeBillingEventClaim;
  try {
    claim = await deps.store.claimBillingEvent({
      provider: 'stripe',
      provider_event_id: eventId,
      event_type: eventType,
      idempotency_key: `stripe:${eventId}`,
      payload_hash: payloadHash,
      user_id: ledgerUserId,
    });
  } catch {
    return safeJson({ error: 'billing_event_record_failed' }, 500);
  }

  if (claim.state === 'payload_mismatch') {
    return safeJson({ error: 'billing_event_payload_mismatch' }, 409);
  }
  if (claim.state === 'duplicate_terminal') {
    return safeJson({ received: true, duplicate: true }, 200);
  }
  if (claim.state === 'busy') {
    return safeJson({ error: 'stripe_webhook_retryable_failure' }, 500);
  }

  const ledger = claim.event;

  const processedAt = new Date().toISOString();
  try {
    if (usageTopUp) {
      const created = (event as { created?: unknown }).created;
      const occurredAt = typeof created === 'number' ? new Date(created * 1000).toISOString() : processedAt;
      const grant = usageTopUpGrantFromSession(eventObject, occurredAt);
      if (!grant) {
        await deps.store.updateBillingEvent(ledger.id, { status: 'ignored', processed_at: processedAt, error_code: 'usage_top_up_not_payable' });
        return safeJson({ received: true, ignored: 'usage_top_up_not_payable' }, 200);
      }
      if (!deps.recordUsageTopUp) throw new Error('usage_top_up_store_unavailable');
      await deps.recordUsageTopUp(grant);
      await deps.store.updateBillingEvent(ledger.id, { status: 'processed', processed_at: processedAt, user_id: grant.userId, error_code: null });
      return safeJson({ received: true, note: 'usage_top_up' }, 200);
    }
    if (eventType === 'charge.refunded' || eventType === 'charge.dispute.created') {
      const reversal = await processStripeReversal(event, deps, resolveSeries4SuspendRetentionSeconds(deps.env));
      await deps.store.updateBillingEvent(ledger.id, {
        status: reversal.outcome.startsWith('ignored_') ? 'ignored' : 'processed',
        processed_at: processedAt, user_id: reversal.userId ?? null, error_code: reversal.outcome,
      });
      return safeJson({ received: true, note: reversal.outcome }, 200);
    }
    if (resolution.kind === 'ignored') {
      await deps.store.updateBillingEvent(ledger.id, {
        status: 'ignored',
        processed_at: processedAt,
        error_code: resolution.reason,
      });
      return safeJson({ received: true, ignored: resolution.reason }, 200);
    }

    const result = await deps.store.applyEntitlement({
      subscription: { ...toSubscriptionPatchRecord(resolution), ...verifiedInvoicePatch(event), ...verifiedPurchaseIntentPatch(event) },
      quota: toUsageQuotaPatchRecord(resolution),
      eventKey: `stripe:${eventId}`,
      allowProviderSwitch: eventType === 'checkout.session.completed',
      retentionSeconds: resolveSeries4SuspendRetentionSeconds(deps.env),
    });
    if (result.outcome === 'provider_conflict' || result.outcome === 'activation_pending' || result.outcome === 'purchase_conflict') {
      throw new Error(`billing_${result.outcome}`);
    }
    if (result.resumed && typeof deps.waitUntil === 'function') {
      deps.waitUntil(reattachResumedSeries4Runner(
        deps.store, resolution.subscription.userId, deps.fetchImpl ?? fetch,
      ).catch(() => undefined));
    }
    const ignored = result.outcome.startsWith('ignored_');
    await deps.store.updateBillingEvent(ledger.id, {
      status: ignored ? 'ignored' : 'processed',
      processed_at: processedAt,
      user_id: resolution.subscription.userId,
      error_code: ignored ? result.outcome : null,
    });
    return safeJson({ received: true }, 200);
  } catch (error) {
    await markLedgerFailedBestEffort(deps.store, ledger.id, processedAt, sanitizeErrorCode(error));
    return safeJson({ error: 'stripe_webhook_retryable_failure' }, 500);
  }
}

export function createSupabaseAuthResolver(authClient: {
  auth: {
    getUser(token: string): Promise<{ data?: { user?: { id?: string; email?: string | null } | null } | null; error?: unknown }>;
  };
}) {
  return async function getAuthenticatedUser(token: string): Promise<AuthenticatedCheckoutUser | null> {
    const result = await authClient.auth.getUser(token);
    if (result.error || !result.data?.user?.id) return null;
    return {
      id: result.data.user.id,
      email: result.data.user.email ?? null,
    };
  };
}

const BILLING_EVENT_SELECT = 'id, provider, provider_event_id, event_type, idempotency_key, payload_hash, status, user_id, error_code, processed_at, processing_started_at, processing_expires_at';
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;

function processingLeaseWindow(nowMs = Date.now()): { startedAt: string; expiresAt: string } {
  return {
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + WEBHOOK_PROCESSING_LEASE_MS).toISOString(),
  };
}

function processingLeaseExpired(event: StripeBillingEventRecord, nowIso: string): boolean {
  const expiresAt = nonEmptyString(event.processing_expires_at);
  if (!expiresAt) return true;
  return expiresAt <= nowIso;
}

export function createSupabaseStripeBillingStore(client: {
  from(table: string): any;
  // Series 4 — mark_hermes_runner_* RPCs are called via the underlying
  // Supabase REST `/rpc/<name>` endpoint. Optional so existing test fakes
  // for createSupabaseStripeBillingStore stay valid. Typed as `any` so the
  // supabase-js PostgrestFilterBuilder thenable shape lines up with both
  // its real return (a thenable) and a test-fake plain Promise.
  rpc?: (name: string, args: Record<string, unknown>) => any;
}): StripeBillingStore {
  return {
    async getStripeReversalTarget(customerId, subscriptionId) {
      const owner = await client.from('billing_subscription_ownership').select('user_id,provider_customer_id')
        .eq('provider','stripe').eq('provider_subscription_id',subscriptionId).maybeSingle();
      if (owner.error) throw new Error('reversal_owner_lookup_failed');
      if (!owner.data) throw new Error('reversal_owner_not_yet_recorded');
      if (owner.data.user_id === null) return null;
      if (typeof owner.data.user_id !== 'string' || owner.data.provider_customer_id !== customerId) throw new Error('reversal_owner_mismatch');
      const current = await client.from('subscriptions')
        .select('billing_provider,stripe_subscription_id,stripe_customer_id,current_period_start,current_period_end,stripe_entitlement_invoice_id,billing_revision')
        .eq('user_id',owner.data.user_id).maybeSingle();
      if (current.error) throw new Error('reversal_subscription_lookup_failed');
      const value = current.data;
      if (!value) throw new Error('reversal_subscription_not_yet_recorded');
      if (value.billing_provider !== 'stripe' || value.stripe_subscription_id !== subscriptionId) return null;
      if (value.stripe_customer_id !== customerId || !Number.isSafeInteger(value.billing_revision)
        || typeof value.current_period_start !== 'string' || typeof value.current_period_end !== 'string') throw new Error('reversal_subscription_invalid');
      return { userId: owner.data.user_id, revision: value.billing_revision, periodStart: value.current_period_start,
        periodEnd: value.current_period_end, invoiceId: nonEmptyString(value.stripe_entitlement_invoice_id) };
    },
    async applyStripeReversal(input) {
      if (!client.rpc) throw new Error('reversal_rpc_unavailable');
      const result = await client.rpc('apply_stripe_payment_reversal', {
        p_user_id: input.userId, p_customer_id: input.customerId, p_subscription_id: input.subscriptionId,
        p_invoice_id: input.invoiceId, p_charge_id: input.chargeId, p_expected_revision: input.revision,
        p_period_start: input.periodStart, p_period_end: input.periodEnd, p_event_key: input.eventKey,
        p_event_at: input.eventAt, p_reason: input.reason, p_retention_seconds: input.retentionSeconds,
      });
      if (result.error) throw upsertFailureError('reversal_apply_failed', result.error);
      if (!['applied','duplicate','ignored_historical_subscription'].includes(result.data)) throw new Error('reversal_result_invalid');
      return result.data;
    },
    async applyEntitlement(input) {
      if (typeof client.rpc !== 'function') throw new Error('billing_entitlement_rpc_unavailable');
      const result = await client.rpc('apply_billing_entitlement', {
        p_provider: 'stripe', p_subscription: input.subscription, p_quota: input.quota,
        p_event_key: input.eventKey, p_allow_provider_switch: input.allowProviderSwitch,
        p_retention_seconds: input.retentionSeconds,
      });
      if (result.error) throw upsertFailureError('billing_entitlement_apply_failed', result.error);
      return parseBillingEntitlementResult(result.data);
    },
    async claimBillingEvent(input) {
      const lease = processingLeaseWindow();
      const row = {
        ...input,
        status: 'processing' as const,
        processing_started_at: lease.startedAt,
        processing_expires_at: lease.expiresAt,
      };
      const inserted = await client
        .from('billing_events')
        .insert(row)
        .select(BILLING_EVENT_SELECT)
        .single();

      if (!inserted.error) return { state: 'claimed' as const, event: toBillingEventRecord(inserted.data) };
      if (!isUniqueViolation(inserted.error)) throw new Error('billing_event_insert_failed');

      const existing = await client
        .from('billing_events')
        .select(BILLING_EVENT_SELECT)
        .eq('provider', 'stripe')
        .eq('provider_event_id', input.provider_event_id)
        .maybeSingle();

      if (existing.error || !existing.data) throw new Error('billing_event_lookup_failed');
      const event = toBillingEventRecord(existing.data);
      if (event.payload_hash && event.payload_hash !== input.payload_hash) {
        return { state: 'payload_mismatch' as const, event };
      }
      if (event.status === 'processed' || event.status === 'ignored') {
        return { state: 'duplicate_terminal' as const, event };
      }
      if (event.status === 'processing' && !processingLeaseExpired(event, lease.startedAt)) {
        return { state: 'busy' as const, event };
      }

      const claimed = await claimExistingBillingEvent(client, event, input, lease);
      return claimed ? { state: 'claimed' as const, event: claimed } : { state: 'busy' as const, event };
    },

    async updateBillingEvent(id, patch) {
      const result = await client
        .from('billing_events')
        .update({ ...patch, processing_started_at: null, processing_expires_at: null })
        .eq('id', id);
      if (result.error) throw new Error('billing_event_update_failed');
    },

    async upsertSubscription(patch) {
      return insertOrUpdateFreshRow(client, 'subscriptions', patch, 'subscription_upsert_failed');
    },

    async findUserIdByStripeCustomer(stripeCustomerId) {
      // Retain ownership after switching providers. Multiple subscriptions on
      // the same customer are valid only when every row has the same owner.
      const ownership = await client.from('billing_subscription_ownership')
        .select('user_id').eq('provider', 'stripe')
        .eq('provider_customer_id', stripeCustomerId);
      if (ownership.error || !Array.isArray(ownership.data)) throw new Error('billing_owner_lookup_failed');
      if (ownership.data.length) {
        const owners = new Set(ownership.data.map((row: { user_id?: unknown }) => row.user_id));
        if (owners.size !== 1) throw new Error('billing_owner_ambiguous');
        const owner = [...owners][0];
        if (owner === null) return null; // Deleted owners cannot be reassigned.
        if (typeof owner !== 'string' || !owner) throw new Error('billing_owner_invalid');
        return owner;
      }
      // A newly opened checkout may seed the customer before the first
      // subscription event arrives and creates its immutable ownership row.
      const row = await client
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', stripeCustomerId)
        .limit(1)
        .maybeSingle();
      if (row.error) throw new Error('billing_owner_lookup_failed');
      const userId = (row.data as { user_id?: string } | null)?.user_id;
      return typeof userId === 'string' && userId.length > 0 ? userId : null;
    },


    async upsertUsageQuota(patch) {
      return insertOrUpdateFreshRow(client, 'usage_quotas', patch, 'usage_quota_upsert_failed');
    },

    async enqueueHermesProvisioning(job) {
      // 2026-05-16 defect J2 — new rows were defaulting to provider
      // 'railway_legacy' (the DB column default set when migration 0021
      // backfilled existing rows). Series 4 has been the only active
      // provider since v1.0.0, so we explicitly write 'fly_machines' on
      // every enqueue. Migration 0024 also flips the column default for
      // belt-and-braces.
      const patch = {
        status: 'queued' as const,
        provider: 'fly_machines' as const,
        error_code: null,
        ready_at: null,
        public_status_message: job.public_status_message,
        provisioning_tier_id: job.tier_id,
        provisioning_idempotency_key: job.idempotency_key,
        provisioning_requested_at: job.requested_at,
        provisioning_claimed_at: null,
        provisioning_lease_expires_at: null,
      };

      const updated = await client
        .from('hermes_instances')
        .update(patch)
        .eq('user_id', job.user_id)
        // 'deleted' is in this list for the returning customer whose workspace
        // was grace-expired: without it, neither this enqueue nor the
        // sleeping-only resume hook transitions the row, and the user pays
        // forever while stuck on a terminal error gate (defect hunt H3).
        .in('status', ['not_requested', 'error', 'queued', 'deleted'])
        .select('user_id')
        .maybeSingle();
      if (updated.error) throw new Error('hermes_provisioning_enqueue_failed');

      let transitioned = Boolean(updated.data);
      if (!transitioned) {
        const inserted = await client
          .from('hermes_instances')
          .insert({ user_id: job.user_id, ...patch })
          .select('user_id')
          .maybeSingle();
        if (!inserted.error && inserted.data) transitioned = true;
        if (inserted.error && !isUniqueViolation(inserted.error)) throw new Error('hermes_provisioning_enqueue_failed');
      }

      if (!transitioned) {
        // Observability (defect hunt H3): a paying user whose row could not be
        // transitioned used to vanish silently. A healthy runner (ready /
        // provisioning / sleeping-awaiting-resume / reimaging) is an expected
        // no-op on renewal webhooks; anything else is a stuck paying user, so
        // record it. Never throw — the webhook already succeeded financially.
        const current = await client
          .from('hermes_instances')
          .select('status')
          .eq('user_id', job.user_id)
          .maybeSingle();
        const currentStatus = (current.data as { status?: string } | null)?.status ?? 'missing';
        const expectedNoOp = ['ready', 'degraded', 'provisioning', 'reimaging', 'sleeping'];
        if (!expectedNoOp.includes(currentStatus)) {
          await client.from('provisioning_events').insert({
            user_id: job.user_id,
            event: 'hermes_provisioning_enqueue_skipped',
            details: {
              tier_id: job.tier_id,
              requested_at: job.requested_at,
              reason: 'status_not_transitionable',
              status: currentStatus,
            },
          });
        }
        return;
      }

      const event = await client.from('provisioning_events').insert({
        user_id: job.user_id,
        event: 'hermes_provisioning_queued',
        details: {
          tier_id: job.tier_id,
          requested_at: job.requested_at,
          reason: 'stripe_entitlement_active',
        },
      });
      if (event.error) throw new Error('hermes_provisioning_event_failed');
    },

    async recordProvisioningEvent(input) {
      const event = await client.from('provisioning_events').insert({
        user_id: input.userId,
        event: input.event,
        details: input.details,
      });
      if (event.error) throw new Error('hermes_provisioning_event_failed');
    },

    // Series 4 — Option A cancellation hook. Calls the migration-0021 RPC.
    async markSeries4RunnerSuspended(input) {
      if (typeof client.rpc !== 'function') return false;
      const result = await client.rpc('mark_hermes_runner_suspended', {
        p_user_id: input.userId,
        p_retention_seconds: input.retentionSeconds,
        p_public_status_message: input.publicStatusMessage,
      });
      if (result.error) throw new Error('mark_hermes_runner_suspended_failed');
      return result.data === true;
    },

    async markSeries4RunnerResumed(input) {
      if (typeof client.rpc !== 'function') return false;
      const result = await client.rpc('mark_hermes_runner_resumed', {
        p_user_id: input.userId,
        p_public_status_message: input.publicStatusMessage,
      });
      if (result.error) throw new Error('mark_hermes_runner_resumed_failed');
      return result.data === true;
    },

    async getResumedRunnerReattachTarget(userId) {
      const instance = await client
        .from('hermes_instances')
        .select('status')
        .eq('user_id', userId)
        .maybeSingle();
      if (instance.error) return null;
      if ((instance.data as { status?: string } | null)?.status !== 'provisioning') return null;

      const binding = await client
        .from('hermes_instance_private')
        .select('runner_base_url, deleted_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (binding.error) return null;
      const row = binding.data as { runner_base_url?: string | null; deleted_at?: string | null } | null;
      if (!row || row.deleted_at) return null;
      const url = typeof row.runner_base_url === 'string' ? row.runner_base_url.trim() : '';
      return url.length > 0 ? url : null;
    },

    async promoteResumedRunnerReady(userId, runnerBaseUrl) {
      const now = new Date().toISOString();
      const updated = await client
        .from('hermes_instances')
        .update({
          status: 'ready',
          base_url: runnerBaseUrl,
          last_health_at: now,
          ready_at: now,
          error: null,
          error_code: null,
          provisioning_claimed_at: null,
          provisioning_lease_expires_at: null,
          public_status_message: 'Delegent AI is online.',
          updated_at: now,
        })
        .eq('user_id', userId)
        // Only a row still parked in 'provisioning' may be promoted; anything
        // else means another path (provisioner cron, reimage) owns it now.
        .eq('status', 'provisioning')
        .select('user_id')
        .maybeSingle();
      if (updated.error) throw new Error('resume_reattach_promote_failed');
      return Boolean(updated.data);
    },
  };
}

async function claimExistingBillingEvent(
  client: { from(table: string): any },
  event: StripeBillingEventRecord,
  input: StripeBillingEventInsert,
  lease: { startedAt: string; expiresAt: string },
): Promise<StripeBillingEventRecord | null> {
  const patch = {
    status: 'processing' as const,
    user_id: input.user_id ?? event.user_id ?? null,
    error_code: null,
    processed_at: null,
    processing_started_at: lease.startedAt,
    processing_expires_at: lease.expiresAt,
  };

  const retryable = await client
    .from('billing_events')
    .update(patch)
    .eq('id', event.id)
    .in('status', ['received', 'failed'])
    .select(BILLING_EVENT_SELECT)
    .maybeSingle();
  if (retryable.error) throw new Error('billing_event_claim_failed');
  if (retryable.data) return toBillingEventRecord(retryable.data);

  const expired = await client
    .from('billing_events')
    .update(patch)
    .eq('id', event.id)
    .eq('status', 'processing')
    .lte('processing_expires_at', lease.startedAt)
    .select(BILLING_EVENT_SELECT)
    .maybeSingle();
  if (expired.error) throw new Error('billing_event_claim_failed');
  return expired.data ? toBillingEventRecord(expired.data) : null;
}

async function insertOrUpdateFreshRow(
  client: { from(table: string): any },
  table: 'subscriptions' | 'usage_quotas',
  row: SubscriptionPatchRecord | UsageQuotaPatchRecord,
  errorCode: string,
): Promise<boolean> {
  // Schema-lag resilience: if Supabase returns 42703 "column X does not
  // exist" — i.e. a migration adding that column hasn't been applied yet
  // (e.g. 0026 adds storage_quota_bytes / voice_seconds_quota) — drop the
  // unknown column from the patch and retry, looping until the row lands
  // or every removable column has been pruned. This stops a paying user
  // being stranded on "Preparing workspace" because a single optional
  // column was undeployed. Required columns (user_id, status, tier_id,
  // monthly_token_quota, updated_at, provider_updated_at) are NEVER
  // pruned; if any of them is reported missing we surface the error.
  const REQUIRED_COLS = new Set([
    'user_id', 'status', 'tier_id', 'monthly_token_quota',
    'updated_at', 'provider_updated_at',
  ]);
  let patch = { ...row } as Record<string, unknown>;
  let lastUpstreamError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const insert = await client.from(table).insert(patch);
    if (!insert.error) return true;
    lastUpstreamError = insert.error;
    // [diag 2026-05-21] Log the error shape so we can see what supabase-js
    // is returning when the schema-lag retry doesn't kick in. Visible via
    // `wrangler tail`. Safe to leave on; it never emits secret values.
    try {
      const e = insert.error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
      console.warn(`[insertOrUpdateFreshRow] ${table} insert error attempt=${attempt} code=${String(e?.code)} message=${String(e?.message).slice(0, 200)} details=${String(e?.details).slice(0, 100)} keys=${JSON.stringify(Object.keys(patch))}`);
    } catch {}
    const droppedFromInsert = maybeDropUndefinedColumn(insert.error, patch, REQUIRED_COLS);
    if (droppedFromInsert) {
      console.warn(`[insertOrUpdateFreshRow] ${table} dropped column from insert path, retrying. remaining=${JSON.stringify(Object.keys(patch))}`);
      continue;
    }
    if (!isUniqueViolation(insert.error)) throw upsertFailureError(errorCode, insert.error);

    const update = await client
      .from(table)
      .update(patch)
      .eq('user_id', (patch as { user_id?: string }).user_id)
      .or(`provider_updated_at.is.null,provider_updated_at.lte.${(patch as { provider_updated_at?: string }).provider_updated_at}`)
      .select('user_id');
    if (!update.error) {
      return !Array.isArray(update.data) || update.data.length > 0;
    }
    lastUpstreamError = update.error;
    try {
      const e = update.error as { code?: unknown; message?: unknown; details?: unknown };
      console.warn(`[insertOrUpdateFreshRow] ${table} update error attempt=${attempt} code=${String(e?.code)} message=${String(e?.message).slice(0, 200)}`);
    } catch {}
    const droppedFromUpdate = maybeDropUndefinedColumn(update.error, patch, REQUIRED_COLS);
    if (droppedFromUpdate) {
      console.warn(`[insertOrUpdateFreshRow] ${table} dropped column from update path, retrying. remaining=${JSON.stringify(Object.keys(patch))}`);
      continue;
    }
    throw upsertFailureError(errorCode, update.error);
  }
  throw upsertFailureError(errorCode, lastUpstreamError);
}

function upsertFailureError(errorCode: string, upstreamError: unknown): Error {
  const upstream = recordOrNull(upstreamError);
  const upstreamCode = nonEmptyString(upstream?.code);
  const upstreamMessage = nonEmptyString(upstream?.message);
  const suffix = [upstreamCode, upstreamMessage].filter((part): part is string => Boolean(part)).join('_');
  return new Error(suffix ? `${errorCode}_${suffix}` : errorCode);
}

function maybeDropUndefinedColumn(
  err: unknown,
  patch: Record<string, unknown>,
  required: Set<string>,
): boolean {
  if (!err || typeof err !== 'object') return false;
  const errRec = err as { code?: unknown; message?: unknown };
  // supabase-js surfaces "column missing" via TWO codes depending on
  // whether the error came from Postgres directly (42703 =
  // undefined_column SQLSTATE) or from PostgREST's schema cache
  // (PGRST204 = "column not found in schema cache"). The schema-cache
  // path is the one that fires for additive-column migrations whose
  // DDL has been applied but the cache hasn't been refreshed yet —
  // exactly the symptom we hit in production on 2026-05-21.
  if (errRec.code !== '42703' && errRec.code !== 'PGRST204') return false;
  const msg = typeof errRec.message === 'string' ? errRec.message : '';
  // Message shapes covered:
  //   `column "X" does not exist`
  //   `column X does not exist`
  //   `column TABLE.X does not exist`
  //   `Could not find the 'X' column of 'TABLE' in the schema cache`
  // Capture either bare-name or table.qualified-name; the leaf name
  // after the last "." is what's actually in our patch object.
  const match = msg.match(/column "?([a-zA-Z_][a-zA-Z0-9_.]*)"? does not exist/i)
    ?? msg.match(/Could not find the '([a-zA-Z_][a-zA-Z0-9_]*)' column/i);
  if (!match) return false;
  const qualified = match[1];
  const col = qualified.includes('.') ? qualified.slice(qualified.lastIndexOf('.') + 1) : qualified;
  if (required.has(col)) return false; // never drop required columns
  if (!(col in patch)) return false;
  delete patch[col];
  return true;
}

function toSubscriptionPatchRecord(resolution: Extract<StripeBillingDryRunResolution, { kind: 'subscription_patch' }>): SubscriptionPatchRecord {
  const subscription = resolution.subscription;
  if (!subscription.tierId || !subscription.updatedAt) throw new Error('incomplete_subscription_patch');

  const patch: SubscriptionPatchRecord = {
    user_id: subscription.userId,
    status: subscription.status,
    tier_id: subscription.tierId,
    updated_at: subscription.updatedAt,
    provider_updated_at: subscription.updatedAt,
  };

  if (subscription.stripeCustomerId) patch.stripe_customer_id = subscription.stripeCustomerId;
  if (subscription.stripeSubscriptionId) patch.stripe_subscription_id = subscription.stripeSubscriptionId;
  if (subscription.priceId) patch.price_id = subscription.priceId;
  if (subscription.currentPeriodStart) patch.current_period_start = subscription.currentPeriodStart;
  if (subscription.currentPeriodEnd) patch.current_period_end = subscription.currentPeriodEnd;
  if (typeof subscription.cancelAtPeriodEnd === 'boolean') patch.cancel_at_period_end = subscription.cancelAtPeriodEnd;

  return patch;
}

function toUsageQuotaPatchRecord(resolution: Extract<StripeBillingDryRunResolution, { kind: 'subscription_patch' }>): UsageQuotaPatchRecord {
  const quota = resolution.usageQuota;
  if (!quota.tierId || !quota.updatedAt) throw new Error('incomplete_usage_quota_patch');

  // [Batch 4b §2.5.4] Storage + voice caps are tier-derived: read the canonical
  // SIDEKICK_PLAN_TIERS row for the tier the resolution is moving us TO and
  // pin the matching cap values. A mid-cycle upgrade therefore raises ALL
  // three caps (token, storage, voice) atomically; a downgrade lowers all
  // three. Consumed counters (consumed_storage_bytes / consumed_voice_seconds)
  // are NOT reset on tier change — usage carries over so a downgrade doesn't
  // give the user free room they already used.
  const tier = getPlanTier(quota.tierId);
  const storageQuotaBytes = tier.storageGb * 1024 ** 3;

  return {
    user_id: quota.userId,
    tier_id: quota.tierId,
    monthly_token_quota: quota.monthlyTokenQuota,
    storage_quota_bytes: storageQuotaBytes,
    voice_seconds_quota: tier.voiceSecondsQuota,
    updated_at: quota.updatedAt,
    provider_updated_at: quota.updatedAt,
  };
}

function toHermesProvisioningJobRecord(
  resolution: Extract<StripeBillingDryRunResolution, { kind: 'subscription_patch' }>,
  billingEventId: string,
): HermesProvisioningJobRecord {
  const subscription = resolution.subscription;
  if (!subscription.tierId || !subscription.updatedAt) throw new Error('incomplete_hermes_provisioning_job');

  return {
    user_id: subscription.userId,
    tier_id: subscription.tierId,
    billing_event_id: billingEventId,
    provider_event_id: resolution.eventId,
    idempotency_key: `hermes-provisioning:${resolution.eventId}`,
    requested_at: subscription.updatedAt,
    public_status_message: "Your coworker's cloud computer is queued for setup.",
  };
}

function resolveReadiness(env: StripeServerEnv, required: readonly (keyof StripeServerEnv)[]): ReadinessResult {
  const missing = required.filter((key) => !nonEmptyString(env[key]));
  return { ok: missing.length === 0, missing };
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return recordOrNull(await request.json());
  } catch {
    return null;
  }
}

function parsePlanTierId(value: unknown): PlanTierId | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  try {
    return getPlanTier(candidate as PlanTierId).id;
  } catch {
    return null;
  }
}

function requireAllowedCheckoutRedirectUrl(value: unknown, env: StripeServerEnv): string | null {
  const rawUrl = nonEmptyString(value);
  if (!rawUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (!allowedCheckoutRedirectOrigins(env).has(parsed.origin)) return null;
  return rawUrl;
}

function allowedCheckoutRedirectOrigins(env: StripeServerEnv): Set<string> {
  const origins = new Set<string>();

  for (const rawOrigin of (env.SIDEKICK_CHECKOUT_REDIRECT_ORIGINS ?? '').split(',')) {
    const origin = nonEmptyString(rawOrigin);
    if (!origin) continue;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password) {
        origins.add(parsed.origin);
      }
    } catch {
      // Invalid env entries are ignored so they cannot broaden the allow-list.
    }
  }

  return origins;
}

function isProviderBackedEntitlementStatus(status: SubscriptionStatus | null | undefined): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due';
}

function isStripeCheckoutUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'checkout.stripe.com' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isStripeBillingPortalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'billing.stripe.com' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return nonEmptyString(match?.[1]);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function sanitizeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return sanitized || 'stripe_webhook_failed';
}

async function markLedgerFailedBestEffort(store: StripeBillingStore, id: string, processedAt: string, errorCode: string) {
  try {
    await store.updateBillingEvent(id, {
      status: 'failed',
      processed_at: processedAt,
      error_code: errorCode,
    });
  } catch {
    // Stripe will retry the event because the route returns 500.
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = recordOrNull(error)?.code;
  return code === '23505' || code === '409';
}

function toBillingEventRecord(value: unknown): StripeBillingEventRecord {
  const row = recordOrNull(value) ?? {};
  const provider = row.provider === 'stripe' ? 'stripe' : 'stripe';
  return {
    id: String(row.id ?? ''),
    provider,
    provider_event_id: String(row.provider_event_id ?? ''),
    event_type: String(row.event_type ?? ''),
    idempotency_key: String(row.idempotency_key ?? ''),
    payload_hash: nonEmptyString(row.payload_hash) ?? null,
    status: parseBillingEventStatus(row.status),
    user_id: nonEmptyString(row.user_id) ?? null,
    error_code: nonEmptyString(row.error_code) ?? null,
    processed_at: nonEmptyString(row.processed_at) ?? null,
    processing_started_at: nonEmptyString(row.processing_started_at) ?? null,
    processing_expires_at: nonEmptyString(row.processing_expires_at) ?? null,
  };
}

function parseBillingEventStatus(value: unknown): StripeBillingEventRecord['status'] {
  return value === 'processing' || value === 'processed' || value === 'ignored' || value === 'failed' ? value : 'received';
}

function externalCheckoutUrlResponse(request: Request, url: string): Response {
  if (acceptsJson(request)) {
    return Response.json({ url }, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        vary: 'accept',
      },
    });
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      'cache-control': 'no-store',
      vary: 'accept',
    },
  });
}

function acceptsJson(request: Request): boolean {
  return request.headers
    .get('accept')
    ?.split(',')
    .some((entry) => entry.trim().toLowerCase().split(';', 1)[0] === 'application/json') ?? false;
}

function safeJson(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function verifiedInvoicePatch(event: unknown): { stripe_entitlement_invoice_id?: string } {
  const envelope = recordOrNull(event);
  const object = recordOrNull(recordOrNull(envelope?.data)?.object);
  const asId = (value: unknown) => nonEmptyString(value) ?? nonEmptyString(recordOrNull(value)?.id);
  const invoiceId = String(envelope?.type).startsWith('invoice.') ? asId(object)
    : asId(object?.latest_invoice) ?? asId(recordOrNull(object?.subscription)?.latest_invoice) ?? asId(object?.invoice);
  return invoiceId ? { stripe_entitlement_invoice_id: invoiceId } : {};
}

function verifiedPurchaseIntentPatch(event: unknown): { purchase_intent_id?: string } {
  const object = recordOrNull(recordOrNull(recordOrNull(event)?.data)?.object);
  const metadata = recordOrNull(object?.metadata);
  const details = recordOrNull(recordOrNull(object?.parent)?.subscription_details) ?? recordOrNull(object?.subscription_details);
  const intent = nonEmptyString(metadata?.purchaseIntentId) ?? nonEmptyString(recordOrNull(details?.metadata)?.purchaseIntentId);
  return intent ? { purchase_intent_id: intent } : {};
}
