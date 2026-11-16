// Pure view model for an agent-engine account's allowance (agentAllowance.ts
// does the network and the hook). Kept apart so it is testable under tsx.

export interface AgentAllowance {
  trialing: boolean;
  allowanceUsedRatio: number;
  topUpBalanceTokens: number;
  hardLimited: boolean;
  nextResetAt: string | null;
  talkQuotaSeconds: number;
  talkUsedSeconds: number;
  topUpPricePence: number;
  topUpTokens: number;
  topUpValidMonths: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The Worker's answer, or null for anything that is not an agent account's allowance. */
export function parseAgentAllowance(payload: unknown): AgentAllowance | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.engine !== 'agent') return null;
  const talk = body.talk && typeof body.talk === 'object' ? body.talk as Record<string, unknown> : {};
  const topUp = body.topUp && typeof body.topUp === 'object' ? body.topUp as Record<string, unknown> : {};
  const ratio = finiteNumber(body.allowanceUsedRatio);
  const balance = finiteNumber(body.topUpBalanceTokens);
  const pricePence = finiteNumber(topUp.pricePence);
  const tokens = finiteNumber(topUp.tokens);
  if (ratio === null || balance === null || !pricePence || !tokens) return null;
  return {
    trialing: body.trialing === true,
    allowanceUsedRatio: Math.max(0, Math.min(1, ratio)),
    topUpBalanceTokens: Math.max(0, balance),
    hardLimited: body.hardLimited === true,
    nextResetAt: typeof body.nextResetAt === 'string' ? body.nextResetAt : null,
    talkQuotaSeconds: Math.max(0, finiteNumber(talk.quotaSeconds) ?? 0),
    talkUsedSeconds: Math.max(0, finiteNumber(talk.usedSeconds) ?? 0),
    topUpPricePence: pricePence,
    topUpTokens: tokens,
    topUpValidMonths: Math.max(1, finiteNumber(topUp.validMonths) ?? 12),
  };
}

/**
 * The share of the allowance at which the chat banner warns, the same 80% the
 * workspace capacity bar uses. Top-up credit does not lift the warning: it is
 * about the allowance, and the credit is what the warning offers.
 */
export const AGENT_ALLOWANCE_NEAR_LIMIT_RATIO = 0.8;

export function allowanceNearLimit(allowance: AgentAllowance): boolean {
  return allowance.allowanceUsedRatio >= AGENT_ALLOWANCE_NEAR_LIMIT_RATIO;
}

/** Top-up credit shown as what it is worth: "£1.60". */
export function topUpCreditLine(allowance: AgentAllowance): string {
  const pence = Math.floor((allowance.topUpBalanceTokens / allowance.topUpTokens) * allowance.topUpPricePence);
  return `£${(pence / 100).toFixed(2)}`;
}

/** "Refreshes on Wednesday 30 September", or null without a date. */
export function allowanceRefreshLine(allowance: AgentAllowance): string | null {
  if (!allowance.nextResetAt) return null;
  const date = new Date(allowance.nextResetAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  return `Refreshes on ${day}`;
}

export function talkMinutesLeftLine(allowance: AgentAllowance): string {
  const total = Math.round(allowance.talkQuotaSeconds / 60);
  const left = Math.max(0, Math.floor((allowance.talkQuotaSeconds - allowance.talkUsedSeconds) / 60));
  return `${left} of ${total} minutes left`;
}

