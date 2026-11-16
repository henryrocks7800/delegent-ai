import assert from 'node:assert/strict';
import test from 'node:test';
import { createYahooInboxProvider, yahooImapHost, type YahooImapSession } from '../src/inboxYahoo.ts';
import { ConnectionTokenError, fetchConnectionToken } from '../src/connectionToken.ts';
import { yahooMoneySearches } from '../src/moneyFinder.ts';
import { hmacHex } from '../src/internal.ts';

const raw = (subject: string, body: string) => new TextEncoder().encode(
  `From: BA <noreply@ba.example>\r\nSubject: ${subject}\r\nDate: Tue, 20 Jul 2021 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);

function fakeSession(boxes: Record<string, number[]>, messages: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const session: YahooImapSession = {
    async mailboxes() { return [{ path: 'INBOX' }, { path: 'Archive', specialUse: '\\Archive' }, { path: 'Bulk', specialUse: '\\Junk' }, { path: 'Trash', specialUse: '\\Trash' }, { path: 'Sent', specialUse: '\\Sent' }]; },
    async search(mailbox) { calls.push(`search ${mailbox}`); return boxes[mailbox] ?? []; },
    async source(mailbox, uid) { calls.push(`fetch ${mailbox} ${uid}`); return messages[`${mailbox}|${uid}`] ?? null; },
    async close() { calls.push('close'); },
  };
  return { session, calls };
}

test('reads only the inbox and archive, newest first, and turns a raw message into text', async () => {
  const f = fakeSession({ INBOX: [3, 9], Archive: [5], Bulk: [100], Trash: [101] }, { 'INBOX|9': raw('Your BA452 flight has been cancelled', 'We are sorry.') });
  const yahoo = createYahooInboxProvider({ getToken: async () => ({ accessToken: 't', account: 'Me@Yahoo.co.uk' }), session: () => f.session });
  await assert.rejects(yahoo.searchIds({ subject: 'x' }, 10), /account_not_verified/);
  assert.deepEqual(await yahoo.resolveAccount(), { mailboxEmail: 'me@yahoo.co.uk' });
  assert.deepEqual(await yahoo.searchIds({ subject: 'cancelled' }, 2), ['INBOX|9', 'Archive|5']);
  assert.ok(!f.calls.some((c) => /Bulk|Trash|Sent/.test(c)), 'never spam, trash or sent');
  const message = await yahoo.messageText('INBOX|9');
  assert.deepEqual([message.subject, message.from, message.text], ['Your BA452 flight has been cancelled', 'BA <noreply@ba.example>', 'We are sorry.']);
  await assert.rejects(yahoo.messageText('../etc'), /invalid_input/);
  await yahoo.close();
  assert.equal(f.calls.at(-1), 'close');
});

test('AOL addresses read from AOL\'s server; everything else from Yahoo', () => {
  assert.equal(yahooImapHost('someone@aol.com'), 'imap.aol.com');
  assert.equal(yahooImapHost('someone@aim.com'), 'imap.aol.com');
  assert.equal(yahooImapHost('someone@yahoo.co.uk'), 'imap.mail.yahoo.com');
  assert.equal(yahooImapHost('someone@ymail.com'), 'imap.mail.yahoo.com');
});

test('a missing or broken connection never opens a mailbox', async () => {
  let opened = false;
  const yahoo = createYahooInboxProvider({ getToken: async () => ({ accessToken: '', account: '' }), session: () => { opened = true; return fakeSession({}, {}).session; } });
  await assert.rejects(yahoo.resolveAccount(), /account_not_connected/);
  assert.equal(opened, false);
});

test('the token request is signed over the exact body, and errors map to plain codes', async () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
  const ok = await fetchConnectionToken({ apiBase: 'https://api.example.test', secret: 's3cret', userId: USER, provider: 'yahoo_mail',
    fetch: async (url, init) => { seen = { url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) };
      return Response.json({ accessToken: 'tok', account: 'me@yahoo.com', expiresAt: null }); } });
  assert.deepEqual(ok, { accessToken: 'tok', account: 'me@yahoo.com' });
  assert.equal(seen!.url, 'https://api.example.test/internal/connection-token');
  assert.equal(seen!.body, '{"provider":"yahoo_mail"}');
  const time = seen!.headers['x-sidekick-token-timestamp']!;
  assert.equal(seen!.headers['x-sidekick-token-signature'], `v1.${await hmacHex('s3cret', `connection-token:v1:${USER}:${time}:${seen!.body}`)}`);
  for (const [status, code] of [[404, 'not_connected'], [409, 'needs_reauth'], [503, 'unavailable']] as const) {
    await assert.rejects(fetchConnectionToken({ apiBase: 'https://api.example.test', secret: 's', userId: USER, provider: 'yahoo_mail', fetch: async () => new Response(null, { status }) }),
      (error: unknown) => error instanceof ConnectionTokenError && error.code === code);
  }
  await assert.rejects(fetchConnectionToken({ apiBase: 'http://api.example.test', secret: 's', userId: USER, provider: 'yahoo_mail' }), /unavailable/);
});

test('Yahoo searches are the same three, bounded by date', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const searches = yahooMoneySearches(now);
  assert.deepEqual(searches.map((s) => s.key), ['travel', 'refunds', 'subscriptions']);
  assert.equal((searches[0]!.criteria.since as Date).getUTCFullYear(), 2020);
  assert.ok(searches.every((s) => Array.isArray(s.criteria.or) && s.criteria.or.length > 0));
});
