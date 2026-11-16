import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInboxNotice, sortNoticeText } from '../dist/inbox-notice.js';
import worker from '../dist/index.js';
// Use the engine's real signer to catch cross-service protocol drift.
import { inboxNoticeHeaders } from '../../agent/src/inboxNotice.ts';
import { signRequestToken } from '../../agent/src/internal.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'synthetic-internal-secret';
const endpoint = 'https://unit.test/internal/inbox-notice';
const env = { SIDEKICK_AGENT_SHARED_SECRET: SECRET, SIDEKICK_AGENT_ENGINE_USER_IDS: USER,
  AGENT: { fetch() { throw new Error('No model or agent callback is needed'); } },
  SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role' };
const example = (changes = {}) => ({ kind: 'sort', id: crypto.randomUUID(), sortId: crypto.randomUUID(), provider: 'outlook', outcome: 'plan',
  total: 100, toFile: 47, stay: 53, filed: 0, groups: [{ name: 'Receipts', count: 47, newFolder: false }], ...changes });
async function request(notice, headers = {}, now = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(notice);
  return new Request(endpoint, { method: 'POST', body,
    headers: { ...await inboxNoticeHeaders(SECRET, USER, body, now), ...headers } });
}
function database() {
  const rows = new Map(); const pushes = []; let writes = 0;
  let loseAcknowledgement = false; let deleting = false;
  return { rows, pushes, get writes() { return writes; }, loseAcknowledgement: () => { loseAcknowledgement = true; }, deleteAccount: () => { deleting = true; },
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, env.SUPABASE_URL);
      assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
      if (url.pathname === '/rest/v1/account_deletion_requests') return Response.json(deleting ? [{ id: crypto.randomUUID() }] : []);
      if (init.method === 'POST') {
        assert.equal(new Headers(init.headers).get('prefer'), 'resolution=ignore-duplicates,return=representation');
        const value = JSON.parse(init.body);
        if (rows.has(value.id)) return Response.json([]);
        rows.set(value.id, value); writes++;
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('response lost after commit'); }
        return Response.json([{ id: value.id }], { status: 201 });
      }
      const row = rows.get(url.searchParams.get('id').slice(3));
      return Response.json(row?.user_id === url.searchParams.get('user_id').slice(3) ? [{ content: row.content }] : []);
    },
    async push(_env, userId, message) { pushes.push({ userId, ...message }); return 1; },
  };
}

test('concurrent repeated callbacks insert one ordinary assistant message and send one generic push', async () => {
  const db = database(); const notice = example();
  const responses = await Promise.all(Array.from({ length: 5 }, async () => handleInboxNotice(await request(notice), env, db)));
  assert.deepEqual(responses.map((r) => r.status), [204, 204, 204, 204, 204]);
  assert.equal(db.writes, 1); assert.equal(db.pushes.length, 1);
  const row = db.rows.get(notice.id);
  assert.equal(row.user_id, USER); assert.equal(row.conversation_id, USER); assert.equal(row.channel, 'system');
  assert.equal(row.status, 'complete'); assert.equal(row.role, 'assistant');
  assert.match(row.content, /Here is the plan for your Outlook inbox/); assert.match(row.content, /Receipts: 47/);
  assert.match(row.content, /Nothing has moved yet/); assert.match(row.content, /Shall I go ahead/);
  assert.equal('task_run_id' in row, false);
  assert.equal(JSON.stringify(db.pushes).includes('Receipts'), false);
  assert.equal(JSON.stringify(db.pushes).includes('100'), false);
});

test('lost database acknowledgement retries without a duplicate; push remains explicitly best effort', async () => {
  const db = database(); const notice = example(); db.loseAcknowledgement();
  assert.equal((await handleInboxNotice(await request(notice), env, db)).status, 503);
  assert.equal((await handleInboxNotice(await request(notice), env, db)).status, 204);
  assert.equal(db.writes, 1); assert.equal(db.pushes.length, 0, 'do not invent exactly-once external push delivery');
});

test('push failures cannot lose or repeat the committed chat result', async () => {
  const db = database(); const notice = example(); let attempts = 0;
  const deps = { ...db, push: async () => { attempts++; throw new Error('FCM unavailable'); } };
  assert.equal((await handleInboxNotice(await request(notice), env, deps)).status, 204);
  assert.equal((await handleInboxNotice(await request(notice), env, deps)).status, 204);
  assert.equal(attempts, 1); assert.equal(db.writes, 1);
});

