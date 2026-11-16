import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { normalizePublicApiBaseUrl } from '../billing/mobileCheckout';

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

export type AccountPrivacyErrorReason = 'missing_api_base' | 'unauthenticated' | 'unavailable';

export type MobileAccountExportArtifact = {
  kind: 'account_data_export';
  fileName: string;
  contentType: 'application/json';
  generatedAt: string;
  sha256: string;
  bundle: Record<string, unknown>;
};

export type MobileAccountDeletionConfirmation = {
  message: string;
  deletionRequestId: string;
  status: string;
  teardownBy: string;
  authAccountDeleted: true;
  authAccountDeletedAt: string;
};

export type AccountExportResult =
  | { export: MobileAccountExportArtifact }
  | { error: { reason: AccountPrivacyErrorReason; message: string } };

export type AccountDeletionResult =
  | { deletion: MobileAccountDeletionConfirmation }
  | { error: { reason: AccountPrivacyErrorReason; message: string } };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AccountPrivacyRequestOptions = {
  apiBaseUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

const ACCOUNT_EXPORT_PATH = '/api/account/export';
const ACCOUNT_DELETE_PATH = '/api/account/delete';
const MOBILE_ACCOUNT_PRIVACY_TOKEN_REFRESH_SKEW_SECONDS = 60;
export const MOBILE_ACCOUNT_PRIVACY_REQUEST_TIMEOUT_MS = 15000;

const expoPublicSidekickApiBaseUrl =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

export const mobileAccountPrivacyApiBaseUrl = normalizePublicApiBaseUrl(expoPublicSidekickApiBaseUrl);

function mobileSessionNeedsRefresh(session: { expires_at?: number | null } | null | undefined): boolean {
  if (!session || typeof session.expires_at !== 'number') return true;
  const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_ACCOUNT_PRIVACY_TOKEN_REFRESH_SKEW_SECONDS;
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
      // The response handling below converts stale/missing auth into a safe sign-in recovery message.
    }
  }

  return nonEmptyString(session?.access_token);
}

async function getMobileAccessToken(client: MobileSessionClient | null | undefined): Promise<string | null> {
  if (!client && !mobileSupabase) return null;

  let accessToken: string | null = null;
  try {
    accessToken = client
      ? await getFreshAccessTokenFromClient(client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }

  return accessToken ?? getRememberedMobileAccessToken();
}

async function withMobileAccountPrivacyTimeout<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs = MOBILE_ACCOUNT_PRIVACY_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller?.abort();
      reject(new Error('mobile_account_privacy_timeout'));
    }, timeoutMs);

    operation(controller?.signal)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

async function postAccountPrivacyEndpoint(
  path: typeof ACCOUNT_EXPORT_PATH | typeof ACCOUNT_DELETE_PATH,
  options: AccountPrivacyRequestOptions,
): Promise<Response | AccountExportResult | AccountDeletionResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileAccountPrivacyApiBaseUrl);
  if (!apiBaseUrl) return accountPrivacyError('missing_api_base');

  const accessToken = await getMobileAccessToken(options.client);
  if (!accessToken) return accountPrivacyError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  try {
    return await withMobileAccountPrivacyTimeout((signal) => fetcher(buildAccountPrivacyUrl(apiBaseUrl, path), {
      method: 'POST',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
    }));
  } catch {
    return accountPrivacyError('unavailable');
  }
}

export async function requestAccountExport(options: AccountPrivacyRequestOptions = {}): Promise<AccountExportResult> {
  const response = await postAccountPrivacyEndpoint(ACCOUNT_EXPORT_PATH, options);
  if (!isResponse(response)) return response as AccountExportResult;

  if (response.status === 401) return accountPrivacyError('unauthenticated');
  if (!response.ok) return accountPrivacyError('unavailable');

  const payload = await response.json().catch(() => null);
  const artifact = parseAccountExportArtifact(payload);
  if (!artifact) return accountPrivacyError('unavailable');
  return { export: artifact };
}

export async function requestAccountDeletion(options: AccountPrivacyRequestOptions = {}): Promise<AccountDeletionResult> {
  const response = await postAccountPrivacyEndpoint(ACCOUNT_DELETE_PATH, options);
  if (!isResponse(response)) return response as AccountDeletionResult;

  if (response.status === 401) return accountPrivacyError('unauthenticated');
  if (!response.ok) return accountPrivacyError('unavailable');

  const payload = await response.json().catch(() => null);
  const deletion = parseAccountDeletionConfirmation(payload);
  if (!deletion) return accountPrivacyError('unavailable');
  return { deletion };
}

export function buildAccountPrivacyUrl(apiBaseUrl: string, path: typeof ACCOUNT_EXPORT_PATH | typeof ACCOUNT_DELETE_PATH): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${path}`;
}

function parseAccountExportArtifact(payload: unknown): MobileAccountExportArtifact | null {
  if (!isRecord(payload) || !isRecord(payload.artifact)) return null;
  const artifact = payload.artifact;
  if (artifact.kind !== 'account_data_export') return null;
  if (artifact.contentType !== 'application/json') return null;
  const fileName = boundedText(artifact.fileName, 180);
  const generatedAt = boundedText(artifact.generatedAt, 64);
  const sha256 = boundedText(artifact.sha256, 64);
  if (!fileName || !generatedAt || !sha256 || !isRecord(artifact.bundle)) return null;
  if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
  if (Number.isNaN(new Date(generatedAt).getTime())) return null;
  return {
    kind: 'account_data_export',
    fileName,
    contentType: 'application/json',
    generatedAt,
    sha256,
    bundle: artifact.bundle,
  };
}

function parseAccountDeletionConfirmation(payload: unknown): MobileAccountDeletionConfirmation | null {
  if (!isRecord(payload)) return null;
  if (payload.ok !== true) return null;
  if (!isRecord(payload.deletionRequest) || !isRecord(payload.authAccount)) return null;
  if (payload.authAccount.deleted !== true) return null;
  const message = boundedText(payload.message, 220);
  const deletionRequestId = boundedText(payload.deletionRequest.id, 120);
  const status = boundedText(payload.deletionRequest.status, 40);
  const teardownBy = boundedText(payload.deletionRequest.teardownBy, 64);
  const authAccountDeletedAt = boundedText(payload.authAccount.deletedAt, 64);
  if (!message || !deletionRequestId || !status || !teardownBy || !authAccountDeletedAt) return null;
  if (Number.isNaN(new Date(teardownBy).getTime())) return null;
  if (Number.isNaN(new Date(authAccountDeletedAt).getTime())) return null;
  return {
    message,
    deletionRequestId,
    status,
    teardownBy,
    authAccountDeleted: true,
    authAccountDeletedAt,
  };
}

function accountPrivacyError(reason: AccountPrivacyErrorReason): { error: { reason: AccountPrivacyErrorReason; message: string } } {
  const message: Record<AccountPrivacyErrorReason, string> = {
    missing_api_base: 'Account privacy actions need the app link before they can start.',
    unauthenticated: 'Sign in again before changing account privacy settings.',
    unavailable: 'Account privacy actions are temporarily unavailable. Try again in a moment.',
  };

  return { error: { reason, message: message[reason] } };
}

function isResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = nonEmptyString(value);
  if (!text || text.length > maxLength) return null;
  return text;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
