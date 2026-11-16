import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageModel } from 'ai';
import {
  GMAIL_SORT_BASE, GMAIL_SORT_SECURITY_GUARD, SORT_KEEP, destinationFor, gmailSenderQueries, normaliseAddress, planCounts,
  senderCensus, sortSummary, staysInInbox, type CensusMessage,
} from '../src/inboxSort.ts';
import { chooseSortDestinations, classifySortSenders, type SortModelRequest } from '../src/inboxSortModel.ts';
import { applyGmailSort, applyOutlookSort, SortRunError, type SortPlan } from '../src/inboxSortRun.ts';
import { GmailInboxProvider } from '../src/inboxGmail.ts';
import { OutlookInboxProvider } from '../src/inboxOutlook.ts';

const NOW = Date.parse('2026-09-22T12:00:00Z');
const OLD = '2026-01-01T00:00:00Z';
const model = () => 'fixture' as LanguageModel;
const step = { usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: { openrouter: { usage: { cost: 0.0001 } } }, finishReason: 'stop' };
const answer = (output: unknown) => async (request: SortModelRequest) => { request.onStepEnd(step); return { ...step, output }; };
const message = (id: string, sender: string, extra: Partial<CensusMessage> = {}): CensusMessage => ({ id, sender, receivedAt: OLD, subject: `Subject ${id}`, ...extra });

test('sort sources hold no raw control characters (a shell heredoc once turned regex escapes into them)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['inboxSort.ts', 'inboxSortModel.ts', 'inboxSortRun.ts', 'inboxGmail.ts', 'inboxOutlook.ts']) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, file);
  }
});

test('addresses are normalised from display forms and rejected when malformed', () => {
  assert.equal(normaliseAddress('Shop News <News@Shop.Example>'), 'news@shop.example');
  assert.equal(normaliseAddress('plain@example.co.uk'), 'plain@example.co.uk');
  assert.equal(normaliseAddress('not an address'), null);
  assert.equal(normaliseAddress('a@b'), null);
});

test('the census groups by sender, busiest first, with clipped samples and no in-place items', () => {
  const census = senderCensus([
    message('1', 'a@x.com', { senderName: 'A', subject: 'x'.repeat(300), unsubscribe: true }),
    message('2', 'b@y.com'), message('3', 'b@y.com', { focused: true }), message('4', 'b@y.com'),
    message('5', 'c@z.com', { keepInPlace: true }),
  ]);
  assert.deepEqual(census.map((sender) => [sender.address, sender.count]), [['b@y.com', 3], ['a@x.com', 1]]);
  assert.equal(census[1]!.samples[0]!.length, 100);
  assert.equal(census[1]!.unsubscribe, 1);
  assert.equal(census[0]!.focused, 1);
  assert.ok(census[0]!.samples.length <= 3);
});

test('flagged, in-place and recent security mail stays in the inbox; old security mail may be filed', () => {
  assert.equal(staysInInbox(message('1', 'a@x.com', { flagged: true }), NOW), true);
  assert.equal(staysInInbox(message('2', 'a@x.com', { keepInPlace: true }), NOW), true);
  assert.equal(staysInInbox(message('3', 'a@x.com', { subject: 'Your verification code is 123456', receivedAt: '2026-09-21T00:00:00Z' }), NOW), true);
  assert.equal(staysInInbox(message('4', 'a@x.com', { subject: 'Your verification code is 123456' }), NOW), false);
  assert.equal(staysInInbox(message('5', 'a@x.com', { subject: 'Weekly deals' , receivedAt: '2026-09-21T00:00:00Z' }), NOW), false);
  const decisions = { 'a@x.com': 'promotions', 'b@y.com': SORT_KEEP };
  assert.equal(destinationFor(message('6', 'a@x.com'), decisions, NOW), 'promotions');
  assert.equal(destinationFor(message('7', 'b@y.com'), decisions, NOW), null);
  assert.equal(destinationFor(message('8', 'unknown@y.com'), decisions, NOW), null);
  const counts = planCounts([message('6', 'a@x.com'), message('7', 'b@y.com'), message('9', 'a@x.com', { flagged: true })], decisions, NOW);
  assert.deepEqual(counts, { total: 3, keep: 2, senders: 2, byDestination: { promotions: 1 } });
  assert.deepEqual(sortSummary([{ key: 'promotions', name: 'Promotions', create: true }], counts),
    { total: 3, stayInInbox: 2, toFile: 1, destinations: [{ name: 'Promotions', count: 1, newFolder: true }] });
});

