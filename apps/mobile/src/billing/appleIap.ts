// StoreKit purchases on iOS, and the switch that decides whether iOS is
// allowed to show a price at all.
//
// READ packages/shared/src/appleIap.ts FIRST. It holds the two lawful shapes
// ('hidden' under Guideline 3.1.3(f), 'iap' under 3.1.1) and why they cannot
// coexist in one binary. This file is only the iOS plumbing for them.
//
// WHY THE NATIVE MODULE IS LOADED LAZILY AND OPTIONALLY
//   Because the 3.1.3(f) build must not need it. That build ships with no
//   purchase path at all, so pulling a StoreKit native module into it would add
//   a dependency, a lockfile change and a native rebuild to a change that is
//   otherwise pure JavaScript and could go out over the air. It would also make
//   the reviewer's binary contain purchase machinery it never uses, which is a
//   poor look on an app arguing it does not sell anything.
//
//   So the import is dynamic and its absence is an ordinary, handled outcome.
//   Build 33 is the cautionary tale here: a native module the app relied on was
//   only a transitive dependency, EAS regenerated the lockfile on the worker,
//   and every install crashed at launch with "Cannot find native module".
//   Nothing in this file may ever be the reason the app fails to start.

import { Linking, Platform } from 'react-native';
import {
  ALL_APPLE_IAP_PRODUCT_IDS,
  APPLE_ASSISTANT_PRODUCT_ID,
  appleProductIdForPurchase,
  purchaseCoordinationNotice,
  APPLE_IAP_PRODUCT_IDS,
  isUsableAppleTransactionId,
  resolveIosPurchaseMode,
  shouldUseStoreKit,
  mayShowPurchaseUi,
  type IosPurchaseMode,
  type PlanTierId,
} from '@sidekick/shared';
// One definition, shared with the browser's explanation of the same thing.
import { APPLE_MANAGE_SUBSCRIPTIONS_URL } from '@sidekick/shared';
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileCheckoutApiBaseUrl } from './mobileCheckout';
import { reportConfirmedPurchase } from '../analytics/reportConfirmedPurchaseClient';
import { applePlanOffer, type AppleOfferProduct, type ApplePlanOffer } from './appleOffer';
import { reportAppleOfferRead } from '../observability/sentry';

declare const process: { env: Record<string, string | undefined> };

/**
 * The mode this BUILD ships with. Build-time, never server-driven: Apple
 * reviews a binary, and a paywall that appears after review gets an app pulled
 * rather than merely rejected.
 */
export const iosPurchaseMode: IosPurchaseMode = resolveIosPurchaseMode(
  generatedExpoPublicEnv.EXPO_PUBLIC_IOS_PURCHASE_MODE
  || process.env.EXPO_PUBLIC_IOS_PURCHASE_MODE,
);

