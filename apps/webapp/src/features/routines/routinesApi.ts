import { ROUTINE_LIMIT_REACHED_MESSAGE } from '@sidekick/shared';
import { buildRoutineCreateBody, mapRoutineRows, type Routine, type RoutineDraft } from '@mobile-logic/routines/routines';
import { apiFetch, isFailure } from '../../lib/api';
import { supabase } from '../../lib/supabase';

// Reads and updates go straight to Supabase under the owner RLS policies from
// migration 0036, exactly as the app does. Creates cannot: there is no client
// INSERT policy, so a new routine goes through the Worker, which checks the
// subscription entitlement and inserts as service-role.

const SAFE_ROUTINE_COLUMNS =
  'id,prompt,label,schedule_kind,interval_seconds,next_run_at,last_run_at,status,consecutive_failures';

export type RoutineListResult = { ok: true; routines: readonly Routine[] } | { ok: false; message: string };
export type RoutineMutationResult = { ok: true } | { ok: false; message: string };

export async function fetchRoutines(): Promise<RoutineListResult> {
  if (!supabase) return { ok: false, message: 'Sign in again to see your routines.' };

  try {
    const result = await supabase
      .from('scheduled_tasks')
      .select(SAFE_ROUTINE_COLUMNS)
      .neq('status', 'cancelled')
      .order('next_run_at', { ascending: true })
      .limit(50);

    if (result.error) return { ok: false, message: 'We could not load your routines. Try again in a moment.' };
    return { ok: true, routines: mapRoutineRows(result.data) };
  } catch {
    return { ok: false, message: 'We could not load your routines. Try again in a moment.' };
  }
}

export async function setRoutinePaused(routineId: string, paused: boolean): Promise<RoutineMutationResult> {
  return updateRoutine(routineId, { status: paused ? 'paused' : 'active' }, 'We could not update that routine.');
}

export async function deleteRoutine(routineId: string): Promise<RoutineMutationResult> {
  // Soft-delete, matching the app: 'cancelled' drops it out of the waker's
  // claim query and out of the list, while keeping the run history intact.
  return updateRoutine(routineId, { status: 'cancelled' }, 'We could not delete that routine.');
}

async function updateRoutine(
  routineId: string,
  patch: Record<string, string>,
  failureMessage: string,
): Promise<RoutineMutationResult> {
  if (!supabase) return { ok: false, message: 'Sign in again to manage your routines.' };
  try {
    const result = await supabase.from('scheduled_tasks').update(patch).eq('id', routineId);
    if (result.error) return { ok: false, message: failureMessage };
    return { ok: true };
  } catch {
    return { ok: false, message: failureMessage };
  }
}

export async function createRoutine(draft: RoutineDraft, now: Date = new Date()): Promise<RoutineMutationResult> {
  const body = buildRoutineCreateBody(draft, now);
  if ('error' in body) return { ok: false, message: body.error };

  const result = await apiFetch('/api/scheduled-tasks', { method: 'POST', body });
  if (isFailure(result)) {
    if (result.code === 'no_plan') {
      return { ok: false, message: 'Routines need an active plan. Pick a plan to turn them on.' };
    }
    if (result.code === 'unauthenticated') {
      return { ok: false, message: 'Sign in again, then set up your routine.' };
    }
    // Not a fault to retry into working: the account is at its routine ceiling,
    // and the way through is deleting one, not trying again. The Worker answers
    // 422, which `code` flattens to 'invalid', so the ceiling is only legible in
    // the Worker's own error string.
    if (result.serverCode === 'routine_limit_reached') {
      return { ok: false, message: ROUTINE_LIMIT_REACHED_MESSAGE };
    }
    return { ok: false, message: 'We could not set up that routine. Try again in a moment.' };
  }
  return { ok: true };
}
