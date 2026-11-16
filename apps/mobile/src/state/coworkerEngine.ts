// Which coworker engine this account is on, as the Worker says
// (GET /api/account/engine, apps/worker/src/agent-engine.ts).
//
// An account on the agent engine gets a Chat-only shell, one plan, and help and
// use-case copy for what that engine does (packages/shared/src/content/agentEngine.ts).
// Every other account, and any account while the answer is not known yet, gets
// the existing app exactly as it was: the safe default is the workspace app.
//
// The last answer is remembered per account so the right shell draws on the next
// launch without waiting for the network.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState } from 'react';
import type { CoworkerEngine } from '@sidekick/shared';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';

const ENGINE_PATH = '/api/account/engine';
const CACHE_PREFIX = 'delegent.coworkerEngine.v1.';
const REQUEST_TIMEOUT_MS = 10_000;

export const CoworkerEngineContext = createContext<CoworkerEngine>('runner');

/** True only when the Worker has said this account is on the agent engine. */
export function useIsAgentEngine(): boolean {
  return useContext(CoworkerEngineContext) === 'agent';
}

export function parseCoworkerEngine(payload: unknown): CoworkerEngine | null {
  if (!payload || typeof payload !== 'object') return null;
  const engine = (payload as { engine?: unknown }).engine;
  return engine === 'agent' || engine === 'runner' ? engine : null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchCoworkerEngine(options: { apiBaseUrl?: string | null; fetchImpl?: FetchLike } = {}): Promise<CoworkerEngine | null> {
  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
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
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${apiBaseUrl.replace(/\/+$/, '')}${ENGINE_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseCoworkerEngine(await response.json().catch(() => null));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useCoworkerEngineForUser(userId: string | null): CoworkerEngine {
  const [state, setState] = useState<{ userId: string | null; engine: CoworkerEngine }>({ userId, engine: 'runner' });
  useEffect(() => {
    if (!userId) {
      setState({ userId: null, engine: 'runner' });
      return;
    }
    let cancelled = false;
    let answered = false;
    setState({ userId, engine: 'runner' });
    const cacheKey = `${CACHE_PREFIX}${userId}`;
    void AsyncStorage.getItem(cacheKey)
      .then((cached) => {
        // A remembered answer never overwrites the Worker's live one.
        if (cancelled || answered) return;
        if (cached === 'agent' || cached === 'runner') setState({ userId, engine: cached });
      })
      .catch(() => undefined);
    void fetchCoworkerEngine().then((engine) => {
      if (cancelled || !engine) return;
      answered = true;
      setState({ userId, engine });
      void AsyncStorage.setItem(cacheKey, engine).catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // A different signed-in account never sees the previous account's answer.
  return state.userId === userId ? state.engine : 'runner';
}
