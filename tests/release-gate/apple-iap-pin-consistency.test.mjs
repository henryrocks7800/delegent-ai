// Apple in-app purchase: the invariants that would fail silently.
//
// Apple rejected 2.5.0 (37) on 2026-08-18 under Guideline 3.1.1, and the two
// lawful answers pull in opposite directions:
//
//   'hidden'  Guideline 3.1.3(f). iOS shows NO price and NO purchase path.
//   'iap'     Guideline 3.1.1. StoreKit does the purchase.
//
// Both fail QUIETLY when they break, which is what this file is for:
//
//   1. A product id that disagrees between App Store Connect, the device and
//      the Worker does not error. StoreKit simply returns no product, or the
//      Worker maps a real purchase to no tier and grants nothing. The customer
//      pays and gets an error.
//   2. A price or a purchase verb creeping into the 'hidden' copy does not
//      break a test, it breaks the App Store submission, weeks later, in a
//      rejection email.
//
// Source-level regex on the Python script for the same reason
// model-pin-consistency does it: importing it would need a Python runtime in a
// Node test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// URL.pathname yields "/C:/..." on Windows and is not a filesystem path.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A nested Node test runner must not inherit the parent's binary test channel.
const { NODE_TEST_CONTEXT: _parentTestContext, ...behaviorTestEnv } = process.env;

const SHARED_SOURCE = readFileSync(join(REPO, 'packages/shared/src/appleIap.ts'), 'utf8');
const ASC_SCRIPT = readFileSync(join(REPO, 'infra/scripts/apple-create-iap-products.py'), 'utf8');
const ASSISTANT_ASC_SCRIPT = readFileSync(join(REPO, 'infra/scripts/apple-create-assistant-subscription.py'), 'utf8');
const WORKER_SOURCE = readFileSync(join(REPO, 'apps/worker/src/apple-iap.ts'), 'utf8');
const MIGRATION = readFileSync(join(REPO, 'supabase/migrations/0054_apple_iap.sql'), 'utf8');
const MOBILE_IAP_SOURCE = readFileSync(join(REPO, 'apps/mobile/src/billing/appleIap.ts'), 'utf8');
const MOBILE_APP_SOURCE = readFileSync(join(REPO, 'apps/mobile/App.tsx'), 'utf8');
const MOBILE_PACKAGE = JSON.parse(readFileSync(join(REPO, 'apps/mobile/package.json'), 'utf8'));

function productIdsFrom(text) {
  return [...text.matchAll(/com\.sidekick\.v2\.[a-z]+\.monthly/g)].map((m) => m[0]).sort();
}

test('the product ids in shared are exactly the ones the ASC scripts create', () => {
  const shared = [...new Set(productIdsFrom(SHARED_SOURCE))];
  // Three workspace plans from the original script, plus the assistant plan
  // (£3.99, first month free; Alex 2026-09-16) from its own.
  const asc = [...new Set([...productIdsFrom(ASC_SCRIPT), ...productIdsFrom(ASSISTANT_ASC_SCRIPT)])].sort();

  assert.equal(shared.length, 4, 'expected one product id per plan tier, plus the assistant plan');
  assert.deepEqual(
    shared, asc,
    'App Store Connect and the app disagree about product ids. StoreKit will '
    + 'return no product for the mismatched tier and the purchase button will '
    + 'do nothing, with no error anywhere.',
  );
});

test('every plan tier has a product id, and no tier shares one', () => {
  const tiers = [...SHARED_SOURCE.matchAll(/^\s*'?([a-z-]+)'?:\s*'(com\.sidekick\.v2\.[a-z]+\.monthly)'/gm)]
    .map((m) => ({ tier: m[1], productId: m[2] }));

  assert.equal(tiers.length, 3, 'expected three tier -> product id entries');
  assert.deepEqual(
    tiers.map((entry) => entry.tier).sort(),
    ['enterprise-suite', 'pro-office', 'studio'],
    'the tier ids must match SIDEKICK_PLAN_TIERS',
  );
  assert.equal(
    new Set(tiers.map((entry) => entry.productId)).size, 3,
    'two tiers share a product id, so one of them can never be bought',
  );
});

