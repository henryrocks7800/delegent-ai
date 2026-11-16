// A ceiling on what one app-tool result may put in front of the model.
//
// 2026-09-19, two real customers on the same morning, both on their first real
// job, both ending in "I couldn't finish that" with every retry failing at
// once:
//   - "sort my Outlook inbox into folders": one turn reached 1,042,511 input
//     tokens and the provider refused it.
//   - "read my Gmail and tell me what the first 10 messages say": one fetch of
//     ten full messages, and the very next step failed.
// The same prompt on the test account scraped through at 834,364 input tokens
// and cost $0.25 for a single reply, which is 5% of a month's allowance.
//
// The cause is the app tools returning whole message bodies. Think truncates
// its own actions' output, but tools that come from Composio over MCP execute
// inside the MCP client, so wrapping their `execute` does nothing (measured:
// the wrap never fired). The honest place to cap is the message list itself,
// in beforeStep, right before each model call: whatever produced the result,
// this is what the provider is about to be sent.
//
// WHY THIS IS NOT A SUBSTRING ANY MORE. The first version sliced the serialised
// JSON at 24,000 characters, which cost a paying customer her afternoon on
// 2026-09-19. Measured that day against her own toolkit: Outlook returns 20
// messages as 654,826 characters, an id is 140 characters long, and a 24,000
// character slice therefore ends inside message 3 of 20. The model read the
// fragment as data, sent half an id to the move tool, and Outlook answered
// "malformed message ID" for every message in the batch. Her transcript:
// "Outlook is rejecting every newly retrieved message ID as malformed".
//
// So the cap now keeps WHOLE records and drops the fat fields inside them. A
// record either arrives complete or is not shown at all, which makes a
// half-written id impossible rather than unlikely. Measured on the same
// mailbox: the same 20 messages come back as 11,178 characters with every
// 140-character id intact.
import type { ModelMessage } from 'ai';

/**
 * About 6k tokens: enough to see the shape of what came back and a record or
 * two, cheap enough that a result the model is about to fetch again does not
 * cost real money on a £3.99 plan.
 */
export const TOOL_OUTPUT_MAX_CHARS = 24_000;

/** Aggregate completed tool history, including call arguments and message/part overhead. */
export const TOOL_CONTEXT_MAX_CHARS = 96_000;

/**
 * Most fields longer than this inside a listing are bodies, HTML or attachments.
 * Identifier and cursor fields are explicitly exempt: an unusually long ID must
 * remain whole, rather than being mistaken for body text.
 */
export const BULKY_FIELD_MAX_CHARS = 600;

/** Small groups are deliberate reads, so keep bounded body excerpts instead of stripping bodies. */
const LISTING_MIN_RECORDS = 4;

// Directive, not descriptive. The first version simply said the result was too
// large, and the model stopped and told the user it "would need to fetch them
// in a lighter format first", which is a worse answer than the failure it
// replaced. It has the steps to fix this itself, so tell it to.
const NOTE =
  '\n\n[Delegent: this result was too large to send, so only a bounded excerpt is shown. Do not mention this to the user and do not ask their permission. Call the tool again now with a smaller request: about 20 items at a time, and only the fields you need (for email the sender, subject and date, never the message bodies). Then answer the question.]';

type ToolResultPartLike = {
  type?: string;
  toolCallId?: string;
  approvalId?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown } | unknown;
};

/** The text a capped result carries: the start of what came back, plus what to do about it. */
export function cappedText(serialized: string): string {
  const prefix = serialized.slice(0, TOOL_OUTPUT_MAX_CHARS - NOTE.length);
  // Unknown text can itself be an opaque ID/token. Cut at a text boundary, never inside one.
  const boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
  return `${boundary < 0 ? '' : prefix.slice(0, boundary)}${NOTE}`;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Not serialisable (a cycle, a BigInt). Treat it as small: the provider
    // would reject it anyway, and guessing its size helps nobody.
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The longest array of objects anywhere in the result, with the path to it.
 *
 * Every mail toolkit buries its list somewhere different: Outlook answers
 * `data.response_data.value`, Gmail answers `data.messages`. Rather than a
 * table of shapes to keep current, find the list by looking.
 */
function findRecordList(value: unknown, depth = 0): { list: Record<string, unknown>[]; parent: Record<string, unknown>; key: string } | null {
  if (Array.isArray(value) && value.length && value.every(isRecord)) {
    return { list: value, parent: { items: value }, key: 'items' };
  }
  if (depth > 5 || !isRecord(value)) return null;
  let best: { list: Record<string, unknown>[]; parent: Record<string, unknown>; key: string } | null = null;
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && child.length && child.every(isRecord)) {
      if (!best || child.length > best.list.length) best = { list: child as Record<string, unknown>[], parent: value, key };
    } else {
      const nested = findRecordList(child, depth + 1);
      if (nested && (!best || nested.list.length > best.list.length)) best = nested;
    }
  }
  return best;
}

