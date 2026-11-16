import { ACKNOWLEDGEMENT_VERSION } from '@sidekick/shared';
import { getFreshMobileSupabaseSession, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSupabaseConfig } from '../auth/publicSupabase';

export type MobileOnboardingErrorReason = 'invalid_name' | 'unauthenticated' | 'unavailable';

export type MobileOnboardingResult =
  | { ok: true; agentName: string }
  | { error: { reason: MobileOnboardingErrorReason; message: string } };

const DEFAULT_AGENT_NAME = 'Nova';
const MAX_AGENT_NAME_LENGTH = 40;

export function normalizeAgentName(input: string | null | undefined): string | null {
  const normalized = input?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length === 0) return null;
  if (normalized.length > MAX_AGENT_NAME_LENGTH) return null;
  if (!/[A-Za-z]/.test(normalized)) return null;
  return normalized;
}

export function defaultAgentName(): string {
  return DEFAULT_AGENT_NAME;
}

export async function completeMobileOnboarding(rawAgentName: string): Promise<MobileOnboardingResult> {
  const agentName = normalizeAgentName(rawAgentName);
  if (!agentName) return onboardingError('invalid_name');
  if (!mobileSupabase) return onboardingError('unauthenticated');

  try {
    const rememberedAccessToken = getRememberedMobileAccessToken();
    const session = await getFreshMobileSupabaseSession(mobileSupabase);
    const accessToken = session?.access_token ?? rememberedAccessToken;
    if (!accessToken) return onboardingError('unauthenticated');

    if (session) {
      const result = await mobileSupabase.rpc('complete_mobile_onboarding', {
        p_agent_name: agentName,
        p_acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
      });

      if (result.error) return onboardingError('unavailable');
      return { ok: true, agentName };
    }

    return completeMobileOnboardingWithAccessToken(agentName, accessToken);
  } catch {
    return onboardingError('unavailable');
  }
}

async function completeMobileOnboardingWithAccessToken(agentName: string, accessToken: string): Promise<MobileOnboardingResult> {
  if (!mobileSupabaseConfig.ready) return onboardingError('unauthenticated');

  const response = await fetch(`${mobileSupabaseConfig.config.url}/rest/v1/rpc/complete_mobile_onboarding`, {
    method: 'POST',
    headers: {
      apikey: mobileSupabaseConfig.config.anonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_agent_name: agentName,
      p_acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    }),
  });

  if (response.status === 401 || response.status === 403) return onboardingError('unauthenticated');
  if (!response.ok) return onboardingError('unavailable');
  return { ok: true, agentName };
}

function onboardingError(reason: MobileOnboardingErrorReason): MobileOnboardingResult {
  const message: Record<MobileOnboardingErrorReason, string> = {
    invalid_name: 'Choose a short coworker name before continuing.',
    unauthenticated: 'Sign in again, then finish setup.',
    unavailable: 'Couldn’t save setup. Try again in a moment.',
  };

  return { error: { reason, message: message[reason] } };
}
