// Admin business-intelligence endpoint: the numbers Alex and Dan run the
// business on, computed LIVE from the systems that already hold them.
//
// Born 2026-08-04 replacing the throwaway delegent-econ workers.dev page,
// which was a static point-in-time snapshot behind its own ad-hoc login. This
// is the opposite on every axis that mattered: served from the real product
// surface (delegent-app.web.app/admin), gated on real Supabase accounts named
// in an explicit allowlist, and computed from live state on every load, so
// there is no "is this current?" question at all.
//
// SECURITY MODEL. The gate is enforced HERE, server-side, not in the client:
// the caller must present a valid Supabase access token AND the resolved user
// id must be in SIDEKICK_ADMIN_USER_IDS (a comma-separated wrangler var; user
// ids are not secrets). Everything returned is owner-eyes-only business data,
// so there is no partial view for non-admins: you are on the list or you get
// 403 with no detail. Provider internals (Fly app names, machine ids) are
// still never returned; admins see money and health, not infrastructure
// coordinates.
//
// Like push.ts, this module is self-contained (own env shape, own Supabase
// helpers) so it is testable from built output without dragging index.ts in.

import { AGENT_PLAN, SIDEKICK_PLAN_TIERS, type PlanTierId } from '@sidekick/shared';

export interface AdminEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Read-only here, and only to put a cardholder name against a customer. */
  STRIPE_SECRET_KEY?: string;
  /** Comma-separated Supabase user ids allowed to read the dashboard. */
  SIDEKICK_ADMIN_USER_IDS?: string;
}

// ---------------------------------------------------------------------------
// Unit economics. Every figure carries its source; MEASURED beats LIST beats
// ESTIMATE. When a number changes upstream, change it here and the whole
// dashboard (per-user margins AND projections) recomputes from it.
// ---------------------------------------------------------------------------
export const UNIT_ECONOMICS = {
  /**
   * What a million metered tokens actually costs us, in USD.
   *
   * This is not a guess and not a blend of list prices: the engine meters every
   * reply by the provider's own reported cost at $0.20 a million (AGENT_USAGE
   * in packages/shared), so a metered token IS a unit of spend. MEASURED
   * 2026-09-19 over the last 30 days of `token_usage_events` that carry a
   * price: $0.2005 per million on the engine path and $0.2139 on the old
   * worker path. Held at 0.20 because that is the rate the meter charges at.
   *
   * Honest caveat, because the next session will otherwise re-derive it and
   * reach a different number: only about 11% of usage events carry a cost at
   * all (135 of 1,193 over those 30 days). The rest come from the old worker
   * path, which recorded tokens and no price. So 0.20 is a rate confirmed on a
   * sample, not a measurement across the whole book. The engine records cost on
   * every reply, so this becomes a full measurement as the old rows age out.
   */
  usdPerMTokMetered: 0.2,
  /**
   * Talk, per minute, worst case. OpenAI realtime list at the mix we send.
   * Talk is capped at AGENT_TALK_SECONDS_PER_CYCLE (15 minutes) for a paying
   * account and 5 for the free month, so this cannot run away.
   */
  talkUsdPerMinute: 0.069,
  /** ESTIMATE: GBP/USD used to express USD provider costs in GBP. */
  usdPerGbp: 1.27,
  /** Stripe UK card rate. A non-UK card is 3.25% + 20p, which is the worst case. */
  stripePercent: 0.015,
  stripeFixedGbp: 0.2,
  stripeWorstPercent: 0.0325,
  /**
   * Apple's cut. CONFIRMED 15%, not assumed: Apple's acceptance mail to
   * customer82@example.com on 2026-09-14 says "the commission rate on your
   * paid apps and in-app purchases is now 15%", and the application was made
   * on 2026-08-19. There is no API for this; the inbox is the only evidence
   * path, and App Store Connect does not expose enrolment state at all.
   *
   * Two things this does NOT model, both deliberate: proceeds before
   * 2026-09-14 were taken at 30%, which only matters when reconciling
   * historical payouts, and the rate reverts to 30% if proceeds pass $1M in a
   * calendar year, which is a problem worth having.
   */
  appleCommission: 0.15,
} as const;

/** The engine's own prices, so the dashboard cannot drift from what we sell. */
export const PLAN_PRICE_GBP = 3.99;

/**
 * How far back per-customer usage is measured. A month rather than a billing
 * cycle, because cycles start on the day each person subscribed and most of
 * them have just reset, which reads as customers who use nothing.
 */
export const USAGE_WINDOW_DAYS = 30;

/**
 * Apple sets its prices in App Store Connect, not in our code, so they are
 * recorded here by product id. The two legacy products were taken off sale on
 * 2026-09-18 but existing subscribers stay on them until they move or lapse.
 */
export const APPLE_PRODUCT_PRICE_GBP: Record<string, number> = {
  'com.sidekick.v2.assistant.monthly': 3.99,
  'com.sidekick.v2.studio.monthly': 9.99,
  'com.sidekick.v2.pro.monthly': 24.99,
  'com.sidekick.v2.max.monthly': 59.99,
};

/** What we keep from a monthly payment after the biller takes its cut. */
export function netOfBillingFees(grossGbp: number, provider: string): number {
  if (grossGbp <= 0) return 0;
  if (provider === 'apple') return grossGbp * (1 - UNIT_ECONOMICS.appleCommission);
  return grossGbp * (1 - UNIT_ECONOMICS.stripePercent) - UNIT_ECONOMICS.stripeFixedGbp;
}

/** The biller's cut itself, which the tables show as its own line. */
export function billingFeeGbp(grossGbp: number, provider: string): number {
  return grossGbp <= 0 ? 0 : grossGbp - netOfBillingFees(grossGbp, provider);
}

/** Inference cost in GBP for a number of metered tokens. */
export function inferenceGbpForTokens(tokens: number): number {
  return ((Math.max(0, tokens) / 1_000_000) * UNIT_ECONOMICS.usdPerMTokMetered) / UNIT_ECONOMICS.usdPerGbp;
}

/** Talk cost in GBP for a number of seconds spoken. */
export function talkGbpForSeconds(seconds: number): number {
  return ((Math.max(0, seconds) / 60) * UNIT_ECONOMICS.talkUsdPerMinute) / UNIT_ECONOMICS.usdPerGbp;
}

// ---------------------------------------------------------------------------
// Fixed monthly costs: what the business pays regardless of subscriber count.
// Re-audited 2026-09-19 against the FreeAgent transaction feed rather than
// against memory, which is how three of these were wrong: Expo bills $19 a
// month and was listed at zero, the Apple Developer Program is £79 a year and
// was missing entirely, and Fly was still being charged for after the org was
// closed. Amounts in GBP/month; annual items are divided by 12 and say so.
// ---------------------------------------------------------------------------
export interface FixedCost {
  readonly label: string;
  readonly gbpMonthly: number;
  readonly basis: 'measured' | 'estimate';
  readonly note: string;
}

