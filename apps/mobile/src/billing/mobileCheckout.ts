import {
  getPlanTier,
  purchaseCoordinationNotice,
  parseScheduledPlanChangeConfirmation,
  SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE,
  type ScheduledPlanChangeConfirmation,
  BILLING_CUSTOMER_REQUIRED_MESSAGE,
  BILLING_SUBSCRIPTION_SYNCING_MESSAGE,
  storageDowngradeBlockBody,
  downgradeScheduledMessage,
  type PlanTierId,
} from '@sidekick/shared';
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';

declare const process: {
  env: Record<string, string | undefined>;
};

type MobileSessionClient = {
  auth: {
    getSession(): Promise<{
      data?: {
        session?: {
          access_token?: string | null;
          expires_at?: number | null;
        } | null;
      } | null;
      error?: unknown;
    }>;
    refreshSession?(): Promise<{
      data?: {
        session?: {
          access_token?: string | null;
          expires_at?: number | null;
        } | null;
      } | null;
      error?: unknown;
    }>;
  };
};

// `managed_elsewhere` is NOT a failure and must not be titled like one. It is
// the permanent, correct answer for an iOS build when the account already pays
// through another provider. It was folded into 'unavailable' until 2026-08-19,
// which put the accurate message "This account already has a subscription
// billed outside the App Store" under the title "Checkout is temporarily
// offline" — telling a customer to come back later for something that will
// never change, and inviting a retry that can never succeed.
/**
 * `purchase_confirming` is the odd one out: it is NOT a failure.
 *
 * It means Apple took the money and our entitlement read had not caught up
 * before the post-purchase poller ran out. Every other reason here describes
 * something that did not happen; this one describes something that DID happen
 * and is merely still settling. It exists because the only other honest-looking
 * reason, `unavailable`, renders as "Checkout is temporarily offline" — which
 * to someone who has just been charged reads as "your payment failed", and
 * invites a second purchase attempt.
 *
 * Only App.tsx's StoreKit branch raises it. `checkoutError()` never returns it,
 * because the Stripe path has no equivalent moment.
 *
 * `owned_by_another_account` is likewise StoreKit-only, and likewise not a
 * failure: the Apple ID holds the subscription, just against a different
 * Delegent account. It must not render as an outage, because waiting and
 * tapping again produces the identical result forever.
 */
export type MobileCheckoutErrorReason = 'missing_api_base' | 'unauthenticated' | 'unavailable' | 'unreachable' | 'checkout_refused' | 'plan_change_required' | 'subscription_recovered' | 'managed_elsewhere' | 'purchase_confirming' | 'owned_by_another_account' | 'payment_required' | 'purchase_pending' | 'purchase_requires_review';
export type MobileBillingPortalErrorReason = 'missing_api_base' | 'unauthenticated' | 'unavailable' | 'billing_customer_required' | 'billing_subscription_required' | 'downgrade_storage_over_limit';

export type MobileCheckoutSession = {
  tierId: PlanTierId;
  url: string;
};

export type MobileBillingPortalSession = {
  url: string;
};

// A downgrade the worker deferred to the next renewal boundary (the plan is
// never shrunk mid-cycle). There is no browser hand-off; the app shows the
// prebuilt `message` as a calm confirmation and keeps the user where they are.
export type MobileDowngradeScheduled = {
  targetTierId: PlanTierId | null;
  currentTierId: PlanTierId | null;
  effectiveAt: string | null;
  message: string;
};

export type MobileCheckoutResult =
  | { checkout: MobileCheckoutSession }
  | { error: { reason: MobileCheckoutErrorReason; message: string; currentTierId?: PlanTierId; requestedTierId?: PlanTierId } };

