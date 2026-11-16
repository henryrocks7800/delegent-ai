import {
  AGENT_PLAN,
  agentFreeTrialTermsLine,
  getPlanTier,
  isPlanUpgrade,
  SIDEKICK_FREE_TRIAL,
  freeTrialTermsLine,
  isLaunchPromoLive,
  launchPromoTermsLine,
  resolveStripeBillingDryRunEvent,
  SIDEKICK_LAUNCH_PROMO,
  launchPromoCouponIdForTier,
  type PlanTierId,
  type StripeBillingDryRunEventType,
  type StripeBillingDryRunResolution,
  type SubscriptionStatus,
} from '@sidekick/shared';
import { assertPortalConfiguration } from './portalPolicy.js';
import { requireScheduledChangeConfirmation } from './scheduledChange.js';

export interface StripePriceRecord {
  id: string;
  lookup_key: string | null;
  active: boolean;
}

export interface StripeCheckoutSessionRecord {
  id: string;
  url: string | null;
}

export interface StripeBillingPortalSessionRecord {
  id: string;
  url: string;
}

export interface StripePriceListParams {
  lookup_keys: readonly string[];
  active: true;
  limit: 1;
}

export interface StripeListResponse<T> {
  data: readonly T[];
}

export interface StripeCheckoutSessionLineItemParams {
  price: string;
  quantity: 1;
}

export interface StripeBillingMetadata {
  purchaseIntentId?: string;
  sidekickUserId: string;
  tierId: PlanTierId;
  priceLookupKey: string;
  /**
   * Stamped onto `subscription_data.metadata` when the launch coupon is applied
   * at Checkout. Stripe keeps subscription metadata forever, including on
   * cancelled subscriptions, and drops an expired repeating discount off the
   * subscription entirely, so this stamp is the only durable record that a
   * customer already had their promo window.
   */
  launchPromoCouponId?: string;
  /** 'assistant' when the checkout is for the assistant plan (AGENT_PLAN), so the record says which plan was bought. */
  plan?: 'assistant';
  introductoryOfferId?: string;
}

export type StripeCheckoutPaymentMethodType = 'card' | 'link';

export interface StripeCheckoutSessionCreateParams {
  expires_at?: number;
  mode: 'subscription';
  line_items: readonly StripeCheckoutSessionLineItemParams[];
  success_url: string;
  cancel_url: string;
  client_reference_id: string;
  customer_email?: string;
  customer?: string;
  metadata: StripeBillingMetadata;
  subscription_data: {
    metadata: StripeBillingMetadata;
    trial_period_days?: 3 | 30;
    trial_settings?: { end_behavior: { missing_payment_method: 'cancel' } };
  };
  payment_method_collection?: 'always';
  payment_method_types: readonly StripeCheckoutPaymentMethodType[];
  // Stripe rejects `allow_promotion_codes` and `discounts` together, so exactly
  // one is set: normally we let the user type a code; when the launch promo is
  // live we auto-apply its coupon and omit the manual-code field.
  allow_promotion_codes?: true;
  discounts?: readonly StripeCheckoutDiscountParams[];
  custom_text?: StripeCheckoutCustomText;
  billing_address_collection: 'auto';
}

export interface StripeCheckoutCustomText {
  submit?: { message: string };
}

export interface StripeCheckoutDiscountParams {
  coupon: string;
}

export interface StripeCheckoutSessionCreateOptions {
  idempotencyKey: string;
}

export interface StripeBillingPortalSessionCreateParams {
  configuration: string;
  customer: string;
  return_url: string;
  flow_data?: StripeBillingPortalSessionFlowData;
}

export interface StripeBillingPortalSessionFlowData {
  type: 'subscription_update_confirm';
  after_completion: {
    type: 'redirect';
    redirect: {
      return_url: string;
    };
  };
  subscription_update_confirm: {
    subscription: string;
    items: readonly StripeBillingPortalSubscriptionUpdateItem[];
    discounts?: readonly StripeCheckoutDiscountParams[];
  };
}

export interface StripeBillingPortalSubscriptionUpdateItem {
  id: string;
  price: string;
  quantity?: number;
}

export interface StripeSubscriptionRetrieveParams {
  expand?: readonly string[];
}

export interface StripeSubscriptionItemRecord {
  id?: string | null;
  price?: string | { id?: string | null } | null;
  quantity?: number | null;
  /** Newer Stripe API surfaces the period end per item (seconds since epoch). */
  current_period_end?: number | null;
}

export interface StripeSubscriptionRecord {
  customer?: string | { id?: string } | null;
  id?: string | null;
  status?: string | null;
  items?: {
    data?: readonly StripeSubscriptionItemRecord[];
  } | null;
  /** Attached schedule id, if any (present once a downgrade has been scheduled). */
  schedule?: string | { id?: string | null } | null;
  /** Legacy top-level period end (older API versions) — seconds since epoch. */
  current_period_end?: number | null;
  metadata?: Record<string, string | null | undefined> | null;
  /**
   * Newer API versions list discounts; legacy versions expose a single one.
   * Each entry is a Discount when expanded and a bare id string when not, and
   * the SDK's own shape varies by pinned API version, so these stay `unknown`
   * and are narrowed at the point of use.
   */
  discounts?: readonly unknown[] | null;
  discount?: unknown;
}

export interface StripeSubscriptionListParams {
  customer: string;
  status: 'all';
  limit: number;
  expand?: readonly string[];
}

/** A single phase of a Stripe subscription schedule. */
export interface StripeSchedulePhaseRecord {
  start_date?: number | null;
  end_date?: number | null;
  items?: readonly { price?: string | { id?: string | null } | null; quantity?: number | null }[] | null;
}

export interface StripeSubscriptionScheduleRecord {
  id?: string | null;
  status?: string | null;
  phases?: readonly StripeSchedulePhaseRecord[] | null;
}

type MaybePromise<T> = T | Promise<T>;

export interface StripeBillingClient {
  prices: {
    list(params: StripePriceListParams): MaybePromise<StripeListResponse<StripePriceRecord>>;
  };
  checkout: {
    sessions: {
      retrieve?(id: string): MaybePromise<unknown>;
      expire?(id: string): MaybePromise<unknown>;
      list?(input: { created: { gte: number; lte: number }; limit: 100; starting_after?: string }): MaybePromise<unknown>;
      create(
        params: StripeCheckoutSessionCreateParams,
        options?: StripeCheckoutSessionCreateOptions,
      ): MaybePromise<StripeCheckoutSessionRecord>;
    };
  };
  billingPortal: {
    configurations?: { retrieve(id: string): MaybePromise<unknown> };
    sessions: {
      create(params: StripeBillingPortalSessionCreateParams): MaybePromise<StripeBillingPortalSessionRecord>;
    };
  };
  subscriptions?: {
    retrieve(id: string, params?: StripeSubscriptionRetrieveParams): MaybePromise<StripeSubscriptionRecord>;
    /**
     * Optional: used only to answer "has this customer already had the launch
     * promo". A client without it simply skips that check.
     */
    list?(params: StripeSubscriptionListParams): MaybePromise<StripeListResponse<StripeSubscriptionRecord>>;
  };
  /**
   * Subscription schedules — used to DEFER a downgrade to the end of the paid
   * period (the user keeps their higher tier until renewal, then it steps down).
   * Upgrades never touch this path; they apply immediately via the portal.
   */
  subscriptionSchedules?: {
    create(params: { from_subscription: string }): MaybePromise<StripeSubscriptionScheduleRecord>;
    update(id: string, params: Record<string, unknown>): MaybePromise<StripeSubscriptionScheduleRecord>;
    release(id: string): MaybePromise<StripeSubscriptionScheduleRecord>;
  };
}

