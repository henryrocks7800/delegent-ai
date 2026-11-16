// Pure core for the native Google Analytics for Firebase transport (2026-09-11).
//
// Why this exists alongside ga4.ts: Google Ads can only import an app's
// events as conversions, and count an iOS install at all, when they arrive
// through the Firebase SDK (first_open, SKAdNetwork postbacks, the Firebase
// to Google Ads link). The Measurement Protocol path in ga4.ts lands the same
// events in the same property, but Google Ads cannot bid on them. So when the
// native module is present, track() goes through Firebase; on a binary that
// lacks it (every install before build 50) ga4.ts carries on exactly as
// before. Event names and call sites are identical on both paths.
//
// No imports, dependency-injected, never throws: the same rules as ga4.ts.
import type { AnalyticsEventProps } from './ga4';

/** The subset of @react-native-firebase/analytics this app uses. */
export type FirebaseAnalyticsApi = {
  logEvent: (name: string, params?: Record<string, string | number | boolean>) => Promise<void>;
  setConsent: (consent: FirebaseConsent) => Promise<void>;
  setAnalyticsCollectionEnabled: (enabled: boolean) => Promise<void>;
};

export type FirebaseConsent = {
  analytics_storage: boolean;
  ad_storage: boolean;
  ad_user_data: boolean;
  ad_personalization: boolean;
};

// Firebase's contract: names 1 to 40 chars, letters/digits/underscores,
// starting with a letter; up to 25 params; param names up to 40 chars; string
// values up to 100 chars. Reserved prefixes ("firebase_", "google_", "ga_")
// are rejected by the SDK, so refuse them here and degrade to a no-op.
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const RESERVED_PREFIX_RE = /^(firebase_|google_|ga_)/;
const MAX_PARAMS = 25;
const MAX_STRING = 100;

export function isValidFirebaseEventName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED_PREFIX_RE.test(name);
}

function sanitiseKey(key: string): string | null {
  const cleaned = key.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  if (!cleaned || !/^[a-zA-Z]/.test(cleaned) || RESERVED_PREFIX_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Shape the shared event props for Firebase: drop null/undefined, truncate
 * strings, keep finite numbers and booleans, cap the count. Never throws.
 */
export function toFirebaseParams(props: AnalyticsEventProps | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  let count = 0;
  for (const [rawKey, value] of Object.entries(props)) {
    if (count >= MAX_PARAMS) break;
    if (value === null || value === undefined) continue;
    const key = sanitiseKey(rawKey);
    if (!key) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number') { if (!Number.isFinite(value)) continue; out[key] = value; }
    else if (typeof value === 'boolean') out[key] = value;
    else continue;
    count += 1;
  }
  return out;
}

/**
 * Consent mapping. Product analytics (analytics_storage) is on regardless:
 * it is the anonymised usage measurement the privacy policy already
 * describes, keyed by a random app-instance id, and the policy offers an
 * email objection route rather than a prompt. The three advertising signals
 * follow the in-app advertising consent, the same answer that switches the
 * Meta SDK on, so a "no" there withholds the advertising id from Google too.
 */
export function consentForAdvertisingAnswer(adConsentGranted: boolean): FirebaseConsent {
  return {
    analytics_storage: true,
    ad_storage: adConsentGranted,
    ad_user_data: adConsentGranted,
    ad_personalization: adConsentGranted,
  };
}

/**
 * The GA4 recommended `purchase` event, which Google Ads imports with a value
 * so it can optimise on revenue rather than on installs alone.
 *
 * ⚠️ IT TAKES THE AMOUNT THAT WAS ACTUALLY CHARGED, not the catalogue price.
 * This used to be `priceGbpMonthly` read off the tier list, so a customer on
 * the 2.99 introductory coupon was reported as 9.99 and the optimiser was
 * trained on a number nobody paid. It also carried no transaction id, so the
 * same payment could be counted more than once and Google had no way to tell.
 *
 * Trials carry no value and are not purchases. Nothing here invents a currency.
 */
export function buildPurchaseParams(input: {
  tierId: string;
  amount: number;
  currency: string;
  transactionId: string;
}): Record<string, string | number | boolean> | null {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return null;
  if (!/^[A-Z]{3}$/.test(input.currency)) return null;
  if (!input.transactionId.trim()) return null;
  return {
    currency: input.currency,
    value: input.amount,
    transaction_id: input.transactionId.slice(0, MAX_STRING),
    tier: input.tierId.slice(0, MAX_STRING),
  };
}

export type FirebaseTracker = {
  trackEvent: (name: string, props?: AnalyticsEventProps) => void;
  applyAdvertisingConsent: (granted: boolean) => void;
};

/**
 * Wrap the native API in the fire-and-forget contract the rest of the app
 * relies on. Every call is synchronous void, catches everything, and awaits
 * nothing on the caller's side.
 */
export function createFirebaseTracker(api: FirebaseAnalyticsApi): FirebaseTracker {
  return {
    trackEvent(name, props) {
      try {
        if (!isValidFirebaseEventName(name)) return;
        void api.logEvent(name, toFirebaseParams(props)).catch(() => {});
      } catch {
        // Analytics must never break the app.
      }
    },
    applyAdvertisingConsent(granted) {
      try {
        void api.setConsent(consentForAdvertisingAnswer(granted)).catch(() => {});
      } catch {
        // As above.
      }
    },
  };
}
