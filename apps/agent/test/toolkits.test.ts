import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APP_GROUPS, APP_NAMES, NO_AUTH_TOOLKITS, PRELOADED_TOOLS, PRODUCT_TOOLKITS, STRIPE_READ_ONLY_TOOLS, appCatalogueText } from '../src/toolkits.ts';

const workerComposio = readFileSync(new URL('../../worker/src/composio.ts', import.meta.url), 'utf8');

test("the agent uses exactly the Worker's Composio toolkits and auth configs", () => {
  const block = workerComposio.slice(workerComposio.indexOf('export const COMPOSIO_TOOLKITS'));
  const listed = block.slice(0, block.indexOf('\n];'));
  const worker = [...listed.matchAll(/\{ slug: '([a-z_]+)', authConfigId: '([^']+)'/g)].map((m) => ({ slug: m[1], authConfigId: m[2] }));
  assert.ok(worker.length >= 30, `parsed ${worker.length} toolkits from composio.ts`);
  assert.deepEqual([...PRODUCT_TOOLKITS], worker);
});

test('Stripe stays read-only, the promise the Worker keeps with its pattern', () => {
  assert.match(workerComposio, /slug: 'stripe'[^\n]*allowTools: \/\^STRIPE_\(LIST\|RETRIEVE\|SEARCH\)_\//);
  assert.ok(STRIPE_READ_ONLY_TOOLS.length > 50);
  for (const tool of STRIPE_READ_ONLY_TOOLS) assert.match(tool, /^STRIPE_(LIST|RETRIEVE|SEARCH)_/);
});

test('everyday tools need no sign-in: web, travel and things to do', () => {
  for (const toolkit of ['composio_search', 'weathermap', 'trivago_mcp', 'viator_mcp']) {
    assert.ok(NO_AUTH_TOOLKITS.includes(toolkit), toolkit);
  }
  assert.ok(!NO_AUTH_TOOLKITS.includes('taskrabbit_mcp'), 'Taskrabbit only takes US bookings');
  assert.ok(PRELOADED_TOOLS.length <= 8, 'preloaded tools cost prompt tokens on every reply (cached after the first step)');
});

test('the calendar read that is preloaded works with the calendar.events grant (live QA, 2026-09-23)', () => {
  assert.ok(PRELOADED_TOOLS.includes('GOOGLECALENDAR_EVENTS_LIST'));
  assert.ok(!PRELOADED_TOOLS.includes('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'), 'listing calendars needs a scope the grant does not include');
});

test('the app list in the prompt names every product app exactly once', () => {
  const listed = APP_GROUPS.flatMap(([, slugs]) => slugs);
  assert.deepEqual([...listed].sort(), PRODUCT_TOOLKITS.map((t) => t.slug).sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const slug of listed) assert.ok(appCatalogueText().includes(APP_NAMES[slug]), slug);
});

test('Confluence is described by what its grant allows: pages, not search or the space list (QA F12, 2026-09-23)', () => {
  const line = appCatalogueText().split('\n').find((l) => l.includes('Confluence')) ?? '';
  assert.match(line, /Confluence \(pages: find one by listing pages and matching the title, and take a spaceId from a listed page/);
  assert.match(line, /search and the space list are not available/);
});
