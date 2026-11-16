import 'react-native-url-polyfill/auto';

import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { AUTH_PROVIDER_APPLE, AUTH_PROVIDER_EMAIL, AUTH_PROVIDER_GOOGLE, AUTH_PROVIDER_PHONE, maskE164PhoneNumber, type AuthProvider, type PublicAuthSession } from '@sidekick/shared';
import { mobileSupabaseConfig } from './publicSupabase';
import { clearPersistedAuthStorage, secureSessionStorage } from './secureSessionStorage';

type PublicMetadata = Record<string, unknown>;

let inMemoryAccessToken: string | null = null;
let inMemorySessionExpiresAt: number | null = null;
const MOBILE_SESSION_REFRESH_SKEW_SECONDS = 60;

// Refresh-storm guard state (GO_LIVE_TRACKER #16). See refreshMobileSessionGuarded.
let inFlightRefresh: Promise<Session | null> | null = null;
let refreshCooldownUntilMs = 0;
let refreshBackoffMs = 0;
const REFRESH_BACKOFF_BASE_MS = 2_000;
const REFRESH_BACKOFF_MAX_MS = 5 * 60_000;
const REFRESH_INVALID_COOLDOWN_MS = 60 * 60_000;

function accessTokenFromSession(session: Session | null): string | null {
  const token = session?.access_token;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

function expiresAtFromSession(session: Session | null): number | null {
  return typeof session?.expires_at === 'number' ? session.expires_at : null;
}

export function rememberMobileSupabaseSession(session: Session | null): void {
  inMemoryAccessToken = accessTokenFromSession(session);
  inMemorySessionExpiresAt = inMemoryAccessToken ? expiresAtFromSession(session) : null;
  // A valid session (sign-in or a successful refresh) clears any backoff so the
  // next near-expiry refresh isn't blocked by a stale cooldown (#16).
  if (inMemoryAccessToken) {
    refreshCooldownUntilMs = 0;
    refreshBackoffMs = 0;
  }
}

export function forgetMobileSupabaseSession(): void {
  inMemoryAccessToken = null;
  inMemorySessionExpiresAt = null;
}

function rememberedMobileSessionNeedsRefresh(): boolean {
  if (!inMemoryAccessToken || typeof inMemorySessionExpiresAt !== 'number') return true;
  const secondsUntilExpiry = inMemorySessionExpiresAt - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_SESSION_REFRESH_SKEW_SECONDS;
}

export function getRememberedMobileAccessToken(): string | null {
  if (rememberedMobileSessionNeedsRefresh()) return null;
  return inMemoryAccessToken;
}

/**
 * End the session on THIS device, whatever the server says.
 *
 * ⚠️ The SDK cannot be relied on for the local half, and the code here used to
 * assume the opposite. In the installed auth client BOTH scopes call the server
 * first and return early on any error that is not a 401, 403 or 404, so an
 * offline or 503 sign-out never reaches its own local removal. `signOut()`
 * resolves with `{ error }` rather than throwing, so a try/catch around it
 * catches nothing. The screen said signed out, storage still held the session,
 * and the next launch restored the same account. Reproduced against the actual
 * SDK on 2026-09-13: two failed requests, nothing removed.
 *
 * The order matters.
 *  1. Ask the server to revoke, best effort, and remember whether it did.
 *  2. Delete the persisted session ourselves. No network in that path, so there
 *     is nothing for it to fail on. This is what actually ends the session here.
 *  3. Call scope:'local' again. With no access token left it skips its server
 *     call, reaches _removeSession, clears the client and notifies every
 *     subscriber, which is what stops the UI holding a stale session object.
 *  4. Clear once more, in case step 3's own read raced a refresh that landed.
 *
 * Returns whether the remote revocation actually happened, so the caller can
 * tell "signed out here" from "signed out everywhere" instead of assuming.
 */
export async function signOutMobileSessionDurably(
  client: SupabaseClient | null = mobileSupabase,
): Promise<{ readonly remoteRevoked: boolean }> {
  let remoteRevoked = false;
  try {
    const result = await client?.auth.signOut();
    remoteRevoked = Boolean(result) && !result?.error;
  } catch {
    remoteRevoked = false;
  }
  await clearPersistedAuthStorage();
  try {
    await client?.auth.signOut({ scope: 'local' });
  } catch {
    // best effort; the clear below is what the session actually depends on
  }
  await clearPersistedAuthStorage();
  forgetMobileSupabaseSession();
  return { remoteRevoked };
}

async function clearLocalMobileSupabaseSession(client: SupabaseClient | null = mobileSupabase): Promise<void> {
  forgetMobileSupabaseSession();
  try {
    await client?.auth.signOut({ scope: 'local' });
  } catch {
    // Local cleanup is best-effort; the in-memory token has already been removed.
  }
}

function sessionNeedsRefresh(session: Session | null): boolean {
  if (!session || typeof session.expires_at !== 'number') return true;
  const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
  return secondsUntilExpiry <= MOBILE_SESSION_REFRESH_SKEW_SECONDS;
}

// --- refresh-storm guard (GO_LIVE_TRACKER #16) ---------------------------------
// Several screens plus the WebView's periodic token push can call refreshSession()
// concurrently. On an invalid/expired refresh token, repeated calls hammer
// Supabase's /token endpoint and trip the per-IP rate limit — which collaterally
// blocks sign-in for anyone sharing the egress IP (the documented 2026-06-07
// incident). Two defences: (1) coalesce concurrent refreshes into ONE in-flight
// call; (2) back off after failures, and stop entirely when the refresh token is
// permanently invalid (force a sign-in instead of retrying the impossible).
type RefreshErrorLike = { message?: string; code?: string; status?: number } | null | undefined;

function isInvalidRefreshError(error: RefreshErrorLike): boolean {
  if (!error) return false;
  const code = (error.code ?? '').toLowerCase();
  const message = (error.message ?? '').toLowerCase();
  return (
    error.status === 400 ||
    code.includes('refresh_token_not_found') ||
    code.includes('invalid_grant') ||
    code.includes('refresh_token_already_used') ||
    message.includes('invalid refresh token') ||
    message.includes('refresh token not found') ||
    message.includes('already used')
  );
}

function noteRefreshFailure(): void {
  refreshBackoffMs = Math.min(
    refreshBackoffMs > 0 ? refreshBackoffMs * 2 : REFRESH_BACKOFF_BASE_MS,
    REFRESH_BACKOFF_MAX_MS,
  );
  refreshCooldownUntilMs = Date.now() + refreshBackoffMs;
}

// Exported for tests / a fresh sign-in to clear the backoff immediately.
export function resetMobileRefreshBackoff(): void {
  inFlightRefresh = null;
  refreshCooldownUntilMs = 0;
  refreshBackoffMs = 0;
}

async function refreshMobileSessionGuarded(client: SupabaseClient): Promise<Session | null> {
  if (Date.now() < refreshCooldownUntilMs) {
    // In a backoff window — do NOT hit /token again. The caller falls back to a
    // still-valid remembered token, or surfaces a sign-in recovery message.
    return null;
  }
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async (): Promise<Session | null> => {
    try {
      const refreshed = await client.auth.refreshSession();
      if (refreshed.error) {
        if (isInvalidRefreshError(refreshed.error)) {
          // Permanently dead refresh token — retrying can only storm /token.
          // Clear the session and stand down until the next sign-in.
          refreshCooldownUntilMs = Date.now() + REFRESH_INVALID_COOLDOWN_MS;
          await clearLocalMobileSupabaseSession(client);
          return null;
        }
        noteRefreshFailure();
        return null;
      }
      refreshBackoffMs = 0;
      refreshCooldownUntilMs = 0;
      const refreshedSession = refreshed.data.session ?? null;
      if (refreshedSession && !sessionNeedsRefresh(refreshedSession)) {
        rememberMobileSupabaseSession(refreshedSession);
      }
      return refreshedSession;
    } catch {
      // Network / transient: back off rather than retry-spamming.
      noteRefreshFailure();
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

export async function getFreshMobileSupabaseSession(client: SupabaseClient | null = mobileSupabase): Promise<Session | null> {
  if (!client) return null;

  let session: Session | null = null;
  try {
    const current = await client.auth.getSession();
    if (!current.error) session = current.data.session ?? null;
  } catch {
    session = null;
  }

  if (!sessionNeedsRefresh(session)) {
    rememberMobileSupabaseSession(session);
    return session;
  }

  // Coalesced + backed-off refresh. It clears the session itself if the refresh
  // token is permanently invalid; on a transient failure (or during a backoff
  // window) it returns null while KEEPING the existing session, so a later
  // attempt can recover without signing the user out on a blip.
  const refreshedSession = await refreshMobileSessionGuarded(client);
  if (refreshedSession && !sessionNeedsRefresh(refreshedSession)) {
    return refreshedSession;
  }
  return null;
}

export async function getFreshMobileAccessToken(client: SupabaseClient | null = mobileSupabase): Promise<string | null> {
  const rememberedAccessToken = getRememberedMobileAccessToken();
  const freshSession = await getFreshMobileSupabaseSession(client);
  if (rememberedMobileSessionNeedsRefresh()) return null;
  return accessTokenFromSession(freshSession) ?? getRememberedMobileAccessToken() ?? rememberedAccessToken;
}

function metadataString(metadata: PublicMetadata, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }

  return undefined;
}

function userDisplayName(user: User): string | undefined {
  const metadata = (user.user_metadata ?? {}) as PublicMetadata;
  return metadataString(metadata, ['full_name', 'name']);
}

function userAvatarUrl(user: User): string | undefined {
  const metadata = (user.user_metadata ?? {}) as PublicMetadata;
  return metadataString(metadata, ['avatar_url', 'picture']);
}

function userAuthProvider(user: User): AuthProvider {
  const appMetadata = (user.app_metadata ?? {}) as PublicMetadata;
  const provider = typeof appMetadata.provider === 'string' ? appMetadata.provider : '';
  if (provider === AUTH_PROVIDER_PHONE || (typeof user.phone === 'string' && user.phone.trim().length > 0 && !user.email)) {
    return AUTH_PROVIDER_PHONE;
  }
  if (provider === AUTH_PROVIDER_EMAIL) {
    return AUTH_PROVIDER_EMAIL;
  }
  if (provider === AUTH_PROVIDER_APPLE) {
    return AUTH_PROVIDER_APPLE;
  }

  return AUTH_PROVIDER_GOOGLE;
}

function userMaskedPhone(user: User): string | undefined {
  if (typeof user.phone !== 'string' || user.phone.trim().length === 0) return undefined;
  try {
    return maskE164PhoneNumber(user.phone);
  } catch {
    return 'Phone account';
  }
}

// Session is persisted via expo-secure-store on iOS/Android (Keychain /
// Keystore-backed) and falls back to AsyncStorage on web/dev where
// SecureStore is unavailable. See `secureSessionStorage.ts` for the
// adapter and the fallback policy.
export const mobileSupabase: SupabaseClient | null = mobileSupabaseConfig.ready
  ? createClient(mobileSupabaseConfig.config.url, mobileSupabaseConfig.config.anonKey, {
      auth: {
        storage: secureSessionStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export function mapSupabaseSessionToPublicSession(session: Session | null): PublicAuthSession | null {
  if (!session) return null;

  const provider = userAuthProvider(session.user);
  const publicSession: PublicAuthSession = {
    provider,
    user: {
      id: session.user.id,
    },
  };

  const email = session.user.email?.trim();
  const fullName = userDisplayName(session.user);
  const avatarUrl = userAvatarUrl(session.user);
  const phoneMasked = userMaskedPhone(session.user);

  if (email) publicSession.user.email = email;
  if (phoneMasked && provider === AUTH_PROVIDER_PHONE) publicSession.user.phoneMasked = phoneMasked;
  if (fullName) publicSession.user.fullName = fullName;
  if (avatarUrl) publicSession.user.avatarUrl = avatarUrl;
  if (typeof session.expires_at === 'number') publicSession.expiresAt = new Date(session.expires_at * 1000).toISOString();

  return publicSession;
}
