// The four things a plan change can end in that are not a Stripe page, and the
// words each one gets.
//
// All four were written twice, once per surface, and three had drifted: the
// phone said "Please free up space ... switching to", the browser said "Free up
// space ... moving to"; the phone said "You keep everything until then", the
// browser "You keep everything you have until then". Cosmetic, but the fourth
// was not. `billing_subscription_required` is returned to someone who HAS a
// Stripe customer and whose subscription record has not caught up. The browser
// folded it in with `billing_customer_required` and told them "There is no
// billing account yet. Pick a plan first." — untrue, and it sends a paying
// reader to the plan picker, whose only offer is the plan they already have.
//
// These assert the copy itself. surface-parity.test.mjs separately holds that
// both surfaces read it from here rather than keeping a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_CUSTOMER_REQUIRED_MESSAGE,
  BILLING_SUBSCRIPTION_SYNCING_MESSAGE,
  downgradeScheduledMessage,
  formatStorageGb,
  friendlyBillingDate,
  storageDowngradeBlockBody,
} from '../dist/index.js';

test('a refusal for no billing account and one for a subscription still syncing are not the same sentence', () => {
  assert.notEqual(BILLING_CUSTOMER_REQUIRED_MESSAGE, BILLING_SUBSCRIPTION_SYNCING_MESSAGE);
  // The reader with no customer record is the only one who should be sent to
  // pick a plan. Telling the other one to do that is the bug this pins.
  assert.match(BILLING_CUSTOMER_REQUIRED_MESSAGE, /plan first/i);
  assert.doesNotMatch(BILLING_SUBSCRIPTION_SYNCING_MESSAGE, /plan first|no billing account/i);
  assert.match(BILLING_SUBSCRIPTION_SYNCING_MESSAGE, /sync/i);
});

test('a byte count reads as a size a person would say out loud', () => {
  assert.equal(formatStorageGb(80 * 1024 ** 3), '80 GB');
  assert.equal(formatStorageGb(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(formatStorageGb(0), '0 GB');
  // Ten and over loses the decimal, because at that size it is noise.
  assert.equal(formatStorageGb(10.4 * 1024 ** 3), '10 GB');
  for (const bad of [null, undefined, '5', Number.NaN, Infinity, -1]) {
    assert.equal(formatStorageGb(bad), null, `${String(bad)} is not a size`);
  }
});

test('a renewal date is the same date wherever the reader is standing', () => {
  assert.equal(friendlyBillingDate('2026-08-07T00:30:00.000Z'), '7 August 2026');
  // 23:30 UTC is already tomorrow in Sydney. It is still the 7th on the invoice,
  // so it has to still be the 7th on screen.
  assert.equal(friendlyBillingDate('2026-08-07T23:30:00.000Z'), '7 August 2026');
  assert.equal(friendlyBillingDate('2026-12-31T12:00:00.000Z'), '31 December 2026');
  for (const bad of [null, undefined, '', '   ', 'next tuesday', 42]) {
    assert.equal(friendlyBillingDate(bad), null, `${String(bad)} is not a date`);
  }
});

test('a blocked downgrade says what is stored, what fits, and that nothing is deleted', () => {
  const message = storageDowngradeBlockBody({
    targetTierShortName: 'Pro',
    currentStorageBytes: 42 * 1024 ** 3,
    targetStorageBytes: 20 * 1024 ** 3,
  });
  assert.equal(
    message,
    "You're using 42 GB. Pro includes 20 GB. Free up space in Files before switching to Pro. We never delete your files.",
  );
  // The reassurance is the load-bearing half: someone told their files will not
  // fit needs to know that pressing on will not lose any of them.
  assert.match(message, /We never delete your files\.$/);
  // And it must not read as a failure to open anything, which invites a retry
  // that can never clear it. The answer is in Files.
  assert.doesNotMatch(message, /try again|couldn't|could not|went wrong/i);
});

test('a blocked downgrade still reads when the server sends no figures', () => {
  const message = storageDowngradeBlockBody({
    targetTierShortName: null,
    currentStorageBytes: null,
    targetStorageBytes: undefined,
  });
  assert.equal(message, 'Free up space in Files before switching to the smaller plan. We never delete your files.');
  assert.doesNotMatch(message, /null|undefined|NaN/);
});

test('a booked downgrade names the plan, names the day, and promises nothing goes today', () => {
  assert.equal(
    downgradeScheduledMessage({ targetTierShortName: 'Studio', effectiveAt: '2026-08-07T00:30:00.000Z' }),
    'Your plan changes to Studio on 7 August 2026. You keep everything you have until then.',
  );
  // No date is the only case where "at your next renewal" is honest.
  assert.equal(
    downgradeScheduledMessage({ targetTierShortName: 'Studio', effectiveAt: null }),
    'Your plan changes to Studio at your next renewal. You keep everything you have until then.',
  );
  assert.equal(
    downgradeScheduledMessage({ targetTierShortName: null, effectiveAt: 'not a date' }),
    'Your plan changes to your new plan at your next renewal. You keep everything you have until then.',
  );
});

test('none of the billing outcome copy uses an em dash', () => {
  const all = [
    BILLING_CUSTOMER_REQUIRED_MESSAGE,
    BILLING_SUBSCRIPTION_SYNCING_MESSAGE,
    storageDowngradeBlockBody({ targetTierShortName: 'Pro', currentStorageBytes: 1024 ** 3, targetStorageBytes: 0 }),
    downgradeScheduledMessage({ targetTierShortName: 'Pro', effectiveAt: '2026-08-07T00:00:00.000Z' }),
  ];
  for (const line of all) assert.doesNotMatch(line, /—/, `em dash in: ${line}`);
});
