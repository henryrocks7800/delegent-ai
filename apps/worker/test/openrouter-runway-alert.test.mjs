// OpenRouter "run-dry" alert — the alert is RUNWAY-relative (days left at the
// current burn rate), NOT a fixed dollar floor. The operator's exact ask: with
// 100 users a low balance is fine; with 5 users the same figure is plenty; with
// many users even a larger balance is urgent. The burn-rate divisor makes the
// same balance trigger at different times depending on the live user count.
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOpenRouterRunway } from '../dist/index.js';

test('fires when runway (remaining / burn) is within the threshold — the live $3 fuse', () => {
  // Real 2026-06-03 shape: $10 cap, $3.06 left, ~$2.95 used this week.
  const e = evaluateOpenRouterRunway(
    { limit: 10, limit_remaining: 3.061, usage_daily: 0.0077, usage_weekly: 2.954, usage_monthly: 2.954 },
    { alertDays: 10 },
  );
  assert.equal(e.shouldAlert, true);
  assert.equal(e.reason, 'low_runway');
  assert.ok(e.runwayDays > 0 && e.runwayDays <= 10);
});

test('SAME balance, FEW users (tiny burn) -> NOT urgent (long runway, no alert)', () => {
  // $3 left but almost no usage => hundreds of days of runway => do not alert.
  const e = evaluateOpenRouterRunway(
    { limit: 10, limit_remaining: 3.0, usage_weekly: 0.07 }, // ~$0.01/day
    { alertDays: 10 },
  );
  assert.equal(e.shouldAlert, false);
  assert.equal(e.reason, 'ok');
  assert.ok(e.runwayDays > 100, `expected long runway, got ${e.runwayDays}`);
});

test('HIGH balance, MANY users (high burn) -> urgent (short runway, alert)', () => {
  // $50 left but $50/day burn => ~1 day runway => alert even though the dollar
  // figure looks "healthy". This is why a fixed $ floor would be wrong.
  const e = evaluateOpenRouterRunway(
    { limit: 100, limit_remaining: 50, usage_weekly: 350 }, // $50/day
    { alertDays: 10 },
  );
  assert.equal(e.shouldAlert, true);
  assert.equal(e.reason, 'low_runway');
  assert.ok(e.runwayDays <= 2);
});

test('exhausted credit -> alert immediately (reason exhausted, 0 days)', () => {
  const e = evaluateOpenRouterRunway({ limit: 10, limit_remaining: 0, usage_weekly: 5 }, { alertDays: 10 });
  assert.equal(e.shouldAlert, true);
  assert.equal(e.reason, 'exhausted');
  assert.equal(e.runwayDays, 0);
});

test('no per-key limit -> no fuse, never alerts', () => {
  const e = evaluateOpenRouterRunway({ limit: null, limit_remaining: null, usage_weekly: 100 }, { alertDays: 10 });
  assert.equal(e.shouldAlert, false);
  assert.equal(e.reason, 'no_limit');
});

test('limit set but no usage yet -> not urgent (nobody is burning it)', () => {
  const e = evaluateOpenRouterRunway({ limit: 10, limit_remaining: 1 }, { alertDays: 10 });
  assert.equal(e.shouldAlert, false);
  assert.equal(e.reason, 'no_burn_signal');
});

test('the days threshold is configurable and honoured', () => {
  const data = { limit: 100, limit_remaining: 15, usage_weekly: 7 }; // $1/day -> 15 days runway
  assert.equal(evaluateOpenRouterRunway(data, { alertDays: 10 }).shouldAlert, false, '15d runway is fine under a 10d threshold');
  assert.equal(evaluateOpenRouterRunway(data, { alertDays: 20 }).shouldAlert, true, '15d runway alerts under a 20d threshold');
});

test('burn rate uses the FASTEST (most conservative) of the recent signals', () => {
  // weekly-avg ($1/day) is faster than monthly-avg ($0.10/day); the alert must
  // use the faster one so it warns early.
  const e = evaluateOpenRouterRunway(
    { limit: 100, limit_remaining: 5, usage_weekly: 7, usage_monthly: 3 },
    { alertDays: 10 },
  );
  assert.ok(Math.abs(e.burnPerDay - 1) < 1e-9, `expected $1/day burn, got ${e.burnPerDay}`);
  assert.ok(e.runwayDays <= 5);
  assert.equal(e.shouldAlert, true);
});

