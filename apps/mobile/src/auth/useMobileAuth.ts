import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, NativeModules } from 'react-native';
import { AUTH_PROVIDER_EMAIL, DEFAULT_SUPABASE_AUTH_CALLBACK, resolveAuthSessionState, type AuthSessionError, type AuthSessionState, type PublicAuthSession } from '@sidekick/shared';
import { mobileSupabaseConfig } from './publicSupabase';
import { startGoogleSignIn, signOutFromGoogle } from './googleSignIn';
import { startAppleSignIn } from './appleSignIn';
import { forgetMobileSupabaseSession, mapSupabaseSessionToPublicSession, mobileSupabase, rememberMobileSupabaseSession, signOutMobileSessionDurably } from './supabaseClient';
import { fenceAuthStorageWrites, releaseAuthStorageWrites } from './secureSessionStorage';
import { reportAuthFailure } from '../observability/sentry';
import { sendEmailOtp as requestEmailOtp, verifyEmailOtp as confirmEmailOtp, type EmailOtpSendResult, type EmailOtpVerifyResult } from './emailOtp';
import { sendPhoneOtp as requestPhoneOtp, verifyPhoneOtp as confirmPhoneOtp, type PhoneOtpSendResult, type PhoneOtpVerifyResult } from './phoneOtp';
import { resolveEmailLinkFailure } from './emailLinkFailure';
import { track } from '../analytics/analyticsClient';

export interface MobileAuthController {
  authState: AuthSessionState;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  sendEmailOtp: (email: string) => Promise<EmailOtpSendResult>;
  verifyEmailOtp: (email: string, code: string) => Promise<EmailOtpVerifyResult>;
  sendPhoneOtp: (phone: string) => Promise<PhoneOtpSendResult>;
  verifyPhoneOtp: (phone: string, code: string) => Promise<PhoneOtpVerifyResult>;
  signOut: () => Promise<void>;
}

function restoreError(): AuthSessionError {
  return {
    code: 'session_restore_failed',
    message: 'Your sign-in account could not be loaded. Please try again.',
    recoverable: true,
    provider: 'google',
  };
}

function emailLinkError(code: AuthSessionError['code'], message: string): AuthSessionError {
  return {
    code,
    message,
    recoverable: true,
    provider: AUTH_PROVIDER_EMAIL,
  };
}

type SupabaseEmailVerifyType = 'signup' | 'magiclink';

type SidekickDeepLinkModule = {
  getInitialUrl?: () => Promise<string | null>;
  peekLatestUrl?: () => Promise<string | null>;
  consumeLatestUrl?: () => Promise<string | null>;
};

const sidekickDeepLink = NativeModules.SidekickDeepLink as SidekickDeepLinkModule | undefined;

async function readSidekickNativeDeepLink(method: keyof SidekickDeepLinkModule): Promise<string | null> {
  try {
    const reader = sidekickDeepLink?.[method];
    if (typeof reader !== 'function') return null;
    const url = await reader();
    return typeof url === 'string' && url.trim() ? url : null;
  } catch {
    return null;
  }
}

function normalizeSupabaseEmailVerifyType(rawType: string | null): SupabaseEmailVerifyType {
  return rawType === 'signup' ? 'signup' : 'magiclink';
}

export function isSupabaseAuthCallbackUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith(DEFAULT_SUPABASE_AUTH_CALLBACK);
}

export function isSupabaseAuthVerifyUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string' || !mobileSupabaseConfig.ready) return false;
  try {
    const parsed = new URL(url);
    const supabase = new URL(mobileSupabaseConfig.config.url);
    return parsed.origin === supabase.origin && parsed.pathname === '/auth/v1/verify';
  } catch {
    return false;
  }
}

function isHandledEmailAuthUrl(url: string | null | undefined): url is string {
  return isSupabaseAuthCallbackUrl(url) || isSupabaseAuthVerifyUrl(url);
}

function callbackParams(url: string): URLSearchParams {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.search);
  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const hashParams = new URLSearchParams(hash);
  hashParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  return params;
}