function currentPlatform(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/** May this build put a price or a purchase in front of the user? */
export function canShowPurchaseUi(): boolean {
  return mayShowPurchaseUi({ platform: currentPlatform(), iosPurchaseMode });
}

/** Should a purchase go through StoreKit rather than Stripe Checkout? */
export function usesStoreKit(): boolean {
  return shouldUseStoreKit({ platform: currentPlatform(), iosPurchaseMode });
}

export type AppleIapFailureReason =
  | 'not_ios'
  | 'module_unavailable'
  | 'product_unavailable'
  | 'cancelled'
  | 'purchase_failed'
  | 'purchase_unavailable'
  | 'purchase_pending'
  | 'purchase_requires_review'
  | 'unauthenticated'
  | 'verification_failed'
  | 'not_allowlisted'
  | 'already_subscribed_elsewhere'
  | 'manage_unavailable'
  | 'unreachable'
  // This Apple ID already owns the subscription, but it is attached to a
  // DIFFERENT Delegent account. Distinct from already_subscribed_elsewhere,
  // which is about Stripe.
  | 'owned_by_another_account'
  // StoreKit was asked something and never answered. Its own name, because
  // "the App Store could not complete that purchase" is not true: it never
  // started one.
  | 'storekit_unresponsive';

export type AppleIapResult =
  | { purchased: { tierId: PlanTierId; expiresAt: string | null } }
  | { error: { reason: AppleIapFailureReason; message: string } };

const FAILURE_COPY: Record<AppleIapFailureReason, string> = {
  not_ios: 'In-app purchase is only available on iPhone and iPad.',
  module_unavailable: 'This build cannot take payments. Update the app and try again.',
  product_unavailable: 'That plan is not available from the App Store right now. Try again in a moment.',
  // Never phrased as a failure. The user chose to stop, and telling them
  // something went wrong invites a support message about a working app.
  cancelled: 'Purchase canceled.',
  purchase_unavailable: 'We could not start checkout. Try again in a moment.',
  purchase_pending: purchaseCoordinationNotice('purchase_pending')!.message,
  purchase_requires_review: purchaseCoordinationNotice('purchase_requires_review')!.message,
  purchase_failed: 'The App Store could not complete that purchase. Try again in a moment.',
  unauthenticated: 'Sign in again, then choose your plan.',
  // A purchase or restore does not prove a payment, especially during a trial.
  // Describe the unresolved entitlement without claiming charge success/failure.
  verification_failed: 'Your purchase has not been confirmed yet. Use Restore purchases to check again, and contact support if your plan still does not appear.',
  not_allowlisted: 'In-app purchase is not enabled for this account yet.',
  // Says where the existing subscription is managed WITHOUT naming a website,
  // a price or a way to buy. This string is reachable only in an `iap` build,
  // which is allowed to mention purchasing, but it costs nothing to keep it
  // clean and it stops the copy leaking into a 3.1.3(f) build by accident.
  already_subscribed_elsewhere: 'This account already has a subscription billed outside the App Store, so there is nothing to buy here. Manage it where you started it.',
  // Names the destination so the user can finish the job by hand. Pointing at
  // Settings is allowed: it is Apple's own subscription management, not a
  // purchase route outside the app.
  manage_unavailable: 'We could not open your subscription settings. You can manage it in Settings, then your name, then Subscriptions.',
  unreachable: "We couldn't reach us just now. If you're on a work network it may be blocking us, so please try again on mobile data or home wifi.",
  // Names Apple's own Settings path, which is allowed: it is subscription
  // management, not a purchase route outside the app. Must NOT say "try again",
  // because trying again produces the identical result forever.
  owned_by_another_account: 'Your Apple ID already has a Delegent AI subscription on a different account. Sign in to that account to use it, or manage the subscription in Settings, then your name, then Subscriptions.',
  // Honest about what happened. The old behaviour here was a five-minute
  // silent spinner, which is what this string exists to replace.
  storekit_unresponsive: 'The App Store did not respond. Close the app fully, reopen it and try again.',
};

function failure(reason: AppleIapFailureReason): Extract<AppleIapResult, { error: unknown }> {
  return { error: { reason, message: FAILURE_COPY[reason] } };
}

/**
 * The StoreKit binding, if this binary has one.
 *
 * `expo-iap` is an optional dependency present only in builds made with the
 * `iap` purchase mode. Returning null rather than throwing is the whole point:
 * a 3.1.3(f) build calls nothing here, and a misconfigured build shows a
 * message instead of a crash.
 */
// WHY THIS HAND-WRITTEN TYPE IS DANGEROUS, AND WHY IT IS STILL HERE
//   The import is dynamic and optional, so there is nothing for TypeScript to
//   check the call against except this declaration. That means a wrong shape
//   here is invisible to typecheck, lint and all 326 mobile tests: they all
//   agree with each other and disagree with expo-iap.
//
//   That is exactly what happened. This said `request: { ios: { sku } }` until
//   2026-08-20. expo-iap's RequestSubscriptionPropsByPlatforms has exactly two
//   keys, `apple` and `google`, and NO `ios`. So the sku reached StoreKit as
//   undefined, the request was rejected before any sheet appeared, and the user
//   got "Checkout is temporarily offline" on a perfectly healthy product.
//
//   If you change any signature here, read node_modules/expo-iap/build/types.d.ts
//   and match it. Do not infer it from the platform name we use everywhere else.
type StoreKitPurchaseEvent = { id?: string; transactionId?: string; productId?: string; appAccountToken?: string | null };
type StoreKitPurchaseError = { code?: string; message?: string; productId?: string | null };

// isUsableAppleTransactionId lives in @sidekick/shared (imported above), not
// here. It guards the placeholder transaction id that killed three of our first
// six real purchases; the full write-up is on the function.

type StoreKitModule = {
  initConnection(): Promise<unknown>;
  fetchProducts(input: { skus: string[]; type: 'subs' }): Promise<AppleOfferProduct[]>;
  isEligibleForIntroOfferIOS?: (groupId: string) => Promise<boolean>;
  // Optional: the App Store storefront country StoreKit is quoting prices for
  // ("GBR", "USA"). Diagnostic only, so a build without it still sells.
  getStorefront?: () => Promise<unknown>;
  requestPurchase(input: { request: { apple: { sku: string; appAccountToken: string } }; type: 'subs' }): Promise<unknown>;
  finishTransaction(input: { purchase: { id: string }; isConsumable: false }): Promise<unknown>;
  // The purchase OUTCOME arrives on these, never on requestPurchase's return
  // value. expo-iap documents that in terms: "The result is delivered through
  // purchaseUpdatedListener - NOT the return value."
  purchaseUpdatedListener(listener: (event: StoreKitPurchaseEvent) => void): { remove: () => void };
  purchaseErrorListener(listener: (error: StoreKitPurchaseError) => void): { remove: () => void };
  // Everything the store still holds for this Apple ID: active subscriptions
  // and any transaction that was never finished. This is the ONLY way to
  // recover a purchase whose verification failed after Apple took the money.
  getAvailablePurchases(options?: { onlyIncludeActiveItemsIOS?: boolean }): Promise<StoreKitPurchaseEvent[]>;
  // Optional: opens the platform's own subscription management. Typed as
  // optional because it is not needed to take a payment, and a build whose
  // expo-iap version lacks it must still be able to sell.
  deepLinkToSubscriptions?: (input?: unknown) => Promise<unknown>;
};

let storeKitPromise: Promise<StoreKitModule | null> | null = null;

/** Read only. The native purchase sheet remains the final price confirmation. */
/** The offers on the paywall: one per workspace tier, plus the assistant plan under 'assistant'. */
export type ApplePlanOffers = Partial<Record<PlanTierId | 'assistant', ApplePlanOffer>>;

export async function readApplePlanOffers(): Promise<ApplePlanOffers> {
  if (!usesStoreKit() || !canShowPurchaseUi()) return {};
  const store = await loadStoreKit();
  if (!store) return {};
  try {
    const products = await withStoreKitTimeout(store.fetchProducts({ skus: [...ALL_APPLE_IAP_PRODUCT_IDS], type: 'subs' }), 'offerProducts');
    // Which storefront StoreKit quoted. On 2026-09-16 Alex's TestFlight build
    // printed "$3.99" on the assistant card while Apple's sheet said £3.99, and
    // nothing on the box could say whether StoreKit was quoting the US
    // storefront (a sandbox default) or a wrong price. This is that evidence.
    const storefront = store.getStorefront
      ? await withStoreKitTimeout(store.getStorefront(), 'storefront')
        .then((value) => (typeof value === 'string' ? value : null))
        .catch(() => null)
      : null;
    const eligibility = new Map<string, Promise<boolean | null>>();
    const offers: ApplePlanOffers = {};
    const wanted: Array<[PlanTierId | 'assistant', string]> = [
      ...(Object.entries(APPLE_IAP_PRODUCT_IDS) as Array<[PlanTierId, string]>),
      ['assistant', APPLE_ASSISTANT_PRODUCT_ID],
    ];
    const evidence: Record<string, string | boolean | number | null> = {
      storefront,
      productsReturned: products.length,
      eligibilityApi: Boolean(store.isEligibleForIntroOfferIOS),
    };
    const missing: string[] = [];
    await Promise.all(wanted.map(async ([tierId, productId]) => {
      const product = products.find((item) => item.id === productId);
      if (!product) {
        missing.push(tierId);
        return;
      }
      const group = product.subscriptionGroupIdIOS;
      if (group && !eligibility.has(group) && store.isEligibleForIntroOfferIOS) {
        eligibility.set(group, withStoreKitTimeout(store.isEligibleForIntroOfferIOS(group), 'introEligibility').catch(() => null));
      }
      const eligible = group ? await (eligibility.get(group) ?? Promise.resolve(null)) : null;
      offers[tierId] = applePlanOffer(product, eligible);
      // The two products the paywall can quote. Prices are the public store
      // price for the storefront; no account or receipt data.
      if (tierId === 'studio' || tierId === 'assistant') {
        evidence[`${tierId}.displayPrice`] = product.displayPrice?.trim() || null;
        evidence[`${tierId}.currency`] = product.currency ?? null;
        evidence[`${tierId}.hasGroup`] = Boolean(group);
        evidence[`${tierId}.eligible`] = eligible === null ? 'unknown' : eligible;
        evidence[`${tierId}.paymentMode`] = product.introductoryPricePaymentModeIOS ?? null;
        evidence[`${tierId}.period`] = product.introductoryPriceSubscriptionPeriodIOS ?? null;
        evidence[`${tierId}.periods`] = product.introductoryPriceNumberOfPeriodsIOS ?? null;
      }
    }));
    // The assistant plan is the one on sale since every account moved to the
    // engine (2026-09-18). The three workspace products are retired, so their
    // absence is expected, yet it was reported as "product_missing" on every
    // paywall open (32 events from 21 people by 2026-09-23, QA F24). The
    // outcome now describes the plan being sold; "missing" still lists the rest.
    const sold = offers.assistant;
    reportOfferReadOnce(
      !sold ? 'product_missing'
        : sold.hasFreeMonth ? 'trial_confirmed'
          : sold.offersFreeMonth ? 'trial_offered_unconfirmed'
            : 'no_trial',
      { ...evidence, missing: missing.length ? missing.join(',') : null },
    );
    return offers;
  } catch (error) {
    reportOfferReadOnce('read_failed', { reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    return {};
  }
}

// One report per app session. The paywall re-reads on every open, and the
// evidence question ("what did StoreKit say?") is answered by the first read.
let offerReadReported = false;
function reportOfferReadOnce(outcome: string, fields: Record<string, string | boolean | number | null>): void {
  if (offerReadReported) return;
  offerReadReported = true;
  reportAppleOfferRead(outcome, fields);
}

/**
 * Every StoreKit call must be able to give up.
 *
 * THE DEFECT THIS EXISTS TO FIX. Not one call on the purchase path had a
 * timeout except the purchase outcome itself, and that one waits FIVE MINUTES.
 * So when StoreKit simply did not answer, the button sat on "Opening secure
 * checkout..." with no sheet, no error and no way forward, and the user
 * concluded the app was broken. It is: 2026-08-27, reproduced on Alex's phone.
 *
 * StoreKit not answering is not exotic. It says nothing at all when asked to
 * buy a product the signed-in Apple ID already owns: no event on
 * purchaseUpdatedListener, no error on purchaseErrorListener, nothing.
 *
 * Ten seconds is chosen against what these calls do: initConnection and
 * fetchProducts are a local IPC hop and a store lookup, not a user
 * interaction. Anything slower than this is not going to arrive. The purchase
 * OUTCOME keeps its own, much longer budget, because a human is entering a
 * password inside it.
 */
const STOREKIT_CALL_TIMEOUT_MS = 10_000;

function withStoreKitTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`storekit_timeout:${label}`)),
      STOREKIT_CALL_TIMEOUT_MS,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function loadStoreKit(): Promise<StoreKitModule | null> {
  if (!storeKitPromise) {
    storeKitPromise = (async () => {
      try {
        // A STRING LITERAL, NOT A TEMPLATE LITERAL, and this is load-bearing.
        //
        // This was `import(`${moduleName}`)`, with a comment saying the template
        // literal was deliberate because it "stops the bundler resolving it at
        // build time". It does, and that is exactly the problem: Metro can only
        // rewrite a dynamic import into a lazy require when the specifier is
        // statically known. An unresolvable one survives into the bundle as a
        // real import() expression, which the Hermes bytecode compiler rejects.
        //
        // IT BROKE BOTH PLATFORMS, and was found twice, separately:
        //
        //   iOS, 2026-08-19. Build 38 died on it:
        //     main.jsbundle:331655:32: error: Invalid expression encountered
        //
        //   Android, 2026-08-25. The identical failure killed
        //   :app:createBundleReleaseJsAndAssets, so NO Play AAB could be built
        //   at all. Latent on master since #419; nothing caught it because the
        //   last Android build predated that merge.
        //
        // Nothing in typecheck, lint or the mobile tests can see this, because
        // it only appears when Hermes compiles a RELEASE bundle. The other eight
        // dynamic imports in this app all use string literals; this was the only
        // one that did not.
        //
        // Laziness is preserved: Metro still splits a string-literal dynamic
        // import, so the module is required on first call rather than at
        // startup. Optionality is preserved by the try/catch below, which is
        // what actually handles the module being absent. expo-iap is in any case
        // a declared dependency, so there is no build where it is missing.
        const loaded = (await import('expo-iap')) as Partial<StoreKitModule>;
        if (typeof loaded?.requestPurchase !== 'function') return null;
        // Bounded: a hung initConnection used to hang the buy button forever,
        // and because this promise is memoised it hung EVERY later attempt too
        // (see the reset below).
        if (loaded.initConnection) {
          await withStoreKitTimeout(loaded.initConnection(), 'initConnection');
        }
        return loaded as StoreKitModule;
      } catch {
        return null;
      }
    })();
  }

  const resolved = await storeKitPromise;

  // DO NOT CACHE A FAILURE.
  //
  // storeKitPromise is memoised so the module loads once. That is right for a
  // success and poison for a failure: one timed-out or failed load meant every
  // subsequent tap awaited the same dead promise, so the buy button could never
  // recover for the rest of the app session. Clearing it here makes the next
  // tap a real retry.
  if (resolved === null) storeKitPromise = null;

  return resolved;
}

/**
 * Where "Manage plan" has to go on an iOS build that sells through StoreKit.
 *
 * THIS IS THE 3.1.1 TRAP, and it is not the purchase button. Build 37 was
 * rejected for opening Stripe Checkout in Safari, and every "Manage plan",
 * "Resubscribe" and cancel control in this app routed to the Stripe customer
 * portal in exactly the same way. Fixing only the buy button would have shipped
 * a binary that still hands the user off to a web payment page one tap later.
 *
 * Apple's rule is that a subscription bought through StoreKit is managed
 * through StoreKit. There is no version of this where we send them to Stripe.
 *
 * Two routes, because the native one is the nicer sheet and the URL always
 * works: expo-iap's deepLinkToSubscriptions if the build has it, otherwise the
 * canonical App Store subscriptions URL, which Apple documents and which opens
 * the App Store app rather than a browser.
 */
// The URL lives in @sidekick/shared, beside the explanation the browser shows
// for the same situation. See the import at the top of this file.

export async function manageAppleSubscription(): Promise<AppleIapResult | null> {
  if (!usesStoreKit()) return failure('not_ios');

  const storeKit = await loadStoreKit();
  if (storeKit && typeof storeKit.deepLinkToSubscriptions === 'function') {
    try {
      await storeKit.deepLinkToSubscriptions();
      return null;
    } catch {
      // Fall through to the URL. A native sheet that refused to open is not a
      // reason to leave the user with no way to manage what they pay for.
    }
  }

  try {
    await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
    return null;
  } catch {
    return failure('manage_unavailable');
  }
}

async function accessToken(): Promise<string | null> {
  try {
    return await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    return null;
  }
}

/**
 * Tell the Worker a purchase happened. The Worker does not believe us: it takes
 * the transaction id, asks Apple directly, and writes the entitlement from
 * Apple's answer. See apps/worker/src/apple-iap.ts.
 */
export async function verifyApplePurchaseWithWorker(
  transactionId: string,
  options: { fetchImpl?: typeof fetch; apiBaseUrl?: string | null; token?: string | null } = {},
): Promise<AppleIapResult> {
  const apiBaseUrl = options.apiBaseUrl ?? mobileCheckoutApiBaseUrl;
  if (!apiBaseUrl) return failure('verification_failed');

  const token = options.token ?? await accessToken();
  if (!token) return failure('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`${apiBaseUrl.replace(/\/+$/, '')}/api/apple/iap/verify`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ transactionId }),
    });

    if (response.status === 401) return failure('unauthenticated');
    if (response.status === 403) return failure('not_allowlisted');

    const payload = await response.json().catch(() => null) as
      { ok?: boolean; tierId?: PlanTierId; expiresAt?: string | null; paidAmount?: number | null; currency?: string | null; error?: string } | null;

    if (response.ok && payload?.ok && payload.tierId) {
      // Meta only optimises toward what we report, and until 2026-09-01 we
      // reported nothing, so both campaigns were chasing installs and could not
      // see a single paying customer. Fire AFTER the Worker has confirmed the
      // purchase, never on tap: reporting an abandoned checkout would train the
      // optimiser to find people who abandon checkouts.
      //
      // Deliberately not awaited. A measurement call must never delay, and can
      // never fail, the screen a customer sees having just paid.
      // The transaction id is what stops the same payment being counted twice
      // across a restore, a retry or a second foreground.
      void reportConfirmedPurchase(payload.tierId, 'apple',
        { amount: payload.paidAmount ?? null, currency: payload.currency ?? null, transactionId });
      return { purchased: { tierId: payload.tierId, expiresAt: payload.expiresAt ?? null } };
    }
    // Read AFTER the ok-path so a success is never reinterpreted, and matched
    // on the outcome string rather than the 409 alone, because
    // already_claimed_by_another_account is also a 409 and means something
    // completely different.
    const notice = purchaseCoordinationNotice(payload?.error === 'billing_purchase_conflict' ? 'purchase_conflict' : payload?.error);
    if (notice) return { error: notice };
    if (payload?.error === 'already_subscribed_via_stripe') return failure('already_subscribed_elsewhere');
    // This Apple ID's subscription belongs to a DIFFERENT Delegent account.
    //
    // It used to fall through to verification_failed, whose copy promises the
    // plan "usually appears within a minute". That is false here: it will never
    // appear, because it is not this account's subscription. Observed live on
    // 2026-08-27 08:44:34, transaction 2000001227131326.
    if (payload?.error === 'already_claimed_by_another_account') return failure('owned_by_another_account');
    return failure('verification_failed');
  } catch {
    return failure('unreachable');
  }
}