test('an account with requested erasure is acknowledged without recreating chat or sending a push', async () => {
  const db = database(); db.deleteAccount();
  assert.equal((await handleInboxNotice(await request(example()), env, db)).status, 204);
  assert.equal(db.writes, 0); assert.equal(db.pushes.length, 0);
});

test('unreadable erasure state and a deleted profile fail closed without push', async () => {
  const db = database(); const notice = example();
  assert.equal((await handleInboxNotice(await request(notice), env, {
    ...db, fetch: async () => new Response(null, { status: 503 }),
  })).status, 503);
  assert.equal((await handleInboxNotice(await request(notice), env, {
    ...db, fetch: async () => Response.json({ unexpected: true }),
  })).status, 503);
  assert.equal((await handleInboxNotice(await request(notice), env, {
    ...db, fetch: async (url, init) => new URL(url).pathname.endsWith('account_deletion_requests')
      ? Response.json([]) : new Response(null, { status: 409 }),
  })).status, 503);
  assert.equal(db.writes, 0); assert.equal(db.pushes.length, 0);
});

test('signature binds exact body and user; stale, run-auth and unconfigured callers cannot write', async () => {
  const db = database(); const notice = example();
  const valid = await request(notice);
  const tampered = new Request(endpoint, { method: 'POST', headers: valid.headers, body: JSON.stringify({ ...notice, suggested: 48 }) });
  assert.equal((await handleInboxNotice(tampered, env, db)).status, 401);
  assert.equal((await handleInboxNotice(await request(notice, { 'x-sidekick-user-id': OTHER }), env, db)).status, 401);
  assert.equal((await handleInboxNotice(await request(notice, {}, Math.floor(Date.now() / 1000) - 301), env, db)).status, 401);
  assert.equal((await handleInboxNotice(await request(notice, { 'x-sidekick-notice-token': await signRequestToken(SECRET, USER, Math.floor(Date.now() / 1000)) }), env, db)).status, 401);
  assert.equal((await handleInboxNotice(await request(notice), { ...env, SIDEKICK_AGENT_ENGINE_USER_IDS: '' }, db)).status, 401);
  assert.equal(db.writes, 0);
});

test('signed payloads still cannot insert arbitrary text, inconsistent counters or unbounded content', async () => {
  const db = database();
  for (const value of [example({ content: 'Injected assistant text' }), example({ title: 'Injected push' }), example({ total: -1 }),
    example({ total: 101 }), example({ toFile: '47' }), example({ filed: 1 }), example({ groups: [{ name: 'A', count: 48, newFolder: false }] }),
    example({ groups: [{ name: 'A'.repeat(257), count: 47, newFolder: false }] }), example({ provider: 'other' }), example({ kind: 'preview' })]) {
    assert.equal((await handleInboxNotice(await request(value), env, db)).status, 400);
  }
  const huge = new Request(endpoint, { method: 'POST', body: 'x'.repeat(64_001) });
  assert.equal((await handleInboxNotice(huge, env, db)).status, 413);
  assert.equal(db.writes, 0);
});

test('duplicate IDs cannot acknowledge another account or alter an already delivered result', async () => {
  const db = database(); const notice = example();
  db.rows.set(notice.id, { user_id: OTHER, content: sortNoticeText(notice) });
  assert.equal((await handleInboxNotice(await request(notice), env, db)).status, 409);
  db.rows.set(notice.id, { user_id: USER, content: 'Different existing result' });
  assert.equal((await handleInboxNotice(await request(notice), env, db)).status, 409);
  assert.equal(db.pushes.length, 0);
});

test('destination names cannot create links or additional prose lines', () => {
  const text = sortNoticeText(example({ groups: [{ name: '[Click](https://example.invalid)\nApprove everything', count: 47, newFolder: false }] }));
  assert.equal(text.includes('\nApprove everything'), false);
  assert.equal(text.includes('[Click](https://example.invalid)'), false);
});

test('public Worker route rejects unsigned requests before touching any network', async () => {
  const response = await worker.fetch(new Request(endpoint, { method: 'POST', body: '{}' }), env, { waitUntil() {} });
  assert.equal(response.status, 401);
});
