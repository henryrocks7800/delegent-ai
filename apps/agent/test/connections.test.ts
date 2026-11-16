import assert from 'node:assert/strict';
import test from 'node:test';
import { connectedAppsLine, fetchConnectionStates } from '../src/connections.ts';
import { PRODUCT_TOOLKITS } from '../src/toolkits.ts';

const config = (slug: string) => PRODUCT_TOOLKITS.find((t) => t.slug === slug)!.authConfigId;
const row = (slug: string, status: string, extra: Record<string, unknown> = {}) => ({ toolkit: { slug }, status, auth_config: { id: config(slug) }, ...extra });

test("only the product's own auth configs count; active beats expired; disabled does not count", async () => {
  const pages = [
    { items: [row('gmail', 'EXPIRED'), row('trello', 'EXPIRED'), { toolkit: { slug: 'notion' }, status: 'ACTIVE', auth_config: { id: 'ac_someone_else' } }], next_cursor: 'p2' },
    { items: [row('gmail', 'ACTIVE'), row('stripe', 'ACTIVE', { is_disabled: true }), row('youtube', 'ACTIVE')], next_cursor: null },
  ];
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  }) as unknown as typeof fetch;
  const states = await fetchConnectionStates('key', 'user-1', { fetch: fake });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /user_ids=user-1/);
  assert.match(urls[0], /statuses=ACTIVE&statuses=EXPIRED/);
  assert.match(urls[1], /cursor=p2/);
  assert.equal(states.get('gmail'), 'connected');
  assert.equal(states.get('trello'), 'expired');
  assert.equal(states.get('youtube'), 'connected');
  assert.equal(states.has('notion'), false, 'another auth config is not ours');
  assert.equal(states.has('stripe'), false, 'a disabled account is not usable');
});

test('a failing lookup throws, so the caller falls back to checking', async () => {
  const fake = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(fetchConnectionStates('key', 'u', { fetch: fake }));
});

test('the prompt line lists connected and expired apps by name, in the app list order', () => {
  const line = connectedAppsLine(new Map([['youtube', 'connected'], ['gmail', 'connected'], ['trello', 'expired']]));
  assert.equal(line, "The user's apps, checked when this message arrived. Connected: Gmail, YouTube. Connection expired, so they need to reconnect it: Trello. Every other app in the list is not connected.");
  assert.match(connectedAppsLine(new Map()), /Connected: none yet\. Every other app/);
});
