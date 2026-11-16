/**
 * Ad clicks: the near end of the advertising funnel.
 *
 * THE PROBLEM THIS SOLVES. On 2026-09-03 the live campaigns were diagnosed
 * against the APIs rather than the dashboards. Meta had billed us for 732 link
 * clicks. Google Play had recorded 3 installs in the whole of August. Nothing
 * we owned could say whether any of those clicks had ever loaded a page of
 * ours, because the marketing site carried no analytics tag at all and the
 * Meta Pixel had fired five times in its life, all on one afternoon and all of
 * them us. So "the advert is not working" and "the store page is not working"
 * were indistinguishable, which is the most expensive pair of possibilities to
 * be unable to tell apart.
 *
 * `install_attribution` measures the FAR end and remains the source of truth
 * for it: which advert produced a real, installed, signed-in user. It is blind
 * to everyone who clicks and does not install, which on current numbers is
 * essentially everyone. This module measures the near end so the gap between
 * the two becomes visible.
 *
 * WHY THIS IS NOT BEHIND THE COOKIE BANNER, and why that is not a shortcut.
 * `apps/website/src/lib/consent.ts` sets a deliberately strict rule: nothing
 * loads before an explicit yes, not even with consent mode denied. That rule
 * is right for the Meta Pixel, which is a third-party advertising technology
 * that stores identifiers on the visitor's device. It does not apply here,
 * because this stores and reads NOTHING on the device. The page forwards
 * parameters that we ourselves put in the URL, to our own server, and the
 * server keeps a count. Under PECR the consent requirement attaches to storage
 * and access on terminal equipment; there is none here.
 *
 * That distinction is the entire reason this is worth building. A
 * consent-gated counter would measure the minority who accept a banner, which
 * is precisely the population we already cannot see clearly.
 *
 * WHAT IS DELIBERATELY NOT STORED. No IP address, no user agent string, no
 * cookie, no device or advertising identifier, no user id, nothing that joins
 * to a person. The user agent is read once to bucket the visitor as
 * android/ios/other and is then discarded. Country comes from Cloudflare's
 * edge and stays at country granularity. See the migration
 * `0057_ad_clicks.sql`, which states the same constraint at the schema.
 */

export type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

/**
 * Only the marketing site may log an ad click.
 *
 * Deliberately tighter than the Worker's general CORS allowlist, which also
 * admits the web app and Firebase preview channels. Nothing but
 * `delegentai.co.uk` serves the advert landing page, so nothing else has any
 * business writing to this table.
 *
 * An `Origin` header is trivially forged by anything that is not a browser, so
 * this is a filter against casual noise rather than a security control. The
 * real protection is that the endpoint writes a fixed, tiny, non-identifying
 * shape: there is no field an attacker can fill with anything useful, no way
 * to read anything back, and the row costs us nothing to delete. It is
 * unauthenticated because the visitor has, by definition, no account yet.
 */
export const AD_CLICK_ALLOWED_ORIGINS: readonly string[] = [
  'https://delegentai.co.uk',
  'https://www.delegentai.co.uk',
];

export function isAllowedClickOrigin(origin: string | null | undefined): boolean {
  return Boolean(origin && AD_CLICK_ALLOWED_ORIGINS.includes(origin));
}

/** Where we sent the visitor. A coarse bucket, never a URL. */
export const AD_CLICK_DESTINATIONS = ['google_play', 'app_store', 'webapp', 'none'] as const;
export type AdClickDestination = (typeof AD_CLICK_DESTINATIONS)[number];

/**
 * What happened, and why the distinction is load-bearing.
 *
 * On a phone /install redirects straight to a store, so an arrival IS the
 * store visit: one visitor, one row. On desktop it shows a chooser, so an
 * arrival and a later store tap are two different events from ONE visitor.
 * Counting both as "clicks" would overstate desktop traffic twofold and make
 * every cost-per-click computed off this table wrong.
 */
export const AD_CLICK_EVENTS = ['arrival', 'store_tap'] as const;
export type AdClickEvent = (typeof AD_CLICK_EVENTS)[number];

export type ParsedAdClick = {
  rawQuery: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  metaCampaignId: string | null;
  metaAdsetId: string | null;
  metaAdId: string | null;
  metaPlacement: string | null;
};

/** Trim, reject empty, and cap. Every text column is bounded on the way in. */
function clean(v: string | null | undefined, max = 256): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  return t.slice(0, max);
}

/**
 * Pull the campaign parameters out of the landing page's query string.
 *
 * Meta resolves `{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}` and
 * `{{placement}}` at delivery time. An UNRESOLVED macro still contains braces,
 * which means the URL was built wrong or the click did not come from Meta;
 * either way storing the literal `{{campaign.id}}` would be worse than storing
 * nothing, because it would silently pollute every count. So braces are
 * rejected rather than kept.
 */