export type MobileBillingPortalResult =
  | { portal: MobileBillingPortalSession }
  | { canceled: true }
  | { scheduled: MobileDowngradeScheduled }
  | { error: { reason: MobileBillingPortalErrorReason; message: string } };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MobileCheckoutRequestOptions = {
  tierId: PlanTierId;
  apiBaseUrl?: string | null;
  successUrl?: string | null;
  cancelUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

export type MobileBillingPortalRequestOptions = {
  confirmScheduledChange?: () => boolean | Promise<boolean>;
  apiBaseUrl?: string | null;
  returnUrl?: string | null;
  targetTierId?: PlanTierId | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

const CHECKOUT_PATH = '/api/stripe/checkout';
const BILLING_PORTAL_PATH = '/api/stripe/portal';
const CHECKOUT_SUCCESS_PATH = '/checkout/success';
const CHECKOUT_CANCEL_PATH = '/checkout/cancel';
const BILLING_PORTAL_RETURN_PATH = '/account/billing';
const MOBILE_CHECKOUT_TOKEN_REFRESH_SKEW_SECONDS = 60;
const MOBILE_CHECKOUT_REQUEST_TIMEOUT_MS = 15000;

// Expo statically inlines direct `process.env.EXPO_PUBLIC_*` member reads into
// the native JS bundle. Keep this as a direct read and never expose server-only
// Stripe/Supabase values in mobile code.
const expoPublicSidekickApiBaseUrl =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

export const mobileCheckoutApiBaseUrl = normalizePublicApiBaseUrl(expoPublicSidekickApiBaseUrl);

function mobileSessionNeedsRefresh(session: { expires_at?: number | null } | null | undefined): boolean {
  if (!session || typeof session.expires_at !== 'number') return true;
  const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_CHECKOUT_TOKEN_REFRESH_SKEW_SECONDS;
}

async function getFreshAccessTokenFromClient(client: MobileSessionClient): Promise<string | null> {
  let session: { access_token?: string | null; expires_at?: number | null } | null = null;
  try {
    const current = await client.auth.getSession();
    if (!current.error) session = current.data?.session ?? null;
  } catch {
    session = null;
  }

  if (mobileSessionNeedsRefresh(session) && client.auth.refreshSession) {
    try {
      const refreshed = await client.auth.refreshSession();
      if (!refreshed.error) session = refreshed.data?.session ?? session;
    } catch {
      // The server 401 branch below still converts stale tokens to a sign-in
      // recovery message without leaking provider details.
    }
  }

  return nonEmptyString(session?.access_token);
}

async function getMobileAccessToken(client: MobileSessionClient | null | undefined): Promise<string | null> {
  if (!client && !mobileSupabase) return null;

  let accessToken: string | null = null;
  try {
    accessToken = client
      ? await getFreshAccessTokenFromClient(client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }

  return accessToken ?? getRememberedMobileAccessToken();
}

async function withMobileCheckoutTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs = MOBILE_CHECKOUT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller?.abort();
      reject(new Error('mobile_checkout_timeout'));
    }, timeoutMs);

    operation(controller?.signal)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export async function requestStripeCheckout(options: MobileCheckoutRequestOptions): Promise<MobileCheckoutResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileCheckoutApiBaseUrl);
  if (!apiBaseUrl) return checkoutError('missing_api_base');

  const accessToken = await getMobileAccessToken(options.client);
  if (!accessToken) return checkoutError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  const successUrl = normalizeCheckoutReturnUrl(options.successUrl) ?? `${apiBaseUrl}${CHECKOUT_SUCCESS_PATH}`;
  const cancelUrl = normalizeCheckoutReturnUrl(options.cancelUrl) ?? `${apiBaseUrl}${CHECKOUT_CANCEL_PATH}`;

  try {
    const response = await withMobileCheckoutTimeout((signal) => fetcher(buildMobileCheckoutUrl(apiBaseUrl), {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        tierId: options.tierId,
        successUrl,
        cancelUrl,
      }),
    }));

    if (response.status === 401) return checkoutError('unauthenticated');
    if (response.status === 409) {
      const payload = await response.json().catch(() => null);
      return checkoutConflictError(payload, options.tierId);
    }

    const redirectedUrl = safeStripeCheckoutUrl(response.headers.get('location'));
    if ((response.status === 302 || response.status === 303) && redirectedUrl) {
      return { checkout: { tierId: options.tierId, url: redirectedUrl } };
    }

    const payload = await response.json().catch(() => null);
    const notice = purchaseCoordinationNotice(isRecord(payload) ? payload.error : null);
    if (!response.ok && notice) return { error: notice };
    const payloadUrl = isRecord(payload) ? safeStripeCheckoutUrl(payload.url) ?? safeStripeCheckoutUrl(payload.checkoutUrl) : null;
    if (response.ok && payloadUrl) return { checkout: { tierId: options.tierId, url: payloadUrl } };

    return checkoutError('unavailable');
  } catch {
    // A thrown fetch means the request never reached us (network block, captive
    // portal, or timeout) rather than a server error. Common on locked-down
    // work / NHS networks that block *.workers.dev. Point the user at the fix.
    return checkoutError('unreachable');
  }
}