/**
 * Re-verify anything Apple still holds for this Apple ID.
 *
 * WHY THIS HAS TO EXIST, and why its absence was the most dangerous gap in the
 * whole feature. A purchase is only ours once the Worker has verified it with
 * Apple and written the entitlement. Everything between Apple taking the money
 * and that write is a window where the customer has paid and has nothing:
 *
 *   - the account was not on SIDEKICK_APPLE_IAP_ALLOWLIST, which is exactly
 *     what happened on 2026-08-20 (403, money taken, nothing granted)
 *   - the Worker could not reach Apple, or Supabase
 *   - the app was killed between the sheet closing and the verify call
 *
 * Without a restore, that customer's only route back is a support ticket, and
 * Apple will not sell them the same subscription twice. WITH it, the next
 * launch or the next tap silently puts it right, because the Worker's verify
 * is idempotent: it re-reads the truth from Apple and writes the same row.
 *
 * Apple also REQUIRES a restore mechanism for subscriptions, so this is a
 * review item as well as a correctness one.
 *
 * Deliberately quiet about "nothing to restore". Someone who taps Restore with
 * no purchase has not hit an error, and telling them something failed invites a
 * support message about a working app.
 */
export async function restoreApplePurchases(): Promise<AppleIapResult | null> {
  if (!usesStoreKit()) return failure('not_ios');

  const storeKit = await loadStoreKit();
  if (!storeKit || typeof storeKit.getAvailablePurchases !== 'function') {
    return failure('module_unavailable');
  }

  let held: StoreKitPurchaseEvent[];
  try {
    held = await storeKit.getAvailablePurchases({ onlyIncludeActiveItemsIOS: true }) ?? [];
  } catch {
    return failure('purchase_failed');
  }

  // Only ours. The same Apple ID may hold subscriptions to other apps, and a
  // transaction id from one of those would be rejected by the Worker anyway,
  // but sending it at all is noise we can cheaply avoid.
  const ours = held.filter((purchase) => {
    const productId = typeof purchase?.productId === 'string' ? purchase.productId : '';
    return ALL_APPLE_IAP_PRODUCT_IDS.includes(productId);
  });
  if (ours.length === 0) return null;

  // Newest last from Apple, so walk backwards: a tier change leaves the older
  // transaction behind it and the most recent one is the plan they hold now.
  let lastError: AppleIapResult | null = null;
  for (let index = ours.length - 1; index >= 0; index -= 1) {
    const transactionId = ours[index]?.transactionId ?? ours[index]?.id ?? null;
    // Skip placeholders here too. A restore walks whatever StoreKit hands back,
    // and one unsettled entry must not burn the restore on an id Apple will
    // refuse while a real transaction sits further down the list.
    if (!isUsableAppleTransactionId(transactionId)) continue;
    const verified = await verifyApplePurchaseWithWorker(String(transactionId));
    if ('purchased' in verified) return verified;
    // Keep the first real refusal to report, but keep trying the rest: an old
    // transaction Apple has since superseded can fail while the current one
    // verifies perfectly.
    lastError ??= verified;
  }
  return lastError;
}

