/**
 * The agent engine's monthly allowance and usage top-ups (Alex, 2026-09-15).
 *
 * An agent-engine account on £3.99 a month gets an allowance set at break-even
 * (AGENT_PLAN in packages/shared/src/content/agentEngine.ts, where the maths
 * lives), metered at provider cost rather than raw tokens (AGENT_USAGE). When
 * it runs out, the account can buy £1 top-ups: used only after the allowance,
 * valid 12 months, the way OpenAI and Google sell extra usage. Purchases arrive
 * through the signed Stripe webhook (packages/billing/src/usageTopUp.ts) and
 * are drawn down by settle_usage_top_ups (migration 0076).
 */
import { AGENT_PLAN, AGENT_TOP_UP, AGENT_USAGE } from '@sidekick/shared';
import { USAGE_TOP_UP_KIND } from '@sidekick/billing/usage-top-up';

/** Talk during the free month. */
export const AGENT_TRIAL_TALK_SECONDS = AGENT_PLAN.trialTalkMinutes * 60;

/** The month's allowance, by subscription status: the free month gets the trial allowance. */
export function agentMonthlyAllowance(status: string | null | undefined): number {
  return status === 'trialing' ? AGENT_PLAN.trialAllowanceTokens : AGENT_PLAN.monthlyAllowanceTokens;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Billable tokens for one reply: the provider's reported cost at $0.20 a million
 * (so any mix of input, cached input and output costs what it really costs),
 * plus Composio's price for each app action. A reply that reports no cost is
 * weighted by the model's own price ratios instead.
 */
export function agentBillableTokens(usage: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedTokens?: unknown;
  costUsd?: unknown;
  toolCalls?: unknown;
}): number {
  const tools = Math.floor(nonNegative(usage.toolCalls)) * AGENT_USAGE.billableTokensPerToolCall;
  const cost = nonNegative(usage.costUsd);
  if (cost > 0) return Math.ceil(cost / AGENT_USAGE.usdPerBillableToken) + tools;
  const input = nonNegative(usage.inputTokens);
  const cached = Math.min(input, nonNegative(usage.cachedTokens));
  const output = nonNegative(usage.outputTokens);
  return Math.ceil((input - cached) + cached * AGENT_USAGE.fallbackCachedWeight + output * AGENT_USAGE.fallbackOutputWeight) + tools;
}

/** How many £1 packs a request asks for: a whole number from 1 to the per-purchase maximum. */
export function parseTopUpPacks(value: unknown): number | null {
  if (value === undefined || value === null) return 1;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= AGENT_TOP_UP.maxPacksPerPurchase ? value : null;
}

export const TOP_UP_SUBMIT_MESSAGE =
  `Your top-up is added straight away, is used once your monthly allowance runs out, and lasts ${AGENT_TOP_UP.validMonths} months. Because it starts straight away, you give up the 14-day right to cancel.`;

/**
 * The Stripe Checkout Session form for a top-up. One line item at the pack price
 * whose quantity the buyer can change, cards only (so the payment is final when
 * the session completes), and metadata the webhook trusts for the grant. The
 * metadata deliberately avoids `sidekickUserId`/`client_reference_id`, which the
 * subscription code, the welcome email and the advert events all read.
 */
