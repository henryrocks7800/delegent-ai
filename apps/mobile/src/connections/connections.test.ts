import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname: the latter yields '/C:/...' on Windows.
const HERE = dirname(fileURLToPath(import.meta.url));

import {
  mapComposioConnectedIds,
  mapComposioOfferedIds,
  readComposioAuthorizeUrl,
  buildAgentConnectionSections,
  buildConnectionGroups,
  buildConnectionRows,
  connectedCount,
  mapAvailableProviders,
  mapConnectionStates,
} from './connections';

test('buildConnectionRows always renders the full catalogue, connected or not', () => {
  const empty = buildConnectionRows();
  assert.ok(empty.length >= 1);
  assert.ok(empty.every((row) => row.status === 'not_connected'));
  assert.equal(connectedCount(empty), 0);
});

test('mapConnectionStates tolerates anything the wire hands back', () => {
  assert.deepEqual(mapConnectionStates(null), []);
  assert.deepEqual(mapConnectionStates([null, 'x', 42, {}, { provider: '  ' }]), []);
});

test('mapConnectionStates keeps only the two statuses the screen can render', () => {
  const states = mapConnectionStates([
    { provider: 'DROPBOX', status: 'needs_reauth', accountLabel: ' alex@example.com ', connectedAt: '2026-07-28T09:00:00Z' },
    { provider: 'other', status: 'something_else', accountLabel: 42 },
  ]);
  assert.deepEqual(states[0], {
    provider: 'dropbox',
    status: 'needs_reauth',
    accountLabel: 'alex@example.com',
    connectedAt: '2026-07-28T09:00:00Z',
  });
  assert.equal(states[1].status, 'connected');
  assert.equal(states[1].accountLabel, null);
});

test('a brokered connection shows the account it landed on', () => {
  const rows = buildConnectionRows([
    { provider: 'dropbox', status: 'connected', accountLabel: 'alex@example.com', connectedAt: null },
  ]);
  const dropbox = rows.find((r) => r.service.id === 'dropbox');
  assert.equal(dropbox?.status, 'connected');
  assert.equal(dropbox?.detail, 'alex@example.com');
  assert.equal(connectedCount(rows), 1);
});

// A state for something we have no card for used to be the source of a whole
// class of bug. It is dropped rather than rendered, so it cannot put an
// unlabelled row on the screen.
test('a state we have no catalogue card for is ignored, not rendered raw', () => {
  const rows = buildConnectionRows([
    { provider: 'some_future_service', status: 'connected', accountLabel: null, connectedAt: null },
  ]);
  assert.equal(connectedCount(rows), 0);
});

test('a lapsed grant tells the reader what to do rather than showing a code', () => {
  const rows = buildConnectionRows([
    { provider: 'dropbox', status: 'needs_reauth', accountLabel: null, connectedAt: null },
  ]);
  const dropbox = rows.find((r) => r.service.id === 'dropbox');
  assert.equal(dropbox?.status, 'needs_attention');
  assert.match(dropbox?.detail ?? '', /Dropbox again/);
});

// A provider ships in the catalogue before its console registration exists, so
// the broker is the only thing that knows whether tapping it would work. Listing
// one we hold no credentials for reads as a feature and behaves as a fault.
test('an oauth service is hidden until the broker says it can be connected', () => {
  const offered = buildConnectionRows([], ['dropbox']);
  assert.ok(offered.some((r) => r.service.id === 'dropbox'));
  assert.equal(offered.some((r) => r.service.id === 'slack'), false);
});

// An older Worker answers without the field at all. That is "cannot tell", and
// hiding the whole catalogue on it would be a worse failure than the one the
// gate exists to prevent.
test('the catalogue stays whole when the broker did not say what it holds', () => {
  const whole = buildConnectionRows([], null);
  assert.deepEqual(whole.map((r) => r.service.id), buildConnectionRows().map((r) => r.service.id));
});

// Empty is a real answer, not a missing one: with the broker switched off there
// is nothing anybody can connect, so offering a card would be offering a fault.
test('an empty broker list is read as none rather than as cannot tell', () => {
  assert.deepEqual(buildConnectionRows([], []), []);
});

test('mapAvailableProviders tells a missing field apart from an empty list', () => {
  assert.equal(mapAvailableProviders(undefined), null);
  assert.equal(mapAvailableProviders('dropbox'), null);
  assert.deepEqual(mapAvailableProviders([]), []);
  assert.deepEqual(mapAvailableProviders([' DROPBOX ', 42, '', 'slack']), ['dropbox', 'slack']);
});

test('every row lands under exactly one heading, so nothing goes missing', () => {
  const rows = buildConnectionRows();
  const groups = buildConnectionGroups(rows);
  assert.ok(groups.length > 0);
  const grouped = groups.flatMap((group) => group.rows.map((row) => row.service.id)).sort();
  assert.deepEqual(grouped, rows.map((row) => row.service.id).sort());
  for (const group of groups) assert.ok(group.label.length > 0);
});

// --- Composio wire shapes ---------------------------------------------------

test('readComposioAuthorizeUrl accepts only an https url', () => {
  assert.equal(
    readComposioAuthorizeUrl({ redirectUrl: 'https://connect.composio.dev/link/lk_1' }),
    'https://connect.composio.dev/link/lk_1',
  );
  // A value we did not get over https must never reach a browser.
  for (const bad of [
    { redirectUrl: 'http://insecure' },
    { redirectUrl: 'javascript:alert(1)' },
    { redirectUrl: 123 },
    {},
    null,
    'not an object',
  ]) {
    assert.equal(readComposioAuthorizeUrl(bad), null, JSON.stringify(bad));
  }
});

