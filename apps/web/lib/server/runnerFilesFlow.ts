import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RunnerFilesServerEnv {
  SUPABASE_URL?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SIDEKICK_FILE_LINK_SIGNING_SECRET?: string | null;
}

export interface AuthenticatedRunnerFilesUser {
  id: string;
}

export interface RunnerBinding {
  userId: string;
  runnerBaseUrl?: string | null;
  runnerSharedSecret?: string | null;
}

type UsableRunnerBinding = {
  userId: string;
  runnerBaseUrl: string;
  runnerSharedSecret: string;
};

export interface RunnerFilesStore {
  getRunnerBinding(userId: string): Promise<RunnerBinding | null>;
}

export type RunnerFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RunnerFilesListRouteDeps {
  env: RunnerFilesServerEnv;
  getAuthenticatedUser(token: string, env: RunnerFilesServerEnv): Promise<AuthenticatedRunnerFilesUser | null>;
  store: RunnerFilesStore;
  fetchRunner: RunnerFetchLike;
  now?: () => number;
  downloadTokenTtlSeconds?: number;
}

export interface RunnerFileDownloadRouteDeps {
  env: RunnerFilesServerEnv;
  store: RunnerFilesStore;
  fetchRunner: RunnerFetchLike;
  now?: () => number;
}

export interface RunnerFileDownloadTokenInput {
  userId: string;
  fileId: string;
  signingSecret: string;
  now?: number;
  ttlSeconds?: number;
}

export interface SafeRunnerFileRecord {
  id: string;
  name: string;
  relativeName?: string;
  sizeBytes: number;
  modifiedAt: number;
  mimeType: string;
  downloadable: boolean;
  downloadUrl: string;
  downloadToken: string;
}

const RUNNER_FILES_PATH = '/files';
const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 300;
const MAX_SAFE_RUNNER_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const SAFE_MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const SAFE_FILE_ID = /^file_[a-f0-9]{32}$/;
const SENSITIVE_FILE_NAME_FRAGMENTS = ['.env', 'secret', 'token', 'credential', 'password', 'private_key'];

export async function handleRunnerFilesListRequest(
  request: Request,
  deps: RunnerFilesListRouteDeps,
): Promise<Response> {
  if (request.method !== 'GET') return safeJson({ error: 'GET required' }, 405);

  const readiness = resolveReadiness(deps.env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_files_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  let user: AuthenticatedRunnerFilesUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return safeJson({ error: 'unauthenticated' }, 401);
  }
  if (!user || !isUuid(user.id)) return safeJson({ error: 'unauthenticated' }, 401);

  const binding = await getUsableRunnerBinding(deps.store, user.id);
  if (!binding) return storageNotReadyResponse();

  const signingSecret = fileLinkSigningSecret(deps.env);
  if (!signingSecret) return safeJson({ error: 'runner_files_unavailable', missing: ['SIDEKICK_FILE_LINK_SIGNING_SECRET'] }, 503);

  let upstream: Response;
  const now = Math.floor((deps.now ?? (() => Date.now() / 1000))());
  try {
    upstream = await deps.fetchRunner(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now),
      },
    });
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }

  if (!upstream.ok) return safeJson({ error: 'runner_files_unavailable' }, upstream.status === 404 ? 404 : 502);

  const payload = await upstream.json().catch(() => null);
  if (!isRecord(payload) || payload.ok !== true) return safeJson({ error: 'runner_files_unavailable' }, 502);

  const ttlSeconds = deps.downloadTokenTtlSeconds ?? DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS;
  const files = Array.isArray(payload.files)
    ? payload.files.flatMap((file): SafeRunnerFileRecord[] => {
      const record = toSafeRunnerFileRecord(file, request.url, binding.userId, signingSecret, now, ttlSeconds);
      return record ? [record] : [];
    })
    : [];

  return safeJson({
    ok: true,
    storageStatus: 'ready',
    files,
    truncated: payload.truncated === true,
  }, 200);
}

// Shared Bearer-auth + runner-binding resolution for the mutating file routes
// (delete/rename). Mirrors the list handler's front matter so the mutation
// routes enforce the same auth + readiness before they touch the runner.
async function authenticateAndResolveBinding(
  request: Request,
  deps: RunnerFilesListRouteDeps,
): Promise<{ binding: UsableRunnerBinding; now: number } | { error: Response }> {
  const readiness = resolveReadiness(deps.env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return { error: safeJson({ error: 'runner_files_unavailable', missing: readiness.missing }, 503) };
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return { error: safeJson({ error: 'unauthenticated' }, 401) };
  let user: AuthenticatedRunnerFilesUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return { error: safeJson({ error: 'unauthenticated' }, 401) };
  }
  if (!user || !isUuid(user.id)) return { error: safeJson({ error: 'unauthenticated' }, 401) };
  const binding = await getUsableRunnerBinding(deps.store, user.id);
  if (!binding) return { error: storageNotReadyResponse() };
  const now = Math.floor((deps.now ?? (() => Date.now() / 1000))());
  return { binding, now };
}