// 2026-07-30: a month-old spend burst held this alert on for three weeks. The
// monthly figure is a 30-day cumulative, so dividing it by 30 reports a burst
// that has already stopped as if it were still running, every hour, until it
// finally ages out of the window.
test('a burst EARLIER IN THE MONTH does not hold the alarm on once spend has collapsed', () => {
  // Exact live shape 2026-07-30: $13.35 of account credit, $181.02 spent over the
  // month (burst), but only $5.57 over the last 7 days = $0.80/day. The old
  // max-including-monthly read $6.03/day and screamed "~2.2 days left" hourly;
  // the honest answer at the burn actually happening is ~17 days.
  const e = evaluateOpenRouterRunway(
    { limit: null, limit_remaining: null, usage_daily: 0, usage_weekly: 5.56682339, usage_monthly: 181.021227774 },
    { alertDays: 10, accountRemaining: 13.348071543999993 },
  );
  assert.ok(Math.abs(e.burnPerDay - 5.56682339 / 7) < 1e-9, `expected the 7-day burn, got ${e.burnPerDay}`);
  assert.ok(e.runwayDays > 15, `expected ~17 days of runway, got ${e.runwayDays}`);
  assert.equal(e.shouldAlert, false);
});

test('a burst happening RIGHT NOW still alerts within hours, via the daily signal', () => {
  // The reason the fix keeps usage_daily: spend that restarts today must relight
  // the fuse without waiting for the weekly average to catch up.
  const e = evaluateOpenRouterRunway(
    { limit: null, limit_remaining: null, usage_daily: 6, usage_weekly: 5.5, usage_monthly: 181 },
    { alertDays: 10, accountRemaining: 13.35 },
  );
  assert.equal(e.burnPerDay, 6, 'today outweighs a quiet week');
  assert.ok(e.runwayDays < 3);
  assert.equal(e.shouldAlert, true);
});

test('an account too new for a daily/weekly signal still gets a fuse from the month', () => {
  const e = evaluateOpenRouterRunway(
    { limit: 100, limit_remaining: 5, usage_daily: 0, usage_weekly: 0, usage_monthly: 30 }, // $1/day
    { alertDays: 10 },
  );
  assert.equal(e.burnPerDay, 1);
  assert.equal(e.shouldAlert, true);
});

// 2026-06-05: account-aware runway. The alert must reflect the BINDING of the
// per-key spend cap AND the real account balance, and say which lever to pull.
// Before this, it read ONLY the per-key cap, so it reported "$0.94 left" when the
// account actually had $10.94 — misleading the operator into thinking chat was
// about to die for lack of money when the real fix was "raise the key cap".
test('per-key cap binds but the account has more -> binding=key_cap + reports the account (the live $0.94/$10 vs $10.94 case)', () => {
  const e = evaluateOpenRouterRunway(
    // exact live shape 2026-06-05: $10 key cap, $0.94 left, ~$0.73/day burn.
    { limit: 10, limit_remaining: 0.939, usage_daily: 0.0108, usage_weekly: 5.076, usage_monthly: 5.076 },
    { alertDays: 10, accountRemaining: 10.939 },
  );
  assert.equal(e.binding, 'key_cap', 'the $10 key cap runs dry before the $10.94 account');
  assert.ok(Math.abs(e.keyRemaining - 0.939) < 1e-6);
  assert.ok(Math.abs(e.accountRemaining - 10.939) < 1e-6);
  assert.ok(Math.abs(e.remaining - 0.939) < 1e-6, 'spendable = the binding (key cap), not the account');
  assert.equal(e.shouldAlert, true, 'runway ~1.3d at this burn -> still a real outage risk -> alert');
});

test('account balance is LOWER than the per-key cap -> binding=account (top up, not raise cap)', () => {
  const e = evaluateOpenRouterRunway(
    { limit: 100, limit_remaining: 80, usage_weekly: 7 }, // key cap fine ($80, $1/day)
    { alertDays: 10, accountRemaining: 2 },               // but only $2 of real money
  );
  assert.equal(e.binding, 'account');
  assert.equal(e.remaining, 2);
  assert.ok(e.runwayDays <= 2);
  assert.equal(e.shouldAlert, true);
});

test('no per-key cap but the account is known + draining -> still a fuse via the account (was previously blind)', () => {
  const e = evaluateOpenRouterRunway(
    { limit: null, limit_remaining: null, usage_weekly: 70 }, // $10/day burn, no key cap
    { alertDays: 10, accountRemaining: 5 },
  );
  assert.equal(e.binding, 'account');
  assert.equal(e.shouldAlert, true, 'a draining account with no per-key cap must still alert');
});

test('backward compat: with no accountRemaining the binding is the per-key cap (unchanged behaviour)', () => {
  const e = evaluateOpenRouterRunway({ limit: 10, limit_remaining: 3.061, usage_weekly: 2.954 }, { alertDays: 10 });
  assert.equal(e.binding, 'key_cap');
  assert.equal(e.shouldAlert, true);
});
