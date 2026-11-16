import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Google sign-in used to hand off through Supabase's redirect, which meant
// Google's account picker announced "to continue to <project>.supabase.co".
// Readers reported that as looking like a phishing attempt. The token is now
// taken in the browser and passed to Supabase directly, the way the phone
// already does it, so the picker names our own origin. These tests pin the
// three properties that fix depends on.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const read = (relative) => readFileSync(resolve(SRC, relative), 'utf8');

const signIn = read('features/auth/SignIn.tsx');
const identity = read('features/auth/googleIdentity.ts');
const auth = read('features/auth/useAuth.ts');

test('the credential is exchanged on our own origin, not via the Supabase redirect', () => {
  // Word-anchored: a renamed-out call such as DISABLED_mountGoogleButton( must
  // read as removed, not as still present.
  assert.match(signIn, /\bmountGoogleButton\(/, 'the sign-in screen no longer mounts the on-page Google button');
  assert.match(auth, /signInWithIdToken\(\{ provider: 'google'/, 'the ID token is no longer exchanged directly');
  // The redirect must survive as a fallback, but it may not be what the screen
  // reaches for first.
  const mountAt = signIn.search(/\bmountGoogleButton\(/);
  const redirectAt = signIn.search(/\bsignInWithGoogle\(/);
  assert.ok(mountAt >= 0 && mountAt < redirectAt, 'the redirect is being used ahead of the on-page button');
});

test('an unreachable Google still leaves a way in', () => {
  // A blocked or slow script fires neither onload nor onerror, so without a
  // timeout the reader waits forever on a button that never appears.
  assert.match(identity, /LOAD_TIMEOUT_MS/, 'the script load has no timeout');
  assert.match(identity, /setTimeout\(\(\) => resolve\(null\)/, 'the timeout does not resolve to the fallback');
  assert.match(signIn, /googleMode === 'redirect'/, 'there is no fallback button when Google cannot be reached');
  // The email code path must never be gated on Google loading at all.
  assert.match(signIn, /Send sign-in code/);
  assert.equal(
    /googleMode[^\n]*Send sign-in code/.test(signIn),
    false,
    'the email path is conditional on the Google button',
  );
});

test('the button is drawn for the width it is actually given', () => {
  // Google bakes the width in at render time, so a rotation would otherwise
  // leave a button that no longer fits its card.
  assert.match(identity, /addEventListener\('resize'/, 'the button is never redrawn on resize');
  assert.match(identity, /removeEventListener\('resize'/, 'the resize listener is never cleaned up');
  assert.match(identity, /MAX_BUTTON_WIDTH = 400/, 'the 400px cap Google enforces is not respected');
});
