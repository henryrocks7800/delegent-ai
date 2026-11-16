// The monthly allowance, top-up credit and Talk time an agent-engine account has
// left (GET /api/account/allowance), and buying a top-up (POST
// /api/billing/top-up), from apps/worker/src/topups.ts. The allowance and the
// £1 top-ups are Alex's call of 2026-09-15; the numbers live in AGENT_PLAN and
// AGENT_TOP_UP in packages/shared/src/content/agentEngine.ts.

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { parseAgentAllowance, type AgentAllowance } from './agentAllowanceModel';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';

export { allowanceNearLimit, allowanceRefreshLine, parseAgentAllowance, talkMinutesLeftLine, topUpCreditLine, type AgentAllowance } from './agentAllowanceModel';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A signed-in request to the Worker; null when there is no session or no network. Shared with referral.ts. */
export async function authorisedRequest(path: string, init: RequestInit, fetchImpl: FetchLike = fetch): Promise<Response | null> {
  const apiBaseUrl = normalizePublicApiBaseUrl(mobileSidekickApiBaseUrl);
  if (!apiBaseUrl) return null;
  let accessToken: string | null = null;
  try {
    accessToken = mobileSupabase ? await getFreshMobileAccessToken(mobileSupabase) : null;
  } catch {
    accessToken = null;
  }
  accessToken = accessToken ?? getRememberedMobileAccessToken();
  if (!accessToken) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetchImpl(`${apiBaseUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAgentAllowance(fetchImpl?: FetchLike): Promise<AgentAllowance | null> {
  const response = await authorisedRequest('/api/account/allowance', { method: 'GET' }, fetchImpl);
  if (!response?.ok) return null;
  return parseAgentAllowance(await response.json().catch(() => null));
}

export type TopUpCheckoutResult = { ok: true; url: string } | { ok: false; message: string };

/** Opens nothing itself: returns the Stripe payment page for the caller to open. */
export async function startTopUpCheckout(packs = 1, fetchImpl?: FetchLike): Promise<TopUpCheckoutResult> {
  const response = await authorisedRequest('/api/billing/top-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packs }),
  }, fetchImpl);
  const body = response ? await response.json().catch(() => null) as { url?: unknown } | null : null;
  if (response?.ok && typeof body?.url === 'string' && body.url.startsWith('https://checkout.stripe.com/')) {
    return { ok: true, url: body.url };
  }
  return { ok: false, message: 'We could not open the payment page. Check your connection and try again.' };
}

/** The allowance for an agent account, read on show and whenever the app comes back to the front (after paying, say). */
export function useAgentAllowance(enabled: boolean): { allowance: AgentAllowance | null; refresh: () => void } {
  const [allowance, setAllowance] = useState<AgentAllowance | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) return;
    void fetchAgentAllowance().then((next) => { if (next) setAllowance(next); });
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { setAllowance(null); return; }
    refresh();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => subscription.remove();
  }, [enabled, refresh]);
  return { allowance, refresh };
}
