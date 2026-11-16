/**
 * A deliberately narrow Gmail adapter for the inbox organisation pilot.
 * Account ownership is verified before reads, and the only mutation available
 * adds one existing custom label. Provider credentials and response bodies never
 * appear in errors. This adapter does not decide whether a user approved a job.
 */
const API_BASE = 'https://backend.composio.dev/api/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const GMAIL_REQUEST_TIMEOUT_MS = 15_000;

export type GmailInboxProviderOptions = {
  apiKey: string;
  userId: string;
  connectionId?: string;
  expectedMailboxEmail?: string;
  fetch?: typeof fetch;
};

export type GmailInboxAccount = { connectionId: string; mailboxEmail: string };
export type GmailInboxLabel = { id: string; name: string };
export type GmailInboxMessage = {
  id: string;
  subject: string;
  snippet: string;
  senderDomain?: string;
  /** True when this adapter removed evidence before the classifier's own input bounds. */
  evidenceTruncated?: boolean;
  labelIds: string[];
};

export class GmailInboxProviderError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, status?: number) {
    super(`gmail_inbox_${code.toLowerCase()}`);
    this.name = 'GmailInboxProviderError';
    this.code = code;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(value);
const validCursor = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
const fail = (code: string): never => { throw new GmailInboxProviderError(code); };

function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || !value.every(validId)) return fail('INVALID_RESPONSE');
  return [...value];
}

function senderDomainOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Match the complete address domain, not a prefix before an unsupported
  // character. Missing or malformed metadata is absent evidence, not an empty
  // domain that would make the classifier reject the entire page.
  const domain = value.match(/@([a-z0-9.-]+)(?=[\s>,;)]|$)/i)?.[1]?.toLowerCase();
  if (!domain || domain.length > 253) return undefined;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return domain;
}

async function boundedJson(response: Response): Promise<JsonRecord> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > GMAIL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return fail('RESPONSE_TOO_LARGE');
  }
  if (!response.body) return fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > GMAIL_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
  catch { return fail('INVALID_RESPONSE'); }
  if (!record(value)) return fail('INVALID_RESPONSE');
  return value;
}

export class GmailInboxProvider {
  private readonly options: GmailInboxProviderOptions;
  private readonly fetcher: typeof fetch;
  private account: GmailInboxAccount | null = null;
  private customLabelIds: Set<string> | null = null;

