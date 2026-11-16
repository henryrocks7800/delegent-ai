// Composio, brokered. The Worker holds the key; the runner never sees it.
//
// WHY THIS SHAPE, and it is the whole design in one paragraph.
//
// A Composio API key unlocks EVERY connected account of EVERY customer: their
// Gmail, their Drive, their Slack, all of it, with one string. It is the most
// dangerous secret this product holds. START_HERE's central rule exists for
// exactly this: "the runner never holds a long-lived secret", so a compromised
// runner leaks one customer's files rather than the business. Putting this key
// on a runner would trade that guarantee away for a bit of convenience.
//
// So the runner asks the Worker, the Worker asks Composio, and every call is
// scoped to one user id. Same trust boundary as the model proxy and the
// existing OAuth broker, reusing machinery rather than adding a second model.
//
// IDENTITY. Composio's user_id IS the Supabase user id. No mapping table, so
// nothing to drift, and a connected account is traceable to a Delegent account
// during support or a DSAR without a join.
//
// ⚠️ THE DOCUMENTED CALL IS WRONG FOR MANAGED AUTH. Composio's docs say to use
// connectedAccounts.initiate(). Against the live v3 API that returns:
//   "Creating connections on this endpoint for Composio-managed OAuth auth
//    configs is no longer supported. Use POST /api/v3/connected_accounts/link"
// Verified on 2026-09-01. This module uses /link. If you are reading the docs
// and this file disagrees, this file was tested against the running system.

const API_BASE = 'https://backend.composio.dev/api/v3';

export interface ComposioEnv {
  COMPOSIO_API_KEY?: string;
  /** Where Composio sends the browser back after a grant. */
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN?: string;
}

export type ComposioFetch = typeof fetch;

export interface ComposioDeps {
  fetchImpl?: ComposioFetch;
  /** Test seam. Defaults to a console.warn sink. */
  warn?: (message: string) => void;
}

/**
 * Toolkits we have actually enabled and tested, and the auth config behind each.
 *
 * DELIBERATELY AN ALLOWLIST. Composio exposes 250+ toolkits. Offering the agent
 * everything would bloat every prompt and invite it to attempt services the
 * customer has not connected and we have not tested. A toolkit appears here
 * only once its copy, its permissions and its privacy-policy line exist.
 */
export interface ComposioToolkit {
  /** Composio's slug, e.g. 'gmail'. */
  readonly slug: string;
  /** The auth config created in our Composio account for this toolkit. */
  readonly authConfigId: string;
  /** Matches ConnectableService.id in packages/shared so the UI can join them. */
  readonly connectionId: string;
  /**
   * A READ-ONLY action that proves the connection actually works.
   *
   * Every connector must name one. It is what scripts/ops/verify-composio-connector.mjs
   * runs to answer "is this live for a real customer", and having it here means the
   * answer lives with the connector rather than in a script that drifts from it.
   *
   * It must not send, write, delete or cost anything: the verifier runs against
   * real customer accounts.
   */
  readonly probeTool: string;
  /**
   * Arguments for the probe, when the toolkit has no argument-free read. Trello
   * has no "who am I" without an id, so its probe is the member read with
   * `idMember: 'me'`. Keep it a flat object literal: the verifier reads it out
   * of this source file rather than importing the built module.
   */
  readonly probeArgs?: Readonly<Record<string, string | number | boolean>>;
  /**
   * When set, only tools matching this pattern may run, enforced at the Worker
   * before anything reaches Composio. For providers whose OAuth grant is wider
   * than the card promises. Stripe is the case: it refuses the `read_only`
   * scope for connections like ours ("Please use the read_write scope",
   * verified 2026-09-03 at connect.stripe.com), so the grant is read and write
   * and the read-only promise on the card is kept HERE, not by Stripe.
   */
  readonly allowTools?: RegExp;
}

