import type { Env } from './index.js';
import { usesAgentEngine } from './agent-engine.js';
import { sendPushToUser, type PushMessage } from './push.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64_000;
const count = (value: number) => value.toLocaleString('en-GB');
// The app's small Markdown renderer does not implement backslash escapes.
// Neutralize delimiters visibly, and prevent directional controls hiding counts.
const DELIMITERS: Record<string, string> = { '*': '＊', '_': '＿', '`': '｀', '[': '［', ']': '］', '~': '～' };
const label = (value: string) => value
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  .replace(/[*_`\[\]~]/g, (char) => DELIMITERS[char]);

// Bulk inbox sorting ("sort my inbox"). Keep in sync with the engine's SortNotice
// in apps/agent/src/inboxSortStore.ts. Counts and destination names only.
interface SortNotice {
  kind: 'sort'; id: string; sortId: string; provider: 'gmail' | 'outlook'; outcome: 'plan' | 'done' | 'failed';
  total: number; toFile: number; stay: number; filed: number; groups: { name: string; count: number; newFolder: boolean }[];
}
const SORT_KEYS = ['kind', 'id', 'sortId', 'provider', 'outcome', 'total', 'toFile', 'stay', 'filed', 'groups'];
const SORT_COUNTS = ['total', 'toFile', 'stay', 'filed'] as const;
const sortCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;

export function parseSortNotice(value: unknown): SortNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const n = value as SortNotice;
  if (n.kind !== 'sort' || Object.keys(n).length !== SORT_KEYS.length || Object.keys(n).some((key) => !SORT_KEYS.includes(key))
    || !UUID.test(n.id) || !UUID.test(n.sortId) || !['gmail', 'outlook'].includes(n.provider)
    || !['plan', 'done', 'failed'].includes(n.outcome) || SORT_COUNTS.some((key) => !sortCount(n[key]))
    || !Array.isArray(n.groups) || n.groups.length > 50) return null;
  for (const group of n.groups) {
    if (!group || typeof group !== 'object' || Object.keys(group).sort().join(',') !== 'count,name,newFolder'
      || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 256
      || !sortCount(group.count) || !group.count || typeof group.newFolder !== 'boolean') return null;
  }
  if (n.total !== n.toFile + n.stay) return null;
  if (n.outcome === 'plan' && (n.filed || !n.toFile || n.groups.reduce((sum, group) => sum + group.count, 0) !== n.toFile)) return null;
  if (n.outcome !== 'plan' && (n.groups.length || n.filed > n.toFile)) return null;
  return n;
}

/**
 * How long filing should take, from the notice's own counts. Calibrated on a
 * real Outlook run (2026-09-24: about a minute per 1,000 emails in the inbox);
 * Gmail files by search and is much faster. Rounded up so it under-promises.
 * Keep in sync with apps/agent/src/inboxSortEstimate.ts.
 */
export function sortEstimateMinutes(provider: 'gmail' | 'outlook', total: number, toFile: number): number {
  if (provider === 'outlook') return Math.ceil(Math.max(0, total) / 1000) + 2;
  return Math.ceil(Math.max(0, toFile) / 5000) + 1;
}
export function formatSortDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 5) return 'a few minutes';
  if (minutes < 60) return `about ${Math.ceil(minutes / 5) * 5} minutes`;
  const rounded = Math.ceil(minutes / 15) * 15;
  const hours = Math.floor(rounded / 60); const rest = rounded % 60;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
}

/** Fixed wording: the engine supplies only counts and folder names. */
export function sortNoticeText(n: SortNotice): string {
  const provider = n.provider === 'outlook' ? 'Outlook' : 'Gmail';
  if (n.outcome === 'plan') {
    const rows = n.groups.map((group) => `- ${label(group.name)}${group.newFolder ? ' (new folder)' : ''}: ${count(group.count)}`).join('\n');
    return `Here is the plan for your ${provider} inbox. I checked ${count(n.total)} emails and can file ${count(n.toFile)} of them into folders:\n\n${rows}\n\n`
      + `${count(n.stay)} stay in your inbox: people you write to, anything that might need you, and recent security codes.\n\n`
      + `Nothing has moved yet. Shall I go ahead? It should take ${formatSortDuration(sortEstimateMinutes(n.provider, n.total, n.toFile))}. `
      + 'One yes sorts the lot, newest first. You can keep using the app or close it, and I will message you when it is done. Nothing is ever deleted or marked as read.';
  }
  if (n.outcome === 'done') {
    // Nothing to file is its own answer, not "I filed 0 emails into their
    // folders, newest first" (QA F20, 2026-09-23).
    if (n.toFile === 0) {
      return `Your ${provider} inbox is already tidy. I checked ${count(n.total)} emails and none of them need filing, so nothing was moved.`;
    }
    const left = n.toFile - n.filed;
    return `Your ${provider} inbox is sorted. I filed ${count(n.filed)} emails into their folders, newest first. `
      + `${count(n.stay)} are still in your inbox for you to look at.`
      + (left > 0 ? ` ${count(left)} changed while I was working, so I left them where they were.` : '')
      + ' Nothing was deleted or marked as read.';
  }
  // A failure before any filing is a failed plan: saying "the emails already
  // filed are in their folders" there confused people, because none were.
  if (n.filed === 0) {
    return `I couldn't finish planning how to sort your ${provider} inbox because of a problem on my side. Nothing was moved or changed. Ask me to try again when you like.`;
  }
  return `Sorting your ${provider} inbox stopped after ${count(n.filed)} emails because of a problem on my side. The emails already filed are in their folders and nothing else changed. Ask me to try again when you like.`;
}