  constructor(options: GmailInboxProviderOptions) {
    if (!options.apiKey || !validId(options.userId) || (options.connectionId !== undefined && !validId(options.connectionId))) fail('INVALID_CONFIG');
    if (options.expectedMailboxEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.expectedMailboxEmail)) fail('INVALID_CONFIG');
    this.options = { ...options };
    // Workers' native fetch requires the global receiver, even through this adapter.
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(path: string, body?: JsonRecord): Promise<JsonRecord> {
    const signal = AbortSignal.timeout(GMAIL_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-api-key': this.options.apiKey, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        // Workers supports manual/follow only. Reject 3xx below without forwarding credentials.
        redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GmailInboxProviderError('HTTP_ERROR', response.status);
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof GmailInboxProviderError) throw error;
      if (signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) fail('TIMEOUT');
      return fail('UNAVAILABLE');
    }
  }

  private verifiedAccount(): GmailInboxAccount {
    return this.account ?? fail('ACCOUNT_NOT_VERIFIED');
  }

  private async execute(tool: string, args: JsonRecord, connectionId = this.verifiedAccount().connectionId): Promise<JsonRecord> {
    const result = await this.request(`/tools/execute/${tool}`, {
      user_id: this.options.userId,
      connected_account_id: connectionId,
      arguments: args,
    });
    if (result.successful !== true) return fail('TOOL_FAILED');
    if (!record(result.data)) return fail('INVALID_RESPONSE');
    return result.data;
  }

  private validateConnection(value: unknown): string {
    if (!record(value) || !validId(value.id)) return fail('INVALID_RESPONSE');
    if ((value.user_id ?? value.userId) !== this.options.userId) return fail('ACCOUNT_OWNER_MISMATCH');
    if (value.status !== 'ACTIVE' || !record(value.toolkit) || value.toolkit.slug !== 'gmail') return fail('ACCOUNT_NOT_ACTIVE_GMAIL');
    return value.id;
  }

  async resolveAccount(): Promise<GmailInboxAccount> {
    // A failed re-verification must invalidate an earlier successful one.
    this.account = null;
    this.customLabelIds = null;
    let connectionId: string;
    if (this.options.connectionId) {
      const value = await this.request(`/connected_accounts/${encodeURIComponent(this.options.connectionId)}`);
      connectionId = this.validateConnection(value);
      if (connectionId !== this.options.connectionId) return fail('ACCOUNT_ID_MISMATCH');
    } else {
      const matches = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ user_ids: this.options.userId, statuses: 'ACTIVE', limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const result = await this.request(`/connected_accounts?${query}`);
        if (!Array.isArray(result.items) || result.items.length > 100) return fail('INVALID_RESPONSE');
        for (const item of result.items) {
          if (!record(item)) return fail('INVALID_RESPONSE');
          if (record(item.toolkit) && item.toolkit.slug === 'gmail' && item.status === 'ACTIVE') matches.add(this.validateConnection(item));
        }
        if (matches.size > 1) return fail('ACCOUNT_AMBIGUOUS');
        const next = result.next_cursor;
        if (next === null || next === undefined || next === '') { cursor = null; break; }
        if (!validCursor(next) || seenCursors.has(next)) return fail('INVALID_RESPONSE');
        seenCursors.add(next);
        cursor = next;
      }
      if (cursor) return fail('ACCOUNT_LIST_INCOMPLETE');
      if (matches.size !== 1) return fail('ACCOUNT_NOT_FOUND');
      connectionId = [...matches][0]!;
    }
    const profile = await this.execute('GMAIL_GET_PROFILE', { user_id: 'me' }, connectionId);
    const source = record(profile.response_data) ? profile.response_data : profile;
    const email = source.emailAddress;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('INVALID_RESPONSE');
    if (this.options.expectedMailboxEmail && email.toLowerCase() !== this.options.expectedMailboxEmail.toLowerCase()) return fail('MAILBOX_MISMATCH');
    this.account = { connectionId, mailboxEmail: email };
    return { ...this.account };
  }

  async listLabels(): Promise<GmailInboxLabel[]> {
    const data = await this.execute('GMAIL_LIST_LABELS', { user_id: 'me' });
    if (!Array.isArray(data.labels)) return fail('INVALID_RESPONSE');
    const labels: GmailInboxLabel[] = [];
    const seen = new Set<string>();
    for (const value of data.labels) {
      if (!record(value) || !['user', 'system'].includes(String(value.type))) return fail('INVALID_RESPONSE');
      if (value.type === 'system') continue;
      if (!validId(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 1024 || seen.has(value.id)) return fail('INVALID_RESPONSE');
      seen.add(value.id);
      labels.push({ id: value.id, name: value.name });
    }
    this.customLabelIds = new Set(labels.map((label) => label.id));
    return labels;
  }


  // Bulk sorting (inboxSort.ts). Raw Gmail API through Composio's authenticated
  // proxy: searches return IDs only, so sorting a Gmail inbox reads no content
  // beyond the sampled headers. OAuth tokens stay at Composio.
  private async proxy(path: string, method: 'GET' | 'POST' = 'GET', body?: JsonRecord): Promise<JsonRecord> {
    if (!path.startsWith('/') || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return fail('INVALID_INPUT');
    const result = await this.request('/tools/execute/proxy', {
      connected_account_id: this.verifiedAccount().connectionId,
      endpoint: `${GMAIL_API}${path}`, method, ...(body ? { body } : {}),
    });
    const status = result.status;
    if (typeof status !== 'number') return fail('INVALID_RESPONSE');
    if (status === 429) throw new GmailInboxProviderError('RATE_LIMITED', 429);
    if (status < 200 || status >= 300) throw new GmailInboxProviderError('GMAIL_ERROR', status);
    return record(result.data) ? result.data : {};
  }

  /** One page of message IDs for an inbox search. Only inbox searches are accepted. */
  async listIds(query: string, pageToken?: string, maxResults = 500): Promise<{ ids: string[]; nextPageToken: string | null }> {
    if (typeof query !== 'string' || !query.startsWith('in:inbox ') || query.length > 2000 || /[\u0000-\u001f\u007f]/.test(query)
      || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500
      || (pageToken !== undefined && !validCursor(pageToken))) return fail('INVALID_INPUT');
    const data = await this.proxy(`/messages?${new URLSearchParams({ q: query, maxResults: String(maxResults), ...(pageToken ? { pageToken } : {}) })}`);
    const messages = data.messages ?? [];
    if (!Array.isArray(messages) || messages.length > maxResults) return fail('INVALID_RESPONSE');
    const ids = messages.map((value) => record(value) && validId(value.id) ? value.id : fail('INVALID_RESPONSE'));
    const next = data.nextPageToken;
    if (next !== undefined && next !== null && next !== '' && !validCursor(next)) return fail('INVALID_RESPONSE');
    if (next && next === pageToken) return fail('INVALID_RESPONSE');
    return { ids, nextPageToken: typeof next === 'string' && next ? next : null };
  }

  /** Sender, subject, unsubscribe header and labels for one message. Never the body. */
  async messageHeaders(id: string): Promise<{ id: string; from: string; subject: string; unsubscribe: boolean; labelIds: string[] }> {
    if (!validId(id)) return fail('INVALID_INPUT');
    const data = await this.proxy(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`);
    if (data.id !== id) return fail('MESSAGE_ID_MISMATCH');
    const headers = record(data.payload) && Array.isArray(data.payload.headers) ? data.payload.headers : [];
    const header = (name: string) => {
      const found = headers.find((value) => record(value) && typeof value.name === 'string' && value.name.toLowerCase() === name);
      return record(found) && typeof found.value === 'string' ? found.value : '';
    };
    return { id, from: header('from').slice(0, 512), subject: header('subject').slice(0, 500),
      unsubscribe: Boolean(header('list-unsubscribe')), labelIds: labelsFrom(data.labelIds ?? []) };
  }

  /**
   * Money Finder: message IDs for an all-mail search (receipts are often archived),
   * newest first, up to `max`. Only searches built in moneyFinder.ts are accepted.
   */
  async searchIds(query: string, max: number): Promise<string[]> {
    if (typeof query !== 'string' || !query.startsWith('-in:spam -in:trash ') || query.length > 2000 || /[\u0000-\u001f\u007f]/.test(query)
      || !Number.isInteger(max) || max < 1 || max > 500) return fail('INVALID_INPUT');
    const ids: string[] = []; let pageToken: string | undefined;
    do {
      const data = await this.proxy(`/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)), ...(pageToken ? { pageToken } : {}) })}`);
      const messages = data.messages ?? [];
      if (!Array.isArray(messages)) return fail('INVALID_RESPONSE');
      for (const value of messages) ids.push(record(value) && validId(value.id) ? value.id : fail('INVALID_RESPONSE'));
      const next = data.nextPageToken;
      pageToken = typeof next === 'string' && next && next !== pageToken && validCursor(next) ? next : undefined;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  /** Money Finder: one message as plain text, decoded by Composio's own Gmail tool. */
  async messageText(id: string): Promise<{ id: string; from: string; subject: string; date: string; text: string }> {
    if (!validId(id)) return fail('INVALID_INPUT');
    const data = await this.execute('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: id, format: 'full', user_id: 'me' });
    const message = record(data.response_data) ? data.response_data : data;
    if (message.messageId !== undefined && message.messageId !== id) return fail('MESSAGE_ID_MISMATCH');
    const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
    return { id, from: text(message.sender, 512), subject: text(message.subject, 500), date: text(message.messageTimestamp, 40),
      text: text(message.messageText, 20_000) };
  }

  /** Create one visible user label. The caller has an approved plan naming it. */
  async createLabel(name: string): Promise<GmailInboxLabel> {
    this.verifiedAccount();
    if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 225 || /[\u0000-\u001f\u007f]/.test(name)) return fail('INVALID_INPUT');
    const data = await this.proxy('/labels', 'POST', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    if (!validId(data.id) || data.name !== name) return fail('INVALID_RESPONSE');
    if (!this.customLabelIds) this.customLabelIds = new Set();
    this.customLabelIds.add(data.id);
    return { id: data.id, name };
  }

  /**
   * Move up to 1,000 messages into one existing user label: add it, remove INBOX.
   * Nothing else can change: no other label, no read state, no trash or spam.
   */
  async fileMessages(ids: string[], labelId: string): Promise<void> {
    this.verifiedAccount();
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(validId) || new Set(ids).size !== ids.length || !validId(labelId)) return fail('INVALID_INPUT');
    if (!this.customLabelIds) await this.listLabels();
    if (!this.customLabelIds?.has(labelId)) return fail('CUSTOM_LABEL_REQUIRED');
    await this.proxy('/messages/batchModify', 'POST', { ids, addLabelIds: [labelId], removeLabelIds: ['INBOX'] });
  }

  /** Undo for fileMessages: back into the inbox, label removed. */
  async restoreMessages(ids: string[], labelId: string): Promise<void> {
    this.verifiedAccount();
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(validId) || new Set(ids).size !== ids.length || !validId(labelId)) return fail('INVALID_INPUT');
    if (!this.customLabelIds) await this.listLabels();
    if (!this.customLabelIds?.has(labelId)) return fail('CUSTOM_LABEL_REQUIRED');
    await this.proxy('/messages/batchModify', 'POST', { ids, addLabelIds: ['INBOX'], removeLabelIds: [labelId] });
  }
}

export function createGmailInboxProvider(options: GmailInboxProviderOptions): GmailInboxProvider {
  return new GmailInboxProvider(options);
}
