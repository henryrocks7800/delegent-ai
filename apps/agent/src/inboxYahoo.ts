/**
 * Yahoo Mail (and AOL Mail), read-only, over IMAP with the OAuth token we
 * broker ourselves (apps/worker/src/connections-oauth.ts, provider yahoo_mail).
 *
 * Libraries, not hand-rolled protocol: imapflow speaks IMAP (implicit TLS on
 * 993, the only mode the Workers runtime supports) and postal-mime turns a raw
 * message into sender, subject, date and text. Nothing here can send, move,
 * flag or delete: the grant is mail-r, and the only IMAP commands used are
 * LIST, SELECT (read-only via EXAMINE), SEARCH and FETCH.
 */
import { ImapFlow, type SearchObject } from 'imapflow';
import PostalMime from 'postal-mime';

export type YahooToken = { accessToken: string; account: string };
export type YahooMessage = { id: string; from: string; subject: string; date: string; text: string };

/** The few IMAP operations we use, so tests can stand in for a server. */
export interface YahooImapSession {
  mailboxes(): Promise<{ path: string; specialUse?: string }[]>;
  search(mailbox: string, criteria: SearchObject): Promise<number[]>;
  source(mailbox: string, uid: number, maxBytes: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export class YahooInboxProviderError extends Error {
  readonly code: string;
  constructor(code: string) { super(`yahoo_inbox_${code.toLowerCase()}`); this.code = code; }
}
const fail = (code: string): never => { throw new YahooInboxProviderError(code); };

const MESSAGE_MAX_BYTES = 256 * 1024;
const TEXT_MAX_CHARS = 20_000;

/** AOL addresses sign in through Yahoo's accounts but read mail from AOL's server. */
export function yahooImapHost(account: string): string {
  return /@(aol|aim)\.[a-z.]+$/i.test(account) ? 'imap.aol.com' : 'imap.mail.yahoo.com';
}

function imapSession(token: YahooToken): YahooImapSession {
  const client = new ImapFlow({
    host: yahooImapHost(token.account), port: 993, secure: true,
    auth: { user: token.account, accessToken: token.accessToken },
    logger: false, disableAutoIdle: true, emitLogs: false,
  });
  let connected: Promise<void> | null = null;
  const ready = () => (connected ??= client.connect());
  const withMailbox = async <T>(path: string, work: () => Promise<T>) => {
    await ready();
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try { return await work(); } finally { lock.release(); }
  };
  return {
    async mailboxes() {
      await ready();
      return (await client.list()).map((box) => ({ path: box.path, specialUse: box.specialUse }));
    },
    search: (mailbox, criteria) => withMailbox(mailbox, async () => (await client.search(criteria, { uid: true })) || []),
    source: (mailbox, uid, maxBytes) => withMailbox(mailbox, async () => {
      const message = await client.fetchOne(String(uid), { source: { maxLength: maxBytes } }, { uid: true });
      return message && message.source ? new Uint8Array(message.source) : null;
    }),
    async close() { if (connected) await client.logout().catch(() => undefined); },
  };
}

export function createYahooInboxProvider(options: {
  getToken: () => Promise<YahooToken>;
  session?: (token: YahooToken) => YahooImapSession;
}) {
  let session: YahooImapSession | null = null;
  let account: string | null = null;
  const open = () => session ?? fail('ACCOUNT_NOT_VERIFIED');
  return {
    async resolveAccount() {
      const token = await options.getToken();
      if (!token.accessToken || !/^[^@\s]+@[^@\s]+$/.test(token.account)) return fail('ACCOUNT_NOT_CONNECTED');
      account = token.account.toLowerCase();
      session = (options.session ?? imapSession)(token);
      return { mailboxEmail: account };
    },
    /** Message IDs matching the criteria in the inbox and archive, newest first. */
    async searchIds(criteria: SearchObject, max: number): Promise<string[]> {
      if (!Number.isInteger(max) || max < 1 || max > 500) return fail('INVALID_INPUT');
      const imap = open();
      const boxes = await imap.mailboxes();
      // Inbox and the archive only: never spam, trash, drafts or sent.
      const paths = boxes.filter((box) => box.path.toUpperCase() === 'INBOX' || box.specialUse === '\\Archive').map((box) => box.path);
      const found: { path: string; uid: number }[] = [];
      for (const path of paths.length ? paths : ['INBOX']) {
        for (const uid of await imap.search(path, criteria)) if (Number.isSafeInteger(uid) && uid > 0) found.push({ path, uid });
      }
      // UIDs rise with arrival within a mailbox; take the newest from each, interleaved by UID.
      return found.sort((a, b) => b.uid - a.uid).slice(0, max).map(({ path, uid }) => `${encodeURIComponent(path)}|${uid}`);
    },
    async messageText(id: string): Promise<YahooMessage> {
      const match = /^([^|]{1,300})\|(\d{1,12})$/.exec(id);
      if (!match) return fail('INVALID_INPUT');
      const source = await open().source(decodeURIComponent(match[1]!), Number(match[2]), MESSAGE_MAX_BYTES);
      if (!source) return fail('MESSAGE_NOT_FOUND');
      const email = await PostalMime.parse(source);
      const from = email.from ? [email.from.name, email.from.address ? `<${email.from.address}>` : ''].filter(Boolean).join(' ') : '';
      const text = email.text || (email.html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
      return { id, from: from.slice(0, 512), subject: (email.subject ?? '').slice(0, 500), date: email.date ?? '',
        text: text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX_CHARS) };
    },
    async close() { await session?.close(); session = null; },
  };
}
