import assert from 'node:assert/strict';
import test from 'node:test';
import { withRateLimitRetry } from '../src/openrouter-retry.ts';

const sse = (events: string[], split = false) => {
  const text = events.map((e) => `data: ${e}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(': OPENROUTER PROCESSING\n\n' + text);
  const parts = split ? [bytes.slice(0, 30), bytes.slice(30, 41), bytes.slice(41)] : [bytes];
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};
const rateLimited = JSON.stringify({
  id: 'x',
  error: { code: 429, message: 'The model is temporarily rate-limited upstream.', metadata: { error_type: 'rate_limit_exceeded' } },
  choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
});
const hello = JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'Hello' } }] });

async function run(responses: Array<() => Response>, expectCalls: number, expectText: RegExp, expectStatus = 200) {
  let calls = 0;
  const retries: string[] = [];
  const f = withRateLimitRetry(async () => responses[Math.min(calls++, responses.length - 1)](), (r) => retries.push(r));
  const res = await f('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' });
  const body = await res.text();
  assert.equal(calls, expectCalls, 'calls');
  assert.equal(res.status, expectStatus, 'status');
  assert.match(body, expectText, 'body');
}

test('a healthy stream passes through intact', () => run([() => sse([hello], true)], 1, /OPENROUTER PROCESSING[\s\S]*Hello[\s\S]*\[DONE\]/));
test('an in-stream rate limit is retried', () => run([() => sse([rateLimited]), () => sse([hello])], 2, /Hello/));
test('an in-stream rate limit split across chunks is retried', () => run([() => sse([rateLimited], true), () => sse([hello])], 2, /Hello/));
test('HTTP 429 is retried', () => run([() => new Response('slow down', { status: 429 }), () => sse([hello])], 2, /Hello/));
test('it gives up after two retries and returns the error', () => run([() => sse([rateLimited])], 3, /rate-limited/));
test('an error after output starts is not retried', () => run([() => sse([hello, rateLimited])], 1, /Hello[\s\S]*rate-limited/));
test('a non-retryable HTTP error is returned as is', () => run([() => new Response('bad key', { status: 401 })], 1, /bad key/, 401));
test('a plain JSON response is untouched', () =>
  run([() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })], 1, /"ok":true/));
