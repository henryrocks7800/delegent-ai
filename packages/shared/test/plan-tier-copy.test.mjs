// Public-copy contract for the three SIDEKICK_PLAN_TIERS shown in the
// mobile plan-picker. Catches:
//   (a) #12 em-dash regressions — the standing rule is no em-dashes in
//       customer-facing copy. The brand voice uses a colon or a
//       full-stop instead.
//   (b) #13 plan-tier blurbs aligned with the canonical 10 use cases
//       maintained in apps/mobile/App.tsx (useCaseLines).
//
// Pure-string assertions; no React, no Stripe, no Supabase.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sharedSource = readFileSync(
  new URL('../src/index.ts', import.meta.url),
  'utf8',
);

const TIER_BLOCK = /id: 'studio',[\s\S]*?features: \[[\s\S]*?\][\s\S]*?id: 'pro-office',[\s\S]*?features: \[[\s\S]*?\][\s\S]*?id: 'enterprise-suite',[\s\S]*?features: \[[\s\S]*?\]/;

test('first-run acknowledgement does not imply live connected-account access (#35)', () => {
  const acknowledgementMatch = sharedSource.match(/export const ACKNOWLEDGEMENT_TEXT =\s*(["'`])([\s\S]*?)\1;/);
  assert.ok(acknowledgementMatch, 'Could not locate ACKNOWLEDGEMENT_TEXT');
  const acknowledgement = acknowledgementMatch[2];

  assert.doesNotMatch(acknowledgement, /acts\s+through\s+the\s+accounts\s+you\s+connect/i);
  assert.doesNotMatch(acknowledgement, /accounts\s+you\s+connect/i);
  assert.match(acknowledgement, /context|files|scoped\s+details/i,
    'Acknowledgement should frame service access around user-provided context/files/scoped details');
  assert.match(acknowledgement, /review/i, 'Acknowledgement should keep human-review responsibility visible');
});

test('first-run acknowledgement version bumps after responsibility copy changes (#36)', () => {
  const versionMatch = sharedSource.match(/export const ACKNOWLEDGEMENT_VERSION = '([^']+)'/);
  assert.ok(versionMatch, 'Could not locate ACKNOWLEDGEMENT_VERSION');
  assert.match(versionMatch[1], /^v[2-9]\d*$/, 'Changed responsibility copy must not reuse the old v1 acceptance token');
});

test('plan-tier summaries contain no em-dashes (#12)', () => {
  const block = sharedSource.match(TIER_BLOCK);
  assert.ok(block, 'Could not locate the SIDEKICK_PLAN_TIERS literal');
  assert.doesNotMatch(block[0], /—/, 'Em-dash found in plan-tier copy; brand voice forbids it.');
});

test('plan-tier copy mentions canonical use-case categories (#13)', () => {
  // Studio: daily admin + drafts/forms. "Digital employee" (2026-06-18) became
  // "AI coworker" on 2026-09-16: nothing user-facing says employee any more.
  assert.match(sharedSource, /An AI coworker for your daily admin/);
  assert.match(sharedSource, /Drafts, forms, and the everyday back-and-forth/);

  // Pro: most of the working week + ongoing tasks / follow-ups
  assert.match(sharedSource, /An AI coworker for most of your working week/);
  assert.match(sharedSource, /Ongoing tasks, follow-ups, and bigger jobs/);
  assert.doesNotMatch(sharedSource, /Recurring jobs, invoice chasing, meeting prep/);

  // Max: heavy back office + bookkeeping/multi-step, WITHOUT unattended-automation claims
  assert.match(sharedSource, /An AI coworker for a heavy back office/);
  assert.doesNotMatch(sharedSource, /digital employee/i, 'no "employee" wording anywhere in shared copy');
  assert.match(sharedSource, /Bookkeeping, chasing, and multi-step work at volume/);
  assert.doesNotMatch(sharedSource, /Autonomous bookkeeping, 24\/7 secretary, multi-step jobs/);
});
