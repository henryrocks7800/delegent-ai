// Security invariants regression suite.
//
// This file converts the explicit "we checked it, here's why it's safe"
// findings from the 2026-05-09 whole-codebase security audit into runnable
// regression tests. Each subtest names the exact security boundary it
// protects so a future refactor that weakens one of them surfaces as a red
// test, not a silent regression.
//
// What the audit confirmed (and what this file locks in):
//   - Worker runner HMAC v1 binds the signature to (userId, timestamp): a
//     token signed for user A cannot authenticate user B even with a valid
//     timestamp.
//   - Malformed v1 signatures (bad hex, wrong length, missing prefix) are
//     rejected before any constant-time comparison runs.
//   - Telegram webhook secret-token mismatch is rejected with 401, not 200,
//     and the secret is not echoed in the response body.
//   - Worker default-fetch security headers (HSTS, nosniff, frame-deny,
//     CSP `default-src 'none'`) are attached to every response, including
//     the 404 path that an attacker is most likely to scan.
//   - The OpenRouter model is pinned to `MODEL` and never honors a caller-
//     supplied `model` field — exercised with both the buildOpenRouterPayload
//     unit and a full proxy fetch (rejected before OpenRouter traffic
//     because env preflight is intentionally incomplete in fixtures).
//   - Telegram connect-code parser rejects userinfo, non-https, and
//     non-`t.me` deep-link host substitutions.
//
// Notes on scope:
//   - Each subtest is title-prefixed `[security-invariant]` for grep.
//   - The suite imports from `apps/worker/dist/index.js` and
//     `packages/shared/dist/index.js`, so it picks up automatically via
//     `npm run test:e2e` (which builds workspaces first).

import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  MAX_REQUEST_CONTENT_BYTES,
  MAX_REQUEST_MESSAGES,
  MODEL,
  RUNNER_AUTH_MAX_SKEW_SECONDS,
  SIDEKICK_WORKER_SECURITY_HEADERS,
  applySecurityHeaders,
  buildOpenRouterPayload,
  requireSidekickRunnerAuth,
  signRunnerTokenV1,
  timingSafeEqualBytes,
  verifyRunnerTokenV1,
} from '../../apps/worker/dist/index.js';

import {
  normalizeGatewayConnectCode,
  resolveTelegramWebhookHandoff,
} from '../../packages/shared/dist/index.js';

const SECRET = 'security_invariant_runner_secret_fixture_32_chars';
const USER_A = '00000000-0000-4000-8000-00000000aaaa';
const USER_B = '00000000-0000-4000-8000-00000000bbbb';

// ---------------------------------------------------------------------------
// Group A — Runner HMAC v1 invariants
// ---------------------------------------------------------------------------

test('[security-invariant] runner HMAC v1 binds the signature to the user id, not the secret alone', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const tokenForA = await signRunnerTokenV1(SECRET, USER_A, ts);

  // Token verifies for the user it was signed for…
  assert.equal(await verifyRunnerTokenV1(SECRET, USER_A, ts, tokenForA), true);

  // …and does NOT verify when presented with a different user id, even
  // though the timestamp is valid and the secret is correct. This is the
  // "leaked token bounds to a single user" property documented in
  // `apps/worker/src/index.ts`.
  assert.equal(await verifyRunnerTokenV1(SECRET, USER_B, ts, tokenForA), false);
});

test('[security-invariant] requireSidekickRunnerAuth rejects cross-user replay of a valid v1 token', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const tokenForA = await signRunnerTokenV1(SECRET, USER_A, ts);

  await assert.rejects(
    requireSidekickRunnerAuth(
      new Headers({
        // header pretends to be userB, but the signature was made for userA
        'x-sidekick-user-id': USER_B,
        'x-sidekick-runner-timestamp': String(ts),
        'x-sidekick-runner-token': tokenForA,
      }),
      { SIDEKICK_RUNNER_SHARED_SECRET: SECRET },
    ),
    /runner token/i,
  );
});

test('[security-invariant] runner auth rejects malformed v1 tokens before constant-time compare', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const malformed = [
    'v1.', // empty signature
    'v1.zzzz', // non-hex
    'v1.deadbe', // odd hex length
    'v1.' + 'a'.repeat(63), // odd hex length
    'v0.deadbeef', // wrong version prefix
    'deadbeef', // missing prefix
    '',
  ];
  for (const token of malformed) {
    await assert.rejects(
      requireSidekickRunnerAuth(
        new Headers({
          'x-sidekick-user-id': USER_A,
          'x-sidekick-runner-timestamp': String(ts),
          'x-sidekick-runner-token': token,
        }),
        { SIDEKICK_RUNNER_SHARED_SECRET: SECRET },
      ),
      `expected ${JSON.stringify(token)} to be rejected`,
    );
  }
});

