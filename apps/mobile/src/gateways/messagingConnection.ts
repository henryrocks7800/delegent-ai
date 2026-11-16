import { isMessagingProviderId, publicMessagingProviderLabel, type MessagingProviderId } from '@sidekick/shared';
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';


declare const process: {
  env: Record<string, string | undefined>;
};

type MobileSessionClient = {
  auth: {
    getSession(): Promise<{
      data?: {
        session?: {
          access_token?: string | null;
          expires_at?: number | null;
        } | null;
      } | null;
      error?: unknown;
    }>;
    refreshSession?(): Promise<{
      data?: {
        session?: {
          access_token?: string | null;
          expires_at?: number | null;
        } | null;
      } | null;
      error?: unknown;
    }>;
  };
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MessagingDisconnectErrorReason = 'missing_api_base' | 'unauthenticated' | 'unsupported_messenger' | 'unavailable';

export type MessagingDisconnectResult =
  | {
      disconnect: {
        providerId: MessagingProviderId | null;
        kind: 'disconnected' | 'already_disconnected';
        message: string;
      };
    }
  | { error: { reason: MessagingDisconnectErrorReason; message: string } };

export type MessagingDisconnectRequestOptions = {
  providerId?: MessagingProviderId | null;
  apiBaseUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

const DISCONNECT_PATH = '/api/gateways/messaging/disconnect';
const SIDEKICK_MOBILE_USER_AGENT = 'SidekickMobile/1.0 (Android)';
const MOBILE_CONNECT_TOKEN_REFRESH_SKEW_SECONDS = 60;

// Expo statically inlines direct `process.env.EXPO_PUBLIC_*` reads into the
// native JS bundle, so keep this as a direct member read instead of aliasing the
// env object.
const expoPublicSidekickApiBaseUrl =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

export const mobileSidekickApiBaseUrl = normalizePublicApiBaseUrl(expoPublicSidekickApiBaseUrl);

function mobileSessionNeedsRefresh(session: { expires_at?: number | null } | null | undefined): boolean {
  if (!session || typeof session.expires_at !== 'number') return true;
  const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_CONNECT_TOKEN_REFRESH_SKEW_SECONDS;
}

async function getFreshAccessTokenFromClient(client: MobileSessionClient): Promise<string | null> {
  let session: { access_token?: string | null; expires_at?: number | null } | null = null;
  try {
    const current = await client.auth.getSession();
    if (!current.error) session = current.data?.session ?? null;
  } catch {
    session = null;
  }

  if (mobileSessionNeedsRefresh(session) && client.auth.refreshSession) {
    try {
      const refreshed = await client.auth.refreshSession();
      if (!refreshed.error) session = refreshed.data?.session ?? session;
    } catch {
      // Keep the current session if refresh fails; the server 401 path below
      // still converts an expired token into a sign-in recovery message.
    }
  }

  return nonEmptyString(session?.access_token);
}

export async function requestMessagingProviderDisconnect(options: MessagingDisconnectRequestOptions = {}): Promise<MessagingDisconnectResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
  if (!apiBaseUrl) return messagingDisconnectError('missing_api_base', options.providerId);

  if (!options.client && !mobileSupabase) return messagingDisconnectError('unauthenticated', options.providerId);

  let accessToken: string | null = null;
  try {
    accessToken = options.client
      ? await getFreshAccessTokenFromClient(options.client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }

  accessToken = accessToken ?? getRememberedMobileAccessToken();

  if (!accessToken) return messagingDisconnectError('unauthenticated', options.providerId);

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(buildMessagingDisconnectUrl(apiBaseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': SIDEKICK_MOBILE_USER_AGENT,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ providerId: options.providerId ?? null }),
    });

    if (!response.ok) {
      return messagingDisconnectError(
        response.status === 401 ? 'unauthenticated' : response.status === 400 ? 'unsupported_messenger' : 'unavailable',
        options.providerId,
      );
    }

    const payload = await response.json().catch(() => null);
    const disconnect = parseMessagingDisconnectResponse(payload, options.providerId);
    if (!disconnect) return messagingDisconnectError('unavailable', options.providerId);
    return { disconnect };
  } catch {
    return messagingDisconnectError('unavailable', options.providerId);
  }
}

export function buildMessagingDisconnectUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${DISCONNECT_PATH}`;
}

export function normalizePublicApiBaseUrl(raw: string | null | undefined): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.protocol === 'https:') return parsed.origin;
    if (parsed.protocol === 'http:' && isLocalDevelopmentHost(parsed.hostname)) return parsed.origin;
    return null;
  } catch {
    return null;
  }
}

function parseMessagingDisconnectResponse(
  payload: unknown,
  requestedProviderId: MessagingProviderId | null | undefined,
): { providerId: MessagingProviderId | null; kind: 'disconnected' | 'already_disconnected'; message: string } | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  const providerId = isMessagingProviderId(payload.providerId) ? payload.providerId : null;
  const kind = payload.kind === 'disconnected' ? 'disconnected' : payload.kind === 'already_disconnected' ? 'already_disconnected' : null;
  if (!kind) return null;

  const fallbackProviderId = providerId ?? requestedProviderId ?? null;
  const fallbackMessage = kind === 'already_disconnected'
    ? fallbackProviderId
      ? `${publicMessagingProviderLabel(fallbackProviderId)} is already disconnected.`
      : 'No messenger is connected right now.'
    : `${publicMessagingProviderLabel(providerId ?? requestedProviderId ?? 'telegram')} is disconnected. You can reconnect it whenever you are ready.`;

  return {
    providerId,
    kind,
    message: boundedText(payload.publicMessage, 180) ?? fallbackMessage,
  };
}

function messagingDisconnectError(reason: MessagingDisconnectErrorReason, providerId: MessagingProviderId | null | undefined): MessagingDisconnectResult {
  const label = providerId ? publicMessagingProviderLabel(providerId) : 'Messenger';
  const message: Record<MessagingDisconnectErrorReason, string> = {
    missing_api_base: `${label} disconnect needs the app link before it can start.`,
    unauthenticated: 'Sign in again, then update your connection.',
    unsupported_messenger: 'That messenger is not ready to manage yet.',
    unavailable: `${label} could not disconnect. Try again in a moment.`,
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

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '10.0.2.2'
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