// Translate the runner's mutation response to a safe client response, mapping
// the runner's explicit statuses (400 bad name, 404 gone, 409 name taken) and
// never leaking a path, the user id, or the runner secret.
async function relayRunnerMutation(upstream: Response): Promise<Response> {
  if (upstream.status === 400) return safeJson({ error: 'invalid_file_name' }, 400);
  if (upstream.status === 404) return safeJson({ error: 'file_not_found' }, 404);
  if (upstream.status === 409) return safeJson({ error: 'file_exists' }, 409);
  if (!upstream.ok) return safeJson({ error: 'runner_files_unavailable' }, 502);
  const payload = await upstream.json().catch(() => null);
  return safeJson(isRecord(payload) && payload.ok === true ? payload : { ok: true }, 200);
}

export async function handleRunnerFileDeleteRequest(
  request: Request,
  fileId: string,
  deps: RunnerFilesListRouteDeps,
): Promise<Response> {
  if (request.method !== 'DELETE') return safeJson({ error: 'DELETE required' }, 405);
  if (!fileId) return safeJson({ error: 'file_not_found' }, 404);
  const auth = await authenticateAndResolveBinding(request, deps);
  if ('error' in auth) return auth.error;
  const { binding, now } = auth;
  let upstream: Response;
  try {
    upstream = await deps.fetchRunner(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json', ...buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now) },
    });
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }
  return relayRunnerMutation(upstream);
}

