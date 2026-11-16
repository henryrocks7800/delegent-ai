// The placeholder transaction id that killed half of our first real purchases.
//
// THE EVIDENCE. Six Apple purchase attempts had ever been recorded when this
// was found on 2026-08-27. Three of them failed, all identically:
//
//   2026-08-20 09:09:56  tx 000000000000000  apple_api_error  applied=false
//   2026-08-20 09:14:16  tx 2000001224293610 applied          applied=true
//   2026-08-20 12:47:09  tx 000000000000000  apple_api_error  applied=false
//   2026-08-20 12:47:10  tx 000000000000000  apple_api_error  applied=false
//   2026-08-24 15:04:50  tx 2000001226091677 applied          applied=true   <- App Review
//   2026-08-26 09:15:24  tx 2000001227131326 applied          applied=true
//
// StoreKit emits an interim purchase event whose transactionId is a string of
// zeros while the transaction is still settling, then emits the real one. The
// app settled on the first event, sent the zeros to the Worker, the Worker
// asked Apple, and Apple refused. The customer had paid and was left looking at
// "Confirming subscription...".
//
// This is the guard. It is deliberately a predicate over the id alone, with no
// StoreKit or network in sight, so it can be tested exhaustively.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isUsableAppleTransactionId } from '../dist/index.js';

test('the exact placeholder ids that failed in production are refused', () => {
  // Verbatim from apple_iap_events.
  assert.equal(isUsableAppleTransactionId('000000000000000'), false);
});

test('zeros are refused at any length, because the length is not ours to rely on', () => {
  for (const zeros of ['0', '00', '0000000000', '000000000000000', '0'.repeat(32)]) {
    assert.equal(isUsableAppleTransactionId(zeros), false, `${zeros} should be refused`);
  }
});

test('the real transaction ids that DID work are accepted', () => {
  // Also verbatim from apple_iap_events, including App Review's own purchase.
  for (const id of ['2000001224293610', '2000001226091677', '2000001227131326']) {
    assert.equal(isUsableAppleTransactionId(id), true, `${id} should be accepted`);
  }
});

test('an id is not rejected merely for containing zeros', () => {
  // The failure mode of a naive /0/ test: every one of the ids above contains
  // zeros, and two of them start with one.
  assert.equal(isUsableAppleTransactionId('2000001226091677'), true);
  assert.equal(isUsableAppleTransactionId('0000000000000001'), true);
  assert.equal(isUsableAppleTransactionId('1000000000000000'), true);
});

test('absent, empty and non-string values are refused rather than stringified', () => {
  for (const value of [null, undefined, '', '   ', {}, [], true, false, NaN]) {
    assert.equal(
      isUsableAppleTransactionId(value), false,
      `${JSON.stringify(value) ?? String(value)} should be refused`,
    );
  }
});

test('surrounding whitespace does not make a placeholder look real', () => {
  assert.equal(isUsableAppleTransactionId('  000000000000000  '), false);
  assert.equal(isUsableAppleTransactionId('  2000001226091677  '), true);
});

test('a numeric id is accepted, since StoreKit is not required to hand us a string', () => {
  assert.equal(isUsableAppleTransactionId(2000001226091677), true);
  assert.equal(isUsableAppleTransactionId(0), false);
});
