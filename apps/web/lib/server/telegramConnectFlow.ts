import { createHash, randomBytes } from 'node:crypto';
import { normalizeGatewayConnectCode } from '@sidekick/shared';

export interface TelegramConnectServerEnv {
  SUPABASE_URL?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SIDEKICK_TELEGRAM_BOT_USERNAME?: string | null;
  SIDEKICK_TELEGRAM_CONNECT_CODE_TTL_MINUTES?: string | null;
}

export interface AuthenticatedTelegramUser {
  id: string;
}

export interface TelegramConnectCodeInsert {
  user_id: string;
  gateway_id: 'telegram';
  code_hash: string;
  expires_at: string;
}

export interface TelegramConnectCodeStore {
  createConnectCode(input: TelegramConnectCodeInsert): Promise<void>;
}

export interface TelegramConnectRouteDeps {
  env: TelegramConnectServerEnv;
  getAuthenticatedUser(token: string, env: TelegramConnectServerEnv): Promise<AuthenticatedTelegramUser | null>;
  store: TelegramConnectCodeStore;
  createCode?: () => string;
  now?: () => number;
}

const TELEGRAM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 30;

export async function handleTelegramConnectCodeRequest(request: Request, deps: TelegramConnectRouteDeps): Promise<Response> {
  if (request.method !== 'POST') return safeJson({ error: 'POST required' }, 405);

  const readiness = resolveReadiness(deps.env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'telegram_connect_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  let user: AuthenticatedTelegramUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return safeJson({ error: 'unauthenticated' }, 401);
  }

  if (!user || !isUuid(user.id)) return safeJson({ error: 'unauthenticated' }, 401);

  const normalizedCode = normalizeGatewayConnectCode(deps.createCode?.() ?? createTelegramConnectCode());
  if (!normalizedCode) return safeJson({ error: 'telegram_connect_unavailable' }, 503);

  const ttlMinutes = connectCodeTtlMinutes(deps.env.SIDEKICK_TELEGRAM_CONNECT_CODE_TTL_MINUTES);
  const nowMs = deps.now?.() ?? Date.now();
  const expiresAt = new Date(nowMs + ttlMinutes * 60_000).toISOString();
  const codeHash = sha256Hex(normalizedCode);

  try {
    await deps.store.createConnectCode({
      user_id: user.id,
      gateway_id: 'telegram',
      code_hash: codeHash,
      expires_at: expiresAt,
    });
  } catch {
    return safeJson({ error: 'telegram_connect_unavailable' }, 503);
  }

  const botUsername = normalizeTelegramBotUsername(deps.env.SIDEKICK_TELEGRAM_BOT_USERNAME);
  return safeJson({
    gatewayId: 'telegram',
    code: formatTelegramConnectCode(normalizedCode),
    startParameter: normalizedCode,
    expiresAt,
    botUsername,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(normalizedCode)}` : null,
    instructions: botUsername
      ? `Open Telegram and send /start ${formatTelegramConnectCode(normalizedCode)} to @${botUsername}.`
      : `Open Telegram and send /start ${formatTelegramConnectCode(normalizedCode)} to your Delegent AI bot.`,
  }, 200);
}

export function createTelegramConnectCode(): string {
  const bytes = randomBytes(6);
  let suffix = '';
  for (let index = 0; index < bytes.length; index += 1) {
    suffix += TELEGRAM_CODE_ALPHABET[bytes[index] % TELEGRAM_CODE_ALPHABET.length];
  }
  return `TG${suffix}`;
}

export function formatTelegramConnectCode(code: string): string {
  const normalized = normalizeGatewayConnectCode(code);
  if (!normalized) return '';
  return `TG ${normalized.slice(2, 5)}-${normalized.slice(5)}`;
}

export function createSupabaseTelegramConnectStore(client: { from(table: string): any }): TelegramConnectCodeStore {
  return {
    async createConnectCode(input) {
      const result = await client
        .from('gateway_connect_codes')
        .insert(input)
        .select('id')
        .single();
      if (result.error) throw new Error('telegram_connect_code_insert_failed');
    },
  };
}

function resolveReadiness(env: TelegramConnectServerEnv, required: Array<keyof TelegramConnectServerEnv>) {
  const missing = required.filter((name) => !nonEmptyString(env[name]));
  return { ok: missing.length === 0, missing: missing.map(String) };
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return nonEmptyString(match?.[1]);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function connectCodeTtlMinutes(raw: string | null | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(parsed, MAX_TTL_MINUTES);
}

function normalizeTelegramBotUsername(raw: string | null | undefined): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;
  const withoutAt = value.replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(withoutAt)) return null;
  return withoutAt;
}
