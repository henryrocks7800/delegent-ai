/**
 * Referrals (growth plan, 2026-09-23; Alex: "happy for you to do everything").
 *
 * "Give a friend a free month, get one yourself." Every new account already gets
 * its first month free, so the friend's side is the standard free month; the
 * member's reward is real: when a friend who entered their code pays for a first
 * month, the member's next month is free, as a credit on their Stripe balance
 * that Stripe applies to their next invoice. Up to 12 a year.
 *
 *   GET  /api/referral          the member's code and share text, or eligible:false
 *   POST /api/referral/redeem   { code }: link a new account to the member who invited it
 *
 * Who can invite: a member billed through Stripe (the Android app and the web),
 * because the reward is a Stripe credit. Apple members are not offered it: a free
 * month outside Apple's billing is a Guideline 3.1.1 risk, and the iPhone app
 * shows neither the invite nor the code box.
 *
 * Tables: supabase/migrations/0077_referrals.sql (service role only).
 */
import { AGENT_PLAN } from '@sidekick/shared';
import { extractPaymentReceiptDetails } from './payment-email.js';

export interface ReferralEnv {
  SUPABASE_URL?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  STRIPE_SECRET_KEY?: string | null;
}

export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
export const REFERRAL_REWARDS_PER_YEAR = 12;
export const REFERRAL_REWARD_PENCE = Math.round(AGENT_PLAN.priceGbpMonthly * 100);
export const REFERRAL_SHARE_URL = 'https://delegentai.co.uk/install';

/** An 8-character code with no easily confused characters (no I, O, 0 or 1). */
export function generateReferralCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(8);
  let code = '';
  for (const byte of bytes) code += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  return code;
}

/** What someone typed, as a code: upper case, spaces and dashes removed. Null if it cannot be one. */
export function normaliseReferralCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

export function referralShareText(code: string): string {
  // The code box is in the Android app only (see the header), so the message
  // says so: an iPhone friend would otherwise look for a box that is not there.
  return `I've been using Delegent AI, an AI assistant that handles email, travel and everyday admin. Your first month is free. If you're on Android, enter my invite code ${code} on the plan screen before you start it and I get a free month too. ${REFERRAL_SHARE_URL}`;
}

// ---------------------------------------------------------------------------
// Database access (PostgREST, service role). Small and local on purpose.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

function restHeaders(env: ReferralEnv, extra: Record<string, string> = {}): Record<string, string> {
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra };
}

async function rest(env: ReferralEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const base = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base || !(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()) throw new Error('referrals_unconfigured');
  return fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...restHeaders(env), ...(init.headers as Record<string, string> | undefined) } });
}

async function selectRows(env: ReferralEnv, path: string): Promise<Row[]> {
  const res = await rest(env, path);
  if (!res.ok) throw new Error(`referrals_read_failed_${res.status}`);
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) ? rows as Row[] : [];
}