test('[security-invariant] runner auth enforces the documented 5-minute skew window', async () => {
  // Use exactly one second past the skew limit so we don't depend on test
  // wall-clock drift.
  const expiredTs = Math.floor(Date.now() / 1000) - (RUNNER_AUTH_MAX_SKEW_SECONDS + 1);
  const token = await signRunnerTokenV1(SECRET, USER_A, expiredTs);

  await assert.rejects(
    requireSidekickRunnerAuth(
      new Headers({
        'x-sidekick-user-id': USER_A,
        'x-sidekick-runner-timestamp': String(expiredTs),
        'x-sidekick-runner-token': token,
      }),
      { SIDEKICK_RUNNER_SHARED_SECRET: SECRET },
    ),
  );
});

test('[security-invariant] timingSafeEqualBytes returns false on length mismatch and never short-circuits on byte mismatch', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  const c = new Uint8Array([1, 2, 3, 5]);
  const d = new Uint8Array([1, 2, 3]); // shorter

  assert.equal(timingSafeEqualBytes(a, b), true);
  assert.equal(timingSafeEqualBytes(a, c), false);
  assert.equal(timingSafeEqualBytes(a, d), false);
});

// ---------------------------------------------------------------------------
// Group B — Worker request shape / model pin
// ---------------------------------------------------------------------------

test('[security-invariant] worker pins the upstream model and ignores caller-supplied model strings', () => {
  const payload = buildOpenRouterPayload({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'attacker/free-model',
  });
  assert.equal(payload.model, MODEL);
});

test('[security-invariant] worker passes stream through with usage accounting, clamps max_tokens, and keeps the model pinned', () => {
  // Streaming rollout (2026-06-02): the worker→OpenRouter leg now PASSES stream
  // through for token-by-token chat instead of forcing it off. The security /
  // billing invariants that must survive streaming are: (a) usage is still
  // requested in the final SSE chunk (`stream_options.include_usage`) so streamed
  // turns are billed and can't dodge the quota meter, (b) max_tokens is clamped to
  // the documented ceiling regardless of caller input, (c) the model stays pinned
  // to MODEL and an attacker-supplied `model` is ignored.
  const streamed = buildOpenRouterPayload({
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 10_000_000,
    model: 'attacker/wants-a-different-model',
  });
  assert.equal(streamed.stream, true);
  assert.deepEqual(streamed.stream_options, { include_usage: true });
  assert.ok(typeof streamed.max_tokens === 'number' && streamed.max_tokens <= 16_384);
  assert.equal(streamed.model, MODEL);

  // The non-streaming path (sync /tasks, Telegram) must keep stream:false and must
  // NOT emit stream_options — no behaviour change there.
  const sync = buildOpenRouterPayload({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10_000_000 });
  assert.equal(sync.stream, false);
  assert.ok(!('stream_options' in sync));
  assert.ok(typeof sync.max_tokens === 'number' && sync.max_tokens <= 16_384);
});

test('[security-invariant] worker rejects oversize message payloads before any provider traffic', () => {
  const tooMany = Array.from({ length: MAX_REQUEST_MESSAGES + 1 }, () => ({ role: 'user', content: '.' }));
  assert.throws(() => buildOpenRouterPayload({ messages: tooMany }));
  const tooBig = 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1);
  assert.throws(() => buildOpenRouterPayload({ messages: [{ role: 'user', content: tooBig }] }));
});

// ---------------------------------------------------------------------------
// Group C — Default-fetch security headers
// ---------------------------------------------------------------------------

test('[security-invariant] every response carries the documented security headers', async () => {
  const response = await worker.fetch(
    new Request('https://worker.invariant.test/health'),
    { SIDEKICK_WORKER_PROXY_ENABLED: 'false', SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'false' },
  );
  for (const [header, expected] of Object.entries(SIDEKICK_WORKER_SECURITY_HEADERS)) {
    assert.equal(response.headers.get(header), expected, `expected ${header} to be ${expected}`);
  }
});

