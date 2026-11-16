// Mobile chat client, talks to the Worker's `/api/chat/*` endpoints.
//
// Returns normalized records. Never accepts raw assistant-engine output,
// never exposes provider internals (workspace URLs, machine ids,
// server-side service-role keys, raw engine logs). All identifiers,
// sizes, and statuses are strictly typed and bounded.

import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { normalizePublicApiBaseUrl } from '../billing/mobileCheckout';

declare const process: {
  env: Record<string, string | undefined>;
};

export type ChatMessageStatus = 'queued' | 'dispatched' | 'complete' | 'failed';
export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

// v1.2.7, each assistant message carries an ordered list of tool
// calls the agent made while answering. Mobile renders them as inline
// cards above the coworker's reply (e.g. "✎ file, created test.txt").
export interface ChatToolCall {
  tool: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  taskRunId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  attachments: readonly ChatAttachment[];
  toolCalls: readonly ChatToolCall[];
}

export interface ChatConversation {
  id: string;
  agentName: string;
  lastMessageAt: string | null;
}

export type ChatRunStatus = 'queued' | 'dispatched' | 'succeeded' | 'failed';

export interface ChatRunSnapshot {
  runId: string;
  status: ChatRunStatus;
  errorCode: string | null;
  kind: string;
  completedAt: string | null;
  assistantMessage: ChatMessage | null;
}

export type ChatErrorReason =
  | 'unauthenticated'
  | 'no_active_subscription'
  | 'runner_not_ready'
  | 'runner_waking_up'
  | 'quota_exhausted'
  | 'content_required'
  | 'content_too_long'
  | 'chat_setup_required'
  | 'chat_unavailable'
  | 'missing_api_base'
  | 'not_found';

export type ChatResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { reason: ChatErrorReason; message: string } };

const expoApiBase =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

export const mobileChatApiBaseUrl = normalizePublicApiBaseUrl(expoApiBase);

const REFRESH_SKEW_SECONDS = 60;

type MobileSessionClient = {
  auth: {
    getSession(): Promise<{ data?: { session?: { access_token?: string | null; expires_at?: number | null } | null } | null; error?: unknown }>;
    refreshSession?(): Promise<{ data?: { session?: { access_token?: string | null; expires_at?: number | null } | null } | null; error?: unknown }>;
  };
};

async function getFreshAccessToken(client: MobileSessionClient | null): Promise<string | null> {
  if (!client) return getRememberedMobileAccessToken();
  let session: { access_token?: string | null; expires_at?: number | null } | null = null;
  try {
    const current = await client.auth.getSession();
    if (!current.error) session = current.data?.session ?? null;
  } catch {
    session = null;
  }
  const needsRefresh =
    !session ||
    typeof session.expires_at !== 'number' ||
    session.expires_at - Math.floor(Date.now() / 1000) <= REFRESH_SKEW_SECONDS;
  if (needsRefresh && client.auth.refreshSession) {
    try {
      const refreshed = await client.auth.refreshSession();
      if (!refreshed.error) session = refreshed.data?.session ?? session;
    } catch {
      // Handled below by falling through to the remembered token.
    }
  }
  return (session?.access_token ?? '').trim() || getRememberedMobileAccessToken();
}

interface ChatRequestOptions {
  apiBaseUrl?: string | null;
  client?: MobileSessionClient | null;
  fetchImpl?: typeof fetch;
}

async function makeRequest<T>(
  path: string,
  init: RequestInit,
  options: ChatRequestOptions = {},
): Promise<ChatResult<T>> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileChatApiBaseUrl);
  if (!apiBaseUrl) return failure('missing_api_base', 'Chat needs the app link before it can load.');

  const client = options.client === undefined ? mobileSupabase : options.client;
  const accessToken = client
    ? await getFreshAccessToken(client)
    : await getFreshMobileAccessToken(mobileSupabase);
  if (!accessToken) return failure('unauthenticated', 'Sign in again to use chat.');

  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${apiBaseUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return failure('chat_unavailable', 'Chat is offline. Try again in a moment.');
  }

  if (response.status === 401) return failure('unauthenticated', 'Sign in again to use chat.');
  if (response.status === 402) {
    const body = await safeJson(response);
    const reason = body?.error === 'no_active_subscription' || body?.error === 'runner_not_ready' || body?.error === 'quota_exhausted'
      ? body.error
      : 'chat_unavailable';
    const message =
      reason === 'no_active_subscription'
        ? "Your subscription isn't active. Open billing to fix it."
        : reason === 'runner_not_ready'
        ? "Your coworker isn't online yet. They're still being set up."
        : reason === 'quota_exhausted'
        ? quotaExhaustedMessage(body)
        : 'Chat is unavailable just now. Try again in a moment.';
    return failure(reason as ChatErrorReason, message);
  }
  if (response.status === 404) return failure('not_found', 'That message has already been cleaned up.');
  if (!response.ok) {
    const body = await safeJson(response);
    const reason =
      body?.error === 'content_required' ? 'content_required'
      : body?.error === 'content_too_long' ? 'content_too_long'
      : body?.error === 'chat_setup_required' ? 'chat_setup_required'
      : 'chat_unavailable';
    const message =
      reason === 'content_required'
        ? 'Type something to send.'
        : reason === 'content_too_long'
        // [R8] After inlining a large attachment the combined payload
        // exceeded the worker cap. Tell the user what to do instead of
        // the generic "trim it" copy which doesn't apply to attachments.
        ? "That file is too big to attach right now. Drop a smaller one (under 60 KB of text) or paste the relevant section into the chat."
        : reason === 'chat_setup_required'
        ? "Chat isn't fully wired up yet. Operator: apply migration 0023 from the install page."
        : 'Chat is unavailable just now. Try again in a moment.';
    return failure(reason as ChatErrorReason, message);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return failure('chat_unavailable', 'Chat reply was malformed.');
  }
  return { ok: true, value: parsed as T };
}

