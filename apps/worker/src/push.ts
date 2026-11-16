// Push notifications: mint an FCM V1 token, send to a user's devices.
//
// WHY WE TALK TO GOOGLE DIRECTLY rather than routing through Expo's push
// service: the service-account key stays in our own vault instead of being
// uploaded to a third party, there is one less dependency in the delivery path,
// and the Worker already owns exactly this shape of secret (it holds the
// OpenRouter key on the same principle). What we give up is Expo's retry and
// receipt handling, which at our volume is a small amount of code we would
// rather own than outsource.
//
// The credential is `FCM_V1_SERVICE_ACCOUNT_JSON` (Doppler / Worker secret).
// It NEVER reaches the mobile app or the runner: the phone only ever holds its
// own device registration token, which is useless to anyone else.
//
// Everything here fails soft. A notification is a courtesy — it must never take
// down the chat turn that triggered it. Callers get `false`, not an exception.

export interface PushEnv {
  FCM_V1_SERVICE_ACCOUNT_JSON?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromString(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

/** PEM -> ArrayBuffer, for SubtleCrypto importKey. */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

function parseServiceAccount(env: PushEnv): ServiceAccount | null {
  const raw = (env.FCM_V1_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return parsed as ServiceAccount;
  } catch {
    return null;
  }
}

// Access tokens last an hour; minting one per send would add a round trip to
// every notification. Cached per isolate, refreshed a minute early so a token
// cannot expire mid-flight.
let cachedToken: { value: string; expiresAtMs: number } | null = null;

export function __resetPushTokenCacheForTests(): void {
  cachedToken = null;
}

export async function mintFcmAccessToken(env: PushEnv, nowMs = Date.now()): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAtMs > nowMs) return cachedToken.value;

  const sa = parseServiceAccount(env);
  if (!sa) return null;

  const nowSec = Math.floor(nowMs / 1000);
  const header = base64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlFromString(JSON.stringify({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signingInput = `${header}.${claim}`;

  let jwt: string;
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    );
    jwt = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    return null;
  }

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    });
    if (!response.ok) return null;
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    const ttlSec = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    cachedToken = { value: body.access_token, expiresAtMs: nowMs + Math.max(0, ttlSec - 60) * 1000 };
    return body.access_token;
  } catch {
    return null;
  }
}

export interface PushMessage {
  title: string;
  body: string;
  /** Small, non-sensitive routing hints for the app (e.g. which screen to open). */
  data?: Record<string, string>;
}

/**
 * Send one message to one device token.
 *
 * Returns 'sent', or 'dead' when Google says the token no longer maps to an
 * install (uninstalled, data cleared, token rotated). 'dead' is the caller's
 * signal to stop sending to it — see disableToken.
 */
export async function sendToDeviceToken(
  env: PushEnv,
  accessToken: string,
  projectId: string,
  deviceToken: string,
  message: PushMessage,
): Promise<'sent' | 'dead' | 'failed'> {
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: {
              // The work is already done by the time we notify, so the user
              // gains nothing from a notification that wakes the device
              // immediately. NORMAL lets Android batch and respect Doze.
              priority: 'NORMAL',
              notification: { channel_id: 'default' },
            },
          },
        }),
      },
    );
    if (response.ok) return 'sent';
    // UNREGISTERED / NOT_FOUND both mean "this install is gone".
    if (response.status === 404) return 'dead';
    if (response.status === 400) {
      const text = await response.text();
      if (/UNREGISTERED|INVALID_ARGUMENT/.test(text) && /token/i.test(text)) return 'dead';
      return 'failed';
    }
    return 'failed';
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Device registry + the notify decision
// ---------------------------------------------------------------------------

function supabaseKey(env: PushEnv): string {
  return (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY ?? '').trim();
}

function supabaseUrl(env: PushEnv, path: string, params: Record<string, string> = {}): string {
  const base = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const query = new URLSearchParams(params).toString();
  return `${base}/rest/v1/${path}${query ? `?${query}` : ''}`;
}

