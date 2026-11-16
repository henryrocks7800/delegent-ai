import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createDemoSidekickState,
  mapMyProductStateRow,
  PROVISIONING_STALL_TIMEOUT_MS,
  resolveSidekickGate,
  type Artifact,
  type ArtifactStatus,
  type AuthSessionState,
  type ChatMessage,
  type ChatRole,
  type MyProductStateRow,
  type ProductGate,
  type SidekickProductSnapshot,
  type TaskRun,
  type TaskRunStatus,
} from '@sidekick/shared';
import { getFreshMobileSupabaseSession, mobileSupabase } from '../auth/supabaseClient';

export type MobileProductStateStatus = 'preview' | 'loading' | 'live' | 'error';
export type MobileProductStateMode = 'preview' | 'live';

export interface MobileProductState {
  status: MobileProductStateStatus;
  mode: MobileProductStateMode;
  snapshot: SidekickProductSnapshot;
  gate: ProductGate;
  errorMessage: string | null;
  // True once a workspace has sat in a setup gate past the point where calling
  // it slow is honest. Its own field rather than an `error` status: the poll
  // that watches setup flips status every few seconds, and the shell suppresses
  // a transient error banner precisely because of that churn, so a stall routed
  // through `status` is guaranteed to be invisible to the people it is for.
  provisioningStalled: boolean;
  refresh: () => Promise<SidekickProductSnapshot>;
}

type ProductDataClient = {
  from(table: string): {
    select(columns?: string): any;
  };
};

const previewBaseSnapshot = createDemoSidekickState();
const previewAgentName = { agentName: 'Nova' } as const;
const previewProductSnapshot: SidekickProductSnapshot = {
  ...previewBaseSnapshot,
  profile: previewBaseSnapshot.profile ? { ...previewBaseSnapshot.profile, ...previewAgentName } : null,
};
// The safe projections these mappers were written against. The snapshot read no
// longer asks for any of them (see fetchMobileProductSnapshot), but the mappers
// are the fail-closed parsers for these shapes and are kept with their tests so
// a future consumer starts from a safe projection rather than select(*).
export const SAFE_ARTIFACT_COLUMNS = 'id,user_id,title,kind,detail,status,created_at,updated_at,viewer_url';
export const SAFE_TASK_COLUMNS = 'id,user_id,status,instruction,message_id,error_code,created_at,updated_at,completed_at';
export const SAFE_MESSAGE_COLUMNS = 'id,user_id,role,content,created_at,task_id';
const PRODUCT_STATE_ERROR = 'Could not load live workspace state.';
// [DN1.3-01] Hard timeout on the auth+snapshot fetch. Before this, if the
// Supabase JS client got stuck (observed on cold-launch of an
// onboarded-but-unsubscribed user via deep link), status stayed at
// `'loading'` indefinitely and the shell's productStateIsAuthoritative gate
// (App.tsx) hid every other surface, leaving the user on a near-blank
// "Checking on your coworker…" screen with no way forward. The race below
// guarantees the hook flips to `'error'` after PRODUCT_STATE_FETCH_TIMEOUT_MS,
// surfacing the existing ProductStateNotice retry path instead of a hang.
export const PRODUCT_STATE_FETCH_TIMEOUT_MS = 15000;
export const PRODUCT_STATE_TRANSIENT_GATE_REFRESH_INTERVAL_MS = 5_000;
export const PRODUCT_STATE_TRANSIENT_GATE_STALL_TIMEOUT_MS = PROVISIONING_STALL_TIMEOUT_MS;
const TRANSIENT_GATES = new Set<string>([
  'subscribed_pending_worker',
  'provisioning_worker',
  'subscription_pending_activation',
]);

class ProductStateTimeoutError extends Error {
  constructor() {
    super('product_state_timeout');
    this.name = 'ProductStateTimeoutError';
  }
}

function withProductStateTimeout<T>(work: () => Promise<T>, timeoutMs: number = PRODUCT_STATE_FETCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ProductStateTimeoutError());
    }, timeoutMs);
    work()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createAuthenticatedFailClosedProductSnapshot(user: Extract<AuthSessionState, { status: 'authenticated' }>['user']): SidekickProductSnapshot {
  const userId = text(user.id) ?? 'authenticated-user';
  return {
    profile: {
      id: userId,
      email: text(user.email) ?? 'signed-in account',
      fullName: text(user.fullName) ?? undefined,
      agentName: text(user.fullName) ?? undefined,
      avatarUrl: safeViewerUrl(user.avatarUrl),
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

export const sidekickProductMode = 'preview' as const;
export const sidekickProductState = previewProductSnapshot;
export const sidekickProductGate = resolveSidekickGate(previewProductSnapshot);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function artifactStatus(value: unknown): ArtifactStatus {
  return value === 'review' || value === 'saved' || value === 'archived' ? value : 'ready';
}

function taskRunStatus(value: unknown): TaskRunStatus {
  return value === 'dispatched' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'canceled' ? value : 'queued';
}

function chatRole(value: unknown): ChatRole {
  return value === 'assistant' || value === 'system' ? value : 'user';
}

function safeViewerUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function mapPublicArtifactRows(rows: unknown): readonly Artifact[] {
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): Artifact[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id);
    const userId = text(row.user_id);
    const title = text(row.title);
    const kind = text(row.kind);
    const createdAt = text(row.created_at);
    if (!id || !userId || !title || !kind || !createdAt) return [];

    const artifact: Artifact = {
      id,
      userId,
      title,
      kind,
      detail: text(row.detail) ?? '',
      status: artifactStatus(row.status),
      createdAt,
    };

    const updatedAt = text(row.updated_at);
    const viewerUrl = safeViewerUrl(row.viewer_url);
    if (updatedAt) artifact.updatedAt = updatedAt;
    if (viewerUrl) artifact.viewerUrl = viewerUrl;

    return [artifact];
  });
}

