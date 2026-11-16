import type { Env } from './index.js';
import { usesAgentEngine } from './agent-engine.js';
import { engineConnectionToken } from './connections-oauth.js';

/**
 * POST /internal/connection-token, from the agent engine only.
 *
 * The engine reads a mailbox we broker ourselves (Yahoo Mail) and needs a fresh
 * access token for it. Same protection as /internal/inbox-notice: an HMAC over
 * the protocol, user, timestamp and exact body with the shared engine secret,
 * five minutes of skew, and the user must be on the engine. The body names only
 * the provider; the token goes back in the response and is never stored by the
 * engine.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1_024;

export async function handleEngineConnectionToken(request: Request, env: Env): Promise<Response> {
  const bad = (status: number) => new Response(null, { status });
  if (request.method !== 'POST') return bad(405);
  try {
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return bad(413);
    const body = await request.text();
    if (body.length > MAX_BYTES) return bad(413);
    const userId = await verified(request, (env.SIDEKICK_AGENT_SHARED_SECRET ?? '').trim(), body);
    if (!userId || !(await usesAgentEngine(env, userId))) return bad(401);
    let value: unknown;
    try { value = JSON.parse(body); } catch { return bad(400); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'provider') return bad(400);
    const provider = (value as { provider: unknown }).provider;
    if (typeof provider !== 'string' || !/^[a-z0-9_]{1,64}$/.test(provider)) return bad(400);
    return await engineConnectionToken(env, userId, provider);
  } catch { return bad(503); }
}

async function verified(request: Request, secret: string, body: string): Promise<string | null> {
  const userId = request.headers.get('x-sidekick-user-id') ?? '';
  const time = request.headers.get('x-sidekick-token-timestamp') ?? '';
  const token = request.headers.get('x-sidekick-token-signature') ?? '';
  if (!secret || !UUID.test(userId) || !/^\d{10}$/.test(time) || !/^v1\.[a-f0-9]{64}$/.test(token)
    || Math.abs(Date.now() / 1000 - Number(time)) > 300) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(token.slice(3).match(/../g)!, (byte) => Number.parseInt(byte, 16));
  return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`connection-token:v1:${userId}:${time}:${body}`)) ? userId : null;
}
