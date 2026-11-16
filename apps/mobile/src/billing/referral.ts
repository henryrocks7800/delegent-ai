// Referrals, "give a friend a free month, get one yourself" (2026-09-23).
// GET /api/referral (the member's code and share text) and POST
// /api/referral/redeem (a new account enters a friend's code), from
// apps/worker/src/referrals.ts. Android only in the app: the reward is a credit
// on a Stripe bill, and a free month outside Apple's billing is a Guideline
// 3.1.1 risk, so the iPhone app shows neither the invite nor the code box.

import { useCallback, useEffect, useState } from 'react';
import { authorisedRequest } from './agentAllowance';
import { parseReferral, redeemOutcome, tidyInviteCode, type RedeemOutcome, type Referral } from './referralModel';

export { INVITE_ACCEPTED_MESSAGE, looksLikeInviteCode, parseReferral, redeemOutcome, tidyInviteCode, type RedeemOutcome, type Referral } from './referralModel';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchReferral(fetchImpl?: FetchLike): Promise<Referral | null> {
  const response = await authorisedRequest('/api/referral', { method: 'GET' }, fetchImpl);
  if (!response?.ok) return null;
  return parseReferral(await response.json().catch(() => null));
}

export async function redeemInviteCode(code: string, fetchImpl?: FetchLike): Promise<RedeemOutcome> {
  const response = await authorisedRequest('/api/referral/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: tidyInviteCode(code) }),
  }, fetchImpl);
  const body = response ? await response.json().catch(() => null) as { error?: unknown } | null : null;
  return redeemOutcome(response?.status ?? null, body?.error);
}

/** The member's invite, fetched when the menu can show it; null for anyone who cannot invite. */
export function useReferral(enabled: boolean): Referral | null {
  const [referral, setReferral] = useState<Referral | null>(null);
  const load = useCallback(() => {
    if (!enabled) return;
    void fetchReferral().then((next) => setReferral(next));
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { setReferral(null); return; }
    load();
  }, [enabled, load]);
  return referral;
}
