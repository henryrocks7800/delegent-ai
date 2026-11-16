// Tell Meta when someone actually pays, so its optimiser can aim at revenue
// rather than at clicks.
//
// WHY THIS EXISTS. Audited 2026-09-01: the Meta SDK shipped, but NOTHING ever
// reported a purchase. No logPurchase, no AppEventsLogger call, no Conversions
// API. So both live campaigns were optimising toward installs and could not see
// a single paying customer.
//
// The two dashboard toggles do not rescue it either, and this is the part that
// is easy to get wrong:
//
//   - ANDROID purchases go through STRIPE CHECKOUT in a browser, not Google
//     Play Billing. Meta's "Log In-App Purchases Automatically" hooks Play
//     Billing, so it can never observe a Stripe web checkout however the
//     toggle is set. Only an explicit event works.
//   - iOS purchases do go through StoreKit, but "Log In-App Subscriptions
//     Automatically" needs the App Store shared secret, which is not set.
//
// So an explicit event is the only thing that works on BOTH platforms today.
//
// ⚠️ IT SHIPS OVER THE AIR. react-native-fbsdk-next is already compiled into
// every build from 2.3.0, so this is JS calling an existing native module. It
// does NOT need a store release, which is why it can fix live campaigns today.
//
// CONSENT. Gated on the same stored answer as the rest of the SDK. If the user
// said no, or was never asked, nothing is sent. Sending a purchase event for
// someone who declined ad measurement would be exactly the thing the consent
// card promises we will not do.
import { readMetaConsent, type ConsentStorage } from './metaSdk';

/** Minimal shape of the logger we use, so tests need no native module. */
export interface MetaPurchaseLogger {
  logPurchase: (amount: number, currency: string, params?: Record<string, string>) => void;
}

export interface ReportPurchaseDeps {
  /**
   * The same ConsentStorage the rest of the SDK uses. We only ever read, but
   * the type carries setItem because readMetaConsent shares it with
   * setMetaConsent, and narrowing it here would fork the contract.
   */
  storage: ConsentStorage;
  loadLogger: () => Promise<MetaPurchaseLogger | null>;
  warn?: (message: string) => void;
  canSend?: () => boolean;
}

export interface PurchaseFacts {
  /** Major units, e.g. 9.99 for £9.99. Meta wants a decimal amount, not pence. */
  amount: number;
  /** ISO 4217, e.g. 'GBP'. */
  currency: string;
  /** Our tier id, sent as a parameter so spend can be broken down by plan. */
  tierId: string;
  /** 'stripe' or 'apple'. Useful when reading Meta's reports later. */
  source: 'stripe' | 'apple';
}

export type ReportPurchaseOutcome =
  | 'sent'
  | 'no_consent'
  | 'no_logger'
  | 'invalid_amount'
  | 'failed';

/**
 * Report one completed purchase. Never throws, never blocks anything, and
 * returns why it did nothing so a caller can log it.
 */
export async function reportPurchaseToMeta(
  deps: ReportPurchaseDeps,
  facts: PurchaseFacts,
): Promise<ReportPurchaseOutcome> {
  try {
    // A zero or negative amount is a bug upstream, and sending it would teach
    // Meta's optimiser that a conversion is worth nothing.
    if (!Number.isFinite(facts.amount) || facts.amount <= 0) return 'invalid_amount';
    if (!facts.currency) return 'invalid_amount';

    const consent = await readMetaConsent(deps.storage);
    if (consent !== 'granted') return 'no_consent';

    const logger = await deps.loadLogger();
    if (!logger) return 'no_logger';
    if (deps.canSend?.() === false || await readMetaConsent(deps.storage) !== 'granted') return 'no_consent';
    if (deps.canSend?.() === false) return 'no_consent';

    logger.logPurchase(facts.amount, facts.currency, {
      fb_content_type: 'subscription',
      fb_content_id: facts.tierId,
      delegent_source: facts.source,
    });
    return 'sent';
  } catch (err) {
    deps.warn?.(`meta purchase report failed: ${String(err)}`);
    return 'failed';
  }
}
