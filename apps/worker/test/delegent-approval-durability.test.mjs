// Approval-card durability (2026-07-03 live incident). A dangerous-command
// card relayed while the app's SSE was dropped used to vanish (queue-only
// delivery), so the exec gate timed out silently after 300s and long build
// tasks looked hung. The runner now persists + replays the card, which means
// the SAME approval_id can reach the translator more than once (live frame,
// stream-reopen replay, reconcile re-emit). These tests lock the Worker-side
// halves: translator emit-once semantics and record parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegentTranslator, parseDelegentPendingApproval } from '../dist/index.js';

test('translator renders an approval card once per approval_id (replays are silent)', () => {
  const t = createDelegentTranslator('run-1');
  const frame = {
    kind: 'approval',
    approval_id: 'u1:7',
    command: 'pip install flask',
    description: 'install packages',
    choices: ['once', 'session', 'always', 'deny'],
  };
  const first = t.push(frame);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'assistant.approval.requested');
  assert.equal(first[0].payload.approvalId, 'u1:7');
  assert.deepEqual(first[0].payload.choices, ['once', 'session', 'always', 'deny']);
  // Replayed card (stream reconnect / reconcile) — must not render twice.
  assert.deepEqual(t.push(frame), []);
  // A DIFFERENT gate still renders.
  const second = t.push({ ...frame, approval_id: 'u1:8' });
  assert.equal(second.length, 1);
  assert.equal(second[0].payload.approvalId, 'u1:8');
});

test('translator does not dedupe cards lacking an approval_id (cannot correlate)', () => {
  const t = createDelegentTranslator('run-2');
  const frame = { kind: 'approval', command: 'x', description: 'y' };
  assert.equal(t.push(frame).length, 1);
  assert.equal(t.push(frame).length, 1);
});

test('parseDelegentPendingApproval parses a valid record field', () => {
  const parsed = parseDelegentPendingApproval({
    approval_id: 'u1:9',
    command: 'python seed.py',
    description: 'seed database',
    choices: ['once', 'deny'],
  });
  assert.deepEqual(parsed, {
    approvalId: 'u1:9',
    command: 'python seed.py',
    description: 'seed database',
    choices: ['once', 'deny'],
  });
});

test('parseDelegentPendingApproval rejects malformed values', () => {
  assert.equal(parseDelegentPendingApproval(null), null);
  assert.equal(parseDelegentPendingApproval('nope'), null);
  assert.equal(parseDelegentPendingApproval({}), null); // no approval_id
  assert.equal(parseDelegentPendingApproval({ approval_id: '   ' }), null);
});

test('parseDelegentPendingApproval defaults description and choices', () => {
  const parsed = parseDelegentPendingApproval({ approval_id: 'a:1' });
  assert.equal(parsed.description, 'dangerous command');
  assert.deepEqual(parsed.choices, ['once', 'session', 'always', 'deny']);
});
