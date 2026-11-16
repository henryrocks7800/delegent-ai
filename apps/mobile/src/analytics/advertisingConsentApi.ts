// Send a durable account-scoped advertising choice. Failed requests retry on
// foreground/sign-in. The server rejects older device revisions.
import { getFreshMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';

const CONSENT_PATH = '/api/analytics/advertising-consent';
const CONSENT_TIMEOUT_MS = 10_000;

export async function advertisingAccessToken(userId: string): Promise<string | null> {
  if (!mobileSupabase) return null;
  const token = await getFreshMobileAccessToken(mobileSupabase);
  const { data } = await mobileSupabase.auth.getSession();
  return data.session?.user.id === userId && data.session.access_token === token ? token : null;
}

export async function reportAdvertisingConsentToServer(
  userId: string, granted: boolean, deviceId: string, revision: number, current: () => boolean,
): Promise<boolean> {
  try {
    const apiBaseUrl = normalizePublicApiBaseUrl(mobileSidekickApiBaseUrl);
    if (!apiBaseUrl) return false;
    const accessToken = await advertisingAccessToken(userId);
    if (!accessToken || !current()) return false;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* already done */ } }, CONSENT_TIMEOUT_MS) : null;
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}${CONSENT_PATH}`, {
        method: 'POST',
        ...(controller ? { signal: controller.signal } : {}),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ granted, deviceId, revision }),
      });
      return response.ok;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