// Money Finder ("find money in my inbox"). Keep in sync with the engine's
// MoneyNotice in apps/agent/src/moneyFinderStore.ts. Report-only: amounts,
// company names and a short fixed-shape detail, never an email's text.
type MoneyKind = 'flight_compensation' | 'refund_due' | 'upgrade_overcharge' | 'subscription' | 'price_rise' | 'trial_ending';
interface MoneyItem { kind: MoneyKind; merchant: string; amountPence: number; yearlyPence: number; detail: string }
interface MoneyNotice {
  kind: 'money'; id: string; runId: string; provider: 'gmail' | 'outlook' | 'yahoo'; outcome: 'report' | 'failed'; read: number;
  owedPence: number; subscriptionCount: number; subscriptionsYearlyPence: number; priceRisesYearlyPence: number; trialsEnding: number;
  items: MoneyItem[];
}
const MONEY_KEYS = ['kind', 'id', 'runId', 'provider', 'outcome', 'read', 'owedPence', 'subscriptionCount',
  'subscriptionsYearlyPence', 'priceRisesYearlyPence', 'trialsEnding', 'items'];
const MONEY_COUNTS = ['read', 'owedPence', 'subscriptionCount', 'subscriptionsYearlyPence', 'priceRisesYearlyPence', 'trialsEnding'] as const;
const MONEY_KINDS: MoneyKind[] = ['flight_compensation', 'refund_due', 'upgrade_overcharge', 'subscription', 'price_rise', 'trial_ending'];
const pence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000_000;

export function parseMoneyNotice(value: unknown): MoneyNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const n = value as MoneyNotice;
  if (n.kind !== 'money' || Object.keys(n).length !== MONEY_KEYS.length || Object.keys(n).some((key) => !MONEY_KEYS.includes(key))
    || !UUID.test(n.id) || !UUID.test(n.runId) || !['gmail', 'outlook', 'yahoo'].includes(n.provider)
    || !['report', 'failed'].includes(n.outcome) || MONEY_COUNTS.some((key) => !pence(n[key]))
    || !Array.isArray(n.items) || n.items.length > 15) return null;
  for (const item of n.items) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'amountPence,detail,kind,merchant,yearlyPence'
      || !MONEY_KINDS.includes(item.kind) || typeof item.merchant !== 'string' || !item.merchant.trim() || item.merchant.length > 60
      || typeof item.detail !== 'string' || item.detail.length > 120 || !pence(item.amountPence) || !pence(item.yearlyPence)) return null;
  }
  if (n.outcome === 'failed' && n.items.length) return null;
  return n;
}

