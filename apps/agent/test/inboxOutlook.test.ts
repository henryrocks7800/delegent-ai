import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutlookInboxProvider, OutlookInboxProviderError } from '../src/inboxOutlook.ts';

const USER = 'synthetic-user'; const CONNECTION = 'ca_synthetic'; const EMAIL = 'synthetic@example.test';
const INBOX = 'inbox-id+='; const DEST = 'school-id+='; const MESSAGE = 'immutable+'.concat('A'.repeat(130), '=');
const connected = { id: CONNECTION, user_id: USER, status: 'ACTIVE', toolkit: { slug: 'outlook' } };
const profile = { successful: true, data: { response_data: { mail: EMAIL } } };
const proxy = (data: unknown, status = 200) => ({ status, data });
const folder = (id: string, displayName: string, childFolderCount = 0) => ({ id, displayName, childFolderCount, isHidden: false });
const systems = proxy({ responses: ['archive', 'clutter', 'conflicts', 'conversationhistory', 'deleteditems', 'drafts',
  'inbox', 'junkemail', 'localfailures', 'msgfolderroot', 'outbox', 'recoverableitemsdeletions',
  'scheduled', 'searchfolders', 'sentitems', 'serverfailures', 'syncissues'].map(name => ({
  id: name, status: 200, body: { id: name === 'inbox' ? INBOX : `${name}-id` },
})) });
const labels = proxy({ value: [folder(INBOX, 'Localized inbox'), folder('deleteditems-id', 'Not called trash', 1), folder(DEST, 'School')] });
const state = { id: MESSAGE, parentFolderId: INBOX, isRead: false, '@odata.etag': 'W/"synthetic"' };
type Call = { path: string; body: any; init?: RequestInit };
function fixture(responses: unknown[], override: Record<string, unknown> = {}) {
  const calls: Call[] = []; const pending = [...responses];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : null, init });
    assert.ok(pending.length, 'unexpected provider call');
    const next = pending.shift(); if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  };
  return { calls, pending, provider: createOutlookInboxProvider({ apiKey: 'synthetic-secret', userId: USER,
    connectionId: CONNECTION, expectedMailboxEmail: EMAIL, fetch: fetcher, ...override }) };
}
const code = (value: string) => (error: unknown) => error instanceof OutlookInboxProviderError && error.code === value;