/** One record with its bulky fields removed, and the names of what went. */
const ID_OR_CURSOR = /(^id$|^ids$|_ids?$|Id$|Ids$|cursor|page.?token|next.?link|delta.?link)/i;
const PAGINATION = /(^next$|^previous$|cursor|page.?token|next.?link|delta.?link|has.?more|^total.?count$)/i;

function paginationMarkers(value: unknown, depth = 0, path = ''): Record<string, unknown> {
  if (depth > 5 || !isRecord(value)) return {};
  const markers: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = path ? `${path}.${key}` : key;
    if (PAGINATION.test(key) && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')) {
      // Keep complete markers, or omit them completely if they cannot fit.
      if (serialize({ ...markers, [name]: child }).length <= 8_000) markers[name] = child;
    } else if (isRecord(child)) Object.assign(markers, paginationMarkers(child, depth + 1, name));
  }
  return serialize(markers).length <= 8_000 ? markers : {};
}

function slimRecord(record: Record<string, unknown>): { slim: Record<string, unknown>; dropped: string[] } {
  const slim: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!ID_OR_CURSOR.test(key) && serialize(value).length > BULKY_FIELD_MAX_CHARS) dropped.push(key);
    else slim[key] = value;
  }
  return { slim, dropped };
}

/**
 * A capped result that a model can safely act on: whole records only, bulky
 * fields named rather than shown, and a note saying how to get the rest.
 *
 * Returns null when the value is not a listing, so the caller can shorten body
 * fields inside valid JSON or cut plain text only at a text boundary.
 */
export function cappedStructured(value: unknown): string | null {
  const found = findRecordList(value);
  if (!found || found.list.length < LISTING_MIN_RECORDS) return null;

  const droppedFields = new Set<string>();
  const slimmed = found.list.map((record) => {
    const { slim, dropped } = slimRecord(record);
    for (const name of dropped) droppedFields.add(name);
    return slim;
  });

  const pagination = paginationMarkers(value);
  const paginationNote = Object.keys(pagination).length ? ` Pagination markers (complete): ${JSON.stringify(pagination)}.` : '';
  const fields = [...droppedFields].filter((name) => name.length <= 80).sort().slice(0, 8);
  const total = found.list.length;
  const noteFor = (count: number) => [
    `[Delegent: ${count} of ${total} items shown, complete and safe to use.`,
    fields.length ? ` Large fields were removed from each item: ${fields.join(', ')}.` : '',
    total > count ? ` ${total - count} item${total - count === 1 ? '' : 's'} not shown.` : '',
    ' Do not mention any of this to the user and do not ask their permission.',
    ' Every id here is complete: use ids exactly as they appear, and never an id that is not in this list.',
    total > count ? ' Do not skip omitted items using the next-page cursor. Repeat a smaller page from the original cursor or use the durable inbox job status.' : '',
    fields.length ? ' To avoid this, pass the tool its own field selector (Outlook: select; Gmail: verbose false and include_payload false).' : '',
    paginationNote,
    ']',
  ].join('');

  // Whole records only, reserving space for intact pagination markers and the note.
  const kept: Record<string, unknown>[] = [];
  let used = 2;
  for (const record of slimmed) {
    const size = serialize(record).length + 1;
    if (used + size + noteFor(kept.length + 1).length > TOOL_OUTPUT_MAX_CHARS) break;
    kept.push(record);
    used += size;
  }

  return `${JSON.stringify(kept)}${noteFor(kept.length)}`;
}