test('Gmail sender searches are inbox-only, guarded, chunked and drop unsafe addresses', () => {
  const addresses = Array.from({ length: 120 }, (_, index) => `sender${index}@example.com`);
  const queries = gmailSenderQueries([...addresses, 'evil)OR(in:anywhere@x.com', 'SENDER1@EXAMPLE.COM'], 400);
  assert.ok(queries.length > 1);
  for (const query of queries) {
    assert.ok(query.startsWith(`${GMAIL_SORT_BASE} ${GMAIL_SORT_SECURITY_GUARD} from:(`));
    assert.ok(query.length <= 400 || query.split(' OR ').length === 1);
    assert.doesNotMatch(query, /evil|in:anywhere/);
  }
  const all = queries.join(' ');
  for (const address of addresses) assert.ok(all.includes(address));
  assert.equal(all.split('sender1@example.com').length - 1, 1, 'deduplicated case-insensitively');
});

test('destinations reuse an equivalent existing folder, create the rest and exclude junk-like folders', async () => {
  const existing = [{ id: 'F1', name: 'Subscriptions & Newsletters' }, { id: 'F2', name: 'Hillside School' }, { id: 'F3', name: 'To delete' }];
  const result = await chooseSortDestinations({ model, existing }, { generate: async (request) => {
    const prompt = JSON.parse(request.prompt);
    assert.deepEqual(prompt.existing, { e0: 'Subscriptions & Newsletters', e1: 'Hillside School', e2: 'To delete' });
    return answer({ standard: [{ key: 'newsletters', use: 'e0' }, { key: 'promotions', use: 'e0' }, { key: 'travel', use: 'e2x' }], exclude: [], named: ['e1'] })(request);
  } });
  assert.ok(result.ok);
  const byKey = Object.fromEntries(result.destinations.map((destination) => [destination.key, destination]));
  assert.equal(byKey.e0!.existingId, 'F1');
  assert.match(byKey.e0!.description!, /Newsletters/);
  assert.equal(byKey.e1!.existingId, 'F2');
  assert.equal(byKey.e2, undefined, 'a folder named for deletion is never used, even when the model forgets to exclude it');
  assert.equal(byKey.newsletters, undefined, 'served by the existing folder');
  assert.equal(byKey.promotions!.create, true, 'Promotions never folds into a newsletters folder');
  assert.equal(byKey.travel!.create, true, 'an invalid answer falls back to creating the approved folder');
  assert.equal(byKey.shopping!.create, true);
});

