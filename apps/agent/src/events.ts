/**
 * Translation between the agent engine (Cloudflare Think, AI SDK message chunks)
 * and the run events the app's chat screen already reads.
 *
 * The production Worker relays these events to the app unchanged apart from the
 * run id, so they use the same NormalisedRunEvent shape the Worker produces for
 * a runner: `{ type, runId, sequence, timestamp, payload }`.
 *
 * Everything in this file is a pure function so it can be tested without a Worker.
 */

export type RunStatus = 'working' | 'succeeded' | 'failed' | 'cancelled';

export type AppEvent = {
  type: string;
  runId: string;
  sequence: number;
  timestamp: string;
  payload?: Record<string, unknown>;
};

export type ToolCard = { tool: string; summary: string };

export type RunUsage = {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** App actions and tool calls this reply made; the Worker meters each (AGENT_USAGE). */
  toolCalls: number;
};

// ── Tool names ────────────────────────────────────────────────────────────────
// The chat screen turns a tool name into a plain-English headline by keyword
// (friendlyToolHeadline in apps/mobile/assets/chat-webview/index.html): "email"
// reads "Working on email", "calendar" reads "Checking the calendar", and
// "web_search" with a short summary reads 'Searching the web for "…"'. So each
// Composio tool is given the name that produces the right sentence. Words like
// "exec" or "command" are avoided: the screen treats those as shell commands.

const EMAIL = /^(GMAIL|OUTLOOK|AGENT_MAIL)_/;
const CALENDAR = /^(GOOGLECALENDAR|OUTLOOK_CALENDAR)_/;
const DOCUMENTS = /^(DROPBOX|GOOGLEDRIVE|ONE_DRIVE|GOOGLEDOCS|GOOGLESHEETS|CONFLUENCE|PDF_CO)_/;
const FLIGHTS = /^COMPOSIO_SEARCH_FLIGHTS$/;
const HOTELS = /^(COMPOSIO_SEARCH_HOTELS|TRIVAGO_MCP_)/;
const THINGS_TO_DO = /^(VIATOR_MCP_|COMPOSIO_SEARCH_TRIP_ADVISOR$|COMPOSIO_SEARCH_EVENT$)/;
const SHOPPING = /^COMPOSIO_SEARCH_(SHOPPING|AMAZON|WALMART)$/;
const PLACES = /^COMPOSIO_SEARCH_GOOGLE_MAPS$/;
const NEWS = /^(COMPOSIO_SEARCH_NEWS$|HACKERNEWS_)/;
const MARKETS = /^COMPOSIO_SEARCH_FINANCE$/;
const WEATHER = /^WEATHERMAP_/;
const WEB = /^(COMPOSIO_SEARCH|FIRECRAWL)_/;

