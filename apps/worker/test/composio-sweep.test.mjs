// Two defects found on the 2026-09-02 review of the Gmail connector, after
// every connector-level test was green. Neither is visible from a phone.
//
//  - Account deletion swept our own OAuth table and never looked at Composio,
//    so a deleted account left its Gmail grant live at Composio while the
//    privacy policy said deleting the account deletes every stored token.
//  - The connected-accounts read was unfiltered and unpaged. Every Connect tap
//    creates a record and abandoned ones linger as INITIATED/EXPIRED, so a page
//    of dead records could push the one live connection off the first page and
//    read as "not connected" for a connected customer.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  disconnectComposioService,
  listConnections,
  listOwnedComposioAccounts,
  revokeAllComposioConnections,
} from '../dist/composio.js';

const ENV = { COMPOSIO_API_KEY: 'ak_test' };
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('listConnections asks Composio for ACTIVE accounts only, with a page big enough to hold them', async () => {
  let url = null;
  await listConnections(ENV, 'user-1', {
    fetchImpl: async (input) => { url = String(input); return ok({ items: [] }); },
  });
  assert.match(url, /statuses=ACTIVE/, 'dead records must be filtered server side, not by us on page one');
  assert.match(url, /limit=100/, 'an unset limit is whatever Composio feels like today');
});

