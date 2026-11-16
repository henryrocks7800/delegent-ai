import type { Env } from './index.js';

/**
 * Backend-brokered OAuth for Connections.
 *
 * The client never sees the authorization code or either token. The Worker
 * mints `state` + a PKCE verifier, owns the one registered HTTPS callback,
 * exchanges the code, holds the refresh token encrypted in Postgres, and hands
 * the runner a short-lived access token per use. Custody rationale is written
 * out in supabase/migrations/0047_oauth_connections.sql.
 *
 * The older /api/connections route (runner vault, user-pasted API keys) is a
 * different thing and stays where it is.
 */

type ReturnSurface = 'app' | 'web';

type OAuthProvider = {
  readonly id: string;
  /** How the agent should say the provider's name out loud. */
  readonly displayName: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /**
   * Kill the grant at the provider on disconnect. A function rather than a URL
   * because the four providers disagree on how: Dropbox and Slack accept the
   * token as a bearer header, Google wants it in the form body, and GitHub
   * wants the app's own credentials plus a DELETE. Null means the provider
   * offers no revoke we can call, in which case disconnect still deletes our
   * copy and the access token dies on its own.
   *
   * Resolves true only when the provider accepted, so account deletion can put
   * on record which grants really were withdrawn instead of assuming they all
   * were. Disconnect ignores the answer: it must not be blocked by a provider
   * outage either way.
   */
  readonly revoke: ((accessToken: string, env: Env) => Promise<boolean>) | null;
  /**
   * Sent as `scope` on the authorize request. Empty means send no scope param
   * at all, which is not the same as sending an empty one: Slack asks for user
   * scopes under `user_scope` instead, and a GitHub App carries its permissions
   * in the app registration rather than on the request.
   */
  readonly scopes: readonly string[];
  /** Extra authorize-request params. Dropbox needs token_access_type=offline
   *  or it issues a short-lived token with no refresh token at all. */
  readonly authorizeParams: Readonly<Record<string, string>>;
  /**
   * Replaces the whole authorize URL for providers that do not start at a plain
   * OAuth authorize endpoint. GitHub Apps do not, and the difference is not
   * cosmetic: /login/oauth/authorize establishes who the user is and grants
   * access to nothing, because a GitHub App's reach comes from its INSTALLATION
   * and a user access token can only touch the intersection of what the user
   * can see and what the app was installed on. Sent there with no installation,
   * that intersection is empty: the connection reports success, the account
   * label resolves, and every repository call afterwards finds nothing. The
   * user is also never shown the repository picker, which the safety sheet
   * promises them by name. The install URL shows the picker, and because the
   * app has user authorization on install switched on, GitHub runs the OAuth
   * flow straight afterwards and returns to the same callback with a code.
   */
  readonly buildAuthorizeUrl?: (state: string, env: Env) => string;
  readonly clientIdEnvKey: keyof Env;
  /**
   * Null for a public client. Dropbox is PKCE-only and has no secret to send;
   * everyone else is a confidential client and the exchange fails without it.
   * When set, the provider is treated as unconfigured until the secret exists,
   * so a half-configured provider fails at the start of the journey rather
   * than after the user has already approved at the provider.
   */
  readonly clientSecretEnvKey: keyof Env | null;
  /**
   * Pull the token out of the provider's response. Defaults to the OAuth 2.0
   * shape. Slack returns 200 with the user token nested a level down, so it
   * needs its own reader.
   */
  readonly parseToken: (payload: unknown) => TokenResponse | null;
  /**
   * Whether a response we could not read means the grant is permanently dead.
   *
   * Only consulted when the provider answered 200 and `parseToken` still came
   * back empty. Slack needs this: it reports a revoked grant as HTTP 200 with
   * `ok:false`, so without this hook a Slack connection the user had removed
   * would retry for ever instead of asking them to reconnect.
   */
  readonly isTerminalFailure: (payload: unknown) => boolean;
  readonly accountLabel: (accessToken: string) => Promise<string | null>;
  /**
   * Show our own "connect" screen first (what is asked for, and that the
   * sign-in happens on the provider's own page), then continue to the
   * provider. The screen is built from the stored flow, never from a query
   * parameter, so it cannot be turned into an open redirect.
   */
  readonly interstitial?: { readonly accent: string; readonly permissions: readonly string[]; readonly cannot: string };
};

/** The common shape: the provider takes the token as a bearer header. */
function bearerPostRevoke(url: string): (accessToken: string) => Promise<boolean> {
  return async (accessToken: string) => {
    const response = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })).catch(() => null);
    return Boolean(response?.ok);
  };
}

function neverTerminal(): boolean {
  return false;
}

// A GitHub APP, deliberately not a classic OAuth App. An OAuth App issues a
// user token that never expires and has no refresh token, so a single leak out
// of the workspace would be permanent. A GitHub App with expiring user tokens
// switched on issues an 8-hour token plus a refresh token, which is the shape
// the broker is built around. Permissions live in the app registration rather
// than in a scope parameter, so `scopes` is empty here on purpose.
// Overridable because the slug is derived from the app's NAME at registration,
// and the registration guide tells whoever runs it to pick another name if
// "Delegent AI" is taken. A wrong slug here is a 404 at the start of the
// journey, so it must not be a constant nobody can reach.
const GITHUB_DEFAULT_APP_SLUG = 'delegent-ai';

/**
 * Shared by both Google connections, which differ in scope and in which env
 * keys hold their client, so a user can connect Drive without also handing
 * over their calendar and we can switch Drive on while Calendar waits for
 * Google's verification.
 *
 * `access_type=offline` is what produces a refresh token, and `prompt=consent`
 * is what keeps producing one: without it Google prompts only on the first
 * authorization ever, so a reconnect returns an access token with no refresh
 * token and the connection quietly dies an hour later.
 */
const GOOGLE_AUTHORIZE_PARAMS: Readonly<Record<string, string>> = {
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'false',
};

// calendar.events is a SENSITIVE scope, so this one cannot go live until the
// OAuth client passes Google's verification. Until then Google shows an
// unverified-app warning and caps the project at 100 users for its entire
// lifetime, a cap that cannot be reset even after verification passes.
//
// Its own env keys, deliberately, even though it will most likely end up
// holding the same client as Drive. drive.file needs no verification and
// calendar.events does, so they become sellable at different times, and sharing
// one key would mean setting Drive's credentials silently offered Calendar too:
// every user who tapped it would meet an unverified-app warning and burn one of
// the hundred lifetime slots. Two keys is what lets Drive ship now and Calendar
// wait. They must also belong to a Google project that is NOT the one behind
// Google sign-in, or the sensitive scope drags sign-in into the same regime.
// Google Calendar moved to the Composio broker on 2026-09-02 (see composio.ts,
// toolkit `googlecalendar`, connectionId `google_calendar`). Nobody was
// connected through this native provider when it was retired, and retiring it
// means one fewer Google OAuth app for us to keep verified. The two
// SIDEKICK_GOOGLE_CALENDAR_CLIENT_* secrets are now unused and can be deleted
// from Doppler and from the Google Cloud project whenever convenient.

/**
 * Microsoft Graph, entered twice.
 *
 * One Entra app registration can serve both and most likely will, but they get
 * separate key pairs for the same reason Drive and Calendar do: mail and Teams
 * are very different asks, and setting one pair must not silently offer the
 * other. Filling in only the Outlook keys leaves Teams hidden.
 *
 * The tenant segment differs on purpose. Mail through Graph works on a personal
 * outlook.com account as well as a work one, so Outlook uses `common`. Teams
 * chat does not exist on a personal Microsoft account, so Teams uses
 * `organizations`: sending a consumer account down that flow would connect
 * successfully, label correctly, and then find no chats at all, which is the
 * worst kind of failure because everything looks like it worked.
 *
 * `User.Read` is on both and is not padding: it is the only thing that lets
 * `accountLabel` say WHICH mailbox is connected. Graph refuses `/me` without
 * it, and a card that cannot name the account it is attached to is how somebody
 * connects their personal address believing it is their work one.
 *
 * `prompt=select_account` for the same reason. A Microsoft user very often has
 * work and personal signed in at once, and without it they are connected as
 * whichever the browser happened to see last, with no chance to say otherwise.
 */
