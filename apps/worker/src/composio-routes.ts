// HTTP surface for the Composio broker.
//
// ⚠️ ROUTE ORDER MATTERS. index.ts matches `/api/connections/` with a prefix
// test that would swallow every path here, which is the same trap
// `/api/connections/oauth` already carries a comment about. These routes MUST
// be matched BEFORE that branch or they silently become vault credential calls.
// There is a test for the ordering, because a comment did not stop it the first
// time.
//
// The callback is deliberately UNAUTHENTICATED. It is a browser redirect
// arriving from Composio after the customer granted access at the provider, so
// it carries no session. It therefore treats its query string as untrusted and
// does nothing with it except decide which message to show; the authoritative
// connection state is read back from Composio afterwards, by the authenticated
// list endpoint.
import {
  COMPOSIO_TOOLKITS,
  disconnect,
  disconnectComposioService,
  executeTool,
  initiateConnection,
  listConnections,
  type ComposioEnv,
  type ComposioDeps,
  type ExecuteDeps,
  type ComposioResult,
} from './composio.js';

/** Where a phone is sent back to once the grant is stored. */
const COMPOSIO_APP_RETURN_URL = 'sidekick://connections/return';

export interface ComposioRouteEnv extends ComposioEnv {
  /** Where to send the browser after the grant. */
  SIDEKICK_CONNECTIONS_RETURN_WEB_URL?: string;
}

export interface AuthedUser {
  readonly id: string;
}

