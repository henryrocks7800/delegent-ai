import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSortDuration, sortEstimateMinutes, sortTimeLeft, ukClock } from '../src/inboxSortEstimate.ts';

test('estimates are calibrated on the 24 Sep Outlook run and rounded up', () => {
  assert.equal(sortEstimateMinutes('outlook', 72_820, 20_876), 75);
  assert.equal(formatSortDuration(75), 'about 1 hour 15 minutes');
  assert.equal(formatSortDuration(sortEstimateMinutes('outlook', 46_938, 37_156)), 'about 50 minutes');
  assert.equal(formatSortDuration(sortEstimateMinutes('gmail', 400, 16)), 'a few minutes');
  assert.equal(formatSortDuration(120), 'about 2 hours');
  assert.equal(formatSortDuration(0), 'a few minutes');
  assert.equal(formatSortDuration(Number.NaN), 'a few minutes');
});

test('time left counts down from filing start and never goes below a few minutes', () => {
  const start = Date.UTC(2026, 8, 24, 18, 42);
  const input = { provider: 'outlook' as const, total: 72_820, toFile: 20_876, filingStartedAt: start };
  assert.equal(sortTimeLeft(input, start), 'about 1 hour 15 minutes');
  assert.equal(sortTimeLeft(input, start + 35 * 60_000), 'about 40 minutes');
  assert.equal(sortTimeLeft(input, start + 200 * 60_000), 'a few minutes');
  // A sort approved before filingStartedAt existed still gets the full estimate, not an error.
  assert.equal(sortTimeLeft({ provider: 'outlook', total: 72_820, toFile: 20_876 }), 'about 1 hour 15 minutes');
  assert.equal(ukClock(Date.UTC(2026, 8, 24, 19, 55)), '20:55');
});
