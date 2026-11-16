/**
 * Sender-first bulk inbox sorting. Pure planning logic, shared by the engine's
 * background workflow and the local operator.
 *
 * The model judges senders, not emails: in a real 46,938-email Outlook inbox
 * the top 500 of 2,920 senders covered 87.5% of the mail and senders with two
 * or more emails covered 97.5%. Filing then uses the provider's own bulk
 * operations. Nothing here stores email content; callers decide persistence.
 */
export type SortProvider = 'gmail' | 'outlook';

/** Approved by Alex on 2026-09-22. "Junk" is Promotions: never deleted, never Spam. */
export const SORT_STANDARD_DESTINATIONS = [
  { key: 'newsletters', name: 'Newsletters', description: 'Newsletters, digests, blogs, mailing lists and regular content the person signed up to read.' },
  { key: 'promotions', name: 'Promotions', description: 'Marketing, sales, offers, discounts, adverts and other promotional mail, which people often call junk. Filed, never deleted.' },
  { key: 'shopping', name: 'Shopping & Orders', description: 'Order confirmations, dispatch and delivery updates, returns and marketplace messages about purchases.' },
  { key: 'invoices', name: 'Invoices & Receipts', description: 'Invoices, receipts, bills, statements, payment confirmations and refunds.' },
  { key: 'travel', name: 'Travel', description: 'Flights, trains, hotels, car hire, holiday bookings and travel updates.' },
  { key: 'social', name: 'Social', description: 'Notifications from social networks, community sites, forums and dating or messaging apps.' },
  { key: 'notifications', name: 'Notifications', description: 'Automated service notices and account updates that need no reply. Not security codes, login alerts or anything needing action.' },
] as const;

export const SORT_KEEP = 'keep';
/** Messages that could be a live security code or login alert stay in the inbox while recent. */
export const SORT_SECURITY_SUBJECT = /password|verification|verify|one[- ]time|\botp\b|sign[- ]?in|log[- ]?in|security (?:code|alert)|authentication|passcode|\b\d{6}\b/i;
export const SORT_SECURITY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Existing folders that are never a destination, whatever the model says. */
export const SORT_UNSUITABLE_FOLDER = /\b(junk|spam|trash|rubbish|delete|deleted|deletion|bin|quarantine|archive|archived|other|misc|miscellaneous|to sort|unsorted)\b/i;
/** Receipts, orders and bookings from a sender whose other mail is marketing. */
export const SORT_TRANSACTIONAL_SUBJECT = /\b(receipts?|invoices?|orders?|trips?|bookings?|reservations?|confirmation|confirmed|refunds?|payments?|paid|statements?|bills?|dispatched|shipped|delivered|delivery|tickets?|e-?tickets?|itinerary)\b/i;
const GMAIL_TRANSACTIONAL_SUBJECT = 'subject:(receipt OR invoice OR order OR trip OR booking OR reservation OR confirmation OR confirmed OR refund OR payment OR paid OR statement OR bill OR dispatched OR shipped OR delivered OR delivery OR ticket OR itinerary)';
/** Gmail inbox mail with no user label, not starred. Already organised or starred mail is never touched. */
export const GMAIL_SORT_BASE = 'in:inbox has:nouserlabels -is:starred';
/** Gmail's equivalent of the recent-security guard, applied to every Gmail search. */
export const GMAIL_SORT_SECURITY_GUARD = '-(newer_than:7d (subject:password OR subject:verification OR subject:verify OR subject:code OR subject:"sign in" OR subject:login OR subject:"security alert" OR subject:authentication))';
const GMAIL_QUERY_MAX = 1_400;

export interface CensusMessage {
  id: string;
  /** Lower-cased sender address. */
  sender: string;
  senderName?: string;
  /** Held in memory for sampling only; never persisted by this module. */
  subject?: string;
  receivedAt?: string;
  /** Outlook Focused inbox, Gmail Primary. */
  focused?: boolean;
  flagged?: boolean;
  unsubscribe?: boolean;
  categories?: string[];
  etag?: string;
  isRead?: boolean;
  folderId?: string;
  /** Meeting requests and similar items that must stay where they are. */
  keepInPlace?: boolean;
}

export interface SenderStat {
  address: string;
  name: string;
  domain: string;
  count: number;
  focused: number;
  unsubscribe: number;
  categories: Record<string, number>;
  /** Up to three recent subjects, clipped, for the model only. */
  samples: string[];
}

export interface SortDestination {
  key: string;
  name: string;
  description?: string;
  /** Existing folder/label ID, absent until a new destination is created. */
  existingId?: string;
  create: boolean;
  /** Named for one specific person, school, club or organisation: only a sender matching its name may go in. */
  named?: boolean;
}

const NAME_STOPWORDS = new Set(['email', 'emails', 'mail', 'mails', 'stuff', 'folder', 'the', 'and', 'of', 'for', 'my', 'from', 'school', 'schools', 'club', 'inbox', 'misc']);
const tokens = (value: string) => value.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Whether a sender plausibly is the one a named folder is for: every
 * distinctive word of the folder's own name (its last path segment) appears in
 * the sender's display name or address. "Northfield St Mary's" accepts
 * "Northfield St Marys CE Junior" but not "Northfield Infant and Nursery".
 */
export function senderMatchesFolderName(folderName: string, sender: { name?: string; address: string }): boolean {
  const own = folderName.split('/').pop() ?? folderName;
  const wanted = tokens(own).filter((token) => !NAME_STOPWORDS.has(token));
  if (!wanted.length) return false;
  const have = new Set([...tokens(sender.name ?? ''), ...tokens(sender.address)]);
  return wanted.every((token) => have.has(token));
}