export const FIXED_MONTHLY_COSTS: readonly FixedCost[] = [
  { label: 'Expo EAS (builds and OTA)', gbpMonthly: 14.6, basis: 'measured', note: '$19/mo production plan. Seen in the bank feed at £14.60 on 14 Aug and £14.63 on 14 Sep. This was listed as free until 2026-09-19 and is the single largest fixed cost.' },
  { label: 'Apple Developer Program', gbpMonthly: 6.58, basis: 'measured', note: '£79.00 paid 2026-08-13 for the year, shown monthly. Renews 2027-08-13.' },
  { label: 'ICO registration', gbpMonthly: 4.33, basis: 'measured', note: '£52.00/yr paid 2026-05-31 (receipt C1946826), shown monthly.' },
  { label: 'GitHub Team', gbpMonthly: 3.15, basis: 'measured', note: '$4.00/mo seat. Actions overage bills on top and is the line below, because it moves with how much we ship.' },
  { label: 'GitHub Actions overage', gbpMonthly: 11, basis: 'estimate', note: 'Not fixed at all: £0 in July, then £13.54 in August and £11.24 in September as CI churn rose. Shown at a recent average so the break-even is not flattered. Batch PRs and this falls.' },
  { label: 'Domains (delegentai.co.uk + delegantai.co.uk)', gbpMonthly: 2, basis: 'estimate', note: '~£24/yr across both, shown monthly.' },
  { label: 'Zoho mail', gbpMonthly: 0.96, basis: 'measured', note: '£11.52/yr paid 2026-06-12 (Mail Lite, annual), shown monthly.' },
  { label: 'Supabase', gbpMonthly: 0, basis: 'measured', note: 'Free tier. No Supabase charge has ever reached the bank feed.' },
  { label: 'Cloudflare Workers Paid', gbpMonthly: 4, basis: 'measured', note: '$5/month for the whole account from 2026-09-23 (Alex bought it; the free plan broke the inbox sort). Includes 10M requests, 1M Durable Object requests and 500,000 Workflow steps a month; overage from $0.30 per million requests.' },
  { label: 'AI spend that is not customer chat', gbpMonthly: 35, basis: 'estimate', note: 'Development, testing, advert generation and Talk. The bank feed shows £34.01 of AI providers in August and £69.26 in September to date, against about £4.50 a month of modelled customer inference, so the great majority of what we spend on AI is us, not customers. Carried here so the break-even is not flattered by leaving it out. It falls when advert generation stops.' },
  { label: 'Sentry, Resend', gbpMonthly: 0, basis: 'measured', note: 'Both on free tiers as of 2026-09-19.' },
  { label: 'Fly.io', gbpMonthly: 0, basis: 'measured', note: 'Was £30.51 in August and £39.54 in July for the per-user runners. The runners were destroyed and the org closed on 2026-09-18, so this is zero from October. A final part-month invoice for 1 to 18 September is still expected.' },
];

export function fixedCostsGbpMonthly(): number {
  return FIXED_MONTHLY_COSTS.reduce((sum, c) => sum + c.gbpMonthly, 0);
}

// ---------------------------------------------------------------------------
// Spend to date: everything the business has actually paid out, as opposed to
// the monthly running costs above. GBP values are FREEAGENT'S OWN, converted
// at each transaction date's rate, covering both spend paths: director-paid
// expenses (on the director's loan) and card purchases on the Mettle account.
// Transcribed from FreeAgent on 2026-08-12 (26 expenses + 8 bank purchases,
// every one evidenced in the operations repo or explained in the bank feed).
//
// This static table is the FALLBACK. When the finance_snapshot Supabase table
// has a row (written daily by infra/scripts/freeagent-finance-snapshot.py on
// the box), the dashboard serves that live feed instead and this table is
// ignored, so it only needs retranscribing if the snapshot pipeline dies.
// ---------------------------------------------------------------------------
export interface CapexRow {
  readonly date: string;
  readonly category: string;
  readonly vendor: string;
  readonly description: string;
  readonly amountGbp: number;
}