test('sender decisions accept only supplied keys; missing, duplicate and invalid answers keep mail in the inbox', async () => {
  const destinations = [{ key: 'promotions', name: 'Promotions', create: true }, { key: 'e1', name: 'Hillside School', existingId: 'F2', create: false }];
  const senders = senderCensus([message('1', 'a@x.com'), message('2', 'b@y.com'), message('3', 'c@z.com'), message('4', 'd@w.com')]);
  const result = await classifySortSenders({ model, destinations, senders }, { generate: async (request) => {
    assert.doesNotMatch(request.prompt, /"id"|messageId/);
    assert.match(request.system, /anything you are unsure about/);
    assert.match(request.system, /First, the person's own folders/);
    return answer({ decisions: [{ s: 's0', d: 'promotions', t: 'e1' }, { s: 's1', d: 'e1', t: null }, { s: 's1', d: 'promotions', t: null }, { s: 's2', d: 'trash', t: null }, { s: 's3', d: 'keep', t: 'promotions' }] })(request);
  } });
  assert.ok(result.ok);
  assert.deepEqual(result.decisions, { 'a@x.com': 'promotions', 'b@y.com': SORT_KEEP, 'c@z.com': SORT_KEEP, 'd@w.com': SORT_KEEP });
  assert.deepEqual(result.split, { 'a@x.com': 'e1' }, 'a split refines a filed sender and never pulls a kept sender out');
  assert.deepEqual(result.usage, { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.0001 });
});

test('mixed senders: receipts, orders and trips follow the split, everything else the main decision', () => {
  const decisions = { 'uber@x.com': 'promotions' };
  const split = { 'uber@x.com': 'invoices' };
  assert.equal(destinationFor(message('1', 'uber@x.com', { subject: 'Your Tuesday evening trip with Uber' }), decisions, NOW, split), 'invoices');
  assert.equal(destinationFor(message('2', 'uber@x.com', { subject: '50% off your next ride' }), decisions, NOW, split), 'promotions');
});

test('junk-like existing folders are never destinations, even if the model picks them', async () => {
  const existing = [{ id: 'F1', name: 'Rubbish to Delete' }, { id: 'F2', name: 'Junk' }, { id: 'F3', name: 'Scouts' }];
  const result = await chooseSortDestinations({ model, existing }, { generate: answer({ standard: [{ key: 'promotions', use: 'e1' }], exclude: [], named: ['e2'] }) });
  assert.ok(result.ok);
  assert.deepEqual(result.destinations.filter((destination) => !destination.create).map((destination) => destination.name), ['Scouts']);
  assert.equal(result.destinations.find((destination) => destination.key === 'promotions')?.create, true);
});

const outlookPlan = (): SortPlan => ({ provider: 'outlook', mailboxEmail: 'me@example.com', createdAt: NOW,
  destinations: [{ key: 'promotions', name: 'Promotions', create: true }, { key: 'e1', name: 'School', existingId: 'F2', create: false }],
  decisions: { 'a@x.com': 'promotions', 'b@y.com': 'e1', 'c@z.com': SORT_KEEP }, counts: { total: 0, keep: 0, senders: 0, byDestination: {} },
  scanned: 0, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, timings: { censusMs: 0, modelMs: 0, countMs: 0 } });

test('Outlook filing moves only planned inbox mail with an etag, retries throttling and skips changed mail', async () => {
  const created: string[] = [];
  const batches: string[][] = [];
  let first = true;
  const provider = {
    listLabels: async () => [{ id: 'F2', name: 'School' }],
    createFolder: async (name: string) => { created.push(name); return { id: 'NEW', name }; },
    getSourceFolderId: () => 'INBOX',
    bulkMove: async (moves: { messageId: string; folderId: string }[]) => {
      batches.push(moves.map((move) => `${move.messageId}>${move.folderId}`));
      return moves.map((move) => {
        if (move.messageId === 'm3' && first) { first = false; return { messageId: move.messageId, error: Object.assign(new Error('x'), { status: 429 }) }; }
        if (move.messageId === 'm4') return { messageId: move.messageId, error: Object.assign(new Error('x'), { status: 412 }) };
        return { messageId: move.messageId, state: { id: move.messageId, folderId: move.folderId, isRead: false, etag: 'e' } };
      });
    },
  } as unknown as OutlookInboxProvider;
  const journal: { destinationKey: string; ids: string[] }[] = [];
  const census = [
    message('m1', 'a@x.com', { etag: 'e', folderId: 'INBOX' }), message('m2', 'b@y.com', { etag: 'e', folderId: 'INBOX' }),
    message('m3', 'a@x.com', { etag: 'e', folderId: 'INBOX' }), message('m4', 'a@x.com', { etag: 'e', folderId: 'INBOX' }),
    message('m5', 'c@z.com', { etag: 'e', folderId: 'INBOX' }), message('m6', 'a@x.com', { etag: 'e', folderId: 'INBOX', flagged: true }),
    message('m7', 'a@x.com', { folderId: 'INBOX' }), message('m8', 'a@x.com', { etag: 'e', folderId: 'ELSEWHERE' }),
  ];
  const result = await applyOutlookSort({ provider, plan: outlookPlan(), census, now: NOW, movesPerSecond: 10_000, retryDelayMs: 1, concurrency: 1,
    journal: (entry) => { journal.push({ destinationKey: entry.destinationKey, ids: entry.ids }); } });
  assert.deepEqual(created, ['Promotions']);
  assert.deepEqual(batches[0], ['m1>NEW', 'm2>F2', 'm3>NEW', 'm4>NEW']);
  assert.deepEqual(batches[1], ['m3>NEW'], 'only the throttled move is retried');
  assert.equal(result.moved, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(journal.flatMap((entry) => entry.ids).sort(), ['m1', 'm2', 'm3']);
});

test('Gmail filing creates missing labels, loops until the search is empty and refuses a no-op success', async () => {
  const plan: SortPlan = { ...outlookPlan(), provider: 'gmail', destinations: [{ key: 'promotions', name: 'Promotions', create: true }],
    gmailQueries: [{ key: 'promotions', query: `${GMAIL_SORT_BASE} from:(a@x.com)` }], counts: { total: 3, keep: 0, senders: 1, byDestination: { promotions: 3 } } };
  let inbox = ['g1', 'g2', 'g3'];
  const filed: string[][] = [];
  const provider = {
    listLabels: async () => [],
    createLabel: async (name: string) => ({ id: 'Label_1', name }),
    listIds: async () => ({ ids: inbox.slice(0, 2), nextPageToken: null }),
    fileMessages: async (ids: string[], labelId: string) => { assert.equal(labelId, 'Label_1'); filed.push(ids); inbox = inbox.filter((id) => !ids.includes(id)); },
  } as unknown as GmailInboxProvider;
  const result = await applyGmailSort({ provider, plan });
  assert.deepEqual(filed, [['g1', 'g2'], ['g3']]);
  assert.equal(result.moved, 3);
  const stuck = { ...provider, fileMessages: async () => undefined, listIds: async () => ({ ids: ['g9'], nextPageToken: null }) } as unknown as GmailInboxProvider;
  await assert.rejects(applyGmailSort({ provider: stuck, plan }), (error: unknown) => error instanceof SortRunError && error.code === 'FILING_NOT_APPLIED');
});

type Call = { url: string; body: Record<string, unknown> };
function composioFetch(respond: (call: Call) => unknown, calls: Call[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    return new Response(JSON.stringify(respond(call)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('Gmail adapter: searches must be inbox searches and filing only adds a user label and removes INBOX', async () => {
  const calls: Call[] = [];
  const provider = new GmailInboxProvider({ apiKey: 'k', userId: 'user_1', connectionId: 'ca_1', fetch: composioFetch((call) => {
    if (call.url.includes('/connected_accounts/')) return { id: 'ca_1', user_id: 'user_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } };
    if (call.url.includes('GMAIL_GET_PROFILE')) return { successful: true, data: { response_data: { emailAddress: 'me@example.com' } } };
    if (call.url.includes('GMAIL_LIST_LABELS')) return { successful: true, data: { labels: [{ id: 'Label_7', name: 'Promotions', type: 'user' }] } };
    if (String(call.body.endpoint).includes('/messages?')) return { status: 200, data: { messages: [{ id: 'abc' }], nextPageToken: 'n1' } };
    return { status: 204, data: null };
  }, calls) });
  await provider.resolveAccount();
  await assert.rejects(provider.listIds('from:(a@x.com)'), /invalid_input/);
  const page = await provider.listIds(`${GMAIL_SORT_BASE} from:(a@x.com)`);
  assert.deepEqual(page, { ids: ['abc'], nextPageToken: 'n1' });
  await assert.rejects(provider.fileMessages(['abc'], 'TRASH'), /custom_label_required/);
  await provider.fileMessages(['abc'], 'Label_7');
  const modify = calls.find((call) => String(call.body.endpoint).endsWith('/messages/batchModify'))!;
  assert.deepEqual(modify.body.body, { ids: ['abc'], addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] });
  assert.equal(modify.body.connected_account_id, 'ca_1');
});

test('Outlook adapter: the census keeps meeting requests and etag-less items in place, and folder creation reuses a name', async () => {
  const calls: Call[] = [];
  const provider = new OutlookInboxProvider({ apiKey: 'k', userId: 'user_1', connectionId: 'ca_2', fetch: composioFetch((call) => {
    if (call.url.includes('/connected_accounts/')) return { id: 'ca_2', user_id: 'user_1', status: 'ACTIVE', toolkit: { slug: 'outlook' } };
    if (call.url.includes('GET_PROFILE')) return { successful: true, data: { response_data: { mail: 'me@example.com' } } };
    const endpoint = String(call.body.endpoint);
    if (endpoint.endsWith('/$batch')) return { status: 200, data: { responses: (call.body.body as { requests: { id: string }[] }).requests.map((request) => request.id === 'inbox'
      ? { id: 'inbox', status: 200, body: { id: 'INBOXID' } } : { id: request.id, status: 404, body: {} }) } };
    if (endpoint.includes('/v1.0/me/mailFolders?')) return { status: 200, data: { value: [{ id: 'F1', displayName: 'Promotions', parentFolderId: 'R', childFolderCount: 0, isHidden: false }] } };
    if (endpoint.includes('/mailFolders/inbox/messages')) return { status: 200, data: { value: [
      { id: 'M1', '@odata.etag': 'W/"1"', from: { emailAddress: { address: 'News@Shop.Example', name: 'Shop' } }, subject: 'Sale', receivedDateTime: '2026-09-20T00:00:00Z', inferenceClassification: 'other', flag: { flagStatus: 'notFlagged' }, isRead: false, parentFolderId: 'INBOXID' },
      { id: 'M2', '@odata.etag': 'W/"2"', '@odata.type': '#microsoft.graph.eventMessage', from: { emailAddress: { address: 'boss@work.example' } }, subject: 'Meeting', receivedDateTime: '2026-09-19T00:00:00Z', isRead: true, parentFolderId: 'INBOXID' },
      { id: 'M3', from: { emailAddress: { address: 'x@y.example' } }, subject: 'No etag', receivedDateTime: '2026-09-18T00:00:00Z', isRead: true, parentFolderId: 'INBOXID' },
    ] } };
    return { status: 500, data: {} };
  }, calls) });
  await provider.resolveAccount();
  await provider.listLabels();
  const page = await provider.censusPage('2026-09-22T00:00:00Z');
  assert.equal(page.full, false);
  assert.equal(page.oldest, '2026-09-18T00:00:00Z');
  assert.deepEqual(page.messages.map((m) => [m.id, m.sender, m.keepInPlace === true, m.focused]), [
    ['M1', 'news@shop.example', false, false], ['M2', 'boss@work.example', true, false], ['M3', 'x@y.example', true, false]]);
  const census = calls.find((call) => String(call.body.endpoint).includes('/mailFolders/inbox/messages'))!;
  assert.match(String(census.body.endpoint), /receivedDateTime\+le\+2026-09-22T00%3A00%3A00\.000Z|receivedDateTime%20le%202026-09-22T00%3A00%3A00\.000Z/);
  assert.deepEqual(await provider.createFolder('promotions'), { id: 'F1', name: 'Promotions' });
  assert.equal(calls.filter((call) => call.body.method === 'POST' && String(call.body.endpoint).endsWith('/v1.0/me/mailFolders')).length, 0);
});

test('Outlook filing steps read a census page straight after resolving the account (the Workflow order)', async () => {
  const calls: Call[] = [];
  const provider = new OutlookInboxProvider({ apiKey: 'k', userId: 'user_1', connectionId: 'ca_2', fetch: composioFetch((call) => {
    if (call.url.includes('/connected_accounts/')) return { id: 'ca_2', user_id: 'user_1', status: 'ACTIVE', toolkit: { slug: 'outlook' } };
    if (call.url.includes('GET_PROFILE')) return { successful: true, data: { response_data: { mail: 'me@example.com' } } };
    const endpoint = String(call.body.endpoint);
    if (endpoint.endsWith('/$batch')) return { status: 200, data: { responses: (call.body.body as { requests: { id: string }[] }).requests.map((request) => request.id === 'inbox'
      ? { id: 'inbox', status: 200, body: { id: 'INBOXID' } } : { id: request.id, status: 404, body: {} }) } };
    if (endpoint.includes('/v1.0/me/mailFolders?')) return { status: 200, data: { value: [{ id: 'F1', displayName: 'Promotions', parentFolderId: 'R', childFolderCount: 0, isHidden: false }] } };
    if (endpoint.includes('/mailFolders/inbox/messages')) return { status: 200, data: { value: [
      { id: 'M1', '@odata.etag': 'W/"1"', from: { emailAddress: { address: 'News@Shop.Example', name: 'Shop' } }, subject: 'Sale', receivedDateTime: '2026-09-20T00:00:00Z', inferenceClassification: 'other', flag: { flagStatus: 'notFlagged' }, isRead: false, parentFolderId: 'INBOXID' },
      { id: 'M2', '@odata.etag': 'W/"2"', '@odata.type': '#microsoft.graph.eventMessage', from: { emailAddress: { address: 'boss@work.example' } }, subject: 'Meeting', receivedDateTime: '2026-09-19T00:00:00Z', isRead: true, parentFolderId: 'INBOXID' },
      { id: 'M3', from: { emailAddress: { address: 'x@y.example' } }, subject: 'No etag', receivedDateTime: '2026-09-18T00:00:00Z', isRead: true, parentFolderId: 'INBOXID' },
    ] } };
    return { status: 500, data: {} };
  }, calls) });
  // The Workflow's filing step does exactly this: resolveAccount, then a page, with no listLabels in between.
  await provider.resolveAccount();
  const page = await provider.censusPage('2026-09-22T00:00:00Z');
  assert.equal(page.messages.length, 3);
  assert.ok(page.messages.every((m) => m.folderId === 'INBOXID'));
  assert.equal(provider.getSourceFolderId(), 'INBOXID');
  assert.ok(calls.some((call) => String(call.body.endpoint).endsWith('/$batch')), 'the folder IDs were looked up first');
});

test('a folder named for one school or person only takes a sender whose name matches it', async () => {
  const { senderMatchesFolderName } = await import('../src/inboxSort.ts');
  assert.equal(senderMatchesFolderName("Northfield St Mary's", { name: 'Northfield St Marys CE Junior', address: 'office@teachers2parents.co.uk' }), true);
  assert.equal(senderMatchesFolderName("Northfield St Mary's", { name: 'Northfield Infant and Nursery', address: 'office@northfield-infant.example.sch.uk' }), false);
  assert.equal(senderMatchesFolderName('Alex Emails', { name: 'Alex Example', address: 'alex@example.com' }), true);
  assert.equal(senderMatchesFolderName('IBM', { name: 'Alex Example', address: 'alex@uk.ibm.com' }), true);
  assert.equal(senderMatchesFolderName('Scouts', { name: 'RunThrough', address: 'hello@runthrough.co.uk' }), false);
  assert.equal(senderMatchesFolderName('Hillside School', { name: 'Northfield Infant and Nursery', address: 'office@northfield-infant.example.sch.uk' }), false);
  const destinations = [{ key: 'e1', name: "Northfield St Mary's", existingId: 'F1', create: false, named: true },
    { key: 'e2', name: 'Hillside School', existingId: 'F2', create: false, named: true }, { key: 'promotions', name: 'Promotions', create: true }];
  const senders = senderCensus([message('1', 'office@teachers2parents.co.uk', { senderName: 'Northfield St Marys CE Junior' }),
    message('2', 'office@northfield-infant.example.sch.uk', { senderName: 'Northfield Infant and Nursery' }), message('3', 'hello@runthrough.co.uk', { senderName: 'RunThrough' })]);
  const result = await classifySortSenders({ model, destinations, senders }, { generate: async (request) => {
    const prompt = JSON.parse(request.prompt);
    const key = (address: string) => Object.entries(prompt.senders as Record<string, { address: string }>).find(([, value]) => value.address === address)![0];
    const junior = key('office@teachers2parents.co.uk'); const infant = key('office@northfield-infant.example.sch.uk'); const running = key('hello@runthrough.co.uk');
    assert.deepEqual(prompt.senders[junior].nameMatchesFolder, ['e1']);
    assert.equal(prompt.senders[infant].nameMatchesFolder, undefined);
    return answer({ decisions: [{ s: junior, d: 'e1', t: null }, { s: infant, d: 'e1', t: null }, { s: running, d: 'e2', t: 'promotions' }] })(request);
  } });
  assert.ok(result.ok);
  assert.deepEqual(result.decisions, { 'office@teachers2parents.co.uk': 'e1', 'office@northfield-infant.example.sch.uk': SORT_KEEP, 'hello@runthrough.co.uk': SORT_KEEP });
  assert.deepEqual(result.split, {});
});
