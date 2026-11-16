import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');
const accountPrivacyUrl = new URL('../../../../../src/privacy/accountPrivacy.ts', import.meta.url);
const accountPrivacySource = existsSync(accountPrivacyUrl) ? readFileSync(accountPrivacyUrl, 'utf8') : '';
// The in-app help copy lives in @sidekick/shared so mobile and web share it.
const helpSource = readFileSync(new URL('../../../../../../../packages/shared/src/content/help.ts', import.meta.url), 'utf8');

// The export/delete CAPABILITY is retained server-side + via email even though
// the in-app Profile UI was removed (PREOP-H03 operator decision), so the
// UK-GDPR right to erasure / data portability is still honoured.
test('account privacy client capability is retained (authenticated export/delete APIs, no secrets)', () => {
  assert.ok(existsSync(accountPrivacyUrl), 'src/privacy/accountPrivacy.ts should still exist');
  assert.match(accountPrivacySource, /\/api\/account\/export/);
  assert.match(accountPrivacySource, /\/api\/account\/delete/);
  assert.match(accountPrivacySource, /requestAccountExport/);
  assert.match(accountPrivacySource, /requestAccountDeletion/);
  assert.match(accountPrivacySource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.doesNotMatch(accountPrivacySource, /SERVICE_ROLE|STRIPE_SECRET|WEBHOOK_SECRET|OPENROUTER|RAILWAY|CLOUDFLARE|BOT_TOKEN/i);
});

// PREOP-H03 removed the in-app "Export my data" / "Delete my account"
// controls on 2026-06-01, when the product was Android-only.
//
// REVERSED 2026-08-16. Apple guideline 5.1.1(v) requires any app offering
// account creation to offer account deletion IN THE APP, and App Review
// asked to see the deletion flow in the demo recording. The removal would
// have failed iOS review on its own. The assertion is now its inverse: the
// control must be PRESENT, must confirm before acting, and must call the
// real endpoint.
test('the app offers in-app account deletion (Apple guideline 5.1.1(v))', () => {
  const profileScreen = appSource.match(/function ProfileScreen[\s\S]*?function TabButton/);
  assert.ok(profileScreen, 'ProfileScreen source should be available');
  assert.match(appSource, /testID="profile\.deleteAccountButton"/, 'Profile must offer account deletion');
  assert.match(appSource, /testID="profile\.deleteAccountConfirm"/, 'deletion must require an explicit confirmation');
  assert.match(appSource, /testID="profile\.deleteAccountCancel"/, 'the confirmation must offer a way out');
  assert.match(appSource, /requestAccountDeletion\(\)/, 'it must call the real endpoint, not a placeholder');
});

test('PREOP-H03: in-app help copy no longer points users to a removed Profile control', () => {
  for (const source of [appSource, helpSource]) {
    assert.doesNotMatch(source, /Use the options in Profile/, 'delete-account FAQ must not reference the removed Profile control');
    assert.doesNotMatch(source, /Request it from Profile/, 'data-copy FAQ must not reference the removed Profile control');
  }
  // Export/erasure remain available via the email route (GDPR preserved).
  assert.match(helpSource, /Email admin@example\.com from your registered address/);
});

// The Play Store data-deletion page, the Terms and the Privacy Policy all
// describe the deletion route to someone who cannot try it first: a Google
// reviewer, or a user who has already uninstalled. They were written while the
// Profile control still existed and were never reconciled with its removal, so
// /legal/delete.html spent seven weeks telling readers to open Settings and
// choose a "Delete account" button that is not there. Tie the documents to the
// control: while the app mounts no deletion flow, no document may describe one.
const LEGAL_SOURCES = ['deletion', 'terms', 'privacy'].map((name) => ({
  name: `legal/${name}.ts`,
  text: readFileSync(new URL(`../../../../../../../packages/shared/src/legal/${name}.ts`, import.meta.url), 'utf8'),
}));

const IN_APP_DELETE_CLAIMS = [
  /delete[^.]{0,60}\b(?:in|from|inside|through|via) the app\b/i,
  /\bin-app deletion\b/i,
  /choose \\?"Delete account\\?"/i,
  /Settings[^.]{0,40}Delete account/i,
];

test('the documents and the app agree about how deletion works', () => {
  // This guard used to assert the OPPOSITE: that no document described an
  // in-app route, because none existed. Now one does, so the risk inverts.
  // What must not drift is the EMAIL fallback: it is the only route open to
  // someone who has uninstalled or cannot sign in, and every document that
  // discusses deletion has to keep offering it.
  const appOffersDeletion = /testID="profile\.deleteAccountButton"/.test(appSource);
  assert.equal(appOffersDeletion, true, 'the app must offer in-app deletion (Apple 5.1.1(v))');
  assert.match(helpSource, /Email admin@example\.com from your registered address/);
});

test('the deletion route offered is the one that works, at one address across every document', () => {
  const deletion = LEGAL_SOURCES[0].text;
  assert.match(deletion, /email admin@example\.com from the email address on your account/i);
  assert.match(deletion, /whether or not you still have the app installed/);
  // The page described email only, while the app has had a Delete my account
  // button the whole time. Someone reading the page had no idea the faster
  // route existed, and the two documents disagreed about what the product does.
  assert.match(deletion, /open Profile and choose Delete my account/i);
  // What the product genuinely cannot do. An Apple subscription is Apple's to
  // cancel, and the page used to promise we would end "any subscription", which
  // would have left somebody paying for an account that no longer exists.
  assert.match(deletion, /Apple takes the payment and Apple holds the subscription/i);
  assert.match(deletion, /does not cancel it/i);
  // Deletion is a data-protection request. Terms used to send account closure
  // to support@ while Privacy and this page sent it to admin@, so the same
  // request had two addresses depending on which document you read.
  for (const source of LEGAL_SOURCES) {
    const closure = source.text.match(/[^"]*\b(?:delete|close)[^"]*your account[^"]*/gi) ?? [];
    for (const sentence of closure) {
      assert.doesNotMatch(sentence, /support@example\.com/, `${source.name} routes account deletion to support@ instead of admin@`);
    }
  }
});

test('mobile test suite includes account privacy profile regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /profile-account-privacy-readiness\.test\.mjs/);
});
