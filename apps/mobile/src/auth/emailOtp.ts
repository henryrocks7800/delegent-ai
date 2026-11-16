import {
  AUTH_PROVIDER_EMAIL,
  normalizeEmailAddress,
  normalizeOtpCode,
  type AuthSessionError,
  type PublicAuthSession,
} from '@sidekick/shared';
import { mobileSupabaseConfig } from './publicSupabase';
import { mapSupabaseSessionToPublicSession, mobileSupabase, rememberMobileSupabaseSession } from './supabaseClient';

export type EmailOtpSendResult =
  | { ok: true; email: string }
  | { ok: false; error: AuthSessionError };

export type EmailOtpVerifyResult =
  | { ok: true; session: PublicAuthSession }
  | { ok: false; error: AuthSessionError };

function emailAuthError(code: AuthSessionError['code'], message: string): { ok: false; error: AuthSessionError } {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      provider: AUTH_PROVIDER_EMAIL,
    },
  };
}

function missingConfigError(): { ok: false; error: AuthSessionError } {
  return emailAuthError('missing_config', 'Email sign-in needs setup before it can send codes.');
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('code' in error || 'status' in error) &&
    ((error as { code?: unknown }).code === 'over_email_send_rate_limit' || (error as { status?: unknown }).status === 429)
  );
}

function sendFailureMessage(error: unknown): string {
  if (isRateLimitError(error)) return 'Too many sign-in emails were requested. Please wait a minute and try again.';
  return 'We could not send that sign-in email. Please check the address and try again.';
}

function normalizePublicEmail(rawEmail: string): string | { error: AuthSessionError } {
  try {
    return normalizeEmailAddress(rawEmail);
  } catch {
    return { error: emailAuthError('email_otp_invalid', 'Enter a valid email address.').error };
  }
}

function normalizePublicCode(rawCode: string): string | { error: AuthSessionError } {
  try {
    return normalizeOtpCode(rawCode, 8);
  } catch {
    return { error: emailAuthError('email_otp_invalid', 'Enter the eight-digit code from your email.').error };
  }
}

export async function sendEmailOtp(rawEmail: string): Promise<EmailOtpSendResult> {
  const email = normalizePublicEmail(rawEmail);
  if (typeof email !== 'string') return { ok: false, error: email.error };

  if (!mobileSupabaseConfig.ready || !mobileSupabase) return missingConfigError();

  try {
    const { error } = await mobileSupabase.auth.signInWithOtp({
      email: email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: mobileSupabaseConfig.config.redirectTo,
      },
    });
    if (error) return emailAuthError('email_otp_failed', sendFailureMessage(error));
  } catch {
    return emailAuthError('email_otp_failed', 'We could not send that sign-in email. Please check the address and try again.');
  }

  return { ok: true, email };
}

export async function verifyEmailOtp(rawEmail: string, rawCode: string): Promise<EmailOtpVerifyResult> {
  const email = normalizePublicEmail(rawEmail);
  if (typeof email !== 'string') return { ok: false, error: email.error };

  const token = normalizePublicCode(rawCode);
  if (typeof token !== 'string') return { ok: false, error: token.error };

  if (!mobileSupabaseConfig.ready || !mobileSupabase) return missingConfigError();

  let data;
  try {
    const response = await mobileSupabase.auth.verifyOtp({
      email: email,
      token: token,
      type: 'email',
    });
    if (response.error) return emailAuthError('email_otp_failed', 'That code did not work. Please request a new one or try again.');
    data = response.data;
  } catch {
    return emailAuthError('email_otp_failed', 'That code did not work. Please request a new one or try again.');
  }

  rememberMobileSupabaseSession(data.session ?? null);
  const publicSession = mapSupabaseSessionToPublicSession(data.session);
  if (!publicSession) return emailAuthError('session_restore_failed', 'Email sign-in finished, but the account could not be loaded. Please try again.');

  return { ok: true, session: publicSession };
}
