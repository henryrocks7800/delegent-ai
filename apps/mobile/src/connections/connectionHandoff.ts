import { connectionReturnNotice, findConnectableService, findConnectionState, type ConnectableService, type ConnectionReturnNotice } from '@sidekick/shared';
import { connectionStatesForService, type ConnectionInventory } from './connectionInventory';
import type { PendingConnectionHandoff } from './connectionHandoffStore';

type HandoffIdentity = {
  readonly service: ConnectableService;
  /** Ties a pending hand-off to its durable record, so a receipt or a clear
   * cannot land on an attempt that has already been replaced. */
  readonly attemptId?: string;
};

export type ConnectionHandoff =
  | (HandoffIdentity & { readonly kind: 'native'; readonly outcome: 'completing' | 'confirmed' | 'unconfirmed' | 'failed'; readonly code?: string })
  | (HandoffIdentity & {
    readonly kind: 'composio';
    /**
     * Null only for the older broker that linked the account inside its own
     * callback, where no id was ever handed out. Every hand-off this build
     * starts carries one, and it is checked exactly.
     */
    readonly connectedAccountId: string | null;
    readonly outcome?: 'failed';
    readonly code?: string;
  });

export type ConnectionHandoffOutcome =
  | { readonly kind: 'connected'; readonly accountLabel: string | null }
  | { readonly kind: 'checking' }
  | { readonly kind: 'unconfirmed'; readonly notice: ConnectionReturnNotice }
  | { readonly kind: 'failed'; readonly notice: ConnectionReturnNotice };

/** A read of an existing grant cannot replace an acknowledgement of this attempt. */
export function connectionHandoffOutcome(handoff: ConnectionHandoff, inventory: ConnectionInventory | null): ConnectionHandoffOutcome {
  const unknown = (): ConnectionHandoffOutcome => ({ kind: 'unconfirmed', notice: connectionReturnNotice(handoff.service, 'complete_unconfirmed') });
  const failed = (): ConnectionHandoffOutcome => ({ kind: 'failed', notice: connectionReturnNotice(handoff.service, handoff.code ?? 'complete_failed') });
  // A broker that said the grant did not complete is only believed once this
  // account's own fresh inventory agrees the grant is not there. Until then the
  // outcome is unknown, not a refusal.
  const missing = (): ConnectionHandoffOutcome => (handoff.outcome === 'failed' ? failed() : unknown());
  if (handoff.kind === 'native') {
    if (handoff.outcome === 'completing') return { kind: 'checking' };
    if (handoff.outcome === 'failed') return failed();
    if (handoff.outcome === 'unconfirmed') return unknown();
  }
  const states = connectionStatesForService(inventory, handoff.service);
  if (!states) return unknown();
  if (handoff.kind === 'composio' && handoff.connectedAccountId && !inventory?.composio.data?.connectedAccounts.some((account) =>
    account.id === handoff.service.id && account.connectedAccountId === handoff.connectedAccountId)) return missing();
  const state = findConnectionState(states, handoff.service.id);
  return state.status === 'connected' ? { kind: 'connected', accountLabel: state.accountLabel } : missing();
}

/**
 * What a durable record means after every mounted reference is gone.
 *
 * The one outcome this can never produce is `completing`. That state says a
 * completion request is in flight right now, which no restored record can be:
 * the process that was waiting for it is gone. A record whose completion may
 * already have been sent comes back unknown and read-only, because completion
 * is single use and replaying it would report an expired link over a
 * connection that landed.
 */
export function restoredConnectionHandoff(record: PendingConnectionHandoff): ConnectionHandoff | null {
  const service = findConnectableService(record.serviceId);
  if (!service || service.backend !== record.backend) return null;
  const identity = { service, attemptId: record.attemptId };
  if (record.backend === 'composio') {
    return record.receipt?.outcome === 'failed'
      ? { ...identity, kind: 'composio', connectedAccountId: record.connectedAccountId, outcome: 'failed', ...(record.receipt.code ? { code: record.receipt.code } : {}) }
      : { ...identity, kind: 'composio', connectedAccountId: record.connectedAccountId };
  }
  const receipt = record.receipt;
  if (receipt?.outcome === 'confirmed') return { ...identity, kind: 'native', outcome: 'confirmed' };
  if (receipt?.outcome === 'failed') return { ...identity, kind: 'native', outcome: 'failed', ...(receipt.code ? { code: receipt.code } : {}) };
  return { ...identity, kind: 'native', outcome: 'unconfirmed' };
}
