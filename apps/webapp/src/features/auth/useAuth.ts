import { useEffect, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { normalizeEmailAddress, normalizeOtpCode } from '@sidekick/shared';
import { supabase, WEB_AUTH_STORAGE_KEY } from '../../lib/supabase';

export type WebAuthUser = {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
};

export type WebAuthState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed_out'; message?: string }
  | { status: 'signed_in'; user: WebAuthUser };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// Only https avatars are rendered. A user-controlled metadata field is
// otherwise an easy way to smuggle a javascript: or data: URL into an <img>.
function safeAvatarUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function mapSessionToUser(session: Session | null): WebAuthUser | null {
  const user = session?.user;
  const id = text(user?.id);
  if (!id) return null;
  const metadata = (user?.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id,
    email: text(user?.email) ?? 'signed-in account',
    fullName: text(metadata.full_name) ?? text(metadata.name),
    avatarUrl: safeAvatarUrl(metadata.avatar_url) ?? safeAvatarUrl(metadata.picture),
  };
}

const GOOGLE_RETURN_FAILED = 'We could not finish signing you in with Google. Please try again.';

/**
 * Finish a Google redirect, and return a message only if the reader is left
 * signed out.
 *
 * Supabase is told not to read the URL itself, so the exchange happens here,
 * once, and the code is cleared from the address bar straight after. A
 * reloaded or bookmarked callback URL carries a code that has already been
 * spent: the phone app learned that treating that as a failure signs a
 * perfectly good session out (PR #264), so if a session exists, keep it and say
 * nothing.
 */
async function completeOAuthRedirect(client: SupabaseClient): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const failed = params.get('error_description') ?? params.get('error');
  if (!code && !failed) return null;

  for (const key of ['code', 'state', 'error', 'error_description', 'error_code']) params.delete(key);
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);

  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return null;
  }
  const { data } = await client.auth.getSession();
  return data.session ? null : GOOGLE_RETURN_FAILED;
}

export function useAuth(): WebAuthState {
  const [state, setState] = useState<WebAuthState>(() =>
    supabase ? { status: 'loading' } : { status: 'unconfigured' },
  );

  useEffect(() => {
    const client = supabase;
    if (!client) return;

    let cancelled = false;
    let returnMessage: string | null = null;
    const apply = (session: Session | null) => {
      if (cancelled) return;
      const user = mapSessionToUser(session);
      if (user) setState({ status: 'signed_in', user });
      else setState(returnMessage ? { status: 'signed_out', message: returnMessage } : { status: 'signed_out' });
    };

    // The exchange has to settle before the first getSession, or a successful
    // Google return would flash the sign-in screen on the way in.
    void completeOAuthRedirect(client)
      .then((message) => {
        returnMessage = message;
        return client.auth.getSession();
      })
      .then(({ data }) => apply(data.session))
      // A rejection anywhere in that chain leaves status on 'loading', which is
      // a full-screen "Signing you in…" with nothing to press, for good. These
      // are raw supabase-js calls rather than apiFetch, so they really can
      // throw. Falling back to signed out puts the sign-in screen up instead,
      // and onAuthStateChange corrects it the moment a session does appear.
      .catch(() => apply(null));
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => apply(session));

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export type GoogleSignInResult = { ok: true } | { ok: false; message: string };

/**
 * Exchange a Google ID token for a Supabase session, exactly as
 * apps/mobile/src/auth/googleSignIn.ts does with the token from the native
 * picker. This is the path the reader normally takes: it never leaves our
 * origin, so Google's account picker names us rather than the Supabase host.
 */
export async function signInWithGoogleCredential(idToken: string): Promise<GoogleSignInResult> {
  if (!supabase) return { ok: false, message: 'Google sign-in needs setup before it can run.' };
  try {
    const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error || !data.session) return { ok: false, message: 'Google sign-in did not finish. Please try again.' };
  } catch {
    return { ok: false, message: 'Google sign-in did not finish. Please try again.' };
  }
  return { ok: true };
}

/**
 * The fallback, used only when Google's script cannot be reached at all. Hands
 * off through Supabase's redirect, which works everywhere but shows the reader
 * the Supabase host on the way through.
 */
export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  if (!supabase) return { ok: false, message: 'Google sign-in needs setup before it can run.' };
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) return { ok: false, message: 'We could not open Google sign-in. Please try again.' };
  } catch {
    return { ok: false, message: 'We could not open Google sign-in. Please try again.' };
  }
  return { ok: true };
}