/** Shorten body text inside valid JSON. IDs, tokens and unknown opaque strings are never sliced. */
function slimSingle(value: unknown, maxText: number, key = '', depth = 0): unknown {
  if (depth > 12) return '[nested content omitted]';
  if (typeof value === 'string') {
    if (ID_OR_CURSOR.test(key)) return value;
    if (value.length > maxText && /^[\s]*[\[{]/.test(value)) {
      try { return slimSingle(JSON.parse(value), maxText, key, depth + 1); }
      catch { return '[oversized malformed structured text omitted]'; }
    }
    if (value.length <= maxText) return value;
    if (/body|content|html|text|snippet|description/i.test(key)) return `${value.slice(0, maxText)}[text shortened]`;
    return '[large field omitted]';
  }
  if (Array.isArray(value)) return value.map((child) => slimSingle(child, maxText, key, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, slimSingle(child, maxText, name, depth + 1)]));
  return value;
}

/** The bounded text for one oversized result, with JSON values and identifiers kept whole. */
export function capValue(value: unknown): string {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { value = JSON.parse(value); } catch { return `[Delegent: oversized malformed structured output omitted. Request a smaller valid response.]`; }
  }
  const listing = cappedStructured(value);
  if (listing) return listing;
  if (isRecord(value) || Array.isArray(value)) {
    for (const maxText of [8_000, 2_000, 600, 0]) {
      const serialized = serialize(slimSingle(value, maxText));
      if (serialized.length + NOTE.length <= TOOL_OUTPUT_MAX_CHARS) return `${serialized}${NOTE}`;
    }
    const markers = paginationMarkers(value);
    return `${JSON.stringify({ pagination: markers })}\n[Delegent: this structured result cannot fit with whole identifiers. Use a smaller request or the durable inbox job status; never reconstruct missing IDs.]`;
  }
  return cappedText(serialize(value));
}

const OLD_RESULT_NOTE = '[Delegent: earlier tool output omitted from model context. Execution status is unchanged. Check the durable inbox job status/cursor to resume; do not repeat reads or writes solely to rebuild this history.]';
const HISTORY_NOTE = '[Delegent tool history: older completed tool exchanges were compacted or omitted to bound model context. This does not undo their actions. Use durable inbox job status and its recorded cursor/counts for progress. Do not replay completed writes or restart inbox reads to reconstruct this history.]';

function boundedOutput(output: unknown, value: string): unknown {
  if (isRecord(output) && output.type === 'execution-denied') return { type: 'execution-denied', reason: value };
  if (isRecord(output) && (output.type === 'error-json' || output.type === 'error-text')) return { type: 'error-text', value };
  return { type: 'text', value };
}

type HistoryPart = { message: number; index: number; part: ToolResultPartLike; size: number; overhead: number; removed?: boolean };

/**
 * Keep the newest useful results, then bound completed history including huge call arguments.
 * Pending/incomplete exchanges and ordinary conversation are deliberately not removed.
 * Their size is outside this completed-history budget; changing them could lose user intent
 * or invalidate an in-flight call. The caller must bound newly created tool arguments.
 */
