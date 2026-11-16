import { isMessagingProviderId, publicMessagingProviderLabel, type MessagingProviderId } from '@sidekick/shared';

export interface MessagingConnectionServerEnv {
  SUPABASE_URL?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
}

export interface AuthenticatedMessagingUser {
  id: string;
}

export interface MessagingProviderDisconnectInput {
  userId: string;
  providerId?: MessagingProviderId | null;
}

export interface MessagingProviderDisconnectResult {
  providerId: MessagingProviderId | null;
}

export interface MessagingProviderConnectionStore {
  disconnectActiveProvider(input: MessagingProviderDisconnectInput): Promise<MessagingProviderDisconnectResult>;
}

export interface MessagingConnectionRouteDeps {
  env: MessagingConnectionServerEnv;
  getAuthenticatedUser(token: string, env: MessagingConnectionServerEnv): Promise<AuthenticatedMessagingUser | null>;
  store: MessagingProviderConnectionStore;
}

const DISCONNECT_RPC = 'disconnect_gateway_connection';

export async function handleMessagingProviderDisconnectRequest(
  request: Request,
  deps: MessagingConnectionRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') return safeJson({ error: 'POST required' }, 405);

  const readiness = resolveReadiness(deps.env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!readiness.ok) return safeJson({ error: 'messenger_disconnect_unavailable', missing: readiness.missing }, 503);

  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return safeJson({ error: 'unauthenticated' }, 401);

  let user: AuthenticatedMessagingUser | null;
  try {
    user = await deps.getAuthenticatedUser(token, deps.env);
  } catch {
    return safeJson({ error: 'unauthenticated' }, 401);
  }

  if (!user || !isUuid(user.id)) return safeJson({ error: 'unauthenticated' }, 401);

  const requestedProvider = await requestedMessagingProviderId(request);
  if (requestedProvider === 'invalid') return safeJson({ error: 'unsupported_messenger' }, 400);

  let result: MessagingProviderDisconnectResult;
  try {
    result = await deps.store.disconnectActiveProvider({ userId: user.id, providerId: requestedProvider });
  } catch {
    return safeJson({ error: 'messenger_disconnect_unavailable' }, 503);
  }

  const providerId = result.providerId;
  if (!providerId) {
    return safeJson({
      ok: true,
      providerId: null,
      kind: 'already_disconnected',
      publicMessage: requestedProvider
        ? `${publicMessagingProviderLabel(requestedProvider)} is already disconnected.`
        : 'No messenger is connected right now.',
    }, 200);
  }

  return safeJson({
    ok: true,
    providerId,
    kind: 'disconnected',
    publicMessage: `${publicMessagingProviderLabel(providerId)} is disconnected. You can reconnect it whenever you are ready.`,
  }, 200);
}

export function createSupabaseMessagingConnectionStore(client: {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data?: unknown; error?: unknown }>;
}): MessagingProviderConnectionStore {
  return {
    async disconnectActiveProvider(input) {
      const result = await client.rpc(DISCONNECT_RPC, {
        p_user_id: input.userId,
        p_gateway_id: input.providerId ?? null,
      });
      if (result.error) throw new Error('messenger_disconnect_failed');

      const firstRow = Array.isArray(result.data) ? result.data[0] : result.data;
      const providerValue = isRecord(firstRow) ? firstRow.gateway_id ?? firstRow.provider_id ?? firstRow.providerId : null;
      return { providerId: isMessagingProviderId(providerValue) ? providerValue : null };
    },
  };
}

export function createSupabaseMessagingAuthResolver(authClient: {
  auth: {
    getUser(token: string): Promise<{ data?: { user?: { id?: string } | null } | null; error?: unknown }>;
  };
}) {
  return async function getAuthenticatedUser(token: string): Promise<AuthenticatedMessagingUser | null> {
    const result = await authClient.auth.getUser(token);
    if (result.error || !result.data?.user?.id) return null;
    return { id: result.data.user.id };
  };
}

async function requestedMessagingProviderId(request: Request): Promise<MessagingProviderId | null | 'invalid'> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return 'invalid';
  }

  if (!isRecord(payload) || payload.providerId === undefined || payload.providerId === null || payload.providerId === '') {
    return null;
  }

  return isMessagingProviderId(payload.providerId) ? payload.providerId : 'invalid';
}

function resolveReadiness(env: MessagingConnectionServerEnv, required: Array<keyof MessagingConnectionServerEnv>) {
  const missing = required.filter((name) => !nonEmptyString(env[name]));
  return { ok: missing.length === 0, missing: missing.map(String) };
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return nonEmptyString(match?.[1]);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