export interface ComposioRouteDeps extends ComposioDeps {
  /** Resolve the caller, or null when unauthenticated. */
  authedUser: (request: Request) => Promise<AuthedUser | null>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function brokerError(result: Extract<ComposioResult<unknown>, { ok: false }>, status: number): Response {
  // The runner forwards JSON but does not forward provider headers.
  return json({ error: result.error, ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }, status);
}

/** Does this path belong to the Composio broker? */
export function isComposioPath(pathname: string): boolean {
  return pathname === '/api/connections/composio'
    || pathname.startsWith('/api/connections/composio/');
}

export async function handleComposio(
  request: Request,
  env: ComposioRouteEnv,
  url: URL,
  deps: ComposioRouteDeps,
): Promise<Response> {
  const path = url.pathname;

  // ---- callback: unauthenticated, browser-facing ---------------------------
  if (path === '/api/connections/composio/callback' || path === '/api/connections/composio/callback/app') {
    const status = url.searchParams.get('status');
    const ok = status === 'success';
    // Which surface to return to is read off OUR OWN path, never off the query
    // string. Composio redirects a browser here and we control nothing else
    // about that request. A phone that started the flow has to land back in the
    // app: sending it to the web app is how someone ends up staring at a
    // browser wondering whether what they just did actually worked.
    //
    // The app return carries no state or code because there is nothing left to
    // exchange. Composio already stored the grant, and bringing the app to the
    // foreground is enough, since the screen re-reads the broker on resume.
    const back = path.endsWith('/callback/app')
      ? `${COMPOSIO_APP_RETURN_URL}?provider=composio`
      : env.SIDEKICK_CONNECTIONS_RETURN_WEB_URL?.replace(/\/+$/, '');
    // Never echo Composio's parameters onward. They arrive from a redirect we
    // do not control, and the app re-reads the truth from the list endpoint.
    const target = back ? `${back}${back.includes('?') ? '&' : '?'}connected=${ok ? 'ok' : 'failed'}` : null;
    if (target) return Response.redirect(target, 302);
    return new Response(
      ok
        ? 'Connected. You can close this window and return to Delegent AI.'
        : 'That did not complete. Nothing was connected. You can close this window and try again.',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // ---- everything else needs a session ------------------------------------
  const user = await deps.authedUser(request);
  if (!user) return json({ error: 'unauthenticated' }, 401);

  if (path === '/api/connections/composio' && request.method === 'GET') {
    const res = await listConnections(env, user.id, deps);
    if (!res.ok) {
      // not_configured is not an error the customer caused. Report an empty
      // list with a flag rather than a failure, so the page still renders.
      if (res.error === 'not_configured') return json({ available: false, offered: [], connections: [] });
      return brokerError(res, res.error === 'rate_limited' ? 429 : 502);
    }
    return json({
      available: true,
      // Which services to OFFER, as distinct from which are already connected.
      // Without this the screen could only learn a Composio service exists by
      // seeing a live connection to it, so the card appeared only once it was
      // connected, and there was no way to connect it in the first place.
      offered: COMPOSIO_TOOLKITS.map((t) => t.connectionId),
      connections: res.value.filter((c) => c.active).map((c) => ({
        id: c.connectionId,
        toolkit: c.toolkitSlug,
        connectedAccountId: c.connectedAccountId,
      })),
    });
  }

  if (path === '/api/connections/composio/initiate' && request.method === 'POST') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text() || '{}');
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const toolkit = (parsed as { toolkit?: unknown } | null)?.toolkit;
    if (typeof toolkit !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(toolkit)) {
      return json({ error: 'invalid_toolkit' }, 400);
    }
    // 'app' or nothing. An unrecognised surface falls back to web rather than
    // being trusted, because this arrives from the client.
    const surface = (parsed as { surface?: unknown } | null)?.surface === 'app' ? 'app' : 'web';
    const res = await initiateConnection(env, user.id, toolkit, deps, surface);
    if (!res.ok) {
      const status = res.error === 'unknown_toolkit' ? 400
        : res.error === 'not_configured' ? 503
          : res.error === 'rate_limited' ? 429 : 502;
      return brokerError(res, status);
    }
    // The client can confirm this exact initiated grant after returning. A
    // different existing connection to the same service is not that proof.
    return json({ redirectUrl: res.value.redirectUrl, expiresAt: res.value.expiresAt,
      connectedAccountId: res.value.connectedAccountId });
  }

  // BEFORE the account-addressed branch below, which matches this prefix too.
  // The comment at the top of this file is about exactly this class of mistake.
  if (path.startsWith('/api/connections/composio/service/') && request.method === 'DELETE') {
    const service = decodeURIComponent(path.slice('/api/connections/composio/service/'.length));
    if (!/^[a-z0-9_-]{1,64}$/.test(service)) return json({ error: 'invalid_toolkit' }, 400);
    const res = await disconnectComposioService(env, user.id, service, deps);
    if (!res.ok) {
      return brokerError(res, res.error === 'unknown_toolkit' ? 400
        : res.error === 'not_configured' ? 503
          : res.error === 'rate_limited' ? 429 : 502);
    }
    const { removed, failed, complete } = res.value;
    // The card promises that access is lost straight away, so anything short
    // of that is reported as short of it. A partial removal is NOT a success
    // with a footnote: the coworker can still reach the account.
    if (failed.length > 0) {
      return json({ error: 'partial_disconnect', removed: removed.length, failed: failed.length }, 502);
    }
    // Nothing found and an inventory we could not finish reading is not proof
    // that there was nothing to remove.
    if (!complete && removed.length === 0) return json({ error: 'disconnect_unconfirmed' }, 502);
    return json({ disconnected: true, removed: removed.length, complete });
  }

  if (path.startsWith('/api/connections/composio/') && request.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/connections/composio/'.length));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return json({ error: 'invalid_account' }, 400);

    // Only disconnect something that is genuinely THIS user's. Composio would
    // happily delete any account id we hand it, so the ownership check has to
    // happen here or one customer could disconnect another's mailbox.
    const mine = await listConnections(env, user.id, deps);
    if (!mine.ok) return json({ error: mine.error }, 502);
    if (!mine.value.some((c) => c.connectedAccountId === id)) {
      return json({ error: 'not_found' }, 404);
    }

    const res = await disconnect(env, id, deps);
    return res.ok ? json({ disconnected: true }) : json({ error: res.error }, 502);
  }

  if (path === '/api/connections/composio/toolkits' && request.method === 'GET') {
    return json({ toolkits: COMPOSIO_TOOLKITS.map((t) => ({ slug: t.slug, id: t.connectionId })) });
  }

  return json({ error: 'not_found' }, 404);
}

// ---------------------------------------------------------------------------
// The RUNNER surface.
//
// Separate from everything above because the caller differs in kind: not a
// customer holding a bearer token, but their workspace holding the runner HMAC.
// index.ts authenticates that and passes the resolved user id in, so nothing
// here reads a header.
//
// **This is the part that was missing, and its absence is the whole reason a
// connected Gmail was useless.** The card, the consent and the storage all
// worked. The agent simply had no door onto them, so it looked in our own
// broker, did not find Gmail there, and correctly told the customer it was not
// connected. Shipping the plumbing is not shipping the connection.
//
// The Composio API key never reaches the runner. A runner is per-customer and
// the agent runs arbitrary code inside it, so a key there would be a key the
// agent could read out and use against every other customer's connections.
// ---------------------------------------------------------------------------

export type ComposioRunnerDeps = ExecuteDeps;

export function isComposioRunnerPath(pathname: string): boolean {
  return pathname === '/api/runner/connections/composio'
    || pathname === '/api/runner/connections/composio/execute';
}

export async function handleComposioRunner(
  request: Request,
  env: ComposioRouteEnv,
  url: URL,
  userId: string,
  deps: ComposioRunnerDeps,
): Promise<Response> {
  if (url.pathname === '/api/runner/connections/composio' && request.method === 'GET') {
    const res = await listConnections(env, userId, deps);
    // An unconfigured broker reports nothing connected rather than an error.
    // The agent can act on "you have no Gmail". It cannot act on a 502.
    if (!res.ok) {
      if (res.error === 'not_configured') return json({ connections: [] });
      return brokerError(res, res.error === 'rate_limited' ? 429 : 502);
    }
    return json({
      connections: res.value.filter((c) => c.active).map((c) => ({
        provider: c.connectionId,
        toolkit: c.toolkitSlug,
        backend: 'composio',
        status: 'connected',
      })),
    });
  }

  if (url.pathname === '/api/runner/connections/composio/execute' && request.method === 'POST') {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await request.text()) || '{}');
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;

