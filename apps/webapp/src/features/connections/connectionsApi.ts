import { CONNECTIONS_UNREACHABLE } from '@sidekick/shared';
import {
  connectionAuthorizeUrl, connectionFailureMessage, connectionRecord, connectionRequest,
  connectionStartedAccountId,
  parseComposioConnectionInventory, parseNativeConnectionInventory,
  type ComposioConnectionInventory, type NativeConnectionInventory,
} from '@mobile-logic/connections/connectionProtocol';
import { apiFetch, isFailure, type ApiRequestInit, type ApiResult } from '../../lib/api';

const OAUTH_PATH = '/api/connections/oauth';
const COMPOSIO_PATH = '/api/connections/composio';
export type ConnectionMutationResult = { ok: true } | { ok: false; message: string };
export type ConnectionStateResult = ({ ok: true } & NativeConnectionInventory) | { ok: false; message: string };
export type ComposioConnectionsResult = ({ ok: true } & ComposioConnectionInventory) | { ok: false; message: string };
export type ConnectionStartResult = { ok: true; authorizeUrl: string; connectedAccountId?: string } | { ok: false; message: string };
export type ConnectionCompleteResult = { ok: true } | { ok: false; code: string };
export interface ConnectionRequestOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }

const unreachable = () => ({ ok: false as const, message: CONNECTIONS_UNREACHABLE });

function request(path: string, init: ApiRequestInit, options: ConnectionRequestOptions): Promise<ApiResult<unknown>> {
  return connectionRequest<ApiResult<unknown>>(
    (signal) => apiFetch<unknown>(path, { ...init, signal }),
    { ok: false, status: 0, code: 'offline', serverCode: null, body: null, message: CONNECTIONS_UNREACHABLE },
    options,
  );
}

export async function fetchConnectionStates(options: ConnectionRequestOptions = {}): Promise<ConnectionStateResult> {
  const result = await request(OAUTH_PATH, {}, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode) };
  const inventory = parseNativeConnectionInventory(result.data);
  return inventory ? { ok: true, ...inventory } : unreachable();
}

export async function fetchComposioConnections(options: ConnectionRequestOptions = {}): Promise<ComposioConnectionsResult> {
  const result = await request(COMPOSIO_PATH, {}, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode) };
  const inventory = parseComposioConnectionInventory(result.data);
  return inventory && !inventory.brokerUnavailable ? { ok: true, ...inventory } : unreachable();
}

export async function startConnection(providerId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionStartResult> {
  const result = await request(`${OAUTH_PATH}/${encodeURIComponent(providerId)}/start`,
    { method: 'POST', body: { surface: 'web' } }, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode, true) };
  const authorizeUrl = connectionAuthorizeUrl(connectionRecord(result.data)?.authorizeUrl);
  return authorizeUrl ? { ok: true, authorizeUrl } : unreachable();
}

export async function startComposioConnection(toolkit: string, options: ConnectionRequestOptions = {}): Promise<ConnectionStartResult> {
  const result = await request(`${COMPOSIO_PATH}/initiate`,
    { method: 'POST', body: { toolkit, surface: 'web' } }, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode, true) };
  const authorizeUrl = connectionAuthorizeUrl(connectionRecord(result.data)?.redirectUrl);
  const connectedAccountId = connectionStartedAccountId(result.data);
  return authorizeUrl && connectedAccountId ? { ok: true, authorizeUrl, connectedAccountId } : unreachable();
}

export async function completeConnection(
  providerId: string, state: string, code: string, options: ConnectionRequestOptions = {},
): Promise<ConnectionCompleteResult> {
  const result = await request(`${OAUTH_PATH}/${encodeURIComponent(providerId)}/complete`,
    { method: 'POST', body: { state, code } }, options);
  if (isFailure(result)) return { ok: false, code: result.serverCode ?? 'complete_unconfirmed' };
  const body = connectionRecord(result.data);
  return body?.ok === true && body.provider === providerId ? { ok: true } : { ok: false, code: 'complete_unconfirmed' };
}

export async function disconnectConnection(providerId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionMutationResult> {
  const result = await request(`${OAUTH_PATH}/${encodeURIComponent(providerId)}`, { method: 'DELETE' }, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode) };
  const body = connectionRecord(result.data);
  return body?.ok === true && body.provider === providerId ? { ok: true } : unreachable();
}

/**
 * Addressed by SERVICE, not by one connected-account id. The card is per
 * service and its confirmation promises access stops, so the Worker removes
 * every grant this account holds for it and refuses to call a partial removal
 * a success. The account-addressed route still exists for older clients.
 */
export async function disconnectComposioService(serviceId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionMutationResult> {
  const result = await request(`${COMPOSIO_PATH}/service/${encodeURIComponent(serviceId)}`, { method: 'DELETE' }, options);
  if (isFailure(result)) return { ok: false, message: connectionFailureMessage(result.status, result.serverCode) };
  return connectionRecord(result.data)?.disconnected === true ? { ok: true } : unreachable();
}
