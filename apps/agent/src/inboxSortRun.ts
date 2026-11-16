/**
 * Plan and apply a sender-first bulk sort for one mailbox. Used by the engine's
 * background workflow and by the local operator. Provider adapters own identity
 * and every write guard; this module owns pacing, batching and the plan.
 *
 * What leaves memory: the plan (destinations, sender decisions, counts) and the
 * journal of moved message IDs. Never a subject or a body.
 */
import type { LanguageModel } from 'ai';
import type { GmailInboxProvider } from './inboxGmail.ts';
import { OUTLOOK_BULK_MOVE_SIZE, type OutlookBatchMove, type OutlookInboxProvider } from './inboxOutlook.ts';
import {
  GMAIL_SORT_BASE, SORT_KEEP, destinationFor, gmailSenderQueries, matchExisting, normaliseAddress, planCounts, senderCensus,
  displayName, type CensusMessage, type SortDestination, type SortPlanCounts, type SortProvider,
} from './inboxSort.ts';
import { addSortUsage, chooseSortDestinations, classifySortSenders, emptySortUsage, SORT_SENDER_BATCH, type SortModelDependencies, type SortModelUsage } from './inboxSortModel.ts';

export const GMAIL_CENSUS_MAX = 2_000;
export const OUTLOOK_CENSUS_MAX = 100_000;
const MODEL_CONCURRENCY = 8;
const GMAIL_HEADER_CONCURRENCY = 8;

export interface SortPlan {
  provider: SortProvider;
  mailboxEmail: string;
  createdAt: number;
  destinations: SortDestination[];
  /** Sender address to destination key, or keep. Deleted once filing ends. */
  decisions: Record<string, string>;
  counts: SortPlanCounts;
  /** Mixed senders: where their receipts, orders and bookings go instead. */
  split?: Record<string, string>;
  /** Gmail only: the searches that select each destination's mail, in the order they run. */
  gmailQueries?: { key: string; query: string }[];
  /** Gmail only: messages sampled to learn senders; the searches reach further back. */
  sampled?: number;
  /** Messages seen by the census (Outlook: the whole inbox). */
  scanned: number;
  /** Senders left in the inbox because the model could not answer for them, and why. */
  unclassified?: number;
  failures?: Record<string, number>;
  usage: SortModelUsage;
  timings: { censusMs: number; modelMs: number; countMs: number };
}

export interface SortProgress { phase: 'census' | 'classify' | 'count' | 'create' | 'file'; done: number; total?: number }
export type SortJournal = (entry: { destinationKey: string; folderId: string; ids: string[] }) => void | Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;
const retryable = (error: unknown) => {
  const status = statusOf(error); const code = (error as { code?: string } | null)?.code;
  return status === 429 || (typeof status === 'number' && status >= 500) || code === 'TIMEOUT' || code === 'UNAVAILABLE' || code === 'RATE_LIMITED';
};

/** Reads only. Retries throttling, gateway errors and timeouts with backoff. */
export async function withReadRetry<T>(work: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt + 1 >= attempts || !retryable(error)) throw error;
      await sleep(Math.min(16_000, 1_000 * 2 ** attempt));
    }
  }
}

async function pool<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!, index); }
  }));
  return results;
}

