// Apple in-app purchase: the contract every surface has to agree on.
//
// WHY THIS FILE EXISTS AT ALL
//   Apple rejected 2.5.0 (37) on 2026-08-18 under Guideline 3.1.1, because the
//   iOS build showed three prices and handed off to Stripe Checkout in Safari.
//   There are exactly two lawful shapes for iOS after that, and this file is
//   the switch between them. See docs/app-store/IAP_ARCHITECTURE.md.
//
// THE TWO SHAPES, AND WHY THEY ARE MUTUALLY EXCLUSIVE
//
//   'hidden'  Guideline 3.1.3(f), "Free Stand-alone Apps". The app is a free
//             companion to a paid web based tool, which is what a per-subscriber
//             cloud machine with a storage volume is. The clause's condition is
//             "no purchasing inside the app, OR calls to action for purchase
//             outside of the app", so in this mode iOS shows NO price, NO plan
//             picker, and NO link that leads to a purchase. Costs us the in-app
//             upgrade path. Costs Apple nothing, so we pay no commission.
//
//   'iap'     Guideline 3.1.1. StoreKit does the purchase, Apple takes 15-30%,
//             and the in-app upgrade path works.
//
//   You cannot have both in one binary. 'hidden' means literally no call to
//   action; adding a StoreKit button is a purchase inside the app, which takes
//   you straight back to 3.1.1. Anything that renders a price on iOS must ask
//   this module first.
//
// WHY THIS IS A BUILD-TIME CONSTANT AND NOT A SERVER FLAG
//   Because Apple reviews a binary. A paywall that appears after review is
//   bait-and-switch and gets apps pulled, not just rejected. The same reasoning
//   is already written down in platformAvailability.ts, which calls these
//   CLAIMS, NOT CAPABILITIES. Flip it in a build, never at runtime.

import type { PlanTierId } from './index';

export type IosPurchaseMode = 'hidden' | 'iap';

/**
 * The mode the CURRENT BUILD ships with.
 *
 * Default is 'hidden' on purpose: it is the shape that is safe to submit while
 * the 3.1.3(f) argument is with App Review, and a mistake in this direction
 * costs a missing upgrade button rather than a second 3.1.1 rejection.
 *
 * Overridden at build time by EXPO_PUBLIC_IOS_PURCHASE_MODE so a TestFlight
 * build can carry StoreKit without the production build changing. Anything
 * other than the two known values falls back to 'hidden' rather than throwing,
 * because a typo in a build profile must not brick the app at launch.
 */
export function resolveIosPurchaseMode(raw: string | null | undefined): IosPurchaseMode {
  return raw?.trim() === 'iap' ? 'iap' : 'hidden';
}

/**
 * Product ids as created in App Store Connect by
 * infra/scripts/apple-create-iap-products.py.
 *
 * These strings are load-bearing in three places at once: App Store Connect,
 * the StoreKit query on the device, and the Worker's mapping back to a tier. A
 * release-gate test pins them so a rename cannot land in one place only.
 */
export const APPLE_IAP_PRODUCT_IDS: Readonly<Record<PlanTierId, string>> = {
  studio: 'com.sidekick.v2.studio.monthly',
  'pro-office': 'com.sidekick.v2.pro.monthly',
  'enterprise-suite': 'com.sidekick.v2.max.monthly',
} as const;

/**
 * The one plan an assistant account buys: £3.99 a month, first month free
 * (Alex, 2026-09-16). Created by infra/scripts/apple-create-assistant-subscription.py
 * in the same subscription group as the three workspace plans, at the lowest
 * group level. It is recorded under the assistant plan's tier (AGENT_PLAN.tierId,
 * which is 'studio'), exactly as its Stripe price is, so entitlement, quota and
 * the allowance all read the same tier whichever store billed it.
 */
export const APPLE_ASSISTANT_PRODUCT_ID = 'com.sidekick.v2.assistant.monthly';
const APPLE_ASSISTANT_TIER_ID: PlanTierId = 'studio';

export const APPLE_IAP_BUNDLE_ID = 'com.sidekick.v2';

export function appleProductIdForTier(tierId: PlanTierId): string {
  return APPLE_IAP_PRODUCT_IDS[tierId];
}

/** The product StoreKit should sell: the assistant plan for an assistant account, else the tier's. */
export function appleProductIdForPurchase(tierId: PlanTierId, assistant: boolean): string {
  return assistant ? APPLE_ASSISTANT_PRODUCT_ID : APPLE_IAP_PRODUCT_IDS[tierId];
}

