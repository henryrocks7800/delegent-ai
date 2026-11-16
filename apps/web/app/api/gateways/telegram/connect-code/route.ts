import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseTelegramConnectStore,
  handleTelegramConnectCodeRequest,
  type AuthenticatedTelegramUser,
  type TelegramConnectServerEnv,
} from '../../../../../lib/server/telegramConnectFlow';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = telegramConnectServerEnv();
  const serviceClient = createServerSupabaseClient(env, env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key');
  return handleTelegramConnectCodeRequest(request, {
    env,
    async getAuthenticatedUser(token) {
      const authClient = createServerSupabaseClient(env, env.SUPABASE_ANON_KEY || 'missing-anon-key');
      return getAuthenticatedTelegramUser(authClient, token);
    },
    store: createSupabaseTelegramConnectStore(serviceClient),
  });
}

function telegramConnectServerEnv(): TelegramConnectServerEnv {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SIDEKICK_TELEGRAM_BOT_USERNAME: process.env.SIDEKICK_TELEGRAM_BOT_USERNAME,
    SIDEKICK_TELEGRAM_CONNECT_CODE_TTL_MINUTES: process.env.SIDEKICK_TELEGRAM_CONNECT_CODE_TTL_MINUTES,
  };
}

function createServerSupabaseClient(env: TelegramConnectServerEnv, key: string) {
  return createClient(
    env.SUPABASE_URL || 'https://missing.supabase.co',
    key,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

async function getAuthenticatedTelegramUser(authClient: {
  auth: {
    getUser(token: string): Promise<{ data?: { user?: { id?: string } | null } | null; error?: unknown }>;
  };
}, token: string): Promise<AuthenticatedTelegramUser | null> {
  const result = await authClient.auth.getUser(token);
  if (result.error || !result.data?.user?.id) return null;
  return { id: result.data.user.id };
}
