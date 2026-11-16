import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverInboxNotice, inboxNoticeHeaders, INBOX_NOTICE_PATH } from '../src/inboxNotice.ts';
import type { SortNotice } from '../src/inboxSortStore.ts';

const notice = (): SortNotice => ({ kind: 'sort', id: crypto.randomUUID(), sortId: crypto.randomUUID(), provider: 'outlook', outcome: 'plan',
  total: 10, toFile: 6, stay: 4, filed: 0, groups: [{ name: 'Promotions', count: 6, newFolder: true }] });

test('delivery requires exact acknowledgement and does not follow redirects', async () => {
  for (const status of [200, 301, 401, 503, 204]) {
    let redirect: RequestRedirect | undefined;
    const delivered = await deliverInboxNotice({ apiBase: 'https://unit.invalid', secret: 'test', userId: crypto.randomUUID(), notice: notice(),
      fetch: async (_url, init) => { redirect = init?.redirect; return new Response(null, { status }); } });
    assert.equal(delivered, status === 204);
    assert.equal(redirect, 'manual');
  }
});

test('delivery refuses a non-https base or a missing secret, and a thrown fetch is a failed delivery', async () => {
  const fetch = async () => new Response(null, { status: 204 });
  assert.equal(await deliverInboxNotice({ apiBase: 'http://unit.invalid', secret: 'test', userId: 'u', notice: notice(), fetch }), false);
  assert.equal(await deliverInboxNotice({ apiBase: 'https://unit.invalid', secret: '', userId: 'u', notice: notice(), fetch }), false);
  assert.equal(await deliverInboxNotice({ apiBase: 'https://unit.invalid', secret: 'test', userId: 'u', notice: notice(),
    fetch: async () => { throw new Error('network'); } }), false);
});

test('the signature binds the user, the time and the exact body, and the path is fixed', async () => {
  const body = JSON.stringify(notice());
  const a = await inboxNoticeHeaders('secret', 'user-1', body, 1_789_000_000);
  assert.match(a['x-sidekick-notice-token'], /^v1\.[a-f0-9]{64}$/);
  assert.notEqual((await inboxNoticeHeaders('secret', 'user-2', body, 1_789_000_000))['x-sidekick-notice-token'], a['x-sidekick-notice-token']);
  assert.notEqual((await inboxNoticeHeaders('secret', 'user-1', `${body} `, 1_789_000_000))['x-sidekick-notice-token'], a['x-sidekick-notice-token']);
  assert.equal(INBOX_NOTICE_PATH, '/internal/inbox-notice');
});