/**
 * How long to wait for StoreKit to report an outcome before giving up.
 *
 * Generous on purpose. The sheet can sit open while someone types an Apple ID
 * password, completes 2FA, or waits on an Ask to Buy approval. Timing out
 * early would tell a user their purchase failed while Apple is still asking
 * them to confirm it.
 */
const PURCHASE_OUTCOME_TIMEOUT_MS = 300_000;

/**
 * Start a StoreKit purchase and resolve with the transaction it produces.
 *
 * THE BUG THIS EXISTS TO FIX. The previous version awaited requestPurchase and
 * read the transaction off its return value. expo-iap says, in its own type
 * documentation: "The result is delivered through purchaseUpdatedListener -
 * NOT the return value", and "@returns The dispatched purchase payload. Do not
 * rely on it for the actual outcome." So the id was always absent, the
 * `!transactionId` guard below always fired, and every purchase reported
 * 'purchase_failed' regardless of what Apple actually did. Combined with the
 * `ios`/`apple` key error above, no sheet ever opened either.
 *
 * The listeners are attached BEFORE requestPurchase is called. StoreKit can
 * deliver a cached or instantly-approved transaction synchronously, and a
 * listener attached afterwards would miss it and then sit until the timeout.
 */
function requestPurchaseAndAwaitOutcome(
  storeKit: StoreKitModule,
  sku: string,
  appAccountToken: string,
): Promise<StoreKitPurchaseEvent> {
  return new Promise<StoreKitPurchaseEvent>((resolve, reject) => {
    let settled = false;
    let updated: { remove: () => void } | null = null;
    let failed: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Removing a listener must never be the reason a completed purchase is
      // reported as a failure, so neither remove is allowed to throw out.
      try { updated?.remove(); } catch { /* already gone */ }
      try { failed?.remove(); } catch { /* already gone */ }
      finish();
    };

    try {
      updated = storeKit.purchaseUpdatedListener((event) => {
        // The listener also fires for restored and unrelated transactions, so
        // anything carrying a different product id is not this purchase.
        if (event?.productId && event.productId !== sku) return;
        if (event?.appAccountToken && event.appAccountToken.toLowerCase() !== appAccountToken.toLowerCase()) return;

        // KEEP WAITING on a placeholder id rather than settling on it.
        //
        // StoreKit emits an interim event with an all-zeros transactionId while
        // the purchase is still settling, then emits the real one. Settling on
        // the first event sent those zeros to the Worker, which asked Apple,
        // which refused: three of our six recorded purchase attempts died
        // exactly there (see isUsableAppleTransactionId).
        //
        // Returning here is safe because this listener stays attached until
        // something settles the promise, and the outer timeout still bounds the
        // wait. The worst case is the timeout we already had, instead of a
        // confident failure on an id that was never real.
        const id = event?.transactionId ?? event?.id;
        if (!isUsableAppleTransactionId(id)) return;

        settle(() => resolve(event ?? {}));
      });
      failed = storeKit.purchaseErrorListener((error) => {
        if (error?.productId && error.productId !== sku) return;
        settle(() => reject(error ?? new Error('purchase_failed')));
      });
    } catch (err) {
      settle(() => reject(err));
      return;
    }

    timer = setTimeout(
      () => settle(() => reject(new Error('purchase_timed_out'))),
      PURCHASE_OUTCOME_TIMEOUT_MS,
    );

    // A synchronous rejection here (E_NOT_PREPARED, a validation failure) is
    // still the real outcome and must not wait for the timeout.
    Promise.resolve().then(() =>
      storeKit.requestPurchase({ request: { apple: { sku, appAccountToken } }, type: 'subs' }),
    ).catch((err) => settle(() => reject(err)));
  });
}