/** Choose destinations once, then judge every sender in parallel batches. */
async function decide(input: { model: () => LanguageModel | Promise<LanguageModel>; existing: { id: string; name: string }[]; census: CensusMessage[];
  purpose?: string; onProgress?: (progress: SortProgress) => void }, dependencies: SortModelDependencies) {
  const usage = emptySortUsage();
  const chosen = await chooseSortDestinations({ model: input.model, existing: input.existing, ...(input.purpose ? { purpose: input.purpose } : {}) }, dependencies);
  addSortUsage(usage, chosen.usage);
  if (!chosen.ok) throw new SortRunError('DESTINATIONS_UNAVAILABLE');
  const senders = senderCensus(input.census.filter((message) => message.sender));
  const batches: typeof senders[] = [];
  for (let offset = 0; offset < senders.length; offset += SORT_SENDER_BATCH) batches.push(senders.slice(offset, offset + SORT_SENDER_BATCH));
  const decisions: Record<string, string> = {};
  const split: Record<string, string> = {};
  let done = 0;
  let failed = 0;
  const failures: Record<string, number> = {};
  await pool(batches, MODEL_CONCURRENCY, async (batch) => {
    let result = await classifySortSenders({ model: input.model, destinations: chosen.destinations, senders: batch, ...(input.purpose ? { purpose: input.purpose } : {}) }, dependencies);
    if (!result.ok) {
      failures[result.code] = (failures[result.code] ?? 0) + 1;
      addSortUsage(usage, result.usage);
      result = await classifySortSenders({ model: input.model, destinations: chosen.destinations, senders: batch, ...(input.purpose ? { purpose: input.purpose } : {}) }, dependencies);
    }
    addSortUsage(usage, result.usage);
    if (result.ok) { Object.assign(decisions, result.decisions); Object.assign(split, result.split); }
    else { failures[result.code] = (failures[result.code] ?? 0) + 1; failed += batch.length; for (const sender of batch) decisions[sender.address] = SORT_KEEP; }
    done += batch.length;
    input.onProgress?.({ phase: 'classify', done, total: senders.length });
  });
  // A failed batch keeps its senders in the inbox; too many failures means no plan at all.
  if (senders.length && failed / senders.length > 0.2) throw new SortRunError('CLASSIFICATION_UNAVAILABLE');
  const used = new Set([...Object.values(decisions), ...Object.values(split)]);
  const destinations = chosen.destinations.filter((destination) => used.has(destination.key));
  return { destinations, decisions, split, usage, senders: senders.length, unclassified: failed, failures };
}

export class SortRunError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SortRunError'; this.code = code; }
}

// ---------------------------------------------------------------- Outlook

export async function outlookCensus(provider: OutlookInboxProvider, options: { max?: number; onProgress?: (progress: SortProgress) => void } = {}) {
  const max = options.max ?? OUTLOOK_CENSUS_MAX;
  const seen = new Set<string>();
  const messages: CensusMessage[] = [];
  let before = new Date(Date.now() + 60_000).toISOString();
  for (let page = 0; page < 200 && messages.length < max; page++) {
    const result = await withReadRetry(() => provider.censusPage(before));
    let fresh = 0;
    for (const message of result.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id); messages.push(message); fresh++;
    }
    options.onProgress?.({ phase: 'census', done: messages.length });
    if (!result.full || !fresh || !result.oldest) break;
    before = result.oldest;
  }
  return messages.slice(0, max);
}

export async function planOutlookSort(input: { provider: OutlookInboxProvider; model: () => LanguageModel | Promise<LanguageModel>; purpose?: string;
  now?: number; onProgress?: (progress: SortProgress) => void }, dependencies: SortModelDependencies = {}): Promise<{ plan: SortPlan; census: CensusMessage[] }> {
  const now = input.now ?? Date.now();
  const account = await withReadRetry(() => input.provider.resolveAccount());
  const existing = await withReadRetry(() => input.provider.listLabels());
  const censusStarted = Date.now();
  const census = await outlookCensus(input.provider, { ...(input.onProgress ? { onProgress: input.onProgress } : {}) });
  const censusMs = Date.now() - censusStarted;
  const modelStarted = Date.now();
  const decided = await decide({ model: input.model, existing, census, ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}) }, dependencies);
  const modelMs = Date.now() - modelStarted;
  const counts = planCounts(census.filter((message) => message.sender), decided.decisions, now, decided.split);
  counts.keep += census.filter((message) => !message.sender).length;
  counts.total = census.length;
  return { census, plan: { provider: 'outlook', mailboxEmail: account.mailboxEmail, createdAt: now, destinations: decided.destinations,
    decisions: decided.decisions, split: decided.split, counts, scanned: census.length, unclassified: decided.unclassified, failures: decided.failures, usage: decided.usage, timings: { censusMs, modelMs, countMs: 0 } } };
}

/** Create any new folders in the plan, then resolve every destination to a folder ID. */
async function resolveOutlookFolders(provider: OutlookInboxProvider, plan: SortPlan) {
  const existing = await withReadRetry(() => provider.listLabels());
  const ids = new Map<string, string>();
  for (const destination of plan.destinations) {
    const known = destination.existingId && existing.some((folder) => folder.id === destination.existingId) ? destination.existingId
      : matchExisting(destination.name, existing)?.id;
    ids.set(destination.key, known ?? (await provider.createFolder(destination.name)).id);
  }
  return ids;
}

