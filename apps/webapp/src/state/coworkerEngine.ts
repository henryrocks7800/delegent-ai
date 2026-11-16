// Which coworker engine this account is on, as the Worker says
// (GET /api/account/engine, apps/worker/src/agent-engine.ts). The mobile app
// has had this since the assistant release; the web app did not, which is why
// an agent-engine account in a browser was still shown the three workspace
// tiers and their £9.99 headline while checkout charged the £3.99 plan.
//
// The charge was never wrong: the server decides the plan from the account and
// ignores whatever tier the client asks for (packages/billing serverFlow.ts,
// "an account on it can only buy it"). The price on screen was wrong, which is
// its own kind of bad.
//
// Same contract as the phone: the safe default is the workspace app, the answer
// is remembered per account so the right plan draws on the next load without
// waiting for the network, and a failure to ask changes nothing.
import { useEffect, useState } from 'react';
import type { CoworkerEngine } from '@sidekick/shared';
import { apiFetch, isFailure } from '../lib/api';
import { supabase } from '../lib/supabase';

const ENGINE_PATH = '/api/account/engine';
const CACHE_PREFIX = 'delegent.coworkerEngine.v1.';

export function parseCoworkerEngine(payload: unknown): CoworkerEngine | null {
  if (!payload || typeof payload !== 'object') return null;
  const engine = (payload as { engine?: unknown }).engine;
  return engine === 'agent' || engine === 'runner' ? engine : null;
}

function cached(userId: string | null): CoworkerEngine | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(`${CACHE_PREFIX}${userId}`);
    return value === 'agent' || value === 'runner' ? value : null;
  } catch {
    return null;
  }
}

function remember(userId: string | null, engine: CoworkerEngine): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${userId}`, engine);
  } catch {
    /* a browser with storage blocked simply asks again next load */
  }
}

export async function fetchCoworkerEngine(): Promise<CoworkerEngine | null> {
  const result = await apiFetch<unknown>(ENGINE_PATH, { headers: { accept: 'application/json' } });
  if (isFailure(result)) return null;
  return parseCoworkerEngine(result.data);
}

// The product state, the shell and several screens all ask, so one page load
// sent the same request three times. They now share one answer, reused for a
// minute; a failed ask is not kept, so the next caller tries again.
const REUSE_MS = 60_000;
const asked = new Map<string, { at: number; answer: Promise<CoworkerEngine | null> }>();

function askOnce(userId: string): Promise<CoworkerEngine | null> {
  const hit = asked.get(userId);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.answer;
  const answer = fetchCoworkerEngine();
  asked.set(userId, { at: Date.now(), answer });
  void answer.then((value) => {
    if (!value && asked.get(userId)?.answer === answer) asked.delete(userId);
  });
  return answer;
}

/** 'runner' until the Worker has said otherwise, so an unknown answer never changes what is sold. */
export function useCoworkerEngine(): CoworkerEngine {
  const [engine, setEngine] = useState<CoworkerEngine>('runner');

  useEffect(() => {
    let live = true;
    void (async () => {
      // Keyed per account: two people sharing a browser must not inherit each
      // other's plan page.
      const userId = supabase ? (await supabase.auth.getSession()).data.session?.user.id ?? null : null;
      if (!live) return;
      const known = cached(userId);
      if (known) setEngine(known);
      if (!userId) return;
      const answer = await askOnce(userId);
      if (!live || !answer) return;
      remember(userId, answer);
      setEngine(answer);
    })();
    return () => { live = false; };
  }, []);

  return engine;
}
