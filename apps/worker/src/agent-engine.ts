/**
 * The agent engine: which accounts use it, and how the Worker talks to it.
 *
 * The agent engine (apps/agent, Worker `delegent-agent`) is the coworker for an
 * account that has no per-user runner. It sits where a runner sits: the Worker
 * keeps the run lifecycle (task_runs), the display record (messages),
 * notifications, entitlement and usage, and hands the work to the engine through
 * the AGENT service binding instead of an HMAC call to a Fly Machine.
 *
 * Which accounts: see usesAgentEngine and agentEngineTokens. Always the ids in
 * SIDEKICK_AGENT_ENGINE_USER_IDS; everyone else only while that list holds "*",
 * and never without both the binding and the shared secret. Since 2026-09-18
 * there are no runners to fall back to (Fly closed, Alex's call), so removing
 * "*" would leave every account without a coworker rather than roll it back.
 *
 * Requests to the engine carry the runner auth v1 headers (the same format
 * signRunnerTokenV1 produces for runners) signed with SIDEKICK_AGENT_SHARED_SECRET,
 * so the engine trusts only the user this Worker signed for.
 */
import type { Env } from './index.js';

/** task_runs.runner_task_id for a run on the agent engine: "agent:<taskRunId>". */
export const AGENT_RUN_PREFIX = 'agent:';

/**
 * Talk (live voice) for an agent-engine account: 15 minutes per billing cycle,
 * the single plan's allowance. Dictation is not counted against it; it costs a
 * fraction of a penny a minute.
 */
export const AGENT_TALK_SECONDS_PER_CYCLE = 15 * 60;

/** How long the Worker waits for the engine to accept a run or answer a status. */
export const AGENT_REQUEST_TIMEOUT_MS = 15_000;

/** The service binding ignores the host; this only has to be a valid URL. */
const AGENT_ORIGIN = 'https://agent.internal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SIDEKICK_AGENT_ENGINE_USER_IDS, comma-separated, holds all of it:
 *   <user id>    always uses the engine (the test accounts);
 *   *            everyone else uses it too (the assistant release);
 *   -<user id>   held back from "*" (a paying customer not yet told about the move).
 * One variable, not three, because this Worker is at Cloudflare's limit of 64
 * variables and secrets: a deploy with two more was refused (code 10055,
 * 2026-09-15).
 */
