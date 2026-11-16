import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../../../../../../../packages/shared/src/index.ts', import.meta.url), 'utf8');
const helpSource = readFileSync(new URL('../../../../../../../packages/shared/src/content/help.ts', import.meta.url), 'utf8');
const inspirationsStateUrl = new URL('../../../../../src/state/inspirationsState.ts', import.meta.url);
const inspirationsStateSource = existsSync(inspirationsStateUrl) ? readFileSync(inspirationsStateUrl, 'utf8') : '';

test('mobile keeps the shared starter catalogue credential-free for future use-case surfaces', () => {
  assert.ok(existsSync(inspirationsStateUrl), 'src/state/inspirationsState.ts should exist');
  assert.match(inspirationsStateSource, /SIDEKICK_INSPIRATION_STARTERS/);
  assert.doesNotMatch(inspirationsStateSource, /fetch\(|XMLHttpRequest|WebSocket|process\.env|createClient|SUPABASE|SERVICE_ROLE|API_KEY|SECRET/i);
});

test('Use cases live in the hamburger menu as punchy examples, not fake live actions', () => {
  const menuMatch = appSource.match(/const useCaseLines = \[[\s\S]*?\] as const;/);
  assert.ok(menuMatch, 'Use case lines should live near drawer content');
  const useCaseSource = menuMatch[0];

  assert.match(appSource, /function MenuDrawer/);
  assert.doesNotMatch(appSource, /control centre/i);
  assert.match(appSource, /Use cases/);
  // 2026-05-15 copy pass: "digital employee" framing replaced with concrete
  // jobs. Audience signal still pinned via small-business PA + a supported
  // messenger.
  // 2026-05-15 copy pass: the line that signals the audience now reads
  // "A small business PA on WhatsApp or Telegram — admin off your plate..."
  // instead of "Small business PA: ..." + "WhatsApp task runner: ..." +
  // "Anything you can guide on a PC...". The substance is the same; the
  // wording is shorter and punchier.
  // v1.2.2 retired messenger language from the use-cases copy. The
  // audience cue is still "a small business PA"; the surface ("in your
  // pocket") replaces the old Telegram/WhatsApp reference.
  assert.match(useCaseSource, /small business PA in your pocket/i);
  assert.match(useCaseSource, /admin off your plate/i);
  assert.doesNotMatch(useCaseSource, /Run inspiration|Start request|Send now|Open Telegram|actionUrl|endpoint|provider/i);
  // The shipped mobile journey is chat + small readable attachments +
  // the runner Files workspace. Until there is a real in-app setup path
  // for third-party accounts and background jobs, examples must not sell
  // direct bank-feed, inbox, calendar, browser-form, supplier-order, or
  // follow-up automation as automatic outcomes.
  assert.doesNotMatch(
    useCaseSource,
    /bank feed|overnight emails read|calendar slots negotiated|repeat web forms|files claims|supplier orders triggered|competitor pricing tracked|reminders followed up without you typing/i,
  );
  assert.doesNotMatch(
    useCaseSource,
    /\bRecurring jobs?\b|\bscheduled chores\b|\brepeat jobs, all stick\b|\bnever off the clock\b/i,
    'Use cases must not imply unattended recurring/scheduled work before a user scheduler exists',
  );
  assert.match(useCaseSource, /repeatable/i, 'Repeat work should be framed as repeatable checklists/recipes/workflows today');
  assert.match(useCaseSource, /Files/i, 'Use cases should anchor file outcomes in the shipped Files workspace');
  assert.match(useCaseSource, /review/i, 'Use cases should make human review explicit for external actions');
  // Word-bound "secret" so "secretary" (a legitimate use-case word) doesn't match.
  assert.doesNotMatch(useCaseSource, /supabase|oauth|railway|cloudflare|openrouter|hermes|service-role|anon key|env var|api key|\bsecret\b|container|runtime|\bworker\b/i);
});

// The FAQ moved to packages/shared/src/content/help.ts so mobile and web render
// one source. Routines GA'd 2026-07-25, so the FAQ may now describe a real
// scheduler; what it must not do is revert to the pre-scheduler wordings that
// promised event-watching we never built.
test('FAQ describes the shipped scheduler accurately, without the pre-scheduler overclaims', () => {
  assert.match(helpSource, /export const DELEGENT_FAQ_ITEMS/, 'FAQ items should be defined in shared');
  assert.doesNotMatch(helpSource, /\bscheduled chores\b|\brepeat jobs, all stick\b|\bwatch for events on a schedule\b/i);
  assert.match(helpSource, /repeatable/i, 'FAQ should still explain saved repeatable workflows/checklists');
  assert.match(helpSource, /Open Routines in the menu/, 'FAQ should point at the shipped Routines surface');
});
