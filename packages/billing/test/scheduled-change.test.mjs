import test from 'node:test';
import assert from 'node:assert/strict';
import { requireScheduledChangeConfirmation, ScheduledChangeConfirmationRequired, ScheduledChangeChanged } from '../dist/scheduledChange.js';
import { releaseScheduledDowngrade } from '../dist/index.js';

const scope = { secretKey: 'fixture_only_secret', userId: 'user_A', subscriptionId: 'sub_A', scheduleId: 'sub_sched_A',
  currentPriceId: 'price_studio', targetTierId: 'pro-office', returnUrl: 'https://fixture.test/billing', now: 1_800_000_000_000 };
async function challenge() {
  try { await requireScheduledChangeConfirmation(scope); }
  catch (error) {
    assert.ok(error instanceof ScheduledChangeConfirmationRequired);
    return error.confirmation;
  }
  assert.fail('unconfirmed schedule removal must request confirmation');
}

test('schedule acknowledgement is opaque, time limited and bound to the authenticated action', async () => {
  const confirmation = await challenge();
  assert.equal(confirmation.expiresAt, scope.now / 1000 + 300);
  assert.match(confirmation.token, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(confirmation), /fixture_only_secret|user_A|sub_A|sub_sched_A|price_studio/);
  await requireScheduledChangeConfirmation({ ...scope, provided: confirmation });
  for (const change of [{ userId: 'user_B' }, { subscriptionId: 'sub_B' }, { scheduleId: 'sub_sched_B' },
    { scheduleId: null }, { currentPriceId: 'price_pro' }, { targetTierId: 'enterprise-suite' },
    { returnUrl: 'https://fixture.test/elsewhere' }, { secretKey: 'rotated_fixture' }, { now: scope.now + 300_000 }]) {
    await assert.rejects(() => requireScheduledChangeConfirmation({ ...scope, ...change, provided: confirmation }), ScheduledChangeChanged);
  }
  for (const invalid of [true, {}, { ...confirmation, token: '0'.repeat(64) },
    { ...confirmation, expiresAt: confirmation.expiresAt + 1 }, { ...confirmation, expiresAt: 0 },
    { ...confirmation, expiresAt: 'future' }]) {
    await assert.rejects(() => requireScheduledChangeConfirmation({ ...scope, provided: invalid }), ScheduledChangeChanged);
  }
  await requireScheduledChangeConfirmation({ ...scope, scheduleId: null });
});

test('schedule release requires an adapter and the matching released provider response', async () => {
  await assert.rejects(() => releaseScheduledDowngrade('sub_sched_A', {}), /release unavailable/);
  for (const response of [undefined, {}, { id: 'sub_sched_B', status: 'released' }, { id: 'sub_sched_A', status: 'active' }]) {
    await assert.rejects(() => releaseScheduledDowngrade('sub_sched_A', { subscriptionSchedules: { release: async () => response } }), /release not verified/);
  }
  await releaseScheduledDowngrade('sub_sched_A', { subscriptionSchedules: { release: async () => ({ id: 'sub_sched_A', status: 'released' }) } });
});