// A sign-in link may CREATE a session. It may never REPLACE one.
//
// Both link routes into the app are reachable by anyone: sidekick:// is a
// BROWSABLE scheme, and the Supabase /auth/v1/verify app link is an ordinary
// https URL any web page, email or message can point at. So an attacker can
// hand the victim a link carrying a token minted for the ATTACKER's account.
// Completing it moves the victim silently into that account, where every file
// they upload and everything they say to their coworker is the attacker's to
// read. Refusing while a session exists closes that off, at the cost of asking
// a signed-in user to sign out before switching accounts by link.
//
// The PKCE `code` branch is exempt: it only completes against a verifier this
// install generated, so it cannot be driven by a link from outside.
async function refusalIfAlreadySignedIn(): Promise<AuthSessionError | null> {
  const existing = await mobileSupabase?.auth.getSession();
  if (!existing?.data.session) return null;
  return emailLinkError('email_otp_invalid', 'You are already signed in. Sign out first to use a sign-in link.');
}

export async function completeEmailLinkSignIn(url: string): Promise<{ ok: true; session: PublicAuthSession } | { ok: false; error: AuthSessionError } | null> {
  if (!mobileSupabaseConfig.ready || !mobileSupabase) {
    return { ok: false, error: emailLinkError('missing_config', 'Email sign-in needs setup before it can finish.') };
  }

  if (isSupabaseAuthVerifyUrl(url)) {
    const params = callbackParams(url);
    const tokenHash = (params.get('token_hash') || params.get('token'))?.trim();
    const verifyType = normalizeSupabaseEmailVerifyType(params.get('type'));
    if (!tokenHash) {
      return { ok: false, error: emailLinkError('email_otp_invalid', 'That email link was missing its sign-in token. Please request a new one.') };
    }

    try {
      // Checked before verifyOtp so a refused link does not also burn the token.
      const refusal = await refusalIfAlreadySignedIn();
      if (refusal) return { ok: false, error: refusal };

      const response = await mobileSupabase.auth.verifyOtp({ token_hash: tokenHash, type: verifyType });
      if (response.error) {
        return { ok: false, error: emailLinkError('email_otp_failed', 'That email link could not sign you in. Please request a new one.') };
      }

      const verifiedSession = response.data.session ?? null;
      if (!verifiedSession?.access_token || !verifiedSession.refresh_token) {
        return { ok: false, error: emailLinkError('session_restore_failed', 'Email sign-in finished, but the account could not be loaded. Please try again.') };
      }

      // Android app links can deliver Supabase /auth/v1/verify links directly to
      // the installed app. Persist the returned session back into the GoTrue
      // client so later RPCs (onboarding, checkout, product refresh) can read a
      // real current session instead of only the public React state.
      const persisted = await mobileSupabase.auth.setSession({
        access_token: verifiedSession.access_token,
        refresh_token: verifiedSession.refresh_token,
      });
      if (persisted.error || !persisted.data.session) {
        return { ok: false, error: emailLinkError('session_restore_failed', 'Email sign-in finished, but the account could not be loaded. Please try again.') };
      }

      rememberMobileSupabaseSession(persisted.data.session);
      const publicSession = mapSupabaseSessionToPublicSession(persisted.data.session);
      if (!publicSession) {
        return { ok: false, error: emailLinkError('session_restore_failed', 'Email sign-in finished, but the account could not be loaded. Please try again.') };
      }
      return { ok: true, session: publicSession };
    } catch {
      return { ok: false, error: emailLinkError('email_otp_failed', 'That email link could not sign you in. Please request a new one.') };
    }
  }

  if (!isSupabaseAuthCallbackUrl(url)) return null;

  const params = callbackParams(url);
  const callbackError = params.get('error_description') || params.get('error');
  if (callbackError) {
    return { ok: false, error: emailLinkError('email_otp_failed', 'That email link could not sign you in. Please request a new one.') };
  }

  try {
    const code = params.get('code')?.trim();
    const accessToken = params.get('access_token')?.trim();
    const refreshToken = params.get('refresh_token')?.trim();
    // The raw-token branch exists for Supabase verify-link redirects: the
    // tokens arrive in the deeplink itself, with no PKCE verifier held by the
    // app, so it is driveable from outside. See refusalIfAlreadySignedIn.
    if (!code && accessToken && refreshToken) {
      const refusal = await refusalIfAlreadySignedIn();
      if (refusal) return { ok: false, error: refusal };
    }
    const response = code
      ? await mobileSupabase.auth.exchangeCodeForSession(code)
      : accessToken && refreshToken
      ? await mobileSupabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      : { data: { session: null }, error: emailLinkError('email_otp_invalid', 'That email link was missing its sign-in token. Please request a new one.') };

    if (response.error) {
      return { ok: false, error: emailLinkError('email_otp_failed', 'That email link could not sign you in. Please request a new one.') };
    }

    rememberMobileSupabaseSession(response.data.session ?? null);
    const publicSession = mapSupabaseSessionToPublicSession(response.data.session ?? null);
    if (!publicSession) {
      return { ok: false, error: emailLinkError('session_restore_failed', 'Email sign-in finished, but the account could not be loaded. Please try again.') };
    }
    return { ok: true, session: publicSession };
  } catch {
    return { ok: false, error: emailLinkError('email_otp_failed', 'That email link could not sign you in. Please request a new one.') };
  }
}

