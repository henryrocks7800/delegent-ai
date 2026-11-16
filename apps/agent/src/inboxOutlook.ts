/** Outlook inbox operations through Composio's authenticated proxy. OAuth tokens stay at Composio. */
import type { GmailInboxProviderOptions, GmailInboxLabel } from './inboxGmail.ts';
import { displayName, normaliseAddress, type CensusMessage } from './inboxSort.ts';

const BASE = 'https://backend.composio.dev/api/v3';
const GRAPH = 'https://graph.microsoft.com';
const IMMUTABLE = 'IdType="ImmutableId"';
const MAX_BYTES = 2 * 1024 * 1024;
const FOLDER_FIELDS = 'id,displayName,parentFolderId,childFolderCount,isHidden';
const SYSTEM_FOLDERS = ['archive', 'clutter', 'conflicts', 'conversationhistory', 'deleteditems', 'drafts',
  'inbox', 'junkemail', 'localfailures', 'msgfolderroot', 'outbox', 'recoverableitemsdeletions',
  'scheduled', 'searchfolders', 'sentitems', 'serverfailures', 'syncissues'];
type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_+/=-]{1,2048}$/.test(v);
const email = (v: unknown): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
export class OutlookInboxProviderError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, status?: number) { super(`outlook_inbox_${code.toLowerCase()}`); this.name = 'OutlookInboxProviderError'; this.code = code; this.status = status; }
}
const fail = (code: string): never => { throw new OutlookInboxProviderError(code); };
export type OutlookInboxAccount = { connectionId: string; mailboxEmail: string; sourceFolderId?: string };
export type OutlookMessageState = { id: string; folderId: string; isRead: boolean; etag: string };
/** Graph's JSON batch maximum, used by bulk sorting. */
export const OUTLOOK_BULK_MOVE_SIZE = 20;
export const OUTLOOK_CENSUS_PAGE = 1000;
const CENSUS_FIELDS = 'id,from,subject,receivedDateTime,inferenceClassification,flag,isRead,parentFolderId';
export type OutlookBatchStateResult = { messageId: string; state: OutlookMessageState; error?: never }
  | { messageId: string; error: OutlookInboxProviderError; state?: never };
export type OutlookBatchMove = { messageId: string; folderId: string;
  expectedState: { id: string; folderId: string; isRead: boolean; etag?: string } };

function messageState(value: unknown, messageId: string): OutlookMessageState {
  if (!record(value) || value.id !== messageId || !id(value.parentFolderId) || typeof value.isRead !== 'boolean'
    || typeof value['@odata.etag'] !== 'string' || !value['@odata.etag'] || value['@odata.etag'].length > 1024
    || /[\r\n]/.test(value['@odata.etag'])) return fail('INVALID_RESPONSE');
  return { id: messageId, folderId: value.parentFolderId, isRead: value.isRead, etag: value['@odata.etag'] };
}

/** Match responses by our short request keys, never by array order or provider error text. */
function batchStates(result: Obj, ids: string[], status: number): OutlookBatchStateResult[] {
  const responses = new Map<string, Obj>(); const duplicates = new Set<string>();
  if (Array.isArray(result.responses) && result.responses.length <= 20) {
    for (const response of result.responses) {
      if (!record(response) || typeof response.id !== 'string') continue;
      if (responses.has(response.id)) duplicates.add(response.id);
      responses.set(response.id, response);
    }
  }
  return ids.map((messageId, index) => {
    const key = String(index); const response = responses.get(key);
    if (!response || duplicates.has(key) || !Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) {
      return { messageId, error: new OutlookInboxProviderError('INVALID_RESPONSE') };
    }
    if (response.status !== status) return { messageId, error: new OutlookInboxProviderError('GRAPH_ERROR', Number(response.status)) };
    try { return { messageId, state: messageState(response.body, messageId) }; }
    catch { return { messageId, error: new OutlookInboxProviderError('INVALID_RESPONSE') }; }
  });
}

function batchIds(ids: string[], maximum: number) {
  if (!Array.isArray(ids) || !ids.length || ids.length > maximum
    || ids.some((value) => !id(value)) || new Set(ids).size !== ids.length) fail('INVALID_INPUT');
}

