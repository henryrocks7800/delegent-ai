import test from 'node:test';
import assert from 'node:assert/strict';
import { reversalFixture } from './fixtures/stripe-reversal.mjs';

test('the real Dispute shape resolves its charge without a top-level customer', async () => {
  const f = reversalFixture();
  const response = await f.run(f.event('charge.dispute.created'));
  assert.equal(response.status, 200);
  assert.equal(f.calls.find((c) => c.name === 'charge').detail, 'ch-fixture');
  assert.equal(f.calls.find((c) => c.name === 'apply').detail.reason, 'dispute');
  assert.equal(f.ledger.get('evt-reversal').status, 'processed');
});
test('a dispute for an older paid invoice cannot suspend a newer payment', async () => {
  const f = reversalFixture({ subscription: { latest_invoice: 'in-new-paid' } });
  assert.equal((await f.run(f.event('charge.dispute.created'))).status, 200);
  assert.equal(f.calls.filter((c) => c.name === 'apply').length, 0);
  assert.equal(f.ledger.get('evt-reversal').status, 'ignored');
});
test('a delayed creation event cannot revoke service after the dispute was already won or prevented', async () => {
  for (const status of ['won','prevented','warning_closed']) {
    const f = reversalFixture({ dispute: { status } });
    assert.equal((await f.run(f.event('charge.dispute.created'))).status, 200);
    assert.deepEqual(f.calls.map((c) => c.name), ['claim','dispute','ledger']);
    assert.equal(f.ledger.get('evt-reversal').error_code, 'ignored_closed_dispute');
  }
});
test('a failed current-dispute lookup leaves its event retryable', async () => {
  const f = reversalFixture({ failures: ['dispute'] });
  assert.equal((await f.run(f.event('charge.dispute.created'))).status, 500);
  assert.equal(f.ledger.get('evt-reversal').status, 'failed');
});
test('a failed dispute write is not acknowledged and a replay can finish it', async () => {
  const f = reversalFixture({ failures: ['apply'] });
  const event = f.event('charge.dispute.created');
  assert.equal((await f.run(event)).status, 500);
  assert.equal(f.ledger.get('evt-reversal').status, 'failed');
  f.failures.clear();
  assert.equal((await f.run(event)).status, 200);
});
test('missing dispute identifiers fail durably rather than claiming no customer', async () => {
  const f = reversalFixture();
  assert.equal((await f.run(f.event('charge.dispute.created', { data: { object: {} } }))).status, 500);
  assert.equal(f.ledger.get('evt-reversal').status, 'failed');
});
test('the configured retention window reaches the atomic dispute transaction', async () => {
  const f = reversalFixture({ env: { SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '14' } });
  await f.run(f.event('charge.dispute.created'));
  assert.equal(f.calls.find((c) => c.name === 'apply').detail.retentionSeconds, 14 * 86400);
});
test('stripeServerEnvFromWorker passes the retention window through to the shared flow', async () => {
  const { stripeServerEnvFromWorker } = await import('../dist/stripe.js');
  const { resolveSeries4SuspendRetentionSeconds } = await import('../dist/stripe-flow.js');
  assert.equal(resolveSeries4SuspendRetentionSeconds(stripeServerEnvFromWorker({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: ' 45 ' })), 45 * 86400);
  assert.equal(resolveSeries4SuspendRetentionSeconds(stripeServerEnvFromWorker({})), 60 * 86400);
});
