import { useCallback, useEffect, useState } from 'react';
import {
  describeCadence,
  describeNextRun,
  formatHourChoice,
  isRoutinePromptReady,
  routineTitle,
  ROUTINE_SUGGESTIONS,
  ROUTINE_TIME_CHOICES,
  ROUTINE_WEEKDAY_LABELS,
  type Routine,
  type RoutineCadence,
  type RoutineDraft,
} from '@mobile-logic/routines/routines';
import { ROUTINE_CREATED_REFRESH_FAILED } from '@sidekick/shared';
import { ConfirmDialog, EmptyState, Notice, Screen, Spinner } from '../../components/ui';
import { createRoutine, deleteRoutine, fetchRoutines, setRoutinePaused } from './routinesApi';

const CADENCES: readonly { id: RoutineCadence; label: string }[] = [
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekly', label: 'Every week' },
];

const EMPTY_DRAFT: RoutineDraft = { prompt: '', label: '', cadence: 'daily', hour: 9, weekday: 1 };

export function RoutinesScreen() {
  const [routines, setRoutines] = useState<readonly Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<RoutineDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Routine | null>(null);
  // The row whose pause or resume is in flight. Without it the button stays
  // live, and a second press sends the opposite instruction before the first
  // has landed, so which state the routine ends in is down to which reply the
  // server happens to finish first.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // A pause, resume or delete that was refused, carried with the routine it was
  // refused for. These used to write the page-level `error`, which draws at the
  // top above the composer and the whole list, while the button that produced it
  // was somewhere down the page beside a routine the message never named. The
  // delete case was worse: the dialog closed on the press, so the only thing
  // that changed was a line the reader had already scrolled past.
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Kept apart from `error`. The form is taller than a phone screen, so by the
  // time someone reaches Create, a notice at the top of the page is not
  // somewhere they will look, or in most cases somewhere they can see.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Said only when a routine was created but the list refresh after it failed.
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchRoutines();
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setError(null);
    setRoutines(result.routines);
    return true;
  }, []);

  // Try again on the failed-read card goes through here rather than calling
  // load directly. Without the spinner the press has no visible effect for as
  // long as the request takes, so it gets pressed again, and each press starts
  // another read. The refresh after a save or a pause deliberately does not
  // take this path: blanking the list to a spinner after every toggle flashes.
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setConfirmation(null);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const result = await createRoutine(draft);
    setBusy(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setSaveError(null);
    setError(null);
    setConfirmation(null);
    setComposing(false);
    setDraft(EMPTY_DRAFT);
    // The routine exists from here on. A failed refresh would otherwise leave a
    // read error over a list that does not include what was just made, and the
    // natural response to that is to make it a second time.
    const refreshed = await load();
    if (!refreshed) setConfirmation(ROUTINE_CREATED_REFRESH_FAILED);
  }

  async function togglePaused(routine: Routine) {
    if (togglingId === routine.id) return;
    setTogglingId(routine.id);
    setRowError(null);
    const result = await setRoutinePaused(routine.id, routine.status !== 'paused');
    if (!result.ok) {
      setTogglingId(null);
      setRowError({ id: routine.id, message: result.message });
      return;
    }
    await load();
    setTogglingId(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusy(true);
    setRowError(null);
    const result = await deleteRoutine(target.id);
    setBusy(false);
    setPendingDelete(null);
    if (!result.ok) {
      setRowError({ id: target.id, message: result.message });
      return;
    }
    await load();
  }

  const now = new Date();

  return (
    <Screen
      title="Routines"
      subtitle="Standing jobs your coworker runs on a schedule."
      action={
        composing ? null : (
          <button
            className="btn-primary"
            type="button"
            onClick={() => {
              setSaveError(null);
              setComposing(true);
            }}
          >
            New routine
          </button>
        )
      }
    >
      {/* Only a failed read reaches here now, and it is suppressed when the
          failed-read card below is already carrying the same news. A refresh
          that fails over a list already on screen still gets said. */}
      {error && !(routines.length === 0 && !composing) ? (
        <Notice tone="danger">
          {error}
          {/* The failed-read card below carries its own Try again, but it only
              renders over an empty list. A refresh that failed after a save, a
              pause or a delete lands here instead, and here there was nothing
              to press: the list was stale, the message asked for another go and
              the only way to have one was to leave the page or reload it. */}
          <button
            className="btn-secondary mt-3 flex w-full justify-center"
            type="button"
            onClick={retry}
            data-testid="routines.retry"
          >
            Try again
          </button>
        </Notice>
      ) : null}
      {confirmation ? <Notice tone="warning">{confirmation}</Notice> : null}

      {composing ? (
        <div className="card mb-4 p-4">
          <label className="label" htmlFor="routine-prompt">
            What should your coworker do?
          </label>
          <textarea
            id="routine-prompt"
            className="field min-h-[6rem] resize-y"
            placeholder="Give me a short brief for today…"
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            {ROUTINE_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.key}
                type="button"
                className="chip-off"
                onClick={() =>
                  setDraft({
                    prompt: suggestion.prompt,
                    label: suggestion.label,
                    cadence: suggestion.cadence,
                    hour: suggestion.hour,
                    weekday: suggestion.weekday,
                  })
                }
              >
                {suggestion.label}
              </button>
            ))}
          </div>

          <p className="label mt-4">How often</p>
          <div className="flex flex-wrap gap-2">
            {CADENCES.map((cadence) => (
              <Chip
                key={cadence.id}
                label={cadence.label}
                selected={draft.cadence === cadence.id}
                onClick={() => setDraft({ ...draft, cadence: cadence.id })}
              />
            ))}
          </div>

          {draft.cadence !== 'hourly' ? (
            <>
              <p className="label mt-4">At</p>
              <div className="flex flex-wrap gap-2">
                {ROUTINE_TIME_CHOICES.map((hour) => (
                  <Chip
                    key={hour}
                    label={formatHourChoice(hour)}
                    selected={draft.hour === hour}
                    onClick={() => setDraft({ ...draft, hour })}
                  />
                ))}
              </div>
            </>
          ) : null}

          {draft.cadence === 'weekly' ? (
            <>
              <p className="label mt-4">On</p>
              <div className="flex flex-wrap gap-2">
                {ROUTINE_WEEKDAY_LABELS.map((label, index) => (
                  <Chip
                    key={label}
                    label={label}
                    selected={draft.weekday === index}
                    onClick={() => setDraft({ ...draft, weekday: index })}
                  />
                ))}
              </div>
            </>
          ) : null}

          {/* Next to the button that failed, not at the top of a page the
              reader has scrolled away from. */}
          {saveError ? (
            <p className="mt-4 text-body-sm text-danger" role="alert">
              {saveError}
            </p>
          ) : null}

          <div className="mt-5 flex gap-2">
            <button
              className="btn-secondary flex-1"
              type="button"
              onClick={() => {
                setComposing(false);
                setSaveError(null);
                setDraft(EMPTY_DRAFT);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn-primary flex-1" type="button" onClick={() => void save()} disabled={busy || !isRoutinePromptReady(draft.prompt)}>
              {busy ? 'Saving…' : 'Create routine'}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <Spinner label="Loading your routines…" />
      ) : error && routines.length === 0 && !composing ? (
        // A failed read is not the same as having none, and saying otherwise
        // would tell someone their routines had vanished.
        <EmptyState
          title="We could not load your routines"
          body="They are still set up and still due to run. This is a problem reaching them, not a problem with the routines."
          action={
            <button className="btn-secondary" type="button" onClick={retry}>
              Try again
            </button>
          }
        />
      ) : routines.length === 0 && !composing ? (
        <EmptyState
          title="No routines yet"
          body="A routine is a standing instruction, like a morning brief or a weekly review, that runs without you asking."
          action={
            <button className="btn-primary" type="button" onClick={() => setComposing(true)}>
              Create your first routine
            </button>
          }
        />
      ) : (
        routines.map((routine) => (
          <article key={routine.id} className="card mb-3 p-4">
            {/* The name is the one thing on this card the reader chose, so it
                keeps a floor of 11rem and the buttons drop beneath it on a
                narrow screen. Letting the text column shrink instead cut a
                named routine down to "Write the weekly…" at 320px. */}
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-[11rem] flex-1">
                <p className="line-clamp-2 text-body font-medium text-textPrimary">{routineTitle(routine)}</p>
                <p className="mt-0.5 text-body-sm text-textSecondary">{describeCadence(routine)}</p>
                {routine.status === 'paused' ? (
                  // Amber on white is 2.8:1, so the state is carried by a tinted
                  // badge rather than by faint coloured text.
                  <span className="mt-1 inline-block rounded-full bg-[#F5E9D9] px-2 py-0.5 text-body-sm text-textPrimary">
                    Paused
                  </span>
                ) : describeNextRun(routine.nextRunAt, now) ? (
                  // Rendered only when there is one. The empty string this used
                  // to fall back to still drew a paragraph with its top margin,
                  // so a routine with no next run carried a blank line where
                  // the phone drew nothing.
                  <p className="mt-0.5 text-body-sm text-textSecondary">{describeNextRun(routine.nextRunAt, now)}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="inline-flex min-h-[44px] items-center rounded-md px-2.5 text-body-sm text-textSecondary hover:bg-bg disabled:opacity-50"
                  onClick={() => void togglePaused(routine)}
                  disabled={togglingId === routine.id}
                >
                  {togglingId === routine.id ? 'Saving…' : routine.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="inline-flex min-h-[44px] items-center rounded-md px-2.5 text-body-sm text-danger hover:bg-bg disabled:opacity-50"
                  onClick={() => setPendingDelete(routine)}
                  disabled={togglingId === routine.id}
                >
                  Delete
                </button>
              </div>
            </div>
            {/* Beneath the two buttons that can produce it, inside the card for
                the routine it happened to. */}
            {rowError?.id === routine.id ? (
              <p className="mt-3 text-body-sm text-danger" role="alert">
                {rowError.message}
              </p>
            ) : null}
            {routine.label && routine.label !== routine.prompt ? (
              <p className="mt-3 line-clamp-3 text-body-sm text-textSecondary">{routine.prompt}</p>
            ) : null}
          </article>
        ))
      )}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this routine?"
          message={`"${routineTitle(pendingDelete)}" will stop running. This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </Screen>
  );
}

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={selected ? 'chip-on' : 'chip-off'}
    >
      {label}
    </button>
  );
}