test('the reverse lookup refuses to default an unknown product to a tier', () => {
  // The failure this prevents is a free subscription: anyone able to buy any
  // product from any app in the team would otherwise land on the fallback tier.
  assert.match(
    SHARED_SOURCE,
    /return match \?\? null;/,
    'planTierIdForAppleProduct must return null for an unknown product id, never a fallback tier',
  );
  assert.ok(
    !/\?\?\s*'studio'/.test(SHARED_SOURCE),
    'a default of studio in the product lookup would grant a plan for an unrecognised purchase',
  );
});

test("the 'hidden' copy contains no price, no link and no purchase call to action", () => {
  // This is the screen an App Review reviewer reads to decide whether the app
  // contains a "call to action for purchase outside of the app". Guideline
  // 3.1.3(f) is conditional on there being none.
  const copy = [
    ...SHARED_SOURCE.matchAll(/IOS_NO_SUBSCRIPTION_(?:TITLE|BODY)\s*=\s*\n?\s*'([^']*)'/g),
  ].map((m) => m[1]);

  assert.equal(copy.length, 2, 'expected both the title and the body to be found');
  const joined = copy.join(' ');

  assert.ok(!/[£$€]\s*\d/.test(joined), `a price appears in the no-purchase copy: ${joined}`);
  assert.ok(!/https?:\/\//.test(joined), `a URL appears in the no-purchase copy: ${joined}`);
  assert.ok(
    !/\b(subscribe|upgrade|buy|purchase|checkout|plan[s]?\s+start|sign\s+up\s+at|visit)\b/i.test(joined),
    `a purchase call to action appears in the no-purchase copy: ${joined}`,
  );
});

test('the allowlist fails closed, so an unset variable cannot open Apple billing to everyone', () => {
  assert.match(
    WORKER_SOURCE,
    /if \(allowlist\.length === 0\) return false;/,
    'an empty SIDEKICK_APPLE_IAP_ALLOWLIST must mean nobody. Reading it as '
    + '"everybody" would open a second billing path to every customer on the '
    + 'first deploy that forgot to set it.',
  );
});

