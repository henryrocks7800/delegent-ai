// Usage top-ups for agent-engine accounts: a one-off Stripe Checkout payment
// that adds to what the account can use once its monthly allowance runs out
// (Alex, 2026-09-15). The Worker creates the session; the webhook records the
// grant from the signed event. Nothing here touches a subscription.

export const USAGE_TOP_UP_KIND = 'usage_top_up';

/** Metadata the Worker writes on the session. Deliberately not `sidekickUserId`, so no subscription code, welcome email or advert event reads a top-up as a sign-up. */
export interface UsageTopUpSessionMetadata {
  kind: typeof USAGE_TOP_UP_KIND;
  topUpUserId: string;
  pricePence: string;
  tokensPerPack: string;
  validMonths: string;
}

export interface UsageTopUpGrant {
  userId: string;
  tokens: number;
  amountPence: number;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  purchasedAt: string;
  expiresAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** A Checkout session this product opened to sell a top-up. */
export function isUsageTopUpSession(object: unknown): boolean {
  const session = record(object);
  return session?.mode === 'payment' && record(session.metadata)?.kind === USAGE_TOP_UP_KIND;
}

/** The date `months` calendar months after `iso`, clamped to the month's last day. */
export function addCalendarMonths(iso: string, months: number): string {
  const start = new Date(iso);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1,
    start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target.toISOString();
}

/**
 * The grant a completed top-up session pays for, or null when it is not one we
 * can honour: unpaid, not in pounds, or an amount that is not whole packs. The
 * amount is Stripe's; the pack price and size are what the Worker wrote when it
 * opened the session, so a later price change never alters an old purchase.
 */
export function usageTopUpGrantFromSession(object: unknown, occurredAtIso: string): UsageTopUpGrant | null {
  const session = record(object);
  if (!session || !isUsageTopUpSession(session)) return null;
  if (session.payment_status !== 'paid' || session.currency !== 'gbp') return null;
  const metadata = record(session.metadata) ?? {};
  const userId = typeof metadata.topUpUserId === 'string' && UUID.test(metadata.topUpUserId) ? metadata.topUpUserId : null;
  const pricePence = positiveInteger(metadata.pricePence);
  const tokensPerPack = positiveInteger(metadata.tokensPerPack);
  const validMonths = positiveInteger(metadata.validMonths);
  const amountPence = positiveInteger(session.amount_total);
  const sessionId = typeof session.id === 'string' && session.id.startsWith('cs_') ? session.id : null;
  if (!userId || !pricePence || !tokensPerPack || !validMonths || !amountPence || !sessionId) return null;
  if (amountPence % pricePence !== 0) return null;
  const packs = amountPence / pricePence;
  if (packs > 100) return null;
  const paymentIntent = session.payment_intent;
  const paymentIntentId = typeof paymentIntent === 'string' ? paymentIntent
    : typeof record(paymentIntent)?.id === 'string' ? record(paymentIntent)!.id as string : null;
  const purchasedAt = new Date(occurredAtIso).toISOString();
  return {
    userId,
    tokens: packs * tokensPerPack,
    amountPence,
    checkoutSessionId: sessionId,
    paymentIntentId,
    purchasedAt,
    expiresAt: addCalendarMonths(purchasedAt, validMonths),
  };
}
