import { apiBaseUrl, apiReady } from '../../lib/env';
import { getFreshAccessToken, supabase } from '../../lib/supabase';

// The same `update_mobile_profile` RPC the phone app calls, with the same
// normalisation rules. Those rules live in apps/mobile/src/profile/mobileProfile.ts
// and apps/mobile/src/onboarding/mobileOnboarding.ts, which cannot be imported
// here because they pull in the React Native Supabase client. test/profile.test.mjs
// pins the rules to the mobile source so the two cannot drift silently.

export type ProfileDraft = { displayName: string; agentName: string; region: string };

export type ProfileUpdateResult = { ok: true; profile: ProfileDraft } | { ok: false; message: string };

const MAX_NAME_LENGTH = 80;
const MAX_AGENT_NAME_LENGTH = 40;
const DEFAULT_REGION = 'United Kingdom';

export function normalizeTextField(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length < 2 || normalized.length > maxLength) return null;
  if (!/[A-Za-z0-9]/.test(normalized)) return null;
  return normalized;
}

export function normalizeAgentName(input: string | null | undefined): string | null {
  const normalized = input?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length === 0) return null;
  if (normalized.length > MAX_AGENT_NAME_LENGTH) return null;
  if (!/[A-Za-z]/.test(normalized)) return null;
  return normalized;
}

export function normalizeProfileDraft(draft: ProfileDraft): ProfileDraft | null {
  const displayName = normalizeTextField(draft.displayName, MAX_NAME_LENGTH);
  const agentName = normalizeAgentName(draft.agentName);
  const region = normalizeTextField(draft.region, MAX_NAME_LENGTH) ?? DEFAULT_REGION;
  if (!displayName || !agentName) return null;
  return { displayName, agentName, region };
}

export async function updateProfile(draft: ProfileDraft): Promise<ProfileUpdateResult> {
  const profile = normalizeProfileDraft(draft);
  if (!profile) {
    return { ok: false, message: 'Check your name and your coworker’s name, then try again.' };
  }

  if (!supabase) return { ok: false, message: 'Sign in again, then update your profile.' };

  try {
    const { error } = await supabase.rpc('update_mobile_profile', {
      p_full_name: profile.displayName,
      p_agent_name: profile.agentName,
      p_region: profile.region,
    });
    if (error) return { ok: false, message: 'We could not save your profile. Try again in a moment.' };
    return { ok: true, profile };
  } catch {
    return { ok: false, message: 'We could not save your profile. Try again in a moment.' };
  }
}

/**
 * Request account deletion.
 *
 * Restored to the web app on 2026-08-16 alongside the mobile control. The
 * endpoint SCHEDULES teardown within 24 hours rather than erasing on click,
 * which is why the copy promises a request rather than an instant wipe.
 *
 * Same endpoint the mobile app calls (POST /api/account/delete), so the two
 * surfaces cannot drift into different behaviour.
 */
export type AccountDeletionRequestResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function requestAccountDeletion(): Promise<AccountDeletionRequestResult> {
  if (!apiReady) {
    return { ok: false, message: 'Account deletion is unavailable right now. Email admin@example.com and we will action it.' };
  }
  const token = await getFreshAccessToken();
  if (!token) return { ok: false, message: 'Sign in again, then request deletion.' };

  try {
    const response = await fetch(`${apiBaseUrl}/api/account/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (response.status === 401) return { ok: false, message: 'Sign in again, then request deletion.' };
    if (!response.ok) {
      return { ok: false, message: 'We could not send that request. Try again shortly, or email admin@example.com.' };
    }
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof payload?.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Request received. Your account and workspace will be deleted within 24 hours.';
    return { ok: true, message };
  } catch {
    return { ok: false, message: 'We could not send that request. Check your connection, or email admin@example.com.' };
  }
}

/**
 * Request a copy of your data.
 *
 * Sits beside deletion because portability and erasure are the same right in
 * UK GDPR terms, and a delete-only screen quietly drops the gentler option
 * most people want first. The browser gets the bundle as a download rather
 * than a share sheet, which is the native idiom here.
 */
export type AccountExportRequestResult =
  | { ok: true; fileName: string }
  | { ok: false; message: string };

export async function requestAccountExport(): Promise<AccountExportRequestResult> {
  if (!apiReady) {
    return { ok: false, message: 'Data export is unavailable right now. Email admin@example.com and we will send it.' };
  }
  const token = await getFreshAccessToken();
  if (!token) return { ok: false, message: 'Sign in again, then request your data.' };

  try {
    const response = await fetch(`${apiBaseUrl}/api/account/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (response.status === 401) return { ok: false, message: 'Sign in again, then request your data.' };
    if (!response.ok) {
      return { ok: false, message: 'We could not prepare that export. Try again shortly, or email admin@example.com.' };
    }
    const payload = (await response.json().catch(() => null)) as { artifact?: { fileName?: unknown; bundle?: unknown } } | null;
    const bundle = payload?.artifact?.bundle;
    if (!bundle) return { ok: false, message: 'We could not prepare that export. Try again shortly.' };

    const fileName = typeof payload?.artifact?.fileName === 'string' && payload.artifact.fileName.trim()
      ? payload.artifact.fileName.trim()
      : 'delegent-export.json';

    // Trigger a download without leaving the page. The object URL is revoked
    // immediately after; leaking one pins the whole bundle in memory.
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    return { ok: true, fileName };
  } catch {
    return { ok: false, message: 'We could not prepare that export. Check your connection, or email admin@example.com.' };
  }
}
