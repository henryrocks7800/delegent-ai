import { ROUTINE_LIMIT_REACHED_MESSAGE } from '@sidekick/shared';
import { getFreshMobileAccessToken, getRememberedMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';
import { buildRoutineCreateBody, mapRoutineRows, type Routine, type RoutineDraft } from './routines';

// Reads/updates go straight to Supabase under the owner RLS policies from
// migration 0036. Creates cannot: there is deliberately no client INSERT
// policy, so a new routine goes through the Worker, which authenticates the
// bearer, checks the subscription entitlement, then inserts as service-role.

const ROUTINES_PATH = '/api/scheduled-tasks';
const SIDEKICK_MOBILE_USER_AGENT = 'SidekickMobile/1.0 (Android)';
const SAFE_ROUTINE_COLUMNS = 'id,prompt,label,schedule_kind,interval_seconds,next_run_at,last_run_at,status,consecutive_failures';

export type RoutineActionError = { message: string };

export type RoutineListResult = { routines: readonly Routine[] } | { error: RoutineActionError };
export type RoutineMutationResult = { ok: true } | { error: RoutineActionError };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchRoutines(): Promise<RoutineListResult> {
  if (!mobileSupabase) return { error: { message: 'Sign in again to see your routines.' } };

  try {
    const result = await mobileSupabase
      .from('scheduled_tasks')
      .select(SAFE_ROUTINE_COLUMNS)
      .neq('status', 'cancelled')
      .order('next_run_at', { ascending: true })
      .limit(50);

    if (result.error) return { error: { message: 'Couldn’t load your routines. Try again in a moment.' } };
    return { routines: mapRoutineRows(result.data) };
  } catch {
    return { error: { message: 'Couldn’t load your routines. Try again in a moment.' } };
  }
}

export async function setRoutinePaused(routineId: string, paused: boolean): Promise<RoutineMutationResult> {
  return updateRoutine(routineId, { status: paused ? 'paused' : 'active' }, 'Couldn’t update that routine.');
}

export async function deleteRoutine(routineId: string): Promise<RoutineMutationResult> {
  // Soft-delete: 'cancelled' takes it out of the waker's claim query and out of
  // the list, while keeping the row for the run history it's linked to.
  return updateRoutine(routineId, { status: 'cancelled' }, 'Couldn’t delete that routine.');
}

async function updateRoutine(routineId: string, patch: Record<string, string>, failureMessage: string): Promise<RoutineMutationResult> {
  if (!mobileSupabase) return { error: { message: 'Sign in again to manage your routines.' } };

  try {
    const result = await mobileSupabase.from('scheduled_tasks').update(patch).eq('id', routineId);
    if (result.error) return { error: { message: failureMessage } };
    return { ok: true };
  } catch {
    return { error: { message: failureMessage } };
  }
}

export async function createRoutine(
  draft: RoutineDraft,
  options: { now?: Date; apiBaseUrl?: string | null; fetchImpl?: FetchLike } = {},
): Promise<RoutineMutationResult> {
  const body = buildRoutineCreateBody(draft, options.now ?? new Date());
  if ('error' in body) return { error: { message: body.error } };

  const apiBaseUrl = normalizePublicApiBaseUrl(options.apiBaseUrl ?? mobileSidekickApiBaseUrl);
  if (!apiBaseUrl) return { error: { message: 'Routines need the app link before they can start.' } };

  let accessToken: string | null = null;
  try {
    accessToken = mobileSupabase ? await getFreshMobileAccessToken(mobileSupabase) : null;
  } catch {
    accessToken = null;
  }
  accessToken = accessToken ?? getRememberedMobileAccessToken();
  if (!accessToken) return { error: { message: 'Sign in again, then set up your routine.' } };

  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`${apiBaseUrl.replace(/\/+$/, '')}${ROUTINES_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': SIDEKICK_MOBILE_USER_AGENT,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return { ok: true };
    if (response.status === 401) return { error: { message: 'Sign in again, then set up your routine.' } };
    if (response.status === 402) return { error: { message: 'Routines need an active plan. Pick a plan to turn them on.' } };
    if (response.status === 422) {
      // The one 422 that is not a malformed draft: the account is at its
      // routine ceiling, and "try again" cannot clear it, deleting one can.
      const code = await response
        .json()
        .then((body) => (body as { error?: unknown } | null)?.error)
        .catch(() => null);
      if (code === 'routine_limit_reached') return { error: { message: ROUTINE_LIMIT_REACHED_MESSAGE } };
    }
    return { error: { message: 'Couldn’t set up that routine. Try again in a moment.' } };
  } catch {
    return { error: { message: 'Couldn’t set up that routine. Try again in a moment.' } };
  }
}
