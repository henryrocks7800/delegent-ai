import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { type AuthSessionError, type PublicAuthSession } from '@sidekick/shared';
import { mobileAuthConfig } from './publicSupabase';
import { mapSupabaseSessionToPublicSession, mobileSupabase, rememberMobileSupabaseSession } from './supabaseClient';
import { reportAuthFailure } from '../observability/sentry';

export type GoogleSignInResult =
  | { ok: true; session: PublicAuthSession }
  | { ok: false; error: AuthSessionError };

let googleConfigured = false;

function authError(code: AuthSessionError['code'], message: string): GoogleSignInResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      provider: 'google',
    },
  };
}

function configureGoogleSignIn() {
  if (googleConfigured) return;

  // `webClientId` is what makes the returned id token's audience the WEB
  // client on both platforms, which is what Supabase validates against
  // (external_google_client_id). `iosClientId` is a separate thing: it is what
  // lets the library START the flow on iOS at all. Without it, and with no
  // GoogleService-Info.plist in the tree, iOS sign-in cannot configure.
  // Spread it only when set, because the library types it as a union of
  // iosClientId | googleServicePlistPath and an explicit undefined is not the
  // same as absent. Harmlessly ignored on Android.
  const iosClientId = mobileAuthConfig.googleIosClientId;
  GoogleSignin.configure({
    webClientId: mobileAuthConfig.googleWebClientId,
    ...(iosClientId.length > 0 ? { iosClientId } : {}),
    offlineAccess: false,
    profileImageSize: 160,
  });
  googleConfigured = true;
}

function extractIdToken(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  if (typeof record.idToken === 'string' && record.idToken.trim().length > 0) return record.idToken.trim();
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>;
    if (typeof data.idToken === 'string' && data.idToken.trim().length > 0) return data.idToken.trim();
  }

  return null;
}

function isGoogleCancel(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === statusCodes.SIGN_IN_CANCELLED || code === 'SIGN_IN_CANCELLED';
}

function publicGoogleError(error: unknown): GoogleSignInResult {
  if (isGoogleCancel(error)) {
    return authError('oauth_cancelled', 'Google sign-in was cancelled. Please try again when you are ready.');
  }

  // Same reporting as Apple, for the same reason: the iOS Google failure cost
  // hours precisely because nothing outside the screen recorded it.
  const record = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof record.code === 'string' && record.code ? record.code : String(record.message || 'unknown');
  reportAuthFailure('google', code, 'native_sheet');
  return authError('oauth_failed', 'Google sign-in did not finish. Please try again.');
}

export async function startGoogleSignIn(): Promise<GoogleSignInResult> {
  if (!mobileAuthConfig.ready) {
    return authError('missing_config', 'Google sign-in needs setup before it can be used.');
  }

  if (!mobileSupabase) {
    return authError('missing_config', 'Google sign-in needs setup before it can be used.');
  }

  try {
    configureGoogleSignIn();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const googleUser = await GoogleSignin.signIn();
    // ⚠️ v16 STOPPED THROWING ON CANCEL. It resolves with
    // { type: 'cancelled', data: null } instead, which has no id token, so the
    // getTokens() fallback below ran and returned whatever the SDK still had
    // cached from an earlier Google session. That token exchanges perfectly
    // well with Supabase, so backing out of the sheet signed the person in.
    // The discriminator has to be read before any cached credential is touched.
    const outcome = (googleUser as { type?: unknown } | null)?.type;
    if (outcome === 'cancelled') {
      return authError('oauth_cancelled', 'Google sign-in was cancelled. Please try again when you are ready.');
    }
    if (outcome !== undefined && outcome !== 'success') {
      reportAuthFailure('google', typeof outcome === 'string' ? outcome : 'unknown_outcome', 'native_sheet');
      return authError('oauth_failed', 'Google sign-in did not finish. Please try again.');
    }
    // getTokens() reads the SDK's cache, so it may only be consulted once this
    // attempt has actually succeeded.
    const idToken = extractIdToken(googleUser) ?? extractIdToken(await GoogleSignin.getTokens());

    if (!idToken) {
      return authError('oauth_failed', 'Google sign-in did not return the account approval. Please try again.');
    }

    // ⚠️ Deliberately NO `nonce` parameter, and the server side is load-bearing:
    // Supabase `external_google_skip_nonce_check` MUST stay `true` (set
    // 2026-08-13) or iOS Google sign-in breaks while Android keeps working.
    //
    // The whole story, learned across two failed fixes on TestFlight build 32:
    // Google's iOS SDK always mints the ID token with a nonce it generates
    // internally, and @react-native-google-signin 16.x exposes no way to supply
    // or read one. Sending no nonce fails ("Passed nonce and nonce in id_token
    // should either both exist or not"). Echoing the token's own nonce back
    // also fails ("invalid nonce: Nonces mismatch", proven live 2026-08-13),
    // because GoTrue compares the SHA256 of the passed nonce to the claim, so
    // only the pre-image — which the SDK never reveals — could ever satisfy it.
    // skip_nonce_check is Supabase's documented answer for exactly this SDK;
    // signature, audience and expiry checks are unaffected, and the setting is
    // Google-scoped so Apple's nonce handling is untouched.
    const { data, error } = await mobileSupabase.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });

    if (error) return authError('oauth_failed', 'Google sign-in did not finish. Please try again.');
    rememberMobileSupabaseSession(data.session ?? null);

    const publicSession = mapSupabaseSessionToPublicSession(data.session);
    if (!publicSession) return authError('session_restore_failed', 'Google sign-in finished, but the account could not be loaded. Please try again.');

    return { ok: true, session: publicSession };
  } catch (error) {
    return publicGoogleError(error);
  }
}

export async function signOutFromGoogle(): Promise<void> {
  try {
    if (!googleConfigured && mobileAuthConfig.googleWebClientId.length > 0) configureGoogleSignIn();
    await GoogleSignin.signOut();
  } catch {
    // Local Google sign-out is best-effort; Supabase is the source for app access.
  }
}
