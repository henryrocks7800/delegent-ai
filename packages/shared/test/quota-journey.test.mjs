// Quota-journey shared-package tests (AGENT_TODO_CHECKLIST §2.5 / Batch 4a).
//
// Verifies the friendly-copy + reset-line helpers in
// packages/shared/src/quotaJourney.ts. The Worker-side enforcement tests live
// at apps/worker/test/quota-journey.test.mjs and exercise the gate/guard/
// violation-log code paths separately.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_PAUSE_BASE_COPY,
  buildQuotaPauseResponse,
  formatCycleEndLine,
  summariseBillingPeriod,
} from '../dist/index.js';

test('QUOTA_PAUSE_BASE_COPY: matches the AGENT_TODO_CHECKLIST §2.5 wording verbatim', () => {
  assert.equal(
    QUOTA_PAUSE_BASE_COPY,
    "You've used this month's included assistant time, so I've paused new tasks for now. " +
      'You can upgrade to keep going today, or wait until your next billing cycle starts.',
  );
});

test('buildQuotaPauseResponse(token): primary + secondary line + 5 actions', () => {
  const response = buildQuotaPauseResponse({
    capKind: 'token',
    reason: 'tier_limit_exceeded',
    nextResetAtIso: '2026-06-15T00:00:00.000Z',
    tierId: 'studio',
  });
  assert.equal(response.capKind, 'token');
  assert.equal(response.reason, 'tier_limit_exceeded');
  assert.match(response.primary, /paused new tasks/);
  assert.match(response.secondary, /upgrade|next billing cycle/);
  assert.equal(response.actions.length, 5);
  assert.equal(response.actions[0].id, 'upgrade');
  assert.equal(response.actions[0].tone, 'primary');
  assert.equal(response.nextResetAtIso, '2026-06-15T00:00:00.000Z');
  assert.equal(response.tierId, 'studio');
});

test('buildQuotaPauseResponse(storage): "Your private cloud space is full" + free-up CTA', () => {
  const response = buildQuotaPauseResponse({ capKind: 'storage', reason: 'storage_full' });
  assert.match(response.primary, /private cloud space is full/);
  assert.equal(response.actions[0].id, 'free_up_storage');
  assert.equal(response.actions[0].tone, 'primary');
  assert.equal(response.nextResetAtIso, null);
});

test('buildQuotaPauseResponse(voice): "type instead" primary CTA + see-reset-date secondary', () => {
  const response = buildQuotaPauseResponse({
    capKind: 'voice',
    reason: 'voice_cap_exceeded',
    nextResetAtIso: '2026-06-01T00:00:00.000Z',
    tierId: 'pro-office',
  });
  assert.match(response.primary, /voice transcription time/);
  assert.equal(response.actions[0].id, 'dismiss');
  assert.equal(response.actions[0].label, 'Type instead');
  assert.ok(response.actions.some((a) => a.id === 'upgrade'));
  assert.ok(response.actions.some((a) => a.id === 'see_reset_date'));
});

test('buildQuotaPauseResponse(concurrent / rate / global_spend): transient — single try-again action, no reset date', () => {
  for (const capKind of ['concurrent', 'rate', 'global_spend']) {
    const response = buildQuotaPauseResponse({ capKind, reason: capKind });
    assert.equal(response.capKind, capKind);
    assert.equal(response.actions.length, 1);
    assert.equal(response.actions[0].id, 'wait_brief_moment');
    assert.equal(response.actions[0].tone, 'primary');
    assert.equal(response.nextResetAtIso, null);
  }
});

test('buildQuotaPauseResponse(global_spend): copy emphasises "we will not bill for paused time"', () => {
  const response = buildQuotaPauseResponse({ capKind: 'global_spend', reason: 'global_spend_paused' });
  assert.match(response.primary, /temporarily paused/);
  assert.match(response.secondary, /will not bill/);
});

test('buildQuotaPauseResponse: leak guards — no provider names in any cap copy', () => {
  const provisionerWords =
    /openrouter|cloudflare|fly\.io|fly machines|supabase|stripe|telegram|whatsapp|signal/i;
  for (const capKind of ['token', 'storage', 'voice', 'concurrent', 'rate', 'global_spend']) {
    const response = buildQuotaPauseResponse({ capKind, reason: capKind });
    assert.ok(
      !provisionerWords.test(response.primary),
      `${capKind} primary leaks a provider name: ${response.primary}`,
    );
    assert.ok(
      !provisionerWords.test(response.secondary),
      `${capKind} secondary leaks a provider name: ${response.secondary}`,
    );
  }
});