const MICROSOFT_AUTHORIZE_PARAMS: Readonly<Record<string, string>> = {
  prompt: 'select_account',
};

function microsoftAuthorizeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function microsoftTokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

// FreeAgent has NO scope system at all. There is no read-only grant, no
// per-area narrowing, nothing: approving the app gives full access to that
// company's accounting data, including creating and deleting records.
//
// That is the same fact that made Stripe unbuildable (see docs/connections/
// STATUS.md), and it is recorded here so nobody later assumes a narrower grant
// was available and we simply failed to ask for it. The difference is purpose:
// a bookkeeper that cannot write cannot enter an expense, which is the entire
// job someone connects it for. So the trade-off is stated plainly on the card
// instead of being quietly hidden, and the safety sheet says "full access" in
// those words.
//
// Confirmed against the live API 2026-08-05: credentials in the form body
// authenticate the client (an invalid code came back `invalid_grant`, not
// `invalid_client`), so the generic exchange path works with no Basic-auth
// special case. Verified before writing this row, not assumed.
//
// There is no documented revoke endpoint, so `revoke` is null: disconnect
// deletes our copy and the card points the user at FreeAgent's own app list.
const FREEAGENT: OAuthProvider = {
  id: 'freeagent',
  displayName: 'FreeAgent',
  authorizeUrl: 'https://api.freeagent.com/v2/approve_app',
  tokenUrl: 'https://api.freeagent.com/v2/token_endpoint',
  revoke: null,
  scopes: [],
  authorizeParams: {},
  clientIdEnvKey: 'SIDEKICK_FREEAGENT_CLIENT_ID',
  clientSecretEnvKey: 'SIDEKICK_FREEAGENT_CLIENT_SECRET',
  parseToken: parseTokenResponse,
  isTerminalFailure: neverTerminal,
  accountLabel: freeagentAccountLabel,
};

// Six providers were retired here on 2026-09-03 and moved to Composio, at
// Alex's request, so every connection is brokered the same way: dropbox, slack,
// github, google_drive, microsoft_outlook and microsoft_teams. Their card ids
// are unchanged, so a card that used to be ours is now the same card on a
// different backend. Only Alex held a native connection to any of them
// (checked live against user_connections), and he asked for the swap.
//
// FreeAgent stays. Composio lists a freeagent toolkit and ships ZERO actions
// for it, so moving it would delete a working integration to gain nothing.
// Yahoo Mail, and AOL Mail, which signs in through the same Yahoo account
// system. Built on our own broker rather than Composio because no Composio-like
// service covers Yahoo at a viable price (research, 2026-09-25): Nango's paid
// plan has a $50 monthly minimum, Nylas is about $2 a mailbox a month.
//
// ⚠️ Mail access is NOT self-serve. Yahoo only grants the mail-r scope after
// it approves the app (Mail API access form plus a commercial agreement). Until
// SIDEKICK_YAHOO_CLIENT_ID and _SECRET exist, providerConfigured() is false and
// the start endpoint answers provider_not_configured, so this ships inert.
//
// Read-only on purpose: mail-r. Money Finder and "find that email" need to
// read; nothing here needs to send, move or delete, so we do not ask for it.
// There is no documented revoke endpoint, so disconnect deletes our copy and
// the card points the user at Yahoo's own "Recent activity" page.
const YAHOO_MAIL: OAuthProvider = {
  id: 'yahoo_mail',
  displayName: 'Yahoo Mail',
  authorizeUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
  tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
  revoke: null,
  scopes: ['openid', 'email', 'mail-r'],
  authorizeParams: {},
  clientIdEnvKey: 'SIDEKICK_YAHOO_CLIENT_ID',
  clientSecretEnvKey: 'SIDEKICK_YAHOO_CLIENT_SECRET',
  parseToken: parseTokenResponse,
  isTerminalFailure: (payload) => isRecord(payload) && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(String(payload.error)),
  accountLabel: yahooAccountLabel,
  interstitial: {
    accent: '#6001D2',
    permissions: ['Read your emails and folders', 'See your email address'],
    cannot: 'It cannot send, move or delete anything in your mailbox.',
  },
};

const PROVIDERS: Readonly<Record<string, OAuthProvider>> = {
  freeagent: FREEAGENT,
  yahoo_mail: YAHOO_MAIL,
};

/** Providers the agent engine may ask for a token for, over the signed internal route. */
export const ENGINE_TOKEN_PROVIDERS: ReadonlySet<string> = new Set(['yahoo_mail']);

/**
 * Per-user burst ceiling on the two endpoints that start and finish a hand-off.
 *
 * Ten a minute is far above anything a person does by hand (a connect is two
 * calls, and there are seven providers) and far below what a loop does. Both
 * endpoints are already behind a bearer token, so this is not a doorway to
 * anywhere; what it stops is one account being able to mint flow rows and fire
 * token exchanges at seven third parties as fast as a script can ask. Without
 * it a stuck client could write unbounded rows into connection_oauth_flows,
 * whose only cleanup is the opportunistic purge at the end of a SUCCESSFUL
 * connect, so the rows that never complete are exactly the ones nothing sweeps.
 *
 * Its own bucket rather than the chat limiter's, so a burst of connects cannot
 * take away the sends the same person has left, and because the right ceiling
 * for the two is nowhere near the same number. In-isolate only, like the chat
 * limiter, and for the same reason: correctness across isolates would mean a
 * Durable Object, and the runaway-client class this catches does not need one.
 */
const CONNECTION_ATTEMPTS_PER_MINUTE = 10;
const CONNECTION_BURST_BUCKETS = new Map<string, { count: number; resetAt: number }>();

function withinConnectionBurstLimit(userId: string, now: number = Date.now()): boolean {
  const bucket = CONNECTION_BURST_BUCKETS.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    // Bounded so a stream of distinct user ids cannot grow this without limit.
    // Clearing rather than evicting one entry is deliberate: the window is a
    // minute, so the worst a clear costs is one minute of forgiveness.
    if (CONNECTION_BURST_BUCKETS.size > 10_000) CONNECTION_BURST_BUCKETS.clear();
    CONNECTION_BURST_BUCKETS.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= CONNECTION_ATTEMPTS_PER_MINUTE) return false;
  bucket.count += 1;
  return true;
}

const FLOW_TTL_SECONDS = 600;
const TOKEN_REQUEST_BUDGET_MS = 18_000;
/** Refresh this far ahead of expiry so a turn never starts on a token that
 *  dies mid-request. */
