// WhatsApp + Signal ingress handlers. They mirror the Telegram pattern in
// apps/worker/src/index.ts but for two new channels.
//
// Wire-format references:
//   WhatsApp Cloud API   — https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
//   Signal-cli REST API  — https://bbernhard.github.io/signal-cli-rest-api/
//
// Both routes are guarded by feature flags so they can be turned on per
// environment as credentials become available:
//   SIDEKICK_WHATSAPP_WEBHOOK_ENABLED = "true"
//   SIDEKICK_SIGNAL_WEBHOOK_ENABLED   = "true"

import type { Env } from './index.js';

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

function safeJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Constant-time string compare for verification tokens. Prevents timing
// oracles on misconfigured webhook secrets.
function timingSafeEqualString(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// -----------------------------------------------------------------------------
// WhatsApp Cloud API ingress
// -----------------------------------------------------------------------------

export interface WhatsAppWebhookMessage {
  /** Plain-text body of the incoming WhatsApp message. */
  text: string;
  /** E.164 phone number of the sender, e.g. "+447801283442". */
  fromPhone: string;
  /** WhatsApp Business Phone Number ID that received the message. */
  toPhoneNumberId: string;
  /** Unique WAMID from WhatsApp — used as the idempotency key. */
  wamid: string;
  /** Best-effort sender name from Meta's webhook payload. May be blank. */
  fromName: string;
  /** Unix timestamp (seconds) per Meta's webhook payload. */
  timestamp: number;
}

/**
 * Parses Meta's webhook payload to a normalized message envelope. Returns
 * `null` when the payload is a status event / read receipt rather than an
 * inbound user message (Meta uses one envelope shape for everything).
 */
export function parseWhatsAppWebhookPayload(payload: unknown): WhatsAppWebhookMessage | null {
  if (!isRecord(payload) || payload.object !== 'whatsapp_business_account') return null;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!isRecord(change) || change.field !== 'messages') continue;
      const value = isRecord(change.value) ? change.value : null;
      if (!value) continue;
      const metadata = isRecord(value.metadata) ? value.metadata : null;
      const phoneNumberId = typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : '';
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        if (!isRecord(message)) continue;
        if (message.type !== 'text') continue;
        const text = isRecord(message.text) && typeof message.text.body === 'string' ? message.text.body : '';
        const wamid = typeof message.id === 'string' ? message.id : '';
        const fromPhone = typeof message.from === 'string' ? `+${message.from.replace(/[^0-9]/g, '')}` : '';
        const timestamp = typeof message.timestamp === 'string' ? Number.parseInt(message.timestamp, 10) : 0;
        if (!text || !wamid || !fromPhone) continue;
        const contact = contacts.find((c) => isRecord(c)) as Record<string, unknown> | undefined;
        const profile = contact && isRecord(contact.profile) ? contact.profile : null;
        const fromName = typeof profile?.name === 'string' ? profile.name : '';
        return {
          text,
          fromPhone,
          toPhoneNumberId: phoneNumberId,
          wamid,
          fromName,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        };
      }
    }
  }
  return null;
}