test('revokeAllComposioConnections deletes every account and reports each outcome honestly', async () => {
  const deleted = [];
  const res = await revokeAllComposioConnections(ENV, 'user-1', {
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (init && init.method === 'DELETE') {
        deleted.push(url.split('/').pop());
        return url.endsWith('ca_bad') ? new Response('nope', { status: 500 }) : ok({});
      }
      return ok({ items: [
        { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_bad', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      ] });
    },
  });
  assert.deepEqual(deleted, ['ca_1', 'ca_bad'], 'every account must be attempted, a failure must not stop the rest');
  // What actually happened, not what we hoped: the failed one is named so the
  // deletion audit can say a grant was left behind rather than assume it went.
  assert.deepEqual(res, { revoked: ['ca_1'], failed: ['ca_bad'], complete: true });
});

test('revokeAllComposioConnections on a Worker with no key is a clean no-op', async () => {
  assert.deepEqual(await revokeAllComposioConnections({}, 'user-1'), { revoked: [], failed: [], complete: true });
});

test('revokeAllComposioConnections reports an unreadable list rather than pretending it was empty', async () => {
  const res = await revokeAllComposioConnections(ENV, 'user-1', {
    fetchImpl: async () => { throw new Error('composio down'); },
  });
  // "*" is the sweep saying it could not even find out. An empty list here would
  // be the failed read reported as an answer, which is the mistake this whole
  // codebase keeps writing comments about.
  assert.deepEqual(res, { revoked: [], failed: ['*'], complete: false });
});

// ---------------------------------------------------------------------------
// The 2026-09-13 review of the same code. The sweep above was built on the
// DISPLAY list, which is filtered to ACTIVE, allowlisted toolkits on one page,
// so it reported a clean deletion while leaving behind every record the display
// filter hides. The same single-account thinking let a service-level Disconnect
// remove one of two live grants and tell the reader access had stopped.
// ---------------------------------------------------------------------------

const page = (items, nextCursor) => ok(nextCursor ? { items, next_cursor: nextCursor } : { items });

test('the owned inventory is every status, every toolkit and every page', async () => {
  const asked = [];
  const res = await listOwnedComposioAccounts(ENV, 'user-1', {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      asked.push(url.search);
      return url.searchParams.get('cursor') === 'page2'
        ? page([{ id: 'ca_3', status: 'EXPIRED', toolkit: { slug: 'gmail' } }])
        : page([
          { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
          // Disabled, so the display list hides it. It still exists at Composio
          // and can be re-enabled, which is exactly why deletion must see it.
          { id: 'ca_2', status: 'INACTIVE', toolkit: { slug: 'gmail' } },
          // A toolkit this build no longer offers. Still our customer's grant.
          { id: 'ca_4', status: 'ACTIVE', toolkit: { slug: 'a_toolkit_we_dropped' } },
        ], 'page2');
    },
  });
  assert.ok(res.ok);
  assert.equal(res.value.complete, true);
  assert.deepEqual(res.value.accounts.map((a) => a.connectedAccountId), ['ca_1', 'ca_2', 'ca_4', 'ca_3']);
  assert.deepEqual(res.value.accounts.map((a) => a.status), ['ACTIVE', 'INACTIVE', 'ACTIVE', 'EXPIRED']);
  // A dropped toolkit has no catalogue id, and is still owned.
  assert.equal(res.value.accounts.find((a) => a.connectedAccountId === 'ca_4').connectionId, null);
  assert.equal(asked.length, 2);
  assert.doesNotMatch(asked[0], /statuses=/, 'a status filter here is what hid the records');
  assert.match(asked[0], /user_ids=user-1/, 'and it must still be scoped to one customer');
  assert.match(asked[1], /cursor=page2/);
});

test('an inventory that cannot be finished says so instead of reading as empty', async () => {
  // A later page failing leaves what was read, marked incomplete.
  const partial = await listOwnedComposioAccounts(ENV, 'user-1', {
    fetchImpl: async (input) => (new URL(String(input)).searchParams.get('cursor')
      ? new Response('nope', { status: 500 })
      : page([{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }], 'page2')),
  });
  assert.ok(partial.ok);
  assert.equal(partial.value.complete, false);
  assert.equal(partial.value.accounts.length, 1);

  // The FIRST page failing is an unreadable inventory, not an empty one.
  const unreadable = await listOwnedComposioAccounts(ENV, 'user-1', {
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(unreadable.ok, false);

  // A provider looping on one cursor is stopped rather than followed.
  let calls = 0;
  const looping = await listOwnedComposioAccounts(ENV, 'user-1', {
    fetchImpl: async () => { calls++; return page([{ id: 'ca_' + calls, status: 'ACTIVE', toolkit: { slug: 'gmail' } }], 'same'); },
  });
  assert.ok(looping.ok);
  assert.equal(looping.value.complete, false);
  assert.equal(calls, 2, 'the repeated cursor must stop it, not the page bound');
});

test('the sweep now reaches what the display list hides', async () => {
  const deleted = [];
  const res = await revokeAllComposioConnections(ENV, 'user-1', {
    fetchImpl: async (input, init) => {
      if (init && init.method === 'DELETE') { deleted.push(String(input).split('/').pop()); return ok({}); }
      return page([
        { id: 'ca_active', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_inactive', status: 'INACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_dropped', status: 'ACTIVE', toolkit: { slug: 'a_toolkit_we_dropped' } },
      ]);
    },
  });
  assert.deepEqual(deleted, ['ca_active', 'ca_inactive', 'ca_dropped']);
  assert.deepEqual(res, { revoked: ['ca_active', 'ca_inactive', 'ca_dropped'], failed: [], complete: true });
});

test('an incomplete sweep is reported, because an empty failure list would read as a clean one', async () => {
  const res = await revokeAllComposioConnections(ENV, 'user-1', {
    fetchImpl: async (input, init) => {
      if (init && init.method === 'DELETE') return ok({});
      return new URL(String(input)).searchParams.get('cursor')
        ? new Response('nope', { status: 500 })
        : page([{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }], 'page2');
    },
  });
  assert.deepEqual(res, { revoked: ['ca_1'], failed: [], complete: false });
});

test('disconnecting a service removes every grant it holds, not the first one found', async () => {
  const deleted = [];
  const res = await disconnectComposioService(ENV, 'user-1', 'gmail', {
    fetchImpl: async (input, init) => {
      if (init && init.method === 'DELETE') { deleted.push(String(input).split('/').pop()); return ok({}); }
      return page([
        { id: 'ca_one', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_two', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        // Another service's grant is untouched: Disconnect names one card.
        { id: 'ca_other', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' } },
      ]);
    },
  });
  assert.ok(res.ok);
  assert.deepEqual(deleted, ['ca_one', 'ca_two']);
  assert.deepEqual(res.value, { removed: ['ca_one', 'ca_two'], failed: [], complete: true });
});

test('a service disconnect reports the grant it could not remove, and refuses an unknown service', async () => {
  const res = await disconnectComposioService(ENV, 'user-1', 'gmail', {
    fetchImpl: async (input, init) => {
      if (init && init.method === 'DELETE') {
        return String(input).endsWith('ca_stuck') ? new Response('nope', { status: 500 }) : ok({});
      }
      return page([
        { id: 'ca_gone', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_stuck', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      ]);
    },
  });
  assert.ok(res.ok);
  assert.deepEqual(res.value, { removed: ['ca_gone'], failed: ['ca_stuck'], complete: true });

  const unknown = await disconnectComposioService(ENV, 'user-1', 'not_a_service', {
    fetchImpl: async () => { throw new Error('must not reach Composio'); },
  });
  assert.deepEqual(unknown, { ok: false, error: 'unknown_toolkit' });
});

test('a service disconnect never deletes an id it was handed rather than one it owns', async () => {
  // The inventory read is the ownership check. Somebody else's account id is
  // simply not in it, so nothing is deleted and nothing is claimed.
  const deleted = [];
  const res = await disconnectComposioService(ENV, 'user-1', 'gmail', {
    fetchImpl: async (input, init) => {
      if (init && init.method === 'DELETE') { deleted.push(String(input)); return ok({}); }
      assert.match(String(input), /user_ids=user-1/);
      return page([{ id: 'ca_someone_else', status: 'ACTIVE', toolkit: { slug: 'slack' } }]);
    },
  });
  assert.ok(res.ok);
  assert.deepEqual(deleted, []);
  assert.deepEqual(res.value, { removed: [], failed: [], complete: true });
});
