import { getFreshMobileSupabaseSession, mobileSupabase } from '../auth/supabaseClient';
import { normalizeAgentName } from '../onboarding/mobileOnboarding';

export type MobileProfileUpdateInput = {
  displayName: string;
  agentName: string;
  region: string;
};

export type MobileProfileUpdate = {
  displayName: string;
  agentName: string;
  region: string;
};

export type MobileProfileUpdateErrorReason = 'invalid_profile' | 'unauthenticated' | 'unavailable';

export type MobileProfileUpdateResult =
  | { ok: true; profile: MobileProfileUpdate }
  | { error: { reason: MobileProfileUpdateErrorReason; message: string } };

const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_REGION_LENGTH = 80;

export function normalizeProfileUpdate(input: MobileProfileUpdateInput): MobileProfileUpdate | null {
  const displayName = normalizeTextField(input.displayName, MAX_DISPLAY_NAME_LENGTH);
  const agentName = normalizeAgentName(input.agentName);
  const region = normalizeTextField(input.region, MAX_REGION_LENGTH) ?? 'United Kingdom';

  if (!displayName || !agentName) return null;

  return { displayName, agentName, region };
}

export async function updateMobileProfile(input: MobileProfileUpdateInput): Promise<MobileProfileUpdateResult> {
  const profile = normalizeProfileUpdate(input);
  if (!profile) return profileUpdateError('invalid_profile');
  if (!mobileSupabase) return profileUpdateError('unauthenticated');

  try {
    const session = await getFreshMobileSupabaseSession(mobileSupabase);
    if (!session) return profileUpdateError('unauthenticated');

    const result = await mobileSupabase.rpc('update_mobile_profile', {
      p_full_name: profile.displayName,
      p_agent_name: profile.agentName,
      p_region: profile.region,
    });

    if (result.error) return profileUpdateError('unavailable');
    return { ok: true, profile };
  } catch {
    return profileUpdateError('unavailable');
  }
}

function normalizeTextField(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length < 2 || normalized.length > maxLength) return null;
  if (!/[A-Za-z0-9]/.test(normalized)) return null;
  return normalized;
}

function profileUpdateError(reason: MobileProfileUpdateErrorReason): MobileProfileUpdateResult {
  const message: Record<MobileProfileUpdateErrorReason, string> = {
    invalid_profile: 'Check the editable profile fields and try again.',
    unauthenticated: 'Sign in again, then update your profile.',
    unavailable: 'Couldn’t save your profile. Try again in a moment.',
  };

  return { error: { reason, message: message[reason] } };
}
