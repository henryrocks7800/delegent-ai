import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CADENCE_SECONDS,
  ROUTINE_SUGGESTIONS,
  buildRoutineCreateBody,
  cadenceFromIntervalSeconds,
  computeFirstRunAt,
  describeCadence,
  describeNextRun,
  deviceTimezone,
  formatClockTime,
  isRoutinePromptReady,
  mapRoutineRows,
  routineTitle,
  type Routine,
  type RoutineDraft,
} from './routines';

const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({
  prompt: 'Summarise my inbox',
  cadence: 'daily',
  hour: 9,
  weekday: 1,
  ...over,
});

// The Create button on both surfaces is disabled on this. If it ever disagrees
// with the builder, one of two things happens: a button that refuses an
// instruction the builder would have accepted, with nothing on screen saying
// why, or a button that sends one the builder then rejects. Both surfaces used
// to hold their own version of the rule and they had already drifted, so this
// pins the two together rather than pinning either one's wording.
test('the readiness rule accepts exactly what the builder accepts', () => {
  const now = new Date(2026, 6, 25, 7, 30, 12);
  const cases = ['', '   ', '\n\t ', 'Go', 'a', 'Summarise my inbox', 'x'.repeat(4_000), 'x'.repeat(4_001)];
  for (const prompt of cases) {
    const built = buildRoutineCreateBody(draft({ prompt }), now);
    const builderAccepts = !('error' in built);
    assert.equal(
      isRoutinePromptReady(prompt),
      builderAccepts,
      `readiness and the builder disagree on ${JSON.stringify(prompt.slice(0, 24))} (length ${prompt.length})`,
    );
  }
});

test('daily first run is the next occurrence of the chosen hour', () => {
  const now = new Date(2026, 6, 25, 7, 30, 12);
  const first = computeFirstRunAt(draft({ cadence: 'daily', hour: 9 }), now);

  assert.equal(first.getDate(), 25);
  assert.equal(first.getHours(), 9);
  assert.equal(first.getMinutes(), 0);
  assert.equal(first.getSeconds(), 0);
});

test('daily first run rolls to tomorrow when the hour has already passed', () => {
  const now = new Date(2026, 6, 25, 18, 5, 0);
  const first = computeFirstRunAt(draft({ cadence: 'daily', hour: 9 }), now);

  assert.equal(first.getDate(), 26);
  assert.equal(first.getHours(), 9);
});

test('daily first run rolls forward when the chosen hour is exactly now', () => {
  const now = new Date(2026, 6, 25, 9, 0, 0);
  const first = computeFirstRunAt(draft({ cadence: 'daily', hour: 9 }), now);

  assert.equal(first.getDate(), 26, 'must be strictly in the future so the waker does not fire it instantly');
});

test('weekly first run lands on the chosen weekday', () => {
  // 2026-07-25 is a Saturday.
  const now = new Date(2026, 6, 25, 7, 0, 0);
  const first = computeFirstRunAt(draft({ cadence: 'weekly', hour: 9, weekday: 1 }), now);

  assert.equal(first.getDay(), 1);
  assert.equal(first.getDate(), 27);
  assert.equal(first.getHours(), 9);
});

test('weekly first run stays today when today is already the chosen weekday and the time is ahead', () => {
  const now = new Date(2026, 6, 27, 7, 0, 0); // Monday
  const first = computeFirstRunAt(draft({ cadence: 'weekly', hour: 9, weekday: 1 }), now);

  assert.equal(first.getDate(), 27);
  assert.equal(first.getHours(), 9);
});

test('weekly first run jumps a full week when the chosen weekday time has passed', () => {
  const now = new Date(2026, 6, 27, 12, 0, 0); // Monday afternoon
  const first = computeFirstRunAt(draft({ cadence: 'weekly', hour: 9, weekday: 1 }), now);

  assert.equal(first.getDay(), 1);
  assert.equal(first.getDate(), 3);
  assert.equal(first.getMonth(), 7);
});

test('hourly first run is the next whole hour', () => {
  const now = new Date(2026, 6, 25, 7, 42, 9);
  const first = computeFirstRunAt(draft({ cadence: 'hourly' }), now);

  assert.equal(first.getHours(), 8);
  assert.equal(first.getMinutes(), 0);
  assert.equal(first.getSeconds(), 0);
});

test('create body matches the worker contract', () => {
  const now = new Date(2026, 6, 25, 7, 0, 0);
  const body = buildRoutineCreateBody(draft({ label: '  Morning brief  ' }), now);

  assert.ok(!('error' in body));
  assert.equal(body.schedule_kind, 'interval');
  assert.equal(body.interval_seconds, CADENCE_SECONDS.daily);
  assert.equal(body.prompt, 'Summarise my inbox');
  assert.equal(body.label, 'Morning brief');
  assert.equal(body.first_run_at, new Date(2026, 6, 25, 9, 0, 0).toISOString());
});

test('the create body carries a zone, so the routine keeps its local hour across a clock change', () => {
  // A fixed-seconds interval alone slides a 09:00 routine to 10:00 at the spring
  // change. Migration 0046 advances whole-day cadences in this zone instead, so
  // the field has to be present and has to be a real IANA name.
  const body = buildRoutineCreateBody(draft(), new Date(2026, 6, 25, 7, 0, 0));
  assert.ok(!('error' in body));
  assert.equal(typeof body.timezone, 'string');
  assert.ok(body.timezone.length > 0);
  assert.equal(body.timezone, deviceTimezone());
  assert.match(body.timezone, /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+)*$/, 'must survive the worker validator');
});