export async function requestStripeBillingPortal(options: MobileBillingPortalRequestOptions = {}): Promise<MobileBillingPortalResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileCheckoutApiBaseUrl);
  if (!apiBaseUrl) return billingPortalError('missing_api_base');

  const accessToken = await getMobileAccessToken(options.client);
  if (!accessToken) return billingPortalError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  const returnUrl = normalizeCheckoutReturnUrl(options.returnUrl) ?? `${apiBaseUrl}${BILLING_PORTAL_RETURN_PATH}`;

  try {
    const send = (confirmation?: ScheduledPlanChangeConfirmation) => withMobileCheckoutTimeout((signal) => fetcher(buildMobileBillingPortalUrl(apiBaseUrl), {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ returnUrl, targetTierId: options.targetTierId ?? null,
        ...(confirmation ? { scheduledChangeConfirmation: confirmation } : {}) }),
    }));

    // At most one confirmed retry, using the token captured before the prompt.
    let response = await send();
    if (response.status === 409) {
      const payload = await response.clone().json().catch(() => null);
      if (isRecord(payload) && payload.error === 'billing_scheduled_change_confirmation_required') {
        const confirmation = parseScheduledPlanChangeConfirmation(payload.confirmation);
        if (!confirmation || !options.targetTierId || !options.confirmScheduledChange) return billingPortalError('unavailable');
        if (await options.confirmScheduledChange() !== true) return { canceled: true };
        response = await send(confirmation);
      }
    }

    if (response.status === 401) return billingPortalError('unauthenticated');
    if (response.status === 409) {
      const payload = await response.json().catch(() => null);
      if (isRecord(payload) && (payload.error === 'billing_scheduled_change_changed'
        || payload.error === 'billing_scheduled_change_confirmation_required')) {
        return { error: { reason: 'unavailable', message: SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE } };
      }
      // A downgrade blocked because the target plan's storage is smaller than
      // what the user is currently storing. This is a soft block, not a
      // failure: it points the reader at Files and never opens the browser.
      // The wording is shared with the browser; see checkoutNotices.ts.
      if (isRecord(payload) && payload.error === 'downgrade_storage_over_limit') {
        return downgradeStorageBlockResult(payload);
      }
      return billingPortalError(isRecord(payload) && payload.error === 'billing_subscription_required'
        ? 'billing_subscription_required'
        : 'billing_customer_required');
    }

    const redirectedUrl = safeStripeBillingPortalUrl(response.headers.get('location'));
    if ((response.status === 302 || response.status === 303) && redirectedUrl) {
      return { portal: { url: redirectedUrl } };
    }

    const payload = await response.json().catch(() => null);
    // Downgrade scheduled for the next renewal: the worker returns a JSON body
    // (NOT a portal URL) so a paid tier is never shrunk mid-cycle. Show a calm
    // confirmation and never hand off to the browser.
    if (response.ok && isRecord(payload) && payload.scheduled === true) {
      return downgradeScheduledResult(payload);
    }
    const payloadUrl = isRecord(payload) ? safeStripeBillingPortalUrl(payload.url) ?? safeStripeBillingPortalUrl(payload.portalUrl) : null;
    if (response.ok && payloadUrl) return { portal: { url: payloadUrl } };

    // [#14 billing-not-ready diagnostics] When a non-OK or unexpected
    // response lands, log the status + body hint so the next test
    // cycle on the emulator surfaces the actual cause instead of the
    // generic "Billing is not ready". The log target is the JS console
    // which logcat captures (`adb logcat | grep delegent`).
    const errCode = isRecord(payload) ? String((payload as { error?: unknown }).error ?? '') : '';
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[delegent-billing] portal unavailable status=${response.status} bodyError=${errCode}`);
    }
    // Also surface the worker's exact status + error code in the
    // user-facing message so Alex / users can report the precise
    // failure without us having to ask for logs.
    return billingPortalError('unavailable', { status: response.status, errCode });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[delegent-billing] portal threw err=${errMessage}`);
    }
    return billingPortalError('unavailable', { networkError: errMessage.slice(0, 60) });
  }
}