export interface SortPlanCounts { total: number; keep: number; senders: number; byDestination: Record<string, number> }

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Safe inside a Gmail from:(...) group: no spaces, quotes, parentheses or braces. */
const GMAIL_SAFE_ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;

export function normaliseAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1];
  const address = (bracketed ?? value).trim().toLowerCase();
  return address.length <= 254 && ADDRESS.test(address) ? address : null;
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.replace(/<[^>]*>/g, '').replace(/["\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 80);
}

/** Group messages by sender, busiest first. Samples are clipped and never include bodies. */
export function senderCensus(messages: CensusMessage[], options: { maxSamples?: number; sampleLength?: number } = {}): SenderStat[] {
  const maxSamples = options.maxSamples ?? 3;
  const sampleLength = options.sampleLength ?? 100;
  const bySender = new Map<string, SenderStat>();
  for (const message of messages) {
    if (message.keepInPlace) continue;
    const stat = bySender.get(message.sender) ?? { address: message.sender, name: '', domain: message.sender.split('@')[1] ?? '',
      count: 0, focused: 0, unsubscribe: 0, categories: {}, samples: [] };
    stat.count += 1;
    if (!stat.name && message.senderName) stat.name = displayName(message.senderName);
    if (message.focused) stat.focused += 1;
    if (message.unsubscribe) stat.unsubscribe += 1;
    for (const category of message.categories ?? []) stat.categories[category] = (stat.categories[category] ?? 0) + 1;
    const subject = message.subject?.replace(/\s+/g, ' ').trim();
    if (subject && stat.samples.length < maxSamples && !stat.samples.includes(subject.slice(0, sampleLength))) stat.samples.push(subject.slice(0, sampleLength));
    bySender.set(message.sender, stat);
  }
  return [...bySender.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

/** A message stays put if it is flagged, not a normal message, or a recent possible security code. */
export function staysInInbox(message: CensusMessage, now: number): boolean {
  if (message.flagged || message.keepInPlace) return true;
  const received = message.receivedAt ? Date.parse(message.receivedAt) : Number.NaN;
  const recent = !Number.isFinite(received) || now - received < SORT_SECURITY_WINDOW_MS;
  return recent && SORT_SECURITY_SUBJECT.test(message.subject ?? '');
}

/**
 * Destination key per message, or null when it stays in the inbox. `split`
 * sends a mixed sender's receipts, orders and bookings to a second destination.
 */
export function destinationFor(message: CensusMessage, decisions: Record<string, string>, now: number, split: Record<string, string> = {}): string | null {
  if (staysInInbox(message, now)) return null;
  const transactional = split[message.sender];
  if (transactional && transactional !== SORT_KEEP && SORT_TRANSACTIONAL_SUBJECT.test(message.subject ?? '')) return transactional;
  const decision = decisions[message.sender];
  return decision && decision !== SORT_KEEP ? decision : null;
}

export function planCounts(messages: CensusMessage[], decisions: Record<string, string>, now: number, split: Record<string, string> = {}): SortPlanCounts {
  const byDestination: Record<string, number> = {};
  let keep = 0;
  const senders = new Set<string>();
  for (const message of messages) {
    senders.add(message.sender);
    const destination = destinationFor(message, decisions, now, split);
    if (destination) byDestination[destination] = (byDestination[destination] ?? 0) + 1;
    else keep += 1;
  }
  return { total: messages.length, keep, senders: senders.size, byDestination };
}

/**
 * Gmail searches that select exactly the given senders' eligible inbox mail,
 * chunked to stay well inside Gmail's query length. Unsafe addresses are
 * dropped rather than escaped: they cannot be expressed without risking a
 * broader match.
 */
export function gmailSenderQueries(addresses: string[], maxLength = GMAIL_QUERY_MAX, options: { transactional?: boolean } = {}): string[] {
  const safe = [...new Set(addresses.map((address) => address.toLowerCase()))].filter((address) => GMAIL_SAFE_ADDRESS.test(address) && ADDRESS.test(address)).sort();
  const prefix = `${GMAIL_SORT_BASE} ${GMAIL_SORT_SECURITY_GUARD} ${options.transactional ? `${GMAIL_TRANSACTIONAL_SUBJECT} ` : ''}from:(`;
  const queries: string[] = [];
  let current: string[] = [];
  const render = (items: string[]) => `${prefix}${items.join(' OR ')})`;
  for (const address of safe) {
    if (current.length && render([...current, address]).length > maxLength) { queries.push(render(current)); current = []; }
    current.push(address);
  }
  if (current.length) queries.push(render(current));
  return queries;
}

/** The existing destination with the same name, case-insensitively, if any. */
export function matchExisting(name: string, existing: { id: string; name: string }[]): { id: string; name: string } | undefined {
  const wanted = name.trim().toLowerCase();
  return existing.find((folder) => folder.name.trim().toLowerCase() === wanted);
}

/** Constant-size summary for chat and notices: counts and destination names only. */
export function sortSummary(destinations: SortDestination[], counts: SortPlanCounts) {
  const names = new Map(destinations.map((destination) => [destination.key, destination]));
  const rows = Object.entries(counts.byDestination)
    .map(([key, count]) => ({ name: names.get(key)?.name ?? key, count, newFolder: names.get(key)?.create === true }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total: counts.total, stayInInbox: counts.keep, toFile: counts.total - counts.keep, destinations: rows };
}