export function topUpCheckoutForm(input: {
  userId: string;
  packs: number;
  apiOrigin: string;
  stripeCustomerId: string | null;
  email: string | null;
}): URLSearchParams {
  const form = new URLSearchParams();
  const metadata: Record<string, string> = {
    kind: USAGE_TOP_UP_KIND,
    topUpUserId: input.userId,
    pricePence: String(AGENT_TOP_UP.pricePence),
    tokensPerPack: String(AGENT_TOP_UP.tokens),
    validMonths: String(AGENT_TOP_UP.validMonths),
  };
  form.set('mode', 'payment');
  form.set('locale', 'en-GB');
  form.append('payment_method_types[]', 'card');
  if (input.stripeCustomerId) form.set('customer', input.stripeCustomerId);
  else if (input.email) form.set('customer_email', input.email);
  form.set('line_items[0][price_data][currency]', 'gbp');
  form.set('line_items[0][price_data][unit_amount]', String(AGENT_TOP_UP.pricePence));
  form.set('line_items[0][price_data][product_data][name]', 'Delegent AI top-up');
  form.set('line_items[0][price_data][product_data][description]',
    `Extra usage for your coworker, used once your monthly allowance runs out. Lasts ${AGENT_TOP_UP.validMonths} months.`);
  form.set('line_items[0][quantity]', String(input.packs));
  form.set('line_items[0][adjustable_quantity][enabled]', 'true');
  form.set('line_items[0][adjustable_quantity][minimum]', '1');
  form.set('line_items[0][adjustable_quantity][maximum]', String(AGENT_TOP_UP.maxPacksPerPurchase));
  for (const [key, value] of Object.entries(metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }
  form.set('custom_text[submit][message]', TOP_UP_SUBMIT_MESSAGE);
  const origin = input.apiOrigin.replace(/\/+$/, '');
  form.set('success_url', `${origin}/account/billing?top_up=1`);
  form.set('cancel_url', `${origin}/checkout/cancel`);
  return form;
}

export interface TopUpSettlement {
  balance: number;
  drawnThisCycle: number;
  usedThisCycle: number;
}

/**
 * Settle this cycle's use beyond the allowance against the account's top-ups and
 * read what is left (migration 0076). Null when it cannot be read, which callers
 * treat as no top-up credit: never more than the account has paid for.
 */
export async function settleAgentTopUps(
  env: { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string },
  userId: string,
  cycleStartIso: string,
  allowance: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TopUpSettlement | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/settle_usage_top_ups`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId, p_cycle_start: cycleStartIso, p_allowance: Math.max(0, Math.floor(allowance)) }),
    });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null) as unknown;
    const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    if (!row) return null;
    return {
      balance: Math.max(0, Number(row.balance) || 0),
      drawnThisCycle: Math.max(0, Number(row.drawn_this_cycle) || 0),
      usedThisCycle: Math.max(0, Number(row.used_this_cycle) || 0),
    };
  } catch {
    return null;
  }
}

/** What the app shows for an agent-engine account's allowance (GET /api/account/allowance). */
export function agentAllowanceView(input: {
  trialing: boolean;
  allowance: number;
  used: number;
  topUpBalance: number;
  periodStart: string;
  nextResetAt: string | null;
  talkSecondsQuota: number;
  talkSecondsUsed: number;
}) {
  const allowanceUsed = Math.min(input.used, input.allowance);
  return {
    engine: 'agent' as const,
    trialing: input.trialing,
    allowanceTokens: input.allowance,
    usedTokens: input.used,
    allowanceUsedRatio: input.allowance > 0 ? Math.min(1, allowanceUsed / input.allowance) : 0,
    topUpBalanceTokens: input.topUpBalance,
    hardLimited: input.used >= input.allowance && input.topUpBalance <= 0,
    periodStart: input.periodStart,
    nextResetAt: input.nextResetAt,
    talk: {
      quotaSeconds: input.talkSecondsQuota,
      usedSeconds: Math.min(input.talkSecondsUsed, input.talkSecondsQuota),
    },
    topUp: {
      pricePence: AGENT_TOP_UP.pricePence,
      tokens: AGENT_TOP_UP.tokens,
      validMonths: AGENT_TOP_UP.validMonths,
      maxPacks: AGENT_TOP_UP.maxPacksPerPurchase,
    },
  };
}

/** The chat's pause copy when an agent-engine account's allowance and top-ups are both used. */
export function agentTokenPause(reason: string) {
  return {
    capKind: 'token' as const,
    reason,
    primary: "You've used this month's allowance, so I've paused new requests for now.",
    secondary: `Top up from £${(AGENT_TOP_UP.pricePence / 100).toFixed(2)} under Manage plan to keep going straight away, or your allowance refreshes at the start of your next billing month.`,
    actions: [
      { id: 'upgrade', label: 'Top up', tone: 'primary' as const },
      { id: 'see_reset_date', label: 'See when it refreshes', tone: 'secondary' as const },
      { id: 'dismiss', label: 'Not now', tone: 'secondary' as const },
    ],
    nextResetAtIso: null,
    tierId: AGENT_PLAN.tierId,
  };
}