function agentEngineTokens(env: Pick<Env, 'SIDEKICK_AGENT_ENGINE_USER_IDS'>): string[] {
  return (env.SIDEKICK_AGENT_ENGINE_USER_IDS ?? '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
}

export function agentEngineUserIds(env: Pick<Env, 'SIDEKICK_AGENT_ENGINE_USER_IDS'>): Set<string> {
  return new Set(agentEngineTokens(env).filter((id) => UUID.test(id)));
}

export function agentEngineForEveryone(env: Pick<Env, 'SIDEKICK_AGENT_ENGINE_USER_IDS'>): boolean {
  return agentEngineTokens(env).includes('*');
}

export function agentEngineConfigured(env: Pick<Env, 'AGENT' | 'SIDEKICK_AGENT_SHARED_SECRET'>): boolean {
  return Boolean(env.AGENT && typeof env.AGENT.fetch === 'function' && (env.SIDEKICK_AGENT_SHARED_SECRET ?? '').trim());
}

export function agentEngineExcludedIds(env: Pick<Env, 'SIDEKICK_AGENT_ENGINE_USER_IDS'>): Set<string> {
  return new Set(agentEngineTokens(env).filter((token) => token.startsWith('-')).map((token) => token.slice(1)).filter((id) => UUID.test(id)));
}

/**
 * An assistant account has no workspace, but apply_billing_entitlement queues a
 * runner for every entitled activation regardless of who the account is (a
 * brand-new account gets a 'queued' row; a customer whose old runner was asleep
 * gets it woken). Alex's Apple test purchase on 2026-09-16 queued a Studio
 * runner for an assistant account, and the hourly provisioner would have built
 * it. Called after any successful entitlement for an assistant account: a
 * request that never became a runner goes back to not_requested; a runner that
 * exists goes back to sleep with its retention window, so its files stay
 * downloadable for the move and the machine costs nothing.
 */
export async function releaseAssistantRunnerRequest(env: Env, userId: string, now = new Date()): Promise<'released' | 'slept' | 'untouched' | 'failed'> {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!base || !key) return 'failed';
  const headers = { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' };
  try {
    const current = await fetch(`${base}/rest/v1/hermes_instances?select=status,ready_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`, { headers });
    if (!current.ok) return 'failed';
    const [row] = (await current.json()) as Array<{ status?: string | null; ready_at?: string | null }>;
    if (!row || !['queued', 'provisioning'].includes(String(row.status ?? ''))) return 'untouched';
    // The cancellation grace window (SIDEKICK_FLY_VOLUME_RETENTION_DAYS, 60 since 2026-08-04).
    const retentionDays = 60;
    const patch = row.ready_at
      ? { status: 'sleeping', suspended_at: now.toISOString(), volume_retention_until: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
          provisioning_claimed_at: null, provisioning_lease_expires_at: null, public_status_message: null, updated_at: now.toISOString() }
      : { status: 'not_requested', provisioning_tier_id: null, provisioning_idempotency_key: null, provisioning_requested_at: null,
          provisioning_claimed_at: null, provisioning_lease_expires_at: null, public_status_message: null, updated_at: now.toISOString() };
    const response = await fetch(`${base}/rest/v1/hermes_instances?user_id=eq.${encodeURIComponent(userId)}&status=eq.${row.status}`, {
      method: 'PATCH', headers, body: JSON.stringify(patch),
    });
    if (!response.ok) return 'failed';
    console.log(JSON.stringify({ agent: 'assistant_runner_request_released', userId, from: row.status, to: patch.status }));
    return row.ready_at ? 'slept' : 'released';
  } catch {
    return 'failed';
  }
}

/**
 * Whether this account uses the agent engine, on a deployment that can reach it.
 *
 * - An id listed in SIDEKICK_AGENT_ENGINE_USER_IDS (the test accounts) always does.
 * - With "*" in that list (the assistant release, Alex, 2026-09-15) every other
 *   account does too, except an id listed as "-<id>".
 * - Otherwise nobody else does, exactly as before.
 *
 * Until 2026-09-18 an account billed through the App Store was also held on
 * its runner, because the iPhone app still sold and ran the workspace coworker.
 * Alex's call that day: every account moves, the runners are destroyed and the
 * Fly account is closed, so there is no runner left for an App Store customer
 * to be held on. The function is async still: callers await it, and the
 * signature is the contract, not the lookup.
 */
export async function usesAgentEngine(env: Env, userId: string | null | undefined): Promise<boolean> {
  if (!userId || !agentEngineConfigured(env)) return false;
  const id = userId.toLowerCase();
  if (agentEngineUserIds(env).has(id)) return true;
  if (!agentEngineForEveryone(env)) return false;
  return !agentEngineExcludedIds(env).has(id);
}

export function isAgentRun(runnerTaskId: string | null | undefined): boolean {
  return typeof runnerTaskId === 'string' && runnerTaskId.startsWith(AGENT_RUN_PREFIX);
}

export function agentRunIdOf(runnerTaskId: string): string {
  return runnerTaskId.slice(AGENT_RUN_PREFIX.length);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/** Runner auth v1 headers, signed with the agent engine's secret. */
export async function agentRequestHeaders(secret: string, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  return {
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': String(nowSeconds),
    'x-sidekick-runner-token': `v1.${await hmacHex(secret, `v1:${userId}:${nowSeconds}`)}`,
  };
}

/**
 * A signed request to the engine, as `userId`. A timeout aborts the request;
 * pass `timeoutMs: 0` for a long-lived stream.
 */
export async function agentFetch(
  env: Env,
  userId: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const binding = env.AGENT;
  const secret = (env.SIDEKICK_AGENT_SHARED_SECRET ?? '').trim();
  if (!binding || !secret) throw new Error('agent engine not configured');
  const { timeoutMs = AGENT_REQUEST_TIMEOUT_MS, headers, ...rest } = init;
  const signed = new Headers(headers);
  for (const [name, value] of Object.entries(await agentRequestHeaders(secret, userId))) signed.set(name, value);
  return binding.fetch(`${AGENT_ORIGIN}${path}`, {
    ...rest,
    headers: signed,
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}

/**
 * Check a link to a file the coworker shared (made by apps/agent/src/internal.ts
 * fileLinkToken): v1.<expiresAt>.<userId>.<fileId>.<HMAC over
 * "agent-file:v1:<expiresAt>:<userId>:<fileId>">.
 */
export async function verifyAgentFileLinkToken(
  token: string | null,
  fileId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ userId: string } | null> {
  const parts = (token ?? '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || !secret) return null;
  const [, expiresRaw, userId, tokenFileId, signature] = parts;
  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds) return null;
  if (!UUID.test(userId) || tokenFileId !== fileId || !/^file_[a-f0-9]{32}$/.test(fileId) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = await hmacHex(secret, `agent-file:v1:${expiresAt}:${userId}:${fileId}`);
  return timingSafeEqual(signature, expected) ? { userId } : null;
}

/** Cap a voice allowance snapshot at the agent engine's Talk allowance (less during the free month). */
export function capAgentTalkAllowance<T extends { voiceSecondsQuota: number; consumedVoiceSeconds: number; remainingVoiceSeconds: number; hardLimited: boolean }>(
  snapshot: T,
  capSeconds: number = AGENT_TALK_SECONDS_PER_CYCLE,
): T {
  const quota = snapshot.voiceSecondsQuota > 0 ? Math.min(snapshot.voiceSecondsQuota, capSeconds) : capSeconds;
  const remaining = Math.max(0, quota - snapshot.consumedVoiceSeconds);
  return { ...snapshot, voiceSecondsQuota: quota, remainingVoiceSeconds: remaining, hardLimited: snapshot.consumedVoiceSeconds >= quota };
}