/**
 * File every message whose sender has a destination, newest first, at a pace
 * under Microsoft's 10,000 requests per 10 minutes per mailbox. Each move is
 * guarded by the message's etag and the inbox as source, so a message the user
 * changed or moved meanwhile is skipped, never forced.
 */
export async function applyOutlookSort(input: { provider: OutlookInboxProvider; plan: SortPlan; census?: CensusMessage[]; now?: number;
  journal?: SortJournal; onProgress?: (progress: SortProgress) => void; movesPerSecond?: number; retryDelayMs?: number; maxMoves?: number; concurrency?: number; shouldStop?: () => boolean | Promise<boolean> }) {
  const now = input.now ?? Date.now();
  const folderIds = await resolveOutlookFolders(input.provider, input.plan);
  const inbox = input.provider.getSourceFolderId() ?? (() => { throw new SortRunError('FOLDERS_NOT_VERIFIED'); })();
  const census = input.census ?? await outlookCensus(input.provider);
  const queue: (OutlookBatchMove & { destinationKey: string })[] = [];
  for (const message of census) {
    const key = message.sender ? destinationFor(message, input.plan.decisions, now, input.plan.split ?? {}) : null;
    const folderId = key ? folderIds.get(key) : undefined;
    if (!key || !folderId || !message.etag || message.folderId !== inbox) continue;
    queue.push({ destinationKey: key, messageId: message.id, folderId,
      expectedState: { id: message.id, folderId: inbox, isRead: message.isRead === true, etag: message.etag } });
  }
  if (input.maxMoves !== undefined) queue.splice(Math.max(0, input.maxMoves));
  const result = { planned: queue.length, moved: 0, skipped: 0, failed: 0, throttled: 0, byDestination: {} as Record<string, number> };
  // A shared pace for every in-flight batch keeps the mailbox under Microsoft's
  // 10,000 requests per 10 minutes, while two batches hide each round trip.
  const batchMs = (1000 / (input.movesPerSecond ?? 14)) * OUTLOOK_BULK_MOVE_SIZE;
  let nextSlot = Date.now();
  const slot = async () => {
    const at = Math.max(nextSlot, Date.now());
    nextSlot = at + batchMs;
    if (at > Date.now()) await sleep(at - Date.now());
  };
  let stopped = false;
  let retries: typeof queue = [];
  for (let round = 0; round < 4 && queue.length && !stopped; round++) {
    const batches: (typeof queue)[] = [];
    for (let offset = 0; offset < queue.length; offset += OUTLOOK_BULK_MOVE_SIZE) batches.push(queue.slice(offset, offset + OUTLOOK_BULK_MOVE_SIZE));
    await pool(batches, input.concurrency ?? 2, async (batch) => {
      if (stopped || await input.shouldStop?.()) { stopped = true; return; }
      await slot();
      let responses;
      try { responses = await input.provider.bulkMove(batch); }
      catch (error) {
        // The whole batch failed before or during dispatch. Moves are etag-guarded,
        // so retrying cannot move a message twice; a moved one fails its source check.
        if (retryable(error)) { result.throttled += batch.length; retries.push(...batch); nextSlot += Math.min(5_000, input.retryDelayMs ?? 5_000); return; }
        throw error;
      }
      const moved = new Map<string, string[]>();
      responses.forEach((response, index) => {
        const move = batch[index]!;
        if (response.state) {
          result.moved++;
          result.byDestination[move.destinationKey] = (result.byDestination[move.destinationKey] ?? 0) + 1;
          moved.set(move.destinationKey, [...(moved.get(move.destinationKey) ?? []), move.messageId]);
        } else if (response.error.status === 429 || (response.error.status ?? 0) >= 500) { result.throttled++; retries.push(move); }
        // 404: already gone from the inbox. 412: changed since the census. Both stay as they are.
        else if (response.error.status === 404 || response.error.status === 412) result.skipped++;
        else result.failed++;
      });
      for (const [destinationKey, ids] of moved) await input.journal?.({ destinationKey, folderId: folderIds.get(destinationKey)!, ids });
      input.onProgress?.({ phase: 'file', done: result.moved + result.skipped + result.failed, total: result.planned });
    });
    queue.length = 0; queue.push(...retries); retries = [];
    if (queue.length && !stopped) await sleep(input.retryDelayMs ?? 10_000);
  }
  if (stopped) return { ...result, stopped: true };
  result.failed += queue.length;
  return { ...result, stopped: false };
}

