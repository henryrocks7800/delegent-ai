import {
  CONNECTABLE_SERVICES,
  CONNECTIONS_DISCONNECT_UNCONFIRMED,
  CONNECTIONS_NOT_TURNED_ON,
  CONNECTIONS_NO_PLAN,
  CONNECTIONS_PARTLY_DISCONNECTED,
  CONNECTIONS_RATE_LIMITED,
  CONNECTIONS_SIGN_IN_AGAIN,
  CONNECTIONS_UNREACHABLE,
  CONNECTIONS_WORKSPACE_STARTING,
  type ConnectionState,
} from '@sidekick/shared';

export const CONNECTION_REQUEST_TIMEOUT_MS = 15_000;

/** Bounds authentication, headers AND body. A timed-out mutation is never replayed. */
export async function connectionRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  failure: T,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<T>((resolve) => {
    abort = () => { controller.abort(); resolve(failure); };
    timer = setTimeout(abort, options.timeoutMs ?? CONNECTION_REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    if (options.signal?.aborted) { abort(); return failure; }
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)).catch(() => failure), stopped]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function connectionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
const isAccountId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(isId);
const nullableText = (value: unknown) => value === undefined || value === null || typeof value === 'string';

export interface NativeConnectionInventory {
  readonly states: readonly ConnectionState[];
  readonly available: readonly string[] | null;
  readonly brokerUnavailable: boolean;
}

export interface ComposioConnectionInventory {
  readonly ids: readonly string[];
  readonly offered: readonly string[];
  /**
   * Every grant, not one per service. Disconnect is addressed by service now,
   * precisely because reducing this to one id per service is what let a second
   * live grant survive a disconnect the reader had been told took effect.
   */
  readonly connectedAccounts: readonly { id: string; connectedAccountId: string }[];
  readonly brokerUnavailable: boolean;
}

/** A malformed envelope or row invalidates the read, rather than proving absence. */
export function parseNativeConnectionInventory(value: unknown): NativeConnectionInventory | null {
  const body = connectionRecord(value);
  if (!body || body.error !== undefined || !Array.isArray(body.connections)) return null;
  if (body.available !== undefined && !isIds(body.available)) return null;
  const states: ConnectionState[] = [];
  const seen = new Set<string>();
  for (const value of body.connections) {
    const row = connectionRecord(value);
    if (!row || !isId(row.provider) || seen.has(row.provider)
      || (row.status !== 'connected' && row.status !== 'needs_reauth')
      || !nullableText(row.accountLabel) || !nullableText(row.connectedAt)) return null;
    seen.add(row.provider);
    states.push({ provider: row.provider, status: row.status,
      accountLabel: typeof row.accountLabel === 'string' ? row.accountLabel.trim() || null : null,
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : null });
  }
  // Only a missing availability field supports the historical Worker fallback.
  return { states, available: body.available === undefined ? null : body.available as string[], brokerUnavailable: false };
}

export function parseComposioConnectionInventory(value: unknown): ComposioConnectionInventory | null {
  const body = connectionRecord(value);
  if (!body || body.error !== undefined || typeof body.available !== 'boolean' || !Array.isArray(body.connections)) return null;
  if (body.offered !== undefined && !isIds(body.offered)) return null;
  if (!body.available && (body.connections.length || (body.offered as string[] | undefined)?.length)) return null;
  const connectedAccounts: { id: string; connectedAccountId: string }[] = [];
  const seen = new Set<string>();
  for (const value of body.connections) {
    const row = connectionRecord(value);
    if (!row || !isId(row.id) || !isAccountId(row.connectedAccountId)
      || seen.has(row.connectedAccountId) || (row.toolkit !== undefined && !isId(row.toolkit))) return null;
    seen.add(row.connectedAccountId);
    connectedAccounts.push({ id: row.id, connectedAccountId: row.connectedAccountId });
  }
  return {
    ids: [...new Set(connectedAccounts.map((row) => row.id))],
    offered: body.available ? (body.offered as string[] | undefined)
      ?? CONNECTABLE_SERVICES.filter((service) => service.backend === 'composio').map((service) => service.id) : [],
    connectedAccounts,
    brokerUnavailable: !body.available,
  };
}

export function connectionErrorCode(value: unknown): string | null {
  const code = connectionRecord(value)?.error;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}

export function connectionFailureMessage(status: number, code: string | null, starting = false): string {
  if (status === 401 || status === 403) return CONNECTIONS_SIGN_IN_AGAIN;
  if (status === 402) return CONNECTIONS_NO_PLAN;
  if (status === 429) return CONNECTIONS_RATE_LIMITED;
  // Both mean the coworker may still be able to reach the account, which is the
  // opposite of what the confirmation said. Neither may fall through to the
  // generic "try again in a moment", which reads as though nothing happened.
  if (code === 'partial_disconnect') return CONNECTIONS_PARTLY_DISCONNECTED;
  if (code === 'disconnect_unconfirmed') return CONNECTIONS_DISCONNECT_UNCONFIRMED;
  if (starting && (code === 'provider_not_configured' || code === 'connections_unavailable' || code === 'not_configured')) {
    return CONNECTIONS_NOT_TURNED_ON;
  }
  if (status === 503 && (code === 'runner_not_ready' || code === 'worker_not_ready' || code === 'not_ready')) {
    return CONNECTIONS_WORKSPACE_STARTING;
  }
  return CONNECTIONS_UNREACHABLE;
}

export function connectionAuthorizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function connectionStartedAccountId(value: unknown): string | null {
  const id = connectionRecord(value)?.connectedAccountId;
  return isAccountId(id) ? id : null;
}
