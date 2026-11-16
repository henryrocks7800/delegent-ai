// Routines (roadmap #3) — the user-facing wrapper around `scheduled_tasks`.
//
// The schema only understands `interval` (>= 300s) and `once`; there are no cron
// expressions. So "every Monday at 9am" is expressed as an 86400*7 interval
// anchored by `first_run_at` at the next Monday 9am in the user's local zone.
//
// The interval alone would drift off that local hour at every clock change, so
// the draft also carries the device's IANA zone. Migration 0046 advances a
// whole-day cadence in that zone, which keeps 09:00 at 09:00 all year.

export type RoutineCadence = 'hourly' | 'daily' | 'weekly';

export type RoutineStatus = 'active' | 'paused' | 'cancelled' | 'done';

export type Routine = {
  id: string;
  prompt: string;
  label: string | null;
  cadence: RoutineCadence | null;
  intervalSeconds: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: RoutineStatus;
  consecutiveFailures: number;
};

export type RoutineDraft = {
  prompt: string;
  label?: string | null;
  cadence: RoutineCadence;
  /** Local hour of day (0-23) for daily/weekly. Ignored for hourly. */
  hour: number;
  /** 0 = Sunday ... 6 = Saturday. Only used for weekly. */
  weekday: number;
};

export type RoutineCreateBody = {
  prompt: string;
  schedule_kind: 'interval';
  interval_seconds: number;
  first_run_at: string;
  timezone: string;
  label?: string;
};

/** The device's IANA zone, or UTC when the runtime cannot name one. */
export function deviceTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.trim() ? zone.trim() : 'UTC';
  } catch {
    return 'UTC';
  }
}

export const ROUTINE_MAX_PROMPT_LENGTH = 4_000;

export const CADENCE_SECONDS: Record<RoutineCadence, number> = {
  hourly: 3_600,
  daily: 86_400,
  weekly: 604_800,
};

export const ROUTINE_TIME_CHOICES: readonly number[] = [7, 9, 12, 18, 21];

export const ROUTINE_WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type RoutineSuggestion = {
  key: string;
  label: string;
  prompt: string;
  cadence: RoutineCadence;
  hour: number;
  weekday: number;
};

export const ROUTINE_SUGGESTIONS: readonly RoutineSuggestion[] = [
  {
    key: 'morning-brief',
    label: 'Morning brief',
    prompt: 'Give me a short brief for today: anything you think I should know, plus what you would prioritise. Keep it under ten lines.',
    cadence: 'daily',
    hour: 7,
    weekday: 1,
  },
  {
    key: 'weekly-review',
    label: 'Weekly review',
    prompt: 'Summarise what we worked on together this week, what is still open, and suggest three things to focus on next week.',
    cadence: 'weekly',
    hour: 9,
    weekday: 1,
  },
  {
    key: 'end-of-day',
    label: 'End-of-day wrap-up',
    prompt: 'Wrap up my day: summarise what we covered, list anything I said I would do, and flag anything you are still waiting on from me.',
    cadence: 'daily',
    hour: 18,
    weekday: 1,
  },
  {
    key: 'inbox-summary',
    label: 'Inbox summary',
    prompt: 'Check my inbox and summarise anything that needs a reply from me, most urgent first.',
    cadence: 'daily',
    hour: 9,
    weekday: 1,
  },
];

export function cadenceFromIntervalSeconds(seconds: number | null): RoutineCadence | null {
  if (seconds === CADENCE_SECONDS.hourly) return 'hourly';
  if (seconds === CADENCE_SECONDS.daily) return 'daily';
  if (seconds === CADENCE_SECONDS.weekly) return 'weekly';
  return null;
}

/**
 * The next local moment the routine should first fire. Hourly anchors to the
 * next whole hour; daily/weekly to the next occurrence of the chosen time,
 * strictly in the future so the waker never fires it immediately.
 */
export function computeFirstRunAt(draft: RoutineDraft, now: Date): Date {
  const first = new Date(now.getTime());
  first.setSeconds(0, 0);

  if (draft.cadence === 'hourly') {
    first.setMinutes(0);
    first.setHours(first.getHours() + 1);
    return first;
  }

  first.setMinutes(0);
  first.setHours(clampHour(draft.hour));
  if (first.getTime() <= now.getTime()) first.setDate(first.getDate() + 1);

  if (draft.cadence === 'weekly') {
    const target = clampWeekday(draft.weekday);
    const daysAhead = (target - first.getDay() + 7) % 7;
    if (daysAhead > 0) first.setDate(first.getDate() + daysAhead);
  }

  return first;
}