type ApplePurchaseIntent = { intentId: string; expiresAt: string; token: string; apiBaseUrl: string };
type AppleAdmissionResult = { intent: ApplePurchaseIntent } | Extract<AppleIapResult, { error: unknown }>;

/** Admission is immediately before the native sheet and owns the verification account. */
async function requestApplePurchaseIntent(tierId: PlanTierId): Promise<AppleAdmissionResult> {
  const apiBaseUrl = mobileCheckoutApiBaseUrl;
  if (!apiBaseUrl) return failure('purchase_unavailable');
  const token = await accessToken();
  if (!token) return failure('unauthenticated');
  try {
    return await withStoreKitTimeout((async (): Promise<AppleAdmissionResult> => {
      const response = await fetch(`${apiBaseUrl}/api/apple/iap/intent`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ tierId }),
      });
      if (response.status === 401) return failure('unauthenticated');
      if (response.status === 403) return failure('not_allowlisted');
      const payload = await response.json().catch(() => null) as { intentId?: unknown; expiresAt?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const notice = purchaseCoordinationNotice(payload?.error);
        if (notice) return { error: notice };
        if (payload?.error === 'already_subscribed_via_stripe') return failure('already_subscribed_elsewhere');
        return failure('purchase_unavailable');
      }
      if (typeof payload?.intentId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.intentId)
        || typeof payload.expiresAt !== 'string' || !(Date.parse(payload.expiresAt) > Date.now())) {
        return failure('purchase_unavailable');
      }
      return { intent: { intentId: payload.intentId, expiresAt: payload.expiresAt, token, apiBaseUrl } };
    })(), 'purchaseAdmission');
  } catch { return failure('unreachable'); }
}