export interface CreateStripeCheckoutSessionInput {
  userId: string;
  tierId: PlanTierId;
  customerEmail?: string | null;
  existingStripeCustomerId?: string | null;
  /** Server-read history across billing providers, never a request-body field. */
  hasPriorSubscription?: boolean;
  successUrl: string;
  cancelUrl: string;
  /**
   * Clock override for tests. The durable coordinator supplies a purchase
   * intent ID and immutable expiry for user-facing checkout attempts.
   */
  now?: () => number;
  purchaseIntentId?: string;
  expiresAt?: number;
  /**
   * The assistant plan: its own price (AGENT_PLAN.stripePriceLookupKey), a free
   * month instead of three days, recorded under AGENT_PLAN.tierId. Decided by
   * the server from the account's engine, never by the request body.
   */
  plan?: 'assistant';
}

/**
 * Legacy low-level helper. The durable coordinator uses a persisted intent
 * ID instead of a time bucket; runtime route integration is tracked in PASS13.
 */
export function resolveStripeIdempotencyBucket(input: { now?: () => number } = {}): string {
  // [Stripe-checkout-stale-session-fix 2026-05-21] Previously a 1-hour
  // bucket. That collapsed every "tap plan in the same hour" into the
  // SAME Stripe idempotency-key, so Stripe returned the cached session
  // response. If the first session had already been completed or
  // expired, the retry opened the same dead URL and Chrome rendered
  // "You're all done here". Shortened to a 60-second bucket: retries
  // within 60s still dedupe (network blip → still safe), but anything
  // spaced further apart gets a fresh Stripe session URL.
  const nowMs = (input.now ?? Date.now)();
  const bucketMinute = Math.floor(nowMs / (60 * 1000));
  return `t${bucketMinute}`;
}

export interface StripeCheckoutSessionContract {
  provider: 'stripe';
  mode: 'checkout';
  sessionId: string;
  url: string;
  tierId: PlanTierId;
  priceLookupKey: string;
  idempotencyKey: string;
}

export interface CreateStripeBillingPortalSessionInput {
  scheduledChangeContext?: { userId: string; secretKey: string; confirmation?: unknown };
  configurationId: string;
  livemode: boolean;
  currentTierId?: PlanTierId | null;
  customerId: string;
  returnUrl: string;
  targetTierId?: PlanTierId | null;
  currentSubscriptionId?: string | null;
  currentPriceId?: string | null;
}

export interface StripeBillingPortalSessionContract {
  provider: 'stripe';
  mode: 'billing_portal';
  sessionId: string;
  url: string;
}

// 2026-07-14 upgrade-defect lesson: these catches used to DISCARD Stripe's
// error, so a live incident ("subscription update feature in the portal
// configuration is disabled", every upgrade broken) surfaced only as a blind
// generic 503 and had to be re-derived by hand against the Stripe API. Keep
// the stable message prefix (callers/tests match on it) but carry Stripe's
// own words so the worker log names the cause. Stripe error messages are
// operator-safe (no secrets) and never reach user-facing copy (PREOP-C05).
function stripeErrorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const detail = message.trim().slice(0, 240);
  return detail ? `: ${detail}` : '';
}

export async function createStripeBillingPortalSession(
  input: CreateStripeBillingPortalSessionInput,
  client: StripeBillingClient,
): Promise<StripeBillingPortalSessionContract> {
  const customerId = nonEmptyString(input.customerId);
  if (!customerId) throw new Error('Stripe customer required');

  const returnUrl = requireHttpsRedirectUrl(input.returnUrl);
  if (!input.configurationId || !/^bpc_[A-Za-z0-9]+$/.test(input.configurationId)
    || typeof input.livemode !== 'boolean' || !client.billingPortal.configurations) {
    throw new Error('Stripe billing portal configuration required');
  }
  const prepared = input.targetTierId
    ? await createSubscriptionUpdateFlowData(input, returnUrl, client)
    : undefined;
  const configuration = await client.billingPortal.configurations.retrieve(input.configurationId);
  assertPortalConfiguration(configuration, { id: input.configurationId, livemode: input.livemode,
    targetPriceId: prepared?.flow.subscription_update_confirm.items[0].price });
  // The customer must explicitly acknowledge removing the scheduled choice,
  // including when they subsequently leave the upgrade confirmation unfinished.
  if (prepared) await requireScheduledChangeConfirmation({
    secretKey: input.scheduledChangeContext?.secretKey ?? '', userId: input.scheduledChangeContext?.userId ?? '',
    subscriptionId: input.currentSubscriptionId!, scheduleId: prepared.scheduleId,
    currentPriceId: input.currentPriceId!, targetTierId: input.targetTierId!, returnUrl,
    provided: input.scheduledChangeContext?.confirmation,
  });
  if (prepared?.scheduleId) await releaseScheduledDowngrade(prepared.scheduleId, client);

  let session: StripeBillingPortalSessionRecord;
  try {
    const createParams: StripeBillingPortalSessionCreateParams = {
      configuration: input.configurationId,
      customer: customerId,
      return_url: returnUrl,
    };
    if (prepared) createParams.flow_data = prepared.flow;
    session = await client.billingPortal.sessions.create(createParams);
  } catch (err) {
    throw new Error(`Stripe billing portal session creation failed${stripeErrorDetail(err)}`);
  }

  const sessionId = nonEmptyString(session?.id);
  const url = nonEmptyString(session?.url);
  if (!sessionId || !url) throw new Error('Stripe billing portal session creation failed');

  return {
    provider: 'stripe',
    mode: 'billing_portal',
    sessionId,
    url,
  };
}