export function isAppleAssistantProduct(productId: string | null | undefined): boolean {
  return typeof productId === 'string' && productId.trim() === APPLE_ASSISTANT_PRODUCT_ID;
}

/**
 * Reverse lookup, and it must stay total: an unknown product id means Apple
 * sent us something we do not sell, and the caller has to treat that as "grant
 * nothing" rather than defaulting to the cheapest tier. Returns null, never a
 * fallback tier.
 */
export function planTierIdForAppleProduct(productId: string | null | undefined): PlanTierId | null {
  const value = typeof productId === 'string' ? productId.trim() : '';
  if (!value) return null;
  if (value === APPLE_ASSISTANT_PRODUCT_ID) return APPLE_ASSISTANT_TIER_ID;
  const match = (Object.keys(APPLE_IAP_PRODUCT_IDS) as PlanTierId[])
    .find((tierId) => APPLE_IAP_PRODUCT_IDS[tierId] === value);
  return match ?? null;
}

export const ALL_APPLE_IAP_PRODUCT_IDS: readonly string[] =
  [...Object.values(APPLE_IAP_PRODUCT_IDS), APPLE_ASSISTANT_PRODUCT_ID];

// -- copy for the 'hidden' mode -------------------------------------------
//
// Read this before editing a single word. Under 3.1.3(f) this screen is the
// thing a reviewer looks at to decide whether the app contains a "call to
// action for purchase outside of the app". So it may NOT contain: a price, a
// plan name attached to a price, a URL, a button that opens a browser, or a
// verb like "subscribe", "upgrade", "buy" or "get started" pointed at a
// purchase. Saying where to go is exactly what gets it rejected.
//
// It is allowed to say the account has no workspace, because that is a
// statement of account state, not a solicitation.

export const IOS_NO_SUBSCRIPTION_TITLE = 'No active workspace';

export const IOS_NO_SUBSCRIPTION_BODY =
  'This account does not have an active workspace at the moment. Once one is active, your coworker and your files will appear here automatically.';

/**
 * A single predicate every surface uses instead of testing the platform inline.
 * Reads as the question that actually matters: may this build put a price or a
 * purchase in front of the user?
 */
export function mayShowPurchaseUi(input: {
  platform: 'ios' | 'android' | 'web';
  iosPurchaseMode: IosPurchaseMode;
}): boolean {
  if (input.platform !== 'ios') return true;
  return input.iosPurchaseMode === 'iap';
}

/**
 * True when this build should route a purchase through StoreKit rather than
 * Stripe Checkout. Android and web are always Stripe; there is no StoreKit
 * there and Google Play billing is a separate question we have not been asked.
 */
export function shouldUseStoreKit(input: {
  platform: 'ios' | 'android' | 'web';
  iosPurchaseMode: IosPurchaseMode;
}): boolean {
  return input.platform === 'ios' && input.iosPurchaseMode === 'iap';
}

/**
 * Is this a transaction id Apple will actually answer for?
 *
 * THE DEFECT THIS EXISTS TO FIX, and it is not theoretical: THREE of the six
 * real purchase attempts we had ever recorded failed this way.
 *
 *   2026-08-20 09:09:56  tx 000000000000000  apple_api_error  applied=false
 *   2026-08-20 12:47:09  tx 000000000000000  apple_api_error  applied=false
 *   2026-08-20 12:47:10  tx 000000000000000  apple_api_error  applied=false
 *
 * StoreKit delivers an interim purchase event whose transactionId is a string
 * of zeros while the transaction is still settling. It is a placeholder, not an
 * id. The app sent it to the Worker anyway, the Worker dutifully asked Apple
 * about it, Apple refused, and the customer was left on "Confirming
 * subscription..." having genuinely paid.
 *
 * Zeros are the only shape observed, but the test is "contains a digit other
 * than zero" rather than an equality check against one literal, because the
 * length of the placeholder is not something we control or should depend on.
 *
 * It lives in shared rather than next to its caller because the caller imports
 * react-native, which the test runner cannot load, and an untested guard on the
 * money path is how this class of bug got here in the first place.
 */
export function isUsableAppleTransactionId(value: unknown): value is string {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  if (!text) return false;
  return /[1-9]/.test(text);
}