function quotaExhaustedMessage(body: { pause?: unknown } | null): string {
  const pause = body && typeof body.pause === 'object' && body.pause !== null
    ? body.pause as { primary?: unknown; secondary?: unknown }
    : null;
  const primary = typeof pause?.primary === 'string' ? pause.primary.trim() : '';
  const secondary = typeof pause?.secondary === 'string' ? pause.secondary.trim() : '';
  const fromWorker = [primary, secondary].filter(Boolean).join(' ');
  return fromWorker || "You've used this month's included assistant time, so I've paused new tasks for now. You can upgrade to keep going today, or wait until your next billing cycle starts.";
}

async function safeJson(response: Response): Promise<{ error?: string; pause?: unknown } | null> {
  try {
    return (await response.json()) as { error?: string; pause?: unknown };
  } catch {
    return null;
  }
}

function failure(reason: ChatErrorReason, message: string): { ok: false; error: { reason: ChatErrorReason; message: string } } {
  return { ok: false, error: { reason, message } };
}

// ---------------------------------------------------------------------------
// API surface, what HomeChatPanel calls
// ---------------------------------------------------------------------------

export async function listConversations(options: ChatRequestOptions = {}): Promise<ChatResult<{ conversations: ChatConversation[] }>> {
  return makeRequest<{ conversations: ChatConversation[] }>(`/api/chat/conversations`, { method: 'GET' }, options);
}

// Best-effort pre-warm of the user's scale-to-zero runner. Called when the chat
// screen mounts / returns to foreground so the box boots while the user is still
// typing, cutting the cold-boot delay on the first message. Fire-and-forget: the
// caller ignores the result and never blocks the UI on it.
export async function warmRunner(options: ChatRequestOptions = {}): Promise<ChatResult<{ ok: boolean; warmed: boolean }>> {
  return makeRequest<{ ok: boolean; warmed: boolean }>(`/api/chat/warm`, { method: 'POST', body: '{}' }, options);
}

export async function listMessages(
  conversationId: string,
  options: ChatRequestOptions & { limit?: number; before?: string } = {},
): Promise<ChatResult<{ conversationId: string; messages: ChatMessage[] }>> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.before) params.set('before', options.before);
  const query = params.toString() ? `?${params.toString()}` : '';
  return makeRequest(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    { method: 'GET' },
    options,
  );
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  attachments?: readonly ChatAttachment[];
}

export interface SendMessageResponse {
  conversationId: string;
  userMessage: ChatMessage;
  assistantPlaceholder: ChatMessage;
  taskRunId: string;
}

export async function sendMessage(
  input: SendMessageInput,
  options: ChatRequestOptions = {},
): Promise<ChatResult<SendMessageResponse>> {
  return makeRequest(
    `/api/chat/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: input.content,
        attachments: input.attachments ?? [],
      }),
    },
    options,
  );
}

export async function getRunStatus(
  runId: string,
  options: ChatRequestOptions = {},
): Promise<ChatResult<ChatRunSnapshot>> {
  return makeRequest<ChatRunSnapshot>(`/api/chat/runs/${encodeURIComponent(runId)}`, { method: 'GET' }, options);
}

/**
 * Poll `getRunStatus` every `intervalMs` until status is `succeeded`,
 * `failed`, or `timeoutMs` elapses. Caller is responsible for cancelling
 * via AbortSignal if the user navigates away.
 */
export async function pollRunUntilComplete(
  runId: string,
  options: ChatRequestOptions & {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSnapshot?: (snapshot: ChatRunSnapshot) => void;
  } = {},
): Promise<ChatResult<ChatRunSnapshot>> {
  const interval = Math.max(options.intervalMs ?? 1500, 500);
  // v2.0.1: poll past the worker's 150s dispatch ceiling (raised from 90s for
  // real agentic tasks) so the client sees the true result/error instead of a
  // premature client-side timeout while the runner is still finishing.
  const deadline = Date.now() + Math.max(options.timeoutMs ?? 180_000, 5000);

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return failure('chat_unavailable', 'Chat poll cancelled.');
    const result = await getRunStatus(runId, options);
    if (!result.ok) return result;
    options.onSnapshot?.(result.value);
    if (result.value.status === 'succeeded' || result.value.status === 'failed') {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return failure('chat_unavailable', "Your coworker took too long to reply. Try again.");
}
