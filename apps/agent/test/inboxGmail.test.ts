import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGmailInboxProvider,
  GmailInboxProviderError,
  GMAIL_RESPONSE_MAX_BYTES,
  type GmailInboxProviderOptions,
} from '../src/inboxGmail.ts';

const USER = 'user_123';
const ACCOUNT = 'ca_gmail_123';
const EMAIL = 'test@example.com';
const MESSAGE = '19a00bca12cde123';
const connected = { id: ACCOUNT, user_id: USER, toolkit: { slug: 'gmail' }, status: 'ACTIVE' };
const profile = { successful: true, data: { response_data: { emailAddress: EMAIL } } };
const listedLabels = { successful: true, data: { labels: [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' },
  { id: 'Label_1', name: 'Work / Projects', type: 'user' },
  { id: 'Label_2', name: 'Receipts', type: 'user' },
] } };
type Call = { url: URL; init: RequestInit | undefined; body: Record<string, unknown> | null };

function fixture(responses: unknown[], options: Partial<GmailInboxProviderOptions> = {}) {
  const calls: Call[] = [];
  const pending = [...responses];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    assert.ok(pending.length, 'unexpected provider request');
    const next = pending.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  };
  const provider = createGmailInboxProvider({ apiKey: 'test-api-key', userId: USER, expectedMailboxEmail: EMAIL, fetch: fetcher, ...options });
  return { provider, calls, pending };
}
const resolved = (...responses: unknown[]) => [{ items: [connected], next_cursor: null }, profile, ...responses];
const errorCode = (code: string) => (error: unknown) => error instanceof GmailInboxProviderError && error.code === code;