export type SendCodeResult = { ok: true; email: string } | { ok: false; message: string };
export type VerifyCodeResult = { ok: true } | { ok: false; message: string };

function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: unknown }).status;
  return code === 'over_email_send_rate_limit' || status === 429;
}

/**
 * Send the eight-digit sign-in code. Deliberately mirrors
 * apps/mobile/src/auth/emailOtp.ts, including the copy, so a user who has both
 * surfaces open reads the same words.
 */
export async function sendSignInCode(rawEmail: string): Promise<SendCodeResult> {
  let email: string;
  try {
    email = normalizeEmailAddress(rawEmail);
  } catch {
    return { ok: false, message: 'Enter a valid email address.' };
  }

  if (!supabase) return { ok: false, message: 'Email sign-in needs setup before it can send codes.' };

  try {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) {
      return {
        ok: false,
        message: isRateLimited(error)
          ? 'Too many sign-in emails were requested. Please wait a minute and try again.'
          : 'We could not send that sign-in email. Please check the address and try again.',
      };
    }
  } catch {
    return { ok: false, message: 'We could not send that sign-in email. Please check the address and try again.' };
  }

  return { ok: true, email };
}

export async function verifySignInCode(rawEmail: string, rawCode: string): Promise<VerifyCodeResult> {
  let email: string;
  try {
    email = normalizeEmailAddress(rawEmail);
  } catch {
    return { ok: false, message: 'Enter a valid email address.' };
  }

  let token: string;
  try {
    token = normalizeOtpCode(rawCode, 8);
  } catch {
    return { ok: false, message: 'Enter the eight-digit code from your email.' };
  }

  if (!supabase) return { ok: false, message: 'Email sign-in needs setup before it can send codes.' };

  try {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error || !data.session) {
      return { ok: false, message: 'That code did not work. Please request a new one or try again.' };
    }
  } catch {
    return { ok: false, message: 'That code did not work. Please request a new one or try again.' };
  }

  return { ok: true };
}

/**
 * Everything the SDK persists for a session, under the storage key we chose.
 * The code verifier is the PKCE half of an interrupted sign-in and has no
 * business outliving a sign-out either.
 */
function clearPersistedWebSession(): void {
  for (const key of [WEB_AUTH_STORAGE_KEY, `${WEB_AUTH_STORAGE_KEY}-code-verifier`, `${WEB_AUTH_STORAGE_KEY}-user`]) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* a blocked store has nothing to clear */ }
  }
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  // ⚠️ NEITHER SCOPE CLEARS LOCALLY WHEN THE SERVER IS UNREACHABLE, and the
  // comment that used to sit here said scope:'local' only touched storage. In
  // the installed auth client both scopes call the server first and return
  // early on any error that is not a 401, 403 or 404. signOut() resolves with
  // { error } rather than throwing, so the try/catch caught nothing, the reply
  // was discarded, and someone could walk away from a shared machine with the
  // session still in localStorage and nothing on screen saying so. Reproduced
  // against the actual SDK on 2026-09-13.
  try {
    await supabase.auth.signOut();
  } catch {
    // Best effort. The clear below is what actually ends the session here.
  }
  // Ours, synchronous, no network in the path.
  clearPersistedWebSession();
  // With no access token left, scope:'local' skips its server call and reaches
  // _removeSession, which clears the client and notifies every subscriber.
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Best effort.
  }
  clearPersistedWebSession();
}
