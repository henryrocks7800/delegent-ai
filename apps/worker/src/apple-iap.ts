/**
 * Apple in-app purchase: the Worker half.
 *
 * WHY THIS EXISTS
 *   Apple rejected 2.5.0 (37) on 2026-08-18 under Guideline 3.1.1, because the
 *   iOS build showed prices and handed off to Stripe Checkout. This module is
 *   the backup plan: StoreKit takes the money, Apple tells us about it, and the
 *   same entitlement lands in Supabase that a Stripe subscription would have
 *   produced. See docs/app-store/IAP_ARCHITECTURE.md.
 *
 * THE ONE SECURITY RULE THAT SHAPES EVERYTHING BELOW
 *
 *   NEVER GRANT ANYTHING FROM A JWS SOMEBODY ELSE HANDED US.
 *
 *   Apple signs its transactions and notifications as JWS with an x5c
 *   certificate chain, and the textbook approach is to validate that chain
 *   against Apple's root CA. Doing that correctly inside a Cloudflare Worker
 *   means implementing X.509 path validation on WebCrypto, and getting it
 *   subtly wrong looks exactly like getting it right until somebody forges a
 *   receipt.
 *
 *   So this module does not rely on that at all. Whatever arrives, we take only
 *   the IDENTIFIERS from it (transaction id, original transaction id), and then
 *   we go and ask Apple ourselves over TLS, authenticated with our own signed
 *   JWT. The entitlement is written from APPLE'S ANSWER, never from the payload
 *   that arrived. A forged notification therefore achieves nothing: it can name
 *   a transaction id, and Apple will tell us that transaction does not exist or
 *   does not belong to our bundle.
 *
 *   This is why `decodeJwsPayloadUnverified` is named the way it is. It is safe
 *   ONLY because of the re-fetch. If you ever make a granting decision straight
 *   from its output, that rule is broken and the name stopped being true.
 *
 * THE ALLOWLIST
 *   `SIDEKICK_APPLE_IAP_ALLOWLIST` gates who may activate a subscription this
 *   way. Empty means NOBODY, deliberately: this ships dark and is switched on
 *   for one account at a time. Alex asked to test it on his own account before
 *   it goes anywhere near a customer, and an empty-means-nobody default is the
 *   only version of that which survives someone forgetting to set the variable.
 */

import {
  APPLE_IAP_BUNDLE_ID,
  getPlanTier,
  planTierIdForAppleProduct,
  type PlanTierId,
} from '@sidekick/shared';
import { parseBillingEntitlementResult } from '@sidekick/billing/server-flow';

export type AppleIapEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /**
   * The App Store Server API key. These may be the same values as the App Store
   * Connect API key: verified live on 2026-08-18 that our existing ASC key is
   * accepted by the App Store Server API in SANDBOX (it answers 400 "Invalid
   * transaction id", which is an authenticated answer) but refused in
   * PRODUCTION with 401. So sandbox testing works today with no new key, and
   * production will need either a dedicated In-App Purchase key or a recheck
   * once the app is actually on sale.
   */
  APPLE_IAP_KEY_P8?: string;
  APPLE_IAP_KEY_ID?: string;
  APPLE_IAP_ISSUER_ID?: string;
  /** Comma-separated user ids permitted to activate via Apple. Empty = nobody. */
  SIDEKICK_APPLE_IAP_ALLOWLIST?: string;
  /**
   * 'Sandbox' | 'Production' | 'auto'. 'auto' asks production first and falls
   * back to sandbox, which is what Apple recommends because a TestFlight
   * build's transactions live in sandbox while the same binary in the wild
   * produces production ones.
   *
   * 'auto' falls back on a not-found AND on a 401, and the 401 case is the one
   * that matters here: Production refuses our key until the app is on sale (see
   * APPLE_IAP_KEY_P8 above), so a 401-aborts-the-walk made 'auto' verify
   * nothing at all. That is why this was pinned to 'Sandbox'. The pin is a
   * WORKAROUND, not a decision, and it is only safe while no real purchase can
   * happen: a launch-day purchase is a Production transaction, and Sandbox has
   * never heard of it. Pinned by apple-iap-environment-fallback.test.mjs.
   */
  SIDEKICK_APPLE_IAP_ENVIRONMENT?: string;
  /**
   * Days a cancelled customer's workspace volume is kept before the grace
   * expiry job deletes it. Same knob the Stripe webhook and the provisioner
   * read; the default here MUST match theirs (60, Alex's call 2026-08-04) or
   * an Apple customer's files are deleted on a different schedule from a
   * Stripe customer's.
   */
  SIDEKICK_FLY_VOLUME_RETENTION_DAYS?: string;
};

/**
 * Retention window for an Apple cancellation, in seconds. Mirrors
 * resolveFlyVolumeRetentionSeconds in the provisioner and the Stripe webhook's
 * resolveSeries4SuspendRetentionSeconds: env override, else 60 days.
 */
