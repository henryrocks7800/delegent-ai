// Defect hunt 2026-09-03: the in-memory per-user rate-limit buckets are bounded.
//
// checkChatRateLimit (and the support-ticket limiter that shares the helper)
// kept one Map entry per distinct user id forever. On a long-lived isolate
// that is a slow leak keyed on whatever subject the bearer carried. Past the
// cap the miss path now drops expired buckets and, if that is not enough,
// starts over. Both outcomes are asserted here, plus the basic limit still
// holding for a single user.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkChatRateLimit,
  _resetChatRateLimitForTests,
  _chatRateLimitBucketCountForTests,
  RATE_LIMIT_BUCKET_CAP,
  CHAT_RATE_LIMIT_PER_USER_PER_MINUTE,
} from '../dist/index.js';

const T0 = 1_700_000_000_000;

test('the per-user limit still holds: the 31st message inside a minute is refused with a retry hint', () => {
  _resetChatRateLimitForTests();
  for (let i = 0; i < CHAT_RATE_LIMIT_PER_USER_PER_MINUTE; i += 1) {
    assert.deepEqual(checkChatRateLimit('user-a', T0 + i), { ok: true });
  }
  const refused = checkChatRateLimit('user-a', T0 + 1000);
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterMs, 60_000 - 1000);
  // the window rolls over and the same user is fine again
  assert.deepEqual(checkChatRateLimit('user-a', T0 + 60_000), { ok: true });
});

test('past the cap, EXPIRED buckets are evicted on the next miss instead of growing forever', () => {
  _resetChatRateLimitForTests();
  const fill = RATE_LIMIT_BUCKET_CAP + 1;
  for (let i = 0; i < fill; i += 1) checkChatRateLimit(`user-${i}`, T0);
  assert.equal(_chatRateLimitBucketCountForTests(), fill, 'the map grows freely up to the cap');
  // A minute later every one of those buckets has expired; the next miss prunes them all.
  assert.deepEqual(checkChatRateLimit('fresh-user', T0 + 60_000), { ok: true });
  assert.equal(_chatRateLimitBucketCountForTests(), 1, 'only the fresh bucket remains');
});

test('past the cap with nothing expired, the map is cleared rather than left to grow (lenient, never stricter)', () => {
  _resetChatRateLimitForTests();
  const fill = RATE_LIMIT_BUCKET_CAP + 1;
  for (let i = 0; i < fill; i += 1) checkChatRateLimit(`user-${i}`, T0);
  assert.deepEqual(checkChatRateLimit('fresh-user', T0 + 30_000), { ok: true });
  assert.equal(_chatRateLimitBucketCountForTests(), 1, 'a full clear is the last resort');
  // A user wiped by the clear gets a fresh window, which is the harmless direction.
  assert.deepEqual(checkChatRateLimit('user-0', T0 + 30_001), { ok: true });
});

test('under the cap nothing is pruned, so a live bucket is never wiped by an unrelated user', () => {
  _resetChatRateLimitForTests();
  for (let i = 0; i < CHAT_RATE_LIMIT_PER_USER_PER_MINUTE; i += 1) checkChatRateLimit('busy-user', T0);
  for (let i = 0; i < 500; i += 1) checkChatRateLimit(`other-${i}`, T0 + 60_000);
  assert.equal(checkChatRateLimit('busy-user', T0 + 5_000).ok, false, 'busy user still limited inside its window');
  assert.equal(_chatRateLimitBucketCountForTests(), 501);
});