test('all data methods require verified account identity first', async () => {
  const { provider, calls } = fixture([]);
  await assert.rejects(provider.listLabels(), errorCode('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(provider.listIds('in:inbox has:nouserlabels'), errorCode('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(provider.messageHeaders(MESSAGE), errorCode('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(provider.createLabel('Promotions'), errorCode('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(provider.fileMessages([MESSAGE], 'Label_1'), errorCode('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(provider.restoreMessages([MESSAGE], 'Label_1'), errorCode('ACCOUNT_NOT_VERIFIED'));
  assert.equal(calls.length, 0);
});

test('resolves the exact user-owned active Gmail account and validates its profile', async () => {
  const { provider, calls } = fixture(resolved());
  assert.deepEqual(await provider.resolveAccount(), { connectionId: ACCOUNT, mailboxEmail: EMAIL });
  assert.equal(calls[0]!.url.origin, 'https://backend.composio.dev');
  assert.equal(calls[0]!.url.searchParams.get('user_ids'), USER);
  assert.equal(calls[0]!.url.searchParams.get('statuses'), 'ACTIVE');
  assert.deepEqual(calls[1]!.body, { user_id: USER, connected_account_id: ACCOUNT, arguments: { user_id: 'me' } });
  assert.equal(calls[1]!.url.pathname, '/api/v3/tools/execute/GMAIL_GET_PROFILE');
  assert.equal(calls[0]!.init?.redirect, 'manual');
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
});

test('an explicit account must still match owner, identity and provider', async () => {
  const good = fixture([connected, profile], { connectionId: ACCOUNT });
  await good.provider.resolveAccount();
  assert.equal(good.calls[0]!.url.pathname, `/api/v3/connected_accounts/${ACCOUNT}`);
  for (const [connection, code] of [
    [{ ...connected, user_id: 'someone_else' }, 'ACCOUNT_OWNER_MISMATCH'],
    [{ ...connected, status: 'EXPIRED' }, 'ACCOUNT_NOT_ACTIVE_GMAIL'],
    [{ ...connected, toolkit: { slug: 'outlook' } }, 'ACCOUNT_NOT_ACTIVE_GMAIL'],
    [{ ...connected, id: 'ca_other' }, 'ACCOUNT_ID_MISMATCH'],
  ] as const) {
    const bad = fixture([connection], { connectionId: ACCOUNT });
    await assert.rejects(bad.provider.resolveAccount(), errorCode(code));
    assert.equal(bad.calls.length, 1, 'never execute a profile tool on a mismatched account');
  }
});

test('wrong mailbox, missing profile identity and wrong list owner fail closed', async () => {
  const wrong = fixture([{ items: [connected] }, { successful: true, data: { response_data: { emailAddress: 'other@example.com' } } }]);
  await assert.rejects(wrong.provider.resolveAccount(), errorCode('MAILBOX_MISMATCH'));
  await assert.rejects(wrong.provider.listLabels(), errorCode('ACCOUNT_NOT_VERIFIED'));
  const missing = fixture([{ items: [connected] }, { successful: true, data: {} }]);
  await assert.rejects(missing.provider.resolveAccount(), errorCode('INVALID_RESPONSE'));
  const owner = fixture([{ items: [{ ...connected, user_id: 'other' }] }]);
  await assert.rejects(owner.provider.resolveAccount(), errorCode('ACCOUNT_OWNER_MISMATCH'));
});

test('multiple active Gmail accounts are ambiguous, including on subsequent pages', async () => {
  const { provider, calls } = fixture([
    { items: [connected], next_cursor: 'page-two' },
    { items: [{ ...connected, id: 'ca_second' }], next_cursor: null },
  ]);
  await assert.rejects(provider.resolveAccount(), errorCode('ACCOUNT_AMBIGUOUS'));
  assert.equal(calls[1]!.url.searchParams.get('cursor'), 'page-two');
  assert.equal(calls.some((call) => call.url.pathname.includes('/tools/execute/')), false);
});

test('no account and an incomplete or cyclic connection listing never choose another user', async () => {
  await assert.rejects(fixture([{ items: [] }]).provider.resolveAccount(), errorCode('ACCOUNT_NOT_FOUND'));
  const cycle = fixture([{ items: [connected], next_cursor: 'again' }, { items: [connected], next_cursor: 'again' }]);
  await assert.rejects(cycle.provider.resolveAccount(), errorCode('INVALID_RESPONSE'));
  const incomplete = fixture(Array.from({ length: 10 }, (_, i) => ({ items: [connected], next_cursor: `page-${i}` })));
  await assert.rejects(incomplete.provider.resolveAccount(), errorCode('ACCOUNT_LIST_INCOMPLETE'));
});

test('failed re-verification invalidates prior successful identity', async () => {
  const { provider } = fixture([...resolved(), { items: [] }]);
  await provider.resolveAccount();
  await assert.rejects(provider.resolveAccount(), errorCode('ACCOUNT_NOT_FOUND'));
  await assert.rejects(provider.listLabels(), errorCode('ACCOUNT_NOT_VERIFIED'));
});

test('custom labels preserve names and IDs while system labels are excluded', async () => {
  const { provider } = fixture(resolved(listedLabels));
  await provider.resolveAccount();
  assert.deepEqual(await provider.listLabels(), [{ id: 'Label_1', name: 'Work / Projects' }, { id: 'Label_2', name: 'Receipts' }]);
});

test('system or nonexistent destination labels never reach a bulk change', async () => {
  for (const destination of ['UNREAD', 'TRASH', 'SPAM', 'INBOX', 'Label_missing']) {
    const { provider, calls } = fixture(resolved(listedLabels));
    await provider.resolveAccount();
    await assert.rejects(provider.fileMessages([MESSAGE], destination), errorCode('CUSTOM_LABEL_REQUIRED'));
    assert.equal(calls.length, 3, 'refused after the label check, before any batchModify');
  }
});

test('HTTP, provider and network errors never expose credentials or remote message content', async () => {
  const secret = 'private-mail-subject-and-test-api-key';
  const http = fixture([new Response(secret, { status: 403 })]);
  await assert.rejects(http.provider.resolveAccount(), (error: unknown) => error instanceof GmailInboxProviderError && error.status === 403 && !String(error).includes(secret));
  const tool = fixture([{ items: [connected] }, { successful: false, error: secret }]);
  await assert.rejects(tool.provider.resolveAccount(), errorCode('TOOL_FAILED'));
  const network = fixture([new Error(secret)]);
  await assert.rejects(network.provider.resolveAccount(), (error: unknown) => errorCode('UNAVAILABLE')(error) && !String(error).includes(secret));
  assert.equal(network.calls.length, 1, 'no implicit retries, particularly important for later writes');
  const malformed = fixture([new Response(secret)]);
  await assert.rejects(malformed.provider.resolveAccount(), errorCode('INVALID_RESPONSE'));
});

test('response size is bounded before JSON parsing even without Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(512 * 1024)); },
    cancel() { cancelled = true; },
  });
  const streamed = fixture([new Response(stream)]);
  await assert.rejects(streamed.provider.resolveAccount(), errorCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  const declared = fixture([new Response('{}', { headers: { 'content-length': String(GMAIL_RESPONSE_MAX_BYTES + 1) } })]);
  await assert.rejects(declared.provider.resolveAccount(), errorCode('RESPONSE_TOO_LARGE'));
});

test('aborted requests return a sanitized timeout error', async () => {
  const timeout = fixture([new DOMException('private server details', 'TimeoutError')]);
  await assert.rejects(timeout.provider.resolveAccount(), errorCode('TIMEOUT'));
});
