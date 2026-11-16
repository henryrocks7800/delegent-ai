import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InboxSortStore } from '../src/inboxSortStore.ts';
import type { SortPlan } from '../src/inboxSortRun.ts';

function store() {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return new InboxSortStore({
    exec: (query, ...values) => db.prepare(query).all(...values),
    transaction: (callback) => {
      if (depth) throw new Error('nested transaction');
      depth++; db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    },
  });
}
const plan = (): SortPlan => ({ provider: 'outlook', mailboxEmail: 'me@example.com', createdAt: 0,
  destinations: [{ key: 'promotions', name: 'Promotions', create: true }], decisions: { 'shop@example.com': 'promotions' },
  counts: { total: 10, keep: 4, senders: 2, byDestination: { promotions: 6 } }, scanned: 10,
  usage: { calls: 2, inputTokens: 500, outputTokens: 50, costUsd: 0.01 }, timings: { censusMs: 1, modelMs: 1, countMs: 0 } });
const summary = { total: 10, toFile: 6, stay: 4, destinations: [{ name: 'Promotions', count: 6, newFolder: true }] };

test('a sort runs plan, one approval, filing and finish; the plan is deleted and the done message is clamped', () => {
  const s = store();
  const record = s.create('outlook', 1_000);
  assert.throws(() => s.create('gmail'), /INBOX_SORT_ACTIVE/, 'one sort at a time');
  s.setWorkflow(record.id, 'wf-1');
  assert.equal(s.savePlan(record.id, plan(), summary, 2_000)?.state, 'awaiting_approval');
  assert.ok(s.plan(record.id));
  const planNotice = s.claimNotice(3_000)!;
  assert.equal(planNotice.notice.outcome, 'plan');
  assert.deepEqual(planNotice.notice.groups, summary.destinations);
  assert.doesNotMatch(JSON.stringify(planNotice.notice), /shop@example\.com/, 'no sender reaches the message');
  s.settleNotice(planNotice.notice.id, planNotice.leaseUntil, true, 3_000);
  assert.equal(s.planDelivered(record.id), true);
  assert.equal(s.approve(record.id, 4_000)?.state, 'filing');
  assert.equal(s.get(record.id)?.filingStartedAt, 4_000, 'the yes records when filing started, for the time-left estimate');
  s.recordMoves(record.id, [{ messageId: 'm1', folderId: 'F' }, { messageId: 'm1', folderId: 'F' }], { moved: 7, skipped: 1, failed: 0 }, 5_000);
  assert.deepEqual(s.journal(record.id), [{ messageId: 'm1', folderId: 'F' }]);
  const done = s.finish(record.id, 'done', undefined, 6_000)!;
  assert.equal(done.state, 'done');
  assert.equal(s.plan(record.id), null, 'sender decisions are deleted when filing ends');
  const doneNotice = s.claimNotice(7_000)!;
  assert.equal(doneNotice.notice.outcome, 'done');
  assert.equal(doneNotice.notice.filed, 6, 'new mail filed from a planned sender does not break the message contract');
  assert.ok(s.create('gmail'), 'a finished sort allows the next one');
});

test('plan model usage is billed once, and a cancelled plan never asks for approval', () => {
  const s = store();
  const record = s.create('gmail');
  s.savePlan(record.id, plan(), summary, Date.now(), 40);
  assert.deepEqual(s.drainUsage(), { calls: 2, inputTokens: 500, outputTokens: 50, costUsd: 0.01, actions: 40 });
  assert.deepEqual(s.drainUsage(), { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, actions: 0 });
  s.finish(record.id, 'cancelled');
  assert.equal(s.claimNotice(), null, 'the undelivered plan message is superseded');
  assert.equal(s.hasPendingNotices(), false);
});

test('an unanswered plan expires after its approval window and approval refuses a stale plan', () => {
  const s = store();
  const record = s.create('outlook', 0);
  s.savePlan(record.id, plan(), summary, 0);
  assert.throws(() => s.approve(record.id, 25 * 3_600_000), /EXPIRED/);
  s.prune(25 * 3_600_000);
  assert.equal(s.get(record.id)?.state, 'cancelled');
  assert.equal(s.plan(record.id), null);
});

test('nothing to file finishes immediately with a done message and keeps no plan', () => {
  const s = store();
  const record = s.create('gmail');
  assert.equal(s.savePlan(record.id, plan(), { total: 4, toFile: 0, stay: 4, destinations: [] })?.state, 'done');
  assert.equal(s.plan(record.id), null);
  assert.equal(s.claimNotice()?.notice.outcome, 'done');
});
