import type { Env } from './index.js';
import { usesAgentEngine } from './agent-engine.js';

type RunnerBinding = {
  userId: string;
  runnerBaseUrl: string;
  runnerSharedSecret: string;
  /** Set for an agent engine account: its files live in the engine, reached through the AGENT service binding. */
  fetcher?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

type RetainedWorkspaceState = {
  retentionUntil: string;
};

type SafeRunnerFileRecord = {
  id: string;
  name: string;
  relativeName?: string;
  sizeBytes: number;
  modifiedAt: number;
  mimeType: string;
  downloadable: boolean;
  downloadUrl: string;
  downloadToken: string;
};

const RUNNER_FILES_PATH = '/files';
const WORKER_FILES_PATH = '/api/files/runner';
// PREOP-C03 — fail fast when the runner is provisioned-but-not-yet-serving.
// The binding (runner_base_url) is written right after the Fly machine is
// created, BEFORE the runner finishes booting and serving /files. Without a
// timeout, an upload to a still-booting runner hangs on the open connection
// for ~tens of seconds and then errors with a vague message (the reported
// "upload couldn't finish… try again" after ~1 min). A bounded timeout turns
// that into a fast, actionable "not ready, retry shortly" response. 12s is
// comfortably above a healthy runner's file round-trip yet well under the
// minute-long hang users saw. The upload is safe to retry (idempotent re-POST).
const RUNNER_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 300;
const MAX_SAFE_RUNNER_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SAFE_FILE_ID = /^file_[a-f0-9]{32}$/;
const SAFE_MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
// Kept in sync with the runner's UNSAFE_WORKSPACE_NAME list (server.py): the
// Worker must reject everything the runner rejects, or a Worker-validated
// upload 400s downstream and surfaces as an opaque 'runner_file_unavailable'.
const SENSITIVE_FILE_NAME_FRAGMENTS = ['.env', 'secret', 'token', 'credential', 'password', 'private_key', 'passwd', 'apikey', 'api_key'];
const SENSITIVE_FILE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];

export async function handleRunnerFilesListFromWorker(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return safeJson({ error: 'GET required' }, 405);

  const readiness = resolveReadiness(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_files_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  const userId = await getAuthenticatedSupabaseUserId(env, token);
  if (!userId) return safeJson({ error: 'unauthenticated' }, 401);

  const binding = await getUsableRunnerBinding(env, userId);
  if (!binding) {
    const retainedWorkspace = await getRetainedWorkspaceState(env, userId);
    if (retainedWorkspace) return storageRetainedResponse(retainedWorkspace);
    return storageNotReadyResponse();
  }

  const signingSecret = fileLinkSigningSecret(env);
  if (!signingSecret) return safeJson({ error: 'runner_files_unavailable', missing: ['SIDEKICK_FILE_LINK_SIGNING_SECRET'] }, 503);

  let upstream: Response;
  const now = Math.floor(Date.now() / 1000);
  try {
    upstream = await fetchRunnerWithTimeout(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...await buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now),
      },
    }, resolveRunnerTimeoutMs(env), binding.fetcher);
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }

  if (!upstream.ok) return safeJson({ error: 'runner_files_unavailable' }, upstream.status === 404 ? 404 : 502);

  const payload = await upstream.json().catch(() => null);
  if (!isRecord(payload) || payload.ok !== true) return safeJson({ error: 'runner_files_unavailable' }, 502);

  const files = Array.isArray(payload.files)
    ? (await Promise.all(payload.files.map((file) => toSafeRunnerFileRecord(file, request.url, binding.userId, signingSecret, now))))
      .filter((file): file is SafeRunnerFileRecord => Boolean(file))
    : [];

  return safeJson({
    ok: true,
    storageStatus: 'ready',
    files,
    truncated: payload.truncated === true,
  }, 200);
}

