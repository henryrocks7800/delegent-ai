import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// PREOP-M01: the brand is "Delegent" and the canonical domain is
// delegentai.co.uk (the app copy, legal terms, and live mailboxes all use it).
// The app's "Visit our website" row shipped the deleg-A-nt typo
// (delegantai.co.uk) as both the displayed domain and the opened link — the
// wrong domain the operator saw in-app. The app must never ship the typo.
test('PREOP-M01: the app uses the canonical delegentai.co.uk domain, never the delegantai typo', () => {
  assert.doesNotMatch(appSource, /delegantai/, 'app must not contain the deleg-A-nt typo domain');
  assert.match(appSource, /delegentai\.co\.uk/, 'app should reference the canonical Delegent domain');
});

// The browser version shipped in July 2026 and the app said nothing about it,
// so a customer sitting at a desk had no way to learn it existed. "Also
// available on" is the one place in the app that names other doors, and the
// how-to guide is where someone reads about working differently.
test('the app tells people they can use their computer, and links there', () => {
  const elsewhere = appSource.match(
    /MenuSectionLabel testID="menu\.section\.elsewhere"[\s\S]*?menu\.section\.legal/,
  );
  assert.ok(elsewhere, 'the "Also available on" menu section is gone or was renamed');
  assert.match(elsewhere[0], /testID="menu\.webAppRow"/, 'nothing in "Also available on" points at the web app');
  assert.match(elsewhere[0], /Linking\.openURL\(WEB_APP_URL\)/, 'the web app row does not open the web app');

  // Read from shared, not retyped, so the move to app.delegentai.co.uk is one
  // edit rather than a hunt.
  assert.match(appSource, /WEB_APP_URL,/, 'App.tsx does not import the shared web app address');
  assert.doesNotMatch(appSource, /delegent-app\.web\.app/, 'App.tsx hard-codes the web app address');

  // The how-to guide says this too, but through the SHARED section list that
  // both surfaces map, not a card only the phone renders. It was a phone-only
  // card for a day and that is precisely the drift Alex caught, so the guard
  // here is that the phone adds nothing to the guide beyond the shared list.
  assert.match(appSource, /DELEGENT_HOWTO_SECTIONS\.map/, 'the how-to guide no longer renders the shared sections');
  assert.doesNotMatch(appSource, /testID="howto\.webAppLink"/, 'the how-to guide has a phone-only web app card again; put the words in DELEGENT_HOWTO_SECTIONS so the browser gets them too');
});

test('mobile test suite includes brand-domain regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /brand-domain-readiness\.test\.mjs/);
});