function capCompletedHistory(messages: ModelMessage[]): ModelMessage[] | null {
  const entries: HistoryPart[] = [];
  const groups = new Map<string, { calls: HistoryPart[]; results: HistoryPart[]; approvals: HistoryPart[] }>();
  const approvals = new Map<string, string>();
  const cost = (part: unknown, overhead: number) => serialize(part).length + overhead;
  for (let message = 0; message < messages.length; message++) {
    const current = messages[message];
    if (!['assistant', 'tool'].includes(current.role) || !Array.isArray(current.content)) continue;
    // Charge the complete wrapper for every part. This conservatively remains valid after
    // removing one part from a mixed message, and includes provider-specific metadata.
    const overhead = serialize({ ...current, content: [] }).length + 2;
    for (let index = 0; index < current.content.length; index++) {
      const part = current.content[index] as ToolResultPartLike;
      if (!['tool-call', 'tool-result', 'tool-approval-request', 'tool-approval-response'].includes(part.type ?? '')) continue;
      const entry = { message, index, part, overhead, size: cost(part, overhead) };
      entries.push(entry);
      if (typeof part.toolCallId !== 'string') continue;
      const group = groups.get(part.toolCallId) ?? { calls: [], results: [], approvals: [] };
      groups.set(part.toolCallId, group);
      if (part.type === 'tool-call') group.calls.push(entry);
      else if (part.type === 'tool-result') group.results.push(entry);
      else {
        group.approvals.push(entry);
        if (part.approvalId) approvals.set(part.approvalId, part.toolCallId);
      }
    }
  }
  for (const entry of entries) {
    if (entry.part.type === 'tool-approval-response' && entry.part.approvalId) {
      const id = approvals.get(entry.part.approvalId);
      if (id) groups.get(id)?.approvals.push(entry);
    }
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const existingNoteSize = messages.some((message) => message.role === 'assistant' && message.content === HISTORY_NOTE)
    ? serialize({ role: 'assistant', content: HISTORY_NOTE }).length + 1 : 0;
  if (total + existingNoteSize <= TOOL_CONTEXT_MAX_CHARS) return null;
  const budget = TOOL_CONTEXT_MAX_CHARS - HISTORY_NOTE.length - 100;
  const completed = [...groups.values()].filter((group) => group.calls.length > 0 && group.calls.length === group.results.length)
    .sort((a, b) => a.results.at(-1)!.message - b.results.at(-1)!.message || a.results.at(-1)!.index - b.results.at(-1)!.index);
  let changed = false;
  // Compact older output first. Preserve the newest complete result when it fits.
  for (const group of completed.slice(0, -1)) {
    if (total <= budget) break;
    for (const entry of group.results) {
      const replacement = { ...entry.part, output: boundedOutput(entry.part.output, OLD_RESULT_NOTE) };
      const size = cost(replacement, entry.overhead);
      if (size >= entry.size) continue;
      total -= entry.size - size;
      entry.part = replacement;
      entry.size = size;
      changed = true;
    }
  }
  // Tiny tombstones, call arguments and IDs still grow with page count. Remove whole oldest
  // exchanges when necessary, including their approvals, never one half of a pair.
  for (const group of completed) {
    if (total <= budget) break;
    for (const entry of [...group.calls, ...group.results, ...group.approvals]) {
      if (entry.removed) continue;
      total -= entry.size;
      entry.removed = true;
      changed = true;
    }
  }
  if (!changed) return null;
  const byMessage = new Map<number, Map<number, HistoryPart>>();
  for (const entry of entries) {
    if (!byMessage.has(entry.message)) byMessage.set(entry.message, new Map());
    byMessage.get(entry.message)!.set(entry.index, entry);
  }
  const out: ModelMessage[] = [];
  let noted = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'assistant' && message.content === HISTORY_NOTE) continue;
    const changes = byMessage.get(index);
    if (!changes || !Array.isArray(message.content)) { out.push(message); continue; }
    if (!noted) { out.push({ role: 'assistant', content: HISTORY_NOTE }); noted = true; }
    const content = message.content.flatMap((part, partIndex) => {
      const entry = changes.get(partIndex);
      return entry?.removed ? [] : [entry?.part ?? part];
    });
    if (content.length) out.push({ ...message, content } as ModelMessage);
  }
  return out;
}

/**
 * Bound individual outputs and the aggregate completed tool history. Returns
 * null when nothing needed capping, so the caller can leave the step untouched.
 *
 * `toolCallId` and `toolName` are preserved: a provider rejects a transcript
 * whose tool results do not match their calls.
 */
export function capToolResultsInMessages(messages: readonly ModelMessage[]): ModelMessage[] | null {
  let cappedAny = false;
  const out = messages.map((message) => {
    if (!['tool', 'assistant'].includes(message.role) || !Array.isArray(message.content)) return message;
    let cappedHere = false;
    const content = message.content.map((part) => {
      const p = part as ToolResultPartLike;
      if (p.type !== 'tool-result') return part;
      const output = p.output;
      const shaped = output !== null && typeof output === 'object' ? (output as { type?: string; value?: unknown }) : null;
      const value = shaped?.type === 'execution-denied' && isRecord(output) ? output.reason
        : shaped && 'value' in shaped ? shaped.value : output;
      const serialized = serialize(value);
      if (serialized.length <= TOOL_OUTPUT_MAX_CHARS) return part;
      cappedHere = true;
      cappedAny = true;
      return { ...(part as object), output: boundedOutput(output, capValue(value)) };
    });
    return cappedHere ? ({ ...message, content } as ModelMessage) : message;
  });
  return capCompletedHistory(out) ?? (cappedAny ? out : null);
}
