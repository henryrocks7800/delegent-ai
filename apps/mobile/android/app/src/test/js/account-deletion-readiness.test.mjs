import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');

// Apple guideline 5.1.1(v): an app that offers account creation MUST offer
// account deletion inside the app. This control was removed on 2026-06-01
// when the product was Android-only, and that removal would have failed iOS
// review — App Review asked to see the deletion flow in the demo recording.
// Restored 2026-08-16. This test exists so it cannot quietly go again.
test('the app offers in-app account deletion (Apple 5.1.1(v))', () => {
  assert.match(app, /testID="profile\.deleteAccountButton"/,
    'Profile must carry a Delete my account control');
  assert.match(app, /testID="profile\.deleteAccountConfirm"/,
    'deletion must go through an explicit confirmation, never one tap');
  assert.match(app, /testID="profile\.deleteAccountCancel"/,
    'the confirmation must offer a way out');
  assert.match(app, /requestAccountDeletion\(\)/,
    'the control must call the real endpoint, not a placeholder');
});

test('the deletion copy promises a scheduled request, not an instant wipe', () => {
  // The endpoint SCHEDULES teardown within 24h (worker: handleAccountDelete).
  // If the copy ever claims immediate erasure it would be a false statement
  // about someone's data, so the promise is pinned to what the backend does.
  assert.match(app, /within 24 hours/i,
    'the confirmation must state the 24-hour window the endpoint actually honours');
  assert.match(app, /cannot be undone/i,
    'the confirmation must be explicit that this is not reversible');
});

test('a confirmed deletion clears what the privacy policy says it clears', () => {
  // 2026-09-13: the callback only set a confirmation. The server had accepted
  // the deletion and removed the auth user while the handset kept the session
  // and the analytics identifier, which privacy section 10 says is removed.
  //
  // Both cleanup functions are executed elsewhere: clearPersistedAuthStorage in
  // tests/e2e/auth-session.test.mjs, against the installed SecureStore wrapper.
  // This holds the wiring, which is the part a refactor can quietly drop.
  const start = app.indexOf('const onConfirmDeleteAccount = useCallback');
  assert.ok(start >= 0, 'the delete callback should be readable');
  const callback = app.slice(start, app.indexOf('\n  }, []);', start));
  assert.match(callback, /fenceAuthStorageWrites\(\)/,
    'a refresh already in flight would otherwise put the session straight back');
  assert.match(callback, /await clearPersistedAuthStorage\(\)/);
  assert.match(callback, /await forgetAnalyticsIdentity\(\)/);
  // And the reader is not signed out from under the message they are reading.
  assert.match(callback, /status: 'requested'/);
});

