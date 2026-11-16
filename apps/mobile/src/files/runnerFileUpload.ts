// Pure, dependency-injected core for the "upload a file to your coworker"
// flow (POST {apiBase}/api/files/runner, base64-JSON). This module
// deliberately imports nothing native (only `import type` from
// mobileRunnerFiles, which is erased at runtime) so it can be unit-tested
// directly under tsx with a mocked fetch and a fake token resolver.
//
// mobileRunnerFiles.ts wires the real Supabase token plumbing +
// normalizePublicApiBaseUrl around `uploadRunnerFileCore` and re-exports the
// production `uploadRunnerFile`. Keeping the network/validation logic here
// (rather than inline beside the native imports) is what makes it testable.

import type { MobileRunnerFile } from './mobileRunnerFiles';

const RUNNER_FILES_PATH = '/api/files/runner';

// Hard cap on the decoded payload we will send to the proxy. The runner +
// Worker layers mirror this ceiling; rejecting client-side keeps a large
// upload from spending a round-trip just to be refused, and avoids holding
// an oversized base64 string in a fetch body.
export const MOBILE_RUNNER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// An uploaded file is echoed back by the proxy with the same shape as a
// listed file plus the short-lived download token the runner mints. We keep
// `downloadToken` separate from `MobileRunnerFile` (the list shape consumed
// by the Files tab) so callers that re-list never have to carry the token.
export type MobileRunnerUploadedFile = MobileRunnerFile & { downloadToken?: string };

export type RunnerFileUploadErrorReason =
  | 'missing_api_base'
  | 'unauthenticated'
  | 'too_large'
  | 'invalid_input'
  | 'unavailable';

export type RunnerFileUploadResult =
  | { ok: true; file: MobileRunnerUploadedFile }
  | { ok: false; error: { reason: RunnerFileUploadErrorReason; message: string } };

export type RunnerFileUploadArgs = {
  name: string;
  mimeType?: string;
  contentBase64: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Dependencies the production wrapper injects. Keeping these out of the core
// is what lets the unit test run without the native Supabase import chain.
export type RunnerFileUploadCoreDeps = {
  // Already-normalized API origin (e.g. 'https://api.example.com'), or null
  // if the public app link is missing.
  apiBaseUrl: string | null;
  // Resolves a fresh Supabase access token (or null when signed out).
  resolveAccessToken: () => Promise<string | null>;
  // Parses + safety-checks a file record from the proxy response against the
  // API origin (mobileRunnerFiles passes its own parseRunnerFile here).
  parseFile: (value: unknown, apiBaseUrl: string) => MobileRunnerFile | null;
  fetchImpl?: FetchLike;
};

export async function uploadRunnerFileCore(
  deps: RunnerFileUploadCoreDeps,
  args: RunnerFileUploadArgs,
): Promise<RunnerFileUploadResult> {
  const apiBaseUrl = deps.apiBaseUrl;
  if (!apiBaseUrl) return runnerFileUploadError('missing_api_base');

  const name = nonEmptyString(args.name);
  const contentBase64 = typeof args.contentBase64 === 'string' ? args.contentBase64 : '';
  if (!name || !contentBase64) return runnerFileUploadError('invalid_input');

  // Enforce the size ceiling on the *decoded* payload, not the base64 string
  // (which is ~33% larger), so the limit the user experiences matches the
  // real file size.
  const decodedBytes = decodedBase64ByteLength(contentBase64);
  if (decodedBytes === null) return runnerFileUploadError('invalid_input');
  if (decodedBytes > MOBILE_RUNNER_UPLOAD_MAX_BYTES) return runnerFileUploadError('too_large');

  let accessToken: string | null = null;
  try {
    accessToken = await deps.resolveAccessToken();
  } catch {
    accessToken = null;
  }
  if (!accessToken) return runnerFileUploadError('unauthenticated');

  const mimeType = nonEmptyString(args.mimeType);
  const body: Record<string, string> = { name, contentBase64 };
  if (mimeType) body.mimeType = mimeType;

  const fetcher = deps.fetchImpl ?? fetch;
  try {
    const response = await fetcher(buildRunnerFilesUploadUrl(apiBaseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401) return runnerFileUploadError('unauthenticated');
    if (response.status === 413) return runnerFileUploadError('too_large');
    if (!response.ok) return runnerFileUploadError('unavailable');

    const payload = await response.json().catch(() => null);
    if (!isRecord(payload) || payload.ok !== true) return runnerFileUploadError('unavailable');

    const file = parseUploadedRunnerFile(payload.file, apiBaseUrl, deps.parseFile);
    if (!file) return runnerFileUploadError('unavailable');
    return { ok: true, file };
  } catch {
    return runnerFileUploadError('unavailable');
  }
}

export function buildRunnerFilesUploadUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${RUNNER_FILES_PATH}`;
}

function parseUploadedRunnerFile(
  value: unknown,
  apiBaseUrl: string,
  parseFile: (value: unknown, apiBaseUrl: string) => MobileRunnerFile | null,
): MobileRunnerUploadedFile | null {
  const base = parseFile(value, apiBaseUrl);
  if (!base) return null;
  const downloadToken = isRecord(value) ? nonEmptyString(value.downloadToken) : null;
  const uploaded: MobileRunnerUploadedFile = { ...base };
  if (downloadToken) uploaded.downloadToken = downloadToken;
  return uploaded;
}

export function runnerFileUploadError(reason: RunnerFileUploadErrorReason): RunnerFileUploadResult {
  const message: Record<RunnerFileUploadErrorReason, string> = {
    missing_api_base: 'Files need the app link before you can upload.',
    unauthenticated: 'Sign in again, then try the upload once more.',
    too_large: 'That file is too large to upload. The limit is 25 MB.',
    invalid_input: "That file couldn't be read for upload. Try a different file.",
    unavailable: 'Upload could not finish. Try again in a moment.',
  };
  return { ok: false, error: { reason, message: message[reason] } };
}

// Compute the decoded byte length of a base64 string without allocating the
// decoded buffer. Returns null if the string isn't valid base64 (so callers
// can treat it as bad input rather than risk sending garbage).
export function decodedBase64ByteLength(base64: string): number | null {
  const cleaned = base64.replace(/\s+/g, '');
  if (cleaned.length === 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  if (cleaned.length % 4 !== 0) return null;
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  return (cleaned.length / 4) * 3 - padding;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