/**
 * One durable step of Outlook filing: the next census page at or before
 * `before`, newest first. Filed mail leaves the inbox, so the next step's page
 * starts where this one ended and holds only what was kept or is older.
 */
export async function applyOutlookPage(input: { provider: OutlookInboxProvider; plan: SortPlan; before: string; now?: number;
  movesPerSecond?: number; concurrency?: number }) {
  const page = await withReadRetry(() => input.provider.censusPage(input.before));
  const moves: { messageId: string; folderId: string }[] = [];
  const result = await applyOutlookSort({ provider: input.provider, plan: input.plan, census: page.messages,
    ...(input.now ? { now: input.now } : {}), ...(input.movesPerSecond ? { movesPerSecond: input.movesPerSecond } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    journal: (entry) => { for (const messageId of entry.ids) moves.push({ messageId, folderId: entry.folderId }); } });
  // A page of 1,000 kept messages sharing one timestamp must still advance.
  const oldest = page.oldest && page.oldest === input.before && page.full
    ? new Date(Date.parse(page.oldest) - 1000).toISOString() : page.oldest;
  return { ...result, moves, seen: page.messages.length, full: page.full, oldest };
}

// ---------------------------------------------------------------- Gmail

export async function gmailCensus(provider: GmailInboxProvider, options: { max?: number; onProgress?: (progress: SortProgress) => void } = {}) {
  const max = options.max ?? GMAIL_CENSUS_MAX;
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await withReadRetry(() => provider.listIds(GMAIL_SORT_BASE, token, 500));
    ids.push(...page.ids);
    token = page.nextPageToken ?? undefined;
  } while (token && ids.length < max);
  const selected = ids.slice(0, max);
  let done = 0;
  const messages = await pool(selected, GMAIL_HEADER_CONCURRENCY, async (id) => {
    const headers = await withReadRetry(() => provider.messageHeaders(id));
    done++;
    if (done % 50 === 0) options.onProgress?.({ phase: 'census', done, total: selected.length });
    const categories = headers.labelIds.filter((label) => label.startsWith('CATEGORY_'));
    const sender = normaliseAddress(headers.from);
    return { id, sender: sender ?? '', senderName: displayName(headers.from), subject: headers.subject, unsubscribe: headers.unsubscribe,
      focused: categories.length === 0 || categories.includes('CATEGORY_PERSONAL'), categories,
      flagged: headers.labelIds.includes('STARRED'), ...(sender ? {} : { keepInPlace: true }) } satisfies CensusMessage;
  });
  return { messages, totalEligible: ids.length, complete: !token };
}

/** Count what each destination's searches select, in priority order, deduplicated. */
async function countGmail(provider: GmailInboxProvider, queries: { key: string; query: string }[]) {
  const claimed = new Set<string>();
  const byDestination: Record<string, number> = {};
  for (const { key, query } of queries) {
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await withReadRetry(() => provider.listIds(query, token, 500));
      for (const id of page.ids) if (!claimed.has(id)) { claimed.add(id); byDestination[key] = (byDestination[key] ?? 0) + 1; }
      token = page.nextPageToken ?? undefined;
    } while (token && ++pages < 400);
  }
  return { byDestination, claimed: claimed.size };
}

/** Receipts and bookings from mixed senders first, so they are claimed before the sender's main destination. */
export function gmailPlanQueries(decisions: Record<string, string>, split: Record<string, string>) {
  const group = (entries: [string, string][]) => {
    const byKey = new Map<string, string[]>();
    for (const [address, key] of entries) if (key !== SORT_KEEP) byKey.set(key, [...(byKey.get(key) ?? []), address]);
    return byKey;
  };
  const queries: { key: string; query: string }[] = [];
  for (const [key, addresses] of group(Object.entries(split))) for (const query of gmailSenderQueries(addresses, undefined, { transactional: true })) queries.push({ key, query });
  for (const [key, addresses] of group(Object.entries(decisions))) for (const query of gmailSenderQueries(addresses)) queries.push({ key, query });
  return queries;
}