export function mapPublicTaskRows(rows: unknown): readonly TaskRun[] {
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): TaskRun[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id);
    const userId = text(row.user_id);
    const instruction = text(row.instruction);
    const createdAt = text(row.created_at);
    if (!id || !userId || !instruction || !createdAt) return [];

    const task: TaskRun = {
      id,
      userId,
      status: taskRunStatus(row.status),
      instruction,
      createdAt,
    };

    const messageId = text(row.message_id);
    const errorCode = text(row.error_code);
    const updatedAt = text(row.updated_at);
    const completedAt = text(row.completed_at);
    if (messageId) task.messageId = messageId;
    if (errorCode) task.errorCode = errorCode;
    if (updatedAt) task.updatedAt = updatedAt;
    if (completedAt) task.completedAt = completedAt;

    return [task];
  });
}

export function mapPublicMessageRows(rows: unknown): readonly ChatMessage[] {
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): ChatMessage[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id);
    const userId = text(row.user_id);
    const content = text(row.content);
    const createdAt = text(row.created_at);
    if (!id || !userId || !content || !createdAt) return [];

    const message: ChatMessage = {
      id,
      userId,
      role: chatRole(row.role),
      content,
      createdAt,
    };

    const taskId = text(row.task_id);
    if (taskId) message.taskId = taskId;

    return [message];
  });
}

/**
 * The entitlement snapshot, and nothing else.
 *
 * ⚠️ THIS USED TO READ THREE MORE TABLES ON EVERY REFRESH: artifacts, task_runs
 * and messages, twenty rows apiece. Two problems with that, and the second one
 * is the reason it is gone rather than merely trimmed.
 *
 * Nothing rendered them. The snapshot fields they filled fed two builders in
 * App.tsx whose output reached no screen, so every refresh paid for data that
 * was computed and thrown away, including the five-second poll a workspace runs
 * while it is coming online.
 *
 * And a 503 on any of the three rejected the whole snapshot. A customer with a
 * perfectly good entitlement was told their workspace could not be loaded
 * because an optional side feed was briefly unavailable. The authoritative read
 * has no business depending on decoration. The browser has only ever read the
 * state view, which is the shape this should always have been.
 */
export async function fetchMobileProductSnapshot(client: ProductDataClient, emptyStateSnapshot?: SidekickProductSnapshot): Promise<SidekickProductSnapshot> {
  const productStateResult = await client
    .from('my_product_state')
    .select('*')
    .maybeSingle();

  if (productStateResult.error) throw new Error(PRODUCT_STATE_ERROR);
  if (!productStateResult.data) {
    if (emptyStateSnapshot) return emptyStateSnapshot;
    throw new Error(PRODUCT_STATE_ERROR);
  }

  return mapMyProductStateRow(productStateResult.data as MyProductStateRow);
}

