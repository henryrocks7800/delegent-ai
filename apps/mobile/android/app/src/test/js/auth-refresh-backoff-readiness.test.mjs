import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-contract test for the auth refresh-storm guard (GO_LIVE_TRACKER #16).
// supabaseClient.ts imports native modules (expo-secure-store) so we assert on
// source text, matching the other readiness suites. Guards: concurrent refreshes
// are coalesced into one in-flight call; failures back off (capped); a
// permanently-invalid refresh token stops retrying AND clears the session — so
// the app can never storm Supabase /token (the documented 2026-06-07 incident,
// which collaterally rate-limited sign-in for other users on the shared IP).
const src = readFileSync(new URL('../../../../../src/auth/supabaseClient.ts', import.meta.url), 'utf8');

test('concurrent refreshes are coalesced into a single in-flight call', () => {
  assert.match(src, /let inFlightRefresh/);
  assert.match(src, /if \(inFlightRefresh\) return inFlightRefresh/);
});

test('refresh failures back off, and the cooldown is checked before hitting /token', () => {
  assert.match(src, /function noteRefreshFailure/);
  assert.match(src, /REFRESH_BACKOFF_MAX_MS/);
  assert.match(src, /if \(Date\.now\(\) < refreshCooldownUntilMs\)/);
});

test('a permanently-invalid refresh token stops retrying and clears the session', () => {
  assert.match(src, /function isInvalidRefreshError/);
  assert.match(src, /invalid_grant/);
  assert.match(src, /refresh_token_not_found/);
  assert.match(src, /isInvalidRefreshError[\s\S]*?REFRESH_INVALID_COOLDOWN_MS[\s\S]*?clearLocalMobileSupabaseSession/);
});

test('there is exactly ONE refreshSession() call site, and it lives inside the guard', () => {
  assert.match(src, /refreshMobileSessionGuarded\(client\)/);
  const refreshCalls = src.match(/auth\.refreshSession\(/g) || [];
  assert.equal(refreshCalls.length, 1, 'exactly one auth.refreshSession() call (inside refreshMobileSessionGuarded)');
});

test('a valid session clears the backoff so a re-sign-in is not blocked by a stale cooldown', () => {
  assert.match(src, /rememberMobileSupabaseSession[\s\S]*?refreshCooldownUntilMs = 0/);
});