export async function handleRunnerFileDownloadFromWorker(request: Request, env: Env, fileId: string): Promise<Response> {
  if (request.method !== 'GET') return safeJson({ error: 'GET required' }, 405);

  const readiness = resolveReadiness(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_file_unavailable', missing: readiness.missing }, 503);
  if (!isSafeFileId(fileId)) return safeJson({ error: 'file_not_found' }, 404);

  const signingSecret = fileLinkSigningSecret(env);
  if (!signingSecret) return safeJson({ error: 'runner_file_unavailable', missing: ['SIDEKICK_FILE_LINK_SIGNING_SECRET'] }, 503);

  const now = Math.floor(Date.now() / 1000);
  const verified = await verifyRunnerFileDownloadToken(new URL(request.url).searchParams.get('token'), fileId, signingSecret, now);
  if (!verified) return safeJson({ error: 'unauthenticated' }, 401);

  const binding = await getUsableRunnerBinding(env, verified.userId);
  if (!binding) return safeJson({ error: 'file_not_found' }, 404);

  const requestedRange = safeRunnerFileRangeHeader(request.headers.get('range'));
  const runnerHeaders = await buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now);
  if (requestedRange) runnerHeaders.range = requestedRange.header;

  let upstream: Response;
  try {
    upstream = await fetchRunnerWithTimeout(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${fileId}`, {
      method: 'GET',
      headers: runnerHeaders,
    }, resolveRunnerTimeoutMs(env), binding.fetcher);
  } catch {
    return safeJson({ error: 'runner_file_unavailable' }, 503);
  }

  if (upstream.status === 404) return safeJson({ error: 'file_not_found' }, 404);
  if (requestedRange && upstream.status !== 206) return safeJson({ error: 'runner_file_range_unavailable' }, 502);
  if (!upstream.ok) return safeJson({ error: 'runner_file_unavailable' }, 502);

  const contentRange = requestedRange ? safeContentRange(upstream.headers.get('content-range')) : null;
  if (requestedRange && !contentRange) return safeJson({ error: 'runner_file_range_unavailable' }, 502);
  const bodyLimit = requestedRange?.maxBytes ?? MAX_SAFE_RUNNER_FILE_SIZE_BYTES;
  const contentLength = numberFrom(upstream.headers.get('content-length'));
  if (contentLength !== null && contentLength > bodyLimit) {
    return safeJson({ error: 'file_too_large' }, 413);
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > bodyLimit) return safeJson({ error: 'file_too_large' }, 413);

  const responseHeaders: Record<string, string> = {
    'content-type': resolveDownloadContentType(!!requestedRange, upstream.headers.get('content-type')),
    'content-disposition': safeContentDisposition(upstream.headers.get('content-disposition')) ?? `attachment; filename="${fileId}.bin"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (contentRange) {
    responseHeaders['content-range'] = contentRange;
    responseHeaders['accept-ranges'] = 'bytes';
  }

  return new Response(body, {
    status: upstream.status === 206 ? 206 : 200,
    headers: responseHeaders,
  });
}

// Delete a workspace file. Bearer-authenticated (like the listing), then a
// signed DELETE to the runner, which enforces the workspace safety guard. The
// UI owns the destructive confirm; this just performs it.
export async function handleRunnerFileDeleteFromWorker(request: Request, env: Env, fileId: string): Promise<Response> {
  if (request.method !== 'DELETE') return safeJson({ error: 'DELETE required' }, 405);
  const readiness = resolveReadiness(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_files_unavailable', missing: readiness.missing }, 503);
  if (!isSafeFileId(fileId)) return safeJson({ error: 'file_not_found' }, 404);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);
  const userId = await getAuthenticatedSupabaseUserId(env, token);
  if (!userId) return safeJson({ error: 'unauthenticated' }, 401);
  const binding = await getUsableRunnerBinding(env, userId);
  if (!binding) return safeJson({ error: 'file_not_found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  let upstream: Response;
  try {
    upstream = await fetchRunnerWithTimeout(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${fileId}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', ...await buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now) },
    }, resolveRunnerTimeoutMs(env), binding.fetcher);
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }
  if (upstream.status === 404) return safeJson({ error: 'file_not_found' }, 404);
  if (!upstream.ok) return safeJson({ error: 'runner_files_unavailable' }, 502);
  return safeJson({ ok: true }, 200);
}

// Rename a workspace file. Bearer-authenticated; validates the new name the same
// way the runner does (plain filename, no separators/traversal/dotfile/sensitive)
// before proxying, so an obviously-bad name fails fast without a runner round-trip.
export async function handleRunnerFileRenameFromWorker(request: Request, env: Env, fileId: string): Promise<Response> {
  if (request.method !== 'POST') return safeJson({ error: 'POST required' }, 405);
  const readiness = resolveReadiness(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_files_unavailable', missing: readiness.missing }, 503);
  if (!isSafeFileId(fileId)) return safeJson({ error: 'file_not_found' }, 404);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);
  const body = await request.json().catch(() => null);
  const newName = isRecord(body) && typeof body.newName === 'string' ? body.newName.trim() : '';
  const lowered = newName.toLowerCase();
  const badName = !newName || newName.length > 255 || newName.includes('/') || newName.includes('\\')
    || newName.startsWith('.') || newName === '..'
    || SENSITIVE_FILE_NAME_FRAGMENTS.some((frag) => lowered.includes(frag))
    || SENSITIVE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext));
  if (badName) return safeJson({ error: 'invalid_file_name' }, 400);

  const userId = await getAuthenticatedSupabaseUserId(env, token);
  if (!userId) return safeJson({ error: 'unauthenticated' }, 401);
  const binding = await getUsableRunnerBinding(env, userId);
  if (!binding) return safeJson({ error: 'file_not_found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  let upstream: Response;
  try {
    upstream = await fetchRunnerWithTimeout(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${fileId}/rename`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...await buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now),
      },
      body: JSON.stringify({ newName }),
    }, resolveRunnerTimeoutMs(env), binding.fetcher);
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }
  if (upstream.status === 400) return safeJson({ error: 'invalid_file_name' }, 400);
  if (upstream.status === 404) return safeJson({ error: 'file_not_found' }, 404);
  if (upstream.status === 409) return safeJson({ error: 'file_exists' }, 409);
  if (!upstream.ok) return safeJson({ error: 'runner_files_unavailable' }, 502);
  return safeJson({ ok: true }, 200);
}

export async function handleRunnerFileUploadFromWorker(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return safeJson({ error: 'method_not_allowed' }, 405);

  const readiness = resolveReadiness(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_file_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  const userId = await getAuthenticatedSupabaseUserId(env, token);
  if (!userId) return safeJson({ error: 'unauthenticated' }, 401);

  const signingSecret = fileLinkSigningSecret(env);
  if (!signingSecret) return safeJson({ error: 'runner_file_unavailable', missing: ['SIDEKICK_FILE_LINK_SIGNING_SECRET'] }, 503);

  const body = await request.json().catch(() => null);
  if (!isRecord(body)) return safeJson({ error: 'invalid_request' }, 400);

  const name = safeUploadName(body.name);
  if (!name) return safeJson({ error: 'invalid_file_name' }, 400);

  const contentBase64 = nonEmptyString(body.contentBase64);
  if (!contentBase64) return safeJson({ error: 'invalid_request' }, 400);

  // Reject oversized uploads BEFORE any runner call. base64 inflates the byte
  // payload ~4/3, so the decoded size is at most length * 3/4 (a touch less
  // when padding is present) — estimating from the encoded length is enough
  // to fail closed before we forward anything to the runner.
  if (estimateBase64DecodedBytes(contentBase64) > MAX_UPLOAD_BYTES) {
    return safeJson({ error: 'file_too_large' }, 413);
  }

  // mimeType is optional on the wire; only forward it when it is well-formed.
  const declaredMimeType = nonEmptyString(body.mimeType);
  const mimeType = declaredMimeType && SAFE_MIME_TYPE.test(declaredMimeType) ? declaredMimeType : undefined;

  const binding = await getUsableRunnerBinding(env, userId);
  if (!binding) return storageNotReadyResponse();

  const now = Math.floor(Date.now() / 1000);
  const headers = {
    ...await buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now),
    'content-type': 'application/json',
  };

  let upstream: Response;
  try {
    upstream = await fetchRunnerWithTimeout(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, mimeType, contentBase64 }),
    }, resolveRunnerTimeoutMs(env), binding.fetcher);
  } catch {
    // PREOP-C03 — includes the AbortError when the runner is not yet serving:
    // fail fast (503, retry) instead of hanging ~60s then erroring vaguely.
    return safeJson({ error: 'runner_file_unavailable' }, 503);
  }

  if (upstream.status === 413) return safeJson({ error: 'file_too_large' }, 413);
  if (!upstream.ok) return safeJson({ error: 'runner_file_unavailable' }, 502);

  const payload = await upstream.json().catch(() => null);
  if (!isRecord(payload) || payload.ok !== true) return safeJson({ error: 'runner_file_unavailable' }, 502);

  const safeRecord = await toSafeRunnerFileRecord(payload.file, request.url, binding.userId, signingSecret, now);
  if (!safeRecord) return safeJson({ error: 'runner_file_unavailable' }, 502);

  return safeJson({ ok: true, file: safeRecord }, 200);
}

function supabaseBaseUrl(env: Env): string | null {
  return nonEmptyString(env.SUPABASE_URL)?.replace(/\/+$/, '') ?? null;
}

function supabaseHeaders(env: Env, contentType = false): Record<string, string> {
  const serviceRoleKey = requireNonEmpty(env.SUPABASE_SERVICE_ROLE_KEY);
  const headers: Record<string, string> = {
    accept: 'application/json',
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };
  if (contentType) headers['content-type'] = 'application/json';
  return headers;
}

function supabaseRestUrl(env: Env, table: string, params: Record<string, string> = {}): string {
  const baseUrl = requireNonEmpty(supabaseBaseUrl(env));
  const url = new URL(`${baseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function getAuthenticatedSupabaseUserId(env: Env, accessToken: string): Promise<string | null> {
  const baseUrl = supabaseBaseUrl(env);
  if (!baseUrl) return null;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        apikey: requireNonEmpty(env.SUPABASE_SERVICE_ROLE_KEY),
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const userId = isRecord(body) ? nonEmptyString(body.id) : null;
  return userId && isUuid(userId) ? userId : null;
}

async function getUsableRunnerBinding(env: Env, userId: string): Promise<RunnerBinding | null> {
  // Agent engine accounts (src/agent-engine.ts) keep chat attachments in the
  // engine, which serves the same /files contract a runner does and verifies the
  // same v1 signature, made with the engine's secret.
  if (await usesAgentEngine(env, userId) && env.AGENT) {
    return { userId, runnerBaseUrl: 'https://agent.internal', runnerSharedSecret: (env.SIDEKICK_AGENT_SHARED_SECRET ?? '').trim(), fetcher: env.AGENT };
  }
  let workspaceResponse: Response;
  let response: Response;
  try {
    // Defect hunt 2026-09-03 (D7). This used to read only the private row, so
    // a paused (sleeping) workspace still produced a binding and the file
    // request went to the runner. Fly auto-starts a stopped machine on the
    // first request, so opening the Files tab woke a lapsed user's machine,
    // which is exactly what the suspend was meant to stop. The chat dispatch
    // path gates on hermes_instances.status === 'ready'; files now applies
    // the same rule. The two reads run in parallel so the hot path pays no
    // extra latency.
    [workspaceResponse, response] = await Promise.all([
      fetch(supabaseRestUrl(env, 'hermes_instances', {
        user_id: `eq.${userId}`,
        select: 'status,suspended_at,volume_retention_until,deleted_at',
        limit: '1',
      }), {
        method: 'GET',
        headers: supabaseHeaders(env),
      }),
      fetch(supabaseRestUrl(env, 'hermes_instance_private', {
        user_id: `eq.${userId}`,
        select: 'runner_base_url,runner_shared_secret,provider,fly_app_name',
      }), {
        method: 'GET',
        headers: supabaseHeaders(env),
      }),
    ]);
  } catch {
    return null;
  }
  if (!workspaceResponse.ok || !response.ok) return null;

  const workspaceRows = await workspaceResponse.json().catch(() => null);
  const workspace = Array.isArray(workspaceRows) ? workspaceRows.find(isRecord) : null;
  if (recordString(workspace, 'status') !== 'ready') return null;
  if (recordString(workspace, 'deleted_at')) return null;

  const rows = await response.json().catch(() => null);
  const row = Array.isArray(rows) ? rows.find(isRecord) : null;
  const runnerBaseUrl = normalizeRunnerBaseUrl(recordString(row, 'runner_base_url'));
  const runnerSharedSecret = recordString(row, 'runner_shared_secret');
  if (!runnerBaseUrl || !runnerSharedSecret) return null;
  // Same last-gate the chat dispatch path applies (flyRunnerBindingHostMatches
  // in index.ts): a stale or admin-mutated runner_base_url that no longer
  // belongs to this user's Fly app must not receive their signed file
  // requests. Files uploads carry user content, so the bar is identical.
  const provider = (recordString(row, 'provider') ?? '').trim().toLowerCase();
  if (provider === 'fly_machines') {
    const flyAppName = recordString(row, 'fly_app_name');
    if (!flyAppName) return null;
    const expectedHost = `${flyAppName.toLowerCase()}.fly.dev`;
    try {
      if (new URL(runnerBaseUrl).hostname.toLowerCase() !== expectedHost) return null;
    } catch {
      return null;
    }
  }
  return { userId, runnerBaseUrl, runnerSharedSecret };
}

async function getRetainedWorkspaceState(env: Env, userId: string): Promise<RetainedWorkspaceState | null> {
  let response: Response;
  try {
    response = await fetch(supabaseRestUrl(env, 'hermes_instances', {
      user_id: `eq.${userId}`,
      select: 'status,suspended_at,volume_retention_until,deleted_at',
      limit: '1',
    }), {
      method: 'GET',
      headers: supabaseHeaders(env),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const rows = await response.json().catch(() => null);
  const row = Array.isArray(rows) ? rows.find(isRecord) : null;
  if (recordString(row, 'status') !== 'sleeping') return null;
  if (recordString(row, 'deleted_at')) return null;

  const retentionUntil = recordString(row, 'volume_retention_until');
  if (!retentionUntil) return null;
  const retentionTime = Date.parse(retentionUntil);
  if (Number.isFinite(retentionTime) && retentionTime < Date.now()) return null;
  return { retentionUntil };
}

/**
 * PREOP-C03 — fetch a runner endpoint with a hard timeout so a
 * provisioned-but-not-yet-serving runner fails FAST (AbortError) instead of
 * leaving the request hanging on an open connection for ~a minute. The caller's
 * existing catch maps the rejection to a structured `runner_*_unavailable`
 * response, so the user gets an immediate, retry-safe "not ready" signal. Never
 * leaks runner internals — only the fetch rejection propagates.
 */
async function fetchRunnerWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = RUNNER_REQUEST_TIMEOUT_MS,
  fetcher?: RunnerBinding['fetcher'],
): Promise<Response> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const request = controller ? { ...init, signal: controller.signal } : init;
  try {
    return await (fetcher ? fetcher.fetch(input, request) : fetch(input, request));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * PREOP-C03 — resolve the runner request timeout, allowing an env override
 * (`SIDEKICK_RUNNER_REQUEST_TIMEOUT_MS`) for ops tuning and tests. Falls back to
 * the 12s default and ignores non-positive / non-finite values.
 */
function resolveRunnerTimeoutMs(env: Env): number {
  const raw = Number((env as Record<string, string | undefined>).SIDEKICK_RUNNER_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RUNNER_REQUEST_TIMEOUT_MS;
}

async function buildSidekickRunnerHeaders(userId: string, sharedSecret: string, now: number): Promise<Record<string, string>> {
  return {
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': String(now),
    'x-sidekick-runner-token': await signHmacValue(sharedSecret, `v1:${userId}:${now}`),
  };
}

async function createRunnerFileDownloadToken(input: {
  userId: string;
  fileId: string;
  signingSecret: string;
  now: number;
  ttlSeconds?: number;
}): Promise<string> {
  const expiresAt = input.now + (input.ttlSeconds ?? DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS);
  const payload = `v1:${expiresAt}:${input.userId}:${input.fileId}`;
  const signature = await hmacSha256Hex(input.signingSecret, payload);
  return `v1.${expiresAt}.${input.userId}.${input.fileId}.${signature}`;
}

async function verifyRunnerFileDownloadToken(
  token: string | null,
  expectedFileId: string,
  signingSecret: string,
  now: number,
): Promise<{ userId: string } | null> {
  const value = nonEmptyString(token);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const expiresAt = Number.parseInt(parts[1], 10);
  const userId = parts[2];
  const fileId = parts[3];
  const signature = parts[4];
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return null;
  if (!isUuid(userId) || !isSafeFileId(fileId) || fileId !== expectedFileId) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  const expected = await hmacSha256Hex(signingSecret, `v1:${expiresAt}:${userId}:${fileId}`);
  return timingSafeEqualHex(signature, expected) ? { userId } : null;
}

async function signHmacValue(secret: string, payload: string): Promise<string> {
  return `v1.${await hmacSha256Hex(secret, payload)}`;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(requireNonEmpty(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const a = hexToBytes(left);
  const b = hexToBytes(right);
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  let result = 0;
  for (let i = 0; i < a.byteLength; i += 1) result |= a[i] ^ b[i];
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function toSafeRunnerFileRecord(
  value: unknown,
  requestUrl: string,
  userId: string,
  signingSecret: string,
  now: number,
): Promise<SafeRunnerFileRecord | null> {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = safeFileName(value.name);
  const sizeBytes = numberFrom(value.sizeBytes);
  const modifiedAt = numberFrom(value.modifiedAt);
  const mimeType = safeMimeType(value.mimeType);
  if (!id || !isSafeFileId(id) || !name || sizeBytes === null || modifiedAt === null) return null;
  if (sizeBytes < 0 || modifiedAt < 0) return null;

  const downloadToken = await createRunnerFileDownloadToken({ userId, fileId: id, signingSecret, now });
  const downloadUrl = new URL(`${WORKER_FILES_PATH}/${id}`, new URL(requestUrl).origin);
  downloadUrl.searchParams.set('token', downloadToken);

  const record: SafeRunnerFileRecord = {
    id,
    name,
    sizeBytes,
    modifiedAt,
    mimeType,
    downloadable: value.downloadable !== false && sizeBytes <= MAX_SAFE_RUNNER_FILE_SIZE_BYTES,
    downloadUrl: downloadUrl.toString(),
    downloadToken,
  };
  const relativeName = safeRelativeName(value.relativeName);
  if (relativeName) record.relativeName = relativeName;
  return record;
}

function normalizeRunnerBaseUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function storageNotReadyResponse(): Response {
  return safeJson({
    ok: true,
    storageStatus: 'not_ready',
    files: [],
    truncated: false,
    publicMessage: "Your coworker's cloud space is still coming online.",
  }, 200);
}

function storageRetainedResponse(state: RetainedWorkspaceState): Response {
  return safeJson({
    ok: true,
    storageStatus: 'not_ready',
    files: [],
    truncated: false,
    retentionUntil: state.retentionUntil,
    publicMessage: "Your coworker's workspace is paused, but your files stay saved in their private workspace. Resume a plan to wake the workspace and open them again.",
  }, 200);
}

function fileLinkSigningSecret(env: Env): string | null {
  return nonEmptyString(env.SIDEKICK_FILE_LINK_SIGNING_SECRET) ?? nonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY);
}

function safeJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function resolveReadiness(env: Env, required: Array<keyof Env>): { ok: boolean; missing: string[] } {
  const missing = required.filter((name) => !nonEmptyString(env[name])).map(String);
  return { ok: missing.length === 0, missing };
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return nonEmptyString(match?.[1]);
}

function requireNonEmpty(value: string | null | undefined): string {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error('non_empty_string_required');
  return normalized;
}

function recordString(row: Record<string, unknown> | null | undefined, key: string): string | null {
  return nonEmptyString(row?.[key]);
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSafeFileId(value: string): boolean {
  return SAFE_FILE_ID.test(value);
}

function safeFileName(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw || raw.length > 160 || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) return null;
  const lowered = raw.toLowerCase();
  if (raw.startsWith('.') || SENSITIVE_FILE_NAME_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return null;
  if (SENSITIVE_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) return null;
  return raw;
}

function safeUploadName(value: unknown): string | null {
  // Uploads are bare filenames ONLY: the runner rejects any name containing
  // '/' (everything lands in workspace/uploads/), so accepting a relative
  // path here just defers the failure to an opaque downstream 502.
  return safeFileName(value);
}

function estimateBase64DecodedBytes(value: string): number {
  // Strip whitespace some clients fold into base64, then derive the decoded
  // byte count: 4 base64 chars -> 3 bytes, minus 1 per '=' pad char.
  const normalized = value.replace(/\s+/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function safeRelativeName(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw || raw.length > 240 || raw.includes('\\') || raw.includes('\0')) return null;
  if (raw.startsWith('/') || raw.split('/').some((part) => !part || part === '.' || part === '..' || safeFileName(part) === null)) return null;
  return raw;
}

function safeMimeType(value: unknown): string {
  const raw = nonEmptyString(value);
  return raw && SAFE_MIME_TYPE.test(raw) ? raw : 'application/octet-stream';
}

// A full-file "Download to phone" (a browser GET via Linking.openURL) must SAVE
// the file, not render it: Android browsers preview PDFs / office / code files
// inline and render them badly (Alex, 2026-07-18), instead of dropping them in
// Downloads. Forcing application/octet-stream on the full download makes the
// browser save it. RANGE requests (the app's inline preview + any streaming)
// keep the true content-type so previews still work.
export function resolveDownloadContentType(isRangeRequest: boolean, upstreamContentType: unknown): string {
  return isRangeRequest ? safeMimeType(upstreamContentType) : 'application/octet-stream';
}

function safeContentDisposition(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw || raw.length > 220 || /[\r\n\0]/.test(raw)) return null;
  const fileNameMatch = raw.match(/filename="?([^";]+)"?/i);
  const fileName = safeFileName(fileNameMatch?.[1]);
  if (!fileName) return null;
  return `attachment; filename="${fileName.replace(/"/g, '')}"`;
}

function safeRunnerFileRangeHeader(value: unknown): { header: string; maxBytes: number } | null {
  const raw = nonEmptyString(value);
  const match = raw?.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  if (start >= MAX_SAFE_RUNNER_FILE_SIZE_BYTES || end >= MAX_SAFE_RUNNER_FILE_SIZE_BYTES) return null;
  const maxBytes = end - start + 1;
  if (maxBytes <= 0 || maxBytes > MAX_SAFE_RUNNER_FILE_SIZE_BYTES) return null;
  return { header: `bytes=${start}-${end}`, maxBytes };
}

function safeContentRange(value: unknown): string | null {
  const raw = nonEmptyString(value);
  return raw && /^bytes \d+-\d+\/(\d+|\*)$/i.test(raw) ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