/** agentEngine: the account is on the assistant engine, which has no workspace to wait for. */
export function useMobileProductState(authState: AuthSessionState, agentEngine = false): MobileProductState {
  const fallbackSnapshot = useMemo(() => previewProductSnapshot, []);
  const [snapshot, setSnapshot] = useState<SidekickProductSnapshot>(fallbackSnapshot);
  const [status, setStatus] = useState<MobileProductStateStatus>('preview');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const transientGateEnteredAtRef = useRef<number | null>(null);
  const [provisioningStalled, setProvisioningStalled] = useState(false);
  /**
   * ⚠️ EVERY LOAD IS FENCED, and until now only the mount effect was.
   *
   * `refresh` wrote its result unconditionally after its await. Manual refresh
   * and the transient provisioning poll both go through it, so two loads for
   * two different accounts could be in flight at once and the slower one won.
   * Executed against the actual hook: account B finished, then account A
   * finished, and the signed-in account stayed B while the rendered profile
   * became A. Everything downstream reads that snapshot, including the mounted
   * chat host.
   *
   * The generation is bumped by every load. A reply whose generation has been
   * superseded, or whose account is no longer the signed-in one, is dropped.
   */
  const loadGeneration = useRef(0);
  /** What was last published, so a superseded caller gets the winner's answer
   * rather than the retired account's. */
  const publishedRef = useRef<SidekickProductSnapshot>(fallbackSnapshot);
  const publish = useCallback((next: SidekickProductSnapshot) => {
    publishedRef.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async (): Promise<SidekickProductSnapshot> => {
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current;
    if (authState.status !== 'authenticated') {
      publish(fallbackSnapshot);
      setStatus('preview');
      setErrorMessage(null);
      return fallbackSnapshot;
    }

    if (!mobileSupabase) {
      const failClosedSnapshot = createAuthenticatedFailClosedProductSnapshot(authState.user);
      publish(failClosedSnapshot);
      setStatus('error');
      setErrorMessage('Live workspace settings are unavailable on this build.');
      return failClosedSnapshot;
    }

    const failClosedSnapshot = createAuthenticatedFailClosedProductSnapshot(authState.user);
    publish(publishedRef.current.profile?.id === authState.user.id ? publishedRef.current : failClosedSnapshot);
    setStatus('loading');
    setErrorMessage(null);
    // Capture the non-null client locally so the closure passed to
    // withProductStateTimeout doesn't re-widen mobileSupabase to `| null`.
    const client = mobileSupabase;
    try {
      const liveSnapshot = await withProductStateTimeout(async () => {
        await getFreshMobileSupabaseSession(client);
        return fetchMobileProductSnapshot(client, failClosedSnapshot);
      });
      // A reply for an account that is no longer signed in, or a load that a
      // newer one has already superseded, is dropped rather than written.
      if (!current()) return publishedRef.current;
      publish(liveSnapshot);
      setStatus('live');
      return liveSnapshot;
    } catch (error) {
      if (!current()) return publishedRef.current;
      publish(publishedRef.current.profile?.id === authState.user.id ? publishedRef.current : failClosedSnapshot);
      setStatus('error');
      setErrorMessage(error instanceof ProductStateTimeoutError
        ? 'Workspace took too long to load. Tap retry.'
        : PRODUCT_STATE_ERROR);
      return failClosedSnapshot;
    }
  }, [authState.status, fallbackSnapshot, authState.user?.id, publish]);

  useEffect(() => {
    // One load path now, fenced the same way. The effect used to carry its own
    // copy with a `cancelled` flag while refresh carried none, which is exactly
    // how the two drifted apart.
    void refresh();
  }, [refresh]);

  const gate = useMemo(() => resolveSidekickGate(snapshot, { agentEngine }), [snapshot, agentEngine]);

  // Defect #57 (2026-05-22): a queued workspace can sit without an error_code
  // for a long time if the scheduler is delayed, and without a local watchdog
  // the user reads "coming online" for the rest of the session.
  //
  // This used to raise `status` to 'error' with PROVISIONING_STALLED_MESSAGE.
  // A later fix (2026-05-29) suppressed the shell's error banner for anyone who
  // had ever loaded live data, to stop the setup poll bouncing the layout every
  // few seconds, which is every user this watchdog can possibly fire for. The
  // two changes cancelled out and the message reached nobody. It now sets a flag
  // of its own that the setup notice reads, so the escalation survives a poll
  // that keeps rewriting status.
  //
  // It also owns a real timer now. The old version re-read the clock only when
  // `status` changed, so it was borrowing the refresh poll as its heartbeat and
  // would never have fired if that poll ever went quiet.
  useEffect(() => {
    if (authState.status !== 'authenticated' || !TRANSIENT_GATES.has(gate.kind)) {
      transientGateEnteredAtRef.current = null;
      setProvisioningStalled(false);
      return;
    }
    if (transientGateEnteredAtRef.current === null) {
      transientGateEnteredAtRef.current = Date.now();
    }
    // Remaining, not the full timeout: moving between two transient gates is not
    // progress worth restarting the clock for, and the ref survives that move.
    const remaining = PRODUCT_STATE_TRANSIENT_GATE_STALL_TIMEOUT_MS - (Date.now() - transientGateEnteredAtRef.current);
    if (remaining <= 0) {
      setProvisioningStalled(true);
      return;
    }
    const timer = setTimeout(() => setProvisioningStalled(true), remaining);
    return () => clearTimeout(timer);
  }, [authState.status, gate.kind]);

  // Defect #47 (2026-05-21) — when the gate says provisioning_worker /
  // subscribed_pending_worker the workspace is mid-setup. Without an
  // explicit refresh loop the mobile UI stays on "Preparing workspace"
  // indefinitely after Supabase flips to ready. Poll every 5s while the
  // gate is in a transient state; stop the moment we reach a terminal
  // gate (ready_user / inactive_subscriber / fail_closed).
  useEffect(() => {
    if (authState.status !== 'authenticated') return;
    if (!TRANSIENT_GATES.has(gate.kind)) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try { await refresh(); } catch { /* best-effort */ }
    };
    const id = setInterval(tick, PRODUCT_STATE_TRANSIENT_GATE_REFRESH_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [authState.status, gate.kind, refresh]);

  return {
    status,
    mode: authState.status === 'authenticated' ? 'live' : 'preview',
    snapshot,
    gate,
    errorMessage,
    provisioningStalled,
    refresh,
  };
}
