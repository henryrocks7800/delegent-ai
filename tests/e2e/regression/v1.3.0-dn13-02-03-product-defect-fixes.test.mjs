// Regression tests for the two Batch-2 product defects.
//
// DN1.3-02 — Login Terms / Privacy links must be real <Pressable>
//           controls with stable testIDs. The previous nested <Text onPress>
//           inside an outer <Text> rendered as a Spannable whose press
//           events were not reliably dispatched on Android. The fix wraps
//           each link in a <Pressable> with its own testID + accessibility
//           label.
//
// DN1.3-03 — Shell must register an Android BackHandler that intercepts
//           hardwareBackPress and:
//             1. closes burger drawer if open
//             2. closes setup wizard if open
//             3. resets activeTab to 'dashboard' if non-root
//             4. otherwise lets the system exit the app
//
// Both defects were surfaced by Batch-2 Maestro runs (AUTH-07, AUTH-08,
// RES-11) which left those flows failing as verification targets. These
// source-level guards catch a regression of either fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_PATH = REPO + 'apps/mobile/App.tsx';

const appSource = readFileSync(APP_PATH, 'utf8');

// ----- DN1.3-02 — legal-link Pressable refactor -----------------------------

test('[v1.3.0 DN1.3-02a] Terms link is a real <Pressable> with login.termsLink testID', () => {
  // The Pressable element with testID="login.termsLink" must wrap the
  // visible "Terms of Service" text. We grep a single block that contains
  // both — multiline match so the test catches the structural change, not
  // just the testID literal floating somewhere unrelated.
  assert.match(
    appSource,
    /<Pressable[\s\S]{1,400}testID="login\.termsLink"[\s\S]{1,400}Terms of Service/m,
    'login.termsLink must be a Pressable wrapping "Terms of Service"',
  );
});

test('[v1.3.0 DN1.3-02b] Privacy link is a real <Pressable> with login.privacyLink testID', () => {
  assert.match(
    appSource,
    /<Pressable[\s\S]{1,400}testID="login\.privacyLink"[\s\S]{1,400}Privacy Policy/m,
    'login.privacyLink must be a Pressable wrapping "Privacy Policy"',
  );
});

test('[v1.3.0 DN1.3-02c] no nested <Text onPress> for legal links anymore', () => {
  // Catches the regression where someone re-introduces a <Text onPress>
  // for the Terms/Privacy links. The Pressable form must be used.
  const before = appSource.indexOf('Terms of Service');
  const after = appSource.indexOf('Privacy Policy', before);
  // Look 600 chars in each direction for the worst-case nested-Text
  // signature (`<Text...accessibilityRole="link"...onPress`).
  const slice = appSource.slice(Math.max(0, before - 600), after + 600);
  assert.doesNotMatch(
    slice,
    /<Text[^>]*onPress=\{onOpenTerms\}/,
    'Found <Text onPress={onOpenTerms}> — must be <Pressable onPress={onOpenTerms}>',
  );
  assert.doesNotMatch(
    slice,
    /<Text[^>]*onPress=\{onOpenPrivacy\}/,
    'Found <Text onPress={onOpenPrivacy}> — must be <Pressable onPress={onOpenPrivacy}>',
  );
});

// ----- DN1.3-03 — Shell BackHandler -----------------------------------------

test('[v1.3.0 DN1.3-03a] BackHandler is imported from react-native', () => {
  assert.match(
    appSource,
    /import \{[^}]*\bBackHandler\b[^}]*\} from 'react-native'/,
    'BackHandler must be imported from react-native',
  );
});

test('[v1.3.0 DN1.3-03b] Shell registers a hardwareBackPress listener', () => {
  assert.match(
    appSource,
    /BackHandler\.addEventListener\(\s*'hardwareBackPress'\s*,/,
    'Shell must register a hardwareBackPress listener',
  );
});

test('[v1.3.0 DN1.3-03c] Back delegates to the paywall, closes drawer, then resets tab', () => {
  // Anchor: find the back handler function body (between the addEventListener
  // call and its closing brace). Use a slice big enough to cover the whole
  // handler. Anchor on the Shell's named `onHardwareBack` registration — a
  // bare 'hardwareBackPress' search now matches the Files multi-select
  // listener first (2026-07-22), which registers earlier in the file.
  const idx = appSource.indexOf("BackHandler.addEventListener('hardwareBackPress', onHardwareBack)");
  assert.ok(idx >= 0, 'addEventListener call not found');
  const handlerSection = appSource.slice(Math.max(0, idx - 1500), idx + 200);

  // 1. close drawer
  assert.match(handlerSection, /if \(drawerOpen\)/, 'Back handler must check drawerOpen');
  assert.match(handlerSection, /setDrawerOpen\(false\)/, 'Back handler must close the drawer');
  // The mounted paywall closes itself and records the dismissal. Shell must
  // not consume Back first, which would expose the automatic paywall again.
  assert.match(handlerSection, /if \(setupOpen \|\| appOpenPaywallOpen\) return false/);
  assert.match(appSource, /dismissPaywall\('back'\)/);
  assert.match(appSource, /exposure\.current\.dismiss\(reason\)/);
  // 3. reset to dashboard from non-root tab
  assert.match(handlerSection, /activeTab !== 'dashboard'/, 'Back handler must check non-root tab state');
  assert.match(handlerSection, /setActiveTab\('dashboard'\)/, 'Back handler must reset to dashboard');
  // 4. fall through (only) from root
  assert.match(handlerSection, /return false/, 'Back handler must return false from the root to let Android handle exit');
});

test('[v1.3.0 DN1.3-03d] Back handler dependency array tracks drawer, drawerView, setup, and activeTab', () => {
  // The useEffect must re-bind when any of these change so the closure
  // captures the latest value (without the dep array, an old closure
  // would see stale state and the wrong action). drawerView was added
  // so drawer-subpage Back returns to the menu list rather than closing
  // the whole drawer.
  const idx = appSource.indexOf("BackHandler.addEventListener('hardwareBackPress', onHardwareBack)");
  const tail = appSource.slice(idx, idx + 1500);
  assert.match(tail, /\[\s*drawerOpen\s*,\s*drawerView\s*,\s*setupOpen\s*,\s*appOpenPaywallOpen\s*,\s*activeTab\s*\]/);
});

test('[v1.3.0 DN1.3-03e] Back from drawer subpage returns to menu list, not full close', () => {
  const idx = appSource.indexOf("BackHandler.addEventListener('hardwareBackPress', onHardwareBack)");
  const handlerSection = appSource.slice(Math.max(0, idx - 1500), idx + 400);
  assert.match(handlerSection, /drawerView !== 'menu'/, 'Back handler must distinguish drawer-subpage from menu list');
  assert.match(handlerSection, /setDrawerView\('menu'\)/, 'Back handler must reset drawerView to menu');
});
