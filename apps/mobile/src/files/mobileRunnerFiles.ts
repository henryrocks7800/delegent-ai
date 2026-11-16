import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { normalizePublicApiBaseUrl } from '../billing/mobileCheckout';
import {
  uploadRunnerFileCore,
  type RunnerFileUploadArgs,
  type RunnerFileUploadResult,
} from './runnerFileUpload';

// Re-export the upload contract from the pure core so callers (App.tsx,
// tests) can import everything file-upload-related from this one module.
export {
  MOBILE_RUNNER_UPLOAD_MAX_BYTES,
  type MobileRunnerUploadedFile,
  type RunnerFileUploadArgs,
  type RunnerFileUploadErrorReason,
  type RunnerFileUploadResult,
} from './runnerFileUpload';

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

export type RunnerFilesErrorReason = 'missing_api_base' | 'unauthenticated' | 'not_ready' | 'unavailable';

export type MobileRunnerFile = {
  id: string;
  name: string;
  relativeName?: string;
  sizeBytes: number;
  modifiedAt: number;
  mimeType: string;
  downloadable: boolean;
  downloadUrl: string;
};

export type RunnerFilesResult =
  | { storageStatus: 'ready' | 'not_ready'; files: readonly MobileRunnerFile[]; truncated: boolean; publicMessage?: string }
  | { error: { reason: RunnerFilesErrorReason; message: string } };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RunnerFilesRequestOptions = {
  apiBaseUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: FetchLike;
};

const RUNNER_FILES_PATH = '/api/files/runner';
const MOBILE_RUNNER_FILES_TOKEN_REFRESH_SKEW_SECONDS = 60;
const expoPublicSidekickApiBaseUrl =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

export const mobileRunnerFilesApiBaseUrl = normalizePublicApiBaseUrl(expoPublicSidekickApiBaseUrl);

function mobileSessionNeedsRefresh(session: { expires_at?: number | null } | null | undefined): boolean {
  if (!session || typeof session.expires_at !== 'number') return true;
  const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_RUNNER_FILES_TOKEN_REFRESH_SKEW_SECONDS;
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

export async function requestRunnerFiles(options: RunnerFilesRequestOptions = {}): Promise<RunnerFilesResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileRunnerFilesApiBaseUrl);
  if (!apiBaseUrl) return runnerFilesError('missing_api_base');

  if (!options.client && !mobileSupabase) return runnerFilesError('unauthenticated');

  let accessToken: string | null = null;
  try {
    accessToken = options.client
      ? await getFreshAccessTokenFromClient(options.client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }

  accessToken = accessToken ?? getRememberedMobileAccessToken();
  if (!accessToken) return runnerFilesError('unauthenticated');

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(buildRunnerFilesUrl(apiBaseUrl), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 401) return runnerFilesError('unauthenticated');
    if (!response.ok) return runnerFilesError('unavailable');

    const payload = await response.json().catch(() => null);
    const storageStatus = isRecord(payload) && payload.storageStatus === 'not_ready' ? 'not_ready' : 'ready';
    const files = isRecord(payload) && Array.isArray(payload.files)
      ? payload.files.flatMap((file): MobileRunnerFile[] => {
        const normalized = parseRunnerFile(file, apiBaseUrl);
        return normalized ? [normalized] : [];
      })
      : [];

    if (storageStatus === 'not_ready') {
      return {
        storageStatus,
        files: [],
        truncated: false,
        publicMessage: nonEmptyString(isRecord(payload) ? payload.publicMessage : null) ?? 'Delegent AI storage is still coming online.',
      };
    }

    return {
      storageStatus,
      files,
      truncated: isRecord(payload) && payload.truncated === true,
    };
  } catch {
    return runnerFilesError('unavailable');
  }
}

// Shared Bearer-token acquisition used by the mutating file calls (delete/
// rename), mirroring requestRunnerFiles so all three agree on auth + recovery.
async function resolveMobileAccessToken(options: RunnerFilesRequestOptions): Promise<string | null> {
  if (!options.client && !mobileSupabase) return null;
  let accessToken: string | null = null;
  try {
    accessToken = options.client
      ? await getFreshAccessTokenFromClient(options.client)
      : await getFreshMobileAccessToken(mobileSupabase);
  } catch {
    accessToken = null;
  }
  return accessToken ?? getRememberedMobileAccessToken();
}

export type RunnerFileMutationResult =
  | { ok: true }
  | { ok: false; error: 'unauthenticated' | 'missing_api_base' | 'unavailable' | 'invalid_file_name' | 'file_exists' | 'not_found' };