function pushSupabaseHeaders(env: PushEnv, contentType = false): Record<string, string> {
  const key = supabaseKey(env);
  const headers: Record<string, string> = { apikey: key, authorization: `Bearer ${key}` };
  if (contentType) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * Record a device against a user.
 *
 * Upsert on the TOKEN, not on (user, token): the same physical device can be
 * handed to a different account (sign out, sign in as someone else), and when
 * that happens the row's owner must MOVE rather than the device ending up
 * registered to both — otherwise one person's notifications land on another
 * person's phone. Re-registering also clears a previous disable, because a
 * token we are seeing again is demonstrably alive.
 */
export async function registerDeviceToken(
  env: PushEnv,
  userId: string,
  token: string,
  platform: 'android' | 'ios' = 'android',
): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length < 8 || trimmed.length > 512) return false;
  try {
    const response = await fetch(supabaseUrl(env, 'push_tokens', { on_conflict: 'token' }), {
      method: 'POST',
      headers: {
        ...pushSupabaseHeaders(env, true),
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        token: trimmed,
        user_id: userId,
        platform,
        disabled_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function activeTokensForUser(env: PushEnv, userId: string): Promise<string[]> {
  try {
    const response = await fetch(
      supabaseUrl(env, 'push_tokens', {
        select: 'token',
        user_id: `eq.${userId}`,
        disabled_at: 'is.null',
      }),
      { headers: pushSupabaseHeaders(env) },
    );
    if (!response.ok) return [];
    const rows = await response.json() as Array<{ token?: unknown }>;
    return rows.map((r) => (typeof r.token === 'string' ? r.token : '')).filter(Boolean);
  } catch {
    return [];
  }
}

async function disableToken(env: PushEnv, token: string, reason: string): Promise<void> {
  try {
    await fetch(supabaseUrl(env, 'push_tokens', { token: `eq.${token}` }), {
      method: 'PATCH',
      headers: { ...pushSupabaseHeaders(env, true), prefer: 'return=minimal' },
      body: JSON.stringify({ disabled_at: new Date().toISOString(), last_error: reason }),
    });
  } catch {
    // Best effort. A token we failed to disable gets retried next time and
    // disabled then; throwing here would fail the caller's chat turn instead.
  }
}

/**
 * Notify every live device a user has. Returns how many were delivered.
 *
 * Never throws. A missing credential, no registered devices, or a total
 * delivery failure all return 0, because the calling path is finishing a chat
 * turn and a courtesy notification must never be able to break it.
 */
export async function sendPushToUser(
  env: PushEnv,
  userId: string,
  message: PushMessage,
): Promise<number> {
  const sa = parseServiceAccount(env);
  if (!sa) return 0;
  const tokens = await activeTokensForUser(env, userId);
  if (!tokens.length) return 0;
  const accessToken = await mintFcmAccessToken(env);
  if (!accessToken) return 0;

  let delivered = 0;
  for (const token of tokens) {
    const outcome = await sendToDeviceToken(env, accessToken, sa.project_id, token, message);
    if (outcome === 'sent') delivered += 1;
    else if (outcome === 'dead') await disableToken(env, token, 'unregistered');
  }
  return delivered;
}

/** Why a turn ended. Chooses the WORDING; it no longer decides whether to send. */
export type TurnOutcome = 'approval_pending' | 'clarify_pending' | 'async_completion' | 'streamed';

/*
 * WHO GETS NOTIFIED: every device except the one being looked at — and the
 * Worker no longer tries to work out which that is. It sends on every
 * successful turn, and the PHONE stays quiet when the user is already in the
 * app (Notifications.setNotificationHandler, apps/mobile/src/push/registerForPush.ts).
 *
 * WHY THE SERVER STOPPED GUESSING (2026-08-03). The first version inferred
 * "nobody is watching" from the SSE connection dropping. Wrong twice over: a
 * CLOSED app fires it, but merely BACKGROUNDING the app does not, because the
 * process and the socket stay alive. Backgrounding is the common case and the
 * one Alex hit. The follow-up plan was server-side presence tracking, dropped
 * because its failure mode was silence — presence sticks on "foreground", the
 * user is never notified again, and nothing looks broken. Client-side
 * suppression fails the harmless way instead (a notification you did not need),
 * needs no endpoint, no stored state and no staleness handling, and is what
 * Slack, WhatsApp and Discord do.
 *
 * Consequence worth knowing: a turn finishing seconds after the user glances at
 * another app WILL buzz. If that proves noisy, gate it on turn duration. Do not
 * reintroduce presence tracking.
 */

/**
 * Notification copy.
 *
 * Says what happened and never quotes the conversation: a lock-screen preview
 * is visible to anyone holding the phone, and this is a business account whose
 * messages carry invoices, contracts and client names.
 */
export function buildTurnNotification(
  outcome: TurnOutcome,
  agentName: string,
): PushMessage | null {
  const name = agentName.trim() || 'Your coworker';
  switch (outcome) {
    case 'approval_pending':
      return {
        title: `${name} needs your approval`,
        body: 'A task is paused until you approve or decline it.',
        data: { kind: 'approval' },
      };
    case 'clarify_pending':
      return {
        title: `${name} has a question`,
        body: 'They need an answer before they can carry on.',
        data: { kind: 'clarify' },
      };
    case 'async_completion':
    case 'streamed':
      // 'streamed' used to mean "stay silent, they are watching". The phone
      // makes that call now, so this needs real wording rather than null.
      return {
        title: `${name} has finished`,
        body: 'Your reply is ready in the app.',
        data: { kind: 'reply' },
      };
    default:
      return null;
  }
}
