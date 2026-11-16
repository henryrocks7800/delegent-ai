import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseMessagingAuthResolver,
  createSupabaseMessagingConnectionStore,
  handleMessagingProviderDisconnectRequest,
  type MessagingConnectionServerEnv,
} from '../../../../../lib/server/messagingConnectionFlow';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = messagingConnectionServerEnv();
  const serviceClient = createServerSupabaseClient(env, env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key');
  const authClient = createServerSupabaseClient(env, env.SUPABASE_ANON_KEY || 'missing-anon-key');
  return handleMessagingProviderDisconnectRequest(request, {
    env,
    getAuthenticatedUser: createSupabaseMessagingAuthResolver(authClient),
    store: createSupabaseMessagingConnectionStore(serviceClient),
  });
}

function messagingConnectionServerEnv(): MessagingConnectionServerEnv {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

function createServerSupabaseClient(env: MessagingConnectionServerEnv, key: string) {
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