test('every cadence clears the worker minimum interval', () => {
  for (const seconds of Object.values(CADENCE_SECONDS)) {
    assert.ok(seconds >= 300, `interval ${seconds} is below the 300s floor the worker enforces`);
  }
});

test('create body rejects an empty instruction', () => {
  const body = buildRoutineCreateBody(draft({ prompt: '   ' }), new Date());
  assert.ok('error' in body);
});

test('create body rejects an over-long instruction', () => {
  const body = buildRoutineCreateBody(draft({ prompt: 'x'.repeat(4_001) }), new Date());
  assert.ok('error' in body);
});

test('create body omits the label when it is blank', () => {
  const body = buildRoutineCreateBody(draft({ label: '   ' }), new Date());
  assert.ok(!('error' in body));
  assert.equal('label' in body, false);
});

test('cadence is recovered from the stored interval', () => {
  assert.equal(cadenceFromIntervalSeconds(3_600), 'hourly');
  assert.equal(cadenceFromIntervalSeconds(86_400), 'daily');
  assert.equal(cadenceFromIntervalSeconds(604_800), 'weekly');
  assert.equal(cadenceFromIntervalSeconds(1_800), null);
  assert.equal(cadenceFromIntervalSeconds(null), null);
});

test('rows map safely and drop unusable records', () => {
  const routines = mapRoutineRows([
    {
      id: 'a',
      prompt: 'Summarise my inbox',
      label: 'Inbox',
      interval_seconds: 86_400,
      next_run_at: '2026-07-26T08:00:00.000Z',
      last_run_at: null,
      status: 'paused',
      consecutive_failures: 2,
    },
    { id: 'b' },
    { prompt: 'no id' },
    'nonsense',
  ]);

  assert.equal(routines.length, 1);
  assert.equal(routines[0].id, 'a');
  assert.equal(routines[0].cadence, 'daily');
  assert.equal(routines[0].status, 'paused');
  assert.equal(routines[0].consecutiveFailures, 2);
  assert.equal(routines[0].lastRunAt, null);
});

test('an unknown status falls back to active', () => {
  const routines = mapRoutineRows([{ id: 'a', prompt: 'p', status: 'weird' }]);
  assert.equal(routines[0].status, 'active');
});

test('rows map to an empty list when the payload is not an array', () => {
  assert.deepEqual(mapRoutineRows(null), []);
  assert.deepEqual(mapRoutineRows({}), []);
});

test('title falls back to the first line of the instruction', () => {
  const base: Routine = {
    id: 'a',
    prompt: 'Check the news\nthen tell me about it',
    label: null,
    cadence: 'daily',
    intervalSeconds: 86_400,
    nextRunAt: null,
    lastRunAt: null,
    status: 'active',
    consecutiveFailures: 0,
  };

  assert.equal(routineTitle(base), 'Check the news');
  assert.equal(routineTitle({ ...base, label: 'News' }), 'News');
  assert.equal(routineTitle({ ...base, prompt: 'y'.repeat(80) }).length, 58);
});

test('cadence descriptions read in plain English', () => {
  const at = new Date(2026, 6, 27, 9, 0, 0).toISOString(); // Monday
  const base: Routine = {
    id: 'a',
    prompt: 'p',
    label: null,
    cadence: 'daily',
    intervalSeconds: 86_400,
    nextRunAt: at,
    lastRunAt: null,
    status: 'active',
    consecutiveFailures: 0,
  };

  assert.equal(describeCadence(base), 'Every day at 09:00');
  assert.equal(describeCadence({ ...base, cadence: 'weekly', intervalSeconds: 604_800 }), 'Every Mon at 09:00');
  assert.equal(describeCadence({ ...base, cadence: 'hourly', intervalSeconds: 3_600 }), 'Every hour');
});

test('next run reads relative to now', () => {
  const now = new Date(2026, 6, 25, 7, 0, 0);

  assert.equal(describeNextRun(new Date(2026, 6, 25, 9, 0, 0).toISOString(), now), 'Today at 09:00');
  assert.equal(describeNextRun(new Date(2026, 6, 26, 9, 0, 0).toISOString(), now), 'Tomorrow at 09:00');
  assert.equal(describeNextRun(new Date(2026, 6, 28, 9, 0, 0).toISOString(), now), 'Tue at 09:00');
  assert.equal(describeNextRun(new Date(2026, 7, 10, 9, 0, 0).toISOString(), now), '10 Aug at 09:00');
  assert.equal(describeNextRun(new Date(2026, 6, 25, 6, 0, 0).toISOString(), now), 'Due now');
  assert.equal(describeNextRun(null, now), null);
  assert.equal(describeNextRun('not-a-date', now), null);
});

test('clock time is zero padded', () => {
  assert.equal(formatClockTime(new Date(2026, 6, 25, 7, 5, 0)), '07:05');
});

test('every suggestion produces a valid create body', () => {
  const now = new Date(2026, 6, 25, 7, 0, 0);
  for (const suggestion of ROUTINE_SUGGESTIONS) {
    const body = buildRoutineCreateBody({ ...suggestion }, now);
    assert.ok(!('error' in body), `${suggestion.key} did not build`);
    assert.ok(new Date(body.first_run_at).getTime() > now.getTime(), `${suggestion.key} is not in the future`);
  }
});