const ACCESS_TOKEN_SKEW_SECONDS = 120;
const PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_ORIGIN = 'https://api.delegantai.co.uk';
const DEFAULT_WEB_RETURN_URL = 'https://delegent-app.web.app/connections';
const APP_RETURN_URL = 'sidekick://connections/return';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /api/connections/oauth/:provider/start */
export async function handleConnectionStart(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: 'unknown_provider' }, 404);
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  if (!providerConfigured(env, provider)) return json({ error: 'provider_not_configured' }, 503);

  const userId = await authedUserId(request, env);
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  if (!withinConnectionBurstLimit(userId)) return json({ error: 'rate_limited' }, 429);

  const body = await request.json().catch(() => null);
  const surface: ReturnSurface = isRecord(body) && body.surface === 'app' ? 'app' : 'web';

  const state = randomHex(32);
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))),
  );

  const inserted = await supabaseFetch(supabaseRestUrl(env, 'connection_oauth_flows'), {
    method: 'POST',
    headers: { ...supabaseHeaders(env, true), prefer: 'return=minimal' },
    body: JSON.stringify({
      state,
      user_id: userId,
      provider: provider.id,
      code_verifier: codeVerifier,
      return_surface: surface,
      expires_at: new Date(Date.now() + FLOW_TTL_SECONDS * 1000).toISOString(),
    }),
  });
  if (!inserted || !inserted.ok) return json({ error: 'connection_start_failed' }, 502);

  if (provider.buildAuthorizeUrl) {
    return json(
      { authorizeUrl: provider.buildAuthorizeUrl(state, env), expiresInSeconds: FLOW_TTL_SECONDS },
      200,
    );
  }
  if (provider.interstitial) {
    return json({ authorizeUrl: interstitialUrl(env, provider.id, state), expiresInSeconds: FLOW_TTL_SECONDS }, 200);
  }

  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', requireNonEmpty(env[provider.clientIdEnvKey]));
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl(env, provider.id));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (provider.scopes.length > 0) authorizeUrl.searchParams.set('scope', provider.scopes.join(' '));
  for (const [key, value] of Object.entries(provider.authorizeParams)) authorizeUrl.searchParams.set(key, value);

  return json({ authorizeUrl: authorizeUrl.toString(), expiresInSeconds: FLOW_TTL_SECONDS }, 200);
}

function interstitialUrl(env: Env, providerId: string, state: string): string {
  const origin = (nonEmptyString(env.SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN) ?? DEFAULT_CALLBACK_ORIGIN).replace(/\/+$/, '');
  return `${origin}/connect/${providerId}?state=${encodeURIComponent(state)}`;
}

async function providerAuthorizeUrl(env: Env, provider: OAuthProvider, state: string, codeVerifier: string): Promise<string> {
  const codeChallenge = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))),
  );
  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', requireNonEmpty(env[provider.clientIdEnvKey]));
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl(env, provider.id));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (provider.scopes.length > 0) authorizeUrl.searchParams.set('scope', provider.scopes.join(' '));
  for (const [key, value] of Object.entries(provider.authorizeParams)) authorizeUrl.searchParams.set(key, value);
  return authorizeUrl.toString();
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * GET /connect/:provider?state=...
 *
 * Our own "connect" screen, in the same shape as the Composio hand-off people
 * already see for Gmail: who is asking, what for, what it cannot do, and that
 * the password is typed on the provider's own page. Every value on it comes
 * from our code or the stored flow; the only input is the state, which must
 * name a live, unspent flow for this provider.
 */
export async function handleConnectionInterstitial(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider?.interstitial) return json({ error: 'unknown_provider' }, 404);
  if (!configured(env) || !providerConfigured(env, provider)) return json({ error: 'provider_not_configured' }, 503);
  const state = new URL(request.url).searchParams.get('state') ?? '';
  if (!/^[0-9a-f]{64}$/.test(state)) return returnTo('web', env, provider.id, 'invalid_state');
  const rows = await supabaseRows(env, 'connection_oauth_flows', {
    state: `eq.${state}`, select: 'provider,code_verifier,return_surface,expires_at,consumed_at', limit: '1',
  });
  const row = rows?.[0];
  const expiresAt = Date.parse(recordString(row, 'expires_at') ?? '');
  const codeVerifier = recordString(row, 'code_verifier');
  if (!row || recordString(row, 'consumed_at') || recordString(row, 'provider') !== provider.id || !codeVerifier
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return returnTo('web', env, provider.id, 'invalid_state');
  const surface: ReturnSurface = recordString(row, 'return_surface') === 'app' ? 'app' : 'web';
  const next = await providerAuthorizeUrl(env, provider, state, codeVerifier);
  const cancel = returnUrl(surface, env, provider.id); cancel.searchParams.set('connection_error', 'declined');
  return new Response(interstitialPage(provider, next, cancel.toString()), { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  } });
}

function interstitialPage(provider: OAuthProvider, next: string, cancel: string): string {
  const screen = provider.interstitial!;
  const name = escapeHtml(provider.displayName);
  const initial = escapeHtml(provider.displayName.slice(0, 1));
  const permissions = screen.permissions.map((line) => `<li><span class="tick">&#10003;</span>${escapeHtml(line)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${name} to Delegent AI</title><style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e7e5df;--accent:${screen.accent};--sage:#5f7a61}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#f1f0ec;--muted:#a3a39c;--line:#33332f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px 28px;box-shadow:0 12px 40px rgba(0,0,0,.08)}
.logos{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:22px}
.logo{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:24px}
.us{background:var(--sage)}.them{background:var(--accent)}.dots{color:var(--muted);letter-spacing:4px}
h1{font-size:20px;line-height:1.3;margin:0 0 6px;text-align:center}p.sub{margin:0 0 22px;color:var(--muted);text-align:center;font-size:15px}
.box{border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:14px}.box h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:10px;padding:4px 0}.tick{color:var(--sage);font-weight:700}
.note{font-size:14px;color:var(--muted);margin:0 0 22px}.lock{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--muted);margin-bottom:22px}
a.btn{display:block;text-align:center;text-decoration:none;border-radius:12px;padding:14px;font-weight:600;font-size:16px}
a.go{background:var(--accent);color:#fff}a.stop{color:var(--muted);margin-top:8px}
footer{margin-top:20px;text-align:center;font-size:12px;color:var(--muted)}footer a{color:var(--muted)}
</style></head><body><main class="card">
<div class="logos"><div class="logo us" aria-label="Delegent AI">D</div><span class="dots" aria-hidden="true">&middot;&middot;&middot;</span><div class="logo them" aria-label="${name}">${initial}</div></div>
<h1>Connect ${name} to Delegent AI</h1>
<p class="sub">Your coworker is asking for access to your ${name} account.</p>
<div class="box"><h2>It will be able to</h2><ul>${permissions}</ul></div>
<p class="note">${escapeHtml(screen.cannot)}</p>
<div class="lock"><span aria-hidden="true">&#128274;</span><span>You will sign in on ${name}'s own page. Delegent AI never sees your password, and you can disconnect at any time.</span></div>
<a class="btn go" href="${escapeHtml(next)}" rel="noreferrer">Continue to ${name}</a>
<a class="btn stop" href="${escapeHtml(cancel)}">Cancel</a>
<footer>Delegent AI &middot; <a href="https://delegentai.co.uk/legal/privacy" rel="noreferrer">Privacy policy</a></footer>
</main></body></html>`;
}

/**
 * The agent engine asking for a usable token, over its own signed route
 * (apps/agent/src/connectionToken.ts). Only providers in ENGINE_TOKEN_PROVIDERS.
 */
export async function engineConnectionToken(env: Env, userId: string, providerId: string): Promise<Response> {
  if (!ENGINE_TOKEN_PROVIDERS.has(providerId)) return json({ error: 'unknown_provider' }, 404);
  const provider = PROVIDERS[providerId]!;
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  const token = await freshAccessToken(env, userId, provider);
  if ('error' in token) {
    const status = ['needs_reauth', 'refresh_recovery_required'].includes(token.error) ? 409 : token.error === 'not_connected' ? 404 : 503;
    return json({ error: token.error }, status);
  }
  const rows = await supabaseRows(env, 'user_connections', { user_id: `eq.${userId}`, provider: `eq.${provider.id}`, select: 'account_label', limit: '1' });
  return json({ accessToken: token.accessToken, expiresAt: token.expiresAt, account: recordString(rows?.[0], 'account_label') }, 200);
}

/**
 * GET /oauth/:provider/callback
 *
 * Unauthenticated by necessity: it is the provider bouncing a browser back to
 * us. So it deliberately does NOT link anything. It reads the flow without
 * spending it, and hands the authorization code back to the surface the flow
 * was started from; the account link happens in handleConnectionComplete
 * below, which knows who is asking.
 *
 * Why it used to be wrong to link here. The flow row carries the user id of
 * whoever STARTED the flow, and this endpoint stored the grant under it. So an
 * attacker could start a flow on their own account, send the resulting
 * authorize URL to somebody else, and whatever that person approved at the
 * provider landed in the ATTACKER's account: their real Dropbox, readable by a
 * coworker they have never seen. Nothing in the flow row can tell the two
 * apart, because the only browser this endpoint ever hears from is the one
 * coming back from the provider.
 *
 * The authorization code does travel through the client now, which is what a
 * plain public OAuth client has always done. It is single use, dies in about a
 * minute, and is worthless without the PKCE verifier and the client secret,
 * both of which stay in the Worker.
 *
 * The final redirect target is still resolved from the stored `return_surface`
 * enum, never from a query parameter, so this cannot be turned into an open
 * redirect.
 */
export async function handleConnectionCallback(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: 'unknown_provider' }, 404);
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);

  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const providerError = url.searchParams.get('error');

  if (!state) return returnTo('web', env, provider.id, 'invalid_state');

  // Read, not consume. Spending the flow here would leave nothing for the
  // authenticated half to check the asking account against.
  const flow = await peekFlow(env, state);
  if (!flow || flow.provider !== provider.id) return returnTo('web', env, provider.id, 'invalid_state');

  // The user pressed Cancel on the provider's consent screen, or the provider
  // refused. Not an error we should shout about; bounce back quietly.
  if (providerError) return returnTo(flow.surface, env, provider.id, 'declined');
  if (!code) return returnTo(flow.surface, env, provider.id, 'declined');

  return handBack(flow.surface, env, provider.id, state, code);
}

