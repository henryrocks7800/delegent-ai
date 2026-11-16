import { PREVIEW_BYTE_LIMIT, buildFilePreview, isPreviewableFile } from '@sidekick/shared';
import { apiFetch, isFailure, type ApiFailure } from '../../lib/api';
import { apiOrigin } from '../../lib/env';

// The preview ceiling and the previewable-type test live in @sidekick/shared so
// the phone and the browser cannot disagree about which files get a first look.
export { PREVIEW_BYTE_LIMIT, PREVIEW_LINE_LIMIT, isPreviewableFile } from '@sidekick/shared';

// The Worker owns every file operation; the browser never talks to a runner
// directly and never learns a runner URL.

export const RUNNER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type RunnerFile = {
  id: string;
  name: string;
  relativeName?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  mimeType?: string;
  downloadable?: boolean;
  downloadUrl?: string;
};

export type StorageStatus = 'ready' | 'not_ready';

export type FilesListing = {
  storageStatus: StorageStatus;
  files: readonly RunnerFile[];
  truncated: boolean;
  publicMessage?: string;
};

type RunnerFilesResponse = {
  storageStatus?: unknown;
  files?: unknown;
  truncated?: unknown;
  publicMessage?: unknown;
};

export type FilesResult = { ok: true; listing: FilesListing } | ApiFailure;

// The phone tells these three apart and says something different for each. The
// browser only had a message, so a name clash and a dead workspace read the
// same, and a delete of a file that was already gone counted as a failure.
export type MutationErrorCode = 'not_found' | 'file_exists' | 'invalid_file_name';
export type MutationResult = { ok: true } | { ok: false; message: string; error?: MutationErrorCode };
export type UploadResult = { ok: true; file: RunnerFile } | { ok: false; message: string };

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A download URL is only followed when it points at our own API. The Worker
 * builds these, but treating a server field as a trusted URL is the kind of
 * thing that quietly turns into an open redirect.
 */
export function safeDownloadUrl(raw: unknown): string | undefined {
  const value = text(raw);
  if (!value) return undefined;
  const base = apiOrigin || window.location.origin;
  try {
    const parsed = new URL(value, base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.origin !== new URL(base).origin) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function mapRunnerFiles(raw: unknown): readonly RunnerFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): RunnerFile[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const id = text(row.id);
    const name = text(row.name);
    if (!id || !name) return [];

    const file: RunnerFile = { id, name };
    const relativeName = text(row.relativeName);
    if (relativeName) file.relativeName = relativeName;
    const sizeBytes = count(row.sizeBytes);
    if (sizeBytes !== undefined) file.sizeBytes = sizeBytes;
    const modifiedAt = text(row.modifiedAt);
    if (modifiedAt) file.modifiedAt = modifiedAt;
    const mimeType = text(row.mimeType);
    if (mimeType) file.mimeType = mimeType;
    if (row.downloadable === true) file.downloadable = true;
    const downloadUrl = safeDownloadUrl(row.downloadUrl);
    if (downloadUrl) file.downloadUrl = downloadUrl;
    return [file];
  });
}

export async function fetchRunnerFiles(signal?: AbortSignal): Promise<FilesResult> {
  const init = signal ? { signal } : {};
  const result = await apiFetch<RunnerFilesResponse>('/api/files/runner', init);
  if (isFailure(result)) return result;

  const body = result.data;
  const listing: FilesListing = {
    // Only an explicit not_ready means not ready, which is the reading the phone
    // has always taken. Treating anything unrecognised as not_ready looks like
    // the careful choice and is the worse one: it answers a response that did
    // carry files with "your workspace is still coming online", so the same
    // account would show a full folder on a phone and an empty wait in a
    // browser. The Worker sets this field on every path; this is about what
    // happens the day it does not.
    storageStatus: body.storageStatus === 'not_ready' ? 'not_ready' : 'ready',
    files: mapRunnerFiles(body.files),
    truncated: body.truncated === true,
  };
  const publicMessage = text(body.publicMessage);
  if (publicMessage) listing.publicMessage = publicMessage;
  return { ok: true, listing };
}

export async function deleteRunnerFile(fileId: string): Promise<MutationResult> {
  const result = await apiFetch(`/api/files/runner/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  // A file that is already gone is the outcome the reader asked for, so a 404
  // is reported as not_found and counted as deleted rather than rolled back
  // into a list it is no longer in.
  if (isFailure(result)) {
    return result.status === 404
      ? { ok: false, message: result.message, error: 'not_found' }
      : { ok: false, message: result.message };
  }
  return { ok: true };
}

export async function renameRunnerFile(fileId: string, newName: string): Promise<MutationResult> {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, message: 'Give the file a name.' };
  const result = await apiFetch(`/api/files/runner/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    body: { newName: trimmed },
  });
  if (isFailure(result)) {
    if (result.status === 409) return { ok: false, message: 'A file with that name is already there.', error: 'file_exists' };
    if (result.status === 404) return { ok: false, message: result.message, error: 'not_found' };
    if (result.status === 400) return { ok: false, message: result.message, error: 'invalid_file_name' };
    return { ok: false, message: result.message };
  }
  return { ok: true };
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadRunnerFile(file: File): Promise<UploadResult> {
  if (file.size > RUNNER_UPLOAD_MAX_BYTES) {
    return { ok: false, message: 'That file is over the 25 MB limit for uploads.' };
  }

  let contentBase64: string;
  try {
    contentBase64 = await readFileAsBase64(file);
  } catch {
    return { ok: false, message: 'We could not read that file. Try picking it again.' };
  }
  if (!contentBase64) return { ok: false, message: 'That file looked empty. Try picking it again.' };

  const result = await apiFetch<{ file?: unknown }>('/api/files/runner', {
    method: 'POST',
    body: { name: file.name, contentBase64, mimeType: file.type || 'application/octet-stream' },
  });
  if (isFailure(result)) {
    if (result.status === 413) return { ok: false, message: 'That file is over the 25 MB limit for uploads.' };
    return { ok: false, message: result.message };
  }

  const [uploaded] = mapRunnerFiles([result.data.file]);
  if (!uploaded) return { ok: false, message: 'The upload finished but we could not read it back. Refresh the list.' };
  return { ok: true, file: uploaded };
}

export type PreviewResult =
  | { ok: true; body: string; truncated: boolean }
  | { ok: false; reason: 'unsupported' | 'unavailable' };

/**
 * Reads the first few kilobytes of a file for an inline look.
 *
 * The download URL carries its own signed token, so this is a plain fetch with
 * no bearer attached. The Range header is what keeps a 90 MB file from being
 * pulled down to show forty lines of it, and it is also why the Worker has to
 * allow `range` through CORS.
 */
export async function fetchFilePreview(file: RunnerFile, signal?: AbortSignal): Promise<PreviewResult> {
  if (!isPreviewableFile(file)) return { ok: false, reason: 'unsupported' };
  if (!file.downloadUrl) return { ok: false, reason: 'unavailable' };

  let response: Response;
  try {
    const init: RequestInit = { method: 'GET', headers: { range: `bytes=0-${PREVIEW_BYTE_LIMIT - 1}` } };
    if (signal) init.signal = signal;
    response = await fetch(file.downloadUrl, init);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  // 206 is the answer to a range that was honoured. A 200 means the whole file
  // came back, which is still readable, so take it rather than refusing.
  if (!response.ok && response.status !== 206) return { ok: false, reason: 'unavailable' };

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  const preview = buildFilePreview(raw, file.sizeBytes);
  return { ok: true, body: preview.body, truncated: preview.truncated };
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