async function cancelApplePurchaseIntent(intent: ApplePurchaseIntent): Promise<boolean> {
  try {
    return await withStoreKitTimeout((async () => {
      const response = await fetch(`${intent.apiBaseUrl}/api/apple/iap/intent/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${intent.token}` },
        body: JSON.stringify({ intentId: intent.intentId }),
      });
      const payload = await response.json().catch(() => null) as { canceled?: unknown } | null;
      return response.ok && payload?.canceled === true;
    })(), 'purchaseCancellation');
  } catch { return false; }
}

let purchaseInFlight = false;

/**
 * Buy after server admission and finish the transaction only after verified
 * delivery. Existing purchases may restore without opening another sheet.
 * The snapshot guard is useful early feedback; the server claim is authoritative.
 */
export async function purchaseTierWithStoreKit(
  tierId: PlanTierId,
  options: { hasActiveSubscription?: boolean; assistant?: boolean } = {},
): Promise<AppleIapResult> {
  if (!usesStoreKit()) return failure('not_ios');
  if (options.hasActiveSubscription) return failure('already_subscribed_elsewhere');

  if (purchaseInFlight) return failure('purchase_pending');
  purchaseInFlight = true;
  try {
    const storeKit = await loadStoreKit();
    if (!storeKit) return failure('module_unavailable');

    // An assistant account buys the assistant plan (£3.99, first month free),
    // never the £9.99 Studio product its tier would otherwise map to.
    const sku = appleProductIdForPurchase(tierId, options.assistant === true);
    try {
      const products = await withStoreKitTimeout(
        storeKit.fetchProducts({ skus: [sku], type: 'subs' }), 'fetchProducts',
      );
      if (!products.some((product) => product.id === sku)) return failure('product_unavailable');
    } catch (err) {
      // A timeout is not "this plan is unavailable". Saying so sends someone to
      // wait for a product that is sitting right there.
      if (/storekit_timeout/.test(String((err as Error)?.message))) {
        return failure('storekit_unresponsive');
      }
      return failure('product_unavailable');
    }

    // DOES THIS APPLE ID ALREADY OWN THE PRODUCT?
    //
    // THE DEFECT THIS EXISTS TO FIX, reproduced on Alex's phone 2026-08-27 and
    // confirmed against Apple: originalTransactionId 2000001224293610, status 1
    // (ACTIVE), product com.sidekick.v2.studio.monthly.
    //
    // StoreKit will not present a purchase sheet for a subscription the signed-in
    // Apple ID already holds. It does not error either. It emits NOTHING, so
    // requestPurchaseAndAwaitOutcome waited on a listener that could never fire
    // and the button sat on "Opening secure checkout..." for five minutes.
    //
    // Asking first turns a silent hang into one of two honest answers:
    //
    //   - the entitlement is THIS account's, so verifying it is a restore and
    //     the user gets what they already paid for, immediately;
    //   - it belongs to a DIFFERENT Delegent account, which is a real situation
    //     (a second account on a shared device, a re-test, a family member) and
    //     deserves a sentence rather than a spinner.
    //
    // An incomplete ownership lookup cannot authorize another purchase.
    // Keep the sheet closed until StoreKit can answer.
    try {
      const owned = await withStoreKitTimeout(
        storeKit.getAvailablePurchases({ onlyIncludeActiveItemsIOS: true }),
        'getAvailablePurchases',
      );
      const existing = (owned ?? []).find((entry) => entry?.productId === sku);
      const existingId = existing?.transactionId ?? existing?.id ?? null;
      if (isUsableAppleTransactionId(existingId)) {
        const verified = await verifyApplePurchaseWithWorker(String(existingId));
        // Ours already: hand it over rather than asking them to buy it twice.
        if ('purchased' in verified) return verified;
        // Someone else's: say so. Anything vaguer invites them to keep tapping.
        if (verified.error.reason === 'owned_by_another_account') return verified;
        // An existing purchase that cannot be verified is not permission to buy
        // again. Preserve its error and leave it available for Restore.
        return verified;
      }
    } catch {
      return failure('purchase_unavailable');
    }

    const admission = await requestApplePurchaseIntent(tierId);
    if ('error' in admission) return admission;
    const intent = admission.intent;

    let purchase: StoreKitPurchaseEvent | null = null;
    try {
      purchase = await requestPurchaseAndAwaitOutcome(storeKit, sku, intent.intentId);
    } catch (err) {
      // Only the library's explicit user-cancel code proves cancellation.
      // A timeout, network error or message containing "cancel" is uncertain.
      const code = (err as StoreKitPurchaseError | undefined)?.code;
      if (code === 'user-cancelled' || code === 'E_USER_CANCELLED') {
        return failure(await cancelApplePurchaseIntent(intent) ? 'cancelled' : 'purchase_pending');
      }
      return failure('purchase_pending');
    }

    const transactionId = purchase?.transactionId ?? purchase?.id ?? null;
    // A placeholder id is refused here too, not only in the listener. This is the
    // last gate before the Worker is asked, and it must not depend on the
    // listener being the only way a purchase reaches this line.
    if (!isUsableAppleTransactionId(transactionId)) return failure('purchase_failed');

    const verified = await verifyApplePurchaseWithWorker(String(transactionId), { token: intent.token, apiBaseUrl: intent.apiBaseUrl });

    if ('purchased' in verified) {
      try {
        await storeKit.finishTransaction({ purchase: { id: String(transactionId) }, isConsumable: false });
      } catch {
        // Already entitled. An unfinished transaction is replayed by StoreKit on
        // next launch and verifies again idempotently, so this is not worth
        // surfacing to someone who has just successfully subscribed.
      }
    }
    return verified;
  } finally { purchaseInFlight = false; }
}