const pounds = (value: number) => `£${(value / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Fixed wording: the engine supplies only amounts, company names and a short detail. */
export function moneyNoticeText(n: MoneyNotice): string {
  const provider = n.provider === 'outlook' ? 'Outlook' : n.provider === 'yahoo' ? 'Yahoo Mail' : 'Gmail';
  if (n.outcome === 'failed') {
    return `I couldn't finish checking your ${provider} inbox for money because of a problem on my side. Nothing was sent or changed. Ask me to try again when you like.`;
  }
  if (!n.items.length) {
    return `I checked ${count(n.read)} likely emails in your ${provider} inbox and found nothing to chase: no delayed or cancelled flights that qualify for compensation, no refunds still outstanding, and no subscriptions I could spot. Nothing was sent or changed.`;
  }
  const of = (kinds: MoneyKind[]) => n.items.filter((item) => kinds.includes(item.kind));
  const who = (item: MoneyItem) => label(item.merchant);
  const sections: string[] = [];
  const owed = of(['flight_compensation', 'refund_due', 'upgrade_overcharge']);
  if (owed.length) {
    sections.push(`Money you may be owed, about ${pounds(n.owedPence)}:\n` + owed.map((item) => item.kind === 'flight_compensation'
      ? `- ${who(item)}, ${label(item.detail)}: up to ${pounds(item.amountPence)} flight compensation`
      : item.kind === 'upgrade_overcharge'
        ? `- ${who(item)}: ${pounds(item.amountPence)} back, you ${label(item.detail)}`
        : `- ${who(item)}: a ${pounds(item.amountPence)} refund, ${label(item.detail)}`).join('\n'));
  }
  const rises = of(['price_rise']);
  if (rises.length) sections.push('Price rises:\n' + rises.map((item) => `- ${who(item)} ${label(item.detail)}, ${pounds(item.yearlyPence)} a year more`).join('\n'));
  const trials = of(['trial_ending']);
  if (trials.length) sections.push('Free trials about to start charging:\n' + trials.map((item) => `- ${who(item)}: ${label(item.detail)}`
    + (item.amountPence ? `, then ${pounds(item.amountPence)}` : '')).join('\n'));
  const subscriptions = of(['subscription']);
  if (subscriptions.length) {
    sections.push(`Subscriptions, ${count(n.subscriptionCount)} costing about ${pounds(n.subscriptionsYearlyPence)} a year:\n`
      + subscriptions.map((item) => `- ${who(item)}: ${pounds(item.amountPence)} ${label(item.detail)}, ${pounds(item.yearlyPence)} a year`).join('\n'));
  }
  return `I checked ${count(n.read)} likely emails in your ${provider} inbox. Here is what I found.\n\n${sections.join('\n\n')}\n\n`
    + (owed.some((item) => item.kind === 'flight_compensation')
      ? 'Flight claims are possible, not certain: airlines can refuse for things like bad weather, and the amount is per passenger. ' : '')
    + (owed.some((item) => item.kind === 'upgrade_overcharge')
      ? 'For an upgrade charged in full, ask the app store (or the company) to refund the earlier charge. ' : '')
    + (n.items.length >= 15 ? 'These are the biggest items; ask me for the full list. ' : '')
    + 'Nothing was sent or changed. Ask me and I can draft a claim or a cancellation for any of these.';
}

async function boundedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
  } catch { return null; }
  const joined = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