/**
 * POST /api/connections/oauth/:provider/complete
 *
 * The authenticated half of the callback: the surface that started the flow
 * comes back holding the state and the code, and this is where the grant is
 * finally exchanged and stored.
 *
 * The refusal in the middle is the reason this endpoint exists. A flow belongs
 * to the account that started it, and the account finishing it has just proven
 * who it is with a real bearer token. If those two differ, somebody is being
 * walked through a hand-off they did not begin, so the flow is spent, the code
 * is never exchanged, and the reader is told plainly. It costs a legitimate
 * user nothing: the same account starts and finishes every normal connect.
 */
export async function handleConnectionComplete(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: 'unknown_provider' }, 404);
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  if (!providerConfigured(env, provider)) return json({ error: 'provider_not_configured' }, 503);

  const userId = await authedUserId(request, env);
  if (!userId) return json({ error: 'unauthenticated' }, 401);
  if (!withinConnectionBurstLimit(userId)) return json({ error: 'rate_limited' }, 429);

  const body = await request.json().catch(() => null);
  const state = isRecord(body) ? nonEmptyString(body.state) : null;
  const code = isRecord(body) ? nonEmptyString(body.code) : null;
  if (!state || !code) return json({ error: 'invalid_request' }, 400);

  // Single use, and spent whatever the outcome below: a state that has been
  // shown to the wrong account must not stay usable for a second attempt.
  const flow = await consumeFlow(env, state);
  if (!flow || flow.provider !== provider.id) return json({ error: 'invalid_state' }, 410);

  if (flow.userId !== userId) {
    // Logged because it cannot happen by accident, and no id is printed: the
    // fact that it happened at all is the signal.
    console.warn(`[connections-oauth] provider=${provider.id} refused=account_mismatch`);
    return json({ error: 'wrong_account' }, 403);
  }

  const exchange = await exchangeCode(env, provider, code, flow.codeVerifier);
  if (!exchange) return json({ error: 'exchange_failed' }, 502);

  const label = await provider.accountLabel(exchange.accessToken).catch(() => null);

  const stored = await upsertConnection(env, {
    userId,
    provider: provider.id,
    accountLabel: label,
    scopes: exchange.scopes.length > 0 ? exchange.scopes : [...provider.scopes],
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
  });
  if (!stored) return json({ error: 'store_failed' }, 502);

  // A fast path, not the retention mechanism. This was the ONLY caller, so
  // abandoned handshakes were cleaned up only when somebody else completed one.
  // The cron owns it now; see sweepExpiredConnectionFlows in index.ts.
  void supabaseFetch(supabaseRpcUrl(env, 'purge_expired_connection_flows'), {
    method: 'POST',
    headers: supabaseHeaders(env, true),
    body: '{}',
  });

  return json({ ok: true, provider: provider.id }, 200);
}

/** GET /api/connections/oauth */
export async function handleConnectionList(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  const userId = await authedUserId(request, env);
  if (!userId) return json({ error: 'unauthenticated' }, 401);

  const rows = await supabaseRows(env, 'user_connections', {
    user_id: `eq.${userId}`,
    select: 'provider,status,account_label,connected_at',
  });
  // A read we could not do is not an account with nothing connected. Answering
  // 200 with an empty list makes those two indistinguishable, and both clients
  // then use this reply to decide whether a hand-off that just came back
  // actually stored a grant. On a blip that turns a real connection into "No
  // problem, nothing was connected." Distinct from the 503 that means the
  // broker is switched off, which is a state rather than a failure.
  if (!rows || !rows.every(validConnectionStatusRow)) return json({ error: 'connections_unreadable' }, 502);

  // Deliberately a projection, not the row: the token columns must never be
  // reachable from a client-facing response, even by accident.
  const connections = rows
    .filter((row) => recordString(row, 'status') !== 'revoked')
    .map((row) => ({
      provider: recordString(row, 'provider') ?? '',
      status: recordString(row, 'status') === 'needs_reauth' ? 'needs_reauth' : 'connected',
      accountLabel: recordString(row, 'account_label'),
      connectedAt: recordString(row, 'connected_at'),
    }))
    // A row for a provider we no longer broker is a leftover, not a connection.
    // Six providers moved to Composio on 2026-09-03 and their rows stayed in
    // the table; reporting them here told the Connections screen that Dropbox,
    // Google Drive, Outlook and Slack were still connected natively when the
    // only working route for them is now the brokered one. listBrokeredConnections
    // already drops them (it needs a displayName from PROVIDERS); this is the
    // same rule, stated once for the client-facing list.
    .filter((row) => row.provider.length > 0 && Boolean(PROVIDERS[row.provider]));

  // Which providers we actually hold credentials for. Without this the client
  // has no way to tell a provider that is ready from one whose console
  // registration has not happened yet, and would offer both, so half the list
  // would fail the instant it was tapped.
  const available = Object.values(PROVIDERS)
    .filter((provider) => providerConfigured(env, provider))
    .map((provider) => provider.id);

  return json({ connections, available }, 200);
}

/**
 * The same projection as the client list, for server-side callers that already
 * know the user id: the run-instruction builder telling the agent what it is
 * holding, and the runner asking the same question from the box.
 */
export async function listBrokeredConnections(env: Env, userId: string): Promise<BrokeredConnection[] | null> {
  if (!configured(env)) return [];
  const rows = await supabaseRows(env, 'user_connections', {
    user_id: `eq.${userId}`,
    select: 'provider,status,account_label',
  });
  // Null is an unreadable inventory, distinct from an authoritative empty list.
  if (!rows || !rows.every(validConnectionStatusRow)) return null;
  return rows
    .filter((row) => recordString(row, 'status') !== 'revoked')
    .map((row) => ({
      provider: recordString(row, 'provider') ?? '',
      displayName: PROVIDERS[recordString(row, 'provider') ?? '']?.displayName ?? '',
      status: recordString(row, 'status') === 'needs_reauth' ? ('needs_reauth' as const) : ('connected' as const),
      accountLabel: recordString(row, 'account_label'),
    }))
    .filter((row) => row.provider.length > 0 && row.displayName.length > 0);
}

