/**
 * Meta Conversions API: tell Meta, from our server, that a click it sold us
 * turned into a sign-up or a purchase.
 *
 * THE PROBLEM THIS SOLVES. Meta optimises delivery towards whatever it can
 * measure. Today it can measure a click and nothing after it, so it buys the
 * cheapest clicker in the country (2026-09-03 to 06: half the spend went to
 * women over 65, who click and never install). The Meta SDK in the app would
 * close that loop, but it reads the advertising ID and is consent-gated, so on
 * current numbers it reports nobody. This path needs no SDK and no consent
 * prompt: Meta appends a click id (`fbclid`) to every outbound advert click,
 * install.html carries it into the Play install referrer, the app hands the
 * referrer to the Worker on first sign-in, and from then on we can send Meta
 * "the person behind click X signed up" and "click X bought a subscription".
 *
 * WHAT IS SENT, AND WHAT IS NOT. The click id Meta itself issued, the event
 * name, a timestamp, an idempotency id, and for a purchase the amount and
 * currency. No email, no name, no phone, no IP address, no user agent, no
 * device identifier, no external id, no user id of ours. Meta's "match
 * quality" would be higher with those, and that is precisely why they are not
 * here. The click id is the join, and nothing else is needed for the join.
 *
 * SWITCHED OFF UNTIL ALEX SAYS OTHERWISE. `SIDEKICK_META_CAPI_ENABLED` must
 * read "true" and both the pixel id and the access token must be present,
 * else every function here is a no-op. The privacy policy paragraph that
 * describes this ("Install source") ships in the same change and must be live
 * before the flag is.
 *
 * NEVER ON THE HOT PATH. Everything here is best-effort and swallows its own
 * failures: a Meta outage or a bad token must not affect sign-in, the Stripe
 * webhook, billing or provisioning. The callers run these through
 * `ctx.waitUntil` after the response is built.
 */

import { AGENT_PLAN, SIDEKICK_FREE_TRIAL } from '@sidekick/shared';

export type MetaCapiEnv = {
  SIDEKICK_META_CAPI_ENABLED?: string;
  /** The pixel / dataset id. Public by design (it ships in page source). */
  SIDEKICK_META_PIXEL_ID?: string;
  /** A Conversions API access token generated for that dataset in Events Manager. Secret. */
  SIDEKICK_META_CAPI_ACCESS_TOKEN?: string;
  /** Set only while proving the wiring in Events Manager's "Test events" tab. */
  SIDEKICK_META_CAPI_TEST_EVENT_CODE?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export const META_GRAPH_VERSION = 'v21.0';

/** Where the click landed. Every advert links here, so it is the honest source URL. */
export const META_EVENT_SOURCE_URL = 'https://delegentai.co.uk/install';

export function metaCapiEnabled(env: MetaCapiEnv): boolean {
  return env.SIDEKICK_META_CAPI_ENABLED === 'true'
    && Boolean(env.SIDEKICK_META_PIXEL_ID)
    && Boolean(env.SIDEKICK_META_CAPI_ACCESS_TOKEN);
}

/**
 * Read a Meta click id out of a query string or a Play referrer string.
 *
 * Meta appends `fbclid` to the URL of every advert click. A real one is a
 * long URL-safe token; anything that is not that shape (an unresolved macro,
 * a stray word, something oversized) is rejected rather than stored, for the
 * same reason an unresolved `{{campaign.id}}` is rejected upstream: a bad
 * value would pollute every later join.
 */
export function extractFbclid(raw: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const v = (params.get('fbclid') ?? '').trim();
  if (v.length < 8 || v.length > 512) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return v;
}

/**
 * Meta's `fbc` format: `fb.1.<click time in ms>.<fbclid>`. The `1` is the
 * subdomain index Meta documents for a first-party domain. The click time is
 * Play's own referrer_click_at where we have it, else when we captured the
 * referrer, which is the closest honest stand-in.
 */
export function buildFbc(fbclid: string, clickAtMs: number): string {
  const ms = Number.isFinite(clickAtMs) && clickAtMs > 0 ? Math.floor(clickAtMs) : Date.now();
  return `fb.1.${ms}.${fbclid}`;
}

export type MetaEventInput = {
  eventName: 'CompleteRegistration' | 'Purchase';
  /** Idempotency key. Meta de-duplicates on (event_name, event_id) for 48 hours. */
  eventId: string;
  fbclid: string;
  clickAtMs: number;
  eventTimeSec?: number;
  value?: number;
  currency?: string;
};

/** The exact body sent to Meta. Kept as a pure function so tests can pin its shape. */
export function buildMetaEventPayload(input: MetaEventInput, testEventCode?: string): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: input.eventTimeSec ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: 'website',
    event_source_url: META_EVENT_SOURCE_URL,
    user_data: { fbc: buildFbc(input.fbclid, input.clickAtMs) },
  };
  if (input.eventName === 'Purchase') {
    event.custom_data = {
      value: typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : 0,
      currency: (input.currency ?? 'GBP').toUpperCase(),
    };
  }
  const body: Record<string, unknown> = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;
  return body;
}

export type MetaSendResult = { sent: boolean; status: number | null; reason: string | null };