export async function handleWhatsAppWebhook(request: Request, env: Env): Promise<Response> {
  if (env.SIDEKICK_WHATSAPP_WEBHOOK_ENABLED !== 'true') {
    return safeJson({ error: 'WhatsApp ingress not enabled yet.' }, 501);
  }

  if (request.method === 'GET') {
    // Meta's one-time verification handshake. They GET the webhook with
    // hub.mode=subscribe and hub.verify_token; we must echo hub.challenge
    // verbatim if the token matches.
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const challenge = url.searchParams.get('hub.challenge');
    const token = url.searchParams.get('hub.verify_token');
    if (mode === 'subscribe' && timingSafeEqualString(token, env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? null)) {
      return new Response(challenge ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return safeJson({ error: 'forbidden' }, 403);
  }

  if (request.method !== 'POST') {
    return safeJson({ error: 'POST required' }, 405);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return safeJson({ error: 'invalid json' }, 400);
  }

  const message = parseWhatsAppWebhookPayload(payload);
  if (!message) {
    // Meta sends status updates and read receipts to the same endpoint.
    // Always 200 OK on non-message events so Meta doesn't disable the
    // webhook after consecutive non-2xx responses.
    return safeJson({ ok: true, ignored: 'non_message_event' }, 200);
  }

  // Dispatch to the user-binding lookup. Until the binding table is wired
  // (next session — needs Alex's Meta WABA), we record the event and
  // return 200 so Meta keeps the webhook subscription active.
  // TODO(E1): resolve binding via `messenger_bindings.whatsapp_phone =
  // message.fromPhone` and dispatch into the same handoff path Telegram
  // uses (TelegramIngressState → dispatchTelegramTaskToRunner generalised
  // to MessengerIngressState).
  return safeJson({
    ok: true,
    gatewayId: 'whatsapp',
    kind: 'pending_binding',
    publicReply: "Hi! WhatsApp delivery is coming online. Please use Telegram while it lights up.",
    seen: { wamid: message.wamid, fromName: message.fromName, length: message.text.length },
  }, 202);
}

// -----------------------------------------------------------------------------
// Signal-cli REST ingress
// -----------------------------------------------------------------------------

export interface SignalWebhookMessage {
  /** Plain-text body of the incoming Signal message. */
  text: string;
  /** E.164 phone number of the sender. */
  fromPhone: string;
  /** The Signal-cli account number that received the message. */
  toAccount: string;
  /** Unix timestamp (ms) of the message. */
  timestamp: number;
}

/**
 * Parses a signal-cli REST envelope to our normalized shape. signal-cli
 * delivers events shaped like:
 *   { envelope: { source: '+447...', sourceNumber: '+447...', timestamp: 1700, dataMessage: { message: 'hi', ... } }, account: '+44...' }
 */
export function parseSignalWebhookPayload(payload: unknown): SignalWebhookMessage | null {
  if (!isRecord(payload)) return null;
  const envelope = isRecord(payload.envelope) ? payload.envelope : null;
  if (!envelope) return null;
  const fromPhone =
    typeof envelope.sourceNumber === 'string'
      ? envelope.sourceNumber
      : typeof envelope.source === 'string'
      ? envelope.source
      : '';
  const dataMessage = isRecord(envelope.dataMessage) ? envelope.dataMessage : null;
  const text = typeof dataMessage?.message === 'string' ? dataMessage.message : '';
  const toAccount = typeof payload.account === 'string' ? payload.account : '';
  const timestamp = typeof envelope.timestamp === 'number' ? envelope.timestamp : 0;
  if (!text || !fromPhone || !toAccount) return null;
  return { text, fromPhone, toAccount, timestamp };
}

export async function handleSignalWebhook(request: Request, env: Env): Promise<Response> {
  if (env.SIDEKICK_SIGNAL_WEBHOOK_ENABLED !== 'true') {
    return safeJson({ error: 'Signal ingress not enabled yet.' }, 501);
  }

  if (request.method !== 'POST') {
    return safeJson({ error: 'POST required' }, 405);
  }

  // signal-cli-rest-api doesn't sign requests; we put it behind a bearer
  // token under our own control. The signal-cli Fly app is configured to
  // POST the bearer in `Authorization: Bearer <SIGNAL_REST_API_BEARER>`.
  const expectedBearer = (env.SIGNAL_REST_API_BEARER ?? '').trim();
  if (!expectedBearer) {
    return safeJson({ error: 'Signal ingress secret not configured.' }, 503);
  }
  const supplied = request.headers.get('authorization')?.trim() ?? '';
  if (!supplied.startsWith('Bearer ') || !timingSafeEqualString(supplied.slice(7), expectedBearer)) {
    return safeJson({ error: 'forbidden' }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return safeJson({ error: 'invalid json' }, 400);
  }

  const message = parseSignalWebhookPayload(payload);
  if (!message) {
    return safeJson({ ok: true, ignored: 'non_message_event' }, 200);
  }

  // Same TODO as WhatsApp — binding lookup lands when the messenger_bindings
  // table + the generalised messenger handoff path lands (next session).
  return safeJson({
    ok: true,
    gatewayId: 'signal',
    kind: 'pending_binding',
    publicReply: "Signal is coming online. Please use Telegram for now.",
    seen: { fromPhone: message.fromPhone, length: message.text.length, timestamp: message.timestamp },
  }, 202);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