test('formatCycleEndLine: en-GB-formatted UTC date', () => {
  const line = formatCycleEndLine('2026-06-15T00:00:00.000Z');
  // en-GB Intl.DateTimeFormat with weekday+day+month omits the comma between
  // weekday and day. Don't pin the exact punctuation, assert the parts.
  assert.ok(line);
  assert.match(line, /^Your monthly time resets on Monday[, ]+15 June\.$/);
});

test('formatCycleEndLine: a cancelled plan is told it ends, not that it resets', () => {
  // The same timestamp, the opposite meaning. Promising a reset to someone who
  // has cancelled is the defect this argument exists to stop.
  const line = formatCycleEndLine('2026-06-15T00:00:00.000Z', true);
  assert.ok(line);
  assert.match(line, /^Your plan ends on Monday[, ]+15 June and will not renew\.$/);
  assert.doesNotMatch(line, /reset/i);
});

test('formatCycleEndLine: returns null for null input', () => {
  assert.equal(formatCycleEndLine(null), null);
  assert.equal(formatCycleEndLine(null, true), null);
});

test('formatCycleEndLine: returns null for unparseable input', () => {
  assert.equal(formatCycleEndLine('not-a-date'), null);
});

// ---------------------------------------------------------------------------
// summariseBillingPeriod: the labelled profile row (2026-07-30)
// ---------------------------------------------------------------------------
const NOW = new Date('2026-07-30T00:00:00.000Z');

test('summariseBillingPeriod: a renewing plan says Renews and offers no way back on', () => {
  const summary = summariseBillingPeriod({ cycleEndAtIso: '2026-08-29T10:57:56.000Z', now: NOW });
  assert.equal(summary.state, 'renews');
  assert.equal(summary.label, 'Renews');
  assert.equal(summary.value, '29 August 2026');
  // Nothing to fix, so no button: a CTA here would imply something is wrong.
  assert.equal(summary.actionLabel, null);
  assert.match(summary.note, /Renews automatically/);
});

test('summariseBillingPeriod: a cancelled but still running plan says Ends and offers Resume', () => {
  const summary = summariseBillingPeriod({
    cycleEndAtIso: '2026-08-29T10:57:56.000Z',
    cancelAtPeriodEnd: true,
    now: NOW,
  });
  assert.equal(summary.state, 'ends');
  assert.equal(summary.label, 'Ends');
  assert.equal(summary.actionLabel, 'Resume plan');
  assert.match(summary.note, /will not renew/);
  assert.doesNotMatch(summary.note, /reset/i);
});

test('summariseBillingPeriod: a plan whose date has passed says Ended and offers Resubscribe', () => {
  // Alex's own case: cancelled 8 July, lapsed 29 July, and the profile still
  // read as though the allowance was coming back.
  const summary = summariseBillingPeriod({ cycleEndAtIso: '2026-07-29T10:57:56.000Z', now: NOW });
  assert.equal(summary.state, 'ended');
  assert.equal(summary.label, 'Ended');
  assert.equal(summary.value, '29 July 2026');
  assert.equal(summary.actionLabel, 'Resubscribe');
  assert.match(summary.note, /Resubscribe/);
});

test('summariseBillingPeriod: a lapsed date beats the cancel flag, because it already happened', () => {
  const summary = summariseBillingPeriod({
    cycleEndAtIso: '2026-07-29T10:57:56.000Z',
    cancelAtPeriodEnd: true,
    now: NOW,
  });
  assert.equal(summary.state, 'ended');
});

test('summariseBillingPeriod: no usable date means no row rather than a placeholder', () => {
  assert.equal(summariseBillingPeriod({ cycleEndAtIso: null }), null);
  assert.equal(summariseBillingPeriod({ cycleEndAtIso: '' }), null);
  assert.equal(summariseBillingPeriod({ cycleEndAtIso: 'not-a-date' }), null);
});

test('summariseBillingPeriod: no state prints an em dash, a raw ISO string or a NaN date', () => {
  for (const cancelAtPeriodEnd of [false, true]) {
    for (const cycleEndAtIso of ['2026-07-29T10:57:56.000Z', '2026-08-29T10:57:56.000Z']) {
      const summary = summariseBillingPeriod({ cycleEndAtIso, cancelAtPeriodEnd, now: NOW });
      const text = `${summary.label} ${summary.value} ${summary.note} ${summary.actionLabel ?? ''}`;
      assert.doesNotMatch(text, /—/);
      assert.doesNotMatch(text, /Invalid Date|NaN|undefined|null|T\d\d:/);
    }
  }
});
