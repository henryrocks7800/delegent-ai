// Regression tests for the OTA sign-out defect (reproduced 2026-07-26 on the
// emulator: tap "Restart to update", land on the login screen showing "That
// email link could not sign you in").
//
// The cause is a replay. An OTA restart reloads the JS but leaves the Android
// launch intent alone, so the app re-reads the magic link the user signed in
// with and re-verifies a token that was consumed long ago. The failure handler
// then wiped the session. These tests pin the rule that fixes it: a failed
// link may only sign someone out if they were not already signed in.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSessionError, PublicAuthSession } from '@sidekick/shared';

import { resolveEmailLinkFailure } from './emailLinkFailure';

const failure: AuthSessionError = {
  code: 'email_otp_failed',
  message: 'That email link could not sign you in. Please request a new one.',
  recoverable: true,
  provider: 'email',
};

const liveSession = { userId: 'user-1', provider: 'email' } as unknown as PublicAuthSession;

test('a spent link does not sign out a user who is already signed in', () => {
  const outcome = resolveEmailLinkFailure(failure, liveSession);
  assert.equal(outcome.session, liveSession, 'the live session must survive');
  assert.equal(outcome.forgetStoredSession, false, 'stored session must not be cleared');
});

test('a spent link raises no error when the user is already signed in', () => {
  // The replay is ours, not the user's. Telling them their link failed after
  // they simply took an update is both wrong and alarming.
  assert.equal(resolveEmailLinkFailure(failure, liveSession).error, null);
});

test('a genuinely failed link still signs the user out and says why', () => {
  // The real case this handler exists for: someone opens an expired link while
  // signed out. That must still land them on the login screen with the reason.
  const outcome = resolveEmailLinkFailure(failure, null);
  assert.equal(outcome.session, null);
  assert.equal(outcome.forgetStoredSession, true);
  assert.equal(outcome.error, failure);
});
