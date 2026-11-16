import type { AuthSessionError, PublicAuthSession } from '@sidekick/shared';

export interface EmailLinkFailureOutcome {
  /** The session to keep. Null means sign the user out. */
  session: PublicAuthSession | null;
  /** The error to surface, or null to stay silent. */
  error: AuthSessionError | null;
  /** Whether to clear the stored session as well. */
  forgetStoredSession: boolean;
}

/**
 * What to do when an email sign-in link fails to complete.
 *
 * Signing the user out is only correct when the failed link was their only way
 * in. Applying an OTA update restarts the JS without changing the Android
 * launch intent, so the app re-reads the magic link the user originally
 * signed in with and re-verifies a one-time token that was consumed weeks ago.
 * Treating that as "sign-in failed, sign them out" dumped signed-in users back
 * on the login screen every time they took an update.
 *
 * Verifying a spent token does not disturb the stored session, so a session
 * that is still there is still good. Keep it, and stay quiet: the failure is
 * our own replay, not anything the user did.
 */
export function resolveEmailLinkFailure(
  failure: AuthSessionError,
  survivingSession: PublicAuthSession | null,
): EmailLinkFailureOutcome {
  if (survivingSession) {
    return { session: survivingSession, error: null, forgetStoredSession: false };
  }
  return { session: null, error: failure, forgetStoredSession: true };
}
