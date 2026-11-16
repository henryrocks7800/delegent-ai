// v1.2.1 chat-first redesign — many earlier defect-regression tests
// pinned UI surfaces that no longer exist (HomeSummaryCard, the
// messenger setup step, plan pills on Home, etc.). The tests below
// keep the surviving pins that still describe live behaviour after
// the chat-first redesign + cut the defunct ones cleanly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const tokensSource = readFileSync(new URL('../../../../../src/design/tokens.ts', import.meta.url), 'utf8');
const primitivesSource = readFileSync(new URL('../../../../../src/design/primitives.tsx', import.meta.url), 'utf8');
const appConfigTsSource = readFileSync(new URL('../../../../../app.config.ts', import.meta.url), 'utf8');
const appJsonSource = readFileSync(new URL('../../../../../app.json', import.meta.url), 'utf8');
const helpSource = readFileSync(new URL('../../../../../../../packages/shared/src/content/help.ts', import.meta.url), 'utf8');

test('entry screen positions Delegent AI as a connected assistant that does the work, not an advisor', () => {
  // "Digital employee" was the positioning to 2026-09-16. The login screen
  // shows before the engine is known, so it carries the assistant line every
  // new account is sold, and nothing user-facing says employee any more.
  assert.match(appSource, /Not just answers\. Real everyday jobs, done in your apps\./);
  assert.match(appSource, /Your connected AI coworker\. It works in the apps you already use, replies in seconds/);
  assert.doesNotMatch(appSource, /digital employee/i);
  assert.doesNotMatch(appSource, /Your AI coworker for admin, follow-ups, research, and files\./);
});

test('entry email action keeps natural height so it cannot overlap the proof line', () => {
  const emailButtonStyle = appSource.match(/phoneAuthButton:\s*\{[\s\S]*?\n  \},/);
  assert.ok(emailButtonStyle, 'phoneAuthButton style should be present');
  assert.doesNotMatch(emailButtonStyle[0], /flex:\s*1/);
  // 48dp = Android a11y minimum touch target (bumped from 42 after the
  // 2026-05-29 Play release-readiness accessibility audit).
  assert.match(emailButtonStyle[0], /minHeight:\s*48/);
  assert.match(appSource, /Not just answers\. Real everyday jobs, done in your apps\./);
});

