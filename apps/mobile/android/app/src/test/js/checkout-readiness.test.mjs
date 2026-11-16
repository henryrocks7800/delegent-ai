import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');
const checkoutUrl = new URL('../../../../../src/billing/mobileCheckout.ts', import.meta.url);
const checkoutSource = existsSync(checkoutUrl) ? readFileSync(checkoutUrl, 'utf8') : '';
const stripeServerSource = readFileSync(new URL('../../../../../../../packages/billing/src/serverFlow.ts', import.meta.url), 'utf8');
const stripeTestSource = readFileSync(new URL('../../../../../../../apps/web/test/stripe-real-flow.test.ts', import.meta.url), 'utf8');

test('mobile checkout client calls the authenticated Stripe checkout API and returns only a safe Stripe URL', () => {
  assert.ok(existsSync(checkoutUrl), 'src/billing/mobileCheckout.ts should exist');
  assert.match(checkoutSource, /EXPO_PUBLIC_SIDEKICK_API_BASE_URL/);
  assert.match(checkoutSource, /generatedExpoPublicEnv\.EXPO_PUBLIC_SIDEKICK_API_BASE_URL \|\|\s*process\.env\.EXPO_PUBLIC_SIDEKICK_API_BASE_URL/);
  assert.match(checkoutSource, /\/api\/stripe\/checkout/);
  assert.match(checkoutSource, /getFreshMobileAccessToken\(mobileSupabase\)/);
  assert.match(checkoutSource, /getRememberedMobileAccessToken\(\)/);
  assert.match(checkoutSource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(checkoutSource, /accept:\s*'application\/json'/);
  assert.match(checkoutSource, /redirect:\s*'manual'/);
  assert.match(checkoutSource, /MOBILE_CHECKOUT_REQUEST_TIMEOUT_MS/);
  assert.match(checkoutSource, /withMobileCheckoutTimeout/);
  assert.match(checkoutSource, /AbortController/);
  assert.match(checkoutSource, /signal/);
  assert.match(checkoutSource, /payloadUrl/);
  assert.match(checkoutSource, /checkout\.stripe\.com/);
  assert.match(checkoutSource, /buildMobileCheckoutUrl/);
  assert.match(checkoutSource, /safeStripeCheckoutUrl/);
  assert.doesNotMatch(checkoutSource, /SERVICE_ROLE|STRIPE_SECRET|WEBHOOK_SECRET|OPENROUTER|RAILWAY|CLOUDFLARE|BOT_TOKEN/i);
});

test('mobile billing portal client opens only authenticated Stripe Billing Portal sessions', () => {
  assert.ok(existsSync(checkoutUrl), 'src/billing/mobileCheckout.ts should exist');
  assert.match(checkoutSource, /requestStripeBillingPortal/);
  assert.match(checkoutSource, /\/api\/stripe\/portal/);
  assert.match(checkoutSource, /billing\.stripe\.com/);
  assert.match(checkoutSource, /buildMobileBillingPortalUrl/);
  assert.match(checkoutSource, /safeStripeBillingPortalUrl/);
  assert.match(checkoutSource, /returnUrl/);
  assert.match(checkoutSource, /getFreshMobileAccessToken\(mobileSupabase\)/);
  assert.match(checkoutSource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(checkoutSource, /accept:\s*'application\/json'/);
  assert.match(checkoutSource, /payloadUrl/);
  assert.doesNotMatch(checkoutSource, /SERVICE_ROLE|STRIPE_SECRET|WEBHOOK_SECRET|OPENROUTER|RAILWAY|CLOUDFLARE|BOT_TOKEN/i);
});

test('setup plan picker opens hosted checkout and refreshes product state on return', () => {
  assert.match(appSource, /requestStripeCheckout/);
  assert.match(appSource, /handlePlanCheckout/);
  assert.match(appSource, /MobileCheckoutErrorReason/);
  assert.match(appSource, /checkoutErrorTitle/);
  assert.match(appSource, /Linking\.openURL\(checkout\.url\)/);
  assert.match(appSource, /<TierSegment selectedTier=\{selectedTier\} onChange=\{chooseTier\} \/>/);
  assert.match(appSource, /<PlanCard\s+tier=\{selectedPlan\}\s+isCurrent=\{selectedPlanIsCurrent\}/);
  assert.match(appSource, /Pick a plan/);
  assert.match(appSource, /'Pay securely'/);
  // v1.2.1 footer captions: after the messenger step is gone, the
  // "already subscribed" caption reads "Ready to chat". The primary button
  // read "Meet ${agentName}" until 2026-09-23 (QA F35: a paying subscriber
  // opening Plan & billing got the welcome pitch); it now reads "Go to chat",
  // under a "Your plan" heading.
  assert.match(appSource, /'Ready to chat'/);
  assert.match(appSource, /selectedPlanIsCurrent\s*\?\s*'Go to chat'/);
  assert.doesNotMatch(appSource, /selectedPlanIsCurrent\s*\?\s*`Meet \$\{productView\.agentName\}`/);
  assert.match(appSource, /productView\.hasActiveSubscription \? 'Your plan' : 'Meet your connected AI coworker'/);
  // [#11] When selectedPlanNeedsChange, the caption was "Change plan",
  // which duplicated the button label sitting right below it. It now says
  // what the change will cost, which is not the same sentence for a move up
  // as for a move down, so it comes from the shared planChangeNote.
  assert.match(appSource, /planChangeNote\(selectedPlanIsDowngrade\)/);
  assert.match(appSource, /AppState\.addEventListener\('change'/);
  assert.match(appSource, /checkoutRefreshPending/);
  assert.match(appSource, /productState\.refresh\(\)/);
  assert.match(appSource, /CheckoutError/);
  assert.match(appSource, /Open secure checkout/);
  assert.match(appSource, /'Go to chat'/);
  assert.match(appSource, /Change to \$\{selectedPlan\.name\}/);
  assert.match(appSource, /CHECKOUT_CONFIRMATION_POLL_ATTEMPTS/);
  assert.match(appSource, /refreshUntilCheckoutSubscriptionActive/);
  assert.match(appSource, /checkoutSnapshotHasActiveSubscription/);
  assert.match(appSource, /advanceAfterSubscription/);
  // v1.2.1: post-checkout users land on Home (chat surface), not the
  // retired Connections tab.
  assert.match(appSource, /advanceToHomeAfterSubscription/);
  assert.match(appSource, /setActiveTab\('dashboard'\)/);
  assert.match(appSource, /checkout_refused/);
  assert.match(appSource, /plan_change_required/);
  // D3/D5/D6 fix (2026-05-20): the two server-side checkout-decline reasons no
  // longer collapse to "advance home". `plan_change_required` opens the Stripe
  // billing portal for the target tier so the user can complete the upgrade;
  // `checkout_refused` (already on this plan) refreshes the snapshot and only
  // advances home when the subscription is confirmed active.
  assert.match(
    appSource,
    /if \(result\.error\.reason === 'plan_change_required'\)[\s\S]*?openStripeBillingPortal\(tierId\)/,
    'plan_change_required must route through the Stripe billing portal',
  );
  assert.match(
    appSource,
    /if \(result\.error\.reason === 'checkout_refused'\)[\s\S]*?advanceAfterSubscription\(snapshot, tierId\)/,
    'checkout_refused must refresh + advance when an active subscription is confirmed',
  );
  // The plan-picker button is binary now: current plan → continue home,
  // otherwise → fresh Stripe Checkout (handles both new-sub and tier-change).
  assert.match(
    appSource,
    /if \(selectedPlanIsCurrent\) \{[\s\S]*?onContinueToHome\(\);[\s\S]*?\} else \{[\s\S]*?onOpenCheckout\(selectedTier\);/,
    'plan-picker onPress must branch current-plan → home, otherwise → checkout',
  );
  assert.match(appSource, /onOpenBillingPortal=\{onOpenBillingPortal\}/);
  assert.match(checkoutSource, /subscription_change_required/);
  assert.match(checkoutSource, /You're already subscribed to \$\{currentTierName\}/);
  assert.match(checkoutSource, /Open billing to change to \$\{requestedTierName\}/);
  assert.match(appSource, /onOpenCheckout=\{handlePlanCheckout\}/);
  assert.match(appSource, /Checkout isn’t connected yet/);
  assert.match(appSource, /Checkout is temporarily offline/);
  assert.match(checkoutSource, /This app build is missing the checkout API link/);
  assert.match(checkoutSource, /Checkout is temporarily unavailable on our side/);
  assert.doesNotMatch(appSource, /Stripe secret|service-role|webhook secret|Railway|Cloudflare|OpenRouter/);
});

test('capacity and plan management surfaces open the Stripe Billing Portal then refresh quota state', () => {
  assert.match(appSource, /requestStripeBillingPortal/);
  assert.match(appSource, /handleBillingPortal/);
  assert.match(appSource, /Linking\.openURL\(portal\.url\)/);
  assert.match(appSource, /billingPortalRefreshPending/);
  assert.match(appSource, /BillingPortalState/);
  assert.match(appSource, /Manage plan & payment/);
  // 2026-05-15 copy pass: "Opening billing portal…" trimmed to "Opening billing…".
  assert.match(appSource, /Opening billing…/);
  // 2026-05-15 copy pass: status trimmed from "Refreshing capacity…" to "Refreshing…".
  assert.match(appSource, /'Refreshing…'/);
  // 2026-05-15 copy pass: hard-limited heading rewritten from "Monthly capacity
  // reached" to "You’ve used this month’s capacity" — same idea, friendlier.
  assert.match(appSource, /You’ve used this month’s capacity/);
  // 2026-05-15 copy pass: near-limit heading trimmed to "Capacity is nearly full".
  assert.match(appSource, /Capacity is nearly full/);
  assert.match(appSource, /onOpenBillingPortal=\{handleBillingPortal\}/);
  assert.match(appSource, /onProductRetry/);
  assert.doesNotMatch(appSource, /Stripe secret|service-role|webhook secret|Railway|Cloudflare|OpenRouter/);
});

test('downgrade plan changes are scheduled or storage-blocked in-app without opening the browser', () => {
  // (1) Scheduled downgrade: the worker returns a JSON body (HTTP 200, NOT a
  //     portal URL) so a paid tier is never shrunk mid-cycle. The client parses
  //     it into a { scheduled } result and never hands off to Stripe.
  assert.match(checkoutSource, /payload\.scheduled === true/);
  assert.match(checkoutSource, /downgradeScheduledResult/);
  assert.match(checkoutSource, /scheduled: \{ targetTierId/);
  // The wording itself is no longer written here. It was written once per
  // surface and drifted, so it moved to @sidekick/shared and is asserted in
  // packages/shared/test/billing-outcome-copy.test.mjs. What this file holds is
  // that the phone still reads it from there rather than growing its own again.
  assert.match(checkoutSource, /downgradeScheduledMessage\(\{/);
  assert.match(checkoutSource, /targetTierShortName: planShortNameOrNull\(targetTierId\)/);
  // Human plan name comes from the shared plan tiers (shortName: Studio/Pro/Max).
  assert.match(checkoutSource, /getPlanTier\(tierId\)\.shortName/);

  // (2) Storage-over-limit block (HTTP 409, error=downgrade_storage_over_limit):
  //     a calm, non-scary message that points at Files, never opens the browser,
  //     and never deletes anything.
  assert.match(checkoutSource, /downgrade_storage_over_limit/);
  assert.match(checkoutSource, /downgradeStorageBlockResult/);
  assert.match(checkoutSource, /storageDowngradeBlockBody\(\{/);
  assert.match(checkoutSource, /currentStorageBytes: payload\.currentStorageBytes/);
  assert.match(checkoutSource, /targetStorageBytes: payload\.targetStorageBytes/);
  // And the plan being moved to, by name. Dropping it degrades the message to
  // "the smaller plan" without breaking anything, which is the quiet kind.
  assert.match(checkoutSource, /targetTierShortName: planShortNameOrNull\(parsePlanTierId\(payload\.targetTierId\)\)/);

  // (2b) Neither message may be re-typed here. A second copy is exactly how the
  //      two surfaces drifted the first time.
  assert.doesNotMatch(checkoutSource, /free up space in Files/i, 'storage block copy belongs in @sidekick/shared');
  assert.doesNotMatch(checkoutSource, /You keep everything/i, 'scheduled downgrade copy belongs in @sidekick/shared');

  // (3) The two 409s that refuse a plan change mean different things: no Stripe
  //     customer at all, versus a customer whose subscription has not caught up.
  //     Each is tied to its own message here, because matching the two names
  //     anywhere in the file is satisfied by the import line alone.
  assert.match(checkoutSource, /billing_customer_required: BILLING_CUSTOMER_REQUIRED_MESSAGE,/);
  assert.match(checkoutSource, /billing_subscription_required: BILLING_SUBSCRIPTION_SYNCING_MESSAGE,/);

  // (3) The caller confirms a scheduled downgrade with an alert and returns
  //     BEFORE the portal-open path, so no browser hand-off happens.
  const scheduledIdx = appSource.indexOf("'scheduled' in result");
  const portalOpenIdx = appSource.indexOf('Linking.openURL(portal.url)');
  assert.ok(scheduledIdx >= 0, 'App must handle the scheduled downgrade result');
  assert.ok(portalOpenIdx > scheduledIdx, 'scheduled downgrade must be handled before the browser open path');
  assert.match(appSource, /Alert\.alert\('Plan change scheduled', result\.scheduled\.message\)/);
});

test('the promo price is only quoted to a reader who is certain to be charged it', () => {
  // The Stripe coupon is attached once per subscription, so a subscriber whose
  // two months are spent is charged the standard price on a tier change. The
  // card quoted every reader the half price, which meant the app promised less
  // than the payment screen took. Nobody without a subscription can be in that
  // position, which is the one case the discount is quoted in.
  // And status alone cannot answer it: a customer who subscribed, cancelled and
  // lapsed reads as 'inactive', exactly like a first-timer, so the card offered a
  // returning customer half price and Stripe charged him in full. The billing
  // period end has to reach the card for it to tell the two apart.
  assert.match(appSource, /shouldQuotePromoPrice\(\{/);
  assert.match(appSource, /currentPeriodEnd: cycleEndAtIso \?\? undefined/);
  assert.match(appSource, /\{quotePromo \? \(/, 'the promo price block is rendered on promoLive alone');
  assert.match(appSource, /subscriptionStatus=\{productView\.subscriptionStatus\}/);
  assert.match(appSource, /cycleEndAtIso=\{productView\.nextResetAtIso\}/);
  // A discount lives on the subscription rather than the price, so months still
  // owed do survive a tier change. Saying that is true for every subscriber.
  assert.match(appSource, /promoLive && alreadySubscribed \? \(/);
  assert.match(appSource, /LAUNCH_PROMO_CARRY_OVER_LINE/);
});

test('a reader who has cancelled is not told their promo months carry across', () => {
  // The carry-over line is only true while a subscription exists for the
  // discount to sit on. `!== 'inactive'` counted a cancelled reader as
  // subscribed, so the one screen where they decide whether to come back
  // offered them months they no longer have. The browser gates on entitlement.
  assert.match(appSource, /const alreadySubscribed = isEntitledSubscriptionStatus\(subscriptionStatus\)/);
  assert.doesNotMatch(appSource, /alreadySubscribed = subscriptionStatus !== 'inactive'/);
});

test('a reader with no live plan is not badged as being on one', () => {
  // `?? 'studio'` defaulted the tier lookup, so someone who had never
  // subscribed, and someone who had just cancelled, both read "Studio" beside
  // their name and in the Plan row of Account details.
  const buildProfileSource = appSource.match(/function buildProfile\([\s\S]*?\n}\n/)?.[0];
  assert.ok(buildProfileSource, 'buildProfile source should be available');
  assert.match(
    buildProfileSource,
    /const planTier = isEntitledSubscriptionStatus\(snapshot\.subscription\?\.status\)/,
  );
  assert.match(buildProfileSource, /plan: planTier\?\.name \?\? 'No active plan'/);
  assert.doesNotMatch(buildProfileSource, /tierId \?\? 'studio'/);
});

test('capacity drawer plan details describe the active tier instead of hardcoded plan copy', () => {
  const capacityDrawerMatch = appSource.match(/function CapacityDrawer[\s\S]*?function checkoutErrorTitle/);
  assert.ok(capacityDrawerMatch, 'CapacityDrawer source should be available');
  const capacityDrawerSource = capacityDrawerMatch[0];

  assert.match(
    capacityDrawerSource,
    /ProfileInfoRow label="Best for" value=\{productView\.currentTier\.capacity\}/,
    'Best for must follow the active tier capacity copy for Studio, Pro Office, and Enterprise Suite',
  );
  assert.match(
    capacityDrawerSource,
    /ProfileInfoRow label="Files" value="Stored in your private cloud space"/,
    'Files row describes the private cloud space without a per-tier storage number',
  );
  assert.doesNotMatch(
    capacityDrawerSource,
    /ProfileInfoRow label="Best for" value="Weekly admin and research"/,
    'Capacity drawer must not show the same Pro-ish Best for copy to every plan',
  );
});

test('no surface claims monthly capacity for a reader with no allowance', () => {
  // Reachable from the menu whether or not anyone has ever subscribed, and the
  // tier lookup falls back to the first tier, so it badged a plan-less reader
  // "Studio" and told them they had plenty of room this month. The browser
  // already refused to draw the card at all in that state. The drawer was
  // fixed on its own and the profile card and the menu row were left making
  // the same claim, so the test now sits on the one value all three read.
  assert.match(appSource, /hasCapacityAllowance: boolean;/);
  assert.match(
    appSource,
    /hasCapacityAllowance: hasActiveSubscription && snapshot\.usage\.quotaTokens > 0,/,
  );

  const capacityDrawerMatch = appSource.match(/function CapacityDrawer[\s\S]*?function checkoutErrorTitle/);
  assert.ok(capacityDrawerMatch, 'CapacityDrawer source should be available');
  const capacityDrawerSource = capacityDrawerMatch[0];

  assert.match(capacityDrawerSource, /if \(!productView\.hasCapacityAllowance\) \{/);
  assert.match(capacityDrawerSource, /CAPACITY_NO_ALLOWANCE_TITLE/);
  assert.match(capacityDrawerSource, /CAPACITY_NO_ALLOWANCE_BODY/);
  assert.match(capacityDrawerSource, /CAPACITY_NO_ALLOWANCE_CTA/);

  // The empty state must come before anything that reads the defaulted tier.
  const gateIdx = capacityDrawerSource.indexOf('!productView.hasCapacityAllowance');
  const badgeIdx = capacityDrawerSource.indexOf('productView.currentTier.name');
  assert.ok(gateIdx >= 0 && badgeIdx > gateIdx, 'the plan badge must sit behind the allowance gate');

  // The whole profile card has to sit behind the gate, not just the badge
  // inside it: the sentence naming the plan is what makes the claim.
  const profileStart = appSource.indexOf('function ProfileScreen({');
  const profileSource = appSource.slice(profileStart, appSource.indexOf('\nfunction TabButton(', profileStart));
  // An agent-engine account's allowance card sits behind the same gate, first.
  const profileGateIdx = profileSource.indexOf('{agentEngine && productView.hasCapacityAllowance ? (');
  assert.ok(profileSource.indexOf('<AgentAllowanceCard testID="profile.agentAllowance" />') > profileGateIdx);
  assert.match(profileSource, /\) : productView\.hasCapacityAllowance \? \(\s*<Entry index=\{2\}>\s*<Surface/);
  const profileCardIdx = profileSource.indexOf('testID="profile.capacityCard"');
  assert.ok(profileGateIdx >= 0, 'the profile capacity card no longer sits behind an allowance gate');
  assert.ok(
    profileCardIdx > profileGateIdx,
    'the profile capacity card must sit inside the gate, not above it',
  );

  // The menu row's right-hand label read "Comfortable" for a reader with no
  // plan at all. The row still opens the capacity view, which is where the
  // reader is told there is nothing to measure yet.
  assert.match(
    appSource,
    /testID="menu\.capacityRow"[^\n]*rightLabel=\{productView\.hasCapacityAllowance \? productView\.capacityText : undefined\}/,
  );
});

test('the Upgrade chip in chat opens the plan picker, not the cancel-only portal', () => {
  // The chat tab is the one surface that never renders billingPortalState, so
  // a failed portal open from here changed nothing on screen: the reader
  // pressed Upgrade and the app sat there. It was also pointed at a page that
  // cannot upgrade, which is the defect D3/D6 already removed from the
  // capacity drawer and from Profile.
  const dashboardMount = appSource.match(/<Dashboard\b[\s\S]*?\/>/);
  assert.ok(dashboardMount, 'the Dashboard mount should be available');
  assert.match(dashboardMount[0], /onOpenBillingPortal=\{openSetup\}/);
  assert.doesNotMatch(dashboardMount[0], /handleBillingPortal/);

  // Every surface that still calls the portal directly has to draw the failure.
  for (const [name, needle] of [
    ['ProfileScreen', 'function ProfileScreen({'],
    ['CapacityDrawer', 'function CapacityDrawer({'],
    ['SetupWizardScreen', 'function SetupWizardScreen({'],
  ]) {
    const start = appSource.indexOf(needle);
    assert.ok(start > -1, `${name} source should be available`);
    const body = appSource.slice(start, appSource.indexOf('\nfunction ', start + needle.length));
    assert.match(body, /billingPortalState\.status === 'error'/, `${name} must render a failed portal open`);
  }
});

test('a downgrade refused over storage is not titled as a failed billing page', () => {
  // The reason was flattened away at the setBillingPortalState call, so a
  // policy answer about the space the reader's files take up was rendered
  // under "Couldn't open the billing page" (or "Billing needs attention"),
  // both of which say something broke and point at a retry that can only
  // refuse them again. The browser shows the same message without a failure
  // title, so the phone was also the divergent one.
  assert.match(appSource, /errorReason: MobileBillingPortalErrorReason; errorMessage: string/);
  assert.match(
    appSource,
    /setBillingPortalState\(\{ status: 'error', errorReason: result\.error\.reason, errorMessage: result\.error\.message \}\)/,
  );
  assert.match(appSource, /STORAGE_DOWNGRADE_BLOCK_TITLE/);

  // Both screens that render this state have to branch on the reason, and do
  // it before either failure branch.
  const setup = appSource.match(/function SetupWizardScreen[\s\S]*?function MenuDrawer/)?.[0];
  const capacity = appSource.match(/function CapacityDrawer[\s\S]*?function checkoutErrorTitle/)?.[0];
  const branches = [
    ['setup wizard', setup, 'billingPortalStorageBlocked ? ('],
    ['capacity drawer', capacity, "billingPortalState.errorReason === 'downgrade_storage_over_limit' ? ("],
  ];
  for (const [name, source, branch] of branches) {
    assert.ok(source, `${name} source should be available`);
    const branchIdx = source.indexOf(branch);
    assert.ok(branchIdx >= 0, `${name} must branch on the storage reason, not just carry the title`);
    const titleIdx = source.indexOf('STORAGE_DOWNGRADE_BLOCK_TITLE');
    const attentionIdx = source.indexOf('Billing needs attention');
    assert.ok(titleIdx > branchIdx, `${name} must render the title inside the storage branch`);
    assert.ok(attentionIdx > titleIdx, `${name} must check the storage block first`);
  }

  assert.match(
    appSource,
    /const billingPortalStorageBlocked =\s*\n\s*billingPortalState\.status === 'error' && billingPortalState\.errorReason === 'downgrade_storage_over_limit';/,
  );
});

test('setup wizard billing portal failures do not falsely imply the subscription needs attention', () => {
  const setupWizardMatch = appSource.match(/function SetupWizardScreen[\s\S]*?function MenuDrawer/);
  assert.ok(setupWizardMatch, 'Setup screen source should be available');
  const setupWizardSource = setupWizardMatch[0];
  const billingErrorStart = setupWizardSource.indexOf('{billingPortalError ? (');
  const footerCaptionStart = setupWizardSource.indexOf('<Text variant="caption" color="textSecondary">{checkoutCaption}</Text>', billingErrorStart);
  assert.ok(billingErrorStart >= 0, 'setup wizard should render billing portal errors in the footer');
  assert.ok(footerCaptionStart > billingErrorStart, 'setup wizard billing portal error should appear before the checkout CTA caption');
  const billingErrorBlock = setupWizardSource.slice(billingErrorStart, footerCaptionStart);

  assert.match(
    billingErrorBlock,
    /productView\.subscriptionNeedsAttention \? \(/,
    'setup wizard must gate "Billing needs attention" behind the real subscription attention flag',
  );
  assert.match(billingErrorBlock, /Billing needs attention/);
  assert.match(
    billingErrorBlock,
    /Couldn[’']t open (the )?billing/,
    'transient portal-open failures should use calm retry copy, not billing-alarm copy',
  );
});

test('v1.2.1 setup wizard: plan picker that flips to the chat surface after pay (no workspace-preparing detour)', () => {
  // v1.2.1 removed the workspace-ready gate from the user journey. The
  // user pays and is dropped into the chat surface immediately — the
  // Worker handles model calls itself rather than waiting on a runner.
  assert.doesNotMatch(appSource, /workspaceStatus: 'ready' \| 'preparing' \| 'needs_attention'/);
  assert.doesNotMatch(appSource, /Setting up your cloud computer/);

  assert.match(appSource, /const selectedPlanIsCurrent = productView\.hasActiveSubscription && selectedTier === productView\.currentTierId/);
  assert.match(appSource, /const selectedPlanNeedsChange = productView\.hasActiveSubscription && !selectedPlanIsCurrent/);
  // Footer caption order: change → ready-to-chat → pay.
  // [#11] "Change plan" caption was redundant against the
  // "Change to <plan>" button; it now says what the change costs.
  assert.match(appSource, /selectedPlanNeedsChange[\s\S]*planChangeCaption[\s\S]*selectedPlanIsCurrent[\s\S]*'Ready to chat'[\s\S]*'Pay securely'/);
  assert.match(appSource, /const \[selectedTierManuallyChanged, setSelectedTierManuallyChanged\] = useState\(false\)/);
  // New customers start with Studio; existing subscribers keep their current tier.
  assert.match(appSource, /if \(!selectedTierManuallyChanged\) \{[\s\S]*setSelectedTier\(productView\.hasActiveSubscription \? productView\.currentTierId : 'studio'\);[\s\S]*\}/);
  assert.match(appSource, /const chooseTier = useCallback\(\(tier: TierId\) => \{[\s\S]*setSelectedTierManuallyChanged\(true\);[\s\S]*setSelectedTier\(tier\);[\s\S]*\}, \[\]\);/);
  // After-pay user lands on Home (chat), not on a messenger detour.
  //
  // D3/D5/D6 fix (2026-05-20): the picker is no longer 3-branch
  // (current → home, needs-change → billing portal, else → checkout).
  // The portal is cancel-only in our config; tier changes now route
  // through a fresh Stripe Checkout for the target tier, which Stripe
  // recognises as a plan-change session when the customer already has
  // an active subscription. Lock that behaviour in: current → home,
  // otherwise → checkout, with NO selectedPlanNeedsChange branch.
  assert.match(
    appSource,
    /onPress=\{\(\) => \{[\s\S]*?if \(selectedPlanIsCurrent\) \{[\s\S]*?onContinueToHome\(\);[\s\S]*?\} else \{[\s\S]*?onOpenCheckout\(selectedTier\);[\s\S]*?\}[\s\S]*?\}\}/,
    'plan-picker onPress must branch current → home, otherwise → fresh Stripe Checkout for the selected tier',
  );
  // Regression guard against the old 3-branch ternary that routed
  // tier-changes to the (cancel-only) billing portal. Alex hit that on
  // 2026-05-20 and got punted home without an upgrade.
  assert.doesNotMatch(
    appSource,
    /selectedPlanIsCurrent \? onContinueToHome\(\) : selectedPlanNeedsChange \? onOpenBillingPortal\(selectedTier\) : onOpenCheckout\(selectedTier\)/,
    'plan-picker must not route tier-changes through the billing portal (cancel-only in our config)',
  );
  assert.match(appSource, /handleBillingPortal = useCallback\(async \(targetTierId: TierId \| null = null\)/);
  // This file is the ANDROID readiness pack, and Android still pays through
  // Stripe. The assertion was `await openStripeBillingPortal(targetTierId)`
  // until 2026-08-19, when handleBillingPortal gained the iOS StoreKit branch
  // in front of it and started returning the call rather than awaiting it.
  // What matters here is unchanged: the non-iOS path still reaches the Stripe
  // portal with the requested tier. Matching on the call, not on `await`,
  // keeps that true without re-pinning a keyword that carries no meaning for
  // this test.
  assert.match(appSource, /openStripeBillingPortal\(targetTierId\)/);
  // The iOS gate must not have become an unconditional removal: Android has no
  // StoreKit, so if this branch ever stops being conditional, Android loses
  // its only way to manage a subscription.
  assert.match(
    appSource,
    /if \(usesStoreKit\(\)\) \{[\s\S]*?manageAppleSubscription\(\)/,
    'the Stripe portal must be gated by usesStoreKit(), not removed outright',
  );
});

test('Stripe return deep links are handled as app navigation, not auth callbacks', () => {
  assert.match(appSource, /checkoutReturnKindFromUrl/);
  assert.match(appSource, /sidekick:/);
  assert.match(appSource, /parsed\.hostname === 'checkout' && parsed\.pathname === '\/success'/);
  assert.match(appSource, /parsed\.hostname === 'checkout' && parsed\.pathname === '\/cancel'/);
  assert.match(appSource, /parsed\.hostname === 'billing' && parsed\.pathname === '\/return'/);
  assert.match(appSource, /checkoutReturnSignal/);
  assert.match(appSource, /handledCheckoutReturnKey/);
  assert.match(appSource, /onContinueToHome=\{\(\) => openTab\('dashboard'\)\}/);
});

test('setup checkout CTA has Stripe-specific visible and accessible labels for new subscriptions and plan changes', () => {
  const setupWizardMatch = appSource.match(/function SetupWizardScreen[\s\S]*?function MenuDrawer/);
  assert.ok(setupWizardMatch, 'Setup screen source should be available');
  const setupWizardSource = setupWizardMatch[0];

  // The busy wording is now shared between the new-subscription and the
  // plan-change branches via checkoutBusyLabel, and it is PLATFORM DEPENDENT.
  // This used to pin the literal nesting of checkoutLabel, which broke the
  // moment the two branches stopped repeating themselves. Pin the behaviour:
  // Stripe still says "secure checkout", StoreKit never does.
  assert.match(
    setupWizardSource,
    /const checkoutBusyLabel = checkoutState\.status === 'opening'[\s\S]{0,220}?purchasesThroughStoreKit \? 'Contacting the App Store…' : 'Opening secure checkout…'[\s\S]{0,80}?'Confirming subscription…'/,
    'busy label must show App Store progress on StoreKit and Stripe Checkout progress elsewhere',
  );
  assert.match(
    setupWizardSource,
    /const checkoutLabel = selectedPlanNeedsChange[\s\S]*checkoutBusyLabel[\s\S]*`Change to \$\{selectedPlan\.name\}`[\s\S]*selectedPlanIsCurrent/,
    'plan-change visible label must show checkout progress, not billing-portal progress',
  );
  assert.match(
    setupWizardSource,
    /purchasesThroughStoreKit\s*\?\s*`Subscribe to \$\{selectedPlan\.name\}`\s*:\s*'Open secure checkout'/,
    'the buy button must say Subscribe on StoreKit and only say "secure checkout" on Stripe',
  );
  assert.doesNotMatch(
    setupWizardSource.match(/const checkoutLabel[\s\S]*?const checkoutCaption/)?.[0] ?? '',
    /Opening billing…/,
    'plan-change checkout visible label must not reuse billing-portal wording',
  );
  // The label names the payment route, and since 2026-08-19 that route is
  // platform-dependent: `purchaseNoun` is "Stripe Checkout" on Android and web,
  // and "the App Store purchase" on an iOS StoreKit build. It used to hardcode
  // Stripe, which meant a VoiceOver user on iOS heard "Open secure Stripe
  // Checkout" while Apple took the payment. That is both untrue and a
  // Guideline 3.1.1 problem, so the assertion now pins the SHAPE and pins the
  // Android/web wording via purchaseNoun below.
  assert.match(
    setupWizardSource,
    /const checkoutAccessibilityLabel = selectedPlanNeedsChange[\s\S]*Open \$\{purchaseNoun\} to change to \$\{selectedPlan\.name\}\. \$\{planChangeCaption\}\.[\s\S]*selectedPlanIsCurrent[\s\S]*Continue to chat with \$\{productView\.agentName\}[\s\S]*Open \$\{purchaseNoun\} for \$\{selectedPlan\.name\}/,
    'checkout CTA accessible label must name the payment route, what the plan change costs, and the current-plan continue action',
  );
  assert.match(
    setupWizardSource,
    /const purchaseNoun = storeKitPurchase \? 'the App Store purchase' : 'Stripe Checkout';/,
    'Android and web must still say Stripe Checkout; only an iOS StoreKit build says App Store',
  );
  assert.match(
    setupWizardSource,
    /testID="billing\.checkoutButton"[\s\S]*accessibilityLabel=\{checkoutAccessibilityLabel\}/,
    'checkout CTA must pass the explicit accessible label to the Button host',
  );
  assert.doesNotMatch(
    setupWizardSource.match(/const checkoutAccessibilityLabel[\s\S]*?;/)?.[0] ?? '',
    /billing portal/i,
    'plan-change checkout accessible label must not mention the cancel-only billing portal',
  );
});

test('Stripe server checkout and webhook contracts still own entitlement and provisioning updates', () => {
  assert.match(stripeServerSource, /handleStripeCheckoutRequest/);
  assert.match(stripeServerSource, /handleStripeWebhookRequest/);
  assert.match(stripeServerSource, /externalCheckoutUrlResponse\(request, sessionUrl\)/);
  assert.match(stripeServerSource, /acceptsJson\(request\)/);
  assert.match(stripeTestSource, /checkout route returns a JSON Stripe URL for mobile clients that ask for JSON/);
  assert.match(stripeServerSource, /enqueueHermesProvisioning/);
  assert.match(stripeServerSource, /upsertUsageQuota/);
  assert.match(stripeTestSource, /webhook route verifies the raw Stripe body/);
  assert.match(stripeTestSource, /provisioningJobs/);
});

test('checkout errors are rendered in the sticky setup footer where the tap response is visible', () => {
  const setupWizardMatch = appSource.match(/function SetupWizardScreen[\s\S]*?function MenuDrawer/);
  assert.ok(setupWizardMatch, 'Setup screen source should be available');
  const setupWizardSource = setupWizardMatch[0];
  // Anchored on the footer's own style, not its look: the 2026-09-27 redesign
  // changed the footer Surface's elevation and radius and this must not care.
  const footerStart = setupWizardSource.indexOf('style={[styles.setupFooter');
  assert.ok(footerStart >= 0, 'setup screen should have a sticky footer');
  const footerSource = setupWizardSource.slice(footerStart);
  const errorStart = footerSource.indexOf('checkoutError ? (');
  const checkoutCaptionStart = footerSource.indexOf('{checkoutCaption}');
  assert.ok(errorStart >= 0, 'checkout error should be rendered inside the visible sticky footer');
  assert.ok(checkoutCaptionStart > errorStart, 'checkout error should appear before the checkout CTA caption');
  assert.match(footerSource, /checkoutErrorTitle\(checkoutError\.reason\)/);
  assert.match(footerSource, /checkoutError\.message/);
});

// PREOP-C05 regression: the operator saw a bare "502" on the Pro upgrade.
// That number was the diagnostic suffix the mobile client appended to the
// user-facing billing error. No raw HTTP status / server code may reach the
// end user on the payment/upgrade path (it is still logged for diagnosis).
test('PREOP-C05: billing/upgrade errors never surface a raw HTTP status or server code to the user', () => {
  assert.doesNotMatch(checkoutSource, /\$\{body\} \(\$\{parts\.join/, 'no status/server suffix may be built into the user-facing message');
  assert.doesNotMatch(checkoutSource, /parts\.push\(`status=\$\{diagnostic\.status\}`\)/, 'must not push a raw status= into the user-facing copy');
  assert.match(checkoutSource, /void diagnostic;/, 'diagnostic is intentionally not rendered to the user');
  // The status is still captured for ops (logcat/Sentry) at the call site.
  assert.match(checkoutSource, /console\.error\(`\[delegent-billing\] portal unavailable status=/);
});

// The picker said "Stripe pro-rates the difference" under the change-plan
// button for any change at all. A downgrade is booked for the end of the period
// already paid for, with proration_behavior 'none' set on purpose in
// packages/billing, so no credit is ever issued. The reader was told to expect
// money back that was never coming, on the one screen where that matters most.
test('the change-plan caption tells the truth in both directions', () => {
  // planChangeNote is now the NON-StoreKit branch. On an iOS StoreKit build the
  // caption is "Managed by Apple" instead, because Apple takes the money and
  // decides the proration, so "Stripe pro-rates the difference" would be a
  // promise about a company that is not involved in that transaction. Android
  // and web, which this pack covers, still read the shared constant.
  assert.match(appSource, /const planChangeCaption = storeKitPurchase\s*\?\s*'Managed by Apple'\s*:\s*planChangeNote\(selectedPlanIsDowngrade\)/);
  assert.match(appSource, /selectedPlanIsDowngrade = selectedPlanNeedsChange && isPlanDowngrade\(productView\.currentTierId, selectedTier\)/);
  // No inlined copy left behind: the phone and the browser read one constant.
  assert.doesNotMatch(appSource, /'Stripe pro-rates the difference'/);
  assert.doesNotMatch(appSource, /Stripe pro-rates the difference\./);
});

// Stripe sends the same currentPeriodEnd whether the subscription renews on
// that date or stops on it. Both surfaces read it as a reset, so a reader who
// had just cancelled was told their allowance came back on the day their plan
// actually ends, on the screen they open precisely because they are watching it.
test('a cancelled plan is not described as resetting', () => {
  assert.match(appSource, /cancelAtPeriodEnd: snapshot\.subscription\?\.cancelAtPeriodEnd \?\? false/);
  assert.match(appSource, /formatCycleEndLine\(productView\.nextResetAtIso, productView\.cancelAtPeriodEnd\)/);
  // And the upgrade nudge underneath is not offered to someone on the way out
  // (nor to an agent-engine account, which has no other plan to move to).
  assert.match(appSource, /productView\.cancelAtPeriodEnd \|\| agentEngine \? null : \(/);
  // The pause card wrapped a whole sentence in another sentence, which read
  // "Your capacity resets on Your monthly time resets on Saturday, 17 May..".
  assert.doesNotMatch(appSource, /Your capacity resets on \$\{/);
});

test('mobile test suite includes checkout readiness regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /checkout-readiness\.test\.mjs/);
  assert.match(scripts.test, /onboarding-readiness\.test\.mjs/);
});

/**
 * Strip comments before pattern-matching source.
 *
 * PR #427 shipped a guard that passed because the string it hunted for lived
 * inside a prose comment rather than in code. The blocks below deliberately
 * document themselves using the very identifiers they assert on, so matching
 * raw source here would pass even if the fix were deleted.
 *
 * String literals are stepped over intact: they are exactly what we are
 * hunting for.
 */
function stripCheckoutComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * REGRESSION: a successful Apple purchase must never dead-end on "Confirming
 * subscription…".
 *
 * The bug: the StoreKit branch of handlePlanCheckout set checkoutState to
 * 'confirming', awaited the post-purchase poller (12 attempts x 1800ms, so
 * about 21 seconds), and then simply `return`ed. If the entitlement read had
 * not caught up, or if the refresh threw and hit the bare `catch`, the state
 * stayed 'confirming' forever: the button read "Confirming subscription…",
 * stayed disabled, and offered no error, no retry and no way forward. Apple
 * had the money and the app looked broken.
 *
 * The Stripe path never had this hole, which is what made it findable: the two
 * providers disagreed about what to do when a real payment outruns the
 * snapshot.
 */
test('[apple-2.1b] a purchased StoreKit result never leaves checkout stuck on confirming', () => {
  const code = stripCheckoutComments(appSource);

  const branchStart = code.indexOf("if ('purchased' in storeKitResult)");
  assert.ok(branchStart > 0, "the StoreKit 'purchased' branch should still exist in App.tsx");

  // Walk the branch to its matching brace so the assertions cannot drift into
  // neighbouring code and pass on somebody else's error handling.
  const open = code.indexOf('{', branchStart);
  let depth = 0;
  let end = open;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const branch = code.slice(branchStart, end + 1);

  assert.match(branch, /setCheckoutState\(\{\s*status:\s*'confirming'/,
    'the branch should still show a confirming state while it polls');
  assert.match(branch, /status:\s*'error'/,
    'a purchase whose confirmation runs out MUST reach a terminal error state, not a bare return');
  assert.match(branch, /errorReason:\s*'purchase_confirming'/,
    "it must use the dedicated reason, not 'unavailable' (which renders as 'Checkout is temporarily offline')");
  assert.match(branch, /setCheckoutRefreshPending\(false\)/,
    'the pending flag must be cleared or the spinner outlives the error state');
});

test('[apple-2.1b] the purchase_confirming reason never tells a charged customer their payment failed', () => {
  const appCode = stripCheckoutComments(appSource);
  const checkoutCode = stripCheckoutComments(checkoutSource);

  // Present in the union, so both exhaustive Record<> maps are forced to cover it.
  assert.match(checkoutCode, /'purchase_confirming'/,
    'purchase_confirming should be a member of MobileCheckoutErrorReason');
  assert.match(checkoutCode, /purchase_confirming:/,
    'the message map in mobileCheckout.ts should cover purchase_confirming');
  assert.match(appCode, /purchase_confirming:\s*'Your payment went through'/,
    'the title must reassure, because Apple has already charged them');

  // The failure mode this guards: wording that pushes a paid customer to buy again.
  const messages = [...appCode.matchAll(/purchase_confirming:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(messages.length > 0, 'expected at least one purchase_confirming string in App.tsx');
  for (const message of messages) {
    assert.doesNotMatch(message, /fail|declin|error|problem|went wrong|offline|unavailable/i,
      `purchase_confirming copy must not imply failure, got: ${message}`);
  }
});

/**
 * REGRESSION: a placeholder StoreKit transaction id must never reach the Worker.
 *
 * Three of the first six real Apple purchase attempts died on an all-zeros
 * transactionId (apple_iap_events, 2026-08-20). StoreKit emits an interim
 * purchase event while the transaction is still settling, the app settled on
 * it, and the Worker was asked about an id Apple has never heard of. Outcome
 * apple_api_error, applied=false, and a customer who had genuinely paid left
 * looking at "Confirming subscription...".
 *
 * The predicate itself is tested exhaustively in
 * packages/shared/test/apple-transaction-id.test.mjs. What THIS pins is that
 * the mobile side actually calls it, at every point an id is trusted.
 */
test('[apple-2.1b] every place a StoreKit transaction id is trusted guards the placeholder', () => {
  const appleIapSource = readFileSync(
    new URL('../../../../../src/billing/appleIap.ts', import.meta.url), 'utf8',
  );
  const code = stripCheckoutComments(appleIapSource);

  assert.match(code, /isUsableAppleTransactionId/,
    'appleIap.ts should use the shared guard');
  assert.match(code, /import\s*\{[^}]*isUsableAppleTransactionId[^}]*\}\s*from\s*'@sidekick\/shared'/s,
    'the guard must come from shared, not be re-implemented locally where it cannot be tested');

  // 1. The purchase listener keeps waiting rather than settling on a placeholder.
  assert.match(code, /purchaseUpdatedListener\([\s\S]{0,900}?isUsableAppleTransactionId/,
    'the purchaseUpdatedListener must skip an event carrying a placeholder id');

  // 2. The last gate before the Worker is asked.
  assert.match(code, /if\s*\(!isUsableAppleTransactionId\(transactionId\)\)\s*return failure\('purchase_failed'\)/,
    'a placeholder must be refused before verifyApplePurchaseWithWorker is called');

  // 3. Restore walks whatever StoreKit hands back and must skip, not abort.
  assert.match(code, /if\s*\(!isUsableAppleTransactionId\(transactionId\)\)\s*continue/,
    'restore must skip a placeholder entry rather than burn the restore on it');

  // The old unguarded shape must be gone from all three sites.
  assert.doesNotMatch(code, /if\s*\(!transactionId\)\s*return failure/,
    'the bare falsy check accepted "000000000000000", which is truthy');
  assert.doesNotMatch(code, /if\s*\(!transactionId\)\s*continue/,
    'the bare falsy check accepted "000000000000000", which is truthy');
});

/**
 * REGRESSION: the buy button must never hang silently.
 *
 * THE DEFECT, reproduced on Alex's phone 2026-08-27 and confirmed against
 * Apple's own API (originalTransactionId 2000001224293610, status 1 ACTIVE,
 * product com.sidekick.v2.studio.monthly):
 *
 * StoreKit will not present a purchase sheet for a subscription the signed-in
 * Apple ID already holds. It does not error either. It emits NOTHING. So
 * requestPurchaseAndAwaitOutcome waited on a listener that could never fire,
 * and the only timeout on that path was FIVE MINUTES. The button sat on
 * "Opening secure checkout..." with no sheet, no error and no way forward.
 *
 * Worse, loadStoreKit memoises its promise, so a single hung or failed load
 * poisoned every later tap for the rest of the app session.
 */
test('[apple-2.1b] every StoreKit call is bounded and a failed load is not cached', () => {
  const appleIapSource = readFileSync(
    new URL('../../../../../src/billing/appleIap.ts', import.meta.url), 'utf8',
  );
  const code = stripCheckoutComments(appleIapSource);

  assert.match(code, /const STOREKIT_CALL_TIMEOUT_MS = [0-9_]+/,
    'StoreKit calls need an explicit timeout budget');
  assert.match(code, /function withStoreKitTimeout/,
    'there should be one helper, so a new call site cannot quietly go unbounded');

  // The three calls that could hang before a sheet ever appears.
  //
  // Whitespace is normalised rather than matched, because these calls are
  // wrapped across several lines and a regex encoding their exact indentation
  // would break on a reformat while the guard still held.
  const flat = code.replace(/\s+/g, ' ');
  for (const call of ['loaded.initConnection(', 'storeKit.fetchProducts(', 'storeKit.getAvailablePurchases(']) {
    assert.ok(
      flat.includes(`withStoreKitTimeout( ${call}`) || flat.includes(`withStoreKitTimeout(${call}`),
      `${call} must be wrapped in withStoreKitTimeout, or it can hang the buy button forever`,
    );
  }

  // A failed load must not poison every later attempt.
  assert.match(code, /if \(resolved === null\) storeKitPromise = null;/,
    'a null (failed) load must clear the memoised promise so the next tap retries');
});

test('[apple-2.1b] an Apple ID that already owns the product gets an answer, not a spinner', () => {
  const appleIapSource = readFileSync(
    new URL('../../../../../src/billing/appleIap.ts', import.meta.url), 'utf8',
  );
  const code = stripCheckoutComments(appleIapSource);

  // The ownership probe must run BEFORE the purchase request, or it cannot
  // prevent the hang it exists to prevent.
  const probe = code.indexOf('getAvailablePurchases({ onlyIncludeActiveItemsIOS: true })');
  const request = code.indexOf('requestPurchaseAndAwaitOutcome(storeKit, sku, intent.intentId)');
  assert.ok(probe > 0, 'purchaseTierWithStoreKit should ask what this Apple ID already owns');
  assert.ok(request > 0, 'the purchase request should still exist');
  assert.ok(probe < request,
    'the ownership check must come BEFORE requestPurchase, otherwise StoreKit has already gone silent');

  assert.match(code, /'owned_by_another_account'/,
    'there must be a distinct reason for "this Apple ID bought it on another account"');
  assert.match(
    code,
    /payload\?\.error === 'already_claimed_by_another_account'\) return failure\('owned_by_another_account'\)/,
    "the Worker's already_claimed_by_another_account must map to its own reason, not verification_failed",
  );
});

test('[apple-2.1b] copy for a permanent state never tells the user to wait or retry', () => {
  const appleIapSource = readFileSync(
    new URL('../../../../../src/billing/appleIap.ts', import.meta.url), 'utf8',
  );
  const code = stripCheckoutComments(appleIapSource);

  const owned = code.match(/owned_by_another_account:\s*'([^']*)'/);
  assert.ok(owned, 'owned_by_another_account needs failure copy');
  // Nothing changes if they wait, so promising that it might is a support ticket.
  assert.doesNotMatch(owned[1], /try again|in a moment|shortly|usually appears/i,
    `permanent-state copy must not invite a retry, got: ${owned[1]}`);

  // And the app-level title must not dress it up as an outage.
  const appCode = stripCheckoutComments(appSource);
  assert.match(appCode, /owned_by_another_account: 'Already used on another account'/,
    'the title must say what is actually true');
});

/**
 * REGRESSION: an iOS StoreKit build must never advertise a web checkout.
 *
 * "Secure checkout" is Stripe language. On a build where Apple takes the
 * payment it tells the user they are about to be sent to an external payment
 * page, which is the impression that got build 37 rejected under Guideline
 * 3.1.1, and it is not even true: nothing opens, Apple presents a sheet.
 *
 * The accessibility label and the plan-change caption were made
 * platform-dependent on 2026-08-19. THE VISIBLE BUTTON WAS MISSED, so the one
 * string a reviewer actually reads still said "Open secure checkout" while
 * StoreKit did the work. Found 2026-08-27 on Alex's phone.
 */
test('[apple-3.1.1] no user-visible string promises a web checkout on a StoreKit build', () => {
  const code = stripCheckoutComments(appSource);

  // 1. The LABEL block, which is what a reviewer reads. Both Stripe literals
  //    here must sit on the non-StoreKit side of the platform ternary.
  const labelBlock = code.match(/const purchasesThroughStoreKit[\s\S]*?const planChangeCaption/)?.[0];
  assert.ok(labelBlock, 'the checkout label block should still be findable');
  for (const m of labelBlock.matchAll(/'([^']*secure checkout[^']*)'/gi)) {
    const at = labelBlock.indexOf(`'${m[1]}'`);
    assert.match(
      labelBlock.slice(Math.max(0, at - 200), at), /purchasesThroughStoreKit\s*\?/,
      `"${m[1]}" is not on the Stripe side of a StoreKit ternary, so it can reach an iOS build`,
    );
  }

  // 2. The StoreKit BRANCH of handlePlanCheckout must not mention a checkout at
  //    all. Strings after it are unreachable on iOS because that branch always
  //    returns, which is why a blanket source sweep would false-positive here.
  const branchStart = code.indexOf("if (usesStoreKit()) {");
  assert.ok(branchStart > 0, 'handlePlanCheckout should still branch on usesStoreKit');
  const open = code.indexOf('{', branchStart);
  let depth = 0;
  let end = open;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const storeKitBranch = code.slice(branchStart, end + 1);
  assert.doesNotMatch(storeKitBranch, /secure checkout/i,
    'the StoreKit purchase branch must never mention a checkout');
  assert.match(storeKitBranch, /return;/,
    'the StoreKit branch must return, or the Stripe path below becomes reachable on iOS');

  // And the StoreKit side must name Apple rather than a checkout.
  assert.match(code, /'Contacting the App Store…'/,
    'the StoreKit busy state should name the App Store');
  assert.match(code, /`Subscribe to \$\{selectedPlan\.name\}`/,
    'the StoreKit buy button should say Subscribe');
});

/**
 * REGRESSION: no full-screen surface may run edge to edge on an iPad.
 *
 * Every layout in App.tsx was written for a phone, where a full-width column
 * is correct. On an iPad the same styles run to roughly 1024pt. The plan
 * picker is the one that matters most: it is the screen App Review lands on,
 * and plan cards stretched across 1024pt read as "not designed for iPad"
 * under Guideline 4.0.
 *
 * The menu drawer was the worst of them at `width: '92%'`, which is 942pt of
 * a 1024pt screen, leaving a sliver of backdrop to dismiss it with.
 *
 * NO PHONE IS AFFECTED. The widest iPhone is 430pt, so neither cap ever
 * binds, which is what makes this safe on the same binary as the phone build.
 */
test('[ipad] scroll surfaces and the drawer are capped on large screens', () => {
  const code = stripCheckoutComments(appSource);

  assert.match(code, /const WIDE_CONTENT_MAX_WIDTH = (\d+);/,
    'the content cap should be a named constant, not repeated magic numbers');
  assert.match(code, /const DRAWER_MAX_WIDTH = (\d+);/,
    'the drawer cap should be a named constant');

  const contentCap = Number(/const WIDE_CONTENT_MAX_WIDTH = (\d+);/.exec(code)[1]);
  const drawerCap = Number(/const DRAWER_MAX_WIDTH = (\d+);/.exec(code)[1]);

  // 430pt is the widest iPhone. If a cap ever drops below it, the phone
  // layout silently changes, which is the failure mode to prevent.
  assert.ok(contentCap > 430, `content cap ${contentCap} would bind on an iPhone`);
  assert.ok(drawerCap > 430 * 0.92, `drawer cap ${drawerCap} would bind on an iPhone at width 92%`);

  // Plain indexOf slicing, NOT a RegExp built from a template literal. Twice
  // now, `[\s\S]` inside a template has degraded to `[sS]` and the assertion
  // failed on the extraction rather than on the thing being asserted, which
  // makes a test bug look like a source bug.
  const styleBody = (name, span) => {
    const at = code.indexOf(`${name}: {`);
    return at < 0 ? null : code.slice(at, at + span);
  };

  // The surfaces a reviewer actually sees.
  for (const style of ['setupScrollContent', 'scrollContent', 'filesScrollContent', 'setupFooter']) {
    const body = styleBody(style, 400);
    assert.ok(body, `${style} should exist`);
    assert.ok(
      body.includes('WIDE_CONTENT_MAX_WIDTH'),
      `${style} has no width cap, so it stretches the full iPad width`,
    );
  }

  const drawer = styleBody('drawerSheetWrapper', 300);
  assert.ok(drawer, 'drawerSheetWrapper should exist');
  assert.ok(drawer.includes('DRAWER_MAX_WIDTH'),
    'the drawer is width 92%, which is 942pt on an iPad without a cap');
});
