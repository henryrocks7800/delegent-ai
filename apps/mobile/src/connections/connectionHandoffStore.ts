import { CONNECTABLE_SERVICES, type ConnectableService } from '@sidekick/shared';

/**
 * The durable record of a connection hand-off that is still in the air.
 *
 * Both screens used to hold this in React refs, which last exactly as long as
 * the mounted component. That is the one thing a hand-off cannot rely on: the
 * phone swaps to the system browser for consent and can be evicted while it is
 * there, and the browser surface leaves the page altogether. Both come back to
 * a fresh mount with no memory of what was started, so the screen reads
 * whatever the broker happens to say, and an older unrelated grant for the same
 * service reads exactly like a successful return.
 *
 * WHAT IS KEPT, AND WHAT IS DELIBERATELY NOT. This holds the identity of the
 * attempt: which service, which broker, the `state` the broker minted for it,
 * and the exact Composio connected-account id it promised. It never holds an
 * authorization code, an access token or a refresh token. Those are single-use
 * or bearer credentials, they belong behind the Worker, and putting them in
 * AsyncStorage or sessionStorage would leave them where anything else on the
 * surface can read them.
 *
 * `completionSent` is written BEFORE the completion request leaves. Completion
 * is single use. If the process dies between sending it and hearing back, the
 * exchange may already have happened, so the restart has to report an unknown
 * outcome and re-read status. Replaying it would spend a consumed state and
 * announce "that connection link had expired" over a connection that landed.
 */

/**
 * Past this, an attempt is forgotten rather than answered for. The Worker's own
 * flow rows live 600 seconds, so anything near this is already unusable; the
 * extra room is so a slow consent journey still gets an honest answer rather
 * than silence.
 */
export const CONNECTION_HANDOFF_LIFETIME_MS = 30 * 60 * 1000;

const KEY_PREFIX = 'delegent.connections.handoff.v1.';

export type ConnectionHandoffOutcomeCode = 'confirmed' | 'failed' | 'unconfirmed';

export interface ConnectionHandoffReceipt {
  readonly outcome: ConnectionHandoffOutcomeCode;
  readonly code?: string;
}

export interface ConnectionHandoffAttempt {
  readonly attemptId: string;
  readonly serviceId: string;
  readonly backend: ConnectableService['backend'];
  /**
   * The OAuth `state` this flow was minted with. Not a credential: it names the
   * flow, and the Worker still refuses one that is expired, spent or another
   * account's. Held so a return can be matched to the attempt that produced it
   * after every mounted reference is gone.
   */
  readonly state: string | null;
  /**
   * The exact grant Composio promised at initiate. A different grant for the
   * same service, however recent, is not this attempt landing.
   */
  readonly connectedAccountId: string | null;
}

export interface PendingConnectionHandoff extends ConnectionHandoffAttempt {
  readonly startedAt: number;
  readonly completionSent: boolean;
  readonly receipt: ConnectionHandoffReceipt | null;
}

export interface ConnectionHandoffStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<unknown> | unknown;
  removeItem(key: string): Promise<unknown> | unknown;
}

export interface ConnectionHandoffStore {
  read(): Promise<PendingConnectionHandoff | null>;
  start(attempt: ConnectionHandoffAttempt): Promise<void>;
  markCompletionSent(attemptId: string): Promise<void>;
  recordReceipt(attemptId: string, receipt: ConnectionHandoffReceipt): Promise<void>;
  clear(attemptId?: string): Promise<void>;
}

const OUTCOMES: readonly string[] = ['confirmed', 'failed', 'unconfirmed'];

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

function parseReceipt(value: unknown): ConnectionHandoffReceipt | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.outcome !== 'string' || !OUTCOMES.includes(record.outcome)) return undefined;
  if (record.code === undefined) return { outcome: record.outcome as ConnectionHandoffOutcomeCode };
  const code = optionalString(record.code);
  return code ? { outcome: record.outcome as ConnectionHandoffOutcomeCode, code } : undefined;
}

/**
 * Rebuilt field by field from a whitelist, never spread from the parsed JSON.
 * Anything a future writer, an older build or a tampered store left alongside
 * these fields is dropped here rather than travelling on into the screen.
 */
