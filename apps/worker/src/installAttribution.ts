/**
 * Install attribution: which advert produced which user.
 *
 * The problem this solves. On 2026-08-06 a campaign produced 43 clicks and zero
 * installs, and nothing could say where people were lost. Meta's own docs give
 * half the answer: "When you first complete app setup, you can only optimize
 * delivery of your ads for LINK_CLICK." Until Meta can measure installs it
 * optimises for the cheapest tap, which is a different population from people
 * who actually install.
 *
 * This is the FIRST-PARTY half, and it deliberately does not depend on Meta.
 * Google Play attaches a referrer string to every install, and expo-application
 * (already in the shipped 2.2.0 binary; it arrived with expo-notifications) can
 * read it from JavaScript. So this ships over the air with no Play release, and
 * gives us our own cost per campaign whatever Meta chooses to credit.
 *
 * Design rules, each of which exists for a reason:
 *
 *   1. FIRST capture wins, always. Play only serves the referrer once, on first
 *      launch, and only for 90 days. A later write must never overwrite the
 *      original, or a reinstall would silently relabel an old user.
 *   2. The raw string is stored verbatim and forever. Every parsed field is a
 *      derivation and derivations have bugs; the raw value is what lets a fix be
 *      applied retrospectively.
 *   3. A decryption failure is RECORDED, never swallowed. A silent failure would
 *      look exactly like organic traffic, which is the most expensive possible
 *      way to be wrong about advertising.
 */

import { extractFbclid } from './metaCapi.js';

export type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /**
   * Meta's Install Referrer Decryption Key, from the Meta App Dashboard under
   * Settings > Basic > Android. Optional on purpose: without it we still capture
   * and store every referrer, we simply cannot expand Meta's encrypted payload.
   * Attribution degrades, it does not break.
   */
  SIDEKICK_META_INSTALL_REFERRER_KEY?: string;
};

export type ParsedReferrer = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  metaCampaignId: string | null;
  metaAdgroupId: string | null;
  metaAdId: string | null;
  metaAccountId: string | null;
  /**
   * Which surface the advert was shown on, from Meta's `{{placement}}` macro.
   *
   * Only ever present on a referrer WE built, in `install.html`. Meta's own
   * encrypted payload does not carry it. Added 2026-09-03 because placement
   * turned out to be the whole story: 99.9% of one campaign's impressions went
   * to Audience Network rewarded video, which produced clicks at 27% and
   * installs at nil, and nothing in this table could show it.
   */
  metaPlacement: string | null;
  /**
   * Meta's click id, carried into the referrer by install.html since
   * 2026-09-08. Only ever present on a referrer WE built. Read by the
   * Conversions API path (metaCapi.ts) and by nothing else.
   */
  fbclid: string | null;
  decryptError: string | null;
};

/**
 * Pull the plain UTM parts out of a Play referrer string.
 *
 * An organic install looks like "utm_source=google-play&utm_medium=organic".
 * The string arrives URL-encoded, and Play does not guarantee any particular
 * key being present, so every field is optional.
 */
export function parsePlainReferrer(raw: string): Pick<ParsedReferrer, 'utmSource' | 'utmMedium' | 'utmCampaign'> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { utmSource: null, utmMedium: null, utmCampaign: null };
  }
  const clean = (v: string | null) => {
    const t = (v ?? '').trim();
    return t.length > 0 && t.length <= 512 ? t : null;
  };
  return {
    utmSource: clean(params.get('utm_source')),
    utmMedium: clean(params.get('utm_medium')),
    utmCampaign: clean(params.get('utm_campaign')),
  };
}

/**
 * Meta hides its campaign metadata inside utm_content as
 * {"data": "<hex>", "nonce": "<hex>"}, encrypted AES-256-GCM.
 *
 * Note the tag handling, which is the thing that catches people out: the
 * ciphertext has the 16-byte GCM authentication tag APPENDED, so it has to be
 * split off and set separately before decryption. Meta's own sample uses
 * libsodium, which hides that detail; WebCrypto does not, but it also expects
 * the tag appended, so we pass the buffer through whole.
 */