export function resolveAppleSuspendRetentionSeconds(env: AppleIapEnv): number {
  const parsed = Number.parseInt((env.SIDEKICK_FLY_VOLUME_RETENTION_DAYS ?? '').trim(), 10);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return days * 24 * 60 * 60;
}

export type AppleEnvironment = 'Sandbox' | 'Production';

const APPLE_API_BASE: Record<AppleEnvironment, string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

/** Apple's error code for "no such transaction", which is how the env probe works. */
const APPLE_TRANSACTION_NOT_FOUND = 4040010;

export type AppleTransactionInfo = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: string;
  purchaseDate: number;
  expiresDate: number | null;
  environment: AppleEnvironment;
  revocationDate: number | null;
  revocationReason: number | null;
  offerDiscountType?: string | null;
  appAccountToken?: string | null;
  /** Apple reports the transaction price in thousandths of its currency. */
  price?: number | null;
  currency?: string | null;
};

export type AppleIapOutcome = {
  ok: boolean;
  outcome: string;
  tierId?: PlanTierId;
  expiresAt?: string | null;
  subscriptionStatus?: 'active' | 'trialing' | 'past_due' | 'canceled';
  paidAmount?: number | null;
  currency?: string | null;
  status?: number;
  /** The Delegent account the notification resolved to, when it applied. */
  userId?: string | null;
};

// -- allowlist -------------------------------------------------------------