// Delete a workspace file. The destructive confirm lives in the UI; this just
// performs the signed DELETE and returns a typed result (never throws).
export async function deleteRunnerFile(
  fileId: string,
  options: RunnerFilesRequestOptions = {},
): Promise<RunnerFileMutationResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileRunnerFilesApiBaseUrl);
  if (!apiBaseUrl) return { ok: false, error: 'missing_api_base' };
  const id = nonEmptyString(fileId);
  if (!id) return { ok: false, error: 'not_found' };
  const accessToken = await resolveMobileAccessToken(options);
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`${buildRunnerFilesUrl(apiBaseUrl)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) return { ok: false, error: 'unauthenticated' };
    if (response.status === 404) return { ok: false, error: 'not_found' };
    if (!response.ok) return { ok: false, error: 'unavailable' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

// Rename a workspace file in place. `newName` is a plain filename; the runner
// enforces the safety rules and 400s a bad name / 409s a taken one. The file id
// changes on rename, so the caller should refresh the listing on success.
export async function renameRunnerFile(
  fileId: string,
  newName: string,
  options: RunnerFilesRequestOptions = {},
): Promise<RunnerFileMutationResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileRunnerFilesApiBaseUrl);
  if (!apiBaseUrl) return { ok: false, error: 'missing_api_base' };
  const id = nonEmptyString(fileId);
  const name = nonEmptyString(newName)?.trim();
  if (!id) return { ok: false, error: 'not_found' };
  if (!name) return { ok: false, error: 'invalid_file_name' };
  const accessToken = await resolveMobileAccessToken(options);
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`${buildRunnerFilesUrl(apiBaseUrl)}/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ newName: name }),
    });
    if (response.status === 401) return { ok: false, error: 'unauthenticated' };
    if (response.status === 400) return { ok: false, error: 'invalid_file_name' };
    if (response.status === 409) return { ok: false, error: 'file_exists' };
    if (response.status === 404) return { ok: false, error: 'not_found' };
    if (!response.ok) return { ok: false, error: 'unavailable' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

// Upload a file to the user's coworker. Mirrors requestRunnerFiles' apiBase
// + bearer-token plumbing, then delegates the 25 MB cap + POST + response
// parsing to the pure uploadRunnerFileCore (so the network/validation logic
// stays unit-testable without the native Supabase import chain). Returns a
// typed {ok:true,file} | {ok:false,error}; never throws to the UI.
export async function uploadRunnerFile(
  args: RunnerFileUploadArgs,
  options: RunnerFilesRequestOptions = {},
): Promise<RunnerFileUploadResult> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileRunnerFilesApiBaseUrl);

  return uploadRunnerFileCore(
    {
      apiBaseUrl,
      resolveAccessToken: () => resolveRunnerFilesAccessToken(options.client),
      parseFile: parseRunnerFile,
      fetchImpl: options.fetchImpl,
    },
    args,
  );
}

// Shared bearer-token resolution: prefer a fresh token (from an injected
// session client or the module Supabase singleton), then fall back to the
// last remembered token. Returns null when there's no client + no remembered
// token, which the callers convert into an 'unauthenticated' result.
async function resolveRunnerFilesAccessToken(client?: MobileSessionClient | null): Promise<string | null> {
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

export function buildRunnerFilesUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${RUNNER_FILES_PATH}`;
}

export function safeRunnerFileDownloadUrl(raw: unknown, apiBaseUrl: string): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;
  const apiBase = normalizePublicApiBaseUrl(apiBaseUrl);
  if (!apiBase) return null;

  try {
    const parsed = new URL(value, apiBase);
    const base = new URL(apiBase);
    if (parsed.username || parsed.password) return null;
    if (parsed.origin !== base.origin) return null;
    if (!parsed.pathname.startsWith(RUNNER_FILES_PATH + '/')) return null;
    if (parsed.searchParams.get('token')?.startsWith('v1.') !== true) return null;
    if (parsed.protocol === 'https:') return parsed.toString();
    if (parsed.protocol === 'http:' && isLocalDevelopmentHost(parsed.hostname)) return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function parseRunnerFile(value: unknown, apiBaseUrl: string): MobileRunnerFile | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const sizeBytes = numberFrom(value.sizeBytes);
  const modifiedAt = numberFrom(value.modifiedAt);
  const mimeType = nonEmptyString(value.mimeType) ?? 'application/octet-stream';
  const downloadUrl = safeRunnerFileDownloadUrl(value.downloadUrl, apiBaseUrl);
  if (!id || !/^file_[a-f0-9]{32}$/.test(id) || !name || sizeBytes === null || modifiedAt === null || !downloadUrl) return null;

  const file: MobileRunnerFile = {
    id,
    name,
    sizeBytes,
    modifiedAt,
    mimeType,
    downloadable: value.downloadable !== false,
    downloadUrl,
  };
  const relativeName = nonEmptyString(value.relativeName);
  if (relativeName) file.relativeName = relativeName;
  return file;
}

function runnerFilesError(reason: RunnerFilesErrorReason): RunnerFilesResult {
  const message: Record<RunnerFilesErrorReason, string> = {
    missing_api_base: 'Files need the app link before they can load.',
    unauthenticated: 'Sign in again, then refresh Files.',
    not_ready: 'Delegent AI storage is still coming online.',
    unavailable: 'Files could not load. Try again in a moment.',
  };
  return { error: { reason, message: message[reason] } };
}

function isLocalDevelopmentHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.localhost')
  ) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const secondOctet = Number.parseInt(match[1], 10);
  return secondOctet >= 16 && secondOctet <= 31;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
