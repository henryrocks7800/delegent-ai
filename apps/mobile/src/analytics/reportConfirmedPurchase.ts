// One call site for "a purchase just completed", so both billing paths report
// the same thing the same way, to every destination.
//
// Both platforms need it and for different reasons:
//   apple  StoreKit, confirmed by the Worker's /api/apple/iap/verify
//   stripe Android and web, confirmed when checkout returns success
//
// Only a provider-confirmed positive payment is revenue. A free trial, restore,
// or missing amount must never be replaced with a guessed catalogue price.
//
// ⚠️ FIREBASE USED TO BYPASS THIS ENTIRELY, and that is the defect this file
// now closes. `advanceToHomeAfterSubscription` emitted a GA4 `purchase` with
// the tier's LIST PRICE from the catalogue, with no receipt, no amount from the
// biller and no transaction id. So a customer on the 2.99 introductory coupon
// was reported as 9.99, a returning subscriber whose checkout was refused for
// already being active was reported as a purchase, and calling the callback
// twice reported it twice. Google Ads imports that event and optimises on its
// value, so every one of those is the optimiser being trained on fiction.
//
// Decision logic only, the same split as metaPurchase.ts and its client: this
// file must stay loadable without react-native so it can be executed under tsx.
// The device halves (AsyncStorage, the Meta logger, the GA4 tracker) are
// supplied by reportConfirmedPurchaseClient.ts.
import { SIDEKICK_PLAN_TIERS, type PlanTierId } from '@sidekick/shared';

import { buildPurchaseParams } from './firebaseAnalytics';
import type { PurchaseFacts, ReportPurchaseOutcome } from './metaPurchase';

/**
 * The purchases already reported, so a retry, a restore or a second foreground
 * cannot report the same money twice.
 *
 * Bounded, and keyed on the biller's own transaction id rather than anything we
 * invent, because the whole point is to survive a process restart.
 */
export const REPORTED_PURCHASES_STORAGE_KEY = 'delegent.analytics.reportedPurchases.v1';
const REPORTED_PURCHASES_KEPT = 20;

interface PurchaseLedgerStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown> | unknown;
}

async function alreadyReported(storage: PurchaseLedgerStorage, id: string): Promise<boolean> {
  try {
    const raw = await storage.getItem(REPORTED_PURCHASES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.includes(id);
  } catch {
    // A ledger we cannot read is not a reason to report the same money twice.
    return true;
  }
}

async function rememberReported(storage: PurchaseLedgerStorage, id: string): Promise<void> {
  try {
    const raw = await storage.getItem(REPORTED_PURCHASES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const previous = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    const next = [...previous.filter((entry) => entry !== id), id].slice(-REPORTED_PURCHASES_KEPT);
    await storage.setItem(REPORTED_PURCHASES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best effort. The read above is the one that has to fail closed.
  }
}

export interface ConfirmedPurchaseDeps {
  storage: PurchaseLedgerStorage;
  trackEvent: (name: string, props: Record<string, string | number | boolean>) => void;
  meta: (facts: PurchaseFacts) => Promise<ReportPurchaseOutcome>;
}

export type ConfirmedPurchaseResult = {
  readonly meta: ReportPurchaseOutcome;
  /** Whether the GA4 purchase event was emitted, and why not when it was not. */
  readonly analytics: 'sent' | 'duplicate' | 'invalid_amount' | 'no_transaction_id';
};

export async function reportConfirmedPurchaseWith(
  deps: ConfirmedPurchaseDeps,
  tierId: PlanTierId,
  source: 'stripe' | 'apple',
  payment?: { amount: number | null; currency: string | null; transactionId?: string | null },
): Promise<ConfirmedPurchaseResult> {
  const storage = deps.storage;
  const emit = deps.trackEvent;
  const meta = deps.meta;

  const tier = SIDEKICK_PLAN_TIERS.find((t) => t.id === tierId);
  // An unknown tier means the catalogue and the biller have diverged. Report
  // nothing rather than guess an amount: a wrong value is worse than a missing
  // one, because the optimiser will aim at it.
  if (!tier) return { meta: 'invalid_amount', analytics: 'invalid_amount' };
  if (!payment || typeof payment.amount !== 'number' || !Number.isFinite(payment.amount)
    || payment.amount <= 0 || !payment.currency || !/^[A-Za-z]{3}$/.test(payment.currency)) {
    return { meta: 'invalid_amount', analytics: 'invalid_amount' };
  }
  const currency = payment.currency.toUpperCase();

  // The biller's own id. Without one there is nothing to deduplicate against,
  // and an event that can be emitted twice is worse than a missing one.
  const transactionId = typeof payment.transactionId === 'string' && payment.transactionId.trim()
    ? `${source}:${payment.transactionId.trim()}`
    : null;

  let analytics: ConfirmedPurchaseResult['analytics'] = 'no_transaction_id';
  if (transactionId) {
    if (await alreadyReported(storage, transactionId)) {
      analytics = 'duplicate';
    } else {
      const params = buildPurchaseParams({ tierId, amount: payment.amount, currency, transactionId });
      if (params) {
        emit('purchase', params);
        await rememberReported(storage, transactionId);
        analytics = 'sent';
      } else {
        analytics = 'invalid_amount';
      }
    }
  }

  const metaOutcome = await meta({ amount: payment.amount, currency, tierId, source });
  return { meta: metaOutcome, analytics };
}
