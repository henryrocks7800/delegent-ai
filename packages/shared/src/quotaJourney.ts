// Quota-journey copy + helpers (AGENT_TODO_CHECKLIST §2.5 / Batch 4a).
//
// Single source of truth for the friendly "you've hit a cap" copy the Worker,
// the mobile app, and any connected messenger (Telegram first) all render.
//
// The exact wording in QUOTA_PAUSE_BASE_COPY mirrors AGENT_TODO_CHECKLIST §2.5
// verbatim so a one-liner copy change there stays in sync with the product.
// Per-cap variants below are operator-friendly extensions that keep the same
// shape: a calm primary line + an actionable secondary line + a typed list
// of suggested actions the rendering surface can map to its own buttons.

import type { PlanTierId } from './index.ts';

export type QuotaCapKind =
  | 'token'
  | 'storage'
  | 'voice'
  | 'concurrent'
  | 'rate'
  | 'global_spend';

export interface QuotaPauseAction {
  /** Stable action ID — renderer maps to a button / deep link. */
  readonly id:
    | 'upgrade'
    | 'manage_subscription'
    | 'view_usage'
    | 'see_reset_date'
    | 'dismiss'
    | 'free_up_storage'
    | 'wait_brief_moment';
  /** User-facing label — short, sentence case. */
  readonly label: string;
  /** Primary CTAs render as the bold action; secondary as a quieter affordance. */
  readonly tone: 'primary' | 'secondary';
}

export interface QuotaPauseResponse {
  /** The cap that fired. Used by the renderer to pick an icon / colour. */
  readonly capKind: QuotaCapKind;
  /** Stable machine-readable reason; safe to log + surface in support tickets. */
  readonly reason: string;
  /** The first user-facing line — calm, no provider names, no numbers. */
  readonly primary: string;
  /** The second line — what they can do next, also calm. */
  readonly secondary: string;
  /** Suggested actions in display order. */
  readonly actions: readonly QuotaPauseAction[];
  /** ISO timestamp of the next reset (cycle end) — empty for caps that don't reset on a schedule. */
  readonly nextResetAtIso: string | null;
  /** The tier the user is on, for "upgrade to Pro Office" framing. */
  readonly tierId: PlanTierId | null;
}

// The base copy from AGENT_TODO_CHECKLIST §2.5, kept word-for-word.
export const QUOTA_PAUSE_BASE_COPY =
  "You've used this month's included assistant time, so I've paused new tasks for now. " +
  'You can upgrade to keep going today, or wait until your next billing cycle starts.';

const TOKEN_CAP_COPY = {
  primary:
    "You've used this month's included assistant time, so I've paused new tasks for now.",
  secondary:
    'You can upgrade to keep going today, or wait until your next billing cycle starts.',
} as const;

const STORAGE_CAP_COPY = {
  primary: 'Your private cloud space is full.',
  secondary: 'Free up some files from the Files tab, or upgrade for more headroom.',
} as const;

const VOICE_CAP_COPY = {
  primary: "You've used this month's voice transcription time.",
  secondary:
    'Type your next message, upgrade for more voice minutes, or wait for the next billing cycle.',
} as const;

const CONCURRENT_CAP_COPY = {
  primary: 'A few of your tasks are still in flight.',
  secondary: 'Give the current ones a moment to finish, then try again.',
} as const;

const RATE_CAP_COPY = {
  primary: "That's a lot of messages in a short window.",
  secondary: "I've paused briefly so things stay healthy. Try again in a minute.",
} as const;

const GLOBAL_SPEND_CAP_COPY = {
  primary: "Delegent's assistant service is temporarily paused for everyone.",
  secondary: 'We expect to be back shortly. Your account is unaffected; we will not bill for paused time.',
} as const;

const ACTIONS_TOKEN: readonly QuotaPauseAction[] = [
  { id: 'upgrade', label: 'Upgrade plan', tone: 'primary' },
  { id: 'manage_subscription', label: 'Manage subscription', tone: 'secondary' },
  { id: 'view_usage', label: 'View this month’s usage', tone: 'secondary' },
  { id: 'see_reset_date', label: 'See next reset date', tone: 'secondary' },
  { id: 'dismiss', label: 'Wait for next cycle', tone: 'secondary' },
];

const ACTIONS_STORAGE: readonly QuotaPauseAction[] = [
  { id: 'free_up_storage', label: 'Free up space', tone: 'primary' },
  { id: 'upgrade', label: 'Upgrade plan', tone: 'secondary' },
  { id: 'view_usage', label: 'View what is using space', tone: 'secondary' },
];

const ACTIONS_VOICE: readonly QuotaPauseAction[] = [
  { id: 'dismiss', label: 'Type instead', tone: 'primary' },
  { id: 'upgrade', label: 'Upgrade plan', tone: 'secondary' },
  { id: 'see_reset_date', label: 'See next reset date', tone: 'secondary' },
];

const ACTIONS_TRANSIENT: readonly QuotaPauseAction[] = [
  { id: 'wait_brief_moment', label: 'Try again in a moment', tone: 'primary' },
];

/**
 * Build the QuotaPauseResponse the Worker returns to the runner and the
 * runner / mobile / Telegram render.
 *
 * `reason` is a stable machine-readable identifier (matches the Worker's
 * existing `tier_limit_exceeded`-style strings); the human-friendly copy is
 * derived from `capKind` so the wording is consistent across surfaces.
 */