export const COMPOSIO_TOOLKITS: readonly ComposioToolkit[] = [
  { slug: 'gmail', authConfigId: 'ac_yJvbuQWeA0uQ', connectionId: 'gmail', probeTool: 'GMAIL_GET_PROFILE' },
  // Composio-managed Intuit app, scopes trimmed to accounting + openid on
  // 2026-09-02 (the default also asked for phone and address). The probe is a
  // report with no required arguments; QUICKBOOKS_QUERY_ACCOUNT needs a query.
  { slug: 'quickbooks', authConfigId: 'ac_CpwDNq1gY6SH', connectionId: 'quickbooks', probeTool: 'QUICKBOOKS_CUSTOMER_BALANCE_REPORT' },
  // Replaces the native google_calendar provider (retired 2026-09-02, nobody
  // was connected to it). Scopes trimmed to calendar.events only: Composio's
  // default also asked for full calendar management.
  { slug: 'googlecalendar', authConfigId: 'ac_KLdSotJvCRud', connectionId: 'google_calendar', probeTool: 'GOOGLECALENDAR_EVENTS_LIST', probeArgs: { calendarId: 'primary', maxResults: 1 } },
  // Sheets and Docs: the API scope plus drive.file, NOT full drive. Composio's
  // default granted every file in the customer's Drive, which is a restricted
  // scope and far wider than our own Drive card promises. With drive.file the
  // agent reaches any sheet or doc it is given a link to, and finds by name
  // only what it created; the recipe says so.
  { slug: 'googlesheets', authConfigId: 'ac_FeTHwCDdhUdU', connectionId: 'google_sheets', probeTool: 'GOOGLESHEETS_SEARCH_SPREADSHEETS' },
  { slug: 'googledocs', authConfigId: 'ac_PsV3q6SSPYkm', connectionId: 'google_docs', probeTool: 'GOOGLEDOCS_SEARCH_DOCUMENTS' },
  // Notion's OAuth has no scopes: the customer picks which pages to share on
  // Notion's own consent screen, and that choice IS the permission.
  { slug: 'notion', authConfigId: 'ac_s09pAPZ-CVIm', connectionId: 'notion', probeTool: 'NOTION_GET_ABOUT_ME' },
  // Trello is OAuth 1 at Composio (managed). The default grant is read, write
  // and account, which is what a board tool needs. No argument-free read exists,
  // so the probe is the member read with the 'me' alias.
  { slug: 'trello', authConfigId: 'ac_QNe0qOc-Owo5', connectionId: 'trello', probeTool: 'TRELLO_GET_MEMBERS_BY_ID_MEMBER', probeArgs: { idMember: 'me' } },
  // Asana's OAuth has no scopes to trim: the grant is the user's whole Asana.
  { slug: 'asana', authConfigId: 'ac_m7EZFROEEf8X', connectionId: 'asana', probeTool: 'ASANA_GET_MULTIPLE_WORKSPACES' },
  // ClickUp's OAuth has no scopes: the customer picks which Workspaces to
  // authorise on ClickUp's own screen, and that choice is the permission.
  { slug: 'clickup', authConfigId: 'ac_xItBm4Cs2L7H', connectionId: 'clickup', probeTool: 'CLICKUP_GET_AUTHORIZED_USER' },
  // Batch of 2026-09-02 (docs/CONNECTOR_BATCH_2026-09-02.md). Scopes trimmed
  // at creation: tasks only; photos read-only; jira and confluence to read and
  // write work content. Zendesk, Jira and Confluence ask the customer for
  // their subdomain on Composio's page, which the cards say.
  { slug: 'googletasks', authConfigId: 'ac_Vy7TZ9VfHRWi', connectionId: 'google_tasks', probeTool: 'GOOGLETASKS_LIST_TASK_LISTS' },
  { slug: 'zendesk', authConfigId: 'ac_4_dJCvlr3uBJ', connectionId: 'zendesk', probeTool: 'ZENDESK_GET_ABOUT_ME' },
  { slug: 'jira', authConfigId: 'ac_x1D8YNApVlw0', connectionId: 'jira', probeTool: 'JIRA_GET_CURRENT_USER' },
  { slug: 'confluence', authConfigId: 'ac_N5S3ZjgfUJyM', connectionId: 'confluence', probeTool: 'CONFLUENCE_GET_PAGES' },
  // Group 2 of the batch. OneDrive trimmed from Files.ReadWrite.All plus
  // SharePoint sites to Files.ReadWrite; HubSpot to contacts, companies and
  // deals; Stripe to read_only; YouTube to readonly; Reddit to identity, read
  // and submit. Salesforce's own scope is `full` and cannot be narrowed, and
  // its card says so. Instagram and Facebook grants are Meta's fixed sets for
  // business accounts and Pages.
  { slug: 'one_drive', authConfigId: 'ac_B2WlSEXZcnRW', connectionId: 'onedrive', probeTool: 'ONE_DRIVE_GET_RECENT_ITEMS' },
  { slug: 'hubspot', authConfigId: 'ac_fyyHSY9Ftc_e', connectionId: 'hubspot', probeTool: 'HUBSPOT_HUBSPOT_LIST_CONTACTS', probeArgs: { limit: 1 } },
  { slug: 'salesforce', authConfigId: 'ac_rdvHLRV9NJ5C', connectionId: 'salesforce', probeTool: 'SALESFORCE_GET_USER_INFO' },
  // Stripe rejects the read_only scope outright for OAuth connections (400 at
  // connect.stripe.com, 2026-09-03: every Connect tap died there). The auth
  // config therefore asks for read_write, and the read-only promise is kept by
  // allowTools: only list, retrieve and search actions can ever run.
  { slug: 'stripe', authConfigId: 'ac__cYajU1M4cDP', connectionId: 'stripe', probeTool: 'STRIPE_RETRIEVE_BALANCE', allowTools: /^STRIPE_(LIST|RETRIEVE|SEARCH)_/ },
  { slug: 'youtube', authConfigId: 'ac_0q1Pgmgk7HlM', connectionId: 'youtube', probeTool: 'YOUTUBE_LIST_USER_PLAYLISTS' },
  { slug: 'reddit', authConfigId: 'ac_C0ZEgGc-180r', connectionId: 'reddit', probeTool: 'REDDIT_GET_USER_FLAIR', probeArgs: { subreddit: 'announcements' } },
  { slug: 'linkedin', authConfigId: 'ac_LQ8sqUg-8H6d', connectionId: 'linkedin', probeTool: 'LINKEDIN_GET_MY_INFO' },
  { slug: 'instagram', authConfigId: 'ac_1XFhh0NqqNR7', connectionId: 'instagram', probeTool: 'INSTAGRAM_GET_USER_INFO' },
  { slug: 'facebook', authConfigId: 'ac_A494rpSkqjBQ', connectionId: 'facebook', probeTool: 'FACEBOOK_GET_USER_PAGES' },
  // API-key connectors. No OAuth exists for these providers, so Composio's
  // hosted page asks the customer for their key (and, for Freshdesk and
  // Firecrawl, their account address), and holds it. The key never passes
  // through chat or through us, which is the whole reason to route it this
  // way rather than through the on-box vault.
  { slug: 'pdf_co', authConfigId: 'ac_XHuHmq4de1hq', connectionId: 'pdf_co', probeTool: 'PDF_CO_ACCOUNT_BALANCE_INFO' },
  { slug: 'freshdesk', authConfigId: 'ac_BkhcoiLgZO-m', connectionId: 'freshdesk', probeTool: 'FRESHDESK_LIST_ALL_TICKETS' },
  { slug: 'firecrawl', authConfigId: 'ac_aUWDVARaC-B1', connectionId: 'firecrawl', probeTool: 'FIRECRAWL_SCRAPE', probeArgs: { url: 'https://delegentai.co.uk' } },
  // Moved off our own OAuth onto Composio on 2026-09-03, at Alex's request:
  // "I would actually rather use composio for all of them so it's consistent
  // across the piece ... they probably have access to more services cuz the
  // ones that we did apart from free agent were very limited." Our native
  // integrations offered a handful of calls each; these are 11 to 823.
  // FreeAgent stays ours, because Composio lists the toolkit and ships zero
  // actions for it, so swapping would delete the integration.
  //
  // Every default scope was trimmed on the day: Teams asked for
  // Directory.ReadWrite.All and Group.ReadWrite.All, Slack for usergroups:write
  // and users.profile:write, Outlook for Teams chat, GitHub for workflow and
  // codespace. None of that is in any card's promise.
  { slug: 'googledrive', authConfigId: 'ac_xYJKrPk-aQir', connectionId: 'google_drive', probeTool: 'GOOGLEDRIVE_GET_ABOUT' },
  { slug: 'dropbox', authConfigId: 'ac_o0sg9nW5E1m6', connectionId: 'dropbox', probeTool: 'DROPBOX_GET_ABOUT_ME' },
  { slug: 'outlook', authConfigId: 'ac_lykFfU9mg4sg', connectionId: 'microsoft_outlook', probeTool: 'OUTLOOK_LIST_CALENDARS' },
  { slug: 'microsoft_teams', authConfigId: 'ac_B8jQhcu9lknb', connectionId: 'microsoft_teams', probeTool: 'MICROSOFT_TEAMS_TEAMS_LIST' },
  { slug: 'slack', authConfigId: 'ac_hSCwO6g_ZT1e', connectionId: 'slack', probeTool: 'SLACK_FETCH_TEAM_INFO' },
  { slug: 'github', authConfigId: 'ac_cNTHF5StYQTj', connectionId: 'github', probeTool: 'GITHUB_USERS_GET_AUTHENTICATED' },
  { slug: 'figma', authConfigId: 'ac_7d5uv_v5MWaW', connectionId: 'figma', probeTool: 'FIGMA_GET_CURRENT_USER' },
  // API-key connectors: the provider offers no OAuth we can use, so Composio's
  // hosted page collects a token from the customer's own account.
  // AgentMail has no argument-free read: every list needs the customer's
  // inbox_id, which only they know, so the live probe cannot run for it and
  // the recipe tells the agent to ask. Verified against the schema 2026-09-08.
  { slug: 'agent_mail', authConfigId: 'ac_RoQKVn4HIWwn', connectionId: 'agent_mail', probeTool: 'AGENT_MAIL_LIST_MESSAGES' },
  { slug: 'shopify', authConfigId: 'ac_Wj11Owr0uFoH', connectionId: 'shopify', probeTool: 'SHOPIFY_GET_PRODUCTS' },
  { slug: 'webflow', authConfigId: 'ac_VEsW3PeRLi4I', connectionId: 'webflow', probeTool: 'WEBFLOW_LIST_WEBFLOW_SITES' },
];