test('entitlement is written from Apple, never from the payload that arrived', () => {
  // The whole security model of apps/worker/src/apple-iap.ts. If a grant is
  // ever made straight from a decoded payload, a forged notification becomes a
  // free subscription.
  assert.match(
    WORKER_SOURCE,
    /decodeJwsPayloadUnverified/,
    'the unverified decoder should still exist and still be named unverified',
  );
  const grantingCalls = [...WORKER_SOURCE.matchAll(/applyAppleEntitlement\(env, \{[^}]*info: ([a-zA-Z.]+)/g)]
    .map((m) => m[1]);
  assert.ok(grantingCalls.length >= 2, 'expected the verify and notification paths to both grant');
  for (const source of grantingCalls) {
    assert.ok(
      /^(authoritative|state\.info)$/.test(source),
      `applyAppleEntitlement was called with "${source}". It may only be given a `
      + 'record fetched from Apple (authoritative / state.info), never one decoded '
      + 'from an inbound payload.',
    );
  }
});

test('the migration keeps a provider-aware active-subscription guarantee', () => {
  // Migration 0004 required Stripe ids on any active row, which no Apple
  // subscription can satisfy. Dropping that check outright rather than
  // replacing it would let a half-written row of either kind go active.
  assert.match(MIGRATION, /drop constraint if exists subscriptions_active_requires_provider_ids_check/);
  assert.match(MIGRATION, /billing_provider = 'stripe'[\s\S]*stripe_subscription_id is not null/);
  assert.match(MIGRATION, /billing_provider = 'apple'[\s\S]*apple_original_transaction_id is not null/);
});

test('one Apple subscription cannot entitle two accounts', () => {
  assert.match(
    MIGRATION,
    /create unique index if not exists subscriptions_apple_original_transaction_idx/,
    'without a unique index one Apple ID could be replayed across accounts and '
    + 'entitle all of them from a single payment',
  );
});

test('an iOS StoreKit build has NO route to Stripe, not even to manage a plan', () => {
  // The rejection everyone remembers is the buy button. The one that would
  // have shipped again is "Manage plan": every billing control in the app
  // (Manage plan, Resubscribe, cancel) routes through handleBillingPortal,
  // which opened the Stripe customer portal in Safari unconditionally. That is
  // the same Guideline 3.1.1 hand-off, one tap later.
  const handler = MOBILE_APP_SOURCE.slice(
    MOBILE_APP_SOURCE.indexOf('const handleBillingPortal'),
    MOBILE_APP_SOURCE.indexOf('const refreshRunnerFiles'),
  );
  assert.ok(handler.length > 0, 'handleBillingPortal should still exist');
  assert.match(
    handler,
    /if \(usesStoreKit\(\)\)/,
    'handleBillingPortal must check usesStoreKit() before it can reach Stripe',
  );
  assert.ok(
    handler.indexOf('usesStoreKit()') < handler.indexOf('openStripeBillingPortal'),
    'the StoreKit branch must come BEFORE the Stripe call, or iOS still opens '
    + 'the Stripe portal before the gate is consulted',
  );
  assert.match(
    handler,
    /manageAppleSubscription\(\)/,
    'iOS must be sent to Apple subscription management, not left with a dead button',
  );

  // The gate belongs on the shared handler, not sprinkled on buttons. If some
  // future surface calls openStripeBillingPortal directly it bypasses all of
  // the above, so pin the number of call sites.
  const directCalls = [...MOBILE_APP_SOURCE.matchAll(/openStripeBillingPortal\(/g)].length;
  assert.ok(
    directCalls <= 4,
    `openStripeBillingPortal is called ${directCalls} times. Every call site is a `
    + 'potential Guideline 3.1.1 hand-off on iOS. Route new billing controls '
    + 'through handleBillingPortal instead of raising this number.',
  );
});

test('an iOS build never names Stripe, and never offers a purchase it must refuse', () => {
  // All three found on a real device on 2026-08-19, on one screen.

  // 1. The refusal was titled as an outage. "This account already has a
  //    subscription billed outside the App Store" appeared under "Checkout is
  //    temporarily offline", which tells a customer to come back later for
  //    something that will never change.
  assert.match(
    MOBILE_APP_SOURCE,
    /errorReason: storeKitResult\.error\.reason === 'already_subscribed_elsewhere'\s*\?\s*'managed_elsewhere'/,
    'the StoreKit refusal must map to its own reason, not be flattened to unavailable',
  );
  assert.match(
    MOBILE_APP_SOURCE,
    /managed_elsewhere: 'Your plan is billed elsewhere'/,
    'managed_elsewhere needs a title that states a fact rather than an outage',
  );

  // 2. Stripe was named on iOS in two places, and the accessibility label is
  //    the worse one: a VoiceOver user, or a reviewer testing with VoiceOver,
  //    heard "Open secure Stripe Checkout" while StoreKit took the payment.
  assert.match(
    MOBILE_APP_SOURCE,
    /const purchaseNoun = storeKitPurchase \? 'the App Store purchase' : 'Stripe Checkout';/,
    'the payment route named in the accessibility label must follow the platform',
  );
  assert.doesNotMatch(
    MOBILE_APP_SOURCE,
    /Open secure Stripe Checkout for/,
    'no hardcoded Stripe wording on a control that StoreKit can drive',
  );
  assert.match(
    MOBILE_APP_SOURCE,
    /const planChangeCaption = storeKitPurchase\s*\?\s*'Managed by Apple'/,
    'the proration caption must not promise what Stripe will do on an Apple purchase',
  );

  // 3. "Change to Pro" was tappable for a subscription StoreKit did not sell,
  //    and the only possible outcome was a refusal AFTER the tap.
  // Became provider-aware on 2026-08-20. What must stay true is that a plan
  // change StoreKit CANNOT perform is not tappable. What changed is which
  // changes those are: a subscription Apple itself sold can be changed through
  // StoreKit, because Apple treats it as an upgrade within the group. Only a
  // subscription billed somewhere else is genuinely unperformable here, and
  // "somewhere else" now includes an unknown provider, so the refusal still
  // covers a database without migration 0055.
  assert.match(
    MOBILE_APP_SOURCE,
    /disabled=\{actionInFlight\s*\n\s*\|\| \(storeKitPurchase && selectedPlanNeedsChange\s*\n\s*&& productView\.billingProvider !== 'apple'\)\}/,
    'a plan change StoreKit cannot perform must not be tappable, and that is '
    + 'now judged by the billing provider rather than by "is this an iOS build"',
  );
  assert.match(
    MOBILE_APP_SOURCE,
    /testID="billing\.managedElsewhereNotice"/,
    'and the reason must be on screen BEFORE the tap, not after it',
  );
});

test('Android and web keep Stripe, because only iOS is restricted', () => {
  // The gate must be platform-conditional, never a blanket removal. Android
  // and the web app have no StoreKit and must keep taking money through
  // Stripe; a change that "fixed" iOS by deleting the Stripe path everywhere
  // would stop the two surfaces that actually have paying customers.
  assert.match(
    SHARED_SOURCE,
    /export function shouldUseStoreKit\(input: \{[\s\S]*?\}\): boolean \{\s*return input\.platform === 'ios' && input\.iosPurchaseMode === 'iap';/,
    'shouldUseStoreKit must be true ONLY for iOS in iap mode',
  );
  assert.match(
    SHARED_SOURCE,
    /if \(input\.platform !== 'ios'\) return true;/,
    'mayShowPurchaseUi must return true for every non-iOS platform, so Android '
    + 'and web keep their prices and their Stripe checkout',
  );
});

test('a customer who already pays via Stripe cannot be billed a second time by Apple', () => {
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^unknown admission state',
    'apps/worker/test/apple-purchase-admission.test.mjs'], { cwd: REPO, encoding: 'utf8', env: behaviorTestEnv });
  assert.match(output, /# pass 1\b/, 'server admission must refuse existing service and uncertain state before Apple purchase');
  // The gate became provider-aware on 2026-08-20 so an Apple subscriber can
  // change tier, which Apple treats as an upgrade within the subscription
  // group rather than a second purchase. What must NOT change is that the
  // refusal still happens on the device, before StoreKit opens: the Worker's
  // matching refusal can only fire once Apple has already taken the money.
  // storeKitPurchaseBlockedByExistingSubscription blocks anything that is not
  // provably Apple, including an unknown provider, so Stripe is still refused.
  assert.match(
    MOBILE_APP_SOURCE,
    /hasActiveSubscription: storeKitPurchaseBlockedByExistingSubscription\(productState\)/,
    'the app must refuse BEFORE opening StoreKit. The Worker refusal can only '
    + 'fire once Apple has already taken the money.',
  );
  assert.match(
    MOBILE_IAP_SOURCE,
    /if \(options\.hasActiveSubscription\) return failure\('already_subscribed_elsewhere'\)/,
    'the client guard must run before loadStoreKit, not after a purchase',
  );
  // Order matters: guarding after the purchase call would charge the customer
  // and then refuse them, which is the outcome the guard exists to prevent.
  //
  // Scoped to purchaseTierWithStoreKit's body, NOT the whole file. It used to
  // scan the file and passed only by luck: adding manageAppleSubscription,
  // which also calls loadStoreKit and sits earlier in the file, moved the
  // first match and failed the assertion without anything being wrong. A test
  // that breaks when an unrelated function is added is not pinning what it
  // claims to pin.
  const purchaseFn = MOBILE_IAP_SOURCE.slice(
    MOBILE_IAP_SOURCE.indexOf('export async function purchaseTierWithStoreKit'),
  );
  assert.ok(purchaseFn.length > 0, 'purchaseTierWithStoreKit should still exist');
  assert.ok(
    purchaseFn.indexOf("failure('already_subscribed_elsewhere')")
    < purchaseFn.indexOf('await loadStoreKit()'),
    'the hasActiveSubscription refusal must come before StoreKit is loaded',
  );
});

test('the guard fails closed when Supabase cannot answer', () => {
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^unknown admission state',
    'apps/worker/test/apple-purchase-admission.test.mjs'], { cwd: REPO, encoding: 'utf8', env: behaviorTestEnv });
  assert.match(output, /# pass 1\b/, 'a database outage must return retryable 503 and make no entitlement write');
});

test('the iap build has the StoreKit dependency it degrades without', () => {
  // Build 33 is the cautionary tale: a native module that was only a
  // transitive dependency got dropped when EAS regenerated the lockfile, and
  // every install crashed. expo-iap must be a direct dependency of the mobile
  // app, not something the loader merely hopes to find.
  assert.ok(
    MOBILE_PACKAGE.dependencies?.['expo-iap'],
    'expo-iap must be a direct dependency of @sidekick/mobile, or an `iap` '
    + 'build silently degrades to "this build cannot take payments"',
  );
});

test('the audit table is revoked from both roles, not just anon', () => {
  // Migration 0051 enabled RLS and left anon AND authenticated holding the
  // grants Supabase hands out by default; 0052 had to come back and fix it.
  assert.match(MIGRATION, /revoke all on public\.apple_iap_events from anon;/);
  assert.match(MIGRATION, /revoke all on public\.apple_iap_events from authenticated;/);
});

// -- the StoreKit call shape, pinned to the library rather than to ourselves --
//
// These exist because on 2026-08-20 every gate in this repo was green while the
// purchase path could not work at all. appleIap.ts declares its own type for
// the dynamically imported expo-iap module, so typecheck, lint and all 326
// mobile tests were only ever checking our mock against our mock. Two errors
// hid in that gap: the request used an `ios` key that expo-iap does not have,
// and the outcome was read from requestPurchase's return value, which its docs
// say never carries it. Alex saw "Checkout is temporarily offline" on a healthy
// product and no Apple sheet ever opened.
//
// Comments are stripped before matching. CLAUDE.md records that whole-file
// assertions matching a file's own prose has bitten this repo three times, and
// the comments above the fixed code quote the very strings under test.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MOBILE_IAP_CODE = codeOnly(MOBILE_IAP_SOURCE);

test('the subscription request uses expo-iap\'s `apple` key, not `ios`', () => {
  // RequestSubscriptionPropsByPlatforms has exactly two keys, `apple` and
  // `google`. An `ios` key is silently dropped, so StoreKit receives no sku,
  // rejects the request before showing a sheet, and the user is told checkout
  // is offline.
  const types = readFileSync(
    join(REPO, 'node_modules/expo-iap/build/types.d.ts'), 'utf8',
  );
  const iface = types.slice(
    types.indexOf('export interface RequestSubscriptionPropsByPlatforms'),
  ).slice(0, 400);

  assert.match(iface, /apple\?:/, 'expo-iap should expose an `apple` key');
  const iosProps = types.slice(types.indexOf('export interface RequestPurchaseIosProps'));
  assert.match(iosProps.slice(0, 1300), /appAccountToken\?:/, 'the installed native request contract supports the admission token');
  assert.ok(
    !/\bios\?:/.test(iface),
    'expo-iap gained an `ios` key. Re-read the interface before trusting this test',
  );
  assert.match(
    MOBILE_IAP_CODE,
    /request:\s*\{\s*apple:\s*\{\s*sku,\s*appAccountToken\s*\}/,
    'the purchase request must include { apple: { sku, appAccountToken } }. An `ios` key reaches '
    + 'StoreKit as no sku at all and no purchase sheet ever opens',
  );
});

test('the purchase outcome is read from the listener, not the return value', () => {
  // expo-iap: "The result is delivered through purchaseUpdatedListener - NOT
  // the return value", and "@returns The dispatched purchase payload. Do not
  // rely on it for the actual outcome."
  assert.match(
    MOBILE_IAP_CODE,
    /purchaseUpdatedListener\(/,
    'the transaction must come from purchaseUpdatedListener. Reading it off '
    + 'requestPurchase makes every purchase report purchase_failed, including '
    + 'the ones Apple actually took money for',
  );
  assert.match(
    MOBILE_IAP_CODE, /purchaseErrorListener\(/,
    'without the error listener a declined or cancelled purchase hangs until timeout',
  );
  assert.ok(
    !/await\s+storeKit\.requestPurchase\([^)]*\)\s*as\s/.test(MOBILE_IAP_CODE),
    'requestPurchase\'s return value must not be cast to a purchase',
  );
});

// -- an Apple subscriber must be able to change tier ------------------------
//
// The app could not tell Apple from Stripe, so it refused a tier change to
// EVERY subscriber and told Apple customers their plan was "billed outside the
// App Store". False for them, and it left them no way to upgrade in-app at all.
// Migration 0055 surfaces billing_provider; these pin the whole chain.

const MIGRATION_0055 = readFileSync(
  join(REPO, 'supabase/migrations/0055_product_state_billing_provider.sql'), 'utf8',
);
const SHARED_INDEX = codeOnly(readFileSync(join(REPO, 'packages/shared/src/index.ts'), 'utf8'));
const MOBILE_APP_CODE = codeOnly(MOBILE_APP_SOURCE);

test('my_product_state exposes billing_provider', () => {
  assert.match(MIGRATION_0055, /create or replace view public\.my_product_state as/);
  assert.match(MIGRATION_0055, /s\.billing_provider\s*\nfrom public\.profiles p/,
    'billing_provider must be the LAST column in the select list. '
    + 'create or replace view permits additions only at the end, so putting it '
    + 'beside the other subscription fields, where it reads better, fails on apply');
  assert.match(MIGRATION_0055, /grant select on public\.my_product_state to authenticated;/,
    'replacing a view drops its grants; re-granting is not optional');
});

test('an unrecognised billing_provider degrades to undefined, never to apple', () => {
  // undefined must mean "not provably Apple" so an un-migrated database keeps
  // the safe refusal instead of opening a double-billing path.
  assert.match(
    SHARED_INDEX,
    /billingProvider:\s*row\.billing_provider === 'apple' \|\| row\.billing_provider === 'stripe'/,
    'the provider must be narrowed against known values, not cast',
  );
});

test('StoreKit is refused for non-Apple subscribers and allowed for Apple ones', () => {
  assert.match(
    MOBILE_APP_CODE,
    /function storeKitPurchaseBlockedByExistingSubscription/,
    'the purchase gate must be its own function, not a widened '
    + 'checkoutSnapshotHasActiveSubscription, which also drives the activation poller',
  );
  assert.match(
    MOBILE_APP_CODE,
    /return snapshot\.subscription\?\.billingProvider !== 'apple';/,
    'block anything not provably Apple. Inverting this double-bills a Stripe customer',
  );
  assert.match(
    MOBILE_APP_CODE,
    /hasActiveSubscription:\s*storeKitPurchaseBlockedByExistingSubscription\(productState\)/,
    'the purchase call must use the provider-aware gate',
  );
  // The poller's meaning must not have been widened along with it.
  assert.match(
    MOBILE_APP_CODE,
    /!checkoutSnapshotHasActiveSubscription\(snapshot\)/,
    'refreshUntilCheckoutSubscriptionActive must still use the plain helper',
  );
});

test('the UI gate and the purchase gate agree about who may change tier', () => {
  // TWO gates guard a tier change and they must move together. On 2026-08-20
  // only the purchase gate was made provider-aware, so the button stayed
  // disabled and the card still told a customer who had bought through
  // StoreKit an hour earlier that their plan "was not bought through the App
  // Store". The fix was invisible because the user could not reach it.
  const gates = MOBILE_APP_CODE.match(
    /storeKitPurchase && selectedPlanNeedsChange[\s\S]{0,80}?billingProvider !== 'apple'/g,
  ) ?? [];
  assert.equal(
    gates.length, 2,
    'expected exactly two provider-aware gates, the notice and the disabled '
    + 'button. Found ' + gates.length + '. A bare `storeKitPurchase && '
    + 'selectedPlanNeedsChange` refuses Apple subscribers too',
  );
  assert.ok(
    !/disabled=\{actionInFlight \|\| \(storeKitPurchase && selectedPlanNeedsChange\)\}/
      .test(MOBILE_APP_CODE),
    'the button must not be disabled without checking the provider',
  );
  assert.match(
    MOBILE_APP_CODE,
    /billingProvider: snapshot\.subscription\?\.billingProvider/,
    'the view model must carry the provider, or the gates cannot see it',
  );
});

test('a purchase Apple took but we never granted can be recovered', () => {
  // The most dangerous gap in the feature, and it was hit for real on
  // 2026-08-20: Apple charged, the Worker answered 403 because the account was
  // not allowlisted, and the customer had paid for nothing. Apple will not sell
  // the same subscription twice, so with no restore the only route back is a
  // support ticket.
  const iap = codeOnly(readFileSync(join(REPO, 'apps/mobile/src/billing/appleIap.ts'), 'utf8'));
  assert.match(iap, /export async function restoreApplePurchases/);
  assert.match(
    iap, /getAvailablePurchases\(\{ onlyIncludeActiveItemsIOS: true \}\)/,
    'restore must ask the store what it still holds; nothing else can recover a lost grant',
  );
  assert.match(
    iap, /ALL_APPLE_IAP_PRODUCT_IDS\.includes\(productId\)/,
    'only our own products may be sent for verification',
  );
  // It must run automatically, not only behind a button someone has to find.
  assert.match(
    MOBILE_APP_CODE, /restoreApplePurchases\(\)/,
    'the app must attempt a restore itself',
  );
  assert.match(
    MOBILE_APP_CODE, /if \(isEntitledSubscriptionStatus\(status\)\) return;/,
    'restore must run only when we believe there is NO subscription, which is '
    + 'the state a silently lost purchase leaves behind',
  );
});