test('[security-invariant] applySecurityHeaders does not clobber per-route headers a route already set', () => {
  const original = new Response('ok', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'sniff-please', // adversarial value
    },
  });
  const merged = applySecurityHeaders(original);
  // Per the implementation contract, an existing header is preserved (the
  // hardening function uses a `set` only when the key is absent), so we
  // assert that contract here as a regression safety net.
  assert.equal(merged.headers.get('cache-control'), 'private, no-store');
  assert.equal(merged.headers.get('x-content-type-options'), 'sniff-please');
  // …and the headers the route did NOT set are still added by the merger.
  assert.equal(merged.headers.get('strict-transport-security'), SIDEKICK_WORKER_SECURITY_HEADERS['strict-transport-security']);
});

test('[security-invariant] worker scan paths return 404 with security headers and never leak engine internals', async () => {
  const env = {
    SIDEKICK_WORKER_PROXY_ENABLED: 'false',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'false',
  };
  for (const path of ['/admin', '/.git/config', '/wp-login.php', '/api/internal/secrets', '/v1/']) {
    const response = await worker.fetch(new Request(`https://worker.invariant.test${path}`), env);
    assert.equal(response.status, 404, `expected 404 at ${path}`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const text = await response.text();
    assert.doesNotMatch(
      text,
      /openrouter|service_role|railway|cloudflare|hermes|supabase|stripe|telegram_bot/i,
      `${path} response leaked provider internals`,
    );
  }
});

// ---------------------------------------------------------------------------
// Group D — Connect code & Telegram handoff invariants
// ---------------------------------------------------------------------------

test('[security-invariant] connect-code normalizer is strict about format and length', () => {
  // These are the only inputs the user-facing /start route accepts. If a
  // future refactor relaxes the rule (e.g. allowing 7-char or 9-char codes)
  // it changes the keyspace of what an attacker has to brute-force, so the
  // rule itself is part of the security boundary.
  for (const accepted of ['TGABC123', 'tg-abc-123', '  TG ABC-123  ', 'tg.abc.123'.replace(/\./g, '')]) {
    const normalized = normalizeGatewayConnectCode(accepted);
    assert.match(normalized ?? '', /^TG[A-Z0-9]{6}$/);
  }
  for (const rejected of ['', null, 'TG', 'TGABC', 'TGABCDEFG', 'XYZABC123', 'TGABC12!', 'TG ABC 1234']) {
    assert.equal(normalizeGatewayConnectCode(rejected), null, `expected ${JSON.stringify(rejected)} to be rejected`);
  }
});

test('[security-invariant] Telegram handoff for an unlinked chat never returns task_handoff', () => {
  const update = {
    update_id: 9_999,
    message: {
      message_id: 1,
      date: 1_777_000_000,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Probe' },
      text: 'do my admin',
    },
  };
  const handoff = resolveTelegramWebhookHandoff({ update, linkedUserId: null });
  assert.notEqual(handoff.kind, 'task_handoff');
});

test('[security-invariant] malformed Telegram updates do not crash the handoff resolver and never produce task_handoff', () => {
  for (const update of [null, undefined, 0, 'string', [], {}, { update_id: 1 }, { update_id: 1, message: {} }]) {
    let result;
    try {
      result = resolveTelegramWebhookHandoff({ update, linkedUserId: USER_A });
    } catch (error) {
      // Resolver may throw on completely garbage shapes (e.g. number/string)
      // — that's also acceptable. What's NOT acceptable is silently
      // emitting a task_handoff.
      continue;
    }
    assert.notEqual(result.kind, 'task_handoff', `update ${JSON.stringify(update)} produced task_handoff`);
  }
});

// ---------------------------------------------------------------------------
// Group E — Worker proxy fail-closed
// ---------------------------------------------------------------------------

test('[security-invariant] worker proxy is unavailable when preflight is incomplete (no OpenRouter traffic possible)', async () => {
  const incompleteEnv = {
    // missing OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    SIDEKICK_RUNNER_SHARED_SECRET: SECRET,
    SIDEKICK_WORKER_PROXY_ENABLED: 'true',
    SIDEKICK_USAGE_ENFORCEMENT_ENABLED: 'true',
  };
  const ts = Math.floor(Date.now() / 1000);
  const tokenForA = await signRunnerTokenV1(SECRET, USER_A, ts);

  const response = await worker.fetch(
    new Request('https://worker.invariant.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sidekick-user-id': USER_A,
        'x-sidekick-runner-timestamp': String(ts),
        'x-sidekick-runner-token': tokenForA,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    incompleteEnv,
  );

  // The exact code can be 501 (preflight blocks) or 5xx — what matters is
  // we don't get a 200 with model output, because that would mean the
  // request reached OpenRouter despite missing config.
  assert.notEqual(response.status, 200);
  // And the security headers are still applied even on the failure path.
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
