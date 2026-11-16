// What a surface says between checkout returning and the plan appearing.
//
// Stripe redirects the buyer back the moment the payment succeeds, but the
// entitlement is written by the webhook, which lands a beat later on its own
// schedule. Read product state once on return and the answer is usually still
// "no plan", so someone who has just been charged lands on a page offering to
// sell them the thing they bought. Both surfaces poll through that window, and
// this is the shared schedule and wording they poll with.

// Twelve reads, 1.8s apart: about twenty seconds of patience, which covers the
// webhook comfortably without leaving anyone watching a spinner if it never
// arrives at all.
export const CHECKOUT_CONFIRMATION_POLL_ATTEMPTS = 12;
export const CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS = 1800;

// A return URL does not prove a charge, and free trials collect no payment.
export const CHECKOUT_CONFIRMING_MESSAGE = 'Confirming your subscription.';

/** A coordinated purchase refusal is neither an active plan nor a failed charge. */
export function purchaseCoordinationNotice(code: unknown): {
  reason: 'purchase_pending' | 'purchase_requires_review'; message: string;
} | null {
  if (code === 'purchase_pending') return { reason: 'purchase_pending',
    message: 'A purchase is already in progress. Finish it or wait for it to settle before starting another.' };
  if (code === 'subscription_payment_pending') return { reason: 'purchase_pending',
    message: 'Your purchase is being confirmed. Please wait for your plan to appear before buying again.' };
  if (code === 'purchase_requires_review' || code === 'purchase_conflict') return { reason: 'purchase_requires_review',
    message: 'A previous purchase needs checking. Contact customer82@example.com before making another purchase.' };
  return null;
}

// Said only after the poll gives up. It has to do three things at once: not
// frighten someone whose money has left their account, not claim the plan is
// active when this surface cannot see that it is, and name no button, since the
// phone offers a retry and the browser offers a reload.
export const CHECKOUT_CONFIRMATION_SLOW_MESSAGE =
  'Your subscription has not appeared here yet, which is usually a short delay. Check back in a minute, and contact support if it still is not showing.';

// The same wait, reached from the other direction: the reader pressed a buy
// button and the server refused it because this account already holds a plan
// our copy of the state has not caught up with. It runs the identical poll, so
// it used to borrow the identical wording, and told someone who had just been
// refused a purchase that their payment had been received. Nothing was charged
// in that press. The phone says "Your plan is already active" for the same
// server answer; these are the browser saying it while it goes and looks.
export const SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING = 'Your plan is already active. Fetching it.';
export const SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE =
  'Your plan is already active, but it has not appeared here yet, which is usually a short delay. Check back in a minute, and contact support if it still is not showing.';

// The line under a change-plan button, which is not the same promise in both
// directions. An upgrade goes through Stripe's portal, which prices the rest of
// the month itself and shows the figure before the reader confirms. A downgrade
// never reaches that flow: it is booked for the end of the period already paid
// for and `scheduleSubscriptionDowngradeAtPeriodEnd` sets
// `proration_behavior: 'none'` deliberately, so no credit is issued and nothing
// changes today. The phone said "Stripe pro-rates the difference" for both,
// which offered a downgrading reader a refund that was never coming.
export const PLAN_UPGRADE_PRORATION_NOTE = 'Stripe pro-rates the difference';
export const PLAN_DOWNGRADE_TIMING_NOTE = 'Starts at your next renewal, nothing changes today';

export function planChangeNote(isDowngrade: boolean): string {
  return isDowngrade ? PLAN_DOWNGRADE_TIMING_NOTE : PLAN_UPGRADE_PRORATION_NOTE;
}

// What the monthly-capacity destination says when there is no allowance behind
// it. The browser already refused to draw a meter for a plan the reader does
// not have; the phone drew the whole card, defaulting the tier lookup to Studio,
// so someone with no subscription read a "Studio" badge, Studio's "Best for"
// line and an empty bar telling them they had plenty of room.
export const CAPACITY_NO_ALLOWANCE_TITLE = 'There is no allowance to show yet.';
export const CAPACITY_NO_ALLOWANCE_BODY =
  'Choose a plan and this page starts tracking what you have used each month.';
export const CAPACITY_NO_ALLOWANCE_CTA = 'See the plans';

// A downgrade the server refuses because the reader's files will not fit in the
// smaller plan is not a failure to open anything. The phone put it under
// "Couldn't open the billing page", which says something broke and invites a
// retry that can never clear it; the answer is in Files, not in a second tap.
export const STORAGE_DOWNGRADE_BLOCK_TITLE = 'Free up space to move down a plan';