export function toolkitBySlug(slug: string): ComposioToolkit | null {
  return COMPOSIO_TOOLKITS.find((t) => t.slug === slug) ?? null;
}

export function toolkitByConnectionId(id: string): ComposioToolkit | null {
  return COMPOSIO_TOOLKITS.find((t) => t.connectionId === id) ?? null;
}

export type ComposioResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ComposioErrorCode; detail?: string; retryAfterSeconds?: number };

export type ComposioErrorCode =
  | 'not_configured'
  | 'unknown_toolkit'
  | 'unreachable'
  | 'refused'
  | 'rate_limited'
  | 'quota_exceeded';

async function call<T>(
  env: ComposioEnv,
  deps: ComposioDeps,
  path: string,
  init: RequestInit = {},
): Promise<ComposioResult<T>> {
  const key = env.COMPOSIO_API_KEY?.trim();
  // Absence must be an ordinary outcome. A Worker deployed without the key has
  // to keep serving chat, not 500 on every connections read.
  if (!key) return { ok: false, error: 'not_configured' };

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${API_BASE}${path}`, {
      ...init,
      // A hung Composio call must not hang the runner's whole turn. The runner
      // waits 60s; this gives up first so the agent gets an answer it can act on.
      signal: AbortSignal.timeout(25_000),
      headers: {
        'x-api-key': key,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    deps.warn?.(`composio ${path} unreachable: ${String(err)}`);
    return { ok: false, error: 'unreachable' };
  }

  if (response.status === 429) {
    const value = response.headers.get('retry-after')?.trim();
    const seconds = value && /^\d+$/.test(value)
      ? Number(value)
      : value ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
    return {
      ok: false,
      error: 'rate_limited',
      ...(Number.isSafeInteger(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {}),
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    deps.warn?.(`composio ${path} -> ${response.status} ${body.slice(0, 200)}`);
    return { ok: false, error: 'refused', detail: `${response.status}` };
  }
  const json = (await response.json().catch(() => null)) as T | null;
  if (json === null) return { ok: false, error: 'refused', detail: 'unparseable' };
  return { ok: true, value: json };
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectLink {
  readonly redirectUrl: string;
  readonly connectedAccountId: string;
  readonly expiresAt: string | null;
}

/**
 * Start a connection for ONE user and return the link they must open.
 *
 * Uses /connected_accounts/link, not the documented initiate(). See the header.
 */
export type ComposioReturnSurface = 'app' | 'web';

export async function initiateConnection(
  env: ComposioEnv,
  userId: string,
  toolkitSlug: string,
  deps: ComposioDeps = {},
  surface: ComposioReturnSurface = 'web',
): Promise<ComposioResult<ConnectLink>> {
  // Accept EITHER the card id or Composio's slug. Both clients send
  // `service.id` (the card id), and the /composio list endpoint publishes card
  // ids in `offered`, so the card id is the real contract. For most toolkits
  // the two strings are equal, which is why this went unnoticed: the six where
  // they differ (google_calendar/googlecalendar, google_sheets, google_docs,
  // google_tasks, google_photos, onedrive/one_drive) had a DEAD Connect button
  // that returned unknown_toolkit, found 2026-09-03 by initiating every card id
  // in turn. Card id is tried first because that is what the clients send.
  const toolkit = toolkitByConnectionId(toolkitSlug) ?? toolkitBySlug(toolkitSlug);
  if (!toolkit) return { ok: false, error: 'unknown_toolkit' };

  const origin = env.SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN?.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    auth_config_id: toolkit.authConfigId,
    user_id: userId,
  };
  // Omit rather than send an empty callback: Composio falls back to its own
  // success page, which is a better outcome than redirecting to nowhere.
  // The surface is carried in OUR OWN path, not in a query parameter, because
  // the callback has to be able to trust it. Composio redirects a browser here
  // and we control nothing else about that request. A phone that started the
  // flow must land back in the app: sending it to the web app is how someone
  // ends up staring at a browser wondering whether what they just did worked.
  if (origin) {
    body.callback_url = `${origin}/api/connections/composio/callback${surface === 'app' ? '/app' : ''}`;
  }

  const res = await call<{
    redirect_url?: string;
    connected_account_id?: string;
    expires_at?: string;
  }>(env, deps, '/connected_accounts/link', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) return res;

  const { redirect_url: redirectUrl, connected_account_id: id } = res.value;
  if (typeof redirectUrl !== 'string' || !redirectUrl
    || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return { ok: false, error: 'refused', detail: 'no valid link returned' };
  }
  return {
    ok: true,
    value: { redirectUrl, connectedAccountId: id, expiresAt: res.value.expires_at ?? null },
  };
}

export interface ConnectedToolkit {
  readonly connectedAccountId: string;
  readonly toolkitSlug: string;
  readonly connectionId: string;
  readonly active: boolean;
}

/**
 * What this user has actually connected, filtered to our allowlist.
 *
 * Filtering matters: an account connected in the Composio dashboard for a
 * toolkit we have not shipped copy for must not appear in the app, or the UI
 * promises something with no permissions text behind it.
 */
export async function listConnections(
  env: ComposioEnv,
  userId: string,
  deps: ComposioDeps = {},
): Promise<ComposioResult<readonly ConnectedToolkit[]>> {
  const res = await call<{ items?: Array<{ id?: string; status?: string; toolkit?: { slug?: string } }> }>(
    // ACTIVE only, server side. Every Connect tap creates a new account record
    // and abandoned ones sit as INITIATED/EXPIRED until Composio purges them, so
    // an unfiltered first page can fill with dead records and push the one live
    // connection off it. That reads as "not connected" for a connected user.
    env, deps, `/connected_accounts?user_ids=${encodeURIComponent(userId)}&statuses=ACTIVE&limit=100`,
  );
  if (!res.ok) return res;

  const out: ConnectedToolkit[] = [];
  for (const item of res.value.items ?? []) {
    const slug = item.toolkit?.slug;
    const toolkit = slug ? toolkitBySlug(slug) : null;
    if (!toolkit || !item.id) continue;
    out.push({
      connectedAccountId: item.id,
      toolkitSlug: toolkit.slug,
      connectionId: toolkit.connectionId,
      // Only ACTIVE counts. INITIALIZING means the user opened the link and has
      // not finished, and offering the agent a half-made connection produces a
      // tool call that fails in front of the customer.
      active: String(item.status ?? '').toUpperCase() === 'ACTIVE',
    });
  }
  return { ok: true, value: out };
}

export async function disconnect(
  env: ComposioEnv,
  connectedAccountId: string,
  deps: ComposioDeps = {},
): Promise<ComposioResult<true>> {
  const res = await call<unknown>(env, deps, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
    method: 'DELETE',
  });
  return res.ok ? { ok: true, value: true } : res;
}

export interface ComposioOwnedAccount {
  readonly connectedAccountId: string;
  readonly toolkitSlug: string | null;
  /** Our catalogue id, or null for a toolkit this build does not offer. */
  readonly connectionId: string | null;
  readonly status: string;
}

export interface ComposioOwnedInventory {
  readonly accounts: readonly ComposioOwnedAccount[];
  /**
   * False when a page failed or the page bound was reached. Absence from
   * `accounts` then proves nothing, which is the difference between "there is
   * no grant" and "we could not finish looking".
   */
  readonly complete: boolean;
}

/** A stop, so a looping or enormous inventory cannot hold a request open. */
const OWNED_INVENTORY_PAGE_BOUND = 50;

/**
 * EVERY connected account Composio holds for this user. Any status, any
 * toolkit, every page.
 *
 * Deliberately not listConnections. That one filters to ACTIVE, allowlisted
 * toolkits on a single page because it answers "which cards are green", and
 * the filtering is right for that. It is wrong for anything that has to REMOVE
 * what we hold: a disabled account still exists at Composio and can be
 * re-enabled, a toolkit since dropped from the catalogue still holds a live
 * grant, and a user with more than a page of abandoned attempts has their real
 * connections pushed off the end.
 *
 * The cursor field and the response shape were read from the live v3 API on
 * 2026-09-13, four pages and 160 records. A repeated cursor is treated as a
 * provider loop rather than followed.
 */
export async function listOwnedComposioAccounts(
  env: ComposioEnv,
  userId: string,
  deps: ComposioDeps = {},
): Promise<ComposioResult<ComposioOwnedInventory>> {
  const accounts: ComposioOwnedAccount[] = [];
  const seenCursors = new Set<string>();
  const seenAccounts = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < OWNED_INVENTORY_PAGE_BOUND; page++) {
    const query = new URLSearchParams({ user_ids: userId, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const res = await call<{ items?: Array<{ id?: string; status?: string; toolkit?: { slug?: string } }>; next_cursor?: unknown }>(
      env, deps, '/connected_accounts?' + query.toString(),
    );
    // A first page we never got is an unreadable inventory, not an empty one.
    // A later page that fails leaves what we did read, marked incomplete.
    if (!res.ok) return page === 0 ? res : { ok: true, value: { accounts, complete: false } };
    for (const item of res.value.items ?? []) {
      if (typeof item.id !== 'string' || !item.id || seenAccounts.has(item.id)) continue;
      seenAccounts.add(item.id);
      const slug = typeof item.toolkit?.slug === 'string' ? item.toolkit.slug : null;
      accounts.push({
        connectedAccountId: item.id,
        toolkitSlug: slug,
        connectionId: slug ? toolkitBySlug(slug)?.connectionId ?? null : null,
        status: String(item.status ?? 'UNKNOWN').toUpperCase(),
      });
    }
    const next = typeof res.value.next_cursor === 'string' && res.value.next_cursor ? res.value.next_cursor : null;
    if (!next) return { ok: true, value: { accounts, complete: true } };
    if (seenCursors.has(next)) {
      deps.warn?.('connected account inventory repeated a pagination cursor');
      return { ok: true, value: { accounts, complete: false } };
    }
    seenCursors.add(next);
    cursor = next;
  }
  deps.warn?.('connected account inventory exceeded its page bound');
  return { ok: true, value: { accounts, complete: false } };
}

export interface ComposioServiceDisconnect {
  readonly removed: readonly string[];
  readonly failed: readonly string[];
  /** False when the owned inventory could not be read to the end. */
  readonly complete: boolean;
}

/**
 * Disconnect every grant this user holds for one catalogue service.
 *
 * The card is per service and the confirmation says access is lost straight
 * away, so that is what has to happen. Deleting one account id left a second
 * live grant behind and the agent carried on working, against a promise the
 * reader had just been shown. Every record for the toolkit goes, whatever its
 * status: a disabled or half-finished one is not access, but it is ours, and
 * leaving it behind is what fills the first page and hides real connections.
 *
 * Ownership comes from the inventory read, which is scoped to this user id, so
 * no id supplied by a caller is ever deleted on trust.
 */
export async function disconnectComposioService(
  env: ComposioEnv,
  userId: string,
  connectionId: string,
  deps: ComposioDeps = {},
): Promise<ComposioResult<ComposioServiceDisconnect>> {
  const toolkit = toolkitByConnectionId(connectionId);
  if (!toolkit) return { ok: false, error: 'unknown_toolkit' };
  const inventory = await listOwnedComposioAccounts(env, userId, deps);
  if (!inventory.ok) return inventory;
  const removed: string[] = [];
  const failed: string[] = [];
  for (const account of inventory.value.accounts) {
    if (account.toolkitSlug !== toolkit.slug) continue;
    const res = await disconnect(env, account.connectedAccountId, deps);
    (res.ok ? removed : failed).push(account.connectedAccountId);
  }
  return { ok: true, value: { removed, failed, complete: inventory.value.complete } };
}

export interface ComposioRevokeSweep {
  readonly revoked: readonly string[];
  readonly failed: readonly string[];
  /**
   * False when the inventory could not be read to the end, so an empty
   * `failed` does not mean nothing was left behind.
   */
  readonly complete: boolean;
}

/**
 * Drop every Composio-held grant this user has. Used by account deletion.
 *
 * The native sweep in connections-oauth.ts cannot see these: they are not in
 * our table, they are at Composio. Without this a deleted account left its
 * Gmail grant live, while the privacy policy states that deleting the account
 * deletes every stored token. Best effort by design, like the native sweep: a
 * partner being down must not stop someone leaving. What comes back is a
 * record of what actually happened, never an assumption.
 */
export async function revokeAllComposioConnections(
  env: ComposioEnv,
  userId: string,
  deps: ComposioDeps = {},
): Promise<ComposioRevokeSweep> {
  const revoked: string[] = [];
  const failed: string[] = [];
  // The owned inventory, not the display list. The display list is filtered to
  // ACTIVE, allowlisted, first-page records, so a sweep built on it reported
  // zero failures while leaving an inactive grant, a dropped toolkit's grant
  // and everything past page one exactly where they were.
  const list = await listOwnedComposioAccounts(env, userId, deps);
  // not_configured means there is nothing at Composio for anyone; any other
  // failure means we could not even find out, which is reported as such.
  if (!list.ok) {
    return list.error === 'not_configured'
      ? { revoked, failed, complete: true }
      : { revoked, failed: ['*'], complete: false };
  }
  for (const account of list.value.accounts) {
    const res = await disconnect(env, account.connectedAccountId, deps);
    (res.ok ? revoked : failed).push(account.connectedAccountId);
  }
  return { revoked, failed, complete: list.value.complete };
}

// ---------------------------------------------------------------------------
// Execute, with a ceiling
// ---------------------------------------------------------------------------

/**
 * Per-user monthly tool-execution ceiling.
 *
 * Composio bills per execution ($0.0003). The unit price is trivial; an agent
 * stuck in a loop is not. At 3,000 calls a month a customer costs about 70p,
 * so this ceiling sits far above honest use and only catches runaways.
 *
 * Deliberately enforced HERE rather than only as a Composio spend cap: their
 * cap protects the account, this protects the customer whose agent is looping
 * and tells us which one it was.
 */
export const COMPOSIO_MONTHLY_EXECUTION_CEILING = 20_000;

export interface ExecuteDeps extends ComposioDeps {
  /** Executions this user has already made in the current billing cycle. */
  usedThisCycle: (userId: string) => Promise<number>;
  /** Record one execution. Best-effort; a failure here must not fail the call. */
  recordExecution?: (userId: string, toolSlug: string) => Promise<void>;
}

export async function executeTool(
  env: ComposioEnv,
  userId: string,
  toolSlug: string,
  args: Record<string, unknown>,
  deps: ExecuteDeps,
): Promise<ComposioResult<unknown>> {
  const used = await deps.usedThisCycle(userId).catch(() => 0);
  if (used >= COMPOSIO_MONTHLY_EXECUTION_CEILING) {
    deps.warn?.(`composio ceiling hit for ${userId}: ${used}`);
    return { ok: false, error: 'quota_exceeded' };
  }

  const res = await call<unknown>(env, deps, `/tools/execute/${encodeURIComponent(toolSlug)}`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, arguments: args }),
  });

  // Count attempts, not successes. A loop that fails every time still costs.
  if (deps.recordExecution) await deps.recordExecution(userId, toolSlug).catch(() => undefined);
  return res;
}