/** POST one event. Never throws. */
export async function sendMetaEvent(
  env: MetaCapiEnv,
  input: MetaEventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaSendResult> {
  if (!metaCapiEnabled(env)) return { sent: false, status: null, reason: 'disabled' };
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${env.SIDEKICK_META_PIXEL_ID}/events`;
  const body = buildMetaEventPayload(input, env.SIDEKICK_META_CAPI_TEST_EVENT_CODE);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: env.SIDEKICK_META_CAPI_ACCESS_TOKEN }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, status: res.status, reason: text.slice(0, 200) };
    }
    return { sent: true, status: res.status, reason: null };
  } catch (err) {
    return { sent: false, status: null, reason: (err as Error).message.slice(0, 200) };
  }
}

/** What the purchase path needs from install_attribution: the click id and when the click was. */
export type AttributionClick = { fbclid: string; clickAtMs: number };

export async function lookupAttributionClick(
  env: MetaCapiEnv,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AttributionClick | null> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return null;
  try {
    const res = await fetchImpl(
      `${base}/rest/v1/rpc/get_consented_install_attribution`,
      { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_user_id: userId }) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ fbclid?: string | null; referrer_click_at?: string | null; captured_at?: string | null }>;
    const row = rows[0];
    if (!row?.fbclid) return null;
    const clickAtMs = Date.parse(row.referrer_click_at ?? row.captured_at ?? '') || Date.now();
    return { fbclid: row.fbclid, clickAtMs };
  } catch {
    return null;
  }
}

/**
 * Sign-up: called when the app hands over the Play referrer on first sign-in.
 * The event id is the user id, so a reinstall or a redelivery cannot count
 * twice. Nothing about the user travels: the id is only a de-duplication key
 * on Meta's side and is never used to match a person.
 */
export async function maybeSendMetaSignupEvent(
  env: MetaCapiEnv,
  input: { userId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MetaSendResult> {
  if (!metaCapiEnabled(env)) return { sent: false, status: null, reason: 'disabled' };
  // Never trust a click captured by an earlier queued job. Withdrawal may have
  // completed since then, or this may be a reinstall through another advert.
  const click = await lookupAttributionClick(env, input.userId, fetchImpl);
  if (!click) return { sent: false, status: null, reason: 'no_fbclid' };
  return sendMetaEvent(env, {
    eventName: 'CompleteRegistration',
    eventId: `signup:${hashForEventId(input.userId)}`,
    fbclid: click.fbclid,
    clickAtMs: click.clickAtMs,
  }, fetchImpl);
}

/** Read the user id off a Stripe Checkout session the way the welcome email does. */
export function extractCheckoutUserId(session: Record<string, unknown> | null): string | null {
  if (!session) return null;
  const meta = session.metadata;
  if (meta && typeof meta === 'object') {
    const v = (meta as Record<string, unknown>).sidekickUserId;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const cri = session.client_reference_id;
  return typeof cri === 'string' && cri.trim() ? cri.trim() : null;
}

/**
 * Purchase: runs after the Stripe webhook response, on
 * Paid checkouts use amount_total. Trial subscriptions report positive paid
 * invoices after conversion instead, never their zero-value checkout. Invoice
 * IDs deduplicate invoice.paid and invoice.payment_succeeded redeliveries.
 */
export async function maybeSendMetaPurchaseEvent(
  env: MetaCapiEnv,
  input: { responseOk: boolean; eventType: string; session: Record<string, unknown> | null },
  fetchImpl: typeof fetch = fetch,
): Promise<MetaSendResult> {
  if (!input.responseOk) return { sent: false, status: null, reason: 'webhook_not_ok' };
  const isInvoice = input.eventType === 'invoice.paid' || input.eventType === 'invoice.payment_succeeded';
  if (input.eventType !== 'checkout.session.completed' && !isInvoice) return { sent: false, status: null, reason: 'not_checkout_completed' };
  if (!metaCapiEnabled(env)) return { sent: false, status: null, reason: 'disabled' };
  const record = input.session;
  const parent = record?.parent as { subscription_details?: { metadata?: Record<string, unknown> } } | null;
  const legacyDetails = record?.subscription_details as { metadata?: Record<string, unknown> } | null;
  const invoiceMetadata = parent?.subscription_details?.metadata ?? legacyDetails?.metadata;
  // Existing paid-intro subscribers still report their checkout once. Only
  // trial-cohort invoices use this additional path, avoiding double counting.
  if (isInvoice && invoiceMetadata?.introductoryOfferId !== SIDEKICK_FREE_TRIAL.offerId
    && invoiceMetadata?.introductoryOfferId !== AGENT_PLAN.freeTrialOfferId) {
    return { sent: false, status: null, reason: 'not_trial_invoice' };
  }
  const amountMinor = isInvoice ? record?.amount_paid : record?.amount_total;
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor) || amountMinor <= 0) {
    return { sent: false, status: null, reason: 'no_positive_payment' };
  }
  if ((isInvoice && record?.status !== 'paid') || (!isInvoice && record?.payment_status !== 'paid')) {
    return { sent: false, status: null, reason: 'payment_not_paid' };
  }
  const userId = extractCheckoutUserId(isInvoice ? { metadata: invoiceMetadata } : record);
  if (!userId) return { sent: false, status: null, reason: 'no_user_id' };
  const click = await lookupAttributionClick(env, userId, fetchImpl);
  if (!click) return { sent: false, status: null, reason: 'no_fbclid' };
  const sessionId = typeof input.session?.id === 'string' ? (input.session.id as string) : hashForEventId(userId);
  const currency = typeof input.session?.currency === 'string' ? (input.session.currency as string) : 'gbp';
  return sendMetaEvent(env, {
    eventName: 'Purchase',
    eventId: `purchase:${sessionId}`,
    fbclid: click.fbclid,
    clickAtMs: click.clickAtMs,
    value: Math.round(amountMinor) / 100,
    currency,
  }, fetchImpl);
}

/**
 * The event id must be stable and unique per user, and it must not be the
 * user id itself: a de-duplication key is the one place an identifier of ours
 * would otherwise leak to Meta. FNV-1a over the id is enough for uniqueness
 * across our user base and is one-way for practical purposes.
 */
export function hashForEventId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
