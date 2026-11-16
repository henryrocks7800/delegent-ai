import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
// Batch 23 (commit 2283323) moved the canonical legal text to
// packages/shared/src/legal/. The mobile app + website both import from
// @sidekick/shared now. This test reads from the canonical source.
const termsSource = readFileSync(
  new URL('../../../../../../../packages/shared/src/legal/terms.ts', import.meta.url),
  'utf8',
);
const privacySource = readFileSync(
  new URL('../../../../../../../packages/shared/src/legal/privacy.ts', import.meta.url),
  'utf8',
);

test('Delegent AI has readable UK company Terms of Service content', () => {
  // Batch 23 renamed COWORKER_AI_TERMS_* -> DELEGENT_TERMS_* when consolidating
  // the text under @sidekick/shared.
  assert.match(termsSource, /DELEGENT_TERMS_TITLE = 'Delegent AI Terms of Service'/);
  assert.match(termsSource, /DELEGENT_TERMS_UPDATED/);
  assert.match(termsSource, /Delegent AI/);
  assert.match(termsSource, /UK company/);
  assert.match(termsSource, /what Delegent AI does/);
  assert.match(termsSource, /Connected messengers, files, and third-party services/);
  assert.match(termsSource, /Plans, billing, and capacity/);
  assert.match(termsSource, /AI output can be inaccurate/);
  assert.match(termsSource, /UK law/);
  assert.doesNotMatch(termsSource, /Kimi|Moonshot|Singapore|China|membership@moonshot\.ai/);
  assert.ok((termsSource.match(/title: '/g) ?? []).length >= 9, 'Terms should include practical sections, not a placeholder');
});

test('Delegent AI has readable Privacy Policy content for UK users', () => {
  assert.match(privacySource, /DELEGENT_PRIVACY_TITLE = 'Delegent AI Privacy Policy'/);
  assert.match(privacySource, /Delegent AI/);
  assert.match(privacySource, /UK company/);
  assert.match(privacySource, /Who controls your information/);
  assert.match(privacySource, /Information you provide/);
  // Updated 2026-08-20 alongside the two payment processors that actually
  // exist now: Stripe on web/Android, Apple for iOS In-App Purchase.
  assert.match(privacySource, /Payment processors, Stripe on the web and Android, and Apple/);
  assert.match(privacySource, /AI processing and connected providers/);
  assert.match(privacySource, /Information Commissioner/);
  assert.doesNotMatch(privacySource, /Kimi|Moonshot|Singapore|China|membership@moonshot\.ai/);
  assert.ok((privacySource.match(/title: '/g) ?? []).length >= 10, 'Privacy policy should include practical sections, not a placeholder');
});

test('logged-out login screen exposes Terms and Privacy as inline bottom links, not separate buttons', () => {
  const loginMatch = appSource.match(/function LoginScreen[\s\S]*?function Header/);
  assert.ok(loginMatch, 'LoginScreen source should be available');
  const loginSource = loginMatch[0];

  assert.match(loginSource, /onOpenTerms/);
  assert.match(loginSource, /onOpenPrivacy/);
  assert.match(loginSource, /accessibilityRole="link"/);
  assert.match(loginSource, /accessibilityLabel="Open Terms of Service"/);
  assert.match(loginSource, /accessibilityLabel="Open Privacy Policy"/);
  assert.match(loginSource, /By continuing, you agree to the/);
  assert.match(loginSource, /Terms of Service/);
  assert.match(loginSource, /Privacy Policy/);
  assert.match(loginSource, /style=\{styles\.loginTermsLink\}/);
  assert.match(loginSource, /onPress=\{onOpenTerms\}/);
  assert.match(loginSource, /onPress=\{onOpenPrivacy\}/);
  assert.doesNotMatch(loginSource, /styles\.loginGoogleTermsRow/);
  assert.doesNotMatch(loginSource, /termsInlineButton/);
});

test('logged-in drawer exposes Terms and Privacy and renders the same legal content', () => {
  // 2026-07-16: Use cases merged INTO Skills; Help drawer added (support form).
  // Assert the members this suite depends on rather than pinning the whole
  // union: the literal was pinned here, so adding any unrelated drawer section
  // (Routines, 2026-07-25) failed the legal suite for no real reason.
  const drawerUnion = appSource.match(/type DrawerView = ([^\n;]+);/);
  assert.ok(drawerUnion, 'DrawerView union not found in App.tsx');
  for (const member of ['menu', 'skills', 'skillCategory', 'commands', 'faqs', 'help', 'capacity', 'setup', 'terms', 'privacy']) {
    assert.ok(drawerUnion[1].includes(`'${member}'`), `DrawerView lost the '${member}' view`);
  }
  // 2026-05-15 copy pass: Terms menu detail trimmed to "How Delegent AI works".
  assert.match(appSource, /label="Terms" detail="How Delegent AI works" onPress=\{\(\) => onChangeView\('terms'\)\}/);
  // 2026-05-15 copy pass: Privacy menu detail trimmed to "How we handle your data".
  assert.match(appSource, /label="Privacy" detail="How we handle your data" onPress=\{\(\) => onChangeView\('privacy'\)\}/);
  assert.match(appSource, /view === 'terms' \? 'Terms' : view === 'privacy' \? 'Privacy'/);
  assert.match(appSource, /view === 'terms' \? <TermsContent \/> : null/);
  assert.match(appSource, /view === 'privacy' \? <PrivacyContent \/> : null/);
});

test('Terms and Privacy modals are available while logged out without requiring authentication', () => {
  assert.match(appSource, /function TermsModal/);
  assert.match(appSource, /function PrivacyModal/);
  assert.match(appSource, /<TermsModal visible=\{termsVisible\} onClose=\{\(\) => setTermsVisible\(false\)\} \/>/);
  assert.match(appSource, /<PrivacyModal visible=\{privacyVisible\} onClose=\{\(\) => setPrivacyVisible\(false\)\} \/>/);
  assert.match(appSource, /onOpenTerms=\{\(\) => setTermsVisible\(true\)\}/);
  assert.match(appSource, /onOpenPrivacy=\{\(\) => setPrivacyVisible\(true\)\}/);
});

test('Terms modal uses a centered safe-area layout that keeps close and scroll content clear', () => {
  const modalMatch = appSource.match(/function TermsModal[\s\S]*?function LoginScreen/);
  assert.ok(modalMatch, 'TermsModal source should be available');
  const modalSource = modalMatch[0];
  assert.match(modalSource, /styles\.termsModalBackdrop/);
  // The modal has both a 'Close Terms icon' button (top-right) and a
  // 'Dismiss Terms backdrop' pressable. Either accessible close affordance
  // satisfies the test (the intent: there IS an accessible way to close
  // the modal beyond the system back gesture).
  assert.match(modalSource, /accessibilityLabel="(Close Terms icon|Close Terms|Dismiss Terms backdrop)"[\s\S]*?hitSlop=\{touchHitSlop\}/);
  assert.match(modalSource, /contentContainerStyle=\{styles\.termsScroll\}/);

  const stylesMatch = appSource.match(/termsModalBackdrop: \{[\s\S]*?termsSection: \{/);
  assert.ok(stylesMatch, 'Terms modal styles should be colocated near terms styles');
  const stylesSource = stylesMatch[0];
  assert.match(stylesSource, /justifyContent: 'center'/);
  assert.match(stylesSource, /alignItems: 'center'/);
  assert.match(stylesSource, /maxHeight: '82%'/);
  assert.match(stylesSource, /paddingTop: space\[7\]/);
  assert.match(stylesSource, /paddingBottom: space\[5\]/);
  assert.match(stylesSource, /paddingRight: space\[1\]/);

  const closeStyleMatch = appSource.match(/sheetCloseButton: \{[\s\S]*?\n  \},/);
  assert.ok(closeStyleMatch, 'Shared sheet close button styles should be available');
  assert.match(closeStyleMatch[0], /width: 44/);
  assert.match(closeStyleMatch[0], /height: 44/);
  assert.match(closeStyleMatch[0], /zIndex: 5/);
});
