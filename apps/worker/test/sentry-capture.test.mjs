// IMPORTANT: this file imports the built Worker from `../dist/index.js`. Always
// run via `npm test` (which performs `npm run build` first) — invoking
// `node --test` directly may test stale compiled output.
//
// Covers the zero-dependency Sentry envelope helper (captureWorkerException)
// added when Sentry error monitoring was wired into the Worker. The helper must
// be: gated on SENTRY_DSN, build a spec-correct Sentry envelope POST, and never
// throw (error reporting must not break the request/cron path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkerException } from '../dist/index.js';

function mockCtx() {
  const waits = [];
  return { waitUntil: (p) => { waits.push(p); }, _waits: waits };
}

function withMockFetch(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve(new Response('')); };
  try { return fn(calls); } finally { globalThis.fetch = original; }
}

test('captureWorkerException is a no-op when SENTRY_DSN is unset (gated, inert)', () => {
  withMockFetch((calls) => {
    const ctx = mockCtx();
    captureWorkerException({}, ctx, new Error('boom'), { where: 'fetch' });
    assert.equal(ctx._waits.length, 0, 'no send scheduled without a DSN');
    assert.equal(calls.length, 0, 'no Sentry HTTP call without a DSN');
  });
});

test('captureWorkerException POSTs a spec-correct Sentry envelope to the DSN ingest URL', async () => {
  await withMockFetch(async (calls) => {
    const ctx = mockCtx();
    const env = { SENTRY_DSN: 'https://abc123def@o4511.ingest.de.sentry.io/4509' };
    captureWorkerException(env, ctx, new Error('kaboom'), { where: 'fetch', path: '/api/chat/runs' });

    assert.equal(ctx._waits.length, 1, 'send scheduled exactly once via ctx.waitUntil (fire-and-forget)');
    await Promise.all(ctx._waits);
    assert.equal(calls.length, 1, 'one Sentry HTTP call');

    const { url, init } = calls[0];
    // host -> envelope endpoint, project id from the DSN path
    assert.equal(url, 'https://o4511.ingest.de.sentry.io/api/4509/envelope/');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/x-sentry-envelope');
    assert.match(init.headers['x-sentry-auth'], /sentry_version=7/);
    assert.match(init.headers['x-sentry-auth'], /sentry_key=abc123def/);

    // Envelope = 3 newline-delimited JSON lines: header, item-header, event.
    const lines = String(init.body).trim().split('\n');
    assert.equal(lines.length, 3, 'envelope has header + item-header + event');
    const header = JSON.parse(lines[0]);
    const itemHeader = JSON.parse(lines[1]);
    const event = JSON.parse(lines[2]);
    assert.equal(header.dsn, env.SENTRY_DSN);
    assert.ok(/^[0-9a-f]{32}$/.test(header.event_id), 'event_id is a 32-char hex id');
    assert.equal(itemHeader.type, 'event');
    assert.equal(event.level, 'error');
    assert.equal(event.platform, 'javascript');
    assert.equal(event.exception.values[0].type, 'Error');
    assert.equal(event.exception.values[0].value, 'kaboom');
    assert.equal(event.extra.where, 'fetch');
    assert.equal(event.extra.path, '/api/chat/runs');
  });
});

test('captureWorkerException never sends PII-bearing fields (no headers/cookies/body capture)', async () => {
  await withMockFetch(async (calls) => {
    const ctx = mockCtx();
    captureWorkerException({ SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2' }, ctx, new Error('x'));
    await Promise.all(ctx._waits);
    const event = JSON.parse(String(calls[0].init.body).trim().split('\n')[2]);
    // The helper only forwards the exception + caller-supplied context + a stack;
    // it must not attach request headers, cookies, or the client IP.
    assert.ok(!('request' in event), 'no request object is attached');
    assert.ok(!('user' in event), 'no user/IP is attached');
  });
});

test('captureWorkerException never throws on a malformed DSN', () => {
  withMockFetch((calls) => {
    const ctx = mockCtx();
    assert.doesNotThrow(() => captureWorkerException({ SENTRY_DSN: 'not-a-valid-dsn' }, ctx, new Error('x')));
    assert.equal(ctx._waits.length, 0, 'malformed DSN -> nothing scheduled');
    assert.equal(calls.length, 0);
  });
});

test('captureWorkerException never throws on a non-Error thrown value', async () => {
  await withMockFetch(async (calls) => {
    const ctx = mockCtx();
    assert.doesNotThrow(() => captureWorkerException({ SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/2' }, ctx, 'string failure'));
    await Promise.all(ctx._waits);
    const event = JSON.parse(String(calls[0].init.body).trim().split('\n')[2]);
    assert.equal(event.exception.values[0].value, 'string failure');
  });
});
