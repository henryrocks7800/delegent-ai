import test from 'node:test';
import assert from 'node:assert/strict';
import { reversalFixture, USER } from './fixtures/stripe-reversal.mjs';

test('a full refund verifies charge, invoice and current subscription before one atomic reversal', async () => {
  const f = reversalFixture();
  assert.equal((await f.run()).status, 200);
  assert.deepEqual(f.calls.map((c) => c.name), ['claim','charge','payments','invoice','target','subscription','apply','ledger']);
  const applied = f.calls.find((c) => c.name === 'apply').detail;
  assert.equal(applied.userId, USER);
  assert.equal(applied.subscriptionId, 'sub-fixture');
  assert.equal(applied.invoiceId, 'in-current');
  assert.equal(applied.chargeId, 'ch-fixture');
  assert.equal(applied.revision, 4);
  assert.equal(applied.retentionSeconds, 60 * 86400);
  assert.equal(f.ledger.get('evt-reversal').status, 'processed');
});
test('a historical subscription or invoice cannot revoke the current paid entitlement', async () => {
  for (const options of [{ target: null }, { subscription: { latest_invoice: 'in-newer-paid-period' } }]) {
    const f = reversalFixture(options);
    assert.equal((await f.run()).status, 200);
    assert.equal(f.calls.filter((c) => c.name === 'apply').length, 0);
    assert.equal(f.ledger.get('evt-reversal').status, 'ignored');
  }
});
test('provider, ownership and atomic-write outages leave the refund retryable', async () => {
  for (const name of ['charge','payments','invoice','target','subscription','apply']) {
    const f = reversalFixture({ failures: [name] });
    assert.equal((await f.run()).status, 500, name);
    assert.equal(f.ledger.get('evt-reversal').status, 'failed', name);
    f.failures.clear();
    assert.equal((await f.run()).status, 200, name);
    assert.equal(f.ledger.get('evt-reversal').status, 'processed', name);
  }
});
test('a partial refund is durably ignored and a processed reversal replay does not repeat provider reads', async () => {
  const partial = reversalFixture();
  assert.equal((await partial.run(partial.event('charge.refunded', { data: { object: { id: 'ch-fixture', refunded: false } } }))).status, 200);
  assert.deepEqual(partial.calls.map((c) => c.name), ['claim','ledger']);
  assert.equal(partial.ledger.get('evt-reversal').status, 'ignored');
  const full = reversalFixture();
  await full.run();
  full.calls.length = 0;
  const response = await full.run();
  assert.equal((await response.json()).duplicate, true);
  assert.deepEqual(full.calls.map((c) => c.name), ['claim']);
});
test('invalid signatures and changed same-id payloads cannot reverse an entitlement', async () => {
  const f = reversalFixture();
  assert.equal((await f.run(f.event(), false)).status, 400);
  assert.equal(f.calls.length, 0);
  await f.run();
  f.calls.length = 0;
  assert.equal((await f.run(f.event('charge.dispute.created'))).status, 409);
  assert.deepEqual(f.calls.map((c) => c.name), ['claim']);
});
test('wrong charge, customer, invoice or local period refuses revocation', async () => {
  for (const options of [{ charge: { id: 'ch-other' } }, { invoice: { customer: 'cus-other' } },
    { invoice: { id: 'in-other' } }, { target: { periodEnd: '2099-01-01T00:00:00Z' } },
    { target: { invoiceId: 'in-upgrade' } }, { subscription: { customer: 'cus-other' } }]) {
    const f = reversalFixture(options);
    assert.equal((await f.run()).status, 500);
    assert.equal(f.calls.filter((c) => c.name === 'apply').length, 0);
  }
});
test('invoice payment pagination is complete and ambiguous allocations request a retry', async () => {
  const f = reversalFixture({ pages(after) { return after ? { has_more: false, data: [{ id: 'inpay-2', invoice: 'in-current',
    status: 'paid', amount_paid: 999, payment: { payment_intent: 'pi-fixture' } }] }
    : { has_more: true, data: [{ id: 'inpay-1', status: 'canceled', payment: { payment_intent: 'pi-fixture' } }] }; } });
  assert.equal((await f.run()).status, 200);
  assert.deepEqual(f.calls.filter((c) => c.name === 'payments').map((c) => c.detail.after), [undefined, 'inpay-1']);
  const ambiguous = reversalFixture({ pages() { return { has_more: false, data: ['in-first','in-second'].map((invoice) => ({
    id: invoice, invoice, amount_paid: 999, status: 'paid', payment: { payment_intent: 'pi-fixture' },
  })) }; } });
  assert.equal((await ambiguous.run()).status, 500);
  assert.equal(ambiguous.calls.filter((c) => c.name === 'apply').length, 0);
});