/**
 * Whether there is enough of an instruction to send. The same rule as the one
 * `buildRoutineCreateBody` enforces below, exposed so the Create button on both
 * surfaces is disabled for exactly the reason the builder would refuse.
 *
 * The phone used to hold its own floor of three characters. Nothing said so and
 * nothing was shown when it applied, so a reader who typed "Go" got a button
 * that did nothing with no account of why, and the same two letters were
 * accepted in the browser.
 */
export function isRoutinePromptReady(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed.length > 0 && trimmed.length <= ROUTINE_MAX_PROMPT_LENGTH;
}

export function buildRoutineCreateBody(draft: RoutineDraft, now: Date): RoutineCreateBody | { error: string } {
  const prompt = draft.prompt.trim();
  if (!prompt) return { error: 'Tell your coworker what to do.' };
  if (prompt.length > ROUTINE_MAX_PROMPT_LENGTH) return { error: 'That instruction is too long.' };

  const body: RoutineCreateBody = {
    prompt,
    schedule_kind: 'interval',
    interval_seconds: CADENCE_SECONDS[draft.cadence],
    first_run_at: computeFirstRunAt(draft, now).toISOString(),
    timezone: deviceTimezone(),
  };

  const label = typeof draft.label === 'string' ? draft.label.trim().slice(0, 200) : '';
  if (label) body.label = label;

  return body;
}

export function mapRoutineRows(rows: unknown): readonly Routine[] {
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): Routine[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id);
    const prompt = text(row.prompt);
    if (!id || !prompt) return [];

    const intervalSeconds = typeof row.interval_seconds === 'number' && Number.isFinite(row.interval_seconds)
      ? row.interval_seconds
      : null;

    return [{
      id,
      prompt,
      label: text(row.label),
      cadence: cadenceFromIntervalSeconds(intervalSeconds),
      intervalSeconds,
      nextRunAt: text(row.next_run_at),
      lastRunAt: text(row.last_run_at),
      status: routineStatus(row.status),
      consecutiveFailures: typeof row.consecutive_failures === 'number' ? row.consecutive_failures : 0,
    }];
  });
}

/** What the user sees as the routine's title when they didn't name it. */
export function routineTitle(routine: Routine): string {
  if (routine.label) return routine.label;
  const firstLine = routine.prompt.split('\n')[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

export function describeCadence(routine: Routine, referenceRunAt?: string | null): string {
  const at = referenceRunAt ?? routine.nextRunAt;
  const time = at ? formatClockTime(new Date(at)) : null;

  if (routine.cadence === 'hourly') return 'Every hour';
  if (routine.cadence === 'daily') return time ? `Every day at ${time}` : 'Every day';
  if (routine.cadence === 'weekly') {
    if (!at) return 'Every week';
    const date = new Date(at);
    return `Every ${ROUTINE_WEEKDAY_LABELS[date.getDay()]} at ${formatClockTime(date)}`;
  }
  if (routine.intervalSeconds === null) return 'Once';
  return `Every ${Math.round(routine.intervalSeconds / 3_600)} hours`;
}

export function describeNextRun(nextRunAt: string | null, now: Date): string | null {
  if (!nextRunAt) return null;
  const next = new Date(nextRunAt);
  if (Number.isNaN(next.getTime())) return null;
  if (next.getTime() <= now.getTime()) return 'Due now';

  const time = formatClockTime(next);
  const dayDelta = calendarDaysBetween(now, next);
  if (dayDelta === 0) return `Today at ${time}`;
  if (dayDelta === 1) return `Tomorrow at ${time}`;
  if (dayDelta < 7) return `${ROUTINE_WEEKDAY_LABELS[next.getDay()]} at ${time}`;
  return `${next.getDate()} ${MONTH_LABELS[next.getMonth()]} at ${time}`;
}

export function formatClockTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatHourChoice(hour: number): string {
  return `${String(clampHour(hour)).padStart(2, '0')}:00`;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return 9;
  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

function clampWeekday(weekday: number): number {
  if (!Number.isFinite(weekday)) return 1;
  return Math.min(6, Math.max(0, Math.trunc(weekday)));
}

function routineStatus(value: unknown): RoutineStatus {
  return value === 'paused' || value === 'cancelled' || value === 'done' ? value : 'active';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