export function buildMobileCheckoutUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${CHECKOUT_PATH}`;
}

export function buildMobileBillingPortalUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${BILLING_PORTAL_PATH}`;
}

export function normalizePublicApiBaseUrl(raw: string | null | undefined): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.protocol === 'https:') return parsed.origin;
    if (parsed.protocol === 'http:' && isLocalDevelopmentHost(parsed.hostname)) return parsed.origin;
    return null;
  } catch {
    return null;
  }
}

function normalizeCheckoutReturnUrl(raw: string | null | undefined): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && isLocalDevelopmentHost(parsed.hostname)) return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

export function safeStripeCheckoutUrl(raw: unknown): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.hostname !== 'checkout.stripe.com') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function safeStripeBillingPortalUrl(raw: unknown): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.hostname !== 'billing.stripe.com') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function checkoutError(
  reason: MobileCheckoutErrorReason,
  context: { currentTierId?: PlanTierId | null; requestedTierId?: PlanTierId | null } = {},
): MobileCheckoutResult {
  const currentTierName = context.currentTierId ? safePlanName(context.currentTierId) : null;
  const requestedTierName = context.requestedTierId ? safePlanName(context.requestedTierId) : null;
  const message: Record<MobileCheckoutErrorReason, string> = {
    purchase_pending: purchaseCoordinationNotice('purchase_pending')!.message,
    purchase_requires_review: purchaseCoordinationNotice('purchase_requires_review')!.message,
    payment_required: 'Your payment did not go through. Update your payment method in Manage billing to resume Delegent AI.',
    missing_api_base: 'This app build is missing the checkout API link. Update the app or try again from the live app.',
    unauthenticated: 'Sign in again, then choose your plan.',
    unavailable: 'Checkout is temporarily unavailable on our side. Try again in a moment.',
    // Reached only on an iOS StoreKit build. Names no website and no price, so
    // it stays inside what Apple allows an app to say about billing that
    // happens elsewhere.
    managed_elsewhere: 'This account already has a subscription billed outside the App Store, so there is nothing to buy here. Manage it where you started it.',
    unreachable: "We couldn't reach the app just now. If you're on a work or NHS network, it may be blocking us, so please try again on mobile data (4G/5G) or home wifi.",
    checkout_refused: currentTierName
      ? `You're already subscribed to ${currentTierName}. Refresh if this looks wrong.`
      : 'Your current plan is already active. Refresh if this looks wrong.',
    plan_change_required: currentTierName && requestedTierName
      ? `You're subscribed to ${currentTierName}. Open billing to change to ${requestedTierName}.`
      : 'Open billing to change your plan.',
    subscription_recovered: currentTierName
      ? `Good news, your ${currentTierName} subscription is already active. Refreshing now.`
      : 'Good news, your subscription is already active. Refreshing now.',
    // Unreachable via checkoutError(): only the StoreKit branch raises this,
    // and it writes its own message. Present so the map stays exhaustive.
    purchase_confirming: 'Your payment went through and we are still confirming it. Reopen the app in a moment.',
    // Unreachable via checkoutError(): StoreKit-only, and it writes its own
    // message naming the account. Present so the map stays exhaustive.
    owned_by_another_account: 'Your Apple ID already has a subscription on a different account.',
  };

  const error: Extract<MobileCheckoutResult, { error: unknown }>['error'] = { reason, message: message[reason] };
  if (context.currentTierId) error.currentTierId = context.currentTierId;
  if (context.requestedTierId) error.requestedTierId = context.requestedTierId;
  return { error };
}