    const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
    if (!/^[A-Z][A-Z0-9_]{2,96}$/.test(tool)) return json({ error: 'invalid_tool' }, 400);

    // The tool must belong to a toolkit WE offer. Without this the agent could
    // name any slug in Composio's whole catalogue and reach a service the
    // customer was never shown and never agreed to, which is exactly what a
    // prompt injection buried in an email would try to do.
    const toolkit = COMPOSIO_TOOLKITS.find((t) => tool.startsWith(`${t.slug.toUpperCase()}_`));
    if (!toolkit) return json({ error: 'unknown_toolkit' }, 400);

    // Some grants are wider than the card promises (Stripe will not issue a
    // read-only grant). The promise is kept here: a write action on such a
    // toolkit never reaches Composio, whatever the customer's token allows.
    if (toolkit.allowTools && !toolkit.allowTools.test(tool)) {
      return json({ error: 'read_only', provider: toolkit.connectionId }, 403);
    }

    const args = body.arguments;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return json({ error: 'invalid_arguments' }, 400);
    }

    // Refuse before spending anything. "Not connected" is something the agent
    // can tell the customer how to fix. A provider error five layers down is
    // not, and it reads to them as the product being broken.
    const connected = await listConnections(env, userId, deps);
    if (!connected.ok) {
      if (connected.error === 'not_configured') return json({ error: 'not_configured' }, 503);
      return brokerError(connected, connected.error === 'rate_limited' ? 429 : 502);
    }
    if (!connected.value.some((c) => c.active && c.toolkitSlug === toolkit.slug)) {
      return json({ error: 'not_connected', provider: toolkit.connectionId }, 409);
    }

    const res = await executeTool(env, userId, tool, (args as Record<string, unknown>) ?? {}, deps);
    if (!res.ok) {
      const status = res.error === 'quota_exceeded' ? 429
        : res.error === 'not_configured' ? 503
          : res.error === 'rate_limited' ? 429 : 502;
      return brokerError(res, status);
    }
    return json({ result: res.value });
  }

  return json({ error: 'not_found' }, 404);
}
