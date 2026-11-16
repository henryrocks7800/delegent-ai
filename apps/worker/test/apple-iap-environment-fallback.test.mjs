// A 401 from ONE Apple environment must not abandon the other one.
//
// THE DEFECT THIS PINS. fetchAppleTransaction walks the configured
// environments in order. Any status that was not 404 used to `return`
// immediately:
//
//     if (!notFound) {
//       return { error: status === 401 ? 'apple_auth_rejected' : ..., status: 502 };
//     }
//
// Apple's PRODUCTION host refuses our key with 401 while the identical key
// authenticates against SANDBOX (verified by scripts/apple-launch-day.mjs
// --preflight). So under the default 'auto' setting the walk asked Production
// first, took the 401, and never asked Sandbox at all. Every TestFlight and
// every App Review purchase would fail to verify.
//
// That left NO safe configuration, which is the part that made this a launch
// blocker rather than a wart:
//
//   'Sandbox'  -> App Review verifies, but a real launch-day purchase is a
//                 PRODUCTION transaction and Sandbox has never heard of it.
//   'auto'     -> Production 401 aborts the walk, so nothing verifies at all.
//
// The Sandbox pin in Doppler was a workaround for this line, not a decision.
//
// The fix continues past a 401 while remembering it. The original safety
// intent is preserved exactly: a genuinely dead key is refused by EVERY
// environment, so the walk exhausts and still reports apple_auth_rejected. It
// must never degrade into a misleading "no such transaction", because that
// reads as "this customer is lying about paying".
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAppleTransaction } from '../dist/apple-iap.js';

const PRODUCTION_HOST = 'api.storekit.itunes.apple.com';
const SANDBOX_HOST = 'api.storekit-sandbox.itunes.apple.com';

async function testKeyPem() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jws(payload) {
  return `${b64url({ alg: 'ES256' })}.${b64url(payload)}.signature-not-checked`;
}

const TRANSACTION = {
  transactionId: '2000001226091677',
  originalTransactionId: '2000001226091677',
  bundleId: 'com.sidekick.v2',
  productId: 'com.sidekick.v2.studio.monthly',
  type: 'Auto-Renewable Subscription',
  purchaseDate: Date.parse('2026-08-22T15:04:37Z'),
  expiresDate: Date.parse('2026-09-22T15:04:37Z'),
  environment: 'Sandbox',
};

async function env(overrides = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-for-test',
    APPLE_IAP_KEY_P8: await testKeyPem(),
    APPLE_IAP_KEY_ID: 'KEYID12345',
    APPLE_IAP_ISSUER_ID: 'issuer-id',
    SIDEKICK_APPLE_IAP_ENVIRONMENT: 'auto',
    ...overrides,
  };
}

/**
 * Stub Apple per host, and record which hosts were actually asked.
 * `byHost` maps a host to a { status, body } reply.
 */
function stubApple(byHost) {
  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const host = new URL(href).host;
    asked.push(host);
    const reply = byHost[host] ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  };
  return { asked, restore() { globalThis.fetch = originalFetch; } };
}

test('[launch-blocker] a Production 401 still falls through to Sandbox', async () => {
  const apple = stubApple({
    [PRODUCTION_HOST]: { status: 401, body: {} },
    [SANDBOX_HOST]: { status: 200, body: { signedTransactionInfo: jws(TRANSACTION) } },
  });
  try {
    const result = await fetchAppleTransaction(await env(), TRANSACTION.transactionId);

    assert.ok(!('error' in result),
      `Production's 401 must not abandon Sandbox, got ${JSON.stringify(result)}`);
    assert.equal(result.environment, 'Sandbox',
      'the resolved environment must be recorded as Sandbox so free purchases stay out of revenue');
    assert.equal(result.info.transactionId, TRANSACTION.transactionId);
    assert.deepEqual(apple.asked, [PRODUCTION_HOST, SANDBOX_HOST],
      'both environments should have been asked, Production first');
  } finally {
    apple.restore();
  }
});

test('[launch-blocker] a key refused EVERYWHERE still reports auth rejection, never "not found"', async () => {
  const apple = stubApple({
    [PRODUCTION_HOST]: { status: 401, body: {} },
    [SANDBOX_HOST]: { status: 401, body: {} },
  });
  try {
    const result = await fetchAppleTransaction(await env(), TRANSACTION.transactionId);

    assert.ok('error' in result, 'a dead key must not resolve a transaction');
    assert.equal(result.error, 'apple_auth_rejected',
      'this is the whole safety property: a broken key must NOT read as a bogus transaction');
    assert.notEqual(result.error, 'apple_transaction_not_found');
    assert.equal(result.status, 502, 'our fault, not the caller\'s, so 5xx');
  } finally {
    apple.restore();
  }
});

test('a genuinely unknown transaction is still "not found", not an auth error', async () => {
  const apple = stubApple({
    [PRODUCTION_HOST]: { status: 404, body: { errorCode: 4040010 } },
    [SANDBOX_HOST]: { status: 404, body: { errorCode: 4040010 } },
  });
  try {
    const result = await fetchAppleTransaction(await env(), 'made-up-transaction');

    assert.ok('error' in result);
    assert.equal(result.error, 'apple_transaction_not_found');
    assert.equal(result.status, 404, 'the caller sent a bad id, so 4xx');
  } finally {
    apple.restore();
  }
});

test('a transient 5xx stops the walk rather than guessing from the other environment', async () => {
  const apple = stubApple({
    [PRODUCTION_HOST]: { status: 500, body: {} },
    [SANDBOX_HOST]: { status: 200, body: { signedTransactionInfo: jws(TRANSACTION) } },
  });
  try {
    const result = await fetchAppleTransaction(await env(), TRANSACTION.transactionId);

    assert.ok('error' in result, 'an Apple outage must not be answered from the other environment');
    assert.equal(result.error, 'apple_api_error');
    assert.deepEqual(apple.asked, [PRODUCTION_HOST],
      'Sandbox must NOT be asked: a 500 is retryable and says nothing about the other host');
  } finally {
    apple.restore();
  }
});

test('an explicit Sandbox pin still asks only Sandbox', async () => {
  const apple = stubApple({
    [SANDBOX_HOST]: { status: 200, body: { signedTransactionInfo: jws(TRANSACTION) } },
  });
  try {
    const result = await fetchAppleTransaction(
      await env({ SIDEKICK_APPLE_IAP_ENVIRONMENT: 'Sandbox' }),
      TRANSACTION.transactionId,
    );

    assert.ok(!('error' in result));
    assert.deepEqual(apple.asked, [SANDBOX_HOST], 'a pin means a pin');
  } finally {
    apple.restore();
  }
});
