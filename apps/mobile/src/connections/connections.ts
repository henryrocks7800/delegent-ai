import {
  AGENT_CONNECTION_CATEGORIES,
  AGENT_EVERYDAY_TOOLS,
  CONNECTABLE_SERVICES,
  connectionCategoryGroups,
  findConnectionState,
  isServiceOffered,
  type ConnectableService,
  type ConnectionCategory,
  type ConnectionState,
  type EverydayTool,
} from '@sidekick/shared';

// Pure view-model helpers for the Connections screen. No network, no storage.
//
// One feed: the Worker's brokered connection list. The screen used to read a
// second one, the on-box vault inventory, for the services whose credential the
// user typed in themselves. Those are gone, and with them the class of bug
// where a connected provider rendered as disconnected because its state had
// been looked up in the wrong feed.

export type ConnectionStatus = 'connected' | 'not_connected' | 'needs_attention';

export interface ConnectionRow {
  readonly service: ConnectableService;
  readonly status: ConnectionStatus;
  /** A short, secret-free line under the name, e.g. the connected address. */
  readonly detail: string | null;
}

export function buildConnectionRows(
  states: readonly ConnectionState[] = [],
  available: readonly string[] | null = null,
): readonly ConnectionRow[] {
  return CONNECTABLE_SERVICES
    .filter((service) => isServiceOffered(service, available))
    .map((service) => (service.mode === 'oauth'
      ? oauthRow(service, states)
      : { service, status: 'not_connected' as const, detail: null }));
}

function oauthRow(service: ConnectableService, states: readonly ConnectionState[]): ConnectionRow {
  const state = findConnectionState(states, service.id);
  if (state.status === 'connected') {
    return { service, status: 'connected', detail: state.accountLabel };
  }
  if (state.status === 'needs_reauth') {
    // Not an error the user caused, and not something they can fix by
    // fiddling: the grant lapsed at the provider, so the only true
    // instruction is to go through the hand-off again.
    return { service, status: 'needs_attention', detail: `Sign in to ${service.name} again to reconnect.` };
  }
  return { service, status: 'not_connected', detail: null };
}

/**
 * The wire shape of GET /api/connections/oauth. Anything unrecognised is
 * dropped rather than rendered, so a provider we do not have a card for cannot
 * put an unlabelled row on the screen.
 */
export function mapConnectionStates(raw: unknown): readonly ConnectionState[] {
  if (!Array.isArray(raw)) return [];
  const states: ConnectionState[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : '';
    if (!provider) continue;
    states.push({
      provider,
      status: record.status === 'needs_reauth' ? 'needs_reauth' : 'connected',
      accountLabel: typeof record.accountLabel === 'string' && record.accountLabel.trim().length > 0
        ? record.accountLabel.trim()
        : null,
      connectedAt: typeof record.connectedAt === 'string' ? record.connectedAt : null,
    });
  }
  return states;
}

/**
 * The `available` list off the same reply. A missing field is `null`, meaning
 * an older Worker that cannot answer, and the catalogue is then shown whole.
 * An empty array is a real answer and hides every OAuth service.
 */