/** The member's subscription facts the rules need. */
async function subscriptionOf(env: ReferralEnv, userId: string): Promise<Row | null> {
  const rows = await selectRows(env, `subscriptions?select=status,billing_provider,stripe_customer_id,apple_original_transaction_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  return rows[0] ?? null;
}

const LIVE = new Set(['active', 'trialing']);
export function canInvite(subscription: Row | null): boolean {
  return Boolean(
    subscription
      && LIVE.has(String(subscription.status ?? ''))
      && String(subscription.billing_provider ?? 'stripe') !== 'apple'
      && typeof subscription.stripe_customer_id === 'string' && subscription.stripe_customer_id,
  );
}

/** Never paid anyone: no Stripe customer, no Apple purchase, no live plan. */
export function isNewToPaying(subscription: Row | null): boolean {
  if (!subscription) return true;
  if (LIVE.has(String(subscription.status ?? ''))) return false;
  return !subscription.stripe_customer_id && !subscription.apple_original_transaction_id;
}

async function codeFor(env: ReferralEnv, userId: string): Promise<string> {
  const existing = await selectRows(env, `referral_codes?select=code&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  if (typeof existing[0]?.code === 'string') return existing[0].code;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = generateReferralCode();
    const res = await rest(env, 'referral_codes?on_conflict=user_id', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, code }),
    });
    if (res.status === 409) continue; // the code was taken by someone else: draw again
    if (!res.ok) throw new Error(`referral_code_write_failed_${res.status}`);
    // Two first calls at once: whichever row landed is the member's code.
    const settled = await selectRows(env, `referral_codes?select=code&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (typeof settled[0]?.code === 'string') return settled[0].code;
  }
  throw new Error('referral_code_unavailable');
}

// ---------------------------------------------------------------------------
// The two endpoints. The caller has already authenticated the session.
// ---------------------------------------------------------------------------
export async function handleReferralGet(env: ReferralEnv, userId: string): Promise<Response> {
  try {
    const subscription = await subscriptionOf(env, userId);
    if (!canInvite(subscription)) return Response.json({ eligible: false }, { headers: { 'cache-control': 'no-store' } });
    const code = await codeFor(env, userId);
    const mine = await selectRows(env, `referrals?select=status&referrer_user_id=eq.${encodeURIComponent(userId)}`);
    return Response.json({
      eligible: true,
      code,
      shareText: referralShareText(code),
      shareUrl: REFERRAL_SHARE_URL,
      // Counts only: a member never learns who joined.
      friendsJoined: mine.filter((r) => r.status !== 'void').length,
      freeMonthsEarned: mine.filter((r) => r.status === 'rewarded').length,
      rewardsPerYear: REFERRAL_REWARDS_PER_YEAR,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'referral_unavailable' }, { status: 503 });
  }
}

export async function handleReferralRedeem(env: ReferralEnv, userId: string, body: unknown): Promise<Response> {
  const code = normaliseReferralCode((body as { code?: unknown } | null)?.code);
  if (!code) return Response.json({ error: 'invite_code_invalid' }, { status: 400 });
  try {
    const owner = await selectRows(env, `referral_codes?select=user_id&code=eq.${code}&limit=1`);
    const referrer = typeof owner[0]?.user_id === 'string' ? owner[0].user_id : null;
    if (!referrer) return Response.json({ error: 'invite_code_not_found' }, { status: 404 });
    if (referrer === userId) return Response.json({ error: 'invite_code_own' }, { status: 400 });
    if (!isNewToPaying(await subscriptionOf(env, userId))) return Response.json({ error: 'invite_for_new_members' }, { status: 409 });
    const res = await rest(env, 'referrals', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ referrer_user_id: referrer, referred_user_id: userId, code }),
    });
    if (res.status === 409) return Response.json({ error: 'invite_code_already_used' }, { status: 409 });
    if (!res.ok) return Response.json({ error: 'referral_unavailable' }, { status: 503 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'referral_unavailable' }, { status: 503 });
  }
}

// ---------------------------------------------------------------------------
// The reward: a friend's first paid invoice gives the member a free month.
// ---------------------------------------------------------------------------
export interface ReferralRewardDeps {
  pendingReferralFor(referredUserId: string): Promise<{ id: string; referrerUserId: string } | null>;
  rewardsSince(referrerUserId: string, sinceIso: string): Promise<number>;
  stripeCustomerOf(referrerUserId: string): Promise<string | null>;
  /** Returns the balance transaction id. Idempotent per referral. */
  creditFreeMonth(customerId: string, referralId: string): Promise<string>;
  markRewarded(referralId: string, reference: string): Promise<void>;
  markVoid(referralId: string, reason: string): Promise<void>;
  warn?(message: string): void;
  now?(): number;
}

const PAID_INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_succeeded']);

/** Best-effort, like the receipt email beside it: nothing here can disturb billing. */
export async function maybeRewardReferral(input: {
  responseOk: boolean;
  eventType: string;
  invoice: Record<string, unknown> | null;
  deps: ReferralRewardDeps;
}): Promise<'rewarded' | 'skipped' | 'void' | 'pending' | 'error'> {
  const warn = input.deps.warn ?? ((m: string) => console.warn(m));
  try {
    if (!input.responseOk || !PAID_INVOICE_EVENTS.has(input.eventType)) return 'skipped';
    const details = extractPaymentReceiptDetails(input.invoice);
    if (!details || details.amountMinorUnits <= 0) return 'skipped';
    const referral = await input.deps.pendingReferralFor(details.userId);
    if (!referral) return 'skipped';
    const yearAgo = new Date((input.deps.now?.() ?? Date.now()) - 365 * 86_400_000).toISOString();
    if (await input.deps.rewardsSince(referral.referrerUserId, yearAgo) >= REFERRAL_REWARDS_PER_YEAR) {
      await input.deps.markVoid(referral.id, 'yearly_limit');
      return 'void';
    }
    const customer = await input.deps.stripeCustomerOf(referral.referrerUserId);
    if (!customer) {
      warn(`[referral] reward waiting: member has no Stripe customer referral=${referral.id}`);
      return 'pending';
    }
    const reference = await input.deps.creditFreeMonth(customer, referral.id);
    await input.deps.markRewarded(referral.id, reference);
    console.log(JSON.stringify({ referral: 'rewarded', id: referral.id }));
    return 'rewarded';
  } catch (err) {
    warn(`[referral] reward failed (a redelivery retries it): ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

/** The production dependencies: PostgREST for the rows, Stripe's REST API for the credit. */
export function referralRewardDeps(env: ReferralEnv): ReferralRewardDeps {
  return {
    async pendingReferralFor(referredUserId) {
      const rows = await selectRows(env, `referrals?select=id,referrer_user_id&referred_user_id=eq.${encodeURIComponent(referredUserId)}&status=eq.pending&limit=1`);
      const row = rows[0];
      return row && typeof row.referrer_user_id === 'string' ? { id: String(row.id), referrerUserId: row.referrer_user_id } : null;
    },
    async rewardsSince(referrerUserId, sinceIso) {
      const rows = await selectRows(env, `referrals?select=id&referrer_user_id=eq.${encodeURIComponent(referrerUserId)}&status=eq.rewarded&rewarded_at=gte.${encodeURIComponent(sinceIso)}`);
      return rows.length;
    },
    async stripeCustomerOf(referrerUserId) {
      const subscription = await subscriptionOf(env, referrerUserId);
      return subscription && String(subscription.billing_provider ?? 'stripe') !== 'apple' && typeof subscription.stripe_customer_id === 'string'
        ? subscription.stripe_customer_id : null;
    },
    async creditFreeMonth(customerId, referralId) {
      const key = (env.STRIPE_SECRET_KEY ?? '').trim();
      if (!key) throw new Error('stripe_unconfigured');
      const form = new URLSearchParams({
        amount: String(-REFERRAL_REWARD_PENCE),
        currency: 'gbp',
        description: 'Referral reward: a free month (a friend you invited joined)',
        'metadata[referral_id]': referralId,
      });
      const res = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}/balance_transactions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `referral-reward-${referralId}` },
        body: form,
      });
      const body = await res.json().catch(() => null) as { id?: unknown } | null;
      if (!res.ok || typeof body?.id !== 'string') throw new Error(`stripe_credit_failed_${res.status}`);
      return body.id;
    },
    async markRewarded(referralId, reference) {
      const res = await rest(env, `referrals?id=eq.${encodeURIComponent(referralId)}&status=eq.pending`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'rewarded', rewarded_at: new Date().toISOString(), reward_reference: reference }),
      });
      if (!res.ok) throw new Error(`referral_mark_failed_${res.status}`);
    },
    async markVoid(referralId, reason) {
      const res = await rest(env, `referrals?id=eq.${encodeURIComponent(referralId)}&status=eq.pending`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'void', void_reason: reason }),
      });
      if (!res.ok) throw new Error(`referral_mark_failed_${res.status}`);
    },
  };
}