export function buildQuotaPauseResponse(input: {
  capKind: QuotaCapKind;
  reason: string;
  nextResetAtIso?: string | null;
  tierId?: PlanTierId | null;
}): QuotaPauseResponse {
  const { capKind, reason } = input;
  const nextResetAtIso = input.nextResetAtIso ?? null;
  const tierId = input.tierId ?? null;

  switch (capKind) {
    case 'token':
      return {
        capKind,
        reason,
        primary: TOKEN_CAP_COPY.primary,
        secondary: TOKEN_CAP_COPY.secondary,
        actions: ACTIONS_TOKEN,
        nextResetAtIso,
        tierId,
      };
    case 'storage':
      return {
        capKind,
        reason,
        primary: STORAGE_CAP_COPY.primary,
        secondary: STORAGE_CAP_COPY.secondary,
        actions: ACTIONS_STORAGE,
        nextResetAtIso,
        tierId,
      };
    case 'voice':
      return {
        capKind,
        reason,
        primary: VOICE_CAP_COPY.primary,
        secondary: VOICE_CAP_COPY.secondary,
        actions: ACTIONS_VOICE,
        nextResetAtIso,
        tierId,
      };
    case 'concurrent':
      return {
        capKind,
        reason,
        primary: CONCURRENT_CAP_COPY.primary,
        secondary: CONCURRENT_CAP_COPY.secondary,
        actions: ACTIONS_TRANSIENT,
        nextResetAtIso: null,
        tierId,
      };
    case 'rate':
      return {
        capKind,
        reason,
        primary: RATE_CAP_COPY.primary,
        secondary: RATE_CAP_COPY.secondary,
        actions: ACTIONS_TRANSIENT,
        nextResetAtIso: null,
        tierId,
      };
    case 'global_spend':
      return {
        capKind,
        reason,
        primary: GLOBAL_SPEND_CAP_COPY.primary,
        secondary: GLOBAL_SPEND_CAP_COPY.secondary,
        actions: ACTIONS_TRANSIENT,
        nextResetAtIso: null,
        tierId,
      };
  }
}

/**
 * What the date at the end of the billing cycle means, which is not one thing.
 *
 * For a subscription that renews it is the day the allowance comes back. For a
 * subscription the reader has already cancelled, Stripe keeps sending the same
 * timestamp, but it is now the day the plan stops. Both surfaces read that one
 * field and said "Your monthly time resets on <date>" either way, so the reader
 * who had just cancelled was promised an allowance that was never coming, on
 * the screen they would go to precisely because they were watching it run down.
 *
 * Returns null if the input is missing or unparseable. Locale is fixed to en-GB
 * to match the UK-first product positioning.
 */
export function formatCycleEndLine(cycleEndAtIso: string | null, cancelAtPeriodEnd = false): string | null {
  if (!cycleEndAtIso) return null;
  const date = new Date(cycleEndAtIso);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const day = formatter.format(date);
  return cancelAtPeriodEnd
    ? `Your plan ends on ${day} and will not renew.`
    : `Your monthly time resets on ${day}.`;
}

/** Whether the plan is due to renew, due to stop, or already stopped. */
export type BillingPeriodState = 'renews' | 'ends' | 'ended';

export interface BillingPeriodSummary {
  state: BillingPeriodState;
  /** Row label for the account-details table. */
  label: string;
  /** Row value: a bare date a UK reader can read at a glance. */
  value: string;
  /** Button label when the reader needs a way back onto a plan, else null. */
  actionLabel: string | null;
  /** One line under the row explaining the consequence, else null. */
  note: string | null;
}

const BILLING_PERIOD_ACTION_RESUME = 'Resume plan';
const BILLING_PERIOD_ACTION_RESUBSCRIBE = 'Resubscribe';

/**
 * The one row a reader looks for on their profile: when does this roll over.
 *
 * 2026-07-30: the date WAS on the screen, buried in a sentence inside the
 * capacity card, so a paying customer reached the end of his month without
 * knowing it was the end of his month, and when it lapsed there was no
 * obvious way back on. A labelled row plus a named button beats a sentence.
 *
 * Three states, because one timestamp means three different things: it is the
 * day the allowance comes back, the day the plan stops, or a day in the past
 * on which the plan already stopped. Returns null when there is no usable date,
 * so a surface can drop the row rather than print a placeholder.
 */
export function summariseBillingPeriod(input: {
  cycleEndAtIso: string | null;
  cancelAtPeriodEnd?: boolean;
  now?: Date;
}): BillingPeriodSummary | null {
  if (!input.cycleEndAtIso) return null;
  const cycleEnd = new Date(input.cycleEndAtIso);
  if (Number.isNaN(cycleEnd.getTime())) return null;

  const value = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(cycleEnd);

  const now = input.now ?? new Date();
  if (cycleEnd.getTime() <= now.getTime()) {
    return {
      state: 'ended',
      label: 'Ended',
      value,
      actionLabel: BILLING_PERIOD_ACTION_RESUBSCRIBE,
      note: 'Your plan has ended. Resubscribe to pick up where you left off.',
    };
  }
  if (input.cancelAtPeriodEnd) {
    return {
      state: 'ends',
      label: 'Ends',
      value,
      actionLabel: BILLING_PERIOD_ACTION_RESUME,
      note: 'Your plan will not renew. Resume it to keep your coworker after this date.',
    };
  }
  return {
    state: 'renews',
    label: 'Renews',
    value,
    actionLabel: null,
    note: 'Renews automatically. Cancel any time from Cancel subscription on your profile.',
  };
}
