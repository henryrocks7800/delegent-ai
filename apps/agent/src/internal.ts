/**
 * Who may talk to the agent engine, and signed links to its files.
 *
 * The engine has no public address: the production Worker reaches it through a
 * service binding. Every request still carries the runner auth v1 headers the
 * Worker already sends to runners (x-sidekick-user-id, x-sidekick-runner-timestamp,
 * x-sidekick-runner-token = "v1." + HMAC-SHA256 over "v1:<user>:<timestamp>"),
 * signed with SIDEKICK_AGENT_SHARED_SECRET, so a misconfigured route could not
 * open anyone's conversation. The user in the signed header is the only identity
 * the engine trusts.
 */

export const AUTH_MAX_SKEW_SECONDS = 300;
/** The instance the operator's probe uses. It has no connections and no customer data. */
export const PROBE_USER = 'ops-probe';
/** How long a file link the coworker shares in the chat keeps working. */
export const FILE_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export function isAgentUserId(value: string): boolean {
  return value === PROBE_USER || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function signRequestToken(secret: string, userId: string, timestamp: number): Promise<string> {
  return `v1.${await hmacHex(secret, `v1:${userId}:${timestamp}`)}`;
}

/** The verified user id, or null. */
export async function verifyRequest(headers: Headers, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string | null> {
  if (!secret) return null;
  const userId = (headers.get('x-sidekick-user-id') ?? '').trim();
  const timestamp = Number.parseInt(headers.get('x-sidekick-runner-timestamp') ?? '', 10);
  const token = (headers.get('x-sidekick-runner-token') ?? '').trim();
  if (!isAgentUserId(userId) || !Number.isSafeInteger(timestamp) || !token.startsWith('v1.')) return null;
  if (Math.abs(nowSeconds - timestamp) > AUTH_MAX_SKEW_SECONDS) return null;
  const expected = await signRequestToken(secret, userId, timestamp);
  return timingSafeEqual(token, expected) ? userId : null;
}

/**
 * A link token for a file the coworker made or was sent:
 * v1.<expiresAt>.<userId>.<fileId>.<HMAC over "agent-file:v1:<expiresAt>:<userId>:<fileId>">.
 * The production Worker checks it at /api/files/agent/<fileId> (same secret).
 */
export async function fileLinkToken(secret: string, userId: string, fileId: string, expiresAt: number): Promise<string> {
  const signature = await hmacHex(secret, `agent-file:v1:${expiresAt}:${userId}:${fileId}`);
  return `v1.${expiresAt}.${userId}.${fileId}.${signature}`;
}

export async function verifyFileLinkToken(
  token: string | null,
  fileId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ userId: string } | null> {
  const parts = (token ?? '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || !secret) return null;
  const [, expiresRaw, userId, tokenFileId, signature] = parts;
  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds) return null;
  if (!isAgentUserId(userId) || tokenFileId !== fileId || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = await hmacHex(secret, `agent-file:v1:${expiresAt}:${userId}:${fileId}`);
  return timingSafeEqual(signature, expected) ? { userId } : null;
}

export async function fileLinkUrl(apiBase: string, secret: string, userId: string, fileId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const token = await fileLinkToken(secret, userId, fileId, nowSeconds + FILE_LINK_TTL_SECONDS);
  return `${apiBase.replace(/\/+$/, '')}/api/files/agent/${fileId}?token=${encodeURIComponent(token)}`;
}