export function parsePendingConnectionHandoff(raw: string | null): PendingConnectionHandoff | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const attemptId = optionalString(record.attemptId);
  const serviceId = optionalString(record.serviceId);
  if (!attemptId || !serviceId) return null;
  const service = CONNECTABLE_SERVICES.find((entry) => entry.id === serviceId);
  // The backend decides which broker is asked to confirm the return. A record
  // naming a service this build does not offer, or claiming the other broker
  // owns it, cannot be answered honestly, so it is discarded.
  if (!service || service.backend !== record.backend) return null;
  const state = optionalString(record.state);
  const connectedAccountId = optionalString(record.connectedAccountId);
  if (state === undefined || connectedAccountId === undefined) return null;
  const receipt = parseReceipt(record.receipt);
  if (receipt === undefined) return null;
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) return null;
  if (typeof record.completionSent !== 'boolean') return null;
  return {
    attemptId, serviceId, backend: service.backend, state, connectedAccountId,
    startedAt: record.startedAt, completionSent: record.completionSent, receipt,
  };
}

/** Unique per attempt on this device. Only ever compared for equality. */
export function newConnectionAttemptId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One store belongs to one authenticated account. The account id is the key,
 * not a field inside it, so a second account on the same device can neither
 * read nor overwrite the first one's attempt.
 *
 * Every mutation runs through one queue and re-reads the stored value inside
 * it. Without that, a hydrate racing a start, or a completion receipt racing a
 * disconnect, interleave their read and write, and the loser silently
 * reinstates a record the winner had just retired.
 */
export function createConnectionHandoffStore(
  storage: ConnectionHandoffStorage | null | undefined,
  options: { readonly userId: string; readonly now?: () => number; readonly lifetimeMs?: number },
): ConnectionHandoffStore {
  const usable = Boolean(storage) && typeof options.userId === 'string' && options.userId.length > 0;
  const key = `${KEY_PREFIX}${options.userId}`;
  const now = options.now ?? (() => Date.now());
  const lifetimeMs = options.lifetimeMs ?? CONNECTION_HANDOFF_LIFETIME_MS;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const remove = async (): Promise<void> => {
    if (!usable) return;
    // A store we cannot write is not a reason to fail somebody's connection.
    try { await storage!.removeItem(key); } catch { /* best effort */ }
  };
  const write = async (record: PendingConnectionHandoff): Promise<void> => {
    if (!usable) return;
    try { await storage!.setItem(key, JSON.stringify(record)); } catch { /* best effort */ }
  };
  const current = async (): Promise<PendingConnectionHandoff | null> => {
    if (!usable) return null;
    let raw: string | null = null;
    try { raw = await storage!.getItem(key); } catch { return null; }
    const record = parsePendingConnectionHandoff(raw);
    if (!record) { if (raw) await remove(); return null; }
    if (now() - record.startedAt > lifetimeMs) { await remove(); return null; }
    return record;
  };
  /** Applies only while the stored record is still the attempt being named. */
  const amend = (attemptId: string, change: (record: PendingConnectionHandoff) => PendingConnectionHandoff | null) =>
    serial(async () => {
      const record = await current();
      if (!record || record.attemptId !== attemptId) return;
      const next = change(record);
      if (next) await write(next);
    });

  return {
    read: () => serial(current),
    start: (attempt) => serial(async () => {
      const known = CONNECTABLE_SERVICES.some((entry) => entry.id === attempt.serviceId && entry.backend === attempt.backend);
      if (!attempt.attemptId || !known) { await remove(); return; }
      await write({
        attemptId: attempt.attemptId, serviceId: attempt.serviceId, backend: attempt.backend,
        state: attempt.state ?? null, connectedAccountId: attempt.connectedAccountId ?? null,
        startedAt: now(), completionSent: false, receipt: null,
      });
    }),
    markCompletionSent: (attemptId) =>
      amend(attemptId, (record) => (record.completionSent ? null : { ...record, completionSent: true })),
    recordReceipt: (attemptId, receipt) => amend(attemptId, (record) => ({ ...record, receipt })),
    clear: (attemptId) => serial(async () => {
      if (!attemptId) { await remove(); return; }
      const record = await current();
      if (!record || record.attemptId === attemptId) await remove();
    }),
  };
}

/**
 * The browser's store. Session scoped on purpose: it has to survive the
 * full-page navigation out to the provider and back, and it has no business
 * surviving the tab being closed. Absent in a hardened browser or a private
 * window with storage switched off, which is a surface with no memory of the
 * hand-off rather than an error worth showing anybody.
 */
export function sessionConnectionHandoffStorage(): ConnectionHandoffStorage | null {
  try {
    const storage = (globalThis as { sessionStorage?: ConnectionHandoffStorage | null }).sessionStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') return null;
    return storage;
  } catch {
    return null;
  }
}