export type BrokeredConnection = {
  readonly provider: string;
  readonly displayName: string;
  readonly status: 'connected' | 'needs_reauth';
  readonly accountLabel: string | null;
};

function validConnectionStatusRow(row: Record<string, unknown>): boolean {
  return Boolean(recordString(row, 'provider'))
    && ['connected', 'needs_reauth', 'revoked'].includes(recordString(row, 'status') ?? '');
}

/** A connection brokered somewhere other than our own OAuth broker. */
export interface RunnerExtraConnection {
  readonly provider: string;
  readonly displayName: string;
  readonly status: 'connected' | 'needs_reauth';
  readonly accountLabel: string | null;
  readonly backend: 'composio';
  /**
   * Composio's toolkit slug, upper-cased it is the prefix of every action the
   * agent can run (GOOGLECALENDAR_*). Not always the card id, which is why the
   * CLI must not derive it.
   */
  readonly toolkit: string;
}

/**
 * GET /api/runner/connections
 *
 * Every connection this workspace can use, whoever brokers it. `backend` is on
 * every entry because the agent has to call them differently: ours hand out a
 * short-lived token to use directly, Composio's are executed for us. Without
 * that distinction the agent reaches for a token that does not exist.
 */
export async function handleRunnerConnectionList(
  env: Env,
  userId: string,
  extra: { connections: readonly RunnerExtraConnection[]; unavailable: boolean }
    = { connections: [], unavailable: false },
): Promise<Response> {
  // Composio can be configured when our own broker is not. A flat 503 here
  // would hide a connection the customer genuinely holds.
  if (!configured(env) && extra.connections.length === 0 && !extra.unavailable) {
    return json({ error: 'connections_unavailable' }, 503);
  }
  const own = configured(env) ? await listBrokeredConnections(env, userId) : [];
  return json({
    connections: [
      ...(own ?? []).map((connection) => ({ ...connection, backend: 'native' as const })),
      ...extra.connections,
    ],
    // Only present when true, so the common reply is unchanged.
    ...(extra.unavailable ? { composioUnavailable: true } : {}),
    ...(own === null ? { nativeUnavailable: true } : {}),
  }, 200);
}

/** DELETE /api/connections/oauth/:provider */
export async function handleConnectionDisconnect(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = PROVIDERS[providerId];
  if (!provider) return json({ error: 'unknown_provider' }, 404);
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  const userId = await authedUserId(request, env);
  if (!userId) return json({ error: 'unauthenticated' }, 401);

  const row = await connectionRow(env, userId, provider.id);

  if (row === undefined) return json({ error: 'connections_unreadable' }, 502);

  // Best effort: tell the provider first so the grant dies at source even if
  // our own delete then fails. A failure here must not block the disconnect,
  // or a user could be stuck unable to remove a connection.
  if (row && provider.revoke) {
    const accessToken = await decrypt(env, recordString(row, 'access_token_enc'));
    if (accessToken) {
      await provider.revoke(accessToken, env).catch(() => null);
    }
  }

  const deleted = await supabaseFetch(supabaseRestUrl(env, 'user_connections', {
    user_id: `eq.${userId}`,
    provider: `eq.${provider.id}`,
  }), { method: 'DELETE', headers: supabaseHeaders(env) });
  if (!deleted || !deleted.ok) return json({ error: 'disconnect_failed' }, 502);

  return json({ ok: true, provider: provider.id }, 200);
}

export type ConnectionRevokeSweep = {
  /** Providers we asked to drop the grant and that accepted. */
  readonly revoked: readonly string[];
  /** Providers we asked and that refused, or whose token we could not read. */
  readonly failed: readonly string[];
  /** Providers that hold no revoke endpoint, so only our own row could go. */
  readonly unsupported: readonly string[];
  /** Whether our own rows are gone. False means they were left behind. */
  readonly rowsDeleted: boolean;
};

/**
 * Drop every grant this account holds, at the provider as well as here.
 *
 * Deleting the account used to delete the Supabase user and tear down the
 * workspace while leaving live OAuth grants sitting in Dropbox, GitHub and
 * Google. The user saw Delegent gone and reasonably assumed its access had gone
 * with it, when in fact the only way to withdraw it was to find our entry in
 * each provider's own app settings.
 *
 * Every step is best effort by design: a provider that is down must not be able
 * to block someone from deleting their account. What the caller gets back is a
 * record of what actually happened, so a grant we failed to withdraw is written
 * down rather than assumed gone.
 */
export async function revokeAllConnectionsForUser(env: Env, userId: string): Promise<ConnectionRevokeSweep> {
  const revoked: string[] = [];
  const failed: string[] = [];
  const unsupported: string[] = [];

  if (!configured(env)) return { revoked, failed, unsupported, rowsDeleted: false };

  const rows = await supabaseRows(env, 'user_connections', {
    user_id: `eq.${userId}`,
    select: 'provider,access_token_enc',
  });
  // A read we could not do is not an account with nothing connected, and
  // deleting rows we never saw would hide that. Report nothing done instead.
  if (!rows) return { revoked, failed, unsupported, rowsDeleted: false };

  for (const row of rows) {
    const providerId = recordString(row, 'provider') ?? '';
    const provider = PROVIDERS[providerId];
    if (!provider) continue;
    if (!provider.revoke) {
      unsupported.push(providerId);
      continue;
    }
    const accessToken = await decrypt(env, recordString(row, 'access_token_enc'));
    if (!accessToken) {
      failed.push(providerId);
      continue;
    }
    try {
      if (await provider.revoke(accessToken, env)) revoked.push(providerId);
      else failed.push(providerId);
    } catch {
      failed.push(providerId);
    }
  }

  const deleted = await supabaseFetch(
    supabaseRestUrl(env, 'user_connections', { user_id: `eq.${userId}` }),
    { method: 'DELETE', headers: supabaseHeaders(env) },
  );

  return { revoked, failed, unsupported, rowsDeleted: Boolean(deleted?.ok) };
}

/**
 * POST /api/runner/connections/token
 *
 * The runner asking for a usable access token. `userId` has already been
 * proven by the caller's HMAC v1 check in index.ts, which is why this takes it
 * as an argument rather than re-deriving it: one implementation of runner auth,
 * not two.
 */