// The two 409s the portal answers with when it will not change a plan. They are
// not the same situation and must not be answered with the same sentence: the
// first means there is no Stripe customer at all, the second means there is one
// and the subscription behind it has not finished syncing. The browser said
// "There is no billing account yet. Pick a plan first." to both, which for the
// second is untrue and sends someone who already pays us back to the plan
// picker, where the only thing on offer is the plan they are already on.
export const BILLING_CUSTOMER_REQUIRED_MESSAGE = 'Choose a plan first, then billing can manage changes.';
export const BILLING_SUBSCRIPTION_SYNCING_MESSAGE =
  'Your current subscription needs to finish syncing before billing can change the plan.';

const FRIENDLY_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// UTC, because this is a billing boundary rather than an appointment: a date
// that shifts with the reader's timezone would disagree with the invoice. Built
// by hand rather than through `toLocaleDateString`, because React Native's
// Hermes engine ships without full Intl and would answer the phone differently.
export function friendlyBillingDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  const month = FRIENDLY_MONTH_NAMES[parsed.getUTCMonth()];
  if (!month) return null;
  return `${parsed.getUTCDate()} ${month} ${parsed.getUTCFullYear()}`;
}

// Whole gigabytes carry no decimal (80 GB); anything smaller keeps one place
// (2.5 GB), so the figure stays meaningful without reading as machine output.
export function formatStorageGb(bytes: unknown): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  const size = bytes / 1024 ** 3;
  const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} GB`;
}

// Both surfaces take a tier's short name rather than its id, because resolving
// one needs `getPlanTier` from the package root and importing that here would
// close a cycle. A null name means the lookup failed, not that none was sent.
export function storageDowngradeBlockBody(detail: {
  targetTierShortName: string | null;
  currentStorageBytes: unknown;
  targetStorageBytes: unknown;
}): string {
  const name = detail.targetTierShortName ?? 'the smaller plan';
  const using = formatStorageGb(detail.currentStorageBytes);
  const includes = formatStorageGb(detail.targetStorageBytes);
  const usingPart = using ? `You're using ${using}. ` : '';
  const includesPart = includes ? `${name} includes ${includes}. ` : '';
  return `${usingPart}${includesPart}Free up space in Files before switching to ${name}. We never delete your files.`;
}

// A booked downgrade, which is the one plan change that never opens Stripe. The
// reassurance is the point: nothing is taken away on the day it is agreed.
export function downgradeScheduledMessage(detail: {
  targetTierShortName: string | null;
  effectiveAt: string | null | undefined;
}): string {
  const name = detail.targetTierShortName ?? 'your new plan';
  const when = friendlyBillingDate(detail.effectiveAt);
  return when
    ? `Your plan changes to ${name} on ${when}. You keep everything you have until then.`
    : `Your plan changes to ${name} at your next renewal. You keep everything you have until then.`;
}

export type CheckoutSurface = 'app' | 'web';

export const SCHEDULED_PLAN_CHANGE_CONFIRMATION = {
  title: 'Replace your scheduled plan change?',
  body: 'Continuing removes your scheduled change now, even if you leave Stripe without completing the upgrade. Your current plan stays in place until another change takes effect.',
  cancelLabel: 'Keep scheduled change',
  confirmLabel: 'Remove and continue',
} as const;

export const SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE = 'This confirmation is no longer current. Refresh your plan and try again.';

export type ScheduledPlanChangeConfirmation = { token: string; expiresAt: number };

export function parseScheduledPlanChangeConfirmation(value: unknown): ScheduledPlanChangeConfirmation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  // The server owns expiry. Do not rely on the phone or browser clock.
  return typeof candidate.token === 'string' && /^[a-f0-9]{64}$/.test(candidate.token)
    && typeof candidate.expiresAt === 'number' && Number.isSafeInteger(candidate.expiresAt) && candidate.expiresAt > 0
    ? { token: candidate.token, expiresAt: candidate.expiresAt } : null;
}

// Said once the subscription really is visible. The wait it describes is the
// workspace build, not the payment, so it quotes the same upper bound the
// provisioning notice does.
export function checkoutThankYouBody(tierName: string | null | undefined, surface: CheckoutSurface): string {
  const leave = surface === 'web' ? 'close this tab' : 'close the app';
  const opening = tierName ? `You're on the ${tierName} plan.` : 'Your plan is active.';
  return `${opening} We're spinning up your private workspace, this usually takes a few minutes, sometimes up to ten. You can ${leave}; we'll keep going.`;
}