export async function handleRunnerFileRenameRequest(
  request: Request,
  fileId: string,
  deps: RunnerFilesListRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') return safeJson({ error: 'POST required' }, 405);
  if (!fileId) return safeJson({ error: 'file_not_found' }, 404);
  const body = await request.json().catch(() => null);
  const newName = isRecord(body) && typeof body.newName === 'string' ? body.newName.trim() : '';
  if (!newName) return safeJson({ error: 'invalid_file_name' }, 400);
  const auth = await authenticateAndResolveBinding(request, deps);
  if ('error' in auth) return auth.error;
  const { binding, now } = auth;
  let upstream: Response;
  try {
    upstream = await deps.fetchRunner(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${encodeURIComponent(fileId)}/rename`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now),
      },
      body: JSON.stringify({ newName }),
    });
  } catch {
    return safeJson({ error: 'runner_files_unavailable' }, 503);
  }
  return relayRunnerMutation(upstream);
}

export async function handleRunnerFileDownloadRequest(
  request: Request,
  fileId: string,
  deps: RunnerFileDownloadRouteDeps,
): Promise<Response> {
  if (request.method !== 'GET') return safeJson({ error: 'GET required' }, 405);

  const readiness = resolveReadiness(deps.env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'runner_file_unavailable', missing: readiness.missing }, 503);

  if (!isSafeFileId(fileId)) return safeJson({ error: 'file_not_found' }, 404);

  const signingSecret = fileLinkSigningSecret(deps.env);
  if (!signingSecret) return safeJson({ error: 'runner_file_unavailable', missing: ['SIDEKICK_FILE_LINK_SIGNING_SECRET'] }, 503);

  const token = new URL(request.url).searchParams.get('token');
  const now = Math.floor((deps.now ?? (() => Date.now() / 1000))());
  const verified = verifyRunnerFileDownloadToken(token, fileId, signingSecret, now);
  if (!verified) return safeJson({ error: 'unauthenticated' }, 401);

  const binding = await getUsableRunnerBinding(deps.store, verified.userId);
  if (!binding) return safeJson({ error: 'file_not_found' }, 404);

  const requestedRange = safeRunnerFileRangeHeader(request.headers.get('range'));
  const runnerHeaders = buildSidekickRunnerHeaders(binding.userId, binding.runnerSharedSecret, now);
  if (requestedRange) runnerHeaders.range = requestedRange.header;

  let upstream: Response;
  try {
    upstream = await deps.fetchRunner(`${binding.runnerBaseUrl}${RUNNER_FILES_PATH}/${fileId}`, {
      method: 'GET',
      headers: runnerHeaders,
    });
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

  const contentType = safeMimeType(upstream.headers.get('content-type'));
  const contentDisposition = safeContentDisposition(upstream.headers.get('content-disposition')) ?? `attachment; filename="${fileId}.bin"`;
  const responseHeaders: Record<string, string> = {
    'content-type': contentType,
    'content-disposition': contentDisposition,
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

export function createRunnerFileDownloadToken(input: RunnerFileDownloadTokenInput): string {
  const userId = requireNonEmpty(input.userId);
  const fileId = requireNonEmpty(input.fileId);
  const signingSecret = requireNonEmpty(input.signingSecret);
  if (!isUuid(userId) || !isSafeFileId(fileId)) throw new Error('invalid_runner_file_token_input');
  const issuedAt = Math.floor(input.now ?? Date.now() / 1000);
  const expiresAt = issuedAt + (input.ttlSeconds ?? DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS);
  const payload = `v1:${expiresAt}:${userId}:${fileId}`;
  const signature = createHmac('sha256', signingSecret).update(payload).digest('hex');
  return `v1.${expiresAt}.${userId}.${fileId}.${signature}`;
}

function verifyRunnerFileDownloadToken(
  token: string | null,
  expectedFileId: string,
  signingSecret: string,
  now: number,
): { userId: string } | null {
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
  const expected = createHmac('sha256', signingSecret).update(`v1:${expiresAt}:${userId}:${fileId}`).digest('hex');
  return constantTimeEqual(signature, expected) ? { userId } : null;
}

export function createSupabaseRunnerFilesStore(client: {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data?: unknown; error?: unknown }>;
      };
    };
  };
}): RunnerFilesStore {
  return {
    async getRunnerBinding(userId) {
      const result = await client
        .from('hermes_instance_private')
        .select('runner_base_url,runner_shared_secret')
        .eq('user_id', userId)
        .maybeSingle();
      if (result.error || !isRecord(result.data)) return null;
      return {
        userId,
        runnerBaseUrl: nonEmptyString(result.data.runner_base_url),
        runnerSharedSecret: nonEmptyString(result.data.runner_shared_secret),
      };
    },
  };
}

export function createSupabaseRunnerFilesAuthResolver(authClient: {
  auth: {
    getUser(token: string): Promise<{ data?: { user?: { id?: string } | null } | null; error?: unknown }>;
  };
}) {
  return async function getAuthenticatedUser(token: string): Promise<AuthenticatedRunnerFilesUser | null> {
    const result = await authClient.auth.getUser(token);
    if (result.error || !result.data?.user?.id) return null;
    return { id: result.data.user.id };
  };
}

function toSafeRunnerFileRecord(
  value: unknown,
  requestUrl: string,
  userId: string,
  signingSecret: string,
  now: number,
  ttlSeconds: number,
): SafeRunnerFileRecord | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const name = safeFileName(value.name);
  const sizeBytes = numberFrom(value.sizeBytes);
  const modifiedAt = numberFrom(value.modifiedAt);
  const mimeType = safeMimeType(nonEmptyString(value.mimeType));
  if (!id || !isSafeFileId(id) || !name || sizeBytes === null || modifiedAt === null) return null;
  if (sizeBytes < 0 || sizeBytes > MAX_SAFE_RUNNER_FILE_SIZE_BYTES || modifiedAt < 0) return null;

  const downloadToken = createRunnerFileDownloadToken({ userId, fileId: id, signingSecret, now, ttlSeconds });
  const downloadUrl = new URL(`/api/files/runner/${id}`, new URL(requestUrl).origin);
  downloadUrl.searchParams.set('token', downloadToken);

  const record: SafeRunnerFileRecord = {
    id,
    name,
    sizeBytes,
    modifiedAt,
    mimeType,
    downloadable: value.downloadable !== false,
    downloadUrl: downloadUrl.toString(),
    downloadToken,
  };
  const relativeName = safeRelativeName(value.relativeName);
  if (relativeName) record.relativeName = relativeName;
  return record;
}

function buildSidekickRunnerHeaders(userId: string, sharedSecret: string, now: number): Record<string, string> {
  const message = `v1:${userId}:${now}`;
  const digest = createHmac('sha256', sharedSecret).update(message).digest('hex');
  return {
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': String(now),
    'x-sidekick-runner-token': `v1.${digest}`,
  };
}

async function getUsableRunnerBinding(store: RunnerFilesStore, userId: string): Promise<UsableRunnerBinding | null> {
  let binding: RunnerBinding | null;
  try {
    binding = await store.getRunnerBinding(userId);
  } catch {
    return null;
  }
  if (!binding || !isUuid(binding.userId) || binding.userId !== userId) return null;
  const runnerBaseUrl = normalizeRunnerBaseUrl(binding.runnerBaseUrl);
  const runnerSharedSecret = nonEmptyString(binding.runnerSharedSecret);
  if (!runnerBaseUrl || !runnerSharedSecret) return null;
  return { userId, runnerBaseUrl, runnerSharedSecret };
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

function fileLinkSigningSecret(env: RunnerFilesServerEnv): string | null {
  return nonEmptyString(env.SIDEKICK_FILE_LINK_SIGNING_SECRET) ?? nonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY);
}

function safeJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function resolveReadiness(env: RunnerFilesServerEnv, required: Array<keyof RunnerFilesServerEnv>) {
  const missing = required.filter((name) => !nonEmptyString(env[name]));
  return { ok: missing.length === 0, missing: missing.map(String) };
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
  return raw;
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

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