export async function planGmailSort(input: { provider: GmailInboxProvider; model: () => LanguageModel | Promise<LanguageModel>; purpose?: string;
  now?: number; maxCensus?: number; onProgress?: (progress: SortProgress) => void }, dependencies: SortModelDependencies = {}): Promise<{ plan: SortPlan; census: CensusMessage[] }> {
  const now = input.now ?? Date.now();
  const account = await withReadRetry(() => input.provider.resolveAccount());
  const existing = await withReadRetry(() => input.provider.listLabels());
  const censusStarted = Date.now();
  const census = await gmailCensus(input.provider, { ...(input.maxCensus ? { max: input.maxCensus } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}) });
  const censusMs = Date.now() - censusStarted;
  const modelStarted = Date.now();
  const decided = await decide({ model: input.model, existing, census: census.messages, ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}) }, dependencies);
  const modelMs = Date.now() - modelStarted;
  const gmailQueries = gmailPlanQueries(decided.decisions, decided.split);
  const countStarted = Date.now();
  input.onProgress?.({ phase: 'count', done: 0 });
  const counted = await countGmail(input.provider, gmailQueries);
  // Every eligible inbox message, not just the sample: the searches reach older mail too.
  const eligible = census.complete ? census.totalEligible : await countAll(input.provider);
  const counts: SortPlanCounts = { total: eligible, keep: Math.max(0, eligible - counted.claimed), senders: decided.senders, byDestination: counted.byDestination };
  return { census: census.messages, plan: { provider: 'gmail', mailboxEmail: account.mailboxEmail, createdAt: now, destinations: decided.destinations, decisions: decided.decisions, split: decided.split, unclassified: decided.unclassified, failures: decided.failures,
    counts, gmailQueries, sampled: census.messages.length, scanned: census.messages.length, usage: decided.usage,
    timings: { censusMs, modelMs, countMs: Date.now() - countStarted } } };
}

async function countAll(provider: GmailInboxProvider) {
  let total = 0; let token: string | undefined; let pages = 0;
  do {
    const page = await withReadRetry(() => provider.listIds(GMAIL_SORT_BASE, token, 500));
    total += page.ids.length; token = page.nextPageToken ?? undefined;
  } while (token && ++pages < 1000);
  return total;
}

/** Create missing labels, then move each destination's search results out of the inbox, 1,000 at a time. */
export async function applyGmailSort(input: { provider: GmailInboxProvider; plan: SortPlan; journal?: SortJournal;
  onProgress?: (progress: SortProgress) => void; shouldStop?: () => boolean | Promise<boolean> }) {
  if (input.plan.provider !== 'gmail' || !Array.isArray(input.plan.gmailQueries)) throw new SortRunError('GMAIL_PLAN_REQUIRED');
  const existing = await withReadRetry(() => input.provider.listLabels());
  const labelIds = new Map<string, string>();
  const queried = new Set(input.plan.gmailQueries.map((item) => item.key));
  for (const destination of input.plan.destinations) {
    if (!queried.has(destination.key)) continue;
    const known = destination.existingId && existing.some((label) => label.id === destination.existingId) ? destination.existingId
      : matchExisting(destination.name, existing)?.id;
    labelIds.set(destination.key, known ?? (await input.provider.createLabel(destination.name)).id);
  }
  const result = { planned: Object.values(input.plan.counts.byDestination).reduce((sum, count) => sum + count, 0), moved: 0, byDestination: {} as Record<string, number> };
  for (const { key, query } of input.plan.gmailQueries) {
    const labelId = labelIds.get(key);
    if (!labelId) continue;
    {
      // Filed messages leave in:inbox, so each pass sees only what is left.
      let previous = new Set<string>();
      for (let pass = 0; pass < 200; pass++) {
        if (await input.shouldStop?.()) return { ...result, stopped: true };
        const page = await withReadRetry(() => input.provider.listIds(query, undefined, 500));
        if (!page.ids.length) break;
        // A reported success that leaves the same mail in the inbox must stop, not loop.
        if (page.ids.some((id) => previous.has(id))) throw new SortRunError('FILING_NOT_APPLIED');
        previous = new Set(page.ids);
        await withReadRetry(() => input.provider.fileMessages(page.ids, labelId), 3);
        result.moved += page.ids.length;
        result.byDestination[key] = (result.byDestination[key] ?? 0) + page.ids.length;
        await input.journal?.({ destinationKey: key, folderId: labelId, ids: page.ids });
        input.onProgress?.({ phase: 'file', done: result.moved, total: result.planned });
      }
    }
  }
  return { ...result, stopped: false };
}
