import type { ConsentStorage, MetaConsentState } from './metaSdk';

export const advertisingConsentKey = (userId: string) => `delegent.advertisingConsent.v2.${userId}`;
type Choice = { state: MetaConsentState; deviceId: string; revision: number };
export type AdvertisingLease = { userId: string; valid: () => boolean };
type Deps = {
  storage: ConsentStorage;
  newDeviceId: () => string;
  apply: (enabled: boolean) => void;
  report: (userId: string, granted: boolean, deviceId: string, revision: number, current: () => boolean) => Promise<boolean>;
  capture: (lease: AdvertisingLease) => Promise<unknown>;
};

// One account at a time. Local intent is durable before network access; only a
// server acknowledgement enables collection. Every deferred device read/send
// carries a lease invalidated synchronously by withdrawal or account change.
export function createAdvertisingConsent(deps: Deps) {
  let userId: string | null = null;
  let generation = 0;
  let enabled = false;
  let choice: Choice | null = null;
  let ready = Promise.resolve();
  let writes = Promise.resolve();
  let requests = Promise.resolve();
  const disable = () => { enabled = false; deps.apply(false); };
  const current = (id: string, epoch: number) => userId === id && generation === epoch;
  const lease = (): AdvertisingLease | null => {
    if (!userId || !enabled) return null;
    const id = userId; const epoch = generation;
    return { userId: id, valid: () => enabled && current(id, epoch) };
  };
  const persist = (id: string, value: Choice) => {
    const task = writes.then(() => deps.storage.setItem(advertisingConsentKey(id), JSON.stringify(value)));
    writes = task.catch(() => undefined);
    return task;
  };
  const sync = async () => {
    await ready;
    if (!userId || !choice) return;
    const id = userId; const epoch = generation; const value = choice;
    const valid = () => current(id, epoch) && choice === value;
    const task = requests.then(async () => {
      if (!valid()) return;
      const ack = await deps.report(id, value.state === 'granted', value.deviceId, value.revision, valid).catch(() => false);
      if (!valid()) return;
      enabled = ack && value.state === 'granted';
      deps.apply(enabled);
      const permission = lease();
      if (permission) await deps.capture(permission).catch(() => undefined);
    });
    requests = task.catch(() => undefined);
    await requests;
  };
  const activate = async (id: string | null) => {
    if (userId === id) { await sync(); return; }
    userId = id; generation++; choice = null; disable();
    if (!id) return;
    const epoch = generation;
    ready = (async () => {
      // Never inherit a device-wide v1 grant from a different account.
      let stored: Choice | null = null;
      try {
        // A quick A -> B -> A switch must not read A's old grant while its
        // withdrawal is still being written to AsyncStorage.
        await writes;
        const raw = await deps.storage.getItem(advertisingConsentKey(id));
        const parsed = raw ? JSON.parse(raw) as Choice : null;
        if (parsed && ['granted', 'denied', 'unasked'].includes(parsed.state)
            && typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0
            && Number.isSafeInteger(parsed.revision) && parsed.revision > 0) stored = parsed;
      } catch { /* Unreadable storage never enables collection. */ }
      if (!current(id, epoch)) return;
      choice = stored ?? { state: 'unasked', deviceId: deps.newDeviceId(), revision: 1 };
      // Sending false for unasked also retires a legacy account-wide server grant.
      if (!stored) await persist(id, choice).catch(() => undefined);
    })();
    await ready; if (current(id, epoch)) await sync();
  };
  const decide = async (granted: boolean, authorize: () => Promise<boolean> = async () => true) => {
    // The fence changes BEFORE an ATT prompt or storage/network await.
    const id = userId; const epoch = ++generation; disable();
    await ready;
    if (!id || !current(id, epoch)) return;
    choice ??= { state: 'unasked', deviceId: deps.newDeviceId(), revision: 0 };
    const authorized = granted ? await authorize().catch(() => false) : false;
    if (!current(id, epoch)) return;
    const value: Choice = { ...choice, state: authorized ? 'granted' : 'denied', revision: choice.revision + 1 };
    choice = value;
    try { await persist(id, value); } catch {
      // A grant that cannot be saved must never enable this launch. Still send
      // a withdrawal so an older persisted grant cannot re-enable next launch.
      choice = { ...value, state: 'denied' };
    }
    if (current(id, epoch)) await sync();
  };
  return {
    activate, decide, sync, lease,
    state: async (): Promise<MetaConsentState> => { await ready; return choice?.state ?? 'unasked'; },
  };
}