export async function decryptMetaReferrer(
  raw: string,
  hexKey: string,
): Promise<{ payload: Record<string, unknown> | null; error: string | null }> {
  let content: string | null = null;
  try {
    content = new URLSearchParams(raw).get('utm_content');
  } catch {
    return { payload: null, error: 'referrer_not_parseable' };
  }
  if (!content) return { payload: null, error: null }; // not a Meta referrer, not an error

  let envelope: { source?: { data?: string; nonce?: string }; data?: string; nonce?: string };
  try {
    envelope = JSON.parse(content) as typeof envelope;
  } catch {
    return { payload: null, error: null }; // utm_content present but not Meta's shape
  }
  // Meta documents the pair under `source`, but has also been observed at the
  // top level. Accept both rather than losing the data on a shape change.
  const data = envelope.source?.data ?? envelope.data;
  const nonce = envelope.source?.nonce ?? envelope.nonce;
  if (!data || !nonce) return { payload: null, error: null };

  if (!hexKey) return { payload: null, error: 'no_decryption_key_configured' };

  try {
    const fromHex = (h: string) => {
      const bytes = new Uint8Array(h.length / 2);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return bytes;
    };
    const key = await crypto.subtle.importKey('raw', fromHex(hexKey), { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(nonce), tagLength: 128 },
      key,
      fromHex(data),
    );
    const text = new TextDecoder().decode(plain);
    return { payload: JSON.parse(text) as Record<string, unknown>, error: null };
  } catch {
    // Recorded, not swallowed. A failed decrypt that looked like organic traffic
    // would be the most expensive kind of wrong.
    // Parser errors may quote decrypted input. Store a code, never that text.
    return { payload: null, error: 'decrypt_failed' };
  }
}

/**
 * Read campaign ids that are sitting in the referrer as PLAIN parameters.
 *
 * There are two kinds of referrer and they carry the same facts differently.
 *
 *   - An advert pointing straight at the Play Store gets Meta's own referrer,
 *     which hides the ids inside an AES-GCM encrypted `utm_content`. That is
 *     what `decryptMetaReferrer` above is for.
 *   - An advert pointing at our own `/install` page has no Meta referrer at
 *     all, because Meta never touches the store URL. `install.html` builds the
 *     referrer itself and writes the ids in plainly.
 *
 * Both shapes must land in the same columns or the table answers different
 * questions depending on how a campaign happened to be configured, which is
 * exactly the sort of silent inconsistency that makes attribution untrustworthy.
 * An unresolved `{{macro}}` is rejected rather than stored, for the same reason
 * it is rejected in adClicks.ts: a literal would pollute every later count.
 */
export function parsePlainMetaIds(
  raw: string,
): Pick<ParsedReferrer, 'metaCampaignId' | 'metaAdgroupId' | 'metaAdId' | 'metaPlacement'> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { metaCampaignId: null, metaAdgroupId: null, metaAdId: null, metaPlacement: null };
  }
  const clean = (key: string) => {
    const v = (params.get(key) ?? '').trim();
    if (!v || v.length > 128 || v.includes('{{') || v.includes('}}')) return null;
    return v;
  };
  return {
    metaCampaignId: clean('campaign_id'),
    // Meta calls it an ad set; the encrypted payload calls it an adgroup. Same
    // thing, and the column is named for the payload, so accept either spelling.
    metaAdgroupId: clean('adset_id') ?? clean('adgroup_id'),
    metaAdId: clean('ad_id'),
    metaPlacement: clean('placement'),
  };
}

export async function parseReferrer(raw: string, env: Env): Promise<ParsedReferrer> {
  const plain = parsePlainReferrer(raw);
  const plainIds = parsePlainMetaIds(raw);
  const { payload, error } = await decryptMetaReferrer(raw, env.SIDEKICK_META_INSTALL_REFERRER_KEY ?? '');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null);
  const num = (v: unknown) => (typeof v === 'number' ? String(v) : str(v));
  // The encrypted payload wins where it exists: it comes from Meta itself and
  // cannot have been edited by anyone in the click path. The plain values are
  // the fallback for referrers we built.
  return {
    ...plain,
    metaCampaignId: (payload ? num(payload.campaign_id) : null) ?? plainIds.metaCampaignId,
    metaAdgroupId: (payload ? num(payload.adgroup_id) : null) ?? plainIds.metaAdgroupId,
    metaAdId: (payload ? num(payload.ad_id) : null) ?? plainIds.metaAdId,
    metaAccountId: payload ? num(payload.account_id) : null,
    metaPlacement: plainIds.metaPlacement,
    fbclid: extractFbclid(raw),
    decryptError: error,
  };
}