export function parseAdClickQuery(rawQuery: string): ParsedAdClick {
  const raw = (rawQuery ?? '').replace(/^\?/, '').slice(0, 2048);
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    params = new URLSearchParams();
  }

  const macro = (key: string): string | null => {
    const v = clean(params.get(key), 64);
    if (!v) return null;
    // An unresolved Meta macro, or anything else that is plainly not an id.
    if (v.includes('{{') || v.includes('}}')) return null;
    return v;
  };

  return {
    rawQuery: raw,
    utmSource: clean(params.get('utm_source'), 128),
    utmMedium: clean(params.get('utm_medium'), 128),
    utmCampaign: clean(params.get('utm_campaign'), 128),
    utmContent: clean(params.get('utm_content'), 512),
    metaCampaignId: macro('campaign_id'),
    metaAdsetId: macro('adset_id'),
    metaAdId: macro('ad_id'),
    metaPlacement: macro('placement'),
  };
}

/**
 * Bucket the visitor's platform, then forget the user agent.
 *
 * iPadOS 13+ reports itself as a Mac, so the touch hint is what catches it.
 * The page has already made the same decision client-side to choose a store;
 * this is recomputed here rather than trusted from the body so the two cannot
 * disagree about what we recorded.
 */
export function platformFromUserAgent(ua: string | null | undefined): 'android' | 'ios' | 'other' {
  const s = ua ?? '';
  if (/Android/i.test(s)) return 'android';
  if (/iPad|iPhone|iPod/i.test(s)) return 'ios';
  return 'other';
}

function normaliseDestination(v: unknown): AdClickDestination {
  return AD_CLICK_DESTINATIONS.includes(v as AdClickDestination) ? (v as AdClickDestination) : 'none';
}

function normaliseEvent(v: unknown): AdClickEvent {
  return AD_CLICK_EVENTS.includes(v as AdClickEvent) ? (v as AdClickEvent) : 'arrival';
}

/**
 * Record one click. Returns false on any failure, and the caller ignores it.
 *
 * Nothing about advertising measurement is worth failing a visitor's redirect
 * for. Every path here is best-effort by design.
 */
export async function recordAdClick(
  env: Env,
  parsed: ParsedAdClick,
  event: AdClickEvent,
  destination: AdClickDestination,
  platform: string,
  country: string | null,
): Promise<boolean> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return false;

  const res = await fetch(`${base}/rest/v1/ad_clicks`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      raw_query: parsed.rawQuery,
      utm_source: parsed.utmSource,
      utm_medium: parsed.utmMedium,
      utm_campaign: parsed.utmCampaign,
      utm_content: parsed.utmContent,
      meta_campaign_id: parsed.metaCampaignId,
      meta_adset_id: parsed.metaAdsetId,
      meta_ad_id: parsed.metaAdId,
      meta_placement: parsed.metaPlacement,
      event,
      destination,
      platform,
      country,
    }),
  }).catch(() => null);

  return Boolean(res && res.ok);
}

/**
 * `POST /api/ad/click`, called by `install.html` immediately before it
 * redirects to a store.
 *
 * Answers 204 unconditionally and as fast as possible, including when the
 * write fails or the body is rubbish. The caller is a `navigator.sendBeacon`
 * fired microseconds before the page navigates away: it cannot read the
 * response, retrying would be pointless, and an error status would only ever
 * show up as noise in somebody's console. Failing loudly here would trade a
 * measurement we are missing anyway for a worse experience on the one page
 * that has to convert.
 */
export async function handleAdClick(request: Request, env: Env): Promise<Response> {
  const noContent = new Response(null, { status: 204 });

  if (!isAllowedClickOrigin(request.headers.get('origin'))) return noContent;

  let body: { q?: unknown; d?: unknown; e?: unknown };
  try {
    const text = (await request.text()).slice(0, 4096);
    body = JSON.parse(text) as typeof body;
  } catch {
    return noContent;
  }

  const parsed = parseAdClickQuery(typeof body.q === 'string' ? body.q : '');

  // A click with no campaign parameters at all is somebody opening /install
  // directly. Real, but not advertising, and counting it would inflate every
  // cost-per-click we compute off this table.
  const hasCampaign = Boolean(
    parsed.utmSource || parsed.utmCampaign || parsed.metaCampaignId || parsed.metaAdId,
  );
  if (!hasCampaign) return noContent;

  const country = clean(request.headers.get('cf-ipcountry'), 8);
  await recordAdClick(
    env,
    parsed,
    normaliseEvent(body.e),
    normaliseDestination(body.d),
    platformFromUserAgent(request.headers.get('user-agent')),
    country && country !== 'XX' ? country : null,
  ).catch(() => false);

  return noContent;
}