async function createSubscriptionUpdateFlowData(
  input: CreateStripeBillingPortalSessionInput,
  returnUrl: string,
  client: StripeBillingClient,
): Promise<{ flow: StripeBillingPortalSessionFlowData; scheduleId: string | null }> {
  if (!client.subscriptions) throw new Error('Stripe billing portal session creation failed');
  if (!input.currentTierId || !input.targetTierId || !isPlanUpgrade(input.currentTierId, input.targetTierId)) {
    throw new Error('Stripe billing portal upgrade required');
  }

  const targetTier = resolvePlanTierSafely(input.targetTierId as PlanTierId);
  const currentSubscriptionId = nonEmptyString(input.currentSubscriptionId);
  if (!currentSubscriptionId) throw new Error('Stripe subscription required');

  let priceResult: StripeListResponse<StripePriceRecord>;
  try {
    priceResult = await client.prices.list({ lookup_keys: [targetTier.stripePriceLookupKey], active: true, limit: 1 });
  } catch (err) {
    throw new Error(`Stripe price lookup failed${stripeErrorDetail(err)}`);
  }

  const targetPrice = resolveActivePrice(priceResult, targetTier.stripePriceLookupKey);
  if (!targetPrice) throw new Error('Stripe price lookup failed');

  let subscription: StripeSubscriptionRecord;
  try {
    subscription = await client.subscriptions.retrieve(currentSubscriptionId, {
      expand: ['items.data.price'],
    });
  } catch (err) {
    throw new Error(`Stripe subscription lookup failed${stripeErrorDetail(err)}`);
  }

  const currentItem = resolveSubscriptionUpdateItem(subscription, input.currentPriceId);
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!currentItem || !input.currentPriceId || subscription.items?.data?.length !== 1
    || currentItem.quantity !== 1 || subscription.id !== currentSubscriptionId || customer !== input.customerId
    || !['active', 'trialing', 'past_due'].includes(subscription.status ?? '')) {
    throw new Error('Stripe subscription item lookup failed');
  }

  const item: StripeBillingPortalSubscriptionUpdateItem = {
    id: currentItem.id,
    price: targetPrice.id,
  };
  if (typeof currentItem.quantity === 'number' && Number.isFinite(currentItem.quantity) && currentItem.quantity > 0) {
    item.quantity = currentItem.quantity;
  }

  const confirm: StripeBillingPortalSessionFlowData['subscription_update_confirm'] = {
    subscription: currentSubscriptionId,
    items: [item],
  };
  // No `discounts` here, ever. A tier change belongs to a CURRENT subscriber,
  // and the promo is for new customers only, so the plan card never quotes the
  // promo price to this reader (shouldQuotePromoPrice requires a reader Stripe
  // has never seen). Anyone still inside a promo window they already earned
  // keeps it across the change on its own: a discount lives on the
  // subscription, not the price. Setting `discounts` afresh would instead
  // RESTART the window from today, which is how a tier change every couple of
  // months would never reach full price.

  const scheduleId = typeof subscription.schedule === 'string' ? nonEmptyString(subscription.schedule)
    : nonEmptyString(subscription.schedule?.id);
  if (subscription.schedule !== null && subscription.schedule !== undefined && !scheduleId) {
    throw new Error('Stripe subscription schedule lookup failed');
  }
  return { scheduleId, flow: {
    type: 'subscription_update_confirm',
    after_completion: {
      type: 'redirect',
      redirect: { return_url: returnUrl },
    },
    subscription_update_confirm: confirm,
  } };
}

export interface ScheduleSubscriptionDowngradeInput {
  currentSubscriptionId: string;
  currentPriceId?: string | null;
  targetTierId: PlanTierId;
  /**
   * Unix seconds — the paid-period boundary the downgrade takes effect at.
   * Optional: when omitted it is derived from the retrieved subscription
   * (top-level `current_period_end` or the first item's, per Stripe API version).
   */
  currentPeriodEnd?: number | null;
}

/** Extract the current period end (seconds) from a retrieved subscription. */
function resolveSubscriptionPeriodEndSeconds(subscription: StripeSubscriptionRecord): number | null {
  const top = subscription.current_period_end;
  if (typeof top === 'number' && Number.isFinite(top) && top > 0) return top;
  for (const item of subscription.items?.data ?? []) {
    const end = item.current_period_end;
    if (typeof end === 'number' && Number.isFinite(end) && end > 0) return end;
  }
  return null;
}

export interface ScheduledDowngradeContract {
  provider: 'stripe';
  scheduleId: string;
  targetTierId: PlanTierId;
  /** Unix seconds — when the lower tier begins (the current period end). */
  effectiveAt: number;
}

/**
 * Defer a DOWNGRADE to the end of the current paid period via a Stripe
 * subscription schedule: phase 1 keeps the current (higher) price until
 * `currentPeriodEnd`, phase 2 switches to the target (cheaper) price from that
 * boundary on. `proration_behavior: 'none'` so there is no mid-cycle credit or
 * charge; `end_behavior: 'release'` so the schedule detaches once the cheaper
 * phase begins and the subscription is normal again. The user keeps every part
 * of their paid tier (compute, caps, voice, storage) until renewal, then it all
 * steps down together — and our existing `customer.subscription.updated` webhook
 * applies the lower caps at that boundary with no further changes.
 */
