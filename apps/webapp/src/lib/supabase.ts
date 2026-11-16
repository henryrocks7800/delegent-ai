import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseReady, supabaseUrl } from './env';

/**
 * Ours, not derived from the project URL, and exported so sign-out can delete
 * the persisted session itself rather than trusting the SDK to do it. One
 * definition, because two would drift and the second one would silently fail to
 * clear anything.
 */
export const WEB_AUTH_STORAGE_KEY = 'delegent.web.auth';

// The anon key is public by design and is protected by row-level security.
// Nothing here may ever hold a service-role key.
export const supabase: SupabaseClient | null = supabaseReady
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Google returns to us with ?code= in the query, which useAuth exchanges
        // explicitly. Letting Supabase do it implicitly means it also reads
        // unrelated hash fragments on every load, and it leaves no place to
        // handle a code that has already been spent.
        detectSessionInUrl: false,
        // Without this the Google return arrives as an access token in the URL
        // fragment, which lands in history and in any logging that records the
        // full address. The code in the query is single-use and useless alone.
        flowType: 'pkce',
        storageKey: WEB_AUTH_STORAGE_KEY,
      },
    })
  : null;

/**
 * A guaranteed-fresh access token, or null when signed out.
 *
 * `getSession()` alone returns whatever is cached, which can be an expired JWT
 * after the tab has been asleep. Mobile hit exactly this and it presented as a
 * silent 401 on the first action after waking, so refresh rather than trust.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;

  const expiresAt = data.session.expires_at ? data.session.expires_at * 1000 : 0;
  if (expiresAt && expiresAt - Date.now() > 60_000) return data.session.access_token;

  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) return data.session.access_token ?? null;
  return refreshed.data.session.access_token;
}
