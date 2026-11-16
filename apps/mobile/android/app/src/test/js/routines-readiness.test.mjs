import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-25 (Alex, roadmap #3): Routines. The backend already existed
// (migration 0036 scheduled_tasks + the Worker's 5-minute waker); this suite
// guards the mobile surface and, more importantly, the two contracts the UI
// silently depends on:
//   * the waker enforces a 300s minimum interval, so every cadence the
//     composer offers must clear it;
//   * there is deliberately NO client INSERT policy on scheduled_tasks, so a
//     create MUST go through the Worker. If someone "simplifies" this to a
//     direct supabase insert it will fail closed in production only.

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const routinesSource = readFileSync(new URL('../../../../../src/routines/routines.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../../../../src/routines/routinesApi.ts', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../../../../../../../supabase/migrations/0036_scheduled_tasks.sql', import.meta.url), 'utf8');

// Scoped rather than searched for across the whole file. Other drawers hold a
// `busyId` and a notice of their own, so an unscoped match passes on another
// screen's copy of the line and proves nothing about this one.
const routinesDrawer = () => {
  const body = appSource.match(/function RoutinesDrawer[\s\S]*?\n\}\n/);
  assert.ok(body, 'RoutinesDrawer not found');
  return body[0];
};

test('Routines is reachable as its own burger-menu section', () => {
  assert.match(appSource, /testID="menu\.routinesRow"/, 'no Routines row in the menu');
  assert.match(appSource, /'routines'/, 'routines is not a DrawerView');
  assert.match(appSource, /view === 'routines' \? <RoutinesDrawer \/>/, 'the routines view renders nothing');
  assert.match(appSource, /view === 'routines' \? 'Routines'/, 'the routines subview has no header title');
});

test('the composer exposes stable testIDs for every control', () => {
  for (const id of [
    'routines.newButton',
    'routines.promptInput',
    'routines.labelInput',
    'routines.saveButton',
    'routines.cancelButton',
    'routines.cadence.hourly',
    'routines.cadence.daily',
    'routines.cadence.weekly',
  ]) {
    assert.ok(appSource.includes(`testID="${id}"`), `missing stable testID ${id}`);
  }
  // List-row controls are keyed by routine id, so assert the template form.
  assert.match(appSource, /testID=\{`routines\.toggle\.\$\{routine\.id\}`\}/);
  assert.match(appSource, /testID=\{`routines\.delete\.\$\{routine\.id\}`\}/);
});

test('every offered cadence clears the waker minimum the schema enforces', () => {
  const floor = Number(migrationSource.match(/interval_seconds\s*>=\s*(\d+)/)?.[1]);
  assert.equal(floor, 300, 'the schema floor moved; re-check the cadences');

  const block = routinesSource.match(/CADENCE_SECONDS: Record<RoutineCadence, number> = \{([\s\S]*?)\};/);
  assert.ok(block, 'CADENCE_SECONDS not found');
  const seconds = [...block[1].matchAll(/:\s*([\d_]+)/g)].map((m) => Number(m[1].replace(/_/g, '')));
  assert.ok(seconds.length >= 3, 'expected at least three cadences');
  for (const value of seconds) {
    assert.ok(value >= floor, `cadence ${value}s is below the ${floor}s floor the waker enforces`);
  }
});

test('creates go through the Worker because there is no client INSERT policy', () => {
  assert.doesNotMatch(
    migrationSource,
    /create policy \S+ on public\.scheduled_tasks\s+for insert/i,
    'a client INSERT policy appeared; the create path comment is now wrong',
  );
  assert.match(apiSource, /\/api\/scheduled-tasks/, 'create does not call the Worker endpoint');
  assert.doesNotMatch(
    apiSource,
    /from\('scheduled_tasks'\)\s*\.insert/,
    'routines are being inserted straight into Supabase, which RLS blocks in production',
  );
});

test('list, pause and delete use the owner RLS policies that exist', () => {
  for (const policy of ['for select', 'for update', 'for delete']) {
    assert.ok(
      new RegExp(`create policy \\S+ on public\\.scheduled_tasks\\s+${policy}`, 'i').test(migrationSource),
      `migration 0036 has no owner ${policy} policy`,
    );
  }
  assert.match(apiSource, /from\('scheduled_tasks'\)\s*\.select/, 'no RLS-backed list read');
  assert.match(apiSource, /from\('scheduled_tasks'\)\.update/, 'no RLS-backed status update');
});

test('deleting a routine is a soft cancel, and cancelled routines stay hidden', () => {
  // 'cancelled' is what takes a row out of the waker's claim query, and the
  // list filters it out, so a deleted routine neither runs nor reappears.
  assert.match(apiSource, /status: 'cancelled'/, 'delete does not cancel the routine');
  assert.match(apiSource, /\.neq\('status', 'cancelled'\)/, 'cancelled routines would still be listed');
});

test('a failed read leaves a retry that survives the buttons around it', () => {
  // The error used to live in `notice`, which both "Set up a routine" and
  // Cancel clear. So a reader whose list failed could open the composer, back
  // out, and be left with an intro sentence and one button: no list, no error,
  // no empty state, and nothing that would ever ask the server again.
  assert.match(appSource, /const \[loadError, setLoadError\] = useState<string \| null>\(null\)/, 'the read error still shares notice');
  assert.match(appSource, /testID="routines\.retryButton"/, 'there is no retry control');
  assert.match(appSource, /const retryLoad = useCallback\(\(\) => \{\s*\n\s*setLoadState\('loading'\);/, 'retry gives no busy state, so the press looks dead');
  assert.match(appSource, /loadState === 'error' \? \(/, 'the error state renders nothing');
});

test('a routine that was created is not reported as a routine that failed', () => {
  // The create goes to the Worker and the refresh after it is a direct read, so
  // the create can land and the refresh fail. Shown as a bare read error over a
  // list missing the new routine, the obvious response is to make it a second
  // time, which is a second standing job nobody meant to set up.
  assert.match(appSource, /const refreshed = await load\(\);\s*\n\s*if \(!refreshed\) setConfirmation\(ROUTINE_CREATED_REFRESH_FAILED\)/);
  assert.match(appSource, /testID="routines\.confirmation"/);
  assert.match(appSource, /ROUTINE_CREATED_REFRESH_FAILED[\s\S]{0,4000}?from '@sidekick\/shared'/, 'the wording is not shared with the browser');
});

// The browser already split this out, on the surface with the most room for a
// notice at the top of the page. The phone is the one where the composer is an
// instruction box, a name box and fifteen chips before the reader reaches
// Create, and it was the one putting the reason above all of that.
test('a create that failed is reported beside the button that failed', () => {
  const drawer = routinesDrawer();
  assert.match(drawer, /const \[saveError, setSaveError\] = useState<string \| null>\(null\)/, 'the save failure still shares the drawer notice');
  const submit = drawer.match(/const submit = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(submit, 'the routines submit handler is gone');
  assert.match(submit[0], /setSaveError\(result\.error\.message\)/, 'a refused create says nothing beside Create');
  assert.equal(/setRowError\(/.test(submit[0]), false, 'the create path writes a per-routine failure');
  // Inside the composer, above the buttons, not at the top of the drawer.
  const composer = drawer.slice(drawer.indexOf('{composerOpen ? ('), drawer.indexOf('testID="routines.saveButton"'));
  assert.match(composer, /testID="routines\.saveError"/, 'the composer does not show its own failure');
  // Opening and closing the composer clears its own error and leaves the
  // drawer notice, which carries pause and delete failures, alone.
  assert.match(drawer, /setComposerOpen\(false\); setSaveError\(null\);/);
  assert.match(drawer, /setComposerOpen\(true\); setSaveError\(null\);/);
});

test('the Create button is disabled for exactly the reason the builder would refuse', () => {
  // The phone held a private floor of three characters. Nothing said so and
  // nothing appeared when it bit, so "Go" gave a dead button with no account of
  // why, and the identical two letters were accepted in the browser.
  assert.match(routinesSource, /export function isRoutinePromptReady/, 'the rule is not shared');
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/routines/RoutinesScreen.tsx', import.meta.url),
    'utf8',
  );
  for (const [name, source] of [['app', appSource], ['web', webScreen]]) {
    assert.match(source, /isRoutinePromptReady\(/, `${name} writes its own readiness rule`);
  }
  assert.equal(/prompt\.trim\(\)\.length < 3/.test(appSource), false, 'the phone still holds a private character floor');
  assert.equal(/!draft\.prompt\.trim\(\)/.test(webScreen), false, 'the browser still holds its own readiness rule');
});

test('a second press cannot send the opposite instruction to the first', () => {
  // The disabled prop is computed at render time, so two taps inside one frame
  // both see the button live and one pause plus one resume go out for the same
  // routine. Which state it lands in is then down to which reply finishes last.
  const drawer = routinesDrawer();
  const toggle = drawer.match(/const togglePaused = async \(routine: Routine\) => \{[\s\S]*?\n  \};/);
  assert.ok(toggle, 'the routines toggle handler is gone');
  assert.match(toggle[0], /if \(busyId === routine\.id\) return;/, 'the phone has no re-entrancy guard');
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/routines/RoutinesScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.match(webScreen, /if \(togglingId === routine\.id\) return;/, 'the browser lost its re-entrancy guard');
});

test('a routine with no next run draws nothing rather than an empty line', () => {
  // `?? ''` still renders the paragraph, and its top margin with it, so the
  // browser left a blank gap under the cadence where the phone drew nothing.
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/routines/RoutinesScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.equal(/describeNextRun\([^)]*\) \?\? ''/.test(webScreen), false, 'the browser still renders an empty paragraph');
  assert.match(webScreen, /\) : describeNextRun\(routine\.nextRunAt, now\) \? \(/);
});

test('a pause or delete that was refused is said in the card it was refused for', () => {
  // Both surfaces wrote a single page-level message at the very top: above the
  // intro, above the composer button, above the whole list. The button that
  // produced it was somewhere further down beside a routine the message never
  // named, so with two routines there was nothing on screen to say which one
  // had not paused. On the browser the delete case was worse still, because the
  // dialog closed on the press and the only thing that changed was a line the
  // reader had already scrolled past.
  const drawer = routinesDrawer();
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/routines/RoutinesScreen.tsx', import.meta.url),
    'utf8',
  );

  // The message has to carry the routine, or it cannot be drawn next to it.
  for (const [name, source] of [['app', drawer], ['web', webScreen]]) {
    assert.match(
      source,
      /const \[rowError, setRowError\] = useState<\{ id: string; message: string \} \| null>\(null\)/,
      `${name} does not carry the routine the failure belongs to`,
    );
  }

  const toggle = drawer.match(/const togglePaused = async \(routine: Routine\) => \{[\s\S]*?\n  \};/);
  assert.ok(toggle, 'the routines toggle handler is gone');
  assert.match(toggle[0], /setRowError\(\{ id: routine\.id, message: result\.error\.message \}\)/);
  const remove = drawer.match(/const confirmDelete = \(routine: Routine\) => \{[\s\S]*?\n  \};/);
  assert.ok(remove, 'the routines delete handler is gone');
  assert.match(remove[0], /setRowError\(\{ id: routine\.id, message: result\.error\.message \}\)/);
  assert.equal(/setNotice\(/.test(drawer), false, 'a routines failure still writes the drawer-wide notice');

  const webToggle = webScreen.match(/async function togglePaused\(routine: Routine\) \{[\s\S]*?\n  \}/);
  assert.ok(webToggle, 'the browser toggle handler is gone');
  assert.match(webToggle[0], /setRowError\(\{ id: routine\.id, message: result\.message \}\)/);
  assert.equal(/setError\(/.test(webToggle[0]), false, 'a refused pause still writes the page-level error');
  const webDelete = webScreen.match(/async function confirmDelete\(\) \{[\s\S]*?\n  \}/);
  assert.ok(webDelete, 'the browser delete handler is gone');
  assert.match(webDelete[0], /setRowError\(\{ id: target\.id, message: result\.message \}\)/);
  assert.equal(/setError\(/.test(webDelete[0]), false, 'a refused delete still writes the page-level error');

  // And it has to render inside the card, which is the part that moving it back
  // to the top of the screen would break.
  const drawerList = drawer.slice(
    drawer.indexOf('{routines.map((routine) => {'),
    drawer.indexOf("{loadState === 'ready' && !composerOpen ?"),
  );
  assert.ok(drawerList.length > 0, 'the routines card list is gone');
  assert.equal(
    (drawer.match(/\{rowError\.message\}/g) || []).length,
    1,
    'exactly one place on the phone should draw the row failure',
  );
  assert.match(drawerList, /rowError\?\.id === routine\.id \? \(/, 'the phone draws it outside the card');
  assert.ok(
    drawerList.indexOf('routines.rowError') > drawerList.indexOf('routines.delete.'),
    'the phone draws it above the buttons that produce it',
  );

  const webList = webScreen.slice(
    webScreen.indexOf('routines.map((routine) => ('),
    webScreen.indexOf('{pendingDelete ? ('),
  );
  assert.ok(webList.length > 0, 'the browser routines card list is gone');
  assert.equal(
    (webScreen.match(/\{rowError\.message\}/g) || []).length,
    1,
    'exactly one place in the browser should draw the row failure',
  );
  assert.match(webList, /rowError\?\.id === routine\.id \? \(/, 'the browser draws it outside the card');
  assert.match(webList, /role="alert"/, 'the browser failure is not announced');
});

test('the Worker still gates routine creation on an active subscription', () => {
  const workerSource = readFileSync(new URL('../../../../../../worker/src/index.ts', import.meta.url), 'utf8');
  const handler = workerSource.match(/async function handleCreateScheduledTask[\s\S]*?\n\}/);
  assert.ok(handler, 'handleCreateScheduledTask not found');
  assert.match(handler[0], /subscriptionStatusRetainsWorkspaceEntitlement/, 'the entitlement gate is gone');
  assert.match(handler[0], /no_active_subscription/, 'the 402 path is gone');
});
