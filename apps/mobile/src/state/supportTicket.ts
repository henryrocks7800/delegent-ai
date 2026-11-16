// In-app support (2026-07-16). Sends the user's problem description to the
// worker, which relays it to the corporate support inbox with the account
// identity attached server-side. Mobile never holds mail credentials.
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { normalizePublicApiBaseUrl } from '../billing/mobileCheckout';

declare const process: { env: Record<string, string | undefined> };

const expoApiBase =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

// 'issue' = something is broken; 'suggestion' = a feature request. The worker
// labels the relayed email so the team can triage the two apart.
export type SupportTicketKind = 'issue' | 'suggestion';

export async function sendSupportTicket(message: string, kind: SupportTicketKind = 'issue'): Promise<boolean> {
  const apiBase = normalizePublicApiBaseUrl(expoApiBase);
  if (!apiBase) return false;
  const token = await getFreshMobileAccessToken(mobileSupabase);
  if (!token) return false;
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, '')}/api/support/ticket`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message, kind }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
