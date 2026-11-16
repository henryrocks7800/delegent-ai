// Perf-plan step 3 (docs/PERFORMANCE_PLAN_2026-07.md) — per-turn timing line.
// buildDelegentTimingLine() is the Worker-side formatter for the one
// structured log line each live chat turn emits at finalize:
//   [delegent-timing] runId=... firstContentMs=... totalMs=... reason=...
// It must be pure (no clock reads), clamp negative deltas (clock weirdness
// must never produce nonsense), and render 'none' when no content was ever
// relayed (e.g. a turn that failed before the first token).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDelegentTimingLine } from '../dist/index.js';

test('formats first-content and total latencies from absolute timestamps', () => {
  const line = buildDelegentTimingLine({
    runId: 'run-1',
    startedAt: 10_000,
    firstContentAt: 12_500,
    endedAt: 19_000,
    reason: 'completed',
  });
  assert.equal(line, '[delegent-timing] runId=run-1 firstContentMs=2500 totalMs=9000 reason=completed');
});

test('renders firstContentMs=none when no content was ever relayed', () => {
  const line = buildDelegentTimingLine({
    runId: 'run-2',
    startedAt: 10_000,
    firstContentAt: null,
    endedAt: 11_000,
    reason: 'runner_unreachable',
  });
  assert.equal(line, '[delegent-timing] runId=run-2 firstContentMs=none totalMs=1000 reason=runner_unreachable');
});

test('clamps negative deltas to zero (defensive against clock skew)', () => {
  const line = buildDelegentTimingLine({
    runId: 'run-3',
    startedAt: 10_000,
    firstContentAt: 9_000,
    endedAt: 8_000,
    reason: 'completed',
  });
  assert.equal(line, '[delegent-timing] runId=run-3 firstContentMs=0 totalMs=0 reason=completed');
});