export function mapAvailableProviders(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export interface ConnectionRowGroup {
  readonly category: ConnectionCategory;
  readonly label: string;
  readonly rows: readonly ConnectionRow[];
}

/** The same rows, under the category headings both surfaces render. */
export function buildConnectionGroups(rows: readonly ConnectionRow[]): readonly ConnectionRowGroup[] {
  return connectionCategoryGroups().map((group) => ({
    category: group.category,
    label: group.label,
    rows: group.services
      .map((service) => rows.find((row) => row.service.id === service.id))
      .filter((row): row is ConnectionRow => row !== undefined),
  })).filter((group) => group.rows.length > 0);
}

export interface AgentConnectionSection {
  readonly category: { readonly key: string; readonly emoji: string; readonly tint: string; readonly title: string; readonly hook: string };
  /** Built-in tools, shown first, with "Try it" instead of Connect. */
  readonly tools: readonly EverydayTool[];
  readonly rows: readonly ConnectionRow[];
}

export const CHOSEN_APPS_CATEGORY = {
  key: 'chosen',
  emoji: '\u{2B50}',
  tint: '#FFF5DB',
  title: 'Your chosen apps',
  hook: 'The apps you picked when you set up',
} as const;

/**
 * Connections for an agent-engine account, as collapsible categories in the
 * style of Skills (Alex, 2026-09-15). The apps picked during setup come first,
 * in a category of their own, and are not repeated further down. A category
 * with nothing to show, because the broker cannot offer its apps, is left out.
 */
export function buildAgentConnectionSections(
  rows: readonly ConnectionRow[],
  chosenIds: readonly string[] = [],
): readonly AgentConnectionSection[] {
  const byId = new Map(rows.map((row) => [row.service.id, row]));
  const sections: AgentConnectionSection[] = [];
  const chosen = rows.filter((row) => chosenIds.includes(row.service.id));
  if (chosen.length > 0) sections.push({ category: CHOSEN_APPS_CATEGORY, tools: [], rows: chosen });
  for (const category of AGENT_CONNECTION_CATEGORIES) {
    const tools = category.builtIn
      .map((id) => AGENT_EVERYDAY_TOOLS.find((tool) => tool.id === id))
      .filter((tool): tool is EverydayTool => tool !== undefined);
    const categoryRows = category.services
      .filter((id) => !chosenIds.includes(id))
      .map((id) => byId.get(id))
      .filter((row): row is ConnectionRow => row !== undefined);
    if (tools.length + categoryRows.length === 0) continue;
    sections.push({ category, tools, rows: categoryRows });
  }
  return sections;
}

export function connectedCount(rows: readonly ConnectionRow[]): number {
  return rows.filter((row) => row.status === 'connected').length;
}

// ---------------------------------------------------------------------------
// Composio wire shapes
//
// The parsing lives HERE rather than in connectionsApi.ts for the same reason
// mapConnectionStates does: connectionsApi imports the Supabase client, which
// pulls in react-native, which esbuild cannot parse, so anything in that file
// is untestable under tsx. Pure in, pure out, fully covered.
// ---------------------------------------------------------------------------

/**
 * The authorise url from POST /api/connections/composio/initiate.
 *
 * Returns null for anything that is not an https url. A value we did not get
 * over https must never reach a browser, and a malformed response has to read
 * as a failure rather than as a link to nowhere.
 */
export function readComposioAuthorizeUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const url = (payload as Record<string, unknown>).redirectUrl;
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  return url;
}

/**
 * Catalogue ids from GET /api/connections/composio.
 *
 * Returns CATALOGUE ids, not Composio slugs, so a caller compares them against
 * the same ids the native path uses and the screen needs no second vocabulary.
 * Anything unreadable maps to an empty list: an unconfigured Worker must leave
 * the page rendering, not error it.
 */
export function mapComposioConnectedIds(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows = (payload as Record<string, unknown>).connections;
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Which Composio-backed cards to OFFER, from GET /api/connections/composio.
 *
 * This exists because of a bug worth naming rather than quietly patching. The
 * screen derived the whole Composio half of `available` from the CONNECTED
 * list, so a card only appeared once it was already connected, and there was
 * therefore no way to connect it. Gmail shipped invisible.
 *
 * `offered` is the Worker's own answer and is preferred. A Worker that predates
 * the field but reports `available: true` falls back to every Composio-backed
 * card in the catalogue: it has a working key, and one card that turns out to be
 * unconnectable is a far smaller fault than the entire feature being invisible.
 * `available: false` offers nothing, which is the honest reading of a broker
 * that is not configured.
 */
export function mapComposioOfferedIds(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as Record<string, unknown>;
  const offered = body.offered;
  if (Array.isArray(offered)) {
    return offered.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  if (body.available !== true) return [];
  return CONNECTABLE_SERVICES.filter((s) => s.backend === 'composio').map((s) => s.id);
}

/*
 * There was a mapComposioAccountIds here: catalogue id to ONE Composio account
 * id, which is what disconnect used to be addressed by. Reducing a service to a
 * single id is the defect. A service can hold two grants, the route deleted
 * one, and the coworker kept its access after the reader had been told it was
 * cut off. Disconnect is addressed by service now and every grant for that
 * service goes. See disconnectComposioService in the Worker.
 */