export async function handleRunnerConnectionToken(request: Request, env: Env, userId: string): Promise<Response> {
  if (!configured(env)) return json({ error: 'connections_unavailable' }, 503);
  const body = await request.json().catch(() => null);
  const providerId = isRecord(body) ? nonEmptyString(body.provider) : null;
  const provider = providerId ? PROVIDERS[providerId] : undefined;
  if (!provider) return json({ error: 'unknown_provider' }, 404);

  const token = await freshAccessToken(env, userId, provider);
  if ('error' in token) {
    const status = ['needs_reauth', 'refresh_recovery_required'].includes(token.error) ? 409 : token.error === 'not_connected' ? 404 : 503;
    return json({ error: token.error }, status);
  }
  return json({ accessToken: token.accessToken, expiresAt: token.expiresAt, scopes: token.scopes }, 200);
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

type FreshToken = { accessToken: string; expiresAt: string | null; scopes: string[] };

async function freshAccessToken(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<FreshToken | { error: string }> {
  const deadline = Date.now() + TOKEN_REQUEST_BUDGET_MS;
  const row = await connectionRow(env, userId, provider.id, refreshBudget(deadline));
  const failure = connectionTokenFailure(row);
  if (failure || !row) return { error: failure ?? 'connections_unreadable' };
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [];
  const usable = await usableToken(env, row, scopes);
  if (usable) return usable;
  if (!recordString(row, 'refresh_token_enc')) return { error: 'needs_reauth' };
  const refreshToken = await decrypt(env, recordString(row, 'refresh_token_enc'));
  if (!refreshToken) return { error: 'credentials_unreadable' };
  const version = recordString(row, 'credential_version');
  if (!version) return { error: 'connections_unreadable' };
  if (!providerConfigured(env, provider)) return { error: 'provider_not_configured' };
  const claim = { p_user_id: userId, p_provider: provider.id, p_version: version, p_attempt_id: crypto.randomUUID() };
  const claimed = await refreshRpc(env, 'claim_native_connection_refresh', claim, deadline, 2);
  if (claimed === 'busy' || claimed === 'changed') {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(500);
      const retryRow = await connectionRow(env, userId, provider.id, refreshBudget(deadline));
      const retryFailure = connectionTokenFailure(retryRow);
      if (retryFailure || !retryRow) return { error: retryFailure ?? 'connections_unreadable' };
      const retryScopes = Array.isArray(retryRow.scopes) ? retryRow.scopes.filter((s): s is string => typeof s === 'string') : [];
      const retry = await usableToken(env, retryRow, retryScopes);
      if (retry) return retry;
    }
    return { error: claimed === 'busy' ? 'refresh_busy' : 'connection_changed' };
  }
  if (claimed !== 'claimed') {
    return { error: ['not_connected', 'needs_reauth', 'refresh_recovery_required'].includes(claimed ?? '')
      ? claimed! : 'refresh_store_unavailable' };
  }
  // One provider request per attempt. A lost provider response may have rotated
  // the grant; neither lease expiry nor a new caller may replay that token.
  const refreshed = await refreshAccessToken(env, provider, refreshToken, refreshBudget(deadline, 10_000));
  const outcome = refreshed === 'terminal' ? 'terminal' : refreshed ? 'succeeded' : 'uncertain';
  const completion: Record<string, unknown> = { ...claim, p_outcome: outcome };
  if (refreshed && refreshed !== 'terminal') {
    // Encrypt once, then retry this SAME returned pair after an ambiguous write.
    completion.p_access_token_enc = await encrypt(env, refreshed.accessToken);
    completion.p_refresh_token_enc = refreshed.refreshToken ? await encrypt(env, refreshed.refreshToken) : null;
    completion.p_expires_at = refreshed.expiresAt;
    if (!completion.p_access_token_enc || !completion.p_refresh_token_enc) return { error: 'refresh_persistence_failed' };
  }
  let stored = await refreshRpc(env, 'finish_native_connection_refresh', completion, deadline, 3);
  if (stored !== 'stored' && stored !== 'changed') {
    const observed = await connectionRow(env, userId, provider.id, refreshBudget(deadline));
    if (refreshCompletionStored(observed, completion)) stored = 'stored';
    else if (observed === null || (observed && observed.credential_version !== version)) stored = 'changed';
  }
  if (stored !== 'stored') return { error: stored === 'changed' ? 'connection_changed' : 'refresh_persistence_failed' };
  if (!refreshed) return { error: 'refresh_recovery_required' };
  if (refreshed === 'terminal') return { error: 'needs_reauth' };
  return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt, scopes };
}

function connectionTokenFailure(row: Record<string, unknown> | null | undefined): string | null {
  if (row === undefined) return 'connections_unreadable';
  if (!row || recordString(row, 'status') === 'revoked') return 'not_connected';
  if (recordString(row, 'refresh_attempt_state') === 'uncertain') return 'refresh_recovery_required';
  if (recordString(row, 'status') !== 'connected') return 'needs_reauth';
  return null;
}

function refreshBudget(deadline: number, maximum = 3_000): number {
  return Math.max(0, Math.min(maximum, deadline - Date.now()));
}

function refreshCompletionStored(row: Record<string, unknown> | null | undefined, expected: Record<string, unknown>): boolean {
  if (!row || row.refresh_attempt_id !== expected.p_attempt_id || row.refresh_attempt_state !== expected.p_outcome) return false;
  if (expected.p_outcome === 'uncertain') {
    return row.credential_version === expected.p_version && row.status === 'needs_reauth';
  }
  if (row.credential_version !== expected.p_attempt_id) return false;
  if (expected.p_outcome === 'terminal') {
    return row.status === 'needs_reauth' && row.access_token_enc === null && row.refresh_token_enc === null;
  }
  return row.status === 'connected' && row.access_token_enc === expected.p_access_token_enc
    && row.refresh_token_enc === expected.p_refresh_token_enc
    && Date.parse(String(row.access_expires_at)) === Date.parse(String(expected.p_expires_at));
}

async function refreshRpc(env: Env, name: string, body: Record<string, unknown>, deadline: number, attempts: number): Promise<string | null> {
  const serialized = JSON.stringify(body);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = refreshBudget(deadline);
    if (timeout <= 0) return null;
    const value = await withTimeout((async () => {
      const response = await fetch(supabaseRpcUrl(env, name), {
        method: 'POST', headers: supabaseHeaders(env, true), body: serialized,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) return null;
      return await response.json() as unknown;
    })(), timeout).catch(() => null);
    if (typeof value === 'string' && ['claimed', 'busy', 'changed', 'stored', 'not_connected', 'needs_reauth', 'refresh_recovery_required'].includes(value)) return value;
    if (attempt + 1 < attempts && refreshBudget(deadline) > 200) await sleep(100);
  }
  return null;
}

async function usableToken(
  env: Env,
  row: Record<string, unknown>,
  scopes: string[],
): Promise<FreshToken | null> {
  const expiresAt = recordString(row, 'access_expires_at');
  if (!expiresAt) return null;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return null;
  if (expiresMs - Date.now() <= ACCESS_TOKEN_SKEW_SECONDS * 1000) return null;
  const accessToken = await decrypt(env, recordString(row, 'access_token_enc'));
  if (!accessToken) return null;
  return { accessToken, expiresAt, scopes };
}

type TokenResponse = { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] };

async function exchangeCode(
  env: Env,
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse | null> {
  const form = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: callbackUrl(env, provider.id),
    // Dropbox's own OAuth guide says to send code_verifier INSTEAD of
    // client_id. That is wrong (their SDK and engineering blog both send
    // both), and omitting client_id fails the exchange. Send both.
    client_id: requireNonEmpty(env[provider.clientIdEnvKey]),
    code_verifier: codeVerifier,
  });
  applyClientSecret(form, env, provider);
  const response = await withTimeout(fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  })).catch(() => null);
  if (!response || !response.ok) return null;
  return provider.parseToken(await response.json().catch(() => null));
}

/**
 * A confidential client sends its secret in the form body. Dropbox declares no
 * secret and must keep sending none: adding an empty `client_secret` to a PKCE
 * exchange is rejected by some providers outright.
 */
function applyClientSecret(form: URLSearchParams, env: Env, provider: OAuthProvider): void {
  if (!provider.clientSecretEnvKey) return;
  form.set('client_secret', requireNonEmpty(env[provider.clientSecretEnvKey]));
}

/** Returns the new token, `null` for a retryable failure, or the literal
 *  `'terminal'` when the grant itself is dead (revoked at the provider, the
 *  user changed their password, the scope was withdrawn). Only 'terminal'
 *  flips the connection to needs_reauth; a transient outage must never do
 *  that, or a blip logs every user out of their Dropbox. */
async function refreshAccessToken(
  env: Env,
  provider: OAuthProvider,
  refreshToken: string,
  timeoutMs: number,
): Promise<TokenResponse | null | 'terminal'> {
  if (timeoutMs <= 0) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: requireNonEmpty(env[provider.clientIdEnvKey]),
  });
  applyClientSecret(form, env, provider);
  return withTimeout((async (): Promise<TokenResponse | null | 'terminal'> => {
    const response = await fetch(provider.tokenUrl, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 400 || response.status === 401) {
      return isRecord(payload) && payload.error === 'invalid_grant' ? 'terminal' : null;
    }
    if (!response.ok) return null;
    const parsed = provider.parseToken(payload);
    // FreeAgent is the only native provider and returns both replacement tokens.
    if (parsed?.refreshToken && parsed.expiresAt && Date.parse(parsed.expiresAt) > Date.now() + ACCESS_TOKEN_SKEW_SECONDS * 1000) return parsed;
    return provider.isTerminalFailure(payload) ? 'terminal' : null;
  })(), timeoutMs).catch(() => null);
}

