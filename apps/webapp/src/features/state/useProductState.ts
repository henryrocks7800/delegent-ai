import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isProvisioningGate,
  mapMyProductStateRow,
  PROVISIONING_STALL_TIMEOUT_MS,
  resolveSidekickGate,
  type MyProductStateRow,
  type ProductGate,
  type SidekickProductSnapshot,
} from '@sidekick/shared';
import { supabase } from '../../lib/supabase';
import { useCoworkerEngine } from '../../state/coworkerEngine';
import type { WebAuthUser } from '../auth/useAuth';

// The web app reads the same `my_product_state` view the mobile app does, under
// the same row-level-security policies. Deliberately narrower than mobile's
// version: chat lives in the embedded chat surface and files come from the
// runner API, so the artifact / task / message joins are not fetched here.

export type ProductStateStatus = 'loading' | 'live' | 'error';

export type ProductState = {
  status: ProductStateStatus;
  snapshot: SidekickProductSnapshot | null;
  gate: ProductGate | null;
  errorMessage: string | null;
  // True once setup has sat in a provisioning gate past the point where calling
  // it slow is honest. Its own field rather than an `error` status: raising the
  // status took the whole app away over a wait, and it also stopped the poll
  // below, so a workspace that came online a minute later was never noticed.
  provisioningStalled: boolean;
  refresh: () => void;
};

const LOAD_ERROR = 'We could not load your workspace. Check your connection and try again.';

// A workspace that is still coming online flips status without any event we can
// subscribe to, so poll while the gate is transient and stop once it settles.
const TRANSIENT_POLL_MS = 5_000;

// Mirrors mobile's PRODUCT_STATE_FETCH_TIMEOUT_MS. Without it a Supabase request
// that never settles (a resumed background tab on a dead connection, a captive
// portal) leaves `status` on 'loading' forever, and the app renders a bare
// full-screen spinner with nothing to press.
const FETCH_TIMEOUT_MS = 15_000;

// The same list the notice reads, so the app cannot poll for a state it never
// tells the reader about, or explain one it has stopped watching.
export function isTransientGate(gate: ProductGate | null): boolean {
  return isProvisioningGate(gate?.kind);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('product_state_timeout'));
    }, timeoutMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// `my_product_state` has no row for an account between sign-up and the first
// entitlement write, which is every brand new user. That is not a failure, so it
// must not render the "we could not load your workspace" screen. Fail closed
// instead: no acknowledgement and no subscription, which resolves to the
// onboarding gate, exactly as mobile does with its own empty snapshot.
function emptyStateSnapshot(user: WebAuthUser | null): SidekickProductSnapshot {
  return {
    profile: {
      id: user?.id ?? 'authenticated-user',
      email: user?.email ?? 'signed-in account',
      fullName: user?.fullName ?? undefined,
      agentName: user?.fullName ?? undefined,
      avatarUrl: user?.avatarUrl ?? undefined,
      createdAt: new Date(0).toISOString(),
    },
    acknowledgement: null,
    subscription: null,
    hermesInstance: null,
    usage: {
      usedTokens: 0,
      quotaTokens: 0,
      remainingTokens: 0,
      ratio: 0,
      nearLimit: false,
      hardLimited: false,
    },
    connections: [],
    artifacts: [],
    recentTasks: [],
    latestAssistantMessage: null,
    queueCount: 0,
  };
}

export function useProductState(signedIn: boolean, user: WebAuthUser | null = null): ProductState {
  const [snapshot, setSnapshot] = useState<SidekickProductSnapshot | null>(null);
  // An account on the agent engine has no workspace to wait for. Without this the
  // web app said "Preparing workspace" and "Your workspace is coming online" for
  // ever, and polled every 5 seconds for a state that never came (QA, 2026-09-23).
  const agentEngine = useCoworkerEngine() === 'agent';
  const gate = useMemo<ProductGate | null>(() => (snapshot ? resolveSidekickGate(snapshot, { agentEngine }) : null), [snapshot, agentEngine]);
  const [status, setStatus] = useState<ProductStateStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [provisioningStalled, setProvisioningStalled] = useState(false);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const transientGateEnteredAt = useRef<number | null>(null);
  const emptySnapshot = useMemo(() => emptyStateSnapshot(user), [user]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!signedIn || !supabase) {
      setSnapshot(null);
      setStatus(signedIn ? 'error' : 'loading');
      return;
    }

    let cancelled = false;

    async function load() {
      const client = supabase;
      if (!client) return;
      // Only a retry from the error screen goes back to loading. The transient
      // gate polls through here every few seconds while status is 'live', and
      // moving that to 'loading' would flash a full-page spinner over the app.
      // Without it, Try again is a button with no visible effect for up to the
      // full timeout, so it gets pressed again and again.
      setStatus((current) => (current === 'error' ? 'loading' : current));
      try {
        const result = await withTimeout(
          Promise.resolve(client.from('my_product_state').select('*').maybeSingle()),
          FETCH_TIMEOUT_MS,
        );
        if (cancelled || !mounted.current) return;
        if (result.error) {
          setStatus('error');
          setErrorMessage(LOAD_ERROR);
          return;
        }
        const next = result.data
          ? mapMyProductStateRow(result.data as MyProductStateRow)
          : emptySnapshot;
        setSnapshot(next);
        setStatus('live');
        setErrorMessage(null);
      } catch {
        if (cancelled || !mounted.current) return;
        setStatus('error');
        setErrorMessage(LOAD_ERROR);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [signedIn, nonce, emptySnapshot]);

  useEffect(() => {
    if (!signedIn || status !== 'live' || !isTransientGate(gate)) return;
    const timer = window.setTimeout(refresh, TRANSIENT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, status, gate, refresh]);

  // Provisioning can wedge rather than merely run slow (a failing cron is a
  // documented failure mode here), and the poll above would otherwise show
  // "coming online" for the rest of the session. Same watchdog mobile has.
  //
  // It raises a flag instead of the status. Raising the status replaced the
  // whole signed-in app with "Something went wrong" over a wait the user could
  // do nothing about, and, worse, the poll above only re-arms while the status
  // is 'live' — so the escalation switched off the very loop that would have
  // noticed the workspace arriving a minute later.
  useEffect(() => {
    if (!signedIn || !isTransientGate(gate)) {
      transientGateEnteredAt.current = null;
      setProvisioningStalled(false);
      return;
    }
    if (transientGateEnteredAt.current === null) {
      transientGateEnteredAt.current = Date.now();
    }
    // Remaining, not the full timeout: the two provisioning gates hand over to
    // each other mid-setup, and that hand-over is not progress worth restarting
    // the clock for.
    const remaining = PROVISIONING_STALL_TIMEOUT_MS - (Date.now() - transientGateEnteredAt.current);
    if (remaining <= 0) {
      setProvisioningStalled(true);
      return;
    }
    const timer = window.setTimeout(() => setProvisioningStalled(true), remaining);
    return () => window.clearTimeout(timer);
  }, [signedIn, gate]);

  return { status, snapshot, gate, errorMessage, provisioningStalled, refresh };
}