/** Strip the MCP prefix Think adds, e.g. "tool_0S6tjT8w_GMAIL_FETCH_EMAILS". */
export function bareToolName(raw: string): string {
  return raw.replace(/^tool_[A-Za-z0-9]+_/, '');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortPlain(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= 48 && !/[|;&<>$\\{}`/]/.test(text) ? text : '';
}

export function displayTool(rawName: string, input: unknown): ToolCard {
  const name = bareToolName(rawName);
  const args = record(input);

  if (name === 'set_context' || name === 'search_context') return { tool: 'memory', summary: '' };
  if (['sort_inbox', 'inbox_sort_status', 'approve_inbox_sort', 'cancel_inbox_sort'].includes(name)) {
    return { tool: 'email', summary: '' };
  }
  // Tools whose chat-screen headline quotes the summary ("Working on …",
  // "Reading …", "Searching the web for …") always get a real one: an empty
  // summary is replaced by "Working…" in the chat screen and would read
  // "Working on Working…".
  if (name === 'create_pdf') {
    return { tool: 'create_document', summary: shortPlain(args.filename) || 'a document' };
  }
  if (name === 'attach_file') {
    const file = typeof args.file === 'string' && !/^file_[a-f0-9]{32}$/.test(args.file.trim()) ? shortPlain(args.file) : '';
    return { tool: 'create_document', summary: file || 'the attachment' };
  }
  if (name === 'COMPOSIO_SEARCH_TOOLS' || name === 'COMPOSIO_GET_TOOL_SCHEMAS') {
    return { tool: 'plan', summary: '' };
  }
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    // The model runs one or more app actions through this; name the card after
    // the first of them.
    const tools = Array.isArray(args.tools) ? args.tools : [];
    const first = record(tools[0]);
    const inner = typeof first.tool_slug === 'string' ? first.tool_slug : '';
    return inner ? displayTool(inner, first.arguments) : { tool: 'app', summary: '' };
  }
  if (EMAIL.test(name)) return { tool: 'email', summary: '' };
  if (CALENDAR.test(name)) return { tool: 'calendar', summary: '' };
  if (DOCUMENTS.test(name)) {
    const file = shortPlain(String(args.path ?? '').split('/').pop()) || shortPlain(args.file_name) || shortPlain(args.name);
    return { tool: 'read', summary: file || 'a document' };
  }
  if (FLIGHTS.test(name)) {
    const route = args.departure_id && args.arrival_id ? `${String(args.departure_id)} to ${String(args.arrival_id)}` : '';
    return { tool: 'flights', summary: shortPlain(args.query) || shortPlain(route) };
  }
  if (HOTELS.test(name)) return { tool: 'hotels', summary: shortPlain(args.q) || shortPlain(args.query) };
  if (THINGS_TO_DO.test(name)) return { tool: 'things_to_do', summary: shortPlain(args.query) || shortPlain(args.searchTerm) };
  if (SHOPPING.test(name)) return { tool: 'shopping', summary: shortPlain(args.query) };
  if (PLACES.test(name)) return { tool: 'places', summary: shortPlain(args.q) };
  if (NEWS.test(name)) return { tool: 'news', summary: shortPlain(args.query) };
  if (MARKETS.test(name)) return { tool: 'markets', summary: shortPlain(args.query) };
  if (WEATHER.test(name)) return { tool: 'weather', summary: shortPlain(args.location) || shortPlain(args.q) };
  if (WEB.test(name)) {
    const query = shortPlain(args.query) || shortPlain(args.q);
    // With no query, a summary containing "/" makes the headline a plain "Searching the web".
    return { tool: 'web_search', summary: query || 'search/web' };
  }
  const app = name.split('_')[0]?.toLowerCase() || 'app';
  return { tool: app, summary: '' };
}

/** A one-line result for the expandable part of a tool card. Never the raw payload. */
export function toolResultSummary(output: unknown, errorText?: string): string {
  if (errorText) return 'Could not complete this step';
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (/"(?:successful|ok)"\s*:\s*false|"isError"\s*:\s*true/.test(text)) return 'Could not complete this step';
  return 'Done';
}

// ── Live stream ───────────────────────────────────────────────────────────────

/**
 * Turns Think's streamed chunks (JSON strings of AI SDK UIMessageChunk) into the
 * app's run events. One encoder per run.
 */
export class RunEventEncoder {
  private sequence = 0;
  private readonly tools = new Map<string, number>();
  private text = '';
  private error: string | null = null;
  readonly cards: ToolCard[] = [];
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  private event(type: string, payload?: Record<string, unknown>): AppEvent {
    this.sequence += 1;
    return {
      type,
      runId: this.runId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      ...(payload ? { payload } : {}),
    };
  }

  started(): AppEvent {
    return this.event('run.started');
  }

  /** Returns zero or more app events for one Think chunk. */
  chunk(json: string): AppEvent[] {
    let chunk: Record<string, unknown>;
    try {
      chunk = record(JSON.parse(json));
    } catch {
      return [];
    }
    switch (chunk.type) {
      case 'text-delta': {
        const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
        if (!delta) return [];
        this.text += delta;
        return [this.event('assistant.text.delta', { delta })];
      }
      case 'tool-input-available':
      case 'tool-input-error': {
        const id = String(chunk.toolCallId ?? `tool_${this.sequence}`);
        if (this.tools.has(id)) return [];
        const shown = displayTool(String(chunk.toolName ?? ''), chunk.input);
        this.tools.set(id, this.cards.length);
        this.cards.push({ tool: shown.tool, summary: shown.summary });
        const events = [this.event('tool.started', { toolCallId: id, tool: shown.tool, summary: shown.summary })];
        if (chunk.type === 'tool-input-error') {
          events.push(this.toolDone(id, undefined, String(chunk.errorText ?? 'invalid input')));
        }
        return events;
      }
      case 'tool-output-available':
        if (chunk.preliminary === true) return [];
        return [this.toolDone(String(chunk.toolCallId ?? ''), chunk.output)];
      case 'tool-output-error':
        return [this.toolDone(String(chunk.toolCallId ?? ''), undefined, String(chunk.errorText ?? 'error'))];
      case 'error':
        this.error = typeof chunk.errorText === 'string' ? chunk.errorText : 'The reply did not complete.';
        return [];
      default:
        return [];
    }
  }

  /**
   * The events for a run whose live buffer is gone, rebuilt from its stored
   * record. The cards come too: the Worker saves the reply from whatever stream
   * it reads, so a replay without them wiped the tool cards from the chat
   * history of any reply the app reconnected to late (seen 2026-09-15).
   */
  replay(stored: { status: RunStatus; finalText: string; toolCalls: readonly ToolCard[]; usage: RunUsage | null }): AppEvent[] {
    const events = [this.started()];
    stored.toolCalls.forEach((card, index) => {
      const id = `replay_${index}`;
      this.tools.set(id, this.cards.length);
      this.cards.push({ tool: card.tool, summary: card.summary });
      events.push(this.event('tool.started', { toolCallId: id, tool: card.tool, summary: card.summary }));
      events.push(this.event('tool.completed', { toolCallId: id, tool: card.tool, summary: card.summary, output: null }));
    });
    if (stored.status === 'succeeded' && stored.finalText) events.push(...this.chunk(JSON.stringify({ type: 'text-delta', delta: stored.finalText })));
    if (stored.status !== 'working') {
      events.push(this.finish(stored.status === 'succeeded' ? 'completed' : stored.status === 'cancelled' ? 'cancelled' : 'failed', stored.usage));
    }
    return events;
  }

  private toolDone(id: string, output: unknown, errorText?: string): AppEvent {
    const index = this.tools.get(id);
    const card = index === undefined ? undefined : this.cards[index];
    const summary = toolResultSummary(output, errorText);
    if (card && errorText) card.summary = summary;
    return this.event('tool.completed', { toolCallId: id, tool: card?.tool ?? 'tool', summary, output: null });
  }

  failed(message?: string): boolean {
    if (message) this.error = message;
    return this.error !== null;
  }

  /** The terminal event. Usage rides on every outcome: a stopped or failed reply still cost something. */
  finish(outcome: 'completed' | 'failed' | 'cancelled', usage: RunUsage | null = null): AppEvent {
    if (outcome === 'cancelled') return this.event('run.cancelled', { usage });
    if (outcome === 'failed' || this.error !== null) {
      return this.event('run.failed', {
        errorCode: 'agent_error',
        message: friendlyEngineError(this.error),
        usage,
      });
    }
    return this.event('run.completed', { finalText: this.text, usage });
  }

  get finalText(): string {
    return this.text;
  }

  get errorText(): string | null {
    return this.error;
  }
}

/**
 * The way out when a conversation itself is the problem. Without it people
 * resend into the same broken conversation and stay stuck: on 2026-09-16 a
 * photo too big to write out of the context failed every reply, and nothing on
 * screen said a fresh chat would clear it. Alex asked for it on every generic
 * chat failure the same day.
 */
export const FRESH_CHAT_HINT =
  'If it keeps happening, open the menu and tap Start a fresh chat: that clears the conversation, not what it knows about you.';

/** What the person sees when a reply fails. Provider detail stays in the logs. */
export function friendlyEngineError(raw: string | null): string {
  if (raw && /rate.?limit/i.test(raw)) {
    return `Your coworker is very busy for a moment. Please send that again. ${FRESH_CHAT_HINT}`;
  }
  return `That reply did not finish. Please send it again. ${FRESH_CHAT_HINT}`;
}

export function sseFrame(event: AppEvent | '[DONE]'): string {
  return `data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`;
}

// ── What the app sends ────────────────────────────────────────────────────────

/**
 * The app's chat screen prefixes an attached-file message with a note telling
 * the old engine to open the files from its workspace. The agent engine has no
 * workspace: the files travel with the message itself, so the note is removed.
 */
export function stripWorkspaceNote(message: string): string {
  return message
    .replace(/^\[The user attached \d+ files? to your workspace[\s\S]*?\](?:\\n|\n){0,2}/, '')
    .trim();
}

// ── Earlier conversations ─────────────────────────────────────────────────────

type StoredPart = { type: string; text?: string; filename?: string };
export type StoredMessage = { id: string; role: string; parts?: StoredPart[]; metadata?: unknown };

/**
 * A finished conversation as searchable exchanges (one user message and the
 * replies after it), for "Start a fresh chat". Attachment names are kept so a
 * later "the invoice I sent you" can be found.
 */
export function conversationExchanges(messages: StoredMessage[], at: string): string[] {
  const exchanges: string[] = [];
  let current: string[] = [];
  const when = at.slice(0, 16).replace('T', ' ');
  for (const message of messages) {
    const parts = message.parts ?? [];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('').trim();
    const files = parts.filter((p) => p.type === 'file' && p.filename).map((p) => p.filename);
    if (message.role === 'user') {
      if (current.length) exchanges.push(current.join('\n'));
      current = [];
      const attached = files.length ? ` (attached: ${files.join(', ')})` : '';
      if (text || attached) current.push(`${when} User: ${text}${attached}`.trim());
    } else if (message.role === 'assistant' && text) {
      current.push(`${when} Coworker: ${text}`);
    }
  }
  if (current.length) exchanges.push(current.join('\n'));
  return exchanges;
}

export const RESET_COMMANDS = new Set(['/new', '/reset', '/clear']);
