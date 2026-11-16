import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../apps/mobile/App.tsx', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../../../apps/mobile/src/auth/useMobileAuth.ts', import.meta.url), 'utf8');
const mobilePackage = JSON.parse(readFileSync(new URL('../../../apps/mobile/package.json', import.meta.url), 'utf8'));

function sourceBlock(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} should exist`);
  const rest = source.slice(start);
  const nextFunction = rest.slice(declaration.length).search(/\nfunction [A-Z_a-z0-9]+\(/);
  return nextFunction === -1 ? rest : rest.slice(0, declaration.length + nextFunction);
}

test('mobile installed-app auth + OTP code entry + first-run flow stays wired end-to-end', () => {
  const loginSource = sourceBlock(appSource, 'function LoginScreen');
  assert.match(loginSource, /Continue with email/);
  // v1.2.8 — magic-link CTA renamed to "Email me a sign-in code"
  // because the magic-link path dead-ended at about:blank under
  // Gmail's WebView. Users now type the code into login.emailOtpInput.
  assert.match(loginSource, /Email me a sign-in code/);
  assert.match(loginSource, /testID="login\.emailInput"/);
  assert.match(loginSource, /testID="login\.emailSubmit"/);
  assert.match(loginSource, /testID="login\.emailOtpInput"/);
  assert.match(loginSource, /testID="login\.emailOtpVerify"/);
  assert.match(loginSource, /onSendEmailOtp/);
  assert.match(loginSource, /onVerifyEmailOtp/);
  // Magic-link deep-link callback path is still wired as a fallback
  // for users who DO manage to launch sidekick:// from their email
  // app, e.g. if they switch to a different mail client.
  assert.match(authSource, /isSupabaseAuthVerifyUrl/);
  assert.match(authSource, /params\.get\('token_hash'\) \|\| params\.get\('token'\)/);
  assert.match(authSource, /normalizeSupabaseEmailVerifyType\(params\.get\('type'\)\)/);
  assert.match(authSource, /verifyOtp\(\{ token_hash: tokenHash, type: verifyType \}\)/);
  assert.match(authSource, /type SupabaseEmailVerifyType = 'signup' \| 'magiclink'/);

  const termsSource = sourceBlock(appSource, 'function TermsModal');
  // The close-icon's accessibility label was clarified from "Close Terms"
  // (ambiguous with the visible Close Terms button below) to
  // "Close Terms icon" so screen readers announce the X glyph as the icon,
  // not duplicate the button text. The substantive contract — there is a
  // close affordance with a generous touch target — still holds.
  assert.match(termsSource, /accessibilityLabel="Close Terms icon"[\s\S]*?hitSlop=\{touchHitSlop\}/);
  // And there is still a labelled close BUTTON below the scroll region.
  assert.match(termsSource, /testID="terms\.closeButton"[\s\S]*?>Close Terms</);
  const closeStyle = appSource.match(/sheetCloseButton: \{[\s\S]*?\n  \},/)?.[0] ?? '';
  assert.match(closeStyle, /width: 44/);
  assert.match(closeStyle, /height: 44/);
  assert.match(closeStyle, /zIndex: 5/);

  const goalSource = sourceBlock(appSource, 'function OnboardingScreen');
  assert.match(goalSource, /<GoalOnboarding/);
  assert.match(goalSource, /<NameOnboardingScreen/);
  const onboardingSource = sourceBlock(appSource, 'function NameOnboardingScreen');
  assert.match(onboardingSource, /Name your personal Agent/);
  assert.match(onboardingSource, /const \[agentName, setAgentName\] = useState\(''\)/);
  assert.match(onboardingSource, /placeholder="Nova"/);
  assert.doesNotMatch(onboardingSource, /useState\(defaultAgentName\(\)\)|You can start with Ruben/);
  assert.match(appSource, /setOnboardingCompletedUserId\(authState\.user\.id\)/);
  assert.match(appSource, /setSetupGuideLaunchKey\(\(key\) => key \+ 1\)/);
  assert.match(appSource, /setupGuideLaunchKey=\{setupGuideLaunchKey\}/);
  assert.match(appSource, /setSetupOpen\(true\)/);
  assert.match(appSource, /setDrawerOpen\(true\)/);
});

test('mobile setup guide takes users from plan selection to hosted Stripe checkout (v1.2.1 single-step)', () => {
  const setupSource = sourceBlock(appSource, 'function SetupWizardScreen');
  // v1.2.1 chat-first pivot — setup is plan selection only. The
  // messenger step + "Connect Telegram" detour are retired.
  assert.match(setupSource, /GOAL_HEADLINES\[onboardingGoal\]/);
  assert.match(setupSource, /<TierSegment selectedTier=\{selectedTier\} onChange=\{chooseTier\} \/>/);
  assert.match(setupSource, /const \[selectedTierManuallyChanged, setSelectedTierManuallyChanged\] = useState\(false\)/);
  assert.match(setupSource, /if \(!selectedTierManuallyChanged\) \{[\s\S]*setSelectedTier\(productView\.hasActiveSubscription \? productView\.currentTierId : 'studio'\);[\s\S]*\}/);
  // The card shows the tier the segment has selected, not the one the user is
  // already on. Matched prop by prop rather than as one literal line, because
  // pinning the exact single-line JSX went stale the moment PlanCard took a
  // third prop and Prettier wrapped the call, which left this suite red. It was
  // then a 200-character budget, which went stale for exactly the same reason on
  // the fourth prop, so read to the closing bracket instead of guessing a size.
  const PLAN_CARD_CALL = /<PlanCard\b[^>]*\/>/;
  assert.match(setupSource, PLAN_CARD_CALL);
  const planCardCall = setupSource.match(PLAN_CARD_CALL)[0];
  assert.match(planCardCall, /tier=\{selectedPlan\}/);
  assert.match(planCardCall, /isCurrent=\{selectedPlanIsCurrent\}/);
  assert.match(planCardCall, /subscriptionStatus=\{productView\.subscriptionStatus\}/);
  // The lapsed-customer signal has to reach the card, or it quotes a returning
  // customer a promo price Stripe will not honour. See shouldQuotePromoPrice.
  assert.match(planCardCall, /cycleEndAtIso=\{productView\.nextResetAtIso\}/);
  // Contextual CTAs that survived: secure checkout, change plan.
  // "Connect Telegram" / "Continue to Telegram" are retired.
  assert.match(setupSource, /Open secure checkout/);
  assert.match(setupSource, /Change to \$\{selectedPlan\.name\}/);
  assert.match(setupSource, /onOpenCheckout\(selectedTier\)/);
  assert.match(appSource, /handlePlanCheckout/);
  assert.match(appSource, /requestStripeCheckout\(\{ tierId \}\)/);
  assert.match(appSource, /plan_change_required/);
  assert.match(appSource, /checkout_refused/);
  assert.match(appSource, /Linking\.openURL\(checkout\.url\)/);
  assert.match(appSource, /checkoutRefreshPending/);
  assert.match(appSource, /onCheckoutReturnRefresh/);
  assert.match(appSource, /refreshUntilCheckoutSubscriptionActive/);
  assert.match(appSource, /checkoutSnapshotHasActiveSubscription/);
  assert.match(appSource, /advanceAfterSubscription/);
  assert.match(appSource, /checkoutReturnKindFromUrl/);
  assert.match(mobilePackage.scripts.test, /auth-readiness\.test\.mjs/);
  assert.match(mobilePackage.scripts.test, /legal-terms-readiness\.test\.mjs/);
  assert.match(mobilePackage.scripts.test, /onboarding-readiness\.test\.mjs/);
  assert.match(mobilePackage.scripts.test, /checkout-readiness\.test\.mjs/);
});