export const CAPEX_LEDGER: readonly CapexRow[] = [
  { date: '2026-05-17', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits top-up (ref 1961-9218)', amountGbp: 9.45 },
  { date: '2026-05-17', category: 'Office', vendor: 'Registered Office (UK) Ltd', description: 'Registered office + director service address, 1 year', amountGbp: 59.98 },
  { date: '2026-05-19', category: 'Formation', vendor: 'Companies House (via Tide)', description: 'Incorporation fee, Delegent AI', amountGbp: 14.99 },
  { date: '2026-05-20', category: 'Office', vendor: 'Tide / Hoxton Mix', description: 'Virtual office address (monthly; possible duplicate office service)', amountGbp: 27.59 },
  { date: '2026-05-31', category: 'Compliance', vendor: 'ICO', description: 'Data protection fee registration', amountGbp: 52.0 },
  { date: '2026-05-31', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits top-up (ref 2670-5791)', amountGbp: 8.06 },
  { date: '2026-06-02', category: 'Hosting', vendor: 'Fly.io', description: 'Per-user runner hosting, monthly invoice', amountGbp: 72.64 },
  { date: '2026-06-09', category: 'Platform fees', vendor: 'Google', description: 'Google Play developer registration (one-off)', amountGbp: 18.75 },
  { date: '2026-06-11', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits top-up (ref 2150-6193)', amountGbp: 9.74 },
  { date: '2026-06-12', category: 'Software', vendor: 'Zoho', description: 'Workplace Mail Lite, annual, customer82@example.com', amountGbp: 11.52 },
  { date: '2026-06-29', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits top-up (ref 2113-4700)', amountGbp: 9.87 },
  { date: '2026-06-29', category: 'Software', vendor: 'GitHub', description: 'Team seat, monthly (Mettle card)', amountGbp: 3.04 },
  { date: '2026-07-02', category: 'Hosting', vendor: 'Fly.io', description: 'Per-user runner hosting, monthly invoice', amountGbp: 47.53 },
  { date: '2026-07-08', category: 'AI services', vendor: 'Anthropic', description: 'Claude usage (ref 2947-3914-2075)', amountGbp: 8.99 },
  { date: '2026-07-08', category: 'AI services', vendor: 'Anthropic', description: 'Claude usage (ref 2253-0048-7225)', amountGbp: 35.97 },
  { date: '2026-07-08', category: 'AI services', vendor: 'Anthropic', description: 'Claude usage (ref 2750-3019-5912)', amountGbp: 112.39 },
  { date: '2026-07-08', category: 'AI services', vendor: 'Anthropic', description: 'Claude usage (ref 2983-6883-1388)', amountGbp: 134.87 },
  { date: '2026-07-08', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits top-up (ref 2604-3208)', amountGbp: 9.76 },
  { date: '2026-07-16', category: 'AI services', vendor: 'OpenAI', description: 'API credit (Mettle card)', amountGbp: 4.5 },
  { date: '2026-07-16', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2630-6247)', amountGbp: 23.48 },
  { date: '2026-07-17', category: 'AI services', vendor: 'ElevenLabs', description: 'Text-to-speech API credit (Mettle card)', amountGbp: 5.55 },
  { date: '2026-07-17', category: 'Advertising', vendor: 'Kling AI', description: 'Video generation for the promo video and advert assets', amountGbp: 18.48 },
  { date: '2026-07-17', category: 'Advertising', vendor: 'Kling AI', description: 'Video generation for the promo video and advert assets', amountGbp: 6.46 },
  { date: '2026-07-19', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2265-6628)', amountGbp: 23.63 },
  { date: '2026-07-20', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2632-1484)', amountGbp: 23.65 },
  { date: '2026-07-21', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2755-6818)', amountGbp: 23.67 },
  { date: '2026-07-22', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2453-2013)', amountGbp: 23.76 },
  { date: '2026-07-23', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2756-7206)', amountGbp: 19.01 },
  { date: '2026-07-25', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2266-4915)', amountGbp: 23.87 },
  { date: '2026-07-30', category: 'Software', vendor: 'GitHub', description: 'Team seat, monthly (Mettle card)', amountGbp: 3.01 },
  { date: '2026-08-02', category: 'Hosting', vendor: 'Fly.io', description: 'Per-user runner hosting, monthly invoice', amountGbp: 39.54 },
  { date: '2026-08-05', category: 'AI services', vendor: 'OpenRouter', description: 'LLM API credits auto top-up (ref 2172-2817)', amountGbp: 9.68 },
  { date: '2026-08-07', category: 'Advertising', vendor: 'Meta', description: 'Company ad account top-up (Mettle card)', amountGbp: 100.0 },
  { date: '2026-08-10', category: 'Advertising', vendor: 'Zeely AI', description: 'Ad video creation app (Mettle card)', amountGbp: 14.89 },
];

export function capexReceiptedTotalGbp(): number {
  return Math.round(CAPEX_LEDGER.reduce((sum, r) => sum + r.amountGbp, 0) * 100) / 100;
}

/**
 * What AI providers actually charged us this calendar month, from the daily
 * FreeAgent snapshot. Vendor names are matched rather than categories, because
 * FreeAgent books all of them under "Computer Software" alongside everything
 * else. Returns null when there is no snapshot to read.
 */
export function aiProviderSpendThisMonth(
  financeActuals: Record<string, unknown> | null,
  now = new Date(),
): number | null {
  const rows = Array.isArray(financeActuals?.rows) ? (financeActuals?.rows as Record<string, unknown>[]) : null;
  if (!rows) return null;
  const month = now.toISOString().slice(0, 7);
  const isAi = /openai|openrouter|elevenlabs|anthropic/i;
  const total = rows
    .filter((r) => String(r.date ?? '').startsWith(month) && isAi.test(String(r.description ?? '')))
    .reduce((sum, r) => sum + Number(r.amountGbp ?? 0), 0);
  return round2(total);
}

// ---------------------------------------------------------------------------
// Customer funnel classification. Three honest buckets instead of one flat
// "users" list (Alex, launch day: "you just list all the people and say they
// are customers, where in actual fact me and Dan are the only real ones"):
//
//   active    a subscription in good standing today
//   past      PAID at least once (a Stripe customer id exists) but not active
//             now; their workspace sleeps through the 60-day grace window
//   prospect  signed in (a profile exists) but never completed checkout: the
//             paywall-bounce signal the ads will be judged by
// ---------------------------------------------------------------------------
export type CustomerKind = 'active' | 'past' | 'prospect';

export function classifyCustomer(input: {
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  /** Apple's money trail, the counterpart of a Stripe customer id. */
  appleOriginalTransactionId?: string | null;
}): CustomerKind {
  if (input.subscriptionStatus === 'active' || input.subscriptionStatus === 'trialing') return 'active';
  if (input.stripeCustomerId || input.appleOriginalTransactionId) return 'past';
  return 'prospect';
}

/**
 * An App Store SANDBOX purchase: Apple's app reviewers and our own TestFlight
 * testers, never a customer. Sandbox renewals run on an accelerated clock, so
 * such a row can read "active" indefinitely. On 2026-09-23 one did, and the
 * Active count Alex watches read 17 when 16 were real. Every sandbox row is
 * left out of every list and count.
 */
export function isAppleSandbox(subscription: Record<string, unknown> | undefined | null): boolean {
  return String(subscription?.billing_provider ?? '') === 'apple' && String(subscription?.apple_environment ?? '') === 'Sandbox';
}

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------
export function parseAdminUserIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)),
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

async function resolveUserId(env: AdminEnv, accessToken: string): Promise<string | null> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return null;
  try {
    const response = await fetch(`${base}/auth/v1/user`, {
      headers: { accept: 'application/json', apikey: key, authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: string };
    return typeof body.id === 'string' && body.id.length > 0 ? body.id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** null means authorised; otherwise the error Response to return. */
export async function rejectUnlessAdmin(request: Request, env: AdminEnv): Promise<Response | null> {
  const token = bearerToken(request);
  if (!token) return jsonResponse({ error: 'unauthorized' }, 401);
  const admins = parseAdminUserIds(env.SIDEKICK_ADMIN_USER_IDS);
  if (admins.size === 0) return jsonResponse({ error: 'admin_disabled' }, 403);
  const userId = await resolveUserId(env, token);
  if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!admins.has(userId)) return jsonResponse({ error: 'forbidden' }, 403);
  return null;
}

// ---------------------------------------------------------------------------
// Supabase reads (service-role, read-only)
// ---------------------------------------------------------------------------
/** PostgREST's server-side row cap on this project; also the page size. */
export const ADMIN_PAGE_SIZE = 1000;
const ADMIN_MAX_PAGES = 200;

/**
 * Every row the query matches, paged.
 *
 * PostgREST caps a response at 1000 rows on this project regardless of the
 * `limit` in the query, and it does so silently. The 7-day burn read below
 * asked for `limit=10000`, got the first thousand events, and reported a
 * runway computed from a seventh of a busy week. Every list on this page has
 * the same ceiling once there are a thousand of anything, so the reader pages
 * rather than trusting one response. Callers pass `order=` so pages are stable.
 */
async function selectRows(env: AdminEnv, table: string, query: string): Promise<Record<string, unknown>[]> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < ADMIN_MAX_PAGES; page += 1) {
    const response = await fetch(`${base}/rest/v1/${table}?${query}&limit=${ADMIN_PAGE_SIZE}&offset=${offset}`, {
      headers: { accept: 'application/json', apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
    });
    if (!response.ok) throw new Error(`${table} read failed (${response.status})`);
    const body = await response.json();
    const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
    all.push(...rows);
    offset += rows.length;
    if (rows.length === 0) break;
    const total = Number.parseInt(((response.headers.get('content-range') ?? '').match(/\/(\d+)\s*$/) ?? [])[1] ?? '', 10);
    if (Number.isSafeInteger(total) ? offset >= total : rows.length < ADMIN_PAGE_SIZE) break;
  }
  return all;
}

/**
 * The latest FreeAgent actuals, written daily into finance_snapshot by
 * infra/scripts/freeagent-finance-snapshot.py on the box. Tolerant on purpose:
 * the table may not exist yet and the dashboard must not 500 over missing
 * bookkeeping data, so any failure here reads as "no snapshot".
 */
async function readFinanceSnapshot(env: AdminEnv): Promise<Record<string, unknown> | null> {
  try {
    const rows = await selectRows(env, 'finance_snapshot', 'select=taken_at,payload&id=eq.1');
    const payload = rows[0]?.payload;
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-user economics
// ---------------------------------------------------------------------------
export interface UserEconomicsRow {
  /** The person's own name where we hold one, otherwise empty. */
  name: string;
  email: string;
  tierId: PlanTierId | null;
  subscriptionStatus: string;
  /** 'stripe' or 'apple': which shop they bought through, and whose cut applies. */
  billingProvider: string;
  consumedTokensThisCycle: number;
  quotaTokens: number;
  talkSecondsThisCycle: number;
  /** What they pay, before anyone takes a cut. */
  revenueGbp: number;
  /** Stripe's percentage and fixed fee, or Apple's commission. */
  billingFeeGbp: number;
  inferenceGbp: number;
  talkGbp: number;
  marginGbp: number;
  marginPct: number | null;
}

export function computeUserRow(input: {
  name?: string;
  email: string;
  tierId: string | null;
  subscriptionStatus: string;
  billingProvider?: string | null;
  /** What this person actually pays each month, read from Stripe or Apple. */
  priceGbp?: number | null;
  consumedTokens: number;
  quotaTokens: number;
  talkSeconds?: number;
}): UserEconomicsRow {
  const tier = SIDEKICK_PLAN_TIERS.find((t) => t.id === input.tierId) ?? null;
  const active = input.subscriptionStatus === 'active' || input.subscriptionStatus === 'trialing';
  const provider = String(input.billingProvider ?? 'stripe');
  // The price comes from the billing system, never from a tier constant. Half
  // the paying customers are on legacy prices the plan table no longer knows
  // about, and quoting everyone one price made MRR wrong in both directions.
  // >= 0, not > 0: a 100%-off coupon bills exactly nothing, and treating that
  // as "no price known" would fall back to the list price and invent revenue.
  // The test account is on exactly such a coupon, so this is not theoretical.
  const priced =
    typeof input.priceGbp === 'number' && Number.isFinite(input.priceGbp) && input.priceGbp >= 0
      ? input.priceGbp
      : PLAN_PRICE_GBP;
  // A free month earns nothing, and counting it as revenue inflates MRR by the
  // number of people who have not paid anything yet.
  const revenueGbp = active && input.subscriptionStatus !== 'trialing' ? priced : 0;
  const feeGbp = billingFeeGbp(revenueGbp, provider);
  const inferenceGbp = inferenceGbpForTokens(input.consumedTokens);
  const talkGbp = talkGbpForSeconds(input.talkSeconds ?? 0);
  const marginGbp = revenueGbp - feeGbp - inferenceGbp - talkGbp;
  return {
    name: String(input.name ?? '').trim(),
    email: input.email,
    tierId: (tier?.id as PlanTierId) ?? null,
    subscriptionStatus: input.subscriptionStatus,
    billingProvider: provider,
    consumedTokensThisCycle: input.consumedTokens,
    quotaTokens: input.quotaTokens,
    talkSecondsThisCycle: Math.max(0, Math.round(input.talkSeconds ?? 0)),
    revenueGbp: round2(revenueGbp),
    billingFeeGbp: round2(feeGbp),
    inferenceGbp: round2(inferenceGbp),
    talkGbp: round2(talkGbp),
    marginGbp: round2(marginGbp),
    marginPct: revenueGbp > 0 ? round2((marginGbp / revenueGbp) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Projections. The question these have to answer is Alex's, asked 2026-09-19:
// how many customers do I need for a given profit, and what happens if they
// turn out to be heavy users rather than light ones.
//
// So it models several kinds of customer rather than one average, and takes
// the usage of each FROM LIVE DATA where there is any. A made-up average is
// what made the old projections useless: they charged every subscriber for a
// server that no longer exists and assumed 30% of a 19.55M allowance, roughly
// forty times what a real customer actually uses.
// ---------------------------------------------------------------------------
export interface UsagePersona {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly talkSeconds: number;
  readonly note: string;
}

export interface ProjectionPoint {
  subscribers: number;
  revenueGbp: number;
  billingFeeGbp: number;
  inferenceGbp: number;
  talkGbp: number;
  fixedGbp: number;
  profitGbp: number;
  marginPct: number;
}

export interface ProjectionScenario {
  key: string;
  label: string;
  note: string;
  tokens: number;
  talkSeconds: number;
  /** What one subscriber contributes a month, after the biller and their usage. */
  contributionGbp: number;
  /** Subscribers needed to cover the fixed costs. */
  breakEvenSubscribers: number | null;
  /** Subscribers needed for each profit target. */
  targets: { profitGbp: number; subscribers: number | null }[];
  points: ProjectionPoint[];
}

/**
 * The four kinds of customer the plan has to survive, at fixed usage levels
 * chosen against the 16M allowance rather than measured. These are the
 * PLANNING table: they stay put as customers come and go, so "how many do I
 * need" has a stable answer, and the heavy and maxed rows say what happens if
 * the people who arrive are nothing like the people here now.
 */
export const MODEL_PERSONAS: readonly UsagePersona[] = [
  { key: 'light', label: 'Light', tokens: 100_000, talkSeconds: 0, note: 'a few jobs a month' },
  { key: 'typical', label: 'Typical', tokens: 1_500_000, talkSeconds: 60, note: 'weekly use, about a tenth of the allowance' },
  { key: 'heavy', label: 'Heavy', tokens: 6_000_000, talkSeconds: 300, note: 'most days, about a third of the allowance' },
  { key: 'maxed', label: 'Maxed out', tokens: 16_000_000, talkSeconds: 900, note: 'every last token and every minute of Talk' },
];

const PROFIT_TARGETS = [250, 1_000, 5_000];

/**
 * One subscriber's monthly contribution: what they pay, less the biller's cut
 * and what they cost to serve. Fixed costs are not in here; they are carried
 * once across the whole book inside the projection.
 */
export function contributionGbp(persona: UsagePersona, priceGbp: number, appleShare: number): number {
  const share = clamp(appleShare, 0, 1);
  const net = netOfBillingFees(priceGbp, 'apple') * share + netOfBillingFees(priceGbp, 'stripe') * (1 - share);
  return net - inferenceGbpForTokens(persona.tokens) - talkGbpForSeconds(persona.talkSeconds);
}

export function computeProjections(options?: {
  /** The personas to model. Defaults to the fixed planning table above. */
  personas?: readonly UsagePersona[];
  /** Fraction of subscribers paying through Apple, so Apple's cut is weighted. */
  appleShare?: number;
  priceGbp?: number;
  counts?: readonly number[];
}): { assumptions: Record<string, string>; personas: UsagePersona[]; scenarios: ProjectionScenario[] } {
  const personas = (options?.personas?.length ? options.personas : MODEL_PERSONAS).slice();
  const appleShare = clamp(options?.appleShare ?? 0.5, 0, 1);
  const price = options?.priceGbp ?? PLAN_PRICE_GBP;
  const counts = options?.counts ?? [10, 25, 50, 100, 250, 500, 1_000, 5_000];
  const fixedGbp = fixedCostsGbpMonthly();
  const feePerSubscriber =
    billingFeeGbp(price, 'apple') * appleShare + billingFeeGbp(price, 'stripe') * (1 - appleShare);

  const scenarios = personas.map((persona) => {
    const contribution = contributionGbp(persona, price, appleShare);
    const need = (profit: number) => (contribution > 0 ? Math.ceil((fixedGbp + profit) / contribution) : null);
    const points = counts.map((n) => {
      const revenueGbp = n * price;
      const billingFee = n * feePerSubscriber;
      const inference = n * inferenceGbpForTokens(persona.tokens);
      const talk = n * talkGbpForSeconds(persona.talkSeconds);
      const profitGbp = revenueGbp - billingFee - inference - talk - fixedGbp;
      return {
        subscribers: n,
        revenueGbp: round2(revenueGbp),
        billingFeeGbp: round2(billingFee),
        inferenceGbp: round2(inference),
        talkGbp: round2(talk),
        fixedGbp: round2(fixedGbp),
        profitGbp: round2(profitGbp),
        marginPct: revenueGbp > 0 ? round2((profitGbp / revenueGbp) * 100) : 0,
      };
    });
    return {
      key: persona.key,
      label: persona.label,
      note: persona.note,
      tokens: persona.tokens,
      talkSeconds: persona.talkSeconds,
      contributionGbp: round2(contribution),
      breakEvenSubscribers: need(0),
      targets: PROFIT_TARGETS.map((profitGbp) => ({ profitGbp, subscribers: need(profitGbp) })),
      points,
    };
  });

  return {
    assumptions: {
      price: `£${price.toFixed(2)} a month, one plan`,
      billing: `${Math.round(appleShare * 100)}% of subscribers pay through Apple at ${Math.round(UNIT_ECONOMICS.appleCommission * 100)}% commission, the rest through Stripe at ${(UNIT_ECONOMICS.stripePercent * 100).toFixed(1)}% + ${(UNIT_ECONOMICS.stripeFixedGbp * 100).toFixed(0)}p`,
      inference: `$${UNIT_ECONOMICS.usdPerMTokMetered.toFixed(2)} per million metered tokens, the rate the meter itself charges at (measured $0.2005 live over 30 days)`,
      talk: `$${UNIT_ECONOMICS.talkUsdPerMinute.toFixed(3)} a minute, capped at 15 minutes a month by the engine`,
      fixed: `£${fixedGbp.toFixed(2)} a month of fixed costs, carried whatever the subscriber count`,
      fx: `$${UNIT_ECONOMICS.usdPerGbp.toFixed(2)} to £1`,
    },
    personas,
    scenarios,
  };
}

// ---------------------------------------------------------------------------
// Important dates. status 'verify' means the date is derived or assumed and a
// human must confirm it at the named source; the UI shows those amber until
// replaced with a confirmed date. daysLeft < 0 means overdue.
// ---------------------------------------------------------------------------
export interface ImportantDate {
  label: string;
  category: 'company' | 'tax' | 'credentials' | 'providers';
  due: string | null; // ISO date
  status: 'confirmed' | 'verify' | 'pending';
  note: string;
  daysLeft: number | null;
}

export function buildImportantDates(now: Date): ImportantDate[] {
  const entries: Omit<ImportantDate, 'daysLeft'>[] = [
    {
      label: 'Microsoft OAuth client secrets expire (Outlook + Teams)',
      category: 'credentials',
      due: '2028-07-31',
      status: 'verify',
      note: 'Azure limits client secrets to 24 months; the connections launched 2026-08-01, so the secrets die by August 2028 at the latest. Confirm the exact date in the Azure portal (App registrations, Certificates & secrets). When they lapse, every user’s Outlook and Teams connection silently stops refreshing.',
    },
    {
      label: 'Google Calendar verification decision',
      category: 'providers',
      due: null,
      status: 'pending',
      note: 'Submitted 1 Aug 2026. Google replies to customer82@example.com. Secrets stay out of the Worker until approved.',
    },
    {
      label: 'ICO registration renewal',
      category: 'company',
      due: '2027-05-31',
      status: 'verify',
      note: 'Annual, £40 tier 1. Assumed registered around May 2026; confirm the exact date on the ICO register and correct this entry.',
    },
    {
      label: 'Confirmation statement (Companies House)',
      category: 'company',
      due: '2027-05-14',
      status: 'verify',
      note: 'Due 14 days after the anniversary of incorporation, then annually. Confirm the exact date on the Companies House filing for company 00000000.',
    },
    {
      label: 'First annual accounts (Companies House)',
      category: 'company',
      due: '2028-01-31',
      status: 'verify',
      note: 'First accounts are due 21 months after incorporation. Confirm at Companies House; late filing is an automatic penalty.',
    },
    {
      label: 'Corporation tax registration / first CT600',
      category: 'tax',
      due: null,
      status: 'verify',
      note: 'CT600 due 12 months after the first accounting period ends; payment 9 months + 1 day after. Dates firm up once the first period end is confirmed with the accountant / FreeAgent setup.',
    },
    {
      label: 'Domain renewals (delegentai.co.uk, delegantai.co.uk)',
      category: 'providers',
      due: '2027-04-30',
      status: 'verify',
      note: 'Annual at the registrar (LCN). Confirm exact renewal dates; the API domain lapsing would take the whole product down.',
    },
  ];
  return entries.map((entry) => ({
    ...entry,
    daysLeft: entry.due ? Math.floor((Date.parse(entry.due) - now.getTime()) / 86_400_000) : null,
  }));
}

// ---------------------------------------------------------------------------
// Live monitoring probes (parallel, each individually fail-soft)
// ---------------------------------------------------------------------------
async function probe(url: string, timeoutMs = 8000): Promise<{ url: string; ok: boolean; status: number; ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { url, ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch {
    return { url, ok: false, status: 0, ms: Date.now() - started };
  }
}

async function openRouterCredits(env: AdminEnv): Promise<{ totalUsd: number; usedUsd: number; remainingUsd: number } | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { total_credits?: number; total_usage?: number } };
    const total = body.data?.total_credits ?? 0;
    const used = body.data?.total_usage ?? 0;
    return { totalUsd: round2(total), usedUsd: round2(used), remainingUsd: round2(total - used) };
  } catch {
    return null;
  }
}

/**
 * A display name for each person, best effort, so the customer tables read as
 * people rather than as email addresses (Alex, 2026-09-19).
 *
 * `profiles.full_name` is filled by the signup trigger from the sign-in
 * provider's metadata, so anyone who came in through Google already has one.
 * Anyone who signed up with an email address and a one-time code does not, and
 * the only name we hold for them is the one on their card, so fall back to
 * Stripe. Never let this fail the dashboard: an unnamed row still shows the
 * email, which is all the screen showed for anyone until now.
 */
async function resolveNames(
  env: AdminEnv,
  profiles: Record<string, unknown>[],
  subscriptions: Record<string, unknown>[],
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  // 1. The name on their profile, written by the signup trigger.
  for (const p of profiles) {
    const name = String(p.full_name ?? '').trim();
    if (name) byId.set(String(p.id), name);
  }

  // 2. The name the sign-in provider gave us, which for Apple arrives only
  // on the very first sign-in and is written to the auth metadata rather than
  // to profiles. Missing this source is why a customer whose name we DO hold
  // still showed as an email address on 2026-09-19.
  try {
    const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    for (let page = 1; page < 10; page += 1) {
      const response = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!response.ok) break;
      const users = ((await response.json()) as { users?: Record<string, unknown>[] }).users ?? [];
      for (const user of users) {
        const id = String(user.id ?? '');
        if (!id || byId.get(id)) continue;
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        const name = String(meta.full_name ?? meta.name ?? '').trim();
        if (name) byId.set(id, name);
      }
      if (users.length < 1000) break;
    }
  } catch {
    // Same rule as below: a name is a nicety, the dashboard is not.
  }

  // 3. The cardholder name, for anyone still unnamed who pays by card.
  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  const missing = subscriptions.filter((s) => s.stripe_customer_id && !byId.get(String(s.user_id)));
  if (!key || missing.length === 0) return byId;

  try {
    // One listing rather than a request per customer: this screen is read on a
    // phone and must not wait on a fan-out of Stripe calls.
    const response = await fetch('https://api.stripe.com/v1/customers?limit=100', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return byId;
    const body = (await response.json()) as { data?: { id?: string; name?: string | null }[] };
    const nameByCustomer = new Map((body.data ?? []).map((c) => [String(c.id ?? ''), String(c.name ?? '').trim()]));
    for (const s of missing) {
      const name = nameByCustomer.get(String(s.stripe_customer_id)) ?? '';
      if (name) byId.set(String(s.user_id), name);
    }
  } catch {
    // A name is a nicety. The dashboard is not.
  }
  return byId;
}

/**
 * The coupon id out of a Stripe discount, whatever shape it arrives in.
 *
 * The trap that made the first attempt at this read nothing: on this API
 * version the discount carries its coupon as a STRING id under `source.coupon`,
 * so `discount.coupon.percent_off` is undefined and the list price silently
 * survives. All four shapes seen are handled.
 */
export function couponIdOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry || null;
  if (!entry || typeof entry !== 'object') return null;
  const d = entry as Record<string, unknown>;
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string') return value || null;
    if (value && typeof value === 'object') return String((value as Record<string, unknown>).id ?? '') || null;
    return null;
  };
  return pick(d.coupon) ?? pick((d.source as Record<string, unknown> | undefined)?.coupon) ?? null;
}

/**
 * Every column the dashboard reads off a subscription.
 *
 * This exists as one list because it already went wrong the other way round:
 * resolvePrices read `stripe_subscription_id` while the select did not ask for
 * it, so PostgREST returned rows without the property, the coupon lookup never
 * ran, and every customer silently fell back to their LIST price. No error, no
 * log, just the wrong number on the screen, which is the exact fault this
 * change set exists to remove. A test asserts the readers' needs against this
 * list.
 */
export const SUBSCRIPTION_COLUMNS = [
  'user_id',
  'status',
  'stripe_customer_id',
  'stripe_subscription_id',
  'current_period_end',
  'billing_provider',
  'apple_product_id',
  'price_id',
  'apple_environment',
  'apple_original_transaction_id',
] as const;

/** The columns resolvePrices cannot do its job without. */
export const PRICE_COLUMNS = ['user_id', 'stripe_subscription_id', 'apple_product_id'] as const;

/** The columns isAppleSandbox and classifyCustomer read. */
export const CUSTOMER_COLUMNS = ['billing_provider', 'apple_environment', 'apple_original_transaction_id', 'stripe_customer_id', 'status'] as const;

/**
 * What each subscriber actually pays a month, read from the system that bills
 * them rather than from a plan constant.
 *
 * This matters more than it sounds. On 2026-09-19 the dashboard showed every
 * subscriber at £9.99 because that was the Studio tier price in the plan
 * table, while six of the twelve were on the £3.99 plan and two more were on
 * legacy Apple products. MRR was wrong by more than half.
 *
 * Stripe is asked once for every distinct price id, not once per customer.
 * Apple does not expose a price through the API we hold, so its products are
 * mapped from APPLE_PRODUCT_PRICE_GBP above.
 */
async function resolvePrices(env: AdminEnv, subscriptions: Record<string, unknown>[]): Promise<Map<string, number>> {
  const byUser = new Map<string, number>();
  const stripeSubIds: { userId: string; subscriptionId: string }[] = [];
  for (const s of subscriptions) {
    const apple = String(s.apple_product_id ?? '');
    if (apple && APPLE_PRODUCT_PRICE_GBP[apple] != null) {
      byUser.set(String(s.user_id), APPLE_PRODUCT_PRICE_GBP[apple]);
      continue;
    }
    const subscriptionId = String(s.stripe_subscription_id ?? '');
    if (subscriptionId) stripeSubIds.push({ userId: String(s.user_id), subscriptionId });
  }

  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key || stripeSubIds.length === 0) return byUser;

  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // Coupons are shared, so each one is fetched once however many people are on it.
  const couponCache = new Map<string, { percentOff: number; amountOffGbp: number } | null>();
  const coupon = async (couponId: string) => {
    if (couponCache.has(couponId)) return couponCache.get(couponId) ?? null;
    const body = await get(`coupons/${couponId}`);
    const value = body
      ? {
          percentOff: typeof body.percent_off === 'number' ? body.percent_off : 0,
          amountOffGbp: typeof body.amount_off === 'number' ? body.amount_off / 100 : 0,
        }
      : null;
    couponCache.set(couponId, value);
    return value;
  };

  for (const { userId, subscriptionId } of stripeSubIds) {
    const sub = await get(`subscriptions/${subscriptionId}?expand[]=discounts`);
    if (!sub) continue;
    const item = ((sub.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? [])[0];
    const price = item?.price as { unit_amount?: number | null; currency?: string } | undefined;
    // Everything we sell is priced in pounds; anything else is left unpriced
    // rather than silently counted as if it were.
    if (!price || price.currency !== 'gbp' || typeof price.unit_amount !== 'number') continue;
    let gbp = price.unit_amount / 100;

    // What they are BILLED, not what the plan lists at. Three of the four
    // Stripe customers are on launch coupons and the test account is on a
    // 100%-off internal one, so reading unit_amount alone overstated the
    // Stripe book by more than double (£29.94 listed against £13.17 billed,
    // checked live 2026-09-19). Found by a second session reviewing this.
    //
    // The shape is a trap: on this API version a subscription's discount
    // carries its coupon as a STRING id under `source.coupon`, so the
    // obvious `discount.coupon.percent_off` reads undefined and silently
    // yields the list price back. Every shape it has taken is handled.
    const discounts = Array.isArray(sub.discounts) ? (sub.discounts as unknown[]) : [];
    // Every discount, not just the first: nobody has two today, but a stacked
    // coupon would otherwise be half-counted, silently, in our favour.
    for (const entry of discounts) {
      const couponId = couponIdOf(entry);
      if (!couponId) continue;
      const applied = await coupon(couponId);
      if (!applied) continue;
      if (applied.percentOff > 0) gbp = gbp * (1 - applied.percentOff / 100);
      else if (applied.amountOffGbp > 0) gbp = gbp - applied.amountOffGbp;
      gbp = Math.max(0, gbp);
    }
    byUser.set(userId, Math.round(gbp * 100) / 100);
  }
  return byUser;
}

/**
 * What the people actually paying use, as ONE extra row beside the fixed
 * planning table, so the model can be read against reality without the
 * reality rewriting the model.
 *
 * Measured over a rolling window of token_usage_events, NOT over
 * consumed_tokens_this_cycle. That distinction is the whole point of this
 * function: percentiles of the current cycle made the live page say a light
 * customer uses 0 tokens and a typical customer uses 0 tokens, because most
 * cycles had just reset. A dashboard that says customers cost nothing is the
 * same flattery as the old 30%-of-quota assumption, pointing the other way.
 *
 * The median, not the mean: one heavy user among six quiet ones drags an
 * average somewhere no real customer sits. Returns null rather than a
 * fabricated row when there are too few payers to say anything.
 */
export function measuredPersona(
  samples: readonly { tokens: number; talkSeconds: number }[],
  windowDays = USAGE_WINDOW_DAYS,
): UsagePersona | null {
  if (samples.length < 3) return null;
  const tokens = samples.map((s) => s.tokens).sort((a, b) => a - b);
  const talk = samples.map((s) => s.talkSeconds).sort((a, b) => a - b);
  const median = (values: number[]) => {
    const middle = values.length / 2;
    return values.length % 2
      ? values[Math.floor(middle)]
      : Math.round(((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2);
  };
  const quiet = tokens.filter((t) => t === 0).length;
  return {
    key: 'measured',
    label: 'Your customers today',
    tokens: median(tokens),
    talkSeconds: median(talk),
    note:
      `the middle of ${samples.length} paying customers over the last ${windowDays} days` +
      (quiet ? `, ${quiet} of whom used nothing at all` : ''),
  };
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------
export async function handleAdminDashboard(request: Request, env: AdminEnv): Promise<Response> {
  const rejection = await rejectUnlessAdmin(request, env);
  if (rejection) return rejection;

  try {
    const [profiles, usage, subscriptions, voiceQuotas, probes, credits, recentUsage, financeActuals] = await Promise.all([
      selectRows(env, 'profiles', 'select=id,email,full_name,created_at&order=created_at.asc'),
      selectRows(env, 'usage_cycle_summary', 'select=user_id,tier_id,monthly_token_quota,subscription_status,consumed_tokens_this_cycle&order=user_id.asc'),
      selectRows(
        env,
        'subscriptions',
        `select=${SUBSCRIPTION_COLUMNS.join(',')}&order=user_id.asc`,
      ),
      // Talk is metered in seconds against a 15 minute monthly cap, and at
      // worst case it costs more than the inference does, so it belongs in
      // the margin rather than in a footnote.
      selectRows(env, 'usage_quotas', 'select=user_id,consumed_voice_seconds&order=user_id.asc'),
      Promise.all([
        probe('https://delegent-app.web.app'),
        probe('https://delegentai.co.uk'),
      ]),
      openRouterCredits(env),
      // One read serves two jobs: the last 7 days of it is the burn rate, and
      // the whole window is what the measured persona is taken from. Carries
      // user_id because per-customer usage is the half that cannot be
      // reconstructed from a total.
      //
      // No `limit=10000` here: PostgREST ignored it above 1000 and selectRows
      // pages anyway. Ordered so the pages cannot overlap.
      selectRows(
        env,
        'token_usage_events',
        `select=user_id,total_tokens,created_at&created_at=gte.${encodeURIComponent(new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000).toISOString())}&order=created_at.asc`,
      ),
      readFinanceSnapshot(env),
    ]);

    const emailById = new Map(profiles.map((p) => [String(p.id), String(p.email ?? '')]));
    const nameById = await resolveNames(env, profiles, subscriptions);
    const priceById = await resolvePrices(env, subscriptions);
    const subById = new Map(subscriptions.map((s) => [String(s.user_id), s]));
    const voiceById = new Map(voiceQuotas.map((q) => [String(q.user_id), Number(q.consumed_voice_seconds ?? 0)]));

    // Test accounts are the box's own throwaway identities: the contract
    // probes, the store-review mailinator logins, example.com fixtures. NOT
    // passmail.net: that is Proton Pass, an alias service real people use.
    // It sat in this list until 2026-09-09, when Alex's friend subscribed
    // through a Proton alias and the dashboard hid him, and his £2.99, as a
    // test account ("nothing on my dashboard as a new customer").
    const testAccount = (email: string) =>
      /@(delegent-test\.invalid|example\.com|mailinator\.com)$/i.test(email) || email.startsWith('contract-');

    const userRows = usage
      .filter((row) => !isAppleSandbox(subById.get(String(row.user_id))))
      .map((row) => {
        const email = emailById.get(String(row.user_id)) ?? '(unknown)';
        const sub = subById.get(String(row.user_id));
        return computeUserRow({
          name: nameById.get(String(row.user_id)) ?? '',
          email,
          tierId: row.tier_id == null ? null : String(row.tier_id),
          subscriptionStatus: String(row.subscription_status ?? 'inactive'),
          billingProvider: sub?.billing_provider == null ? 'stripe' : String(sub.billing_provider),
          priceGbp: priceById.get(String(row.user_id)) ?? null,
          consumedTokens: Number(row.consumed_tokens_this_cycle ?? 0),
          // The allowance the ENGINE enforces, not the legacy quota row. Those
          // rows still say 19,550,000 from the old Studio plan while the engine
          // cuts off at 16,000,000, so the dashboard was showing a bar that is
          // a fifth longer than the one a customer actually gets.
          quotaTokens:
            String(row.subscription_status ?? '') === 'trialing'
              ? AGENT_PLAN.trialAllowanceTokens
              : AGENT_PLAN.monthlyAllowanceTokens,
          talkSeconds: voiceById.get(String(row.user_id)) ?? 0,
        });
      })
      .filter((row) => !testAccount(row.email))
      .sort((a, b) => a.marginGbp - b.marginGbp);

    const activeSubscribers = userRows.filter((r) => r.subscriptionStatus === 'active' || r.subscriptionStatus === 'trialing');
    const mrrGbp = round2(activeSubscribers.reduce((sum, r) => sum + r.revenueGbp, 0));
    const monthlyCostGbp = round2(
      userRows.reduce((sum, r) => sum + r.inferenceGbp + r.talkGbp + r.billingFeeGbp, 0) + fixedCostsGbpMonthly(),
    );

    // Usage per customer over the whole window, which is what the measured
    // persona needs. The cycle counters cannot answer this: they reset.
    const windowTokensByUser = new Map<string, number>();
    for (const event of recentUsage) {
      const userId = String(event.user_id ?? '');
      if (!userId) continue;
      windowTokensByUser.set(userId, (windowTokensByUser.get(userId) ?? 0) + Number(event.total_tokens ?? 0));
    }
    const idByEmailAll = new Map(profiles.map((p) => [String(p.email ?? ''), String(p.id)]));
    const payingSamples = activeSubscribers
      .filter((r) => r.revenueGbp > 0)
      .map((r) => {
        const userId = idByEmailAll.get(r.email) ?? '';
        return { tokens: windowTokensByUser.get(userId) ?? 0, talkSeconds: r.talkSecondsThisCycle };
      });
    // The fixed planning table first, then what today's customers actually do
    // beside it. Both, rather than either: the table answers "how many do I
    // need if they turn out heavy", the measured row answers "what are the
    // ones I have really costing me".
    const measured = measuredPersona(payingSamples);
    const personas = measured ? [...MODEL_PERSONAS, measured] : [...MODEL_PERSONAS];
    const appleShare = activeSubscribers.length
      ? activeSubscribers.filter((r) => r.billingProvider === 'apple').length / activeSubscribers.length
      : 0.5;

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const tokens7d = recentUsage
      .filter((r) => String(r.created_at ?? '') >= sevenDaysAgo)
      .reduce((sum, r) => sum + Number(r.total_tokens ?? 0), 0);
    const burnUsdPerDay = ((tokens7d / 7) / 1_000_000) * UNIT_ECONOMICS.usdPerMTokMetered;
    const runwayDays = credits && burnUsdPerDay > 0 ? Math.floor(credits.remainingUsd / burnUsdPerDay) : null;

    // Customer funnel: classify every real profile into active / past /
    // prospect. Prospects are the paywall-bounce signal the ads are judged
    // by: a profile exists (they installed and signed in) but Stripe never
    // saw them (no customer id), so they walked at or before the paywall.
    const subscriptionById = new Map(subscriptions.map((s) => [String(s.user_id), s]));
    const realProfiles = profiles.filter(
      (p) => !testAccount(String(p.email ?? '')) && !isAppleSandbox(subscriptionById.get(String(p.id))),
    );
    const kindById = new Map<string, CustomerKind>();
    for (const p of realProfiles) {
      const sub = subscriptionById.get(String(p.id));
      kindById.set(
        String(p.id),
        classifyCustomer({
          subscriptionStatus: String(sub?.status ?? 'inactive'),
          stripeCustomerId: sub?.stripe_customer_id == null ? null : String(sub.stripe_customer_id),
          appleOriginalTransactionId:
            sub?.apple_original_transaction_id == null ? null : String(sub.apple_original_transaction_id),
        }),
      );
    }
    const idByEmail = new Map(realProfiles.map((p) => [String(p.email ?? ''), String(p.id)]));
    const rowsOfKind = (kind: CustomerKind) =>
      userRows.filter((r) => kindById.get(idByEmail.get(r.email) ?? '') === kind);
    const pastRows = rowsOfKind('past').map((r) => {
      // When their paid period ran out, read from the billing record. This was
      // the Fly runner's suspended_at until 2026-09-19, which since the
      // runners were destroyed is null for everyone and told Alex nothing.
      const sub = subscriptionById.get(idByEmail.get(r.email) ?? '');
      return { ...r, lapsedAt: sub?.current_period_end == null ? null : String(sub.current_period_end) };
    });
    const prospects = realProfiles
      .filter((p) => kindById.get(String(p.id)) === 'prospect')
      .map((p) => ({
        name: nameById.get(String(p.id)) ?? '',
        email: String(p.email ?? ''),
        signedUpAt: String(p.created_at ?? ''),
      }))
      .sort((a, b) => (a.signedUpAt < b.signedUpAt ? 1 : -1));

    const body = {
      generatedAt: new Date().toISOString(),
      overview: {
        totalUsers: realProfiles.length,
        activeSubscribers: activeSubscribers.length,
        pastCustomers: pastRows.length,
        prospects: prospects.length,
        mrrGbp,
        monthlyCostGbp,
        monthlyProfitGbp: round2(mrrGbp - monthlyCostGbp),
        openRouter: credits ? { ...credits, estRunwayDays: runwayDays } : null,
        tokens7d,
      },
      customers: {
        active: rowsOfKind('active'),
        past: pastRows,
        prospects: { count: prospects.length, rows: prospects },
      },
      capex: {
        rows: CAPEX_LEDGER,
        receiptedTotalGbp: capexReceiptedTotalGbp(),
        // Provider spend that never passed through the inbox, verified live:
        // total OpenRouter credit ever purchased, in USD from their API.
        openRouterPurchasedUsd: credits?.totalUsd ?? null,
        // FreeAgent actuals when the daily snapshot exists; the static rows
        // above are the fallback the UI uses when this is null.
        financeActuals,
        note: financeActuals
          ? 'Figures are FreeAgent actuals (GBP at each transaction date), refreshed daily by the box.'
          : 'Static transcription of FreeAgent as at 2026-08-12 (every row evidenced). The daily FreeAgent snapshot feed is not live yet.',
      },
      costs: {
        users: userRows,
        fixed: FIXED_MONTHLY_COSTS,
        fixedTotalGbp: round2(fixedCostsGbpMonthly()),
        unitEconomics: { ...UNIT_ECONOMICS, planPriceGbp: PLAN_PRICE_GBP },
        // What the whole book costs to serve this month, split the way the
        // money actually leaves: the biller's cut, the model, and Talk.
        variable: {
          billingFeesGbp: round2(userRows.reduce((sum, r) => sum + r.billingFeeGbp, 0)),
          inferenceGbp: round2(userRows.reduce((sum, r) => sum + r.inferenceGbp, 0)),
          talkGbp: round2(userRows.reduce((sum, r) => sum + r.talkGbp, 0)),
          // What AI providers actually charged the bank this month, against
          // what customers account for. The gap is us: development, testing
          // and advert generation. Shown rather than reconciled away, because
          // a dashboard that models £4.50 while the statement says £69 is a
          // dashboard nobody should trust.
          providerSpendThisMonthGbp: aiProviderSpendThisMonth(financeActuals),
        },
      },
      projections: computeProjections({ personas, appleShare }),
      dates: buildImportantDates(new Date()),
      // No runner list. hermes_instances is a retired table: every one of its
      // 91 rows now reads {"status":"not_requested"}, because the per-user Fly
      // runners were destroyed on 2026-09-18 and everyone is on the agent
      // engine. Shipping 91 dead objects to a phone to render "91
      // not_requested" was the last piece of the old architecture still on
      // this page.
      monitoring: {
        worker: { ok: true, note: 'this response came from the live Worker' },
        surfaces: probes,
      },
    };
    return jsonResponse(body, 200);
  } catch (error) {
    return jsonResponse({ error: 'admin_dashboard_failed', detail: error instanceof Error ? error.message : 'unknown' }, 500);
  }
}

// ---------------------------------------------------------------------------
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