/** Seconds since epoch to an ISO string, tolerating rubbish input. */
function secondsToIso(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n * 1000;
  // Reject anything absurd rather than storing a date in 1970 or 2287.
  if (ms < Date.UTC(2020, 0, 1) || ms > Date.now() + 86_400_000) return null;
  return new Date(ms).toISOString();
}

/**
 * Store one user's attribution. Insert-or-ignore: the first capture wins.
 * Returns true when the row is present afterwards, whether we wrote it or a
 * previous launch did, because both mean the client can stop asking.
 */
/**
 * The advertising answer, read from where it is durable rather than trusted
 * from the request.
 *
 * NULL means never asked, which behaves exactly like no: consent is something
 * somebody gives, not something they fail to withhold. A read we cannot do is
 * also a no, because sending a user-level identifier on the strength of a
 * failed lookup is the wrong way to be wrong.
 */
export async function hasAdvertisingConsent(env: Env, userId: string): Promise<boolean> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return false;
  try {
    const res = await fetch(
      `${base}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=advertising_consent&limit=1`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return false;
    const rows: unknown = await res.json();
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object' ? rows[0] as Record<string, unknown> : null;
    return row?.advertising_consent === true;
  } catch {
    return false;
  }
}

/**
 * Read back what was actually retained for this account.
 *
 * The insert uses ignore-duplicates, so a reinstall gets a 204 and the row that
 * already existed stays. The caller used to build its Meta event from the raw
 * referrer it had just submitted, which is the referrer that was IGNORED. A
 * reinstall through a different advert therefore reported a conversion against
 * a click that never won, and a retry could relabel one that had.
 */
export async function retainedInstallAttribution(
  env: Env,
  userId: string,
): Promise<{ fbclid: string | null; referrerClickAt: string | null } | null> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return null;
  try {
    const res = await fetch(
      `${base}/rest/v1/install_attribution?user_id=eq.${encodeURIComponent(userId)}&select=fbclid,referrer_click_at&limit=1`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const rows: unknown = await res.json();
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object' ? rows[0] as Record<string, unknown> : null;
    if (!row) return null;
    return {
      fbclid: typeof row.fbclid === 'string' && row.fbclid ? row.fbclid : null,
      referrerClickAt: typeof row.referrer_click_at === 'string' ? row.referrer_click_at : null,
    };
  } catch {
    return null;
  }
}

export async function recordInstallAttribution(
  env: Env,
  userId: string,
  raw: string,
  clickSeconds: unknown,
  installBeginSeconds: unknown,
  options: { advertisingConsent?: boolean } = {},
): Promise<boolean> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return false;

  // Older clients may submit before answering. Acknowledge the discarded
  // request without parsing or retaining anything from the device.
  if (options.advertisingConsent !== true) return true;
  const parsed = await parseReferrer(raw, env);
  // The RPC checks consent again under the withdrawal lock. Never retain the
  // raw string: unknown or encrypted parameters can contain more click IDs.
  const res = await fetch(`${base}/rest/v1/rpc/record_consented_install_attribution`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_attribution: {
      utm_source: parsed.utmSource,
      utm_medium: parsed.utmMedium,
      utm_campaign: parsed.utmCampaign,
      meta_campaign_id: parsed.metaCampaignId,
      meta_adgroup_id: parsed.metaAdgroupId,
      meta_ad_id: parsed.metaAdId,
      meta_account_id: parsed.metaAccountId,
      meta_placement: parsed.metaPlacement,
      fbclid: parsed.fbclid,
      decrypt_error: parsed.decryptError,
      referrer_click_at: secondsToIso(clickSeconds),
      install_begin_at: secondsToIso(installBeginSeconds),
      },
    }),
  }).catch(() => null);

  if (!res?.ok) return false;
  return await res.json().catch(() => false) === true;
}