function parseTokenResponse(payload: unknown): TokenResponse | null {
  if (!isRecord(payload)) return null;
  const accessToken = nonEmptyString(payload.access_token);
  if (!accessToken) return null;
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : null;
  const scopeRaw = nonEmptyString(payload.scope);
  return {
    accessToken,
    refreshToken: nonEmptyString(payload.refresh_token),
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: scopeRaw ? scopeRaw.split(/\s+/).filter((s) => s.length > 0) : [],
  };
}

/**
 * Slack answers 200 for everything and puts the USER token one level down,
 * under `authed_user`. The top-level `access_token` on the same response is the
 * bot token, which is a different grant with different permissions, so reading
 * the top level would store the wrong token and every later call would fail
 * with a permissions error that looks nothing like the real cause.
 */
function parseSlackTokenResponse(payload: unknown): TokenResponse | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  const user = isRecord(payload.authed_user) ? payload.authed_user : null;
  if (!user) return null;
  const accessToken = nonEmptyString(user.access_token);
  if (!accessToken) return null;
  const expiresIn = typeof user.expires_in === 'number' && Number.isFinite(user.expires_in)
    ? user.expires_in
    : null;
  const scopeRaw = nonEmptyString(user.scope);
  return {
    accessToken,
    refreshToken: nonEmptyString(user.refresh_token),
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    // Slack separates user scopes with commas where OAuth 2.0 uses spaces.
    scopes: scopeRaw ? scopeRaw.split(/[,\s]+/).filter((s) => s.length > 0) : [],
  };
}

/**
 * Slack error codes that mean the grant will never work again, so the user has
 * to reconnect. Everything else, rate limits and Slack outages included, is
 * treated as retryable: wrongly declaring a live connection dead signs someone
 * out of a working Slack, while a needless retry costs one request.
 */
const SLACK_DEAD_GRANT = new Set([
  'token_revoked',
  'token_expired',
  'invalid_refresh_token',
  'account_inactive',
  'access_denied',
  'team_access_not_granted',
  'invalid_auth',
]);

function isSlackTerminalFailure(payload: unknown): boolean {
  if (!isRecord(payload) || payload.ok !== false) return false;
  const error = nonEmptyString(payload.error);
  return error !== null && SLACK_DEAD_GRANT.has(error);
}

/** Works with any Slack token and needs no scope of its own. */
async function slackAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!isRecord(body) || body.ok !== true) return null;
  const user = nonEmptyString(body.user);
  const team = nonEmptyString(body.team);
  if (user && team) return `${user} at ${team}`;
  return user ?? team;
}

/** GitHub rejects any request without a User-Agent, including this one. */
async function githubAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': GITHUB_USER_AGENT,
    },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  return isRecord(body) ? nonEmptyString(body.login) : null;
}

const GITHUB_USER_AGENT = 'delegent-ai-connections';

/**
 * Drop the whole authorization, not just the current token. Revoking only the
 * token would leave the app still authorized on the user's GitHub account,
 * which contradicts what the Connections screen tells them disconnecting does.
 */
