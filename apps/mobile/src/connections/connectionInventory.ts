import { CONNECTABLE_SERVICES, CONNECTIONS_UNREACHABLE, type ConnectableService, type ConnectionState } from '@sidekick/shared';
import type { ComposioConnectionInventory, NativeConnectionInventory } from './connectionProtocol';

type Failure = { error: { message: string } } | { ok: false; message: string };
type Read<T> = (options: { signal: AbortSignal }) => Promise<T | Failure>;
export type BrokerRead<T> = { readonly data: T | null; readonly status: 'pending' | 'read' | 'unreadable'; readonly message: string | null };
export interface ConnectionInventory {
  readonly native: BrokerRead<NativeConnectionInventory>;
  readonly composio: BrokerRead<ComposioConnectionInventory>;
  readonly states: readonly ConnectionState[];
  readonly available: readonly string[];
  readonly pending: boolean;
  readonly error: string | null;
}

function statesForComposio(data: ComposioConnectionInventory | null): readonly ConnectionState[] {
  return data?.ids.map((provider) => ({ provider, status: 'connected' as const, accountLabel: null, connectedAt: null })) ?? [];
}
function belongsTo(id: string, backend: ConnectableService['backend']): boolean {
  return CONNECTABLE_SERVICES.some((service) => service.id === id && service.backend === backend);
}

function combine(native: BrokerRead<NativeConnectionInventory>, composio: BrokerRead<ComposioConnectionInventory>): ConnectionInventory {
  const states = [
    ...(native.data?.states ?? []).filter((state) => belongsTo(state.provider, 'native')),
    ...statesForComposio(composio.data).filter((state) => belongsTo(state.provider, 'composio')),
  ];
  // A legacy native availability fallback must not offer unread Composio cards.
  const nativeOffered = native.data?.available === null
    ? CONNECTABLE_SERVICES.filter((service) => service.backend === 'native').map((service) => service.id)
    : native.data?.available ?? [];
  const available = [...new Set([
    ...nativeOffered.filter((id) => belongsTo(id, 'native')),
    ...(composio.data?.offered ?? []).filter((id) => belongsTo(id, 'composio')),
    ...states.map((state) => state.provider),
  ])];
  const failed = [native, composio].filter((broker) => broker.status === 'unreadable');
  const messages = [...new Set(failed.map((broker) => broker.message ?? CONNECTIONS_UNREACHABLE))];
  const stale = failed.some((broker) => broker.data !== null);
  return { native, composio, states, available,
    pending: native.status === 'pending' || composio.status === 'pending',
    error: messages.length ? `${stale ? 'Some cards show the last known connection status. ' : ''}${messages.join(' ')}` : null };
}

/** A cached card is useful display state, but cannot prove a browser return. */
export function connectionStatesForService(inventory: ConnectionInventory | null, service: ConnectableService): readonly ConnectionState[] | null {
  if (!inventory || inventory[service.backend].status !== 'read') return null;
  return inventory.states.filter((state) => belongsTo(state.provider, service.backend));
}

// The last inventory BOTH brokers answered for, per signed-in account. A reader
// given the account's key opens with every card already in place instead of
// filling in one broker at a time: the Connections list used to show two
// connections and then all of them, on every open (Alex, 2026-09-28). Remembered
// data is display only; it never counts as a fresh read, so it cannot prove a
// browser return (see connectionStatesForService).
type Settled = { native: NativeConnectionInventory; composio: ComposioConnectionInventory; at: number };
const settled = new Map<string, Settled>();
const prefetching = new Map<string, Promise<void>>();

function remember(key: string | undefined, native: BrokerRead<NativeConnectionInventory>, composio: BrokerRead<ComposioConnectionInventory>): void {
  if (!key || native.status !== 'read' || composio.status !== 'read' || !native.data || !composio.data) return;
  settled.set(key, { native: native.data, composio: composio.data, at: Date.now() });
}

/** Drop what is remembered: one account's, or everyone's on sign-out. */
export function forgetConnectionInventory(key?: string): void {
  if (key) settled.delete(key);
  else settled.clear();
}

function applyRead<T extends { brokerUnavailable: boolean }>(previous: BrokerRead<T>, result: T | Failure): BrokerRead<T> {
  if ('error' in result) return { ...previous, status: 'unreadable', message: result.error.message };
  if ('ok' in result && result.ok === false) return { ...previous, status: 'unreadable', message: result.message };
  const data = result as T;
  if (data.brokerUnavailable) return { ...previous, status: 'unreadable', message: CONNECTIONS_UNREACHABLE };
  return { data, status: 'read', message: null };
}

/**
 * One instance belongs to one mounted account. Each broker publishes
 * independently. With `rememberAs` (the signed-in account id), a broker that
 * has not answered yet shows that account's last settled cards, still marked
 * pending, and a read in which both brokers answer is remembered for next time.
 */
export function createConnectionInventory(readNative: Read<NativeConnectionInventory>, readComposio: Read<ComposioConnectionInventory>, rememberAs?: string) {
  let native: BrokerRead<NativeConnectionInventory> = { data: null, status: 'pending', message: null };
  let composio: BrokerRead<ComposioConnectionInventory> = { data: null, status: 'pending', message: null };
  let generation = 0;
  let controller: AbortController | null = null;
  const withRemembered = <T>(broker: BrokerRead<T>, remembered: T | undefined): BrokerRead<T> =>
    broker.data === null && remembered ? { ...broker, data: remembered } : broker;
  const snapshot = () => {
    const kept = rememberAs ? settled.get(rememberAs) : undefined;
    return combine(withRemembered(native, kept?.native), withRemembered(composio, kept?.composio));
  };
  const invalidate = () => { generation++; controller?.abort(); };
  return {
    snapshot, invalidate,
    async refresh(publish: (inventory: ConnectionInventory) => void): Promise<ConnectionInventory | null> {
      invalidate();
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      native = { ...native, status: 'pending', message: null };
      composio = { ...composio, status: 'pending', message: null };
      publish(snapshot());
      const safe = async <T>(read: Read<T>): Promise<T | Failure> => {
        try { return await read({ signal }); }
        catch { return { error: { message: CONNECTIONS_UNREACHABLE } }; }
      };
      await Promise.all([
        safe(readNative).then((result) => {
          if (generation !== current) return;
          native = applyRead(native, result); publish(snapshot());
        }),
        safe(readComposio).then((result) => {
          if (generation !== current) return;
          composio = applyRead(composio, result); publish(snapshot());
        }),
      ]);
      if (generation !== current) return null;
      remember(rememberAs, native, composio);
      return snapshot();
    },
  };
}

/**
 * Reads an account's connections in the background, so the list is complete
 * by the time Connections opens (the menu calls this as it opens). Skipped when
 * a settled read is younger than `maxAgeMs` or one is already running.
 */
export function prefetchConnectionInventory(
  key: string,
  readNative: Read<NativeConnectionInventory>,
  readComposio: Read<ComposioConnectionInventory>,
  maxAgeMs = 60_000,
): Promise<void> {
  if (!key) return Promise.resolve();
  const kept = settled.get(key);
  if (kept && Date.now() - kept.at < maxAgeMs) return Promise.resolve();
  const running = prefetching.get(key);
  if (running) return running;
  const job = createConnectionInventory(readNative, readComposio, key)
    .refresh(() => undefined)
    .then(() => undefined, () => undefined)
    .finally(() => { prefetching.delete(key); });
  prefetching.set(key, job);
  return job;
}
