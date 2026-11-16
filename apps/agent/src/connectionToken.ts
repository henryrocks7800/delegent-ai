import { hmacHex } from './internal.ts';

/**
 * A fresh access token for a mailbox we broker ourselves, from the production
 * Worker (apps/worker/src/engine-connection-token.ts). Signed over the
 * protocol, user, timestamp and exact body with the shared engine secret. The
 * token is used for the current step and never stored by the engine.
 */
export const CONNECTION_TOKEN_PATH = '/internal/connection-token';

export async function connectionTokenHeaders(secret: string, userId: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  return {
    'content-type': 'application/json', 'x-sidekick-user-id': userId,
    'x-sidekick-token-timestamp': String(nowSeconds),
    'x-sidekick-token-signature': `v1.${await hmacHex(secret, `connection-token:v1:${userId}:${nowSeconds}:${body}`)}`,
  };
}

export class ConnectionTokenError extends Error {
  readonly code: 'not_connected' | 'needs_reauth' | 'unavailable';
  constructor(code: 'not_connected' | 'needs_reauth' | 'unavailable') { super(`connection_token_${code}`); this.code = code; }
}

export async function fetchConnectionToken(input: {
  apiBase: string; secret: string; userId: string; provider: 'yahoo_mail'; fetch?: typeof fetch;
}): Promise<{ accessToken: string; account: string }> {
  const base = new URL(input.apiBase);
  if (base.protocol !== 'https:' || base.username || base.password || !input.secret) throw new ConnectionTokenError('unavailable');
  const body = JSON.stringify({ provider: input.provider });
  const response = await (input.fetch ?? globalThis.fetch.bind(globalThis))(new URL(CONNECTION_TOKEN_PATH, base), {
    method: 'POST', headers: await connectionTokenHeaders(input.secret, input.userId, body), body,
    signal: AbortSignal.timeout(20_000), redirect: 'manual',
  });
  if (response.status === 404) throw new ConnectionTokenError('not_connected');
  if (response.status === 409) throw new ConnectionTokenError('needs_reauth');
  if (!response.ok) throw new ConnectionTokenError('unavailable');
  const value = await response.json().catch(() => null) as { accessToken?: unknown; account?: unknown } | null;
  if (!value || typeof value.accessToken !== 'string' || !value.accessToken || typeof value.account !== 'string') {
    throw new ConnectionTokenError('unavailable');
  }
  return { accessToken: value.accessToken, account: value.account };
}
