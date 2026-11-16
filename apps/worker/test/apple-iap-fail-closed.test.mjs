// Apple entitlement must FAIL CLOSED when Apple cannot be reached.
//
// THE DEFECT THIS PINS. verifyAndRecordApplePurchase re-fetches the
// subscription state after fetching the transaction. When that second call
// failed, the status was computed as:
//
//     info.revocationDate ? 'canceled' : 'active'
//
// which grants `active` on an error. A transaction record is PERMANENT: Apple
// keeps answering for it long after the subscription behind it lapsed. So an
// expired customer could tap Restore, have the transaction lookup succeed, have
// the subscription lookup fail on a transient 500 or on the known Production
// 401, and be handed a live entitlement on the strength of an old receipt.
//
// Every other refusal in apple-iap.ts fails closed. That one line did not, and
// it sat directly on the money path.
//
// statusFromTransactionAlone replaces it: expiry is the authority, because it
// is the end of the period Apple actually charged for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { statusFromTransactionAlone, appleStatusToSubscriptionStatus } from '../dist/apple-iap.js';

const NOW = Date.parse('2026-08-26T12:00:00Z');
const HOUR = 3600_000;

test('an expired subscription is NOT granted when Apple cannot be reached', () => {
  assert.equal(
    statusFromTransactionAlone({ revocationDate: null, expiresDate: NOW - HOUR }, NOW),
    'canceled',
    'a receipt whose period ended must never read as active',
  );
});

test('a still-valid subscription is granted when Apple cannot be reached', () => {
  assert.equal(
    statusFromTransactionAlone({ revocationDate: null, expiresDate: NOW + HOUR }, NOW),
    'active',
    'a customer inside the period they paid for must not lose service to an Apple outage',
  );
});

test('a revoked transaction is never active, even if its expiry is in the future', () => {
  assert.equal(
    statusFromTransactionAlone({ revocationDate: NOW - HOUR, expiresDate: NOW + HOUR }, NOW),
    'canceled',
    'revocation beats expiry: Apple took the money back',
  );
});

test('a transaction with no expiry is not vouched for', () => {
  assert.equal(
    statusFromTransactionAlone({ revocationDate: null, expiresDate: null }, NOW),
    'canceled',
    'no expiry means nothing to verify against, so it cannot fail open',
  );
});

test('the exact boundary does not grant a free instant', () => {
  assert.equal(
    statusFromTransactionAlone({ revocationDate: null, expiresDate: NOW }, NOW),
    'canceled',
  );
});

test("Apple's own status codes still map correctly", () => {
  assert.equal(appleStatusToSubscriptionStatus(1), 'active');    // active
  assert.equal(appleStatusToSubscriptionStatus(2), 'canceled');  // expired
  assert.equal(appleStatusToSubscriptionStatus(3), 'past_due');  // billing retry
  assert.equal(appleStatusToSubscriptionStatus(4), 'active');    // grace period
  assert.equal(appleStatusToSubscriptionStatus(5), 'canceled');  // revoked
});

test('the fail-open expression is gone from source', () => {
  // A unit test on the helper cannot prove the CALLER stopped failing open,
  // and the caller is where the bug lived. Pin it in source.
  const src = readFileSync(new URL('../src/apple-iap.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src,
    /revocationDate\s*\?\s*'canceled'\s*as\s*const\s*:\s*'active'\s*as\s*const/,
    'the old fail-open fallback has come back',
  );
});

test('the notification environment is not taken straight from the payload', () => {
  const src = readFileSync(new URL('../src/apple-iap.ts', import.meta.url), 'utf8');
  // The old line trusted forgeable input to pick which Apple host to ask.
  assert.doesNotMatch(
    src,
    /const environment: AppleEnvironment = payload\.data\?\.environment === 'Production'/,
    'unverified payload is steering the Apple host again',
  );
  // It may only reorder OUR configured list.
  assert.match(src, /const candidates = configuredEnvironments\(env\)/);
});
