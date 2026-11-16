// CORS for the parity web app.
//
// The load-bearing test in this file is the FIRST one: a request with no
// `Origin` header must come back byte-identical to how it did before CORS
// existed. React Native's fetch sends no Origin, so that request is the live
// mobile app, and a regression here breaks paying users' phones.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIDEKICK_WEB_APP_ALLOWED_ORIGINS,
  SIDEKICK_CORS_ALLOWED_METHODS,
  SIDEKICK_CORS_ALLOWED_HEADERS,
  SIDEKICK_CORS_EXPOSED_HEADERS,
  SIDEKICK_WORKER_SECURITY_HEADERS,
  resolveAllowedOrigin,
  applyCorsHeaders,
  applySecurityHeaders,
  buildCorsPreflightResponse,
} from '../dist/index.js';

const CORS_RESPONSE_HEADERS = ['access-control-allow-origin', 'access-control-expose-headers'];

function request(url, init) {
  return new Request(url, init);
}

test('a request with no Origin header is completely untouched (the live mobile app)', () => {
  const base = Response.json({ ok: true });
  const secured = applySecurityHeaders(base);
  const before = [...secured.headers.entries()].sort();

  const after = applyCorsHeaders(secured, request('https://api.delegantai.co.uk/health'));

  assert.deepEqual([...after.headers.entries()].sort(), before);
  for (const name of CORS_RESPONSE_HEADERS) {
    assert.equal(after.headers.get(name), null, `${name} must not appear for an origin-less request`);
  }
  // Every security header is still present and unchanged.
  for (const [name, value] of Object.entries(SIDEKICK_WORKER_SECURITY_HEADERS)) {
    assert.equal(after.headers.get(name), value);
  }
});

test('an origin that is not allowlisted gets no CORS headers at all', () => {
  for (const origin of [
    'https://evil.example',
    'http://app.delegentai.co.uk',
    'https://app.delegentai.co.uk.evil.example',
    'https://delegentai.co.uk.evil.example',
    'https://notdelegent-app.web.app',
    'https://delegent-app.web.app.evil.example',
    'https://delegent-app--preview.web.app.evil.example',
    'null',
  ]) {
    assert.equal(resolveAllowedOrigin(origin), null, `${origin} must not be allowlisted`);
    const wrapped = applyCorsHeaders(
      Response.json({ ok: true }),
      request('https://api.delegantai.co.uk/api/chat/conversations', { headers: { origin } }),
    );
    for (const name of CORS_RESPONSE_HEADERS) {
      assert.equal(wrapped.headers.get(name), null, `${origin} leaked ${name}`);
    }
  }
});

test('allowlisted origins are echoed back exactly, never a wildcard', () => {
  for (const origin of SIDEKICK_WEB_APP_ALLOWED_ORIGINS) {
    const wrapped = applyCorsHeaders(
      Response.json({ ok: true }),
      request('https://api.delegantai.co.uk/api/chat/conversations', { headers: { origin } }),
    );
    assert.equal(wrapped.headers.get('access-control-allow-origin'), origin);
    assert.notEqual(wrapped.headers.get('access-control-allow-origin'), '*');
    assert.equal(wrapped.headers.get('access-control-expose-headers'), SIDEKICK_CORS_EXPOSED_HEADERS);
    assert.equal(wrapped.headers.get('vary'), 'Origin');
  }
});

test('every allowlisted origin is https on a domain we own', () => {
  for (const origin of SIDEKICK_WEB_APP_ALLOWED_ORIGINS) {
    const { protocol, hostname } = new URL(origin);
    assert.equal(protocol, 'https:', `${origin} must be https`);
    assert.ok(
      hostname === 'delegentai.co.uk' ||
        hostname.endsWith('.delegentai.co.uk') ||
        hostname === 'delegent-app.web.app' ||
        hostname === 'delegent-app.firebaseapp.com',
      `${origin} is not a domain we own`,
    );
  }
});

