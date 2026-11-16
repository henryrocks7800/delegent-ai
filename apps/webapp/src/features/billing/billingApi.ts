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
import { apiFetch, isFailure } from '../../lib/api';

// The Worker answers /api/stripe/checkout with a 303 to Stripe by default, and
// with a readable `{ url }` body when the request asks for JSON. A browser
// cannot read a 303's Location header (fetch turns it into an opaque redirect),
// so the web app always takes the JSON branch and navigates itself. Mobile
// keeps using the redirect branch; nothing here changes that.

// Where Stripe sends the browser back to. The app is reachable on more than one
// origin (the custom domain, and Firebase's own domain before DNS is cut over),
// so return the user to the one they are actually using. The list is hard-coded
// and must stay in step with the Worker's SIDEKICK_CHECKOUT_REDIRECT_ORIGINS:
// using window.location.origin unchecked would mean any page that manages to
// host this bundle could name itself as the post-payment destination, and it
// would force localhost into a payment allowlist for local development.
// ORDER MATTERS: the first entry is the fallback for an unrecognised host, so it
// has to be an address that actually resolves. app.delegentai.co.uk was put
// first while it was "verifying in Firebase Hosting"; that never completed, and
// on 2026-09-22 it answered NXDOMAIN on two separate resolvers. A browser on any
// other host would have been sent to a domain that does not exist after paying.
// It stays on the list so that it works if the record is ever created, but the
// address we actually serve leads.
const RETURN_ORIGINS = ['https://delegent-app.web.app', 'https://app.delegentai.co.uk'] as const;

function returnOrigin(): string {
  const current = typeof window === 'undefined' ? '' : window.location.origin;
  return RETURN_ORIGINS.find((origin) => origin === current) ?? RETURN_ORIGINS[0];
}

// `staleSubscription` is the server telling us our copy of the account is out of
// date: it holds a live subscription and this page is still drawing buy buttons.
// The three codes that carry it all mean the same thing to a reader, and one of
// them (`subscription_recovered`) is returned only after the server has already
// repaired the record, so a second read is certain to find it.
export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; message: string; staleSubscription?: boolean; paymentRequired?: boolean };

const STALE_SUBSCRIPTION_CODES = new Set([
  'subscription_already_active',
  'subscription_recovered',
  'subscription_change_required',
]);

const GENERIC = 'We could not open the payment page. Try again in a moment.';
const SIGN_IN = 'Sign in again, then pick your plan.';
const UNAVAILABLE = 'Payments are briefly unavailable. Try again in a few minutes.';

function checkoutMessage(code: string | null, status: number): string {
  const notice = purchaseCoordinationNotice(code);
  if (notice) return notice.message;
  if (code === 'subscription_payment_required') return 'Your payment did not go through. Open Manage billing to update your payment method and resume.';
  if (code === 'unauthenticated' || status === 401) return SIGN_IN;
  if (code === 'subscription_already_active' || code === 'subscription_recovered') {
    return 'You already have this plan. Refresh to see it.';
  }
  if (code === 'subscription_change_required') {
    return 'You already have a plan. Use Manage billing to change it.';
  }
  if (code === 'stripe_checkout_unavailable' || code === 'stripe_checkout_failed' || status === 503) return UNAVAILABLE;
  return GENERIC;
}

function readUrl(data: unknown): string | null {
  const value = (data as { url?: unknown } | null)?.url;
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    // Only ever hand the browser a real Stripe page. The Worker validates this
    // too; repeating it here means a compromised response cannot redirect a
    // signed-in user somewhere arbitrary.
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'checkout.stripe.com' && parsed.hostname !== 'billing.stripe.com') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function startCheckout(tierId: PlanTierId): Promise<CheckoutResult> {
  const result = await apiFetch<{ url?: unknown }>('/api/stripe/checkout', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: {
      tierId,
      successUrl: `${returnOrigin()}/plan?checkout=success`,
      cancelUrl: `${returnOrigin()}/plan?checkout=cancel`,
    },
  });
  if (isFailure(result)) {
    return {
      ok: false,
      message: checkoutMessage(result.serverCode, result.status),
      staleSubscription: result.serverCode !== null && STALE_SUBSCRIPTION_CODES.has(result.serverCode),
      paymentRequired: result.serverCode === 'subscription_payment_required',
    };
  }
  const url = readUrl(result.data);
  return url ? { ok: true, url } : { ok: false, message: GENERIC };
}

