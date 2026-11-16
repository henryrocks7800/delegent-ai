import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseRunnerFilesAuthResolver,
  createSupabaseRunnerFilesStore,
  handleRunnerFileDeleteRequest,
  handleRunnerFileDownloadRequest,
  handleRunnerFileRenameRequest,
  type RunnerFilesServerEnv,
} from '../../../../../lib/server/runnerFilesFlow';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ fileId?: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const env = runnerFilesServerEnv();
  const { fileId } = await context.params;
  const serviceClient = createServerSupabaseClient(env, env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key');
  return handleRunnerFileDownloadRequest(request, fileId || '', {
    env,
    store: createSupabaseRunnerFilesStore(serviceClient as any),
    fetchRunner: fetch,
  });
}

// DELETE removes a workspace file; POST (with { newName }) renames it. Both use
// the user's Bearer token (unlike GET, which uses a signed download link) and
// share the list route's auth resolver + runner-binding store.
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { fileId } = await context.params;
  return handleRunnerFileDeleteRequest(request, fileId || '', mutationDeps());
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { fileId } = await context.params;
  return handleRunnerFileRenameRequest(request, fileId || '', mutationDeps());
}

function mutationDeps() {
  const env = runnerFilesServerEnv();
  const serviceClient = createServerSupabaseClient(env, env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key');
  const authClient = createServerSupabaseClient(env, env.SUPABASE_ANON_KEY || 'missing-anon-key');
  return {
    env,
    getAuthenticatedUser: createSupabaseRunnerFilesAuthResolver(authClient as any),
    store: createSupabaseRunnerFilesStore(serviceClient as any),
    fetchRunner: fetch,
  };
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