function billingPortalError(
  reason: MobileBillingPortalErrorReason,
  diagnostic?: { status?: number; errCode?: string; networkError?: string },
): MobileBillingPortalResult {
  const message: Record<MobileBillingPortalErrorReason, string> = {
    missing_api_base: 'Billing needs the app link before it can start.',
    unauthenticated: 'Sign in again, then manage your plan.',
    unavailable: "Couldn't open billing right now. Try again in a moment.",
    billing_customer_required: BILLING_CUSTOMER_REQUIRED_MESSAGE,
    billing_subscription_required: BILLING_SUBSCRIPTION_SYNCING_MESSAGE,
    // Fallback only; the real, itemised copy is built in downgradeStorageBlockResult.
    // Same shared builder with nothing to itemise, so the two cannot diverge.
    downgrade_storage_over_limit: storageDowngradeBlockBody({
      targetTierShortName: null,
      currentStorageBytes: null,
      targetStorageBytes: null,
    }),
  };

  // PREOP-C05: never surface a raw HTTP status / server error code to the
  // user on the billing/upgrade path. The operator saw a bare "502" because
  // the status was appended here. The status + server code are already
  // captured for diagnosis in the call-site console.error (and Sentry), so
  // the user-facing copy stays clean and reassuring. `diagnostic` is kept in
  // the signature for callers + future structured telemetry, never rendered.
  void diagnostic;
  return { error: { reason, message: message[reason] } };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkoutConflictError(payload: unknown, requestedTierId: PlanTierId): MobileCheckoutResult {
  if (!isRecord(payload)) return checkoutError('unavailable');
  const notice = purchaseCoordinationNotice(payload.error);
  if (notice) return { error: notice };

  const currentTierId = parsePlanTierId(payload.currentTierId);
  const responseRequestedTierId = parsePlanTierId(payload.requestedTierId) ?? requestedTierId;
  if (payload.error === 'subscription_payment_required') return checkoutError('payment_required', { currentTierId, requestedTierId: responseRequestedTierId });
  if (payload.error === 'subscription_change_required') {
    return checkoutError('plan_change_required', { currentTierId, requestedTierId: responseRequestedTierId });
  }
  // R-FIX-2026-05-21 — Worker reconciled a missed Stripe webhook and now
  // says we're already subscribed. Mobile must refresh product state
  // instead of opening Chrome; the App-side checkout-result handler
  // treats this reason as "show a transient toast + reload snapshot".
  if (payload.error === 'subscription_recovered') {
    return checkoutError('subscription_recovered', { currentTierId, requestedTierId: responseRequestedTierId });
  }

  return payload.error === 'subscription_already_active'
    ? checkoutError('checkout_refused', { currentTierId, requestedTierId: responseRequestedTierId })
    : checkoutError('unavailable');
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

function safePlanName(tierId: PlanTierId): string {
  try {
    return getPlanTier(tierId).name;
  } catch {
    return 'your current plan';
  }
}

// Null rather than a wording, so the fallback lives once in the shared copy
// instead of once per surface.
function planShortNameOrNull(tierId: PlanTierId | null): string | null {
  if (!tierId) return null;
  try {
    return getPlanTier(tierId).shortName;
  } catch {
    return null;
  }
}

function downgradeScheduledResult(payload: Record<string, unknown>): MobileBillingPortalResult {
  const targetTierId = parsePlanTierId(payload.targetTierId);
  const currentTierId = parsePlanTierId(payload.currentTierId);
  const effectiveAt = nonEmptyString(payload.effectiveAt);
  const message = downgradeScheduledMessage({
    targetTierShortName: planShortNameOrNull(targetTierId),
    effectiveAt,
  });

  return { scheduled: { targetTierId, currentTierId, effectiveAt, message } };
}

function downgradeStorageBlockResult(payload: Record<string, unknown>): MobileBillingPortalResult {
  const message = storageDowngradeBlockBody({
    targetTierShortName: planShortNameOrNull(parsePlanTierId(payload.targetTierId)),
    currentStorageBytes: payload.currentStorageBytes,
    targetStorageBytes: payload.targetStorageBytes,
  });

  return { error: { reason: 'downgrade_storage_over_limit', message } };
}

function isLocalDevelopmentHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const secondOctet = Number.parseInt(match[1], 10);
  return secondOctet >= 16 && secondOctet <= 31;
}
