// Feature 3 — "Update my coworker" client. POSTs to the Worker's
// /api/coworker/update with the user's Supabase JWT; the Worker queues a
// volume-preserving re-image onto the latest vetted golden image. Mirrors the
// messaging-disconnect client (token acquisition + API-base validation reused).
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/messagingConnection';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CoworkerUpdateErrorReason = 'missing_api_base' | 'unauthenticated' | 'no_live_coworker' | 'unavailable';

export type CoworkerUpdateResult =
  | { update: { kind: 'update_queued'; message: string } }
  | { error: { reason: CoworkerUpdateErrorReason; message: string } };

export type CoworkerUpdateRequestOptions = {
  apiBaseUrl?: string | null;
  /** Tests inject a token directly to skip the Supabase client. */
  accessToken?: string | null;
  fetchImpl?: FetchLike;
};

const COWORKER_UPDATE_PATH = '/api/coworker/update';
const SIDEKICK_MOBILE_USER_AGENT = 'SidekickMobile/1.0 (Android)';

export function buildCoworkerUpdateUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${COWORKER_UPDATE_PATH}`;
}

export async function requestCoworkerUpdate(options: CoworkerUpdateRequestOptions = {}): Promise<CoworkerUpdateResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
  if (!apiBaseUrl) return coworkerUpdateError('missing_api_base');

  let accessToken: string | null = nonEmptyString(options.accessToken);
  if (!accessToken) {
    if (!mobileSupabase) return coworkerUpdateError('unauthenticated');
    try {
      accessToken = await getFreshMobileAccessToken(mobileSupabase);
    } catch {
      accessToken = null;
    }
    accessToken = accessToken ?? getRememberedMobileAccessToken();
  }
  if (!accessToken) return coworkerUpdateError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(buildCoworkerUpdateUrl(apiBaseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': SIDEKICK_MOBILE_USER_AGENT,
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return coworkerUpdateError(
        response.status === 401 ? 'unauthenticated' : response.status === 409 ? 'no_live_coworker' : 'unavailable',
      );
    }

    const payload = await response.json().catch(() => null);
    const parsed = parseCoworkerUpdateResponse(payload);
    if (!parsed) return coworkerUpdateError('unavailable');
    return { update: parsed };
  } catch {
    return coworkerUpdateError('unavailable');
  }
}

function parseCoworkerUpdateResponse(payload: unknown): { kind: 'update_queued'; message: string } | null {
  if (!isRecord(payload) || payload.ok !== true || payload.kind !== 'update_queued') return null;
  return {
    kind: 'update_queued',
    message: boundedText(payload.publicMessage, 200)
      ?? 'Update started. Your coworker will be back in a moment on the latest build, and your files stay exactly where they are.',
  };
}

function coworkerUpdateError(reason: CoworkerUpdateErrorReason): CoworkerUpdateResult {
  const message: Record<CoworkerUpdateErrorReason, string> = {
    missing_api_base: 'The app link is missing, so the update cannot start yet.',
    unauthenticated: 'Sign in again, then start the update.',
    no_live_coworker: 'Your coworker is not online yet, so there is nothing to update right now.',
    unavailable: 'The update could not start. Try again in a moment.',
  };
  return { error: { reason, message: message[reason] } };
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = nonEmptyString(value);
  if (!text || text.length > maxLength) return null;
  return text;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