export async function scheduleSubscriptionDowngradeAtPeriodEnd(
  input: ScheduleSubscriptionDowngradeInput,
  client: StripeBillingClient,
): Promise<ScheduledDowngradeContract> {
  if (!client.subscriptions || !client.subscriptionSchedules) {
    throw new Error('Stripe subscription scheduling unavailable');
  }
  const currentSubscriptionId = nonEmptyString(input.currentSubscriptionId);
  if (!currentSubscriptionId) throw new Error('Stripe subscription required');

  const targetTier = resolvePlanTierSafely(input.targetTierId);
  let priceResult: StripeListResponse<StripePriceRecord>;
  try {
    priceResult = await client.prices.list({ lookup_keys: [targetTier.stripePriceLookupKey], active: true, limit: 1 });
  } catch (err) {
    throw new Error(`Stripe price lookup failed${stripeErrorDetail(err)}`);
  }
  const targetPrice = resolveActivePrice(priceResult, targetTier.stripePriceLookupKey);
  if (!targetPrice) throw new Error('Stripe price lookup failed');

  let subscription: StripeSubscriptionRecord;
  try {
    // `discounts` is expanded so the launch-offer discount (its id, coupon and
    // end date) can be carried into the schedule below.
    subscription = await client.subscriptions.retrieve(currentSubscriptionId, { expand: ['items.data.price', 'discounts'] });
  } catch (err) {
    throw new Error(`Stripe subscription lookup failed${stripeErrorDetail(err)}`);
  }
  // A stale database price must not replace the currently paid price when the
  // schedule applies its first phase. Only a single, unchanged item is supported.
  const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
  const expectedPriceId = nonEmptyString(input.currentPriceId);
  const currentSubItem = items.length === 1 ? items[0] : null;
  const currentPriceId = subscriptionItemPriceId(currentSubItem);
  if (!currentPriceId || (expectedPriceId && expectedPriceId !== currentPriceId)
    || currentSubItem?.quantity !== 1 || subscription.id !== currentSubscriptionId) {
    throw new Error('Stripe subscription item lookup failed');
  }

  const periodEnd =
    typeof input.currentPeriodEnd === 'number' && Number.isFinite(input.currentPeriodEnd) && input.currentPeriodEnd > 0
      ? input.currentPeriodEnd
      : resolveSubscriptionPeriodEndSeconds(subscription);
  if (periodEnd === null) throw new Error('Stripe subscription period end required');

  let schedule: StripeSubscriptionScheduleRecord;
  try {
    schedule = await client.subscriptionSchedules.create({ from_subscription: currentSubscriptionId });
  } catch (err) {
    throw new Error(`Stripe subscription schedule creation failed${stripeErrorDetail(err)}`);
  }
  const scheduleId = nonEmptyString(schedule?.id);
  if (!scheduleId) throw new Error('Stripe subscription schedule creation failed');

  const phase0 = schedule.phases?.[0];
  const phaseStart = typeof phase0?.start_date === 'number' ? phase0.start_date : undefined;
  const rawQuantity = currentSubItem?.quantity;
  const currentQuantity =
    typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;

  // CARRY THE SUBSCRIPTION'S DISCOUNT INTO BOTH PHASES.
  //
  // Rewriting a schedule's phases replaces them wholesale, and a phase with no
  // `discounts` inherits only the CUSTOMER's discount, of which we have none:
  // the launch offer lives on the subscription. So the old update silently
  // stripped the launch discount the moment a downgrade was booked, and Stripe
  // applies the current phase to the subscription straight away. A customer in
  // month one of "70% off your first 2 months" who moved down a tier would have
  // been charged the full price for month two, on the screen that promised
  // "any launch-offer months you have left carry across to your new plan"
  // (LAUNCH_PROMO_CARRY_OVER_LINE). Found in the 2026-09-07 pricing review.
  //
  // Phase 2 only carries a discount that is still running when it starts; one
  // that ends inside phase 1 has nothing left to carry and naming it would be
  // asking Stripe to reuse an expired discount.
  const carried = extractSubscriptionDiscounts(subscription);
  const carriedIntoPhase2 = carried.filter((discount) => discount.end === null || discount.end > periodEnd);

  const buildPhases = (mode: 'reuse_discount' | 'fresh_coupon'): Record<string, unknown>[] => {
    const phase1: Record<string, unknown> = {
      items: [{ price: currentPriceId, quantity: currentQuantity }],
      end_date: periodEnd,
    };
    if (typeof phaseStart === 'number') phase1.start_date = phaseStart;
    const phase2: Record<string, unknown> = {
      items: [{ price: targetPrice.id, quantity: 1 }],
      start_date: periodEnd,
    };
    const phase1Discounts = toPhaseDiscountParams(carried, mode);
    const phase2Discounts = toPhaseDiscountParams(carriedIntoPhase2, mode);
    if (phase1Discounts.length > 0) phase1.discounts = phase1Discounts;
    if (phase2Discounts.length > 0) phase2.discounts = phase2Discounts;
    return [phase1, phase2];
  };

  // Reusing the existing discount by id keeps its original end date, which is
  // the exact carry-over. If Stripe will not reuse it on the schedule, fall
  // back to re-applying the same coupon afresh: a repeating coupon then runs
  // its full duration again from the phase start, which can be a month more
  // generous than the promise but never less. Only the second refusal is an
  // error; no path here books the downgrade with the discount dropped.
  const attempts: Array<'reuse_discount' | 'fresh_coupon'> = ['reuse_discount'];
  if (carried.some((discount) => discount.discountId && discount.couponId)) attempts.push('fresh_coupon');

  let lastError: unknown = null;
  for (const mode of attempts) {
    try {
      await client.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        proration_behavior: 'none',
        phases: buildPhases(mode),
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError !== null) {
    throw new Error(`Stripe subscription schedule update failed${stripeErrorDetail(lastError)}`);
  }

  return { provider: 'stripe', scheduleId, targetTierId: input.targetTierId, effectiveAt: periodEnd };
}

/** A discount on the live subscription, as much of it as the API shape gave us. */
interface CarriedDiscount {
  discountId: string | null;
  couponId: string | null;
  /** Unix seconds when the discount stops applying, null for open-ended. */
  end: number | null;
}

/**
 * Read the subscription's discounts off whichever shape the pinned API version
 * returned: the `discounts` list (expanded objects or bare ids) or the legacy
 * single `discount`. Anything without an id or a coupon is dropped, because it
 * cannot be named to Stripe.
 */
function extractSubscriptionDiscounts(subscription: StripeSubscriptionRecord): CarriedDiscount[] {
  const raw: unknown[] = Array.isArray(subscription.discounts)
    ? [...subscription.discounts]
    : subscription.discount !== null && subscription.discount !== undefined
      ? [subscription.discount]
      : [];
  const carried: CarriedDiscount[] = [];
  for (const entry of raw) {
    const bareId = optionalString(entry);
    if (bareId) {
      carried.push({ discountId: bareId, couponId: null, end: null });
      continue;
    }
    const record = recordOrNull(entry);
    if (!record) continue;
    const discountId = optionalString(record.id);
    const couponId = optionalString(record.coupon) ?? optionalString(recordOrNull(record.coupon)?.id);
    const end = typeof record.end === 'number' && Number.isFinite(record.end) && record.end > 0 ? record.end : null;
    if (!discountId && !couponId) continue;
    carried.push({ discountId, couponId, end });
  }
  return carried;
}

function toPhaseDiscountParams(
  discounts: readonly CarriedDiscount[],
  mode: 'reuse_discount' | 'fresh_coupon',
): Array<{ discount: string } | { coupon: string }> {
  const params: Array<{ discount: string } | { coupon: string }> = [];
  for (const discount of discounts) {
    if (mode === 'reuse_discount' && discount.discountId) params.push({ discount: discount.discountId });
    else if (discount.couponId) params.push({ coupon: discount.couponId });
    else if (discount.discountId) params.push({ discount: discount.discountId });
  }
  return params;
}

/**
 * Cancel a pending scheduled downgrade (e.g. the user upgrades, or re-picks the
 * tier they are already on, before renewal). Releasing detaches the schedule and
 * leaves the live subscription untouched. A missing/empty id is a no-op.
 */
export async function releaseScheduledDowngrade(scheduleId: string, client: StripeBillingClient): Promise<void> {
  const id = nonEmptyString(scheduleId);
  if (!id) return;
  if (!client.subscriptionSchedules) throw new Error('Stripe subscription schedule release unavailable');
  try {
    const result = await client.subscriptionSchedules.release(id);
    if (result?.id !== id || result.status !== 'released') throw new Error('release not verified');
  } catch (err) {
    throw new Error(`Stripe subscription schedule release failed${stripeErrorDetail(err)}`);
  }
}

/**
 * Whether Stripe has ever really billed this customer: any subscription at any
 * status EXCEPT checkout attempts that never completed ('incomplete' /
 * 'incomplete_expired'), which belong to a reader who has never paid and must
 * not cost them the promo on a retry.
 *
 * This is the launch-promo eligibility gate, and it deliberately mirrors the
 * client's shouldQuotePromoPrice ("a reader Stripe has never seen"). The old
 * gate asked the narrower question "has this customer redeemed the promo
 * before", so a customer whose subscription PREDATED the promo passed it: the
 * plan page honestly quoted the standard price, and Stripe then charged the
 * promo price against it (2026-07-30, reported on a real resubscribe). The
 * promo is for new customers only, so having ever held a real subscription is
 * the disqualifier, not having held this particular coupon.
 *
 * Deliberately fails OPEN (reads as new) on a Stripe error. Wrongly granting
 * the discount undercharges against the quoted price and costs us a few
 * pounds; failing closed would charge a genuinely new reader full price
 * against a promo quote, which is the direction we must never be wrong in.
 */
async function customerHasStripeSubscriptionHistory(
  customerId: string | null,
  client: StripeBillingClient,
  requireVerifiedHistory = false,
): Promise<boolean> {
  if (!customerId) return false;
  const list = client.subscriptions?.list;
  if (!list) {
    if (requireVerifiedHistory) throw new Error('Trial eligibility unavailable');
    return false;
  }
  try {
    const result = await list.call(client.subscriptions, {
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    if (requireVerifiedHistory && !Array.isArray(result?.data)) throw new Error('Trial eligibility unavailable');
    const subscriptions = Array.isArray(result?.data) ? result.data : [];
    if (requireVerifiedHistory && subscriptions.some((subscription) =>
      ['active', 'trialing', 'past_due', 'incomplete'].includes(subscription.status ?? ''))) {
      throw new Error('Existing subscription requires billing management');
    }
    return subscriptions.some((subscription) => {
      const status = nonEmptyString(subscription.status) ?? '';
      return status !== 'incomplete' && status !== 'incomplete_expired';
    });
  } catch {
    if (requireVerifiedHistory) throw new Error('Trial eligibility unavailable');
    return false;
  }
}

export async function prepareStripeCheckoutSession(
  input: CreateStripeCheckoutSessionInput,
  client: StripeBillingClient,
): Promise<{ params: StripeCheckoutSessionCreateParams; idempotencyKey: string; tierId: PlanTierId; priceLookupKey: string }> {
  const userId = nonEmptyString(input.userId);
  if (!userId) throw new Error('userId required');

  const successUrl = requireHttpsRedirectUrl(input.successUrl);
  const cancelUrl = requireHttpsRedirectUrl(input.cancelUrl);
  const customerEmail = optionalString(input.customerEmail);
  const existingStripeCustomerId = optionalString(input.existingStripeCustomerId);

  const assistant = input.plan === 'assistant';
  if (assistant && input.tierId !== AGENT_PLAN.tierId) throw new Error('Unknown billing plan tier');
  const tier = resolvePlanTierSafely(input.tierId);
  const priceLookupKey = assistant ? AGENT_PLAN.stripePriceLookupKey : tier.stripePriceLookupKey;
  let priceResult: StripeListResponse<StripePriceRecord>;
  try {
    priceResult = await client.prices.list({ lookup_keys: [priceLookupKey], active: true, limit: 1 });
  } catch {
    throw new Error('Stripe price lookup failed');
  }

  const price = resolveActivePrice(priceResult, priceLookupKey);
  if (!price) throw new Error('Stripe price lookup failed');
  const priceId = price.id;

  const trialEnabled = SIDEKICK_FREE_TRIAL.enabled;
  // An unknown history must never turn a promised free trial into an immediate
  // charge. Retry the lookup instead. A previous Apple period also disqualifies
  // a returning customer even when they have no Stripe customer yet.
  if (trialEnabled && typeof input.hasPriorSubscription !== 'boolean') {
    throw new Error('Trial eligibility unavailable');
  }
  const stripeHistory = await customerHasStripeSubscriptionHistory(existingStripeCustomerId, client, trialEnabled);
  const hasHistory = input.hasPriorSubscription === true || stripeHistory;
  const applyTrial = trialEnabled && !hasHistory;
  const applyLaunchPromo = !assistant && !trialEnabled && isLaunchPromoLive() && !hasHistory;

  const metadata: StripeBillingMetadata = {
    sidekickUserId: userId,
    tierId: tier.id,
    priceLookupKey,
  };
  if (input.purchaseIntentId) metadata.purchaseIntentId = input.purchaseIntentId;
  if (assistant) metadata.plan = 'assistant';
  if (applyLaunchPromo) metadata.launchPromoCouponId = launchPromoCouponIdForTier(tier.id);
  if (applyTrial) metadata.introductoryOfferId = assistant ? AGENT_PLAN.freeTrialOfferId : SIDEKICK_FREE_TRIAL.offerId;
  // Including a server-controlled time bucket ensures a failed Stripe
  // response can't be replayed forever for the same (user, tier) pair while
  // still deduplicating fast retries in the same 60-second window.
  const idempotencyBucket = resolveStripeIdempotencyBucket({ now: input.now });
  const offerKey = trialEnabled ? `:${applyTrial ? metadata.introductoryOfferId : 'returning'}${assistant ? ':assistant' : ''}` : '';
  const idempotencyKey = input.purchaseIntentId ? `purchase-intent:${input.purchaseIntentId}`
    : `sidekick-checkout:${userId}:${tier.id}${offerKey}:${idempotencyBucket}`;
  const createParams: StripeCheckoutSessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    metadata,
    subscription_data: { metadata },
    payment_method_types: ['card', 'link'],
    billing_address_collection: 'auto',
  };
  // Auto-apply the launch coupon when it is live (mutually exclusive with the
  // manual promo-code field). The same coupon backs the struck-through price
  // shown in the app, so the discount the user sees is the discount they pay.
  if (applyTrial) {
    createParams.subscription_data.trial_period_days = assistant ? AGENT_PLAN.freeTrialDays : SIDEKICK_FREE_TRIAL.days;
    createParams.subscription_data.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
    createParams.payment_method_collection = 'always';
    createParams.custom_text = { submit: { message: assistant ? agentFreeTrialTermsLine() : freeTrialTermsLine(tier) } };
  } else if (applyLaunchPromo) {
    createParams.discounts = [{ coupon: launchPromoCouponIdForTier(tier.id) }];
    createParams.custom_text = { submit: { message: launchPromoTermsLine(tier) } };
  } else {
    createParams.allow_promotion_codes = true;
  }
  if (existingStripeCustomerId) createParams.customer = existingStripeCustomerId;
  else if (customerEmail) createParams.customer_email = customerEmail;

  if (input.expiresAt !== undefined) createParams.expires_at = input.expiresAt;
  return { params: createParams, idempotencyKey, tierId: tier.id, priceLookupKey };
}

/** Low-level helper. User-facing routes must use the durable purchase coordinator. */
export async function createStripeCheckoutSession(
  input: CreateStripeCheckoutSessionInput, client: StripeBillingClient,
): Promise<StripeCheckoutSessionContract> {
  const { params: createParams, idempotencyKey, tierId, priceLookupKey } = await prepareStripeCheckoutSession(input, client);
  let session: StripeCheckoutSessionRecord;
  try {
    session = await client.checkout.sessions.create(createParams, { idempotencyKey });
  } catch {
    throw new Error('Stripe checkout session creation failed');
  }

  const sessionId = nonEmptyString(session?.id);
  const url = nonEmptyString(session?.url);
  if (!sessionId || !url) throw new Error('Stripe checkout session creation failed');

  return {
    provider: 'stripe',
    mode: 'checkout',
    sessionId,
    url,
    tierId,
    priceLookupKey,
    idempotencyKey,
  };
}

function resolveActivePrice(priceResult: StripeListResponse<StripePriceRecord>, priceLookupKey: string): { id: string } | null {
  const priceData = Array.isArray(priceResult?.data) ? priceResult.data : [];
  const price = priceData.find(
    (candidate) => candidate.active === true
      && optionalString(candidate.id) !== null
      && optionalString(candidate.lookup_key) === priceLookupKey,
  );

  const priceId = nonEmptyString(price?.id);
  return priceId ? { id: priceId } : null;
}

function resolveSubscriptionUpdateItem(
  subscription: StripeSubscriptionRecord,
  currentPriceId: string | null | undefined,
): { id: string; quantity?: number | null } | null {
  const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
  const expectedPriceId = optionalString(currentPriceId);
  if (expectedPriceId) {
    const matchingItem = items.find((item) => subscriptionItemPriceId(item) === expectedPriceId);
    const itemId = nonEmptyString(matchingItem?.id);
    return itemId ? { id: itemId, quantity: matchingItem?.quantity ?? null } : null;
  }

  const usableItems = items.filter((item) => nonEmptyString(item.id));
  if (usableItems.length !== 1) return null;
  const itemId = nonEmptyString(usableItems[0].id);
  return itemId ? { id: itemId, quantity: usableItems[0].quantity ?? null } : null;
}

function subscriptionItemPriceId(item: StripeSubscriptionItemRecord | null | undefined): string | null {
  const direct = optionalString(item?.price);
  if (direct) return direct;
  return optionalString(recordOrNull(item?.price)?.id);
}

export interface StripeVerifiedWebhookEvent {
  id: string;
  type: StripeBillingDryRunEventType;
  created?: number | string | null;
  data?: {
    object?: unknown;
  };
}

/** Hydrate only the invoice named by a verified trial subscription event. */
export async function hydrateTrialSubscriptionInvoice(
  event: StripeVerifiedWebhookEvent,
  retrieveInvoice?: (id: string) => Promise<Record<string, unknown>>,
): Promise<StripeVerifiedWebhookEvent> {
  const object = recordOrNull(event.data?.object);
  if (!object || !isTrialSubscriptionActivation(event.type, object)) return event;
  if (recordOrNull(object.latest_invoice)) return event;
  const invoiceId = optionalString(object.latest_invoice);
  if (!invoiceId || !retrieveInvoice) throw new Error('trial_invoice_verification_unavailable');
  const invoice = await retrieveInvoice(invoiceId);
  if (invoice.id !== invoiceId) throw new Error('trial_invoice_verification_mismatch');
  return { ...event, data: { ...event.data, object: { ...object, latest_invoice: invoice } } };
}

function isTrialSubscriptionActivation(eventType: string, object: Record<string, unknown>): boolean {
  return (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated')
    && object.status === 'active' && isTrialOfferSubscription(object);
}

const SUPPORTED_VERIFIED_WEBHOOK_EVENTS = new Set<string>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  // A successful renewal charge is the only event that reliably carries the NEW
  // billing period. Ignoring it left `subscriptions.current_period_start` frozen
  // at whatever the last subscription event said, and because the usage window is
  // anchored on that column a renewal that produced no subscription event pinned
  // the user at 100% consumed for good. Stripe sends `invoice.paid` alongside
  // `invoice.payment_succeeded` for the same invoice; both are accepted and the
  // idempotency key drops the duplicate.
  'invoice.payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
]);

const INVOICE_EVENT_TYPES = new Set<string>([
  'invoice.payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
]);

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

export function resolveVerifiedStripeWebhookEvent(event: StripeVerifiedWebhookEvent): StripeBillingDryRunResolution {
  const eventRecord = recordOrNull(event) ?? {};
  const eventId = optionalString(eventRecord.id);
  const eventType = optionalString(eventRecord.type) ?? 'unknown';
  const occurredAt = stripeTimestampToIso(eventRecord.created) ?? EPOCH_ISO;
  const object = recordOrNull(recordOrNull(eventRecord.data)?.object) ?? {};
  const metadata = recordOrNull(object.metadata) ?? {};

  if (!eventId) {
    return { kind: 'ignored', provider: 'stripe', mode: 'dry_run', eventId: 'unknown', reason: 'unsupported_event' };
  }

  if (!SUPPORTED_VERIFIED_WEBHOOK_EVENTS.has(eventType)) {
    return resolveStripeBillingDryRunEvent({
      id: eventId,
      type: eventType,
      mode: 'dry_run',
      occurredAt,
    });
  }

  if (isTrialSubscriptionActivation(eventType, object) && !recordOrNull(object.latest_invoice)) {
    return { kind: 'ignored', provider: 'stripe', mode: 'dry_run', eventId, reason: 'incomplete_provider_entitlement' };
  }

  return resolveStripeBillingDryRunEvent({
    id: eventId,
    type: eventType,
    mode: 'dry_run',
    userId: extractWebhookUserId(object, metadata),
    customerId: extractCustomerId(object),
    subscriptionId: extractSubscriptionId(eventType, object),
    priceId: extractSubscriptionItemPriceId(object),
    priceLookupKey: extractPriceLookupKey(eventType, object, metadata),
    status: extractSubscriptionStatus(eventType, object),
    currentPeriodStart: extractCurrentPeriodStart(object),
    currentPeriodEnd: extractCurrentPeriodEnd(object),
    cancelAtPeriodEnd: stripeCancellationAtPeriodEnd(object),
    occurredAt,
  });
}

function resolvePlanTierSafely(tierId: PlanTierId) {
  try {
    return getPlanTier(tierId);
  } catch {
    throw new Error('Unknown billing plan tier');
  }
}

function requireHttpsRedirectUrl(value: string): string {
  const rawUrl = nonEmptyString(value);
  if (!rawUrl) throw new Error('Checkout redirect URL must be a valid HTTPS URL');

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Checkout redirect URL must be a valid HTTPS URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Checkout redirect URL must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('Checkout redirect URL must not include credentials');

  return rawUrl;
}

function extractWebhookUserId(object: Record<string, unknown>, metadata: Record<string, unknown>): string | null {
  const subscriptionMetadata = recordOrNull(recordOrNull(object.subscription)?.metadata) ?? {};
  const subscriptionDetailsMetadata = recordOrNull(recordOrNull(object.subscription_details)?.metadata) ?? {};
  const parentSubscriptionDetailsMetadata = recordOrNull(recordOrNull(recordOrNull(object.parent)?.subscription_details)?.metadata) ?? {};
  return optionalString(object.client_reference_id)
    ?? optionalString(metadata.sidekickUserId)
    ?? optionalString(subscriptionMetadata.sidekickUserId)
    ?? optionalString(subscriptionDetailsMetadata.sidekickUserId)
    ?? optionalString(parentSubscriptionDetailsMetadata.sidekickUserId)
    ?? extractUniqueInvoiceLineMetadataField(object, 'sidekickUserId');
}

function extractPriceLookupKey(eventType: string, object: Record<string, unknown>, metadata: Record<string, unknown>): string | null {
  const metadataLookupKey = optionalString(metadata.priceLookupKey) ?? extractUniqueInvoiceLineMetadataField(object, 'priceLookupKey');
  const itemLookupKey = extractSubscriptionItemPriceLookupKey(object);

  if (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated' || eventType === 'customer.subscription.deleted') {
    // The subscription item carries the authoritative current plan. On a
    // plan upgrade Stripe doesn't auto-rewrite the customer's metadata
    // (which still references the original lookup_key from sign-up), so a
    // mismatch between metadata and item is the EXPECTED state, not
    // tampering. Trust the item; downstream finalize will refresh the
    // customer metadata to match.
    //
    // The metadata is still useful as a fall-through when the item has no
    // lookup_key (rare; older legacy prices created before lookup_keys).
    if (itemLookupKey) return itemLookupKey;
    if (metadataLookupKey) return metadataLookupKey;
    return null;
  }

  if (metadataLookupKey) return metadataLookupKey;
  if (itemLookupKey) return itemLookupKey;

  return null;
}

function extractSubscriptionItemPriceLookupKey(object: Record<string, unknown>): string | null {
  const subscription = recordOrNull(object.subscription);
  const sourceObjects = subscription ? [object, subscription] : [object];
  const candidates: string[] = [];

  for (const sourceObject of sourceObjects) {
    const sourceLookupKey = extractUniqueSubscriptionItemPriceField(sourceObject, 'lookup_key', 'lookupKey');
    if (sourceLookupKey) candidates.push(sourceLookupKey);
  }

  const invoiceLineLookupKey = extractUniqueInvoiceLinePriceField(object, 'lookup_key', 'lookupKey');
  if (invoiceLineLookupKey) candidates.push(invoiceLineLookupKey);

  return uniqueCandidate(candidates);
}

function extractSubscriptionItemPriceId(object: Record<string, unknown>): string | null {
  const subscription = recordOrNull(object.subscription);
  const sourceObjects = subscription ? [object, subscription] : [object];
  const candidates: string[] = [];

  for (const sourceObject of sourceObjects) {
    const sourcePriceId = extractUniqueSubscriptionItemPriceField(sourceObject, 'id');
    if (sourcePriceId) candidates.push(sourcePriceId);
  }

  const invoiceLinePriceId = extractUniqueInvoiceLinePriceField(object, 'id');
  if (invoiceLinePriceId) candidates.push(invoiceLinePriceId);

  return uniqueCandidate(candidates);
}

function extractUniqueSubscriptionItemPriceField(object: Record<string, unknown>, primaryField: string, fallbackField?: string): string | null {
  const items = recordOrNull(object.items);
  const data = items?.data;
  if (!Array.isArray(data)) return null;

  let uniqueValue: string | null = null;
  for (const item of data) {
    const itemRecord = recordOrNull(item);
    const price = recordOrNull(itemRecord?.price);
    const value = optionalString(price?.[primaryField]) ?? (fallbackField ? optionalString(price?.[fallbackField]) : null);
    if (!value) continue;
    if (uniqueValue && uniqueValue !== value) return null;
    uniqueValue = value;
  }

  return uniqueValue;
}

function extractUniqueInvoiceLinePriceField(object: Record<string, unknown>, primaryField: string, fallbackField?: string): string | null {
  const lines = recordOrNull(object.lines);
  const data = lines?.data;
  if (!Array.isArray(data)) return null;

  let uniqueValue: string | null = null;
  for (const line of data) {
    const lineRecord = recordOrNull(line);
    const pricing = recordOrNull(lineRecord?.pricing);
    const priceDetails = recordOrNull(pricing?.price_details);
    const value = extractPriceField(lineRecord?.price, primaryField, fallbackField)
      ?? extractPriceField(priceDetails?.price, primaryField, fallbackField);
    if (!value) continue;
    if (uniqueValue && uniqueValue !== value) return null;
    uniqueValue = value;
  }

  return uniqueValue;
}

function extractPriceField(priceSource: unknown, primaryField: string, fallbackField?: string): string | null {
  if (primaryField === 'id') {
    const directPriceId = stripeIdentifier(priceSource);
    if (directPriceId) return directPriceId;
  }

  const price = recordOrNull(priceSource);
  return optionalString(price?.[primaryField]) ?? (fallbackField ? optionalString(price?.[fallbackField]) : null);
}

function extractUniqueInvoiceLineMetadataField(object: Record<string, unknown>, field: string): string | null {
  const lines = recordOrNull(object.lines);
  const data = lines?.data;
  if (!Array.isArray(data)) return null;

  let uniqueValue: string | null = null;
  for (const line of data) {
    const lineRecord = recordOrNull(line);
    const metadata = recordOrNull(lineRecord?.metadata);
    const value = optionalString(metadata?.[field]);
    if (!value) continue;
    if (uniqueValue && uniqueValue !== value) return null;
    uniqueValue = value;
  }

  return uniqueValue;
}

function uniqueCandidate(candidates: readonly string[]): string | null {
  let uniqueValue: string | null = null;
  for (const candidate of candidates) {
    if (uniqueValue && uniqueValue !== candidate) return null;
    uniqueValue = candidate;
  }

  return uniqueValue;
}

function extractCurrentPeriodStart(object: Record<string, unknown>): string | null {
  return stripeTimestampToIso(object.current_period_start)
    ?? stripeTimestampToIso(recordOrNull(object.subscription)?.current_period_start)
    ?? stripeTimestampToIso(extractUniqueSubscriptionItemPeriodField(object, 'current_period_start'))
    ?? stripeTimestampToIso(extractUniqueInvoiceLinePeriodField(object, 'start'));
}

function extractCurrentPeriodEnd(object: Record<string, unknown>): string | null {
  return stripeTimestampToIso(object.current_period_end)
    ?? stripeTimestampToIso(recordOrNull(object.subscription)?.current_period_end)
    ?? stripeTimestampToIso(extractUniqueSubscriptionItemPeriodField(object, 'current_period_end'))
    ?? stripeTimestampToIso(extractUniqueInvoiceLinePeriodField(object, 'end'));
}

/** Stripe's customer portal can set cancel_at without cancel_at_period_end. */
export function stripeCancellationAtPeriodEnd(object: Record<string, unknown>): boolean | null {
  const subscription = recordOrNull(object.subscription);
  const flag = typeof object.cancel_at_period_end === 'boolean'
    ? object.cancel_at_period_end
    : typeof subscription?.cancel_at_period_end === 'boolean' ? subscription.cancel_at_period_end : null;
  if (flag === true) return true;
  const cancelAt = stripeTimestampToIso(object.cancel_at ?? subscription?.cancel_at);
  const periodEnd = extractCurrentPeriodEnd(object);
  // A cancellation scheduled several periods ahead must not say this month's
  // renewal is off. Unknown or malformed dates do not override the provider flag.
  if (cancelAt && periodEnd && Date.parse(cancelAt) > 0 && Date.parse(cancelAt) <= Date.parse(periodEnd)) return true;
  return flag;
}

function extractUniqueSubscriptionItemPeriodField(object: Record<string, unknown>, field: 'current_period_start' | 'current_period_end'): unknown {
  const subscription = recordOrNull(object.subscription);
  const sourceObjects = subscription ? [object, subscription] : [object];
  let uniqueValue: unknown = null;

  for (const sourceObject of sourceObjects) {
    const items = recordOrNull(sourceObject.items);
    const data = items?.data;
    if (!Array.isArray(data)) continue;

    for (const item of data) {
      const itemRecord = recordOrNull(item);
      const value = itemRecord?.[field];
      if (value === null || value === undefined) continue;
      if (uniqueValue !== null && uniqueValue !== value) return null;
      uniqueValue = value;
    }
  }

  return uniqueValue;
}

function extractUniqueInvoiceLineSubscriptionId(object: Record<string, unknown>): string | null {
  const lines = recordOrNull(object.lines);
  const data = lines?.data;
  if (!Array.isArray(data)) return null;

  let uniqueValue: string | null = null;
  for (const line of data) {
    const lineRecord = recordOrNull(line);
    const parent = recordOrNull(lineRecord?.parent);
    const subscriptionItemDetails = recordOrNull(parent?.subscription_item_details);
    const invoiceItemDetails = recordOrNull(parent?.invoice_item_details);
    const value = stripeIdentifier(lineRecord?.subscription)
      ?? stripeIdentifier(subscriptionItemDetails?.subscription)
      ?? stripeIdentifier(invoiceItemDetails?.subscription);
    if (!value) continue;
    if (uniqueValue && uniqueValue !== value) return null;
    uniqueValue = value;
  }

  return uniqueValue;
}

function extractUniqueInvoiceLinePeriodField(object: Record<string, unknown>, field: string): unknown {
  const lines = recordOrNull(object.lines);
  const data = lines?.data;
  if (!Array.isArray(data)) return null;

  let uniqueValue: unknown = null;
  for (const line of data) {
    const lineRecord = recordOrNull(line);
    const period = recordOrNull(lineRecord?.period);
    const value = period?.[field];
    if (value === null || value === undefined) continue;
    if (uniqueValue !== null && uniqueValue !== value) return null;
    uniqueValue = value;
  }

  return uniqueValue;
}

function extractCustomerId(object: Record<string, unknown>): string | null {
  return stripeIdentifier(object.customer);
}

function extractSubscriptionId(eventType: string, object: Record<string, unknown>): string | null {
  if (eventType === 'checkout.session.completed') return stripeIdentifier(object.subscription);
  if (INVOICE_EVENT_TYPES.has(eventType)) {
    return stripeIdentifier(object.subscription)
      ?? stripeIdentifier(recordOrNull(object.subscription_details)?.subscription)
      ?? stripeIdentifier(recordOrNull(recordOrNull(object.parent)?.subscription_details)?.subscription)
      ?? extractUniqueInvoiceLineSubscriptionId(object);
  }
  return stripeIdentifier(object.id) ?? stripeIdentifier(object.subscription);
}

export function isTrialOfferSubscription(object: Record<string, unknown>): boolean {
  const sources = [
    recordOrNull(object.metadata),
    recordOrNull(recordOrNull(object.subscription)?.metadata),
    recordOrNull(recordOrNull(object.subscription_details)?.metadata),
    recordOrNull(recordOrNull(recordOrNull(object.parent)?.subscription_details)?.metadata),
  ];
  // The assistant plan's free month is a trial offer in exactly the same sense.
  const offers = new Set<string>([SIDEKICK_FREE_TRIAL.offerId, AGENT_PLAN.freeTrialOfferId]);
  return sources.some((metadata) => typeof metadata?.introductoryOfferId === 'string' && offers.has(metadata.introductoryOfferId))
    || offers.has(extractUniqueInvoiceLineMetadataField(object, 'introductoryOfferId') ?? '');
}

/** Trial-offer subscribers receive service only while trialing or paid. */
export function stripeEntitlementStatus(status: SubscriptionStatus, object: Record<string, unknown>): SubscriptionStatus {
  if (!isTrialOfferSubscription(object)) return status;
  if (status === 'past_due') return 'canceled';
  if (status === 'active') {
    const invoice = recordOrNull(object.latest_invoice);
    // A status can become active with an uncollectible invoice or an unsettled
    // delayed payment. Only a settled post-trial invoice grants the paid period.
    // Current Stripe API versions expose status, not the removed paid boolean.
    if (invoice?.status !== 'paid'
      || (invoice.billing_reason === 'subscription_create' && invoice.amount_paid === 0)) return 'canceled';
  }
  return status;
}

function extractSubscriptionStatus(eventType: string, object: Record<string, unknown>): SubscriptionStatus {
  const trialOffer = isTrialOfferSubscription(object);
  if (eventType === 'customer.subscription.deleted') return 'canceled';
  if (eventType === 'invoice.payment_failed') return trialOffer ? 'canceled' : 'past_due';

  if (eventType === 'invoice.payment_succeeded' || eventType === 'invoice.paid') {
    // An invoice's own `status` is 'paid', which is not a subscription status and
    // would fall through to 'inactive' below — a successful renewal would cancel
    // the very entitlement it just paid for. Prefer the expanded subscription's
    // real status, and otherwise take the payment at face value.
    // Stripe emits a paid £0 invoice at trial creation. It grants the trial,
    // not a paid month, even when the subscription isn't expanded.
    if (trialOffer && object.billing_reason === 'subscription_create' && object.amount_paid === 0) return 'trialing';
    const invoiceSubscriptionStatus = optionalString(recordOrNull(object.subscription)?.status);
    if (isSubscriptionStatus(invoiceSubscriptionStatus)) {
      return stripeEntitlementStatus(invoiceSubscriptionStatus, { ...object, latest_invoice: object });
    }
    return 'active';
  }

  const subscription = recordOrNull(object.subscription);
  const rawStatus = eventType === 'checkout.session.completed'
    ? optionalString(subscription?.status) ?? optionalString(object.subscription_status) ?? optionalString(object.status)
    : optionalString(object.status);

  if (isSubscriptionStatus(rawStatus)) return stripeEntitlementStatus(rawStatus, object);
  // Stripe's terminal dunning states aren't canonical here, but they mean the
  // user is no longer paying — collapse them to 'canceled' so the runner gets
  // SUSPENDED (shouldSuspendSeries4Runner). Without this they fell through to
  // 'inactive', which blocks new chats but never suspends the runner → Fly
  // compute billed indefinitely (GO_LIVE_TRACKER #13).
  if (rawStatus === 'unpaid' || rawStatus === 'incomplete_expired') return 'canceled';
  // 'paused' (pause-collection / subscription-schedule pause) means the user
  // is not paying: same dunning collapse as above, or the Fly Machine keeps
  // billing while no revenue comes in. Data stays safe behind the standard
  // cancellation grace window (volume retention).
  if (rawStatus === 'paused') return 'canceled';
  if (eventType === 'checkout.session.completed') return trialOffer ? 'trialing' : 'active';
  return 'inactive';
}

function isSubscriptionStatus(value: string | null): value is SubscriptionStatus {
  return value === 'inactive'
    || value === 'trialing'
    || value === 'active'
    || value === 'past_due'
    || value === 'canceled';
}

function stripeIdentifier(value: unknown): string | null {
  const direct = optionalString(value);
  if (direct) return direct;

  const record = recordOrNull(value);
  return optionalString(record?.id);
}

function stripeTimestampToIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  return optionalString(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return nonEmptyString(value);
}

// =====================================================================
// R-BILL-09 — pause-on-quota credit logic.
//
// When a user hits their token quota mid-cycle we pause the workspace.
// The user must NOT be billed for paused time. Two equivalent policies
// are accepted by the criterion:
//
//   (a) Pro-rata refund — the next invoice is reduced by
//       dailyPrice * pausedDays.
//   (b) Period extension — the next billing cycle's `current_period_end`
//       advances by `pausedDays` so the user gets the full month they
//       paid for once they upgrade (or the cycle resets).
//
// We pick (b) — operationally simpler (no Stripe credit_note round-trip)
// and matches Pricing.tsx's "we won't bill you for paused time" promise.
// The Worker's reconciler reads `pausedDays` from the usage ledger and
// patches `subscriptions.current_period_end` via the Stripe billing API.
// =====================================================================

export interface PauseCreditPolicy {
  kind: 'period_extension' | 'prorate_refund';
  /** Daily price in pence — used by the prorate path. */
  dailyPricePence: number;
  /** Number of whole days the workspace was paused this cycle. */
  pausedDays: number;
}

export function computePauseCreditAdjustment(policy: PauseCreditPolicy): {
  extendPeriodSeconds: number;
  prorateRefundPence: number;
} {
  if (policy.pausedDays <= 0) return { extendPeriodSeconds: 0, prorateRefundPence: 0 };
  if (policy.kind === 'period_extension') {
    return { extendPeriodSeconds: policy.pausedDays * 86_400, prorateRefundPence: 0 };
  }
  // prorate_refund path
  return { extendPeriodSeconds: 0, prorateRefundPence: policy.dailyPricePence * policy.pausedDays };
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
