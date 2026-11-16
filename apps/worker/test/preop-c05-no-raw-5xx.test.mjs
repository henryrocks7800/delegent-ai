// PREOP-C05 regression — "raw 502 on Pro upgrade; never raw 5xx to user".
//
// Two backend holes let a raw 5xx reach the mobile client:
//
//   (1) The top-level fetch() handler in apps/worker/src/index.ts used to
//       RE-THROW any unhandled exception ("preserve the runtime's existing
//       error behaviour"). A thrown exception makes the Cloudflare runtime
//       return a bare "1101 Worker threw exception" / 500 page with NO JSON
//       body — the client can't render a friendly message and surfaces the raw
//       status. The fix returns a structured, leak-safe JSON 500 instead.
//
//   (2) Stripe checkout/portal session-creation failures returned 502
//       (gateway). They were structured JSON, but the mobile client echoes the
//       status into the user-facing diagnostic suffix, so "502" reached the
//       user as a hard infra error. They are now 503 (temporary, retry),
//       matching the rest of stripe-flow. (Asserted in apps/web/test/
//       stripe-real-flow.test.ts.)
//
// This file pins hole (1): an unhandled throw in the request path produces a
// STRUCTURED, security-headed, leak-free JSON 500 — never a re-thrown raw 5xx.
//
// Fails-without: on the pre-fix code the catch re-throws, so `worker.fetch`
// REJECTS (throws) instead of resolving with a 500 Response — the first
// assertion (await resolves to a Response) throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

// A Request-like object whose `url` getter throws. The top-level handler reads
// `request.url` (via `new URL(request.url)`) inside its try block, so this
// triggers exactly the catch-all error boundary in a handler-agnostic way
// (no dependency on any route's internal error handling).
function requestThatThrowsOnUrlAccess() {
  return {
    method: 'GET',
    headers: new Headers(),
    get url() {
      throw new Error('synthetic unhandled failure with secret sk_test_should_never_leak');
    },
  };
}

const ENV = {
  // No SENTRY_DSN — captureWorkerException stays inert, but the catch path
  // must still return a safe response.
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
};

function noopCtx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

test('PREOP-C05 unhandled exception returns a structured JSON 500, never a re-thrown raw 5xx', async () => {
  let response;
  // The whole regression: this MUST resolve to a Response. On the pre-fix
  // re-throw, the next line throws instead.
  await assert.doesNotReject(async () => {
    response = await worker.fetch(requestThatThrowsOnUrlAccess(), ENV, noopCtx());
  }, 'worker.fetch must not re-throw — it must resolve with a safe Response');

  assert.equal(response.status, 500, 'must be a 500, not a bare Cloudflare exception page');

  const body = await response.json();
  assert.equal(body.error, 'internal_error', 'structured, opaque error code the client can render');
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0, 'a human-readable, recovery-oriented message is present');
});

test('PREOP-C05 the 500 error boundary carries security headers and leaks no internals', async () => {
  const response = await worker.fetch(requestThatThrowsOnUrlAccess(), ENV, noopCtx());
  const text = await response.text();

  // Security headers applied (applySecurityHeaders) just like every normal response.
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get('x-content-type-options') ?? 'nosniff', 'nosniff');

  // The error text must never echo the thrown message, secrets, stack frames,
  // or provider/infra vocabulary.
  assert.doesNotMatch(text, /sk_test_should_never_leak/);
  assert.doesNotMatch(text, /synthetic unhandled failure/);
  assert.doesNotMatch(text, /service_role_test_secret/);
  assert.doesNotMatch(text, /\bat \w+\b.*:\d+:\d+/, 'no stack frames');
  assert.doesNotMatch(text, /openrouter|cloudflare|\bfly\b|supabase|railway/i, 'no infra leak');
});