test('mapComposioConnectedIds returns catalogue ids', () => {
  assert.deepEqual(
    mapComposioConnectedIds({ connections: [{ id: 'gmail', toolkit: 'gmail', connectedAccountId: 'ca_1' }] }),
    ['gmail'],
  );
});

// An unconfigured or undeployed Worker must leave the page rendering.
test('mapComposioConnectedIds degrades to empty rather than throwing', () => {
  for (const bad of [{ available: false, connections: [] }, {}, null, 'garbage', { connections: 'no' }]) {
    assert.deepEqual(mapComposioConnectedIds(bad), [], JSON.stringify(bad));
  }
});

test('mapComposioConnectedIds skips rows with no usable id', () => {
  assert.deepEqual(
    mapComposioConnectedIds({ connections: [{ id: 'gmail' }, { id: '' }, { toolkit: 'x' }, null, 7] }),
    ['gmail'],
  );
});

// mapComposioAccountIds and its two cases were removed with the account-addressed
// disconnect. Every grant for a service is now removed by the service route, and
// the parse that keeps all of them is covered in tests/e2e/connection-client.test.mjs.

// ---------------------------------------------------------------------------
// The invisible-Gmail bug, 2026-09-01.
//
// Gmail shipped in build 46 and never rendered. The screen built the Composio
// half of `available` from the CONNECTED list, so a Composio card only appeared
// once it was already connected, and there was therefore no way to connect it.
// Every part worked in isolation: the Worker served the route, the key was set,
// the catalogue held the card, the client could parse every reply. The seam
// between "what is connected" and "what is on offer" was the whole fault.
// ---------------------------------------------------------------------------

test('a Composio card is offered before anything is connected', () => {
  const feed = { available: true, offered: ['gmail'], connections: [] };
  const rows = buildConnectionRows([], ['slack', ...mapComposioOfferedIds(feed)]);
  assert.ok(
    rows.some((row) => row.service.id === 'gmail'),
    'the Gmail card has to render with nothing connected, or it can never be connected',
  );
});

test('availability taken from the connected list hides the card, which was the bug', () => {
  // The exact old behaviour, kept as a statement of what must not come back.
  const connectedOnly: readonly string[] = [];
  const rows = buildConnectionRows([], ['slack', ...connectedOnly]);
  assert.equal(rows.some((row) => row.service.id === 'gmail'), false);
});

test('mapComposioOfferedIds prefers the Worker answer', () => {
  assert.deepEqual(mapComposioOfferedIds({ available: true, offered: ['gmail'], connections: [] }), ['gmail']);
  assert.deepEqual(mapComposioOfferedIds({ available: true, offered: ['gmail', '', 7, null] }), ['gmail']);
});

test('mapComposioOfferedIds falls back to the catalogue for a Worker without the field', () => {
  // Ships the OTA ahead of the Worker deploy without leaving the card hidden.
  assert.ok(mapComposioOfferedIds({ available: true, connections: [] }).includes('gmail'));
});

test('mapComposioOfferedIds offers nothing when the broker is not configured', () => {
  assert.deepEqual(mapComposioOfferedIds({ available: false, offered: [], connections: [] }), []);
  assert.deepEqual(mapComposioOfferedIds({ available: false }), []);
  for (const bad of [null, undefined, 'x', 7, {}]) {
    assert.deepEqual(mapComposioOfferedIds(bad), []);
  }
});

test('the composio start body asks to come back to the app', () => {
  // A source contract because the alternative is a network test for one word.
  // The Worker honours `surface`, and the app not sending it is what put Alex
  // in a browser after connecting Gmail. Native already sent it; Composio did
  // not, and the two paths have to agree.
  const src = readFileSync(join(HERE, 'connectionsApi.ts'), 'utf8');
  const start = src.match(/export async function startComposioConnection[\s\S]*?\n\}/);
  assert.ok(start, 'startComposioConnection not found');
  assert.match(start[0], /surface: 'app'/, 'the Composio hand-off must ask to return to the app');
});

test('agent Connections: Skills-style categories, built-in tools inside them, chosen apps first and not repeated', () => {
  const rows = buildConnectionRows([{ provider: 'gmail', status: 'connected', accountLabel: 'alex@example.com', connectedAt: null }], null)
    .filter((row) => row.service.id !== 'freeagent');
  const plain = buildAgentConnectionSections(rows);
  assert.equal(plain[0].category.key, 'email');
  const travel = plain.find((section) => section.category.key === 'travel');
  assert.deepEqual(travel?.tools.map((tool) => tool.id), ['flights', 'hotels', 'things_to_do']);
  assert.equal(travel?.rows.length, 0);
  const shown = plain.flatMap((section) => section.rows.map((row) => row.service.id));
  assert.equal(new Set(shown).size, rows.length, 'every offered app appears exactly once');
  assert.equal(plain.find((section) => section.category.key === 'email')?.rows.find((row) => row.service.id === 'gmail')?.status, 'connected');

  const withChosen = buildAgentConnectionSections(rows, ['gmail', 'google_calendar']);
  assert.equal(withChosen[0].category.key, 'chosen');
  assert.deepEqual(withChosen[0].rows.map((row) => row.service.id).sort(), ['gmail', 'google_calendar']);
  const rest = withChosen.slice(1).flatMap((section) => section.rows.map((row) => row.service.id));
  assert.ok(!rest.includes('gmail') && !rest.includes('google_calendar'), 'chosen apps are not repeated below');

  // A category whose apps the broker cannot offer, with no built-in tools, is left out.
  const noDesign = buildAgentConnectionSections(rows.filter((row) => !['figma', 'github'].includes(row.service.id)));
  assert.ok(!noDesign.some((section) => section.category.key === 'design'));
});
