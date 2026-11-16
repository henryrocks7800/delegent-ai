/**
 * Which of the product's apps the user has connected, for the prompt.
 *
 * The model used to learn this only by trying an app, so a vague ask ("how much
 * did I make this month?") went to whatever it could see (Gmail) instead of the
 * Stripe account the user had connected, "which apps are you connected to?" got a
 * guess, and an expired connection looked the same as one never made (live QA,
 * 2026-09-23). Composio's connected-accounts list answers it directly. Only the
 * product's own auth configs count, the ones the Connections screen creates.
 */
import { APP_GROUPS, APP_NAMES, PRODUCT_TOOLKITS } from './toolkits.ts';

export type ConnectionState = 'connected' | 'expired';

const API = 'https://backend.composio.dev/api/v3/connected_accounts';
const MAX_PAGES = 6;

type AccountRow = { status?: string; is_disabled?: boolean; toolkit?: { slug?: string }; auth_config?: { id?: string } };

export async function fetchConnectionStates(
  apiKey: string,
  userId: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Map<string, ConnectionState>> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const ours = new Map(PRODUCT_TOOLKITS.map((t) => [t.authConfigId, t.slug]));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 2_500);
  const states = new Map<string, ConnectionState>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ user_ids: userId, limit: '100' });
    query.append('statuses', 'ACTIVE');
    query.append('statuses', 'EXPIRED');
    if (cursor) query.set('cursor', cursor);
    const response = await fetcher(`${API}?${query}`, { headers: { 'x-api-key': apiKey }, signal });
    if (!response.ok) throw new Error(`connected accounts HTTP ${response.status}`);
    const body = (await response.json()) as { items?: AccountRow[]; next_cursor?: string | null };
    for (const item of body.items ?? []) {
      const slug = item.auth_config?.id ? ours.get(item.auth_config.id) : undefined;
      if (!slug || item.toolkit?.slug !== slug) continue;
      if (item.status === 'ACTIVE' && !item.is_disabled) states.set(slug, 'connected');
      else if (item.status === 'EXPIRED' && !states.has(slug)) states.set(slug, 'expired');
    }
    cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    if (!cursor) break;
  }
  return states;
}

/** One line for the prompt, in the app list's order. */
export function connectedAppsLine(states: ReadonlyMap<string, ConnectionState>): string {
  const ordered = APP_GROUPS.flatMap(([, slugs]) => slugs);
  const named = (state: ConnectionState) => ordered.filter((slug) => states.get(slug) === state).map((slug) => APP_NAMES[slug]);
  const connected = named('connected');
  const expired = named('expired');
  return `The user's apps, checked when this message arrived. Connected: ${connected.length ? connected.join(', ') : 'none yet'}.`
    + (expired.length ? ` Connection expired, so they need to reconnect it: ${expired.join(', ')}.` : '')
    + ' Every other app in the list is not connected.';
}