async function revokeGithubGrant(accessToken: string, env: Env): Promise<boolean> {
  const clientId = nonEmptyString(env.SIDEKICK_GITHUB_CLIENT_ID);
  const clientSecret = nonEmptyString(env.SIDEKICK_GITHUB_CLIENT_SECRET);
  // No credentials means we cannot ask, which is a grant left standing rather
  // than a grant withdrawn, so it must not report success.
  if (!clientId || !clientSecret) return false;
  const response = await withTimeout(fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`, {
    method: 'DELETE',
    headers: {
      authorization: `Basic ${base64Encode(new TextEncoder().encode(`${clientId}:${clientSecret}`))}`,
      accept: 'application/vnd.github+json',
      'user-agent': GITHUB_USER_AGENT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  })).catch(() => null);
  return Boolean(response?.ok);
}

/** Google wants the token in the form body; a bearer header is ignored. */
async function revokeGoogleToken(accessToken: string): Promise<boolean> {
  const response = await withTimeout(fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }).toString(),
  })).catch(() => null);
  return Boolean(response?.ok);
}

async function googleAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  return isRecord(body) ? nonEmptyString(body.email) : null;
}

/**
 * `mail` first, then `userPrincipalName`. They are usually the same string, but
 * on plenty of work tenants the principal name is an internal login that means
 * nothing to the person reading the card, and on others `mail` is simply absent.
 * Taking whichever exists is what keeps the card able to name the account.
 */
async function microsoftAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!isRecord(body)) return null;
  return nonEmptyString(body.mail) ?? nonEmptyString(body.userPrincipalName);
}

async function dropboxAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!isRecord(body)) return null;
  const email = nonEmptyString(body.email);
  if (email) return email;
  return isRecord(body.name) ? nonEmptyString(body.name.display_name) : null;
}

/**
 * The company name, so the card reads "Delegent AI" rather than a bare
 * "connected". FreeAgent returns it under a `company` envelope; the shape was
 * checked against the live API rather than taken from the docs.
 */
async function yahooAccountLabel(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.login.yahoo.com/openid/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), redirect: 'manual',
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const email = isRecord(body) && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    return /^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email) ? email : null;
  } catch { return null; }
}

async function freeagentAccountLabel(accessToken: string): Promise<string | null> {
  const response = await withTimeout(fetch('https://api.freeagent.com/v2/company', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!isRecord(body) || !isRecord(body.company)) return null;
  return nonEmptyString(body.company.name);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type Flow = { userId: string; provider: string; codeVerifier: string; surface: ReturnSurface };

/**
 * Where to send the browser back to, without spending the flow.
 *
 * Deliberately returns no user id and no verifier: the callback has proven
 * nothing about who is holding the browser, so the only thing it is trusted to
 * decide is which of our two surfaces to bounce to. Expiry and single-use are
 * checked here as well as in the RPC, so a stale link is answered with "that
 * link had expired" on the right surface rather than being handed back and
 * failing a step later.
 */
async function peekFlow(env: Env, state: string): Promise<{ provider: string; surface: ReturnSurface } | null> {
  const rows = await supabaseRows(env, 'connection_oauth_flows', {
    state: `eq.${state}`,
    select: 'provider,return_surface,expires_at,consumed_at',
    limit: '1',
  });
  const row = rows?.[0];
  if (!row) return null;
  if (recordString(row, 'consumed_at')) return null;
  const expiresAt = Date.parse(recordString(row, 'expires_at') ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const provider = recordString(row, 'provider');
  if (!provider) return null;
  return { provider, surface: recordString(row, 'return_surface') === 'app' ? 'app' : 'web' };
}

async function consumeFlow(env: Env, state: string): Promise<Flow | null> {
  const response = await supabaseFetch(supabaseRpcUrl(env, 'consume_connection_oauth_flow'), {
    method: 'POST',
    headers: supabaseHeaders(env, true),
    body: JSON.stringify({ p_state: state }),
  });
  if (!response || !response.ok) return null;
  const rows = await response.json().catch(() => null);
  const row = Array.isArray(rows) ? rows.find(isRecord) : null;
  const userId = recordString(row, 'user_id');
  const provider = recordString(row, 'provider');
  const codeVerifier = recordString(row, 'code_verifier');
  if (!userId || !provider || !codeVerifier) return null;
  return {
    userId,
    provider,
    codeVerifier,
    surface: recordString(row, 'return_surface') === 'app' ? 'app' : 'web',
  };
}

// undefined means unreadable; null means the authoritative query found no row.
async function connectionRow(env: Env, userId: string, provider: string, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<Record<string, unknown> | null | undefined> {
  const rows = await supabaseRows(env, 'user_connections', {
    user_id: `eq.${userId}`,
    provider: `eq.${provider}`,
    select: 'status,account_label,scopes,access_token_enc,refresh_token_enc,access_expires_at,credential_version,refresh_attempt_id,refresh_attempt_state',
    limit: '1',
  }, timeoutMs);
  if (!rows) return undefined;
  const row = rows[0];
  if (row && !['connected', 'needs_reauth', 'revoked'].includes(recordString(row, 'status') ?? '')) return undefined;
  return row ?? null;
}

async function upsertConnection(env: Env, input: {
  userId: string;
  provider: string;
  accountLabel: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}): Promise<boolean> {
  // A newly authorised provider account must not inherit an older account's
  // refresh token when the exchange response is incomplete.
  if (!input.refreshToken || !input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) return false;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    provider: input.provider,
    status: 'connected',
    account_label: input.accountLabel,
    scopes: input.scopes,
    access_token_enc: await encrypt(env, input.accessToken),
    refresh_token_enc: await encrypt(env, input.refreshToken),
    credential_version: crypto.randomUUID(),
    refresh_attempt_id: null,
    refresh_attempt_state: null,
    access_expires_at: input.expiresAt,
    refresh_lease_until: null,
    last_error: null,
    connected_at: now,
    updated_at: now,
  };
  if (!payload.access_token_enc || !payload.refresh_token_enc) return false;

  // on_conflict must name the constraint we actually collide on. Without it
  // PostgREST targets the primary key, which is a defaulted uuid, so no insert
  // ever conflicts and `unique (user_id, provider)` rejects it instead: the
  // first connect worked and every reconnect after it returned store_failed,
  // leaving a needs_reauth connection with no way back except Disconnect first.
  const response = await supabaseFetch(supabaseRestUrl(env, 'user_connections', { on_conflict: 'user_id,provider' }), {
    method: 'POST',
    headers: {
      ...supabaseHeaders(env, true),
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  return Boolean(response && response.ok);
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM, key held only by the Worker)
// ---------------------------------------------------------------------------

async function encryptionKey(env: Env): Promise<CryptoKey | null> {
  const raw = nonEmptyString(env.SIDEKICK_CONNECTIONS_ENC_KEY);
  if (!raw) return null;
  const bytes = base64Decode(raw);
  if (!bytes || bytes.length !== 32) return null;
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encrypt(env: Env, plaintext: string): Promise<string | null> {
  const key = await encryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

async function decrypt(env: Env, value: string | null): Promise<string | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const key = await encryptionKey(env);
  if (!key) return null;
  const iv = base64Decode(parts[1]);
  const ciphertext = base64Decode(parts[2]);
  if (!iv || !ciphertext) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function configured(env: Env): boolean {
  return Boolean(
    nonEmptyString(env.SUPABASE_URL)
    && nonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY)
    && nonEmptyString(env.SIDEKICK_CONNECTIONS_ENC_KEY),
  );
}

/**
 * Whether this specific provider can be offered. Separate from `configured`,
 * which is about the feature as a whole: one provider missing its credentials
 * must not take the other connections down with it.
 */
function providerConfigured(env: Env, provider: OAuthProvider): boolean {
  if (!nonEmptyString(env[provider.clientIdEnvKey])) return false;
  if (provider.clientSecretEnvKey && !nonEmptyString(env[provider.clientSecretEnvKey])) return false;
  return true;
}

function callbackUrl(env: Env, providerId: string): string {
  const origin = (nonEmptyString(env.SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN) ?? DEFAULT_CALLBACK_ORIGIN).replace(/\/+$/, '');
  return `${origin}/oauth/${providerId}/callback`;
}

function returnUrl(surface: ReturnSurface, env: Env, providerId: string): URL {
  const base = surface === 'app'
    ? APP_RETURN_URL
    : (nonEmptyString(env.SIDEKICK_CONNECTIONS_RETURN_WEB_URL) ?? DEFAULT_WEB_RETURN_URL);
  const target = new URL(base);
  target.searchParams.set('provider', providerId);
  return target;
}

function redirect(target: URL): Response {
  return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
}

function returnTo(surface: ReturnSurface, env: Env, providerId: string, error: string | null): Response {
  const target = returnUrl(surface, env, providerId);
  if (error) target.searchParams.set('connection_error', error);
  else target.searchParams.set('connected', '1');
  return redirect(target);
}

/**
 * Hand the authorization code back to the surface that started the flow, so the
 * account link can happen behind a bearer token. There is no `connected=1`
 * here: nothing is connected yet, and saying so before the exchange has
 * happened is how the old flow ended up announcing links it had not made.
 */
function handBack(surface: ReturnSurface, env: Env, providerId: string, state: string, code: string): Response {
  const target = returnUrl(surface, env, providerId);
  target.searchParams.set('connection_state', state);
  target.searchParams.set('connection_code', code);
  return redirect(target);
}

async function authedUserId(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = /^bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!token) return null;
  const baseUrl = nonEmptyString(env.SUPABASE_URL)?.replace(/\/+$/, '');
  if (!baseUrl) return null;
  const response = await withTimeout(fetch(`${baseUrl}/auth/v1/user`, {
    headers: {
      accept: 'application/json',
      apikey: requireNonEmpty(env.SUPABASE_SERVICE_ROLE_KEY),
      authorization: `Bearer ${token}`,
    },
  })).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null);
  const userId = isRecord(body) ? nonEmptyString(body.id) : null;
  return userId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ? userId : null;
}

function supabaseHeaders(env: Env, contentType = false): Record<string, string> {
  const serviceRoleKey = requireNonEmpty(env.SUPABASE_SERVICE_ROLE_KEY);
  const headers: Record<string, string> = {
    accept: 'application/json',
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };
  if (contentType) headers['content-type'] = 'application/json';
  return headers;
}

function supabaseRestUrl(env: Env, table: string, params: Record<string, string> = {}): string {
  const url = new URL(`${requireNonEmpty(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function supabaseRpcUrl(env: Env, fn: string): string {
  return `${requireNonEmpty(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
}

async function supabaseFetch(url: string, init: RequestInit): Promise<Response | null> {
  return withTimeout(fetch(url, init)).catch(() => null);
}

/**
 * Null when the read did not happen, an array when it did. The difference is the
 * whole point: a timeout and an account with nothing connected are the same
 * empty list, and callers that cannot tell them apart go on to report one as the
 * other.
 */
async function supabaseRows(env: Env, table: string, params: Record<string, string>, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<Record<string, unknown>[] | null> {
  if (timeoutMs <= 0) return null;
  return withTimeout((async () => {
    const response = await fetch(supabaseRestUrl(env, table, params), {
      method: 'GET', headers: supabaseHeaders(env), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const rows = await response.json() as unknown;
    return Array.isArray(rows) && rows.every(isRecord) ? rows : null;
  })(), timeoutMs).catch(() => null);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function requireNonEmpty(value: unknown): string {
  const parsed = nonEmptyString(value);
  if (!parsed) throw new Error('missing required configuration');
  return parsed;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function recordString(row: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!row) return null;
  return nonEmptyString(row[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const __testing = {
  PROVIDERS,
  parseTokenResponse,
  callbackUrl,
  returnTo,
  handBack,
  CONNECTION_ATTEMPTS_PER_MINUTE,
  withinConnectionBurstLimit,
  resetConnectionBurstLimits: () => CONNECTION_BURST_BUCKETS.clear(),
};
