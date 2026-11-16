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

export type TelegramConnectErrorReason = 'missing_api_base' | 'unauthenticated' | 'unavailable';

export type TelegramConnectCode = {
  gatewayId: 'telegram';
  code: string;
  startParameter: string;
  expiresAt: string;
  instructions: string;
  deepLink: string | null;
  botUsername: string | null;
};

export type TelegramConnectCodeResult =
  | { connection: TelegramConnectCode }
  | { error: { reason: TelegramConnectErrorReason; message: string } };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TelegramConnectRequestOptions = {
  apiBaseUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

const CONNECT_CODE_PATH = '/api/gateways/telegram/connect-code';
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

export async function requestTelegramConnectCode(options: TelegramConnectRequestOptions = {}): Promise<TelegramConnectCodeResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
  if (!apiBaseUrl) return telegramConnectError('missing_api_base');

  if (!options.client && !mobileSupabase) return telegramConnectError('unauthenticated');

  let accessToken: string | null = null;
  try {
    accessToken = options.client
      ? await getFreshAccessTokenFromClient(options.client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }

  accessToken = accessToken ?? getRememberedMobileAccessToken();

  if (!accessToken) return telegramConnectError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(buildTelegramConnectCodeUrl(apiBaseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': SIDEKICK_MOBILE_USER_AGENT,
        authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
    });

    if (!response.ok) {
      return telegramConnectError(response.status === 401 ? 'unauthenticated' : 'unavailable');
    }

    const payload = await response.json().catch(() => null);
    const connection = parseTelegramConnectResponse(payload);
    if (!connection) return telegramConnectError('unavailable');
    return { connection };
  } catch {
    return telegramConnectError('unavailable');
  }
}

export function buildTelegramConnectCodeUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${CONNECT_CODE_PATH}`;
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

function parseTelegramConnectResponse(payload: unknown): TelegramConnectCode | null {
  if (!isRecord(payload)) return null;
  if (payload.gatewayId !== 'telegram') return null;

  const code = boundedText(payload.code, 24);
  const startParameter = boundedText(payload.startParameter, 32);
  const expiresAt = boundedText(payload.expiresAt, 48);
  const instructions = boundedText(payload.instructions, 180);
  if (!code || !startParameter || !expiresAt || !instructions) return null;
  if (!/^TG\s[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)) return null;
  if (!/^TG[A-Z0-9]{6}$/.test(startParameter)) return null;
  if (Number.isNaN(new Date(expiresAt).getTime())) return null;

  return {
    gatewayId: 'telegram',
    code,
    startParameter,
    expiresAt,
    instructions,
    deepLink: safeTelegramDeepLink(payload.deepLink),
    botUsername: safeBotUsername(payload.botUsername),
  };
}

function telegramConnectError(reason: TelegramConnectErrorReason): TelegramConnectCodeResult {
  const message: Record<TelegramConnectErrorReason, string> = {
    missing_api_base: 'Telegram connection needs the app link before it can start.',
    unauthenticated: 'Sign in again, then connect Telegram.',
    unavailable: 'Telegram connection isn’t ready. Try again in a moment.',
  };

  return { error: { reason, message: message[reason] } };
}

function safeTelegramDeepLink(value: unknown): string | null {
  const raw = boundedText(value, 120);
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.hostname !== 't.me') return null;
    if (!parsed.searchParams.get('start')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeBotUsername(value: unknown): string | null {
  const raw = boundedText(value, 40);
  if (!raw) return null;
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(raw) ? raw : null;
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

function isLocalDevelopmentHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const secondOctet = Number.parseInt(match[1], 10);
  return secondOctet >= 16 && secondOctet <= 31;
}
