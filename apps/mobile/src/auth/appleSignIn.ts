import { Platform } from 'react-native';
import { type AuthSessionError, type PublicAuthSession } from '@sidekick/shared';

import { mapSupabaseSessionToPublicSession, mobileSupabase, rememberMobileSupabaseSession } from './supabaseClient';
import { reportAuthFailure } from '../observability/sentry';

// Sign in with Apple, the third peer of Google and email. Guideline 4.8 makes
// it mandatory once Google Sign-In is offered: the alternative login has to
// let users keep their email PRIVATE, which email OTP by definition does not.
//
// The native flow: expo-apple-authentication puts up the system sheet and
// returns an identity token whose audience is the app's bundle id
// (com.sidekick.v2). Supabase validates that audience against
// external_apple_client_id, so the bundle id must be in that list. This is the
// documented Supabase native-Apple pattern (signInWithIdToken, no nonce), the
// same shape as googleSignIn.ts next door.
//
// expo-apple-authentication is loaded LAZILY with the whole body inside one
// try/catch. Expo binds native modules on first property access, not at
// import, so guarding only the import is not enough. That exact mistake
// crashed the app on launch on 2026-07-19 (ExponentImagePicker) — see
// chatAttachmentUpload.ts. The runtimeVersion bump to 2.4.0 means no old
// binary should ever receive this JS, but the guard costs nothing and the
// pattern is the house rule for every native module.

export type AppleSignInResult =
  | { ok: true; session: PublicAuthSession }
  | { ok: false; error: AuthSessionError };

function authError(code: AuthSessionError['code'], message: string): AppleSignInResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      provider: 'apple',
    },
  };
}

function isAppleCancel(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_REQUEST_CANCELED';
}

/**
 * Apple's other way of saying the same thing. Its own engineers confirm that
 * one underlying authorisation failure surfaces as 1000 (unknown) on some
 * devices and 1001 (cancelled) on others, which is exactly what we saw: Alex
 * got UNKNOWN, Dan got CANCELED, from the same build.
 */
function isAppleUnknown(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 'ERR_REQUEST_UNKNOWN';
}

/**
 * Apple's own failure code, appended to the user-facing message.
 *
 * WHY. Sign in with Apple failed for Alex on every attempt (2026-08-13) with
 * Apple's system sheet saying "Sign Up Not Completed", and NOTHING reached
 * Supabase, so there was no server log to read. This module caught the error
 * and showed generic copy, which meant the one piece of evidence that could
 * name the cause was being discarded on the device. Every candidate (2FA off,
 * Screen Time restrictions, the entitlement, the provisioning profile, the
 * App ID capability, the Supabase provider) was checked and cleared, and the
 * investigation still had nothing to go on.
 *
 * A short code in the message is also normal, supportable production
 * behaviour: it costs a user nothing and turns "it does not work" into a
 * diagnosable report. Truncated hard because this string reaches the UI.
 */
function appleErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === 'string' && record.code.trim().length > 0 ? record.code.trim() : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const detail = code || message || 'unknown';
  return detail.slice(0, 80);
}