test('Outlook rejects wrong account ownership, toolkit, mailbox and unverified operations', async () => {
  for (const [value, expected] of [
    [{ ...connected, user_id: 'other' }, 'ACCOUNT_OWNER_MISMATCH'],
    [{ ...connected, id: 'other' }, 'ACCOUNT_ID_MISMATCH'],
    [{ ...connected, toolkit: { slug: 'gmail' } }, 'ACCOUNT_NOT_ACTIVE_OUTLOOK'],
  ] as const) {
    const f = fixture([value]); await assert.rejects(f.provider.resolveAccount(), code(expected)); assert.equal(f.calls.length, 1);
  }
  const f = fixture([connected, { successful: true, data: { mail: 'other@example.test' } }]);
  await assert.rejects(f.provider.resolveAccount(), code('MAILBOX_MISMATCH'));
  await assert.rejects(f.provider.censusPage('2026-09-22T00:00:00Z'), code('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(f.provider.listLabels(), code('ACCOUNT_NOT_VERIFIED'));
});

test('Outlook follows complete root and child folder pages and excludes system IDs independent of locale', async () => {
  const rootNext = `https://graph.microsoft.com/v1.0/me/mailFolders?${new URLSearchParams({ $top: '100', $select: 'id,displayName,parentFolderId,childFolderCount,isHidden', $skip: '100' })}`;
  const f = fixture([connected, profile, systems,
    proxy({ value: [folder(INBOX, 'Inbox'), folder('deleteditems-id', 'Custom sounding', 1), folder(DEST, 'School', 1)], '@odata.nextLink': rootNext }),
    proxy({ value: [folder('receipts-id', 'Receipts')] }), proxy({ value: [folder('child-id', 'Trips')] }),
  ]);
  await f.provider.resolveAccount();
  assert.deepEqual(await f.provider.listLabels(), [{ id: DEST, name: 'School' }, { id: 'receipts-id', name: 'Receipts' }, { id: 'child-id', name: 'School/Trips' }]);
  assert.equal(f.provider.getSourceFolderId(), INBOX);
  assert.equal(f.calls.filter(call => call.body?.endpoint?.includes('childFolders')).length, 1);
  assert.equal(f.pending.length, 0);
});

test('Outlook errors contain neither credentials nor echoed provider content; redirects are not followed', async () => {
  const marker = 'synthetic-private-provider-body';
  for (const response of [new Response(marker, { status: 302, headers: { location: 'https://attacker.example' } }), proxy({ error: { message: marker } }, 429)]) {
    const f = fixture([connected, profile, response]); await f.provider.resolveAccount();
    await assert.rejects(f.provider.listLabels(), error => {
      assert.ok(error instanceof OutlookInboxProviderError); assert.ok(!JSON.stringify(error).includes(marker));
      assert.ok(!String(error).includes('synthetic-secret')); return true;
    });
  }
});

test('Outlook batch bounds and complete input validation prevent any partial dispatch', async () => {
  const f = fixture([connected, profile, systems, labels]);
  await f.provider.resolveAccount();
  const move = { messageId: MESSAGE, folderId: DEST, expectedState: { id: MESSAGE, folderId: INBOX, isRead: false, etag: 'W/"original"' } };
  const moves = (ids: string[]) => ids.map((id) => ({ ...move, messageId: id, expectedState: { ...move.expectedState, id } }));
  for (const ids of [[], [MESSAGE, MESSAGE], ['invalid id'], Array.from({ length: 21 }, (_, i) => `id-${i}`)]) {
    await assert.rejects(f.provider.bulkMove(moves(ids)), code('INVALID_INPUT')); assert.equal(f.calls.length, 2);
  }
  await assert.rejects(f.provider.bulkMove([move]), code('FOLDERS_NOT_VERIFIED'));
  await f.provider.listLabels();
  for (const bad of [
    { ...move, messageId: 'other', expectedState: { ...move.expectedState, id: 'other', folderId: 'foreign' } },
    { ...move, messageId: 'other', folderId: 'deleteditems-id', expectedState: { ...move.expectedState, id: 'other' } },
    { ...move, messageId: 'other', expectedState: { ...move.expectedState, id: 'other', etag: 'bad\r\nheader' } },
  ]) {
    await assert.rejects(f.provider.bulkMove([move, bad]), error => error instanceof OutlookInboxProviderError);
    assert.equal(f.calls.length, 4, 'all input validation precedes the only POST');
  }
});

test('Outlook batch moves scope every POST to the source and keep per-message immutable and concurrency headers', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `immutable-${i}`);
  const f = fixture([connected, profile, systems, labels, proxy({ responses: ids.map((id, index) => ({
    id: String(index), status: 201, body: { ...state, id, parentFolderId: DEST },
  })).reverse() })]);
  await f.provider.resolveAccount(); await f.provider.listLabels();
  const output = await f.provider.bulkMove(ids.map(id => ({ messageId: id, folderId: DEST,
    expectedState: { id, folderId: INBOX, isRead: false, etag: `W/"${id}"` } })));
  assert.deepEqual(output.map(row => row.state?.id), ids);
  assert.equal(f.calls.length, 5, 'one dispatch, with no folder refresh between guard and POST');
  const writes = f.calls[4].body.body.requests;
  assert.equal(writes.length, 20);
  for (const [index, row] of writes.entries()) {
    assert.equal(row.method, 'POST');
    assert.equal(row.url, `/me/mailFolders/${encodeURIComponent(INBOX)}/messages/${ids[index]}/move`);
    assert.deepEqual(row.body, { destinationId: DEST });
    assert.deepEqual(row.headers, { Prefer: 'IdType="ImmutableId"', 'Content-Type': 'application/json', 'If-Match': `W/"${ids[index]}"` });
    assert.equal(row.dependsOn, undefined, 'Graph applies its documented Outlook concurrency limit');
  }
});

test('Outlook partial move responses are not retried and each failed or unverified member is explicit', async () => {
  const ids = ['first', 'second', 'third'];
  const f = fixture([connected, profile, systems, labels, proxy({ responses: [
    { id: '0', status: 201, body: { ...state, id: ids[0], parentFolderId: DEST } },
    { id: '1', status: 429, body: { error: { message: 'private' } } },
    { id: '2', status: 201, body: { ...state, id: ids[2], parentFolderId: DEST, isRead: true } },
  ] })]);
  await f.provider.resolveAccount(); await f.provider.listLabels();
  const result = await f.provider.bulkMove(ids.map(id => ({ messageId: id, folderId: DEST,
    expectedState: { id, folderId: INBOX, isRead: false, etag: 'original' } })));
  assert.equal(result[0].state?.folderId, DEST); assert.equal(result[1].error?.status, 429);
  assert.equal(result[2].error?.code, 'MOVE_NOT_VERIFIED'); assert.equal(f.calls.length, 5);
});

test('Outlook aborted batch makes one attempt and cannot leak the thrown provider error', async t => {
  const f = fixture([connected, profile, systems, labels, new Error('private-secret')]);
  await f.provider.resolveAccount(); await f.provider.listLabels();
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  await assert.rejects(f.provider.bulkMove([{ messageId: MESSAGE, folderId: DEST,
    expectedState: { id: MESSAGE, folderId: INBOX, isRead: false, etag: 'original' } }]), error => {
    assert.ok(error instanceof OutlookInboxProviderError); assert.equal(error.code, 'TIMEOUT');
    assert.ok(!String(error).includes('private-secret')); return true;
  });
  assert.equal(f.calls.length, 5);
});