async function json(response: Response): Promise<Obj> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); return fail('RESPONSE_TOO_LARGE'); }
  if (!response.body) return fail('INVALID_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return fail('RESPONSE_TOO_LARGE'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('INVALID_RESPONSE'); }
  return record(value) ? value : fail('INVALID_RESPONSE');
}

/** Only exact Microsoft Graph paths and query shapes generated here can be followed. */
function graphUrl(value: string, path: string, required: Record<string, string>, paging = false): string {
  if (value.length > 16_384 || /[\u0000-\u001f\u007f]/.test(value)) return fail('INVALID_CURSOR');
  let url: URL;
  try { url = new URL(value); } catch { return fail('INVALID_CURSOR'); }
  // Graph canonicalizes the documented /mailFolders/inbox route in nextLink.
  const canonicalPath = path === '/v1.0/me/mailFolders/inbox/messages' ? "/v1.0/me/mailFolders('inbox')/messages" : path;
  if (url.origin !== GRAPH || url.username || url.password || url.hash || (url.pathname !== path && url.pathname !== canonicalPath)) return fail('INVALID_CURSOR');
  const allowed = new Set([...Object.keys(required), ...(paging ? ['$skip', '$skiptoken'] : [])]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return fail('INVALID_CURSOR');
  for (const [key, expected] of Object.entries(required)) if (url.searchParams.get(key) !== expected) return fail('INVALID_CURSOR');
  return url.toString();
}
const urlFor = (path: string, query: Record<string, string>) => `${GRAPH}${path}?${new URLSearchParams(query)}`;

export class OutlookInboxProvider {
  private readonly options: GmailInboxProviderOptions;
  private readonly fetcher: typeof fetch;
  private account: OutlookInboxAccount | null = null;
  private labels: GmailInboxLabel[] | null = null;
  constructor(options: GmailInboxProviderOptions) {
    if (!options.apiKey || !id(options.userId) || (options.connectionId !== undefined && !id(options.connectionId))
      || (options.expectedMailboxEmail !== undefined && !email(options.expectedMailboxEmail))) fail('INVALID_CONFIG');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.options = { ...options };
  }
  private async request(path: string, body?: Obj): Promise<Obj> {
    const signal = AbortSignal.timeout(20_000);
    try {
      const response = await this.fetcher(`${BASE}${path}`, { method: body ? 'POST' : 'GET',
        headers: { 'x-api-key': this.options.apiKey, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'manual' });
      if (!response.ok) { await response.body?.cancel(); throw new OutlookInboxProviderError('HTTP_ERROR', response.status); }
      return await json(response);
    } catch (error) {
      if (error instanceof OutlookInboxProviderError) throw error;
      return fail(signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    }
  }
  private verified() { return this.account ?? fail('ACCOUNT_NOT_VERIFIED'); }
  getSourceFolderId(): string | undefined { return this.verified().sourceFolderId; }
  private connection(value: unknown): string {
    if (!record(value) || !id(value.id)) return fail('INVALID_RESPONSE');
    if ((value.user_id ?? value.userId) !== this.options.userId) return fail('ACCOUNT_OWNER_MISMATCH');
    if (value.status !== 'ACTIVE' || !record(value.toolkit) || value.toolkit.slug !== 'outlook') return fail('ACCOUNT_NOT_ACTIVE_OUTLOOK');
    return value.id;
  }
  async resolveAccount(): Promise<OutlookInboxAccount> {
    this.account = null; this.labels = null;
    let connectionId: string;
    if (this.options.connectionId) {
      connectionId = this.connection(await this.request(`/connected_accounts/${encodeURIComponent(this.options.connectionId)}`));
      if (connectionId !== this.options.connectionId) return fail('ACCOUNT_ID_MISMATCH');
    } else {
      const matches = new Set<string>(); const cursors = new Set<string>(); let cursor = '';
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ user_ids: this.options.userId, statuses: 'ACTIVE', limit: '100', ...(cursor ? { cursor } : {}) });
        const result = await this.request(`/connected_accounts?${query}`);
        if (!Array.isArray(result.items) || result.items.length > 100) return fail('INVALID_RESPONSE');
        for (const item of result.items) {
          if (!record(item)) return fail('INVALID_RESPONSE');
          if (record(item.toolkit) && item.toolkit.slug === 'outlook' && item.status === 'ACTIVE') matches.add(this.connection(item));
        }
        if (matches.size > 1) return fail('ACCOUNT_AMBIGUOUS');
        const next = result.next_cursor;
        if (next === null || next === undefined || next === '') { cursor = ''; break; }
        if (typeof next !== 'string' || next.length > 8192 || /[\u0000-\u001f\u007f]/.test(next) || cursors.has(next)) return fail('INVALID_RESPONSE');
        cursors.add(next); cursor = next;
      }
      if (cursor) return fail('ACCOUNT_LIST_INCOMPLETE');
      if (matches.size !== 1) return fail('ACCOUNT_NOT_FOUND');
      connectionId = [...matches][0]!;
    }
    const result = await this.request('/tools/execute/OUTLOOK_OUTLOOK_GET_PROFILE', {
      user_id: this.options.userId, connected_account_id: connectionId, arguments: { user_id: 'me' },
    });
    if (result.successful !== true || !record(result.data)) return fail('TOOL_FAILED');
    const profile = record(result.data.response_data) ? result.data.response_data : result.data;
    const mailboxEmail = email(profile.mail) ? profile.mail : profile.userPrincipalName;
    if (!email(mailboxEmail)) return fail('INVALID_RESPONSE');
    if (this.options.expectedMailboxEmail && mailboxEmail.toLowerCase() !== this.options.expectedMailboxEmail.toLowerCase()) return fail('MAILBOX_MISMATCH');
    this.account = { connectionId, mailboxEmail };
    return { ...this.account };
  }
  private async proxy(endpoint: string, method = 'GET', body?: Obj, extraHeaders: Obj[] = []): Promise<Obj> {
    const result = await this.request('/tools/execute/proxy', { connected_account_id: this.verified().connectionId,
      endpoint, method, ...(body ? { body } : {}),
      parameters: [{ name: 'Prefer', value: IMMUTABLE, type: 'header' }, ...extraHeaders] });
    if (typeof result.status !== 'number' || result.status < 200 || result.status >= 300) {
      throw new OutlookInboxProviderError('GRAPH_ERROR', typeof result.status === 'number' ? result.status : undefined);
    }
    return record(result.data) ? result.data : fail('INVALID_RESPONSE');
  }
  async listLabels(): Promise<GmailInboxLabel[]> {
    this.verified(); this.labels = null;
    // Resolve well-known IDs, independent of language or folder display names.
    const systems = await this.proxy(`${GRAPH}/v1.0/$batch`, 'POST', { requests: SYSTEM_FOLDERS.map((name) => ({
      id: name, method: 'GET', url: `/me/mailFolders/${name}?$select=id`, headers: { Prefer: IMMUTABLE },
    })) });
    if (!Array.isArray(systems.responses) || systems.responses.length !== SYSTEM_FOLDERS.length) return fail('INVALID_RESPONSE');
    const excluded = new Set<string>(); const names = new Set<string>(); let inboxId = '';
    for (const response of systems.responses) {
      if (!record(response) || typeof response.id !== 'string' || !SYSTEM_FOLDERS.includes(response.id) || names.has(response.id)) return fail('INVALID_RESPONSE');
      names.add(response.id);
      if (response.status === 404 && response.id !== 'inbox') continue;
      if (response.status !== 200 || !record(response.body) || !id(response.body.id)) return fail('FOLDER_LOOKUP_FAILED');
      excluded.add(response.body.id);
      if (response.id === 'inbox') inboxId = response.body.id;
    }
    if (!inboxId) return fail('FOLDER_LOOKUP_FAILED');
    this.verified().sourceFolderId = inboxId;
    const queue = [{ path: '/v1.0/me/mailFolders', prefix: '' }];
    const labels: GmailInboxLabel[] = []; const seen = new Set<string>(); let requests = 0;
    for (let position = 0; position < queue.length; position++) {
      const { path, prefix } = queue[position]!; const query = { $top: '100', $select: FOLDER_FIELDS };
      let next: string | null = urlFor(path, query); const cursors = new Set<string>();
      while (next) {
        if (++requests > 100 || cursors.has(next)) return fail('FOLDER_LIMIT');
        cursors.add(next);
        const page = await this.proxy(graphUrl(next, path, query, true));
        if (!Array.isArray(page.value) || page.value.length > 100) return fail('INVALID_RESPONSE');
        for (const folder of page.value) {
          if (!record(folder) || !id(folder.id) || seen.has(folder.id) || typeof folder.displayName !== 'string'
            || !folder.displayName.trim() || typeof folder.childFolderCount !== 'number' || !Number.isSafeInteger(folder.childFolderCount)
            || folder.childFolderCount < 0 || typeof folder.isHidden !== 'boolean') return fail('INVALID_RESPONSE');
          seen.add(folder.id);
          if (folder.isHidden || (excluded.has(folder.id) && folder.id !== inboxId)) continue;
          const name = prefix ? `${prefix}/${folder.displayName}` : folder.displayName;
          if (name.length > 256) return fail('FOLDER_NAME_TOO_LONG');
          if (!excluded.has(folder.id)) labels.push({ id: folder.id, name });
          if (labels.length > 50) return fail('FOLDER_LIMIT');
          if (folder.childFolderCount) queue.push({ path: `/v1.0/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders`, prefix: name });
        }
        const cursor = page['@odata.nextLink'];
        if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return fail('INVALID_RESPONSE');
        next = typeof cursor === 'string' ? graphUrl(cursor, path, query, true) : null;
      }
    }
    this.labels = labels;
    return labels.map((label) => ({ ...label }));
  }
  /** Bulk sorting: the same guarded move, at Graph's full batch size. */
  async bulkMove(moves: OutlookBatchMove[]): Promise<OutlookBatchStateResult[]> {
    return this.moveMessages(moves, OUTLOOK_BULK_MOVE_SIZE);
  }
  private async moveMessages(moves: OutlookBatchMove[], maximum: number): Promise<OutlookBatchStateResult[]> {
    if (!Array.isArray(moves)) return fail('INVALID_INPUT');
    batchIds(moves.map((move) => move?.messageId), maximum);
    if (!this.labels) return fail('FOLDERS_NOT_VERIFIED');
    const inbox = this.verified().sourceFolderId;
    for (const move of moves) {
      if (!id(move.folderId) || !move.expectedState || move.expectedState.id !== move.messageId
        || typeof move.expectedState.isRead !== 'boolean' || typeof move.expectedState.etag !== 'string'
        || !move.expectedState.etag || move.expectedState.etag.length > 1024 || /[\r\n]/.test(move.expectedState.etag)) return fail('INVALID_INPUT');
      if (!this.labels.some((label) => label.id === move.folderId)) return fail('CUSTOM_FOLDER_REQUIRED');
      if (move.expectedState.folderId !== inbox) return fail('SOURCE_FOLDER_CHANGED');
    }
    const result = await this.proxy(`${GRAPH}/v1.0/$batch`, 'POST', { requests: moves.map((move, index) => ({
      id: String(index), method: 'POST',
      url: `/me/mailFolders/${encodeURIComponent(move.expectedState.folderId)}/messages/${encodeURIComponent(move.messageId)}/move`,
      headers: { Prefer: IMMUTABLE, 'Content-Type': 'application/json', 'If-Match': move.expectedState.etag },
      body: { destinationId: move.folderId },
    })) });
    return batchStates(result, moves.map((move) => move.messageId), 201).map((response, index) => {
      const move = moves[index]!;
      return response.state && (response.state.folderId !== move.folderId || response.state.isRead !== move.expectedState.isRead)
        ? { messageId: move.messageId, error: new OutlookInboxProviderError('MOVE_NOT_VERIFIED') } : response;
    });
  }
  /**
   * One census page: up to 1,000 inbox messages received at or before `before`,
   * newest first. Keyset paging by date, because deep $skip pages time out on a
   * large inbox (Graph 504 after ~12,000 of 46,938, measured 2026-09-22).
   * Subjects are returned for in-memory sampling only.
   */
  async censusPage(before: string): Promise<{ messages: CensusMessage[]; oldest: string | null; full: boolean }> {
    // Each Workflow filing step builds a fresh provider and reads a page straight
    // after resolveAccount, so the inbox ID has to be loaded here, not assumed.
    // Without this every Outlook filing step failed FOLDERS_NOT_VERIFIED (2026-09-24).
    if (!this.verified().sourceFolderId) await this.listLabels();
    const inbox = this.verified().sourceFolderId ?? fail('FOLDERS_NOT_VERIFIED');
    if (typeof before !== 'string' || !Number.isFinite(Date.parse(before)) || before.length > 40) return fail('INVALID_INPUT');
    const page = await this.proxy(urlFor('/v1.0/me/mailFolders/inbox/messages', { $top: String(OUTLOOK_CENSUS_PAGE), $select: CENSUS_FIELDS,
      $filter: `receivedDateTime le ${new Date(before).toISOString()}`, $orderby: 'receivedDateTime desc' }));
    if (!Array.isArray(page.value) || page.value.length > OUTLOOK_CENSUS_PAGE) return fail('INVALID_RESPONSE');
    const messages: CensusMessage[] = [];
    let oldest: string | null = null;
    for (const value of page.value) {
      if (!record(value) || !id(value.id) || typeof value.receivedDateTime !== 'string' || !Number.isFinite(Date.parse(value.receivedDateTime))) return fail('INVALID_RESPONSE');
      oldest = value.receivedDateTime;
      const from = record(value.from) && record(value.from.emailAddress) ? value.from.emailAddress : {};
      const sender = normaliseAddress(from.address);
      const etag = typeof value['@odata.etag'] === 'string' && value['@odata.etag'].length <= 1024 && !/[\r\n]/.test(value['@odata.etag']) ? value['@odata.etag'] : undefined;
      const type = value['@odata.type'];
      messages.push({ id: value.id, sender: sender ?? '', senderName: displayName(from.name),
        subject: typeof value.subject === 'string' ? value.subject.slice(0, 240) : '', receivedAt: value.receivedDateTime,
        focused: value.inferenceClassification === 'focused',
        flagged: record(value.flag) && value.flag.flagStatus === 'flagged',
        isRead: value.isRead === true, folderId: id(value.parentFolderId) ? value.parentFolderId : inbox,
        ...(etag ? { etag } : {}),
        // Meeting requests, items without a sender or a usable etag stay exactly where they are.
        ...(!sender || !etag || (type !== undefined && type !== '#microsoft.graph.message') ? { keepInPlace: true } : {}) });
    }
    return { messages, oldest, full: page.value.length === OUTLOOK_CENSUS_PAGE };
  }
  /**
   * Undo for bulk sorting: move journalled messages from one of the person's own
   * folders back to the inbox. Up to 20 per call, each scoped to its folder, so a
   * message the person has since moved elsewhere is left alone.
   */
  async restoreToInbox(items: { messageId: string; folderId: string }[]): Promise<{ messageId: string; restored: boolean; status?: number }[]> {
    if (!Array.isArray(items)) return fail('INVALID_INPUT');
    batchIds(items.map((item) => item?.messageId), OUTLOOK_BULK_MOVE_SIZE);
    if (!this.labels) await this.listLabels();
    const inbox = this.verified().sourceFolderId ?? fail('FOLDERS_NOT_VERIFIED');
    for (const item of items) if (!this.labels!.some((label) => label.id === item.folderId)) return fail('CUSTOM_FOLDER_REQUIRED');
    const result = await this.proxy(`${GRAPH}/v1.0/$batch`, 'POST', { requests: items.map((item, index) => ({
      id: String(index), method: 'POST',
      url: `/me/mailFolders/${encodeURIComponent(item.folderId)}/messages/${encodeURIComponent(item.messageId)}/move`,
      headers: { Prefer: IMMUTABLE, 'Content-Type': 'application/json' }, body: { destinationId: inbox },
    })) });
    const responses = new Map<string, Obj>();
    if (Array.isArray(result.responses)) for (const response of result.responses) if (record(response) && typeof response.id === 'string') responses.set(response.id, response);
    return items.map((item, index) => {
      const response = responses.get(String(index));
      const status = response && Number.isInteger(response.status) ? Number(response.status) : undefined;
      return { messageId: item.messageId, restored: status === 201 && record(response!.body) && response!.body.parentFolderId === inbox, ...(status ? { status } : {}) };
    });
  }
  /**
   * Money Finder: messages matching a Graph $search (KQL built in moneyFinder.ts),
   * across all folders, up to `max`. Sender, subject and date only.
   */
  async searchMessages(query: string, max: number): Promise<{ id: string; from: string; subject: string; date: string }[]> {
    this.verified();
    if (typeof query !== 'string' || !query || query.length > 1500 || /["\u0000-\u001f\u007f]/.test(query.replace(/"[^"]*"/g, ''))
      || !Number.isInteger(max) || max < 1 || max > 500) return fail('INVALID_INPUT');
    const path = '/v1.0/me/messages';
    const params = { $search: `"${query.replace(/"/g, '\\"')}"`, $top: '50', $select: 'id,from,subject,receivedDateTime' };
    const found: { id: string; from: string; subject: string; date: string }[] = [];
    let next: string | null = urlFor(path, params); const cursors = new Set<string>();
    while (next && found.length < max) {
      if (cursors.has(next) || cursors.size > 20) return fail('INVALID_CURSOR');
      cursors.add(next);
      const page = await this.proxy(next);
      if (!Array.isArray(page.value) || page.value.length > 50) return fail('INVALID_RESPONSE');
      for (const value of page.value) {
        if (!record(value) || !id(value.id) || typeof value.receivedDateTime !== 'string') return fail('INVALID_RESPONSE');
        const from = record(value.from) && record(value.from.emailAddress) ? value.from.emailAddress : {};
        found.push({ id: value.id, from: [typeof from.name === 'string' ? from.name : '', typeof from.address === 'string' ? `<${from.address}>` : ''].join(' ').trim().slice(0, 512),
          subject: typeof value.subject === 'string' ? value.subject.slice(0, 500) : '', date: value.receivedDateTime });
      }
      const cursor = page['@odata.nextLink'];
      next = typeof cursor === 'string' ? graphUrl(cursor, path, params, true) : null;
    }
    return found.slice(0, max);
  }

  /** Money Finder: one message as plain text, which Graph converts from HTML itself. */
  async messageText(messageId: string): Promise<{ id: string; from: string; subject: string; date: string; text: string }> {
    this.verified();
    if (!id(messageId)) return fail('INVALID_INPUT');
    const result = await this.request('/tools/execute/proxy', { connected_account_id: this.verified().connectionId,
      endpoint: urlFor(`/v1.0/me/messages/${encodeURIComponent(messageId)}`, { $select: 'id,from,subject,receivedDateTime,body' }), method: 'GET',
      parameters: [{ name: 'Prefer', value: `${IMMUTABLE}, outlook.body-content-type="text"`, type: 'header' }] });
    if (typeof result.status !== 'number' || result.status < 200 || result.status >= 300) {
      throw new OutlookInboxProviderError('GRAPH_ERROR', typeof result.status === 'number' ? result.status : undefined);
    }
    const value = record(result.data) ? result.data : fail('INVALID_RESPONSE');
    if (value.id !== messageId) return fail('MESSAGE_ID_MISMATCH');
    const from = record(value.from) && record(value.from.emailAddress) ? value.from.emailAddress : {};
    const body = record(value.body) && typeof value.body.content === 'string' ? value.body.content : '';
    return { id: messageId, from: [typeof from.name === 'string' ? from.name : '', typeof from.address === 'string' ? `<${from.address}>` : ''].join(' ').trim().slice(0, 512),
      subject: typeof value.subject === 'string' ? value.subject.slice(0, 500) : '',
      date: typeof value.receivedDateTime === 'string' ? value.receivedDateTime : '', text: body.slice(0, 20_000) };
  }
  /** Create one top-level folder named in an approved plan, or reuse one with that exact name. */
  async createFolder(name: string): Promise<GmailInboxLabel> {
    this.verified();
    if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) return fail('INVALID_INPUT');
    if (!this.labels) await this.listLabels();
    const existing = this.labels!.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (existing) return { ...existing };
    const value = await this.proxy(`${GRAPH}/v1.0/me/mailFolders`, 'POST', { displayName: name, isHidden: false });
    if (!id(value.id) || value.displayName !== name) return fail('INVALID_RESPONSE');
    const folder = { id: value.id, name };
    this.labels!.push(folder);
    return { ...folder };
  }
}
export const createOutlookInboxProvider = (options: GmailInboxProviderOptions) => new OutlookInboxProvider(options);