test('mobile shell is light-only with no visible dark-mode toggle', () => {
  assert.match(tokensSource, /colorThemes/);
  assert.match(tokensSource, /light:/);
  assert.match(primitivesSource, /ThemeProvider/);
  assert.match(primitivesSource, /useThemeColors/);
  assert.match(appSource, /<ThemeProvider theme="light">/);
  assert.match(appSource, /barStyle="dark-content"/);
  assert.match(appConfigTsSource, /userInterfaceStyle: 'light'/);
  assert.match(appJsonSource, /"userInterfaceStyle": "light"/);
  assert.doesNotMatch(appConfigTsSource, /#0A0A0B|userInterfaceStyle: 'dark'/);
  assert.doesNotMatch(appSource, /ThemeToggle|toggleTheme|Switch to .* mode|Toggle theme/);
  assert.doesNotMatch(tokensSource, /dark:\s*\{/);
  assert.doesNotMatch(primitivesSource, /name: 'dark'/);
});

test('bottom navigation has just Chat and Files; Profile is reachable from the header avatar', () => {
  assert.match(
    appSource,
    /const bottomTabs = \['dashboard', 'artifacts'\] as const/,
  );
  // Profile must NOT appear in the bottom tab bar.
  assert.doesNotMatch(
    appSource,
    /const bottomTabs = \[[^\]]*['"]profile['"][^\]]*\] as const/,
    'Profile must not appear in the bottom tab bar list',
  );
  // The profile screen is still reachable from the top-right avatar + the drawer.
  assert.match(appSource, /onProfilePress=\{\(\) => setActiveTab\('profile'\)\}/);
  assert.match(appSource, /testID="header\.profileButton"/);
  assert.match(appSource, /accessibilityLabel="Open profile"/);
});

test('use cases and FAQs cover tasking, training, limits, and small business workflows', () => {
  const useCasesMatch = appSource.match(/const useCaseLines = \[[\s\S]*?\] as const;/);
  assert.ok(useCasesMatch, 'Use case lines should be defined');
  // FAQ copy is shared with the web app, so it is pinned in @sidekick/shared.
  assert.match(helpSource, /export const DELEGENT_FAQ_ITEMS/, 'FAQ items should be defined');
  assert.match(appSource, /DELEGENT_FAQ_ORDERED\.map/, 'mobile should render the shared FAQ');
});

test('Quiet/Kimi restyle keeps the light-only theme tokens', () => {
  assert.match(tokensSource, /bg: '#FAFAF7'/, 'light theme should use the warm Quiet canvas');
  // Pearl (Alex's pick of five softer looks, 2026-09-28): the accent moved from
  // deep sage to a quiet ink. Still a light theme, still one accent.
  assert.match(tokensSource, /accent: '#222220'/, 'light theme should use the Pearl ink accent');
  assert.doesNotMatch(tokensSource, /bg: '#0C0C0C'/, 'dark theme should not remain in the product surface');
  assert.doesNotMatch(appSource, /useState<ThemeName>\('light'\)/, 'Delegent AI should not keep theme state for a removed dark mode');
  assert.match(appSource, /function LoginScreen[\s\S]*?const themeColors = useThemeColors\(\)/, 'login screen controls must use active theme colours');

  // Brand swap: bundled mark at fixed hero / header / onboarding footprints.
  assert.doesNotMatch(appSource, /^import \{ RobotFace \} from /m, 'RobotFace import must be retired by the brand swap');
  assert.doesNotMatch(appSource, /<RobotFace /, 'the static Delegent AI mark replaces the animated RobotFace everywhere');
  // The login hero mark became CONDITIONAL on 2026-08-14: it shrinks while the
  // email flow is open, because a fixed-height hero left the sign-in buttons
  // no room and they overlapped the logo. Both footprints must still be the
  // bundled mark, which is what this check is actually protecting.
  assert.match(appSource, /style=\{heroCompact \? styles\.brandLogoHeroCompact : styles\.brandLogoHero\}/);
  assert.match(appSource, /source=\{coworkerMark\}[\s\S]{0,120}brandLogoHeroCompact/);
  assert.match(appSource, /brandLogoHero: \{\s*\n\s*width: 108/, 'the full-size hero mark must survive');
  assert.match(appSource, /brandLogoHeroCompact: \{\s*\n\s*width: 64/, 'the compact hero mark must be smaller');
  assert.match(appSource, /<Image source=\{coworkerMark\} style=\{styles\.brandLogoHeader\} resizeMode="contain"/);
  assert.match(appSource, /<Image source=\{coworkerMark\} style=\{styles\.brandLogoOnboarding\} resizeMode="contain"/);
});

test('[defect-6] returning subscribed user lands on Home, never auto-opens the setup wizard', () => {
  // 2026-05-15 fix + 2026-05-16 v1.2.1 redesign: the Shell holds the
  // setup wizard behind an explicit `setupOpen` state and renders
  // SetupWizardScreen as a separate route only when a paid user opens
  // it via the menu, or when an unpaid user first lands. A subscribed
  // user lands directly on Home (the chat surface).
  assert.match(appSource, /const \[setupOpen, setSetupOpen\] = useState\(false\);/);
  assert.doesNotMatch(appSource, /useState<\s*boolean\s*>\([^)]*true\)/);
  // The plan-picker route triggers when the user is signed-in but has
  // no subscription yet, except for canceled users whose sleeping workspace
  // is still inside the retention window; those users must keep the shell and
  // Files tab reachable so the saved-files promise stays true.
  assert.match(appSource, /if \(appOpenPaywallOpen && !productView\.hasActiveSubscription\) \{[\s\S]*?<SetupWizardScreen/);
  assert.match(appSource, /if \(productView\.hasActiveSubscription\) \{\s*setAppOpenPaywallOpen\(false\)/);
});

test('[defect-7] checkout return shows a webhook-gated thank-you banner with non-technical copy', () => {
  // Banner is gated on the webhook-backed `subscription.status==='active'`
  // check, not on optimistic UI alone. Copy stays consumer-facing.
  assert.match(appSource, /checkoutSnapshotHasActiveSubscription/);
  assert.match(appSource, /setCheckoutThankYou\(\{ visible: true, tierId/);
  assert.match(appSource, /CheckoutThankYouBanner/);
  // No raw provider names in the banner copy.
  const banner = appSource.match(/function CheckoutThankYouBanner[\s\S]*?\n\}/);
  assert.ok(banner, 'CheckoutThankYouBanner source should be present');
  assert.doesNotMatch(banner[0], /Stripe|Supabase|webhook|Cloudflare/i);
});

test('[defect 2026-05-29] provisioning screen does not hop: transient loading banner is suppressed once data is live', () => {
  // Alex: while the workspace provisions, the screen "hops up and down" —
  // the "Checking on your coworker…" banner (ProductStateNotice loading
  // state) mounted/unmounted on every background poll, shifting layout.
  // Fix: once we've ever had live data, background re-polls must NOT pop
  // the transient banner. Lock the wiring so it can't regress.
  // 1. The component accepts the suppression flag.
  assert.match(appSource, /function ProductStateNotice\(\{[^}]*suppressTransientLoading/, 'ProductStateNotice must accept suppressTransientLoading');
  // 2. The loading branch early-returns null when suppressed.
  const notice = appSource.match(/function ProductStateNotice[\s\S]*?\n\}/);
  assert.ok(notice, 'ProductStateNotice source should be present');
  assert.match(notice[0], /if \(status === 'loading'\)[\s\S]*?if \(suppressTransientLoading\) return null;/, 'loading branch must early-return null when suppressed');
  // 2026-05-29 follow-up (Alex still saw the jump after the loading fix): the
  // transient-ERROR banner ("Couldn't refresh.") was the one still
  // mounting/unmounting on every failed background provisioning poll, shoving
  // the shell up and down. A cold error (no data yet) is handled by the
  // full-screen error route; once we have live data the background-refresh
  // error is self-healing noise, so the error branch must ALSO early-return
  // null when suppressed.
  assert.match(notice[0], /if \(status === 'error'\)[\s\S]*?if \(suppressTransientLoading\) return null;/, 'error branch must also early-return null when suppressed (stops the provisioning jump)');
  // 3. The render site feeds productEverLive (the latched "we have had live
  //    data" flag) so only the first cold load can show the banner.
  assert.match(appSource, /<ProductStateNotice[^>]*suppressTransientLoading=\{productEverLive\}/, 'render site must suppress transient loading once productEverLive');
  assert.match(appSource, /const \[productEverLive, setProductEverLive\] = useState\(false\)/, 'productEverLive latch must exist');
});

test('[defect 2026-05-29] chat WebView uses the LIGHT app palette (sage on warm paper), not the old dark slab', () => {
  // Alex: the near-black chat panel clashed with the cream app. The chat
  // is a light warm surface; its accent was sage until the 2026-09-28 Pearl
  // redesign made it ink (apps/mobile/src/design/tokens.ts accent #222220).
  // Assert the source HTML, the generated .ts mirror, AND the RN container
  // all carry the light palette — and the dark slab / gold accent are gone.
  const chatHtml = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
  const chatHtmlTs = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
  const webViewScreen = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');

  // Source HTML :root — light canvas + Pearl ink accent.
  assert.match(chatHtml, /--bg:\s*#F5F3ED/, 'chat canvas must be the warm light paper');
  assert.match(chatHtml, /--gold:\s*#3A3A36/, 'chat accent must be the Pearl ink (#3A3A36) since 2026-09-28');
  assert.doesNotMatch(chatHtml, /--bg:\s*#2A2520/, 'old dark taupe slab must be gone');
  assert.doesNotMatch(chatHtml, /--gold:\s*#E0C8A3/, 'old champagne/gold accent must be gone');

  // Generated mirror must be in sync (someone editing index.html without
  // re-running scripts/regen-chat-webview-html.js would fail here).
  assert.match(chatHtmlTs, /--bg:\s*#F5F3ED/, 'generated chatWebViewHtml.ts is stale — re-run regen-chat-webview-html.js');
  assert.match(chatHtmlTs, /--gold:\s*#3A3A36/, 'generated chatWebViewHtml.ts is stale — re-run regen-chat-webview-html.js');
  assert.doesNotMatch(chatHtmlTs, /#2A2520/, 'generated mirror still carries the old dark slab');

  // RN container behind the WebView must match (no dark flash). Since the
  // 2026-09-27 redesign the frame is transparent over the app's ambient light,
  // which is just as light; either is fine, a dark colour is not.
  assert.match(webViewScreen, /backgroundColor:\s*'(#F5F3ED|transparent)'/, 'WebView container bg must be the light canvas or transparent');
  assert.doesNotMatch(webViewScreen, /backgroundColor:\s*'#2A2520'/, 'old dark WebView bg must be gone');
});
