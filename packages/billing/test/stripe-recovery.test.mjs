import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStripeSubscriptionByEmail } from '../dist/stripeRecovery.js';

const userId = '11111111-1111-4111-8111-111111111111';
const customer = { id: 'cus_owned', metadata: { sidekickUserId: userId } };
const subscription = { id: 'sub_owned', status: 'active', metadata: { sidekickUserId: userId, tierId: 'studio' },
  items: { data: [{ price: { id: 'price_studio' }, current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 }] } };
const page = (data, has_more = false) => ({ data, has_more });

function fixture(customers, subscriptions) {
  const writes = [], reads = [];
  return { writes, reads, run: () => reconcileStripeSubscriptionByEmail({}, { userId, email: 'fixture@example.test' }, {
    stripe: {
      customers: { list: async input => { reads.push(['customers', input]); return customers(input); } },
      subscriptions: { list: async input => { reads.push(['subscriptions', input]); return subscriptions(input); } },
    },
    store: { applyEntitlement: async input => { writes.push(input); return { outcome: 'applied', resumed: false }; } },
  }) };
}

test('recovery finds an owned subscription after both customer and subscription pagination', async () => {
  const f = fixture(input => input.starting_after ? page([customer]) : page([{ id: 'cus_unrelated' }], true),
    input => input.customer === 'cus_unrelated' ? page([])
      : input.starting_after ? page([subscription]) : page([{ id: 'sub_old', status: 'canceled' }], true));
  const result = await f.run();
  assert.equal(result.stripeSubscriptionId, subscription.id);
  assert.equal(f.writes.length, 1);
  assert.ok(f.reads.some(([kind, input]) => kind === 'customers' && input.starting_after === 'cus_unrelated'));
  assert.ok(f.reads.some(([kind, input]) => kind === 'subscriptions' && input.starting_after === 'sub_old'));
});

test('a later provider page failing after a candidate never writes or claims absence', async () => {
  const f = fixture(() => page([customer]), input => {
    if (!input.starting_after) return page([subscription], true);
    throw new Error('later page unavailable');
  });
  await assert.rejects(f.run, /later page unavailable/);
  assert.equal(f.writes.length, 0);
});

test('multiple matching active subscriptions require reconciliation instead of picking the first', async () => {
  const f = fixture(() => page([customer]), () => page([subscription, { ...subscription, id: 'sub_duplicate' }]));
  await assert.rejects(f.run, /multiple_subscriptions/);
  assert.equal(f.writes.length, 0);
});

test('unknown, malformed and repeating inventories never authorize a fresh checkout', async () => {
  for (const invalid of [{}, { data: [] }, { data: [], has_more: true }, page([null]), page([{ id: '' }]),
    page([customer, customer]), page([{ id: 'cus_repeat' }], true)]) {
    const f = fixture(() => invalid, () => page([]));
    await assert.rejects(f.run, /inventory_/);
    assert.equal(f.writes.length, 0);
  }
});

test('subscription metadata cannot be overridden by the customer ownership fallback', async () => {
  const f = fixture(() => page([customer]), () => page([{ ...subscription,
    metadata: { ...subscription.metadata, sidekickUserId: 'different-account' } }]));
  assert.equal(await f.run(), null);
  assert.equal(f.writes.length, 0);
});

test('an owned active subscription with unknown tier or malformed billing items blocks checkout', async () => {
  for (const patch of [{ metadata: { sidekickUserId: userId, tierId: 'unknown' } }, { status: null },
    { items: { data: [] } }, { items: { data: [subscription.items.data[0], subscription.items.data[0]] } }]) {
    const f = fixture(() => page([customer]), () => page([{ ...subscription, ...patch }]));
    await assert.rejects(f.run, /stripe_recovery_/);
    assert.equal(f.writes.length, 0);
  }
});
