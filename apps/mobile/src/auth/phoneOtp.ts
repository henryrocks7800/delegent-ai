import {
  AUTH_PROVIDER_PHONE,
  maskE164PhoneNumber,
  normalizeE164PhoneNumber,
  normalizeOtpCode,
  type AuthSessionError,
  type PublicAuthSession,
} from '@sidekick/shared';
import { mobileSupabaseConfig } from './publicSupabase';
import { mapSupabaseSessionToPublicSession, mobileSupabase, rememberMobileSupabaseSession } from './supabaseClient';

export type PhoneOtpSendResult =
  | { ok: true; phoneMasked: string }
  | { ok: false; error: AuthSessionError };

export type PhoneOtpVerifyResult =
  | { ok: true; session: PublicAuthSession }
  | { ok: false; error: AuthSessionError };

function phoneAuthError(code: AuthSessionError['code'], message: string): { ok: false; error: AuthSessionError } {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      provider: AUTH_PROVIDER_PHONE,
    },
  };
}

function missingConfigError(): { ok: false; error: AuthSessionError } {
  return phoneAuthError('missing_config', 'Phone sign-in needs setup before it can send codes.');
}

function normalizePublicPhone(rawPhone: string): { phone: string; phoneMasked: string } | { error: AuthSessionError } {
  try {
    const phone = normalizeE164PhoneNumber(rawPhone);
    return { phone, phoneMasked: maskE164PhoneNumber(phone) };
  } catch {
    return { error: phoneAuthError('phone_otp_invalid', 'Enter a full phone number with country code, for example +447700900123.').error };
  }
}

function normalizePublicCode(rawCode: string): string | { error: AuthSessionError } {
  try {
    return normalizeOtpCode(rawCode);
  } catch {
    return { error: phoneAuthError('phone_otp_invalid', 'Enter the six-digit code from your text message.').error };
  }
}

export async function sendPhoneOtp(rawPhone: string): Promise<PhoneOtpSendResult> {
  if (!mobileSupabaseConfig.ready || !mobileSupabase) return missingConfigError();

  const normalized = normalizePublicPhone(rawPhone);
  if ('error' in normalized) return { ok: false, error: normalized.error };

  const { phone, phoneMasked } = normalized;
  try {
    const { error } = await mobileSupabase.auth.signInWithOtp({ phone });
    if (error) return phoneAuthError('phone_otp_failed', 'We could not send that code. Please check the number and try again.');
  } catch {
    return phoneAuthError('phone_otp_failed', 'We could not send that code. Please check the number and try again.');
  }

  return { ok: true, phoneMasked };
}

export async function verifyPhoneOtp(rawPhone: string, rawCode: string): Promise<PhoneOtpVerifyResult> {
  if (!mobileSupabaseConfig.ready || !mobileSupabase) return missingConfigError();

  const normalized = normalizePublicPhone(rawPhone);
  if ('error' in normalized) return { ok: false, error: normalized.error };

  const token = normalizePublicCode(rawCode);
  if (typeof token !== 'string') return { ok: false, error: token.error };

  let data;
  try {
    const response = await mobileSupabase.auth.verifyOtp({
      phone: normalized.phone,
      token,
      type: 'sms',
    });
    if (response.error) return phoneAuthError('phone_otp_failed', 'That code did not work. Please request a new one or try again.');
    data = response.data;
  } catch {
    return phoneAuthError('phone_otp_failed', 'That code did not work. Please request a new one or try again.');
  }

  rememberMobileSupabaseSession(data.session ?? null);
  const publicSession = mapSupabaseSessionToPublicSession(data.session);
  if (!publicSession) return phoneAuthError('session_restore_failed', 'Phone sign-in finished, but the account could not be loaded. Please try again.');

  return { ok: true, session: publicSession };
}
