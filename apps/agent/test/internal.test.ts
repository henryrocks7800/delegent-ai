import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  AUTH_MAX_SKEW_SECONDS,
  FILE_LINK_TTL_SECONDS,
  PROBE_USER,
  fileLinkToken,
  fileLinkUrl,
  signRequestToken,
  verifyFileLinkToken,
  verifyRequest,
} from '../src/internal.ts';

const SECRET = 'test-agent-secret-not-real';
const USER = '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2';
const OTHER_USER = 'b81242f0-e90b-4e9a-86f0-07f3248bcf55';
const NOW = 1_789_000_000;
const FILE = `file_${'ab'.repeat(16)}`;

function headers(userId: string, timestamp: number, token: string) {
  return new Headers({
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': String(timestamp),
    'x-sidekick-runner-token': token,
  });
}

test('requests use the runner auth v1 format the Worker already signs', async () => {
  // Independent implementation of apps/worker signRunnerTokenV1:
  // "v1." + HMAC-SHA256 over "v1:<user>:<timestamp>".
  const expected = `v1.${createHmac('sha256', SECRET).update(`v1:${USER}:${NOW}`).digest('hex')}`;
  assert.equal(await signRequestToken(SECRET, USER, NOW), expected);
  assert.equal(await verifyRequest(headers(USER, NOW, expected), SECRET, NOW), USER);
});

test('a request is refused without the right secret, user, or a fresh timestamp', async () => {
  const token = await signRequestToken(SECRET, USER, NOW);
  assert.equal(await verifyRequest(headers(USER, NOW, token), 'another-secret', NOW), null);
  assert.equal(await verifyRequest(headers(USER, NOW, token), '', NOW), null, 'no secret configured refuses everyone');
  assert.equal(await verifyRequest(headers(OTHER_USER, NOW, token), SECRET, NOW), null, 'a token is bound to its user');
  assert.equal(await verifyRequest(headers(USER, NOW, token), SECRET, NOW + AUTH_MAX_SKEW_SECONDS + 1), null, 'stale');
  assert.equal(await verifyRequest(headers('../etc/passwd', NOW, token), SECRET, NOW), null, 'user id shape');
  assert.equal(await verifyRequest(new Headers(), SECRET, NOW), null);
  const probe = await signRequestToken(SECRET, PROBE_USER, NOW);
  assert.equal(await verifyRequest(headers(PROBE_USER, NOW, probe), SECRET, NOW), PROBE_USER, 'the operator probe instance is allowed');
});

test('file links last a month, are bound to one user and file, and cannot be forged', async () => {
  const token = await fileLinkToken(SECRET, USER, FILE, NOW + FILE_LINK_TTL_SECONDS);
  assert.deepEqual(await verifyFileLinkToken(token, FILE, SECRET, NOW), { userId: USER });
  assert.deepEqual(await verifyFileLinkToken(token, FILE, SECRET, NOW + FILE_LINK_TTL_SECONDS - 1), { userId: USER });
  assert.equal(await verifyFileLinkToken(token, FILE, SECRET, NOW + FILE_LINK_TTL_SECONDS + 1), null, 'expired');
  assert.equal(await verifyFileLinkToken(token, `file_${'cd'.repeat(16)}`, SECRET, NOW), null, 'another file');
  assert.equal(await verifyFileLinkToken(token.replace(USER, OTHER_USER), FILE, SECRET, NOW), null, 'another user');
  assert.equal(await verifyFileLinkToken(token, FILE, 'another-secret', NOW), null);
  assert.equal(await verifyFileLinkToken(null, FILE, SECRET, NOW), null);
  const url = new URL(await fileLinkUrl('https://api.delegantai.co.uk/', SECRET, USER, FILE, NOW));
  assert.equal(url.origin + url.pathname, `https://api.delegantai.co.uk/api/files/agent/${FILE}`);
  assert.deepEqual(await verifyFileLinkToken(url.searchParams.get('token'), FILE, SECRET, NOW), { userId: USER });
});
