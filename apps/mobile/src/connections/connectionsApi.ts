import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';
import { CONNECTIONS_UNREACHABLE } from '@sidekick/shared';
import {
  connectionAuthorizeUrl, connectionErrorCode, connectionFailureMessage, connectionRecord, connectionRequest,
  connectionStartedAccountId,
  parseComposioConnectionInventory, parseNativeConnectionInventory,
  type ComposioConnectionInventory, type NativeConnectionInventory,
} from './connectionProtocol';

// The client sees status and hand-off URLs only. Grants stay with the broker.
const OAUTH_PATH = '/api/connections/oauth';
const COMPOSIO_PATH = '/api/connections/composio';
const SIDEKICK_MOBILE_USER_AGENT = 'SidekickMobile/1.0 (Android)';

export type ConnectionActionError = { message: string };
export type ConnectionMutationResult = { ok: true } | { error: ConnectionActionError };
export type ConnectionStateResult = NativeConnectionInventory | { error: ConnectionActionError };
export type ComposioConnectionsResult = ComposioConnectionInventory | { error: ConnectionActionError };
export type ConnectionStartResult = { authorizeUrl: string; connectedAccountId?: string } | { error: ConnectionActionError };
export type ConnectionCompleteResult = { ok: true } | { code: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface ConnectionRequestOptions {
  readonly apiBaseUrl?: string | null;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type Attempt = { response: Response; payload: unknown } | { error: ConnectionActionError };
const unreachable = (): { error: ConnectionActionError } => ({ error: { message: CONNECTIONS_UNREACHABLE } });

async function authorizedRequest(
  path: string,
  init: { method: string; body?: string },
  options: ConnectionRequestOptions,
): Promise<Attempt> {
  return connectionRequest<Attempt>(async (signal) => {
    const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
    if (!apiBaseUrl) return { error: { message: 'Connections need the app link before they can be set up.' } };
    let accessToken: string | null = null;
    try {
      accessToken = mobileSupabase ? await getFreshMobileAccessToken(mobileSupabase) : null;
    } catch { accessToken = null; }
    // A refresh may resolve after this operation was abandoned. Never send a
    // delayed mutation or fall back to a remembered token after cancellation.
    if (signal.aborted) return unreachable();
    accessToken = accessToken ?? getRememberedMobileAccessToken();
    if (!accessToken) return { error: { message: connectionFailureMessage(401, null) } };
    const response = await (options.fetchImpl ?? fetch)(`${apiBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method, signal,
      headers: { accept: 'application/json', 'content-type': 'application/json',
        'user-agent': SIDEKICK_MOBILE_USER_AGENT, authorization: `Bearer ${accessToken}` },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    // The deadline includes JSON parsing, even if headers arrived immediately.
    const payload: unknown = await response.json().catch(() => null);
    return { response, payload };
  }, unreachable(), options);
}

function failed(attempt: { response: Response; payload: unknown }, starting = false): { error: ConnectionActionError } {
  return { error: { message: connectionFailureMessage(attempt.response.status, connectionErrorCode(attempt.payload), starting) } };
}

/** An unavailable or malformed broker is an unknown read, never an empty list. */
export async function fetchConnectionStates(options: ConnectionRequestOptions = {}): Promise<ConnectionStateResult> {
  const attempt = await authorizedRequest(OAUTH_PATH, { method: 'GET' }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt);
  return parseNativeConnectionInventory(attempt.payload) ?? unreachable();
}

export async function fetchComposioConnections(options: ConnectionRequestOptions = {}): Promise<ComposioConnectionsResult> {
  const attempt = await authorizedRequest(COMPOSIO_PATH, { method: 'GET' }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt);
  const inventory = parseComposioConnectionInventory(attempt.payload);
  // "Not configured" does not prove that this account has no existing grants.
  return inventory && !inventory.brokerUnavailable ? inventory : unreachable();
}

export async function startConnection(providerId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionStartResult> {
  const attempt = await authorizedRequest(`${OAUTH_PATH}/${encodeURIComponent(providerId)}/start`,
    { method: 'POST', body: JSON.stringify({ surface: 'app' }) }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt, true);
  const authorizeUrl = connectionAuthorizeUrl(connectionRecord(attempt.payload)?.authorizeUrl);
  return authorizeUrl ? { authorizeUrl } : unreachable();
}

export async function startComposioConnection(toolkitSlug: string, options: ConnectionRequestOptions = {}): Promise<ConnectionStartResult> {
  const attempt = await authorizedRequest(`${COMPOSIO_PATH}/initiate`,
    { method: 'POST', body: JSON.stringify({ toolkit: toolkitSlug, surface: 'app' }) }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt, true);
  const authorizeUrl = connectionAuthorizeUrl(connectionRecord(attempt.payload)?.redirectUrl);
  const connectedAccountId = connectionStartedAccountId(attempt.payload);
  return authorizeUrl && connectedAccountId ? { authorizeUrl, connectedAccountId } : unreachable();
}

/** Completion is single-use. An unknown acknowledgement must not replay it. */
export async function completeConnection(
  providerId: string, state: string, code: string, options: ConnectionRequestOptions = {},
): Promise<ConnectionCompleteResult> {
  const attempt = await authorizedRequest(`${OAUTH_PATH}/${encodeURIComponent(providerId)}/complete`,
    { method: 'POST', body: JSON.stringify({ state, code }) }, options);
  if ('error' in attempt) return { code: 'complete_unconfirmed' };
  if (!attempt.response.ok) return { code: connectionErrorCode(attempt.payload) ?? 'complete_unconfirmed' };
  const body = connectionRecord(attempt.payload);
  return body?.ok === true && body.provider === providerId ? { ok: true } : { code: 'complete_unconfirmed' };
}

export async function disconnectConnection(providerId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionMutationResult> {
  const attempt = await authorizedRequest(`${OAUTH_PATH}/${encodeURIComponent(providerId)}`, { method: 'DELETE' }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt);
  const body = connectionRecord(attempt.payload);
  return body?.ok === true && body.provider === providerId ? { ok: true } : unreachable();
}

/**
 * Addressed by SERVICE, not by one connected-account id. The card is per
 * service and its confirmation promises access stops, so the Worker removes
 * every grant this account holds for it and refuses to call a partial removal
 * a success. The account-addressed route still exists for older clients.
 */
export async function disconnectComposioService(serviceId: string, options: ConnectionRequestOptions = {}): Promise<ConnectionMutationResult> {
  const attempt = await authorizedRequest(`${COMPOSIO_PATH}/service/${encodeURIComponent(serviceId)}`, { method: 'DELETE' }, options);
  if ('error' in attempt) return attempt;
  if (!attempt.response.ok) return failed(attempt);
  return connectionRecord(attempt.payload)?.disconnected === true ? { ok: true } : unreachable();
}
