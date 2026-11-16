import { apiOrigin } from './env';
import { getFreshAccessToken } from './supabase';

// One authenticated fetch helper for every Worker call. Mirrors the mobile
// clients: bearer token, JSON in and out, and friendly messages for the status
// codes the Worker actually returns, so no screen ever shows a bare number.

export type ApiFailure = {
  ok: false;
  status: number;
  code: 'unauthenticated' | 'no_plan' | 'not_ready' | 'rate_limited' | 'invalid' | 'offline' | 'server';
  /**
   * The Worker's own `error` string when it sent one, e.g. `subscription_already_active`.
   * Status alone cannot tell the Stripe 409s apart. Never rendered as-is; a
   * screen maps it to its own copy.
   */
  serverCode: string | null;
  message: string;
  /**
   * The parsed error body, for the few callers that need a field out of it. A
   * refused downgrade carries the two storage numbers the reader has to see to
   * know how much to clear. Treat it as untrusted: read named fields, never
   * render it whole.
   */
  body: unknown;
};

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export function isFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return result.ok === false;
}

const MESSAGES: Record<ApiFailure['code'], string> = {
  unauthenticated: 'Sign in again to continue.',
  no_plan: 'This needs an active plan.',
  not_ready: 'Your workspace is still coming online. Try again in a moment.',
  rate_limited: 'That was a lot at once. Give it a few seconds and try again.',
  invalid: 'That did not look right. Check it and try again.',
  offline: 'We could not reach Delegent. Check your connection and try again.',
  server: 'Something went wrong on our side. Please try again in a moment.',
};

// The Worker answers 503 for almost anything momentarily unavailable: a
// dependency blipping, a proxy timeout, a cold runner. Only these codes mean
// the workspace genuinely has not finished being built. Reading every 503 as
// "coming online" tells someone whose workspace came online weeks ago to sit
// and wait for something that already happened, which is what the phone avoids
// by trusting an explicit field rather than the status code.
const NOT_READY_CODES = new Set(['runner_not_ready', 'worker_not_ready', 'not_ready']);

function codeForStatus(status: number, serverCode: string | null): ApiFailure['code'] {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 402) return 'no_plan';
  if (status === 503) return serverCode && NOT_READY_CODES.has(serverCode) ? 'not_ready' : 'server';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid';
  return 'server';
}

function fail(
  status: number,
  code: ApiFailure['code'],
  message?: string,
  serverCode?: string | null,
  body?: unknown,
): ApiFailure {
  return {
    ok: false,
    status,
    code,
    serverCode: serverCode ?? null,
    message: message?.trim() || MESSAGES[code],
    body: body ?? null,
  };
}

/** The Worker's machine-readable `error` field, when the body carried a short one. */
export function serverErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { error?: unknown }).error;
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}

/**
 * A server-supplied message is only shown when it is short, human, and free of
 * internal detail. Anything else falls back to our own copy, so a leaked stack
 * trace or provider error can never reach the screen.
 */
export function safeServerMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as { message?: unknown }).message;
  if (typeof raw !== 'string') return undefined;
  const message = raw.trim();
  if (!message || message.length > 200) return undefined;
  if (/https?:\/\/|\bat \w+\.|stack|undefined is not|\bfly\b|supabase|openrouter|hermes/i.test(message)) {
    return undefined;
  }
  return message;
}

export type ApiRequestInit = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers. Authorization and content-type are always set by us. */
  headers?: Record<string, string>;
};

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<ApiResult<T>> {
  // Same reasoning as the body read below. This is raw supabase-js, whose
  // storage adapter throws outright in a browser with storage blocked (Safari
  // private mode, third-party cookies off), and a rejection here escapes
  // apiFetch past every caller that only knows how to handle an ApiFailure.
  // The phone already guards both of these calls the same way, in
  // apps/mobile/src/chat/chatClient.ts.
  let token: string | null;
  try {
    token = await getFreshAccessToken();
  } catch {
    token = null;
  }
  // Authentication can finish after a caller's deadline or account teardown.
  // In particular, do not start a late POST after its UI has stopped waiting.
  if (init.signal?.aborted) return fail(0, 'offline');
  if (!token) return fail(401, 'unauthenticated');

  const headers: Record<string, string> = { ...init.headers, authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    const requestInit: RequestInit = { method: init.method ?? 'GET', headers };
    if (body !== undefined) requestInit.body = body;
    if (init.signal) requestInit.signal = init.signal;
    response = await fetch(`${apiOrigin}${path}`, requestInit);
  } catch {
    return fail(0, 'offline');
  }

  // Reading the body is a second chance to lose the connection, and it throws
  // rather than returning. Left uncaught it escapes apiFetch entirely, past
  // every caller that only knows how to handle an ApiFailure, which is how a
  // screen ends up stuck on its own "…ing" state with nothing to dismiss.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fail(0, 'offline');
  }

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const serverCode = serverErrorCode(parsed);
    return fail(
      response.status,
      codeForStatus(response.status, serverCode),
      safeServerMessage(parsed),
      serverCode,
      parsed,
    );
  }
  return { ok: true, data: (parsed ?? {}) as T };
}