async function authenticated(request: Request, secret: string, body: string): Promise<string | null> {
  const userId = request.headers.get('x-sidekick-user-id') ?? '';
  const time = request.headers.get('x-sidekick-notice-timestamp') ?? '';
  const token = request.headers.get('x-sidekick-notice-token') ?? '';
  if (!secret || !UUID.test(userId) || !/^\d{10}$/.test(time) || !/^v1\.[a-f0-9]{64}$/.test(token)
    || Math.abs(Date.now() / 1000 - Number(time)) > 300) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(token.slice(3).match(/../g)!, (byte) => Number.parseInt(byte, 16));
  return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`inbox-notice:v1:${userId}:${time}:${body}`)) ? userId : null;
}

/** Engine-only callback. The engine applies the pilot allowlist before delivery. */
export async function handleInboxNotice(request: Request, env: Env, dependencies: {
  fetch?: typeof fetch; push?: (env: Env, userId: string, message: PushMessage) => Promise<number>;
} = {}): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const bad = (status: number) => new Response(null, { status });
  try {
    const body = await boundedBody(request);
    if (body === null) return bad(413);
    const userId = await authenticated(request, (env.SIDEKICK_AGENT_SHARED_SECRET ?? '').trim(), body);
    if (!userId || !(await usesAgentEngine(env, userId))) return bad(401);
    let value: unknown;
    try { value = JSON.parse(body); } catch { return bad(400); }
    const sort = parseSortNotice(value);
    const money = sort ? null : parseMoneyNotice(value);
    if (!sort && !money) return bad(400);
    const id = (sort ?? money)!.id;
    const content = sort ? sortNoticeText(sort) : moneyNoticeText(money!);
    const base = env.SUPABASE_URL?.replace(/\/+$/, '');
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return bad(503);
    const send = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    // A pending erasure may still have a profile, so its FK alone is not a guard.
    // Acknowledge and discard, rather than recreating chat or pushing during erasure.
    const deletion = await send(`${base}/rest/v1/account_deletion_requests?user_id=eq.${userId}&select=id&limit=1`,
      { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!deletion.ok) return bad(503);
    const deletions = await deletion.json();
    if (!Array.isArray(deletions)) return bad(503);
    if (deletions.length) return bad(204);
    const url = `${base}/rest/v1/messages`;
    const response = await send(`${url}?on_conflict=id&select=id`, { method: 'POST', headers: {
      ...headers, prefer: 'resolution=ignore-duplicates,return=representation',
    }, body: JSON.stringify({ id, user_id: userId, conversation_id: userId, role: 'assistant', channel: 'system',
      content, status: 'complete', attachment_metadata: [] }), signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!response.ok) return bad(503);
    const rows = await response.json() as { id?: string }[];
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length && rows[0].id !== id)) return bad(503);
    if (!rows.length) {
      // Never acknowledge a conflicting ID belonging to another account or payload.
      const existing = await send(`${url}?id=eq.${id}&user_id=eq.${userId}&role=eq.assistant&channel=eq.system&status=eq.complete&select=content&limit=1`,
        { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      if (!existing.ok) return bad(503);
      const saved = await existing.json() as { content?: string }[];
      return Array.isArray(saved) && saved.length === 1 && saved[0].content === content ? bad(204) : bad(409);
    }
    // Existing best-effort FCM semantics: only the insertion winner sends. The
    // durable chat record survives a push failure; duplicates never send twice.
    const message: PushMessage = money ? {
      title: money.outcome === 'report' ? 'Your money check is ready' : 'Your money check needs attention',
      body: 'Open the app for the details.', data: { kind: 'reply' },
    } : {
      title: sort!.outcome === 'plan' ? 'Your inbox plan is ready' : sort!.outcome === 'done' ? 'Your inbox is sorted' : 'Your inbox sort needs attention',
      body: sort!.outcome === 'plan' ? 'Open the app to say yes to it.' : 'Open the app for the details.', data: { kind: 'reply' },
    };
    try { await (dependencies.push ?? sendPushToUser)(env, userId, message); } catch { /* Courtesy push cannot undo committed display. */ }
    return bad(204);
  } catch { return bad(503); }
}