// Whatever session the auth client is holding right now, if any. Used to tell
// "this link failed and the user is signed out" apart from "this link failed
// but the user was already signed in anyway".
async function readLiveSession(): Promise<PublicAuthSession | null> {
  if (!mobileSupabase) return null;
  try {
    const { data } = await mobileSupabase.auth.getSession();
    return mapSupabaseSessionToPublicSession(data.session);
  } catch {
    return null;
  }
}

export function useMobileAuth(initialEmailAuthUrl?: string | null): MobileAuthController {
  const [session, setSession] = useState<PublicAuthSession | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AuthSessionError | null>(null);
  // Tracks whether the hook is still mounted, so async sign-in/sign-out
  // callbacks don't call setState (and trigger React warnings) after the
  // component has been unmounted while a Google flow was in flight.
  const mountedRef = useRef(true);
  const consumedEmailCallbackUrlsRef = useRef<Set<string>>(new Set());
  const emailCallbackInFlightRef = useRef(false);
  const emailCallbackControlsStateRef = useRef(false);
  const suppressNextNullAuthEventRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    if (!mobileSupabase) {
      setRestoring(false);
      return undefined;
    }

    mobileSupabase.auth
      .getSession()
      .then(({ data, error: restoreFailure }) => {
        if (!mounted || emailCallbackInFlightRef.current || emailCallbackControlsStateRef.current) return;
        if (restoreFailure) {
          forgetMobileSupabaseSession();
          setSession(null);
          setError(restoreError());
          return;
        }
        rememberMobileSupabaseSession(data.session ?? null);
        setSession(mapSupabaseSessionToPublicSession(data.session));
        setError(null);
      })
      .catch(() => {
        if (!mounted || emailCallbackInFlightRef.current || emailCallbackControlsStateRef.current) return;
        forgetMobileSupabaseSession();
        setSession(null);
        setError(restoreError());
      })
      .finally(() => {
        if (mounted && !emailCallbackInFlightRef.current && !emailCallbackControlsStateRef.current) setRestoring(false);
      });

    const { data: listener } = mobileSupabase.auth.onAuthStateChange((authEvent, nextSession) => {
      if (!mounted || emailCallbackInFlightRef.current) return;
      if (!nextSession && (suppressNextNullAuthEventRef.current || emailCallbackControlsStateRef.current)) {
        suppressNextNullAuthEventRef.current = false;
        return;
      }
      emailCallbackControlsStateRef.current = false;
      rememberMobileSupabaseSession(nextSession);
      setSession(mapSupabaseSessionToPublicSession(nextSession));
      // Clear the error ONLY when a real session arrives. A signed-out event
      // must never wipe one, because a FAILED sign-in produces exactly that
      // event a beat later: the sheet fails, setError runs, the suppress guard
      // is already cleared by its own finally block, this listener fires and
      // erased the message. That is why Alex's Apple failure flashed red for a
      // split second and vanished before it could be read (2026-08-13),
      // costing the whole investigation its only evidence. A null session is
      // not news that the last failure stopped being true.
      if (nextSession) setError(null);
      setRestoring(false);
      // Funnel: a genuine sign-in (not a token refresh or session restore).
      if (authEvent === 'SIGNED_IN' && nextSession) track('sign_in_completed');
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    // v1.2.4 fix: suppress any spurious `null` auth-state events that
    // fire while the Google flow is in progress (the native sheet +
    // signInWithIdToken handshake can briefly emit SIGNED_OUT before
    // the real session lands). Without this guard the Login screen
    // flashes back into view between picker-tap and home-land, so
    // the user has to tap Google twice.
    suppressNextNullAuthEventRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await startGoogleSignIn();
      if (!mountedRef.current) return;
      if ('error' in result) {
        forgetMobileSupabaseSession();
        suppressNextNullAuthEventRef.current = false;
        setSession(null);
        setError(result.error);
      } else {
        suppressNextNullAuthEventRef.current = false;
        setSession(result.session);
      }
    } finally {
      suppressNextNullAuthEventRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Mirrors signInWithGoogle exactly, including the suppress-null guard: the
  // Apple sheet + signInWithIdToken handshake has the same window where a
  // spurious SIGNED_OUT can flash the login screen back into view.
  const signInWithApple = useCallback(async () => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await startAppleSignIn();
      if (!mountedRef.current) return;
      if ('error' in result) {
        forgetMobileSupabaseSession();
        suppressNextNullAuthEventRef.current = false;
        setSession(null);
        setError(result.error);
      } else {
        suppressNextNullAuthEventRef.current = false;
        setSession(result.session);
      }
    } finally {
      suppressNextNullAuthEventRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);


  const sendEmailOtp = useCallback(async (email: string): Promise<EmailOtpSendResult> => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = false;
    setLoading(true);
    setError(null);
    const result = await requestEmailOtp(email);
    if (!mountedRef.current) return result;
    if ('error' in result) {
      forgetMobileSupabaseSession();
      setSession(null);
    }
    setLoading(false);
    return result;
  }, []);

  const completeEmailCallback = useCallback(async (url: string) => {
    if (!isHandledEmailAuthUrl(url)) return;
    if (consumedEmailCallbackUrlsRef.current.has(url)) return;
    consumedEmailCallbackUrlsRef.current.add(url);
    emailCallbackInFlightRef.current = true;
    emailCallbackControlsStateRef.current = true;
    setLoading(true);
    setError(null);
    const result = await completeEmailLinkSignIn(url);
    if (!result) {
      emailCallbackControlsStateRef.current = false;
      if (mountedRef.current) setLoading(false);
      emailCallbackInFlightRef.current = false;
      return;
    }
    if (!mountedRef.current) {
      emailCallbackInFlightRef.current = false;
      return;
    }
    if ('error' in result) {
      const outcome = resolveEmailLinkFailure(result.error, await readLiveSession());
      if (!mountedRef.current) {
        emailCallbackInFlightRef.current = false;
        return;
      }
      if (outcome.forgetStoredSession) forgetMobileSupabaseSession();
      emailCallbackControlsStateRef.current = outcome.session === null;
      suppressNextNullAuthEventRef.current = outcome.session === null;
      setSession(outcome.session);
      setError(outcome.error);
    } else {
      suppressNextNullAuthEventRef.current = false;
      setSession(result.session);
      setError(null);
    }
    setRestoring(false);
    setLoading(false);
    emailCallbackInFlightRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const completeIfAvailable = (url: string | null | undefined) => {
      if (!cancelled && url) void completeEmailCallback(url);
    };

    completeIfAvailable(initialEmailAuthUrl);

    const consumeNativeDeepLink = () => {
      readSidekickNativeDeepLink('peekLatestUrl')
        .then(async (url) => {
          if (!isHandledEmailAuthUrl(url)) return;
          const consumedUrl = await readSidekickNativeDeepLink('consumeLatestUrl');
          completeIfAvailable(consumedUrl);
        })
        .catch(() => undefined);
    };

    Linking.getInitialURL()
      .then(completeIfAvailable)
      .catch(() => undefined);

    // React Native's Linking can miss launch intents in release builds on some
    // Android paths. MainActivity stores both cold-start and onNewIntent URLs in
    // a tiny native module, so the auth hook has a deterministic fallback for
    // real Supabase email links opened from Gmail/Chrome.
    readSidekickNativeDeepLink('getInitialUrl')
      .then(completeIfAvailable)
      .catch(() => undefined);
    consumeNativeDeepLink();
    const nativeDeepLinkPoller = setInterval(consumeNativeDeepLink, 750);

    const listener = Linking.addEventListener('url', ({ url }) => {
      void completeEmailCallback(url);
    });

    return () => {
      cancelled = true;
      clearInterval(nativeDeepLinkPoller);
      listener.remove();
    };
  }, [completeEmailCallback, initialEmailAuthUrl]);

  const verifyEmailOtp = useCallback(async (email: string, code: string): Promise<EmailOtpVerifyResult> => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = false;
    setLoading(true);
    setError(null);
    const result = await confirmEmailOtp(email, code);
    if (!mountedRef.current) return result;
    if ('error' in result) {
      forgetMobileSupabaseSession();
      setSession(null);
      setError(result.error);
    } else {
      setSession(result.session);
    }
    setLoading(false);
    return result;
  }, []);

  const sendPhoneOtp = useCallback(async (phone: string): Promise<PhoneOtpSendResult> => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = false;
    setLoading(true);
    setError(null);
    const result = await requestPhoneOtp(phone);
    if (!mountedRef.current) return result;
    if ('error' in result) {
      forgetMobileSupabaseSession();
      setSession(null);
      setError(result.error);
    }
    setLoading(false);
    return result;
  }, []);

  const verifyPhoneOtp = useCallback(async (phone: string, code: string): Promise<PhoneOtpVerifyResult> => {
    // Whatever a sign-out fenced off, an actual sign-in attempt wants back.
    releaseAuthStorageWrites();
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = false;
    setLoading(true);
    setError(null);
    const result = await confirmPhoneOtp(phone, code);
    if (!mountedRef.current) return result;
    if ('error' in result) {
      forgetMobileSupabaseSession();
      setSession(null);
      setError(result.error);
    } else {
      setSession(result.session);
    }
    setLoading(false);
    return result;
  }, []);

  const signOut = useCallback(async () => {
    emailCallbackControlsStateRef.current = false;
    suppressNextNullAuthEventRef.current = false;
    // Before the remote call. A token refresh already in flight resolves after
    // the storage clear below and writes the session straight back in.
    fenceAuthStorageWrites();
    setLoading(true);
    setError(null);
    try {
      // The sequence lives in supabaseClient.ts, where it can be executed
      // against the actual SDK. See signOutMobileSessionDurably for why the
      // SDK's own sign-out cannot be trusted to clear local storage.
      const { remoteRevoked } = await signOutMobileSessionDurably(mobileSupabase);
      // Signed out here either way. The only thing left undone is revocation
      // elsewhere, which is worth knowing about and is not worth a red line on
      // a screen the person is walking away from.
      if (!remoteRevoked) reportAuthFailure('supabase', 'remote_revoke_failed', 'sign_out');
      await signOutFromGoogle();
    } finally {
      forgetMobileSupabaseSession();
      if (mountedRef.current) {
        setSession(null);
        setLoading(false);
      }
    }
  }, []);

  const authState = useMemo(
    () => resolveAuthSessionState({
      supabaseConfig: mobileSupabaseConfig,
      session,
      restoring,
      loading,
      error,
    }),
    [error, loading, restoring, session],
  );

  return { authState, signInWithGoogle, signInWithApple, sendEmailOtp, verifyEmailOtp, sendPhoneOtp, verifyPhoneOtp, signOut };
}