/**
 * Naming a `targetTierId` is what turns this from "manage my billing" into
 * "change my plan". Without one the Worker opens the plain portal, which our
 * Stripe configuration allows to cancel and nothing else, so an upgrade pressed
 * there quietly goes nowhere. With one, an upgrade deep-links to Stripe's
 * confirm page and a downgrade is scheduled server-side for the renewal date
 * and never opens Stripe at all.
 */
export type PortalResult =
  | { ok: true; kind: 'redirect'; url: string }
  | { ok: true; kind: 'canceled' }
  | { ok: true; kind: 'scheduled'; message: string }
  // `storageBlocked` is not a failure to reach anything. The server refused the
  // downgrade because the reader's files will not fit in the smaller plan, and
  // a page that frames that as an error is telling them to try again when the
  // thing to do is in Files.
  | { ok: false; message: string; storageBlocked?: boolean };

type PortalBody = {
  url?: unknown;
  scheduled?: unknown;
  targetTierId?: unknown;
  effectiveAt?: unknown;
};

// Null rather than a wording, so the fallback lives once in the shared copy
// instead of once per surface.
function tierShortName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return getPlanTier(value as PlanTierId).shortName;
  } catch {
    return null;
  }
}

function overLimitMessage(body: unknown): string {
  const detail = (body ?? {}) as { currentStorageBytes?: unknown; targetStorageBytes?: unknown; targetTierId?: unknown };
  return storageDowngradeBlockBody({
    targetTierShortName: tierShortName(detail.targetTierId),
    currentStorageBytes: detail.currentStorageBytes,
    targetStorageBytes: detail.targetStorageBytes,
  });
}

export async function openBillingPortal(targetTierId: PlanTierId | null = null,
  confirmScheduledChange?: () => boolean | Promise<boolean>): Promise<PortalResult> {
  const send = (confirmation?: ScheduledPlanChangeConfirmation) => apiFetch<PortalBody>('/api/stripe/portal', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: { returnUrl: `${returnOrigin()}/plan?billing=done`, targetTierId,
      ...(confirmation ? { scheduledChangeConfirmation: confirmation } : {}) },
  });
  let result = await send();
  if (isFailure(result) && result.serverCode === 'billing_scheduled_change_confirmation_required') {
    const body = result.body as { confirmation?: unknown } | null;
    const confirmation = parseScheduledPlanChangeConfirmation(body?.confirmation);
    if (!confirmation || !targetTierId || !confirmScheduledChange) return { ok: false, message: GENERIC };
    let confirmed = false;
    try { confirmed = await confirmScheduledChange() === true; } catch { /* Dismissed/unavailable prompt keeps the schedule. */ }
    if (!confirmed) return { ok: true, kind: 'canceled' };
    // The server binds acknowledgement to the original account and action.
    // A changed account/plan cannot use it to open another flow or downgrade.
    result = await send(confirmation);
  }
  if (isFailure(result)) {
    if (result.serverCode === 'billing_scheduled_change_changed' || result.serverCode === 'billing_scheduled_change_confirmation_required') {
      return { ok: false, message: SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE };
    }
    if (result.serverCode === 'downgrade_storage_over_limit') {
      return { ok: false, message: overLimitMessage(result.body), storageBlocked: true };
    }
    // Two different refusals. Only the first means there is nothing to bill
    // against; the second belongs to someone who already pays us and whose
    // subscription record has not caught up, for whom "pick a plan first" is
    // both untrue and a round trip back to the plan they are already on.
    if (result.serverCode === 'billing_customer_required') {
      return { ok: false, message: BILLING_CUSTOMER_REQUIRED_MESSAGE };
    }
    if (result.serverCode === 'billing_subscription_required') {
      return { ok: false, message: BILLING_SUBSCRIPTION_SYNCING_MESSAGE };
    }
    return { ok: false, message: checkoutMessage(result.serverCode, result.status) };
  }

  // A downgrade is not a redirect. It is booked for the end of the month the
  // reader has already paid for, so they keep what they bought until then, and
  // sending them to Stripe afterwards would only offer to cancel.
  if (result.data.scheduled === true) {
    return {
      ok: true,
      kind: 'scheduled',
      message: downgradeScheduledMessage({
        targetTierShortName: tierShortName(result.data.targetTierId),
        effectiveAt: typeof result.data.effectiveAt === 'string' ? result.data.effectiveAt : null,
      }),
    };
  }

  const url = readUrl(result.data);
  return url ? { ok: true, kind: 'redirect', url } : { ok: false, message: GENERIC };
}
