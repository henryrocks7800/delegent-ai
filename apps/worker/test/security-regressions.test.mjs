// Security regression tests for the Cloudflare Worker.
//
// Each test in this file maps to a specific finding from the read-only
// security audit and is intended to fail loudly if the regression returns.
// Keep these passing as the Worker evolves.
//
// IMPORTANT: imports come from `../dist/index.js`. Run via `npm test`
// (which executes `npm run build` first), never via `node --test` alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  MAX_REQUEST_CONTENT_BYTES,
  MAX_REQUEST_MESSAGES,
  RUNNER_AUTH_MAX_SKEW_SECONDS,
  RUNNER_AUTH_VERSION,
  SIDEKICK_WORKER_SECURITY_HEADERS,
  applySecurityHeaders,
  buildOpenRouterPayload,
  parseUsageSnapshotTotalTokens,
  requireSidekickRunnerAuth,
  signRunnerTokenV1,
  timingSafeEqualBytes,
  verifyRunnerTokenV1,
} from '../dist/index.js';

const SECRET = 'runner_secret_under_test';

// ---------------------------------------------------------------------------
// Audit #1: timing-unsafe runner-token compare
// ---------------------------------------------------------------------------

test('Audit #1 — runner token comparison rejects bytewise mismatches without short-circuiting (timingSafeEqualBytes)', () => {
  // The function must return false on length mismatch and on any byte mismatch,
  // never throw, and never short-circuit (covered by the constant-time invariant
  // in the implementation). Here we cover all branches.
  assert.equal(timingSafeEqualBytes(new Uint8Array(), new Uint8Array()), true);
  assert.equal(timingSafeEqualBytes(new Uint8Array([0]), new Uint8Array([0])), true);
  assert.equal(timingSafeEqualBytes(new Uint8Array([0]), new Uint8Array([1])), false);
  assert.equal(timingSafeEqualBytes(new Uint8Array([0]), new Uint8Array([0, 0])), false);
  assert.equal(timingSafeEqualBytes(new Uint8Array([0xff, 0xff]), new Uint8Array([0xff, 0xfe])), false);
});

// ---------------------------------------------------------------------------
// Audit #2: runner secret bound per-user-and-window
// ---------------------------------------------------------------------------

test('Audit #2 — v1 runner token is rejected when presented as a different user', async () => {
  const now = new Date('2026-05-05T12:00:00Z');
  const ts = Math.floor(now.getTime() / 1000);
  const tokenForA = await signRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', ts);

  // Same token, different userId -> rejected.
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'b0000000-bbb0-4bbb-8bbb-00000000000b',
    'x-sidekick-runner-timestamp': String(ts),
    'x-sidekick-runner-token': tokenForA,
  }), { SIDEKICK_RUNNER_SHARED_SECRET: SECRET }, now), /valid Sidekick runner token required/);
});

test('Audit #2 — v1 runner token expires after RUNNER_AUTH_MAX_SKEW_SECONDS', async () => {
  const t0 = new Date('2026-05-05T12:00:00Z');
  const ts = Math.floor(t0.getTime() / 1000);
  const token = await signRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', ts);
  // #30 — global-V1 is now LEGACY-gated (per-user is primary); this skew test
  // exercises the global secret, so enable the legacy flag.
  const env = { SIDEKICK_RUNNER_SHARED_SECRET: SECRET, SIDEKICK_RUNNER_AUTH_LEGACY: 'true' };

  // Within the window -> ok.
  assert.equal(await requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-timestamp': String(ts),
    'x-sidekick-runner-token': token,
  }), env, t0), 'a0000000-aaa0-4aaa-8aaa-00000000000a');

  // Just outside the window in the future -> rejected.
  const tFuture = new Date(t0.getTime() + (RUNNER_AUTH_MAX_SKEW_SECONDS + 1) * 1000);
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-timestamp': String(ts),
    'x-sidekick-runner-token': token,
  }), env, tFuture), /valid Sidekick runner token required/);

  // Just outside the window in the past -> rejected.
  const tPast = new Date(t0.getTime() - (RUNNER_AUTH_MAX_SKEW_SECONDS + 1) * 1000);
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-timestamp': String(ts),
    'x-sidekick-runner-token': token,
  }), env, tPast), /valid Sidekick runner token required/);
});

test('Audit #2 — v1 token format requires the v1. prefix and well-formed hex', async () => {
  assert.equal(await verifyRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', 1, 'no-prefix.deadbeef'), false);
  assert.equal(await verifyRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', 1, 'v1.zzzz'), false); // not hex
  assert.equal(await verifyRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', 1, 'v1.abc'), false);  // odd length
  assert.equal(await verifyRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', 1, 'v1.'), false);     // empty hex

  let malformedEquivalent = null;
  for (let timestamp = 1; timestamp < 1000 && !malformedEquivalent; timestamp += 1) {
    const valid = await signRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', timestamp);
    const hex = valid.slice('v1.'.length);
    for (let index = 0; index < hex.length; index += 2) {
      const pair = hex.slice(index, index + 2);
      if (pair.startsWith('0')) {
        malformedEquivalent = {
          timestamp,
          token: `v1.${hex.slice(0, index)}${pair[1]}g${hex.slice(index + 2)}`,
        };
        break;
      }
    }
  }
  assert.ok(malformedEquivalent, 'test setup should find a low-byte signature pair');
  assert.equal(await verifyRunnerTokenV1(SECRET, 'a0000000-aaa0-4aaa-8aaa-00000000000a', malformedEquivalent.timestamp, malformedEquivalent.token), false);
});

test('Audit #2 — v1 wire format constants (RUNNER_AUTH_VERSION) are exported as `v1`', () => {
  assert.equal(RUNNER_AUTH_VERSION, 'v1');
});

// ---------------------------------------------------------------------------
// Audit #2 — legacy fallback only when explicitly enabled
// ---------------------------------------------------------------------------

test('Audit #2 — legacy unsigned token is rejected when SIDEKICK_RUNNER_AUTH_LEGACY is unset', async () => {
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-token': SECRET,
  }), { SIDEKICK_RUNNER_SHARED_SECRET: SECRET }), /valid Sidekick runner token required/);
});