/**
 * Whether the Sign in with Apple button should render at all: iOS 13+ with
 * the native module present. Never throws, and always false on Android, so
 * the login screen can call it unconditionally.
 */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    const AppleAuthentication = await import('expo-apple-authentication');
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function startAppleSignIn(): Promise<AppleSignInResult> {
  if (Platform.OS !== 'ios') {
    return authError('missing_config', 'Sign in with Apple is only available on Apple devices.');
  }
  if (!mobileSupabase) {
    return authError('missing_config', 'Sign in with Apple needs setup before it can be used.');
  }

  try {
    const AppleAuthentication = await import('expo-apple-authentication');

    // Ask for name and email first, because we genuinely want them: Apple
    // reveals the name ONCE, on the first authorisation, and never again.
    //
    // But fall back to a SCOPELESS request if that is refused. Sign in with
    // Apple has failed for every one of our users since the app's App ID was
    // created on 2026-08-12, with "Sign-Up Not Completed" and
    // ERR_REQUEST_CANCELED / ERR_REQUEST_UNKNOWN, and it survived regenerating
    // the provisioning profile. Apple's developer forums (thread 122458)
    // record dropping the requested scopes as a workaround for precisely this,
    // alongside a second one for App IDs created recently.
    //
    // The fallback is worth keeping even once the underlying fault clears: an
    // account that cannot grant scopes should still be able to sign in, and
    // a nameless profile is a far smaller problem than a locked-out user.
    // Both attempts report to Sentry under distinct stages, so the dashboard
    // says which path a real device actually took.
    let credential: Awaited<ReturnType<typeof AppleAuthentication.signInAsync>>;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
    } catch (scopedError) {
      // Only the two codes Apple uses for this one fault trigger a retry;
      // A CANCEL NO LONGER RETRIES. Dropped 2026-08-27, exactly as the note
      // above said it should be "the first thing to drop once Apple's side is
      // healthy". It is: Sentry shows zero failures across 21 to 26 August,
      // and Sign in with Apple has since succeeded on 18 Aug, on 24 Aug for
      // Apple's own reviewer, and on 27 Aug. The 13 to 20 August cluster was
      // the newly-created App ID settling, which is what the note predicted.
      //
      // Retrying a cancel was always the weaker half of this workaround: it
      // shows a SECOND sheet to someone who just deliberately dismissed the
      // first, which reads as the app refusing to take no for an answer. It
      // was justified only while the alternative was a locked-out user.
      //
      // The evidence that it is not worth keeping: the retry has fired 24
      // times and reported `native_sheet_scopeless_ok` ZERO times. It has
      // never once rescued a sign-in.
      //
      // ERR_REQUEST_UNKNOWN still retries, because that is the fault this
      // fallback was actually built for and it costs a genuine cancel nothing.
      if (isAppleUnknown(scopedError) === false) throw scopedError;
      reportAuthFailure('apple', appleErrorCode(scopedError), 'native_sheet_scoped');
      credential = await AppleAuthentication.signInAsync({});
      reportAuthFailure('apple', 'scopeless retry succeeded', 'native_sheet_scopeless_ok');
    }

    const identityToken = credential.identityToken?.trim();
    if (!identityToken) {
      return authError('oauth_failed', 'Apple sign-in did not return the account approval. Please try again.');
    }

    const { data, error } = await mobileSupabase.auth.signInWithIdToken({
      provider: 'apple',
      token: identityToken,
    });

    if (error) {
      // Supabase rejected a token Apple DID issue. A different failure from
      // the sheet failing, and worth telling apart in a report.
      reportAuthFailure('apple', String(error.message || 'rejected'), 'supabase_exchange');
      return authError('oauth_failed', `Apple sign-in did not finish. Please try again. (supabase: ${String(error.message || 'rejected').slice(0, 60)})`);
    }
    rememberMobileSupabaseSession(data.session ?? null);

    // Apple only reveals the name on the FIRST authorisation, and never
    // again. Persist it into user metadata right away or the profile stays
    // nameless forever. Best-effort: a failure here must not fail sign-in.
    const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (fullName && !data.user?.user_metadata?.full_name) {
      try {
        await mobileSupabase.auth.updateUser({ data: { full_name: fullName } });
      } catch {
        // The session is real either way.
      }
    }

    const publicSession = mapSupabaseSessionToPublicSession(data.session);
    if (!publicSession) return authError('session_restore_failed', 'Apple sign-in finished, but the account could not be loaded. Please try again.');

    return { ok: true, session: publicSession };
  } catch (error) {
    // Report BEFORE branching, and report CANCELS TOO.
    //
    // The cancel branch was the one path through this function with no
    // telemetry and no code on screen, and Apple routinely surfaces a FAILED
    // authorization to the app as a cancellation rather than an error. That
    // combination exactly explains what Alex saw across two days: Apple's own
    // "Sign-Up Not Completed" sheet, then benign copy, an empty bracket, and
    // nothing whatsoever in Sentry. Treating an unexplained failure as a user
    // changing their mind is what hid it.
    //
    // A genuine cancel still reads as a cancel to the user; it is merely no
    // longer invisible to us. Level and stage keep the two apart in Sentry.
    const code = appleErrorCode(error);
    const cancelled = isAppleCancel(error);
    reportAuthFailure('apple', code, cancelled ? 'native_sheet_cancelled' : 'native_sheet');
    if (cancelled) {
      return authError('oauth_cancelled', 'Apple sign-in was cancelled. Please try again when you are ready.');
    }
    return authError('oauth_failed', `Apple sign-in did not finish. Please try again. (${code})`);
  }
}
