// Public configuration. Everything here is already inlined into the shipped
// Android app, so none of it is a secret. Values arrive via .env.production.local,
// which scripts/write-public-env.mjs generates from the same mirror the mobile
// build reads, so the two surfaces can never point at different backends.

function readEnv(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === 'string' ? value.trim() : '';
}

// Mirrors normalizePublicApiBaseUrl in apps/mobile/src/billing/mobileCheckout.ts:
// https only, no trailing slash, no credentials in the URL.
export function normalizeApiBaseUrl(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password) return '';
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export const supabaseUrl = readEnv('VITE_SUPABASE_URL');
export const supabaseAnonKey = readEnv('VITE_SUPABASE_ANON_KEY');
export const apiBaseUrl = normalizeApiBaseUrl(readEnv('VITE_API_BASE_URL'));
// The same client the phone passes to the native Google picker. Public: it is
// already inlined in the shipped APK.
export const googleWebClientId = readEnv('VITE_GOOGLE_WEB_CLIENT_ID');

export const supabaseReady = Boolean(supabaseUrl && supabaseAnonKey);
export const apiReady = Boolean(apiBaseUrl);
export const configReady = supabaseReady && apiReady;

// In `npm run dev` the Vite proxy forwards /api to the live Worker, so the
// browser makes a same-origin request and local development does not depend on
// the production CORS allowlist. In a real build we call the API directly.
export const apiOrigin = import.meta.env.DEV ? '' : apiBaseUrl;