test('Audit #2 — legacy unsigned token is accepted only when SIDEKICK_RUNNER_AUTH_LEGACY=true and matches', async () => {
  // Correct legacy secret -> accepted.
  assert.equal(await requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-token': SECRET,
  }), { SIDEKICK_RUNNER_SHARED_SECRET: SECRET, SIDEKICK_RUNNER_AUTH_LEGACY: 'true' }), 'a0000000-aaa0-4aaa-8aaa-00000000000a');

  // Wrong legacy secret -> rejected (constant-time compare).
  await assert.rejects(() => requireSidekickRunnerAuth(new Headers({
    'x-sidekick-user-id': 'a0000000-aaa0-4aaa-8aaa-00000000000a',
    'x-sidekick-runner-token': 'wrong_secret',
  }), { SIDEKICK_RUNNER_SHARED_SECRET: SECRET, SIDEKICK_RUNNER_AUTH_LEGACY: 'true' }), /valid Sidekick runner token required/);
});

// ---------------------------------------------------------------------------
// Audit #13: oversized requests are rejected before quota & model fetch
// ---------------------------------------------------------------------------

test('Audit #13 — buildOpenRouterPayload rejects an oversized message array', () => {
  const tooMany = Array.from({ length: MAX_REQUEST_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }));
  assert.throws(() => buildOpenRouterPayload({ messages: tooMany }), /messages array too large/);
});

test('Audit #13 — buildOpenRouterPayload rejects oversized total content', () => {
  assert.throws(
    () => buildOpenRouterPayload({ messages: [{ role: 'user', content: 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1024) }] }),
    /messages content too large/,
  );
});

// ---------------------------------------------------------------------------
// Audit #14: malformed usage rows are skipped, not fail-closed
// ---------------------------------------------------------------------------

test('Audit #14 — parseUsageSnapshotTotalTokens returns null for malformed rows and an integer for valid ones', () => {
  assert.equal(parseUsageSnapshotTotalTokens(null), null);
  assert.equal(parseUsageSnapshotTotalTokens('not-a-row'), null);
  assert.equal(parseUsageSnapshotTotalTokens({}), null);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: -1 }), null);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: 1.5 }), null);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: 'NaN' }), null);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: 0 }), 0);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: 100 }), 100);
  assert.equal(parseUsageSnapshotTotalTokens({ total_tokens: ' 25 ' }), 25);
});

// ---------------------------------------------------------------------------
// Audit #18: security headers on every response
// ---------------------------------------------------------------------------

test('Audit #18 — applySecurityHeaders adds HSTS, nosniff, frame-deny, and a default-deny CSP', () => {
  const base = new Response('', { status: 200 });
  const wrapped = applySecurityHeaders(base);

  for (const [name, value] of Object.entries(SIDEKICK_WORKER_SECURITY_HEADERS)) {
    assert.equal(wrapped.headers.get(name), value, `missing security header: ${name}`);
  }
  assert.equal(wrapped.headers.get('vary'), 'Origin');
});

test('Audit #18 — every Worker entry path returns security headers', async () => {
  const env = {
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: SECRET,
  };

  // /health
  const health = await worker.fetch(new Request('https://w.example/health'), env);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  // unknown path
  const notFound = await worker.fetch(new Request('https://w.example/nope'), env);
  assert.equal(notFound.headers.get('x-frame-options'), 'DENY');

  // dry-run telegram with flag off (501)
  const tg = await worker.fetch(new Request('https://w.example/v1/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(tg.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});

// ---------------------------------------------------------------------------
// Audit #19: telegram webhook secret-token verification
// ---------------------------------------------------------------------------

test('Audit #19 — telegram dry-run rejects requests missing the configured secret token', async () => {
  const env = {
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: SECRET,
    SIDEKICK_TELEGRAM_WEBHOOK_DRY_RUN_ENABLED: 'true',
    SIDEKICK_TELEGRAM_WEBHOOK_SECRET_TOKEN: 'tg_secret_token',
  };

  const noHeader = await worker.fetch(new Request('https://w.example/v1/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1770000000, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'hi' } }),
  }), env);
  assert.equal(noHeader.status, 401);

  const wrongHeader = await worker.fetch(new Request('https://w.example/v1/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1770000000, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'hi' } }),
  }), env);
  assert.equal(wrongHeader.status, 401);
});

test('Audit #19 — telegram dry-run accepts requests with the correct secret token', async () => {
  const env = {
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
    OPENROUTER_API_KEY: 'or_test_secret',
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
    SIDEKICK_RUNNER_SHARED_SECRET: SECRET,
    SIDEKICK_TELEGRAM_WEBHOOK_DRY_RUN_ENABLED: 'true',
    SIDEKICK_TELEGRAM_WEBHOOK_SECRET_TOKEN: 'tg_secret_token',
    SIDEKICK_TELEGRAM_DRY_RUN_USER_ID: 'user_tg_123',
  };

  const ok = await worker.fetch(new Request('https://w.example/v1/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg_secret_token' },
    body: JSON.stringify({
      update_id: 42,
      message: {
        message_id: 7,
        date: 1770000000,
        chat: { id: 1, type: 'private' },
        from: { id: 1 },
        text: 'Draft my agenda please.',
      },
    }),
  }), env);
  assert.equal(ok.status, 202);
});