test('Firebase preview channels for our own site are allowed', () => {
  assert.equal(
    resolveAllowedOrigin('https://delegent-app--pr-42-a1b2c3d4.web.app'),
    'https://delegent-app--pr-42-a1b2c3d4.web.app',
  );
  assert.equal(resolveAllowedOrigin('https://someone-else--pr-42.web.app'), null);
  assert.equal(resolveAllowedOrigin('https://delegent-app--.web.app'), null);
});

test('the response body is preserved when CORS headers are added', async () => {
  const wrapped = applyCorsHeaders(
    Response.json({ hello: 'world' }, { status: 201, statusText: 'Created' }),
    request('https://api.delegantai.co.uk/api/chat/conversations', {
      headers: { origin: 'https://app.delegentai.co.uk' },
    }),
  );
  assert.equal(wrapped.status, 201);
  assert.deepEqual(await wrapped.json(), { hello: 'world' });
});

test('a preflight from an allowlisted origin is answered with 204 and no body', async () => {
  const preflight = buildCorsPreflightResponse(
    request('https://api.delegantai.co.uk/api/chat/conversations', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.delegentai.co.uk',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    }),
  );
  assert.ok(preflight, 'preflight should be answered');
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.delegentai.co.uk');
  assert.equal(preflight.headers.get('access-control-allow-methods'), SIDEKICK_CORS_ALLOWED_METHODS);
  assert.equal(preflight.headers.get('access-control-allow-headers'), SIDEKICK_CORS_ALLOWED_HEADERS);
  assert.equal(preflight.headers.get('access-control-max-age'), '86400');
});

test('the preflight allows exactly the methods and headers the web app sends', () => {
  // The web app talks to the Worker with a bearer token and JSON bodies, and
  // reads back a correlation id for support. Anything beyond that should be a
  // deliberate edit here, not a silent widening.
  // PUT is on the list because /api/connections/{service} stores a credential
  // with it; without the preflight the browser never sends the request at all.
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.ok(SIDEKICK_CORS_ALLOWED_METHODS.includes(method), `${method} should be preflight-allowed`);
  }
  assert.ok(!SIDEKICK_CORS_ALLOWED_METHODS.includes('HEAD'));
  assert.ok(!SIDEKICK_CORS_ALLOWED_METHODS.includes('TRACE'));
  for (const header of ['authorization', 'content-type', 'x-correlation-id']) {
    assert.ok(SIDEKICK_CORS_ALLOWED_HEADERS.includes(header));
  }
  // Runner HMAC headers are a server-to-server contract and must never be
  // reachable from a browser.
  assert.ok(!SIDEKICK_CORS_ALLOWED_HEADERS.includes('x-sidekick-runner'));
  assert.ok(!SIDEKICK_CORS_ALLOWED_HEADERS.includes('x-sidekick-user-id'));
});

test('a preflight we do not recognise falls through to the router', () => {
  // No Origin: the mobile app, or curl. Must not be short-circuited.
  assert.equal(
    buildCorsPreflightResponse(
      request('https://api.delegantai.co.uk/health', {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': 'GET' },
      }),
    ),
    null,
  );
  // Disallowed origin.
  assert.equal(
    buildCorsPreflightResponse(
      request('https://api.delegantai.co.uk/health', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      }),
    ),
    null,
  );
  // OPTIONS without the preflight marker header is not a preflight.
  assert.equal(
    buildCorsPreflightResponse(
      request('https://api.delegantai.co.uk/health', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.delegentai.co.uk' },
      }),
    ),
    null,
  );
  // Not OPTIONS.
  assert.equal(
    buildCorsPreflightResponse(
      request('https://api.delegantai.co.uk/health', {
        headers: { origin: 'https://app.delegentai.co.uk', 'access-control-request-method': 'GET' },
      }),
    ),
    null,
  );
});
