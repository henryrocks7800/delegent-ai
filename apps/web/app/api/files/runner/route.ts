import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseRunnerFilesAuthResolver,
  createSupabaseRunnerFilesStore,
  handleRunnerFilesListRequest,
  type RunnerFilesServerEnv,
} from '../../../../lib/server/runnerFilesFlow';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const env = runnerFilesServerEnv();
  const serviceClient = createServerSupabaseClient(env, env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key');
  const authClient = createServerSupabaseClient(env, env.SUPABASE_ANON_KEY || 'missing-anon-key');
  return handleRunnerFilesListRequest(request, {
    env,
    getAuthenticatedUser: createSupabaseRunnerFilesAuthResolver(authClient as any),
    store: createSupabaseRunnerFilesStore(serviceClient as any),
    fetchRunner: fetch,
  });
}

function runnerFilesServerEnv(): RunnerFilesServerEnv {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SIDEKICK_FILE_LINK_SIGNING_SECRET: process.env.SIDEKICK_FILE_LINK_SIGNING_SECRET,
  };
}

function createServerSupabaseClient(env: RunnerFilesServerEnv, key: string) {
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