export function appleIapAllowlist(env: AppleIapEnv): readonly string[] {
  return (env.SIDEKICK_APPLE_IAP_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The one value that opens Apple billing to everybody.
 *
 * It has to be SOMETHING rather than the absence of something. An unset
 * variable meaning "everyone" is how a forgotten deploy opens a second billing
 * path to every customer at once, so empty still means nobody and always will.
 * This is the deliberate, greppable, auditable opposite of that.
 */
const APPLE_IAP_ALLOWLIST_OPEN = '*';

export function isUserAllowlistedForAppleIap(env: AppleIapEnv, userId: string): boolean {
  const allowlist = appleIapAllowlist(env);
  // Empty means nobody. Never "everybody": an unset variable in production must
  // fail closed, or the first deploy silently opens a second billing path to
  // every customer at once.
  if (allowlist.length === 0) return false;
  // '*' means everybody, and it is REQUIRED for App Review. The reviewer's
  // account is not one of ours and cannot be added in advance, so an id-based
  // allowlist answers their purchase with 403 and "In-app purchase is not
  // enabled for this account yet". That is an automatic second rejection under
  // Guideline 3.1.1 for an app that implements StoreKit perfectly.
  if (allowlist.includes(APPLE_IAP_ALLOWLIST_OPEN)) return true;
  return allowlist.includes(userId);
}

// -- Apple auth ------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToString(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Mint the ES256 JWT the App Store Server API wants.
 *
 * Two things Apple is strict about and that have already cost time elsewhere in
 * this repo:
 *   - `bid` (the bundle id) is REQUIRED here and is not part of a plain App
 *     Store Connect token. Omitting it is a 401 that reads like a bad key.
 *   - `iat` is backdated 60 seconds. Apple rejects tokens issued in its future,
 *     and this box's clock ran 2 seconds ahead on 2026-08-12, producing 90
 *     minutes of baffling 401s against a perfectly good key.
 *
 * WebCrypto's ECDSA sign already returns the raw r||s pair JOSE wants, so
 * unlike the Python signer there is no DER conversion here.
 */
export async function mintAppleStoreKitToken(env: AppleIapEnv, now = Date.now()): Promise<string> {
  const keyPem = env.APPLE_IAP_KEY_P8;
  const keyId = env.APPLE_IAP_KEY_ID;
  const issuerId = env.APPLE_IAP_ISSUER_ID;
  if (!keyPem || !keyId || !issuerId) throw new Error('apple_iap_key_not_configured');

  const issuedAt = Math.floor(now / 1000) - 60;
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 1140,
    aud: 'appstoreconnect-v1',
    bid: APPLE_IAP_BUNDLE_ID,
  };

  const encoder = new TextEncoder();
  const signingInput = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(keyPem),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// -- JWS handling ----------------------------------------------------------

/**
 * Read the payload out of a JWS WITHOUT checking its signature.
 *
 * Read the module header before using this. It is safe here for exactly one
 * reason: every caller uses the result only to learn WHICH transaction is being
 * talked about, and then re-fetches the authoritative record from Apple. It
 * must never be the basis of a decision to grant anything.
 */
export function decodeJwsPayloadUnverified<T = Record<string, unknown>>(jws: unknown): T | null {
  if (typeof jws !== 'string') return null;
  const segments = jws.split('.');
  if (segments.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecodeToString(segments[1])) as T;
  } catch {
    return null;
  }
}

function toTransactionInfo(raw: Record<string, unknown>): AppleTransactionInfo | null {
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const num = (key: string): number | null =>
    typeof raw[key] === 'number' ? (raw[key] as number) : null;

  const transactionId = str('transactionId');
  const originalTransactionId = str('originalTransactionId');
  const productId = str('productId');
  if (!transactionId || !originalTransactionId || !productId) return null;

  const environment = str('environment') === 'Production' ? 'Production' : 'Sandbox';
  return {
    transactionId,
    originalTransactionId,
    bundleId: str('bundleId'),
    productId,
    type: str('type'),
    purchaseDate: num('purchaseDate') ?? 0,
    expiresDate: num('expiresDate'),
    environment,
    revocationDate: num('revocationDate'),
    revocationReason: num('revocationReason'),
    offerDiscountType: str('offerDiscountType') || null,
    appAccountToken: str('appAccountToken') || null,
    price: num('price'),
    currency: str('currency') || null,
  };
}

// -- Apple API -------------------------------------------------------------

function configuredEnvironments(env: AppleIapEnv): AppleEnvironment[] {
  const configured = (env.SIDEKICK_APPLE_IAP_ENVIRONMENT ?? 'auto').trim();
  if (configured === 'Production') return ['Production'];
  if (configured === 'Sandbox') return ['Sandbox'];
  // Apple's own recommendation: ask production first, fall back to sandbox.
  // A TestFlight build's transactions are sandbox ones while the identical
  // binary in the wild produces production ones, so the environment cannot be
  // inferred from the build.
  return ['Production', 'Sandbox'];
}

async function appleGet(
  env: AppleIapEnv,
  environment: AppleEnvironment,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const token = await mintAppleStoreKitToken(env);
  const response = await fetch(`${APPLE_API_BASE[environment]}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Ask Apple about one transaction, trying each configured environment.
 *
 * Returns the transaction AND the environment it was found in, because that
 * environment has to be recorded: a sandbox purchase is free and infinitely
 * repeatable, so anything that later reports revenue must be able to exclude
 * those rows.
 */
export async function fetchAppleTransaction(
  env: AppleIapEnv,
  transactionId: string,
): Promise<{ info: AppleTransactionInfo; environment: AppleEnvironment } | { error: string; status: number }> {
  let lastStatus = 0;
  let sawAuthRejection = false;
  const environments = configuredEnvironments(env);

  for (const environment of environments) {
    const { status, body } = await appleGet(env, environment, `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
    lastStatus = status;

    if (status === 200) {
      const decoded = decodeJwsPayloadUnverified<Record<string, unknown>>(body?.signedTransactionInfo);
      if (!decoded) return { error: 'apple_transaction_undecodable', status: 502 };
      const info = toTransactionInfo(decoded);
      if (!info) return { error: 'apple_transaction_incomplete', status: 502 };
      if (info.transactionId !== transactionId || info.environment !== environment) {
        return { error: 'apple_transaction_identity_mismatch', status: 502 };
      }
      return { info, environment };
    }

    // Not found in this environment is the signal to try the other one.
    const errorCode = typeof body?.errorCode === 'number' ? body.errorCode : null;
    const notFound = status === 404 || errorCode === APPLE_TRANSACTION_NOT_FOUND;
    if (notFound) continue;

    // A 401 means THIS environment refused the key, not that the key is dead.
    //
    // Apple's Production host rejects the key for an app that is not yet
    // released, while the identical key authenticates against Sandbox. This
    // used to `return` here, which meant 'auto' asked Production, got 401, and
    // never tried Sandbox at all — so every TestFlight and every App Review
    // purchase failed to verify. That left NO safe setting: 'Sandbox' verifies
    // the review but cannot see a real launch-day purchase, and 'auto' broke
    // the review. Hence the Sandbox pin, which was a workaround for this line.
    //
    // Falling through keeps the original safety intent intact: a genuinely
    // broken key is refused by EVERY environment, so the loop exhausts and
    // still reports apple_auth_rejected below. It never degrades into a
    // misleading "no such transaction".
    if (status === 401) {
      sawAuthRejection = true;
      continue;
    }

    // 5xx and anything else still stops the loop. A transient Apple fault is
    // not evidence about the other environment, and asking it would turn a
    // retryable blip into a wrong answer.
    return { error: 'apple_api_error', status: 502 };
  }

  if (sawAuthRejection) return { error: 'apple_auth_rejected', status: 502 };
  return { error: 'apple_transaction_not_found', status: lastStatus === 0 ? 502 : 404 };
}

/**
 * The current renewal state for a subscription, which is what a notification
 * has to be resolved against. The transaction record alone cannot say whether
 * a subscription is still live: it describes one payment.
 */
export async function fetchAppleSubscriptionState(
  env: AppleIapEnv,
  originalTransactionId: string,
  environment: AppleEnvironment,
): Promise<{ info: AppleTransactionInfo; statusCode: number; autoRenew: boolean | null; gracePeriodExpiresDate: number | null; observedAt: string } | { error: string }> {
  // Order snapshots when requests overlap. A slower, earlier lookup must not
  // overwrite a later one merely because its database write finishes last.
  const observedAt = new Date().toISOString();
  const { status, body } = await appleGet(
    env, environment,
    `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
  );
  if (status !== 200 || !body) return { error: 'apple_subscription_lookup_failed' };

  const groups = Array.isArray(body.data) ? body.data : [];
  for (const group of groups) {
    const items = Array.isArray((group as Record<string, unknown>).lastTransactions)
      ? ((group as Record<string, unknown>).lastTransactions as Record<string, unknown>[])
      : [];
    for (const item of items) {
      if (typeof item.originalTransactionId === 'string'
        && item.originalTransactionId !== originalTransactionId) continue;
      const decoded = decodeJwsPayloadUnverified<Record<string, unknown>>(item.signedTransactionInfo);
      const info = decoded ? toTransactionInfo(decoded) : null;
      if (!info) continue;
      if (info.originalTransactionId !== originalTransactionId || info.environment !== environment
        || info.bundleId !== APPLE_IAP_BUNDLE_ID || !planTierIdForAppleProduct(info.productId)) {
        return { error: 'apple_subscription_identity_mismatch' };
      }
      // Apple's status: 1 active, 2 expired, 3 in billing retry, 4 grace, 5 revoked.
      const statusCode = typeof item.status === 'number' ? item.status : 0;
      if (![1,2,3,4,5].includes(statusCode)) return { error: 'apple_subscription_status_invalid' };
      // Whether the customer still has auto-renew on. This is Apple's own
      // answer (it sits in the re-fetched response, not in anything a caller
      // handed us), so it is safe to write. Without it every Apple row said
      // "renews", and a customer who had switched renewal off in Settings was
      // told their monthly time would reset on a date it would not.
      const renewal = decodeJwsPayloadUnverified<Record<string, unknown>>(item.signedRenewalInfo);
      if (renewal?.originalTransactionId && renewal.originalTransactionId !== originalTransactionId) {
        return { error: 'apple_renewal_identity_mismatch' };
      }
      const autoRenew = renewal?.autoRenewStatus === 1 ? true : renewal?.autoRenewStatus === 0 ? false : null;
      const gracePeriodExpiresDate = typeof renewal?.gracePeriodExpiresDate === 'number'
        && Number.isFinite(renewal.gracePeriodExpiresDate) && renewal.gracePeriodExpiresDate > 0
        ? renewal.gracePeriodExpiresDate : null;
      return { info, statusCode, autoRenew, gracePeriodExpiresDate, observedAt };
    }
  }
  return { error: 'apple_subscription_not_in_response' };
}

/**
 * Apple's numeric subscription status mapped onto our own `subscriptions.status`.
 *
 * Grace period (4) deliberately maps to 'active', not 'past_due': the customer
 * still has service and Apple is still trying to charge them. Billing retry (3)
 * maps to 'past_due', which is the honest description and is what the Stripe
 * path uses for the same situation.
 */
export function appleStatusToSubscriptionStatus(statusCode: number): 'active' | 'past_due' | 'canceled' {
  if (statusCode === 1 || statusCode === 4) return 'active';
  if (statusCode === 3) return 'past_due';
  return 'canceled';
}

/**
 * Receipt-only classifier for diagnostics. The grant path requires a current
 * subscription response: even an unexpired receipt can predate a plan change.
 *
 * This exists because the previous fallback was `revoked ? canceled : active`,
 * which FAILS OPEN. A transaction record is permanent: Apple keeps answering
 * for it long after the subscription behind it lapsed. So a customer whose
 * subscription expired months ago could tap Restore, have the transaction
 * lookup succeed, have the subscription lookup fail on a transient 500 (or on
 * the known Production 401), and be granted `active` on the strength of a
 * receipt for a period that ended long ago.
 *
 * Every other refusal in this module fails closed. This one line did not, and
 * it sat on the money path.
 *
 * `expiresDate` is the authority: it is the end of the period Apple actually
 * charged for. Past it, with no fresher word from Apple, the honest answer is
 * that we do not know this is still paid, so we do not grant it.
 */
export function statusFromTransactionAlone(
  info: Pick<AppleTransactionInfo, 'revocationDate' | 'expiresDate'>,
  now: number = Date.now(),
): 'active' | 'canceled' {
  if (info.revocationDate) return 'canceled';
  // A subscription transaction always carries an expiry. Absent one, this is
  // not something we can vouch for either.
  if (!info.expiresDate) return 'canceled';
  return info.expiresDate > now ? 'active' : 'canceled';
}

// -- Supabase writes -------------------------------------------------------

export function appleEntitlementStatus(
  status: 'active' | 'trialing' | 'past_due' | 'canceled',
  info: Pick<AppleTransactionInfo, 'offerDiscountType'>,
): 'active' | 'trialing' | 'past_due' | 'canceled' {
  // Apple billing retry (status 3) is outside its service grace period.
  if (status === 'past_due') return 'canceled';
  return status === 'active' && info.offerDiscountType === 'FREE_TRIAL' ? 'trialing' : status;
}

export function applePaidAmount(info: Pick<AppleTransactionInfo, 'price' | 'environment' | 'offerDiscountType'>): number | null {
  if (info.environment !== 'Production' || info.offerDiscountType === 'FREE_TRIAL') return null;
  return typeof info.price === 'number' && Number.isFinite(info.price) && info.price > 0 ? info.price / 1000 : null;
}

type SupabaseWriteResult = { ok: boolean; detail?: string;
  subscriptionStatus?: 'active' | 'trialing' | 'past_due' | 'canceled'; serviceAccessUntil?: string | null };

async function supabaseRequest(
  env: AppleIapEnv,
  path: string,
  init: RequestInit & { prefer?: string },
): Promise<Response | null> {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Supabase wants the service-role key in BOTH places. Sending only the
    // bearer looks authenticated and silently applies anon RLS instead.
    apikey: key,
    authorization: `Bearer ${key}`,
  };
  if (init.prefer) headers.prefer = init.prefer;
  return fetch(`${url.replace(/\/+$/, '')}/rest/v1${path}`, { ...init, headers }).catch(() => null);
}

/**
 * Commit the verified entitlement, quota and runner lifecycle in one transaction.
 */
export async function applyAppleEntitlement(
  env: AppleIapEnv,
  input: {
    userId: string;
    tierId: PlanTierId;
    status: 'active' | 'trialing' | 'past_due' | 'canceled';
    info: AppleTransactionInfo;
    statusCode?: number;
    gracePeriodExpiresDate?: number | null;
    /**
     * True when Apple says auto-renew is off: the plan runs to `expiresDate`
     * and stops. Drives the same `cancel_at_period_end` column the Stripe
     * webhook writes, so the app's "ends on" versus "resets on" line is honest
     * for both providers. Defaults to false when Apple did not say.
     */
    cancelAtPeriodEnd?: boolean;
    /** Legacy authenticated restore permission. A verified admitted intent is also checked atomically. */
    allowProviderSwitch?: boolean;
    observedAt?: string;
    now?: () => string;
  },
): Promise<SupabaseWriteResult> {
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  const tier = getPlanTier(input.tierId);
  let status = appleEntitlementStatus(input.status, input.info);
  const entitled = status === 'active' || status === 'trialing' || status === 'past_due';

  const periodStart = input.info.purchaseDate
    ? new Date(input.info.purchaseDate).toISOString() : null;
  const periodEnd = input.info.expiresDate
    ? new Date(input.info.expiresDate).toISOString() : null;

  // Migration 0054's provider-aware constraint requires BOTH period bounds on
  // an active Apple row. Refuse here rather than letting Postgres reject it,
  // because the constraint error surfaces as an opaque 400 that reads like an
  // auth problem.
  if (entitled && (!periodStart || !periodEnd)) {
    return { ok: false, detail: 'apple_transaction_missing_period_bounds' };
  }

  // The current signed renewal supplies grace. The old transaction's expiry
  // remains the billing fact, so grace never resets the customer's allowance.
  const serviceEnd = input.statusCode === 4 ? input.gracePeriodExpiresDate : input.info.expiresDate;
  if (entitled && (!serviceEnd || !Number.isFinite(serviceEnd))) {
    return { ok: false, detail: 'apple_service_deadline_unavailable' };
  }
  const serviceAccessUntil = serviceEnd && Number.isFinite(serviceEnd) ? new Date(serviceEnd).toISOString() : null;
  if (input.info.revocationDate || !serviceEnd || serviceEnd <= Date.parse(nowIso)) status = 'canceled';

  const subscription = {
    user_id: input.userId, status, tier_id: input.tierId, billing_provider: 'apple',
    apple_original_transaction_id: input.info.originalTransactionId,
    apple_product_id: input.info.productId, apple_environment: input.info.environment,
    purchase_intent_id: input.info.appAccountToken ?? null,
    current_period_start: periodStart, current_period_end: periodEnd, service_access_until: serviceAccessUntil,
    cancel_at_period_end: input.cancelAtPeriodEnd === true,
    updated_at: nowIso, provider_updated_at: input.observedAt ?? nowIso,
  };
  const quota = {
    user_id: input.userId, tier_id: input.tierId, monthly_token_quota: tier.monthlyTokenQuota,
    storage_quota_bytes: tier.storageGb * 1024 ** 3, voice_seconds_quota: tier.voiceSecondsQuota,
    updated_at: nowIso, provider_updated_at: input.observedAt ?? nowIso,
  };
  const eventKey = ['apple', input.info.environment, input.info.originalTransactionId,
    input.info.transactionId, status, periodEnd, serviceAccessUntil, input.cancelAtPeriodEnd === true, input.observedAt ?? nowIso].join(':');
  const response = await supabaseRequest(env, '/rpc/apply_billing_entitlement', {
    method: 'POST', body: JSON.stringify({
      p_provider: 'apple', p_subscription: subscription, p_quota: quota,
      p_event_key: eventKey, p_allow_provider_switch: input.allowProviderSwitch === true,
      p_retention_seconds: resolveAppleSuspendRetentionSeconds(env),
    }),
  });
  if (!response?.ok) return { ok: false, detail: 'billing_entitlement_apply_failed' };
  try {
    const result = parseBillingEntitlementResult(await response.json());
    if (result.outcome === 'provider_conflict' || result.outcome === 'activation_pending' || result.outcome === 'purchase_conflict') {
      return { ok: false, detail: `billing_${result.outcome}` };
    }
    return { ok: true, detail: result.outcome, subscriptionStatus: status, serviceAccessUntil };
  } catch {
    return { ok: false, detail: 'billing_entitlement_result_invalid' };
  }
}

async function recordAppleEvent(env: AppleIapEnv, row: Record<string, unknown>): Promise<void> {
  try {
    await supabaseRequest(env, '/apple_iap_events', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify(row),
    });
  } catch {
    // The audit row is best-effort on purpose. Losing it must never turn a
    // successful purchase into a failed one for the customer.
  }
}

/**
 * Has this original transaction already been claimed by a DIFFERENT account?
 *
 * The database's unique index is the real guarantee, but reaching it produces a
 * 409 that is hard to tell apart from other write failures, and the customer
 * would see a generic error. Checking first lets the refusal be specific.
 */
async function conflictingOwner(env: AppleIapEnv, originalTransactionId: string, userId: string, environment: AppleEnvironment): Promise<boolean | null> {
  const response = await supabaseRequest(
    env,
    `/billing_subscription_ownership?provider=eq.apple&provider_environment=eq.${environment}&provider_subscription_id=eq.${encodeURIComponent(originalTransactionId)}&select=user_id`,
    { method: 'GET' },
  );
  if (!response || !response.ok) return null;
  const rows = (await response.json().catch(() => null)) as { user_id?: string }[] | null;
  if (!Array.isArray(rows) || rows.some((row) => !row || (row.user_id !== null && typeof row.user_id !== 'string'))) return null;
  return rows.some((row) => row.user_id !== userId);
}

async function purchaseIntentOwner(env: AppleIapEnv, token: string | null | undefined): Promise<
  { known: boolean; userId: string | null } | { unavailable: true }
> {
  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return { known: false, userId: null };
  }
  const response = await supabaseRequest(env,
    `/billing_purchase_intents?id=eq.${encodeURIComponent(token)}&provider=eq.apple&select=user_id`, { method: 'GET' });
  if (!response?.ok) return { unavailable: true };
  const rows = await response.json().catch(() => null) as { user_id: string | null }[] | null;
  if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => !row
    || (row.user_id !== null && (typeof row.user_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.user_id))))) {
    return { unavailable: true };
  }
  return { known: rows.length === 1, userId: rows[0]?.user_id ?? null };
}

// -- the two entry points --------------------------------------------------

/**
 * Client-initiated: StoreKit completed a purchase on the device and the app is
 * telling us its transaction id. Nothing in the request is trusted beyond that
 * id and the authenticated user.
 */
export async function verifyAndRecordApplePurchase(
  env: AppleIapEnv,
  userId: string,
  transactionId: string,
): Promise<AppleIapOutcome> {
  if (!isUserAllowlistedForAppleIap(env, userId)) {
    return { ok: false, outcome: 'not_allowlisted', status: 403 };
  }

  const fetched = await fetchAppleTransaction(env, transactionId);
  if ('error' in fetched) {
    await recordAppleEvent(env, {
      user_id: userId, transaction_id: transactionId,
      applied: false, outcome: fetched.error,
    });
    return { ok: false, outcome: fetched.error, status: fetched.status };
  }

  const { info } = fetched;

  if (info.bundleId !== APPLE_IAP_BUNDLE_ID) {
    return { ok: false, outcome: 'bundle_id_mismatch', status: 400 };
  }

  if (!planTierIdForAppleProduct(info.productId)) {
    // An unknown product id means Apple is describing something we do not sell.
    // Granting the cheapest tier "to be helpful" would be a free subscription
    // to anyone who can buy any product from any of our future apps.
    await recordAppleEvent(env, {
      user_id: userId, transaction_id: info.transactionId,
      original_transaction_id: info.originalTransactionId, product_id: info.productId,
      environment: info.environment, applied: false, outcome: 'unknown_product_id',
    });
    return { ok: false, outcome: 'unknown_product_id', status: 400 };
  }

  const conflict = await conflictingOwner(env, info.originalTransactionId, userId, info.environment);
  if (conflict === null) return { ok: false, outcome: 'apple_owner_lookup_unavailable', status: 503 };
  if (conflict) {
    await recordAppleEvent(env, {
      user_id: userId, transaction_id: info.transactionId,
      original_transaction_id: info.originalTransactionId, product_id: info.productId,
      environment: info.environment, applied: false, outcome: 'already_claimed_by_another_account',
    });
    return { ok: false, outcome: 'already_claimed_by_another_account', status: 409 };
  }

  // Apple has already processed the purchase. The atomic entitlement fence
  // protects the current provider and records a conflicting payment durably.
  const state = await fetchAppleSubscriptionState(env, info.originalTransactionId, info.environment);
  if ('error' in state) {
    return { ok: false, outcome: state.error, status: 503 };
  }
  const authoritative = state.info;
  const purchaseOwner = await purchaseIntentOwner(env, authoritative.appAccountToken);
  if ('unavailable' in purchaseOwner) return { ok: false, outcome: 'apple_purchase_owner_unavailable', status: 503 };
  if (purchaseOwner.known && purchaseOwner.userId !== userId) {
    return { ok: false, outcome: 'already_claimed_by_another_account', status: 409 };
  }
  const status = authoritative.revocationDate ? 'canceled' : appleStatusToSubscriptionStatus(state.statusCode);
  const tierId = planTierIdForAppleProduct(authoritative.productId);
  if (!tierId) return { ok: false, outcome: 'unknown_product_id', status: 503 };
  const cancelAtPeriodEnd = state.autoRenew === false;

  const applied = await applyAppleEntitlement(env, { userId, tierId, status, info: authoritative, cancelAtPeriodEnd,
    allowProviderSwitch: true, observedAt: state.observedAt,
    statusCode: state.statusCode, gracePeriodExpiresDate: state.gracePeriodExpiresDate });
  await recordAppleEvent(env, {
    user_id: userId, transaction_id: authoritative.transactionId,
    original_transaction_id: authoritative.originalTransactionId,
    product_id: authoritative.productId, environment: authoritative.environment,
    applied: applied.ok && !applied.detail?.startsWith('ignored_'), outcome: applied.detail ?? 'applied',
  });

  if (!applied.ok) return { ok: false, outcome: applied.detail ?? 'write_failed', status: 503 };
  if (applied.detail?.startsWith('ignored_')) return { ok: false, outcome: 'apple_newer_entitlement_exists', status: 503 };
  return {
    ok: true,
    outcome: 'applied',
    tierId,
    expiresAt: applied.serviceAccessUntil ?? null,
    subscriptionStatus: applied.subscriptionStatus ?? 'canceled',
    paidAmount: applePaidAmount(authoritative),
    currency: authoritative.currency ?? null,
    status: 200,
  };
}

/**
 * Apple-initiated: an App Store Server Notification V2.
 *
 * The body is decoded ONLY to learn the notification's identity and which
 * subscription it concerns. Everything that decides entitlement is then
 * re-fetched from Apple. See the module header.
 *
 * Verified unowned subscriptions are acknowledged without activation. Unknown
 * provider/ownership state and failed atomic writes remain retryable.
 */
export async function handleAppleNotification(
  env: AppleIapEnv,
  signedPayload: unknown,
): Promise<AppleIapOutcome> {
  const payload = decodeJwsPayloadUnverified<{
    notificationType?: string;
    subtype?: string;
    notificationUUID?: string;
    data?: { originalTransactionId?: string; environment?: string; signedTransactionInfo?: string };
  }>(signedPayload);

  if (!payload) return { ok: false, outcome: 'undecodable_payload', status: 400 };

  const notificationUuid = payload.notificationUUID ?? null;
  const notificationType = payload.notificationType ?? null;

  // The original transaction id may be at the top of `data` or only inside the
  // signed transaction. Both are just identifiers, so reading either is safe.
  const inner = decodeJwsPayloadUnverified<Record<string, unknown>>(payload.data?.signedTransactionInfo);
  const originalTransactionId = payload.data?.originalTransactionId
    ?? (typeof inner?.originalTransactionId === 'string' ? inner.originalTransactionId : null);

  if (!originalTransactionId) {
    await recordAppleEvent(env, {
      notification_uuid: notificationUuid, notification_type: notificationType,
      subtype: payload.subtype ?? null, applied: false, outcome: 'no_original_transaction_id',
    });
    return { ok: true, outcome: 'no_original_transaction_id', status: 200 };
  }

  // The environment named in the notification is UNVERIFIED input, so it is
  // treated as a HINT about lookup ORDER and nothing more.
  //
  // It used to be taken literally, which meant a value out of a forgeable
  // payload chose which Apple host we asked. That could not by itself grant
  // anything (the re-fetch below is still the only authority), but it let an
  // outsider steer a security-relevant decision, in a module whose whole design
  // rests on never doing that.
  //
  // Now the candidate list comes from OUR configuration, and the hint may only
  // reorder it. A spoofed environment costs one wasted lookup and achieves
  // nothing else.
  const hinted: AppleEnvironment | null =
    payload.data?.environment === 'Production' ? 'Production'
      : payload.data?.environment === 'Sandbox' ? 'Sandbox'
        : null;
  const candidates = configuredEnvironments(env);
  const ordered = hinted && candidates.includes(hinted)
    ? [hinted, ...candidates.filter((c) => c !== hinted)]
    : candidates;
  const environment: AppleEnvironment = ordered[0] ?? 'Sandbox';

  // Existing ownership is authoritative. A first purchase may instead be
  // linked by the admission token on the current transaction fetched below.
  const owner = await supabaseRequest(
    env,
    `/billing_subscription_ownership?provider=eq.apple&provider_subscription_id=eq.${encodeURIComponent(originalTransactionId)}&select=user_id,provider_environment`,
    { method: 'GET' },
  );
  if (!owner?.ok) return { ok: false, outcome: 'apple_owner_lookup_unavailable', status: 503 };
  const rows = await owner.json().catch(() => null) as { user_id: string | null; provider_environment: AppleEnvironment }[] | null;
  if (!Array.isArray(rows) || rows.some((row) => !row || (row.user_id !== null && typeof row.user_id !== 'string')
    || !['Production','Sandbox'].includes(row.provider_environment)) || rows.length > 2) {
    return { ok: false, outcome: 'apple_owner_lookup_unavailable', status: 503 };
  }
  let userId: string | null = null;

  // THE RE-FETCH. Everything above was identifiers; this is the only thing
  // allowed to decide what the customer gets.
  //
  // Tried across every configured environment, hinted order first. Without
  // this, a notification whose environment we guessed wrong looks identical to
  // a transaction Apple has never heard of, and the renewal is silently lost.
  let state: Awaited<ReturnType<typeof fetchAppleSubscriptionState>> = { error: 'apple_subscription_lookup_failed' };
  let resolvedEnvironment = environment;
  for (const candidate of ordered) {
    state = await fetchAppleSubscriptionState(env, originalTransactionId, candidate);
    if (!('error' in state)) { resolvedEnvironment = candidate; break; }
  }
  if ('error' in state) {
    await recordAppleEvent(env, {
      user_id: userId, notification_uuid: notificationUuid, notification_type: notificationType,
      subtype: payload.subtype ?? null, original_transaction_id: originalTransactionId,
      environment, applied: false, outcome: state.error,
    });
    // Apple could not answer. This one IS worth a retry.
    return { ok: false, outcome: state.error, status: 503 };
  }

  // A notification's environment hint is untrusted. Bind the owner to the
  // environment actually verified by Apple, including when ids overlap.
  const verifiedOwners = rows.filter((row) => row.provider_environment === resolvedEnvironment);
  if (verifiedOwners.length > 1) return { ok: false, outcome: 'apple_owner_lookup_unavailable', status: 503 };
  userId = verifiedOwners[0]?.user_id ?? null;
  if (!userId && verifiedOwners.length === 0) {
    // A first notification can precede the device verification. Only the
    // current transaction fetched directly from Apple may identify admission.
    // Unverified notification tokens never select a Delegent account.
    const admittedOwner = await purchaseIntentOwner(env, state.info.appAccountToken);
    if ('unavailable' in admittedOwner) return { ok: false, outcome: 'apple_purchase_owner_unavailable', status: 503 };
    userId = admittedOwner.userId;
  }
  // A deleted historical owner never falls back to a new purchase token.
  if (!userId) return { ok: true, outcome: 'no_local_subscription', status: 200 };

  const tierId = planTierIdForAppleProduct(state.info.productId);
  if (!tierId) {
    await recordAppleEvent(env, {
      user_id: userId, notification_uuid: notificationUuid, notification_type: notificationType,
      original_transaction_id: originalTransactionId, product_id: state.info.productId,
      environment: resolvedEnvironment, applied: false, outcome: 'unknown_product_id',
    });
    return { ok: true, outcome: 'unknown_product_id', status: 200 };
  }

  const status = state.info.revocationDate
    ? 'canceled' as const
    : appleStatusToSubscriptionStatus(state.statusCode);

  const applied = await applyAppleEntitlement(env, {
    userId, tierId, status, info: state.info, cancelAtPeriodEnd: state.autoRenew === false, observedAt: state.observedAt,
    statusCode: state.statusCode, gracePeriodExpiresDate: state.gracePeriodExpiresDate,
  });
  await recordAppleEvent(env, {
    user_id: userId, notification_uuid: notificationUuid, notification_type: notificationType,
    subtype: payload.subtype ?? null, original_transaction_id: originalTransactionId,
    transaction_id: state.info.transactionId, product_id: state.info.productId,
    environment: resolvedEnvironment, applied: applied.ok && !applied.detail?.startsWith('ignored_'), outcome: applied.detail ?? 'applied',
  });

  if (!applied.ok) return { ok: false, outcome: applied.detail ?? 'write_failed', status: 503 };
  return { ok: true, outcome: applied.detail?.startsWith('ignored_') ? applied.detail : `applied:${applied.subscriptionStatus}`, tierId, status: 200, userId };
}
