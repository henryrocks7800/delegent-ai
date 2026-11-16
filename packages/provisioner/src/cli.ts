#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  cleanupHermesTestRunner,
  createHermesRunnerHealthClient,
  createSeries4SupabaseLifecycleStore,
  createSupabaseHermesProvisioningStore,
  createSupabaseServiceRoleRestClient,
  preflightRailwayProvisioner,
  processNextHermesProvisioningJob,
  processNextHermesRunnerDomainDiscoveryJob,
  processNextHermesRunnerReadinessCheck,
  processNextSeries4FlyProvisioningJob,
  processNextSeries4GraceExpiry,
  processNextSeries4StuckReadiness,
  processNextAccountDeletionRequest,
  processNextCoworkerReimage,
  processNextSeries4RunnerResize,
  processSeries4StorageUsageSweep,
  processSeries4SubscriptionSuspension,
  processSeries4SuspendedRunnerStop,
  type RailwayApiClient,
  type RunnerHealthClient,
} from './index.js';

export interface HermesProvisionerCliDeps {
  fetchImpl?: Parameters<typeof createSupabaseServiceRoleRestClient>[0]['fetchImpl'];
  railway?: RailwayApiClient;
  runnerHealth?: RunnerHealthClient;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type CliEnv = Record<string, string | undefined>;

function nonEmptyEnv(env: CliEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sanitizeCliErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return sanitized || 'provisioner_cli_failed';
}

function writeJson(write: (line: string) => void, payload: unknown): void {
  write(JSON.stringify(payload));
}

function nonEmptyArg(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanupTargetFromArgs(argv: readonly string[], env: CliEnv): { userId?: string; railwayProjectId?: string } {
  return {
    userId: nonEmptyArg(argv[1]) ?? nonEmptyEnv(env, 'SIDEKICK_CLEANUP_USER_ID'),
    railwayProjectId: nonEmptyArg(argv[2]) ?? nonEmptyEnv(env, 'SIDEKICK_CLEANUP_RAILWAY_PROJECT_ID'),
  };
}

function supabasePreflight(env: CliEnv): { ok: boolean; missingVariables: string[]; missingSecrets: string[] } {
  const missingVariables = nonEmptyEnv(env, 'SUPABASE_URL') ? [] : ['SUPABASE_URL'];
  const missingSecrets = nonEmptyEnv(env, 'SUPABASE_SERVICE_ROLE_KEY') ? [] : ['SUPABASE_SERVICE_ROLE_KEY'];
  return {
    ok: missingVariables.length === 0 && missingSecrets.length === 0,
    missingVariables,
    missingSecrets,
  };
}

function createStore(env: CliEnv, deps: HermesProvisionerCliDeps) {
  const supabaseUrl = nonEmptyEnv(env, 'SUPABASE_URL');
  const serviceRoleKey = nonEmptyEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) throw new Error('supabase_service_role_config_missing');
  return createSupabaseHermesProvisioningStore(createSupabaseServiceRoleRestClient({
    supabaseUrl,
    serviceRoleKey,
    fetchImpl: deps.fetchImpl,
  }));
}

export async function runHermesProvisionerCli(
  argv: readonly string[] = [],
  env: CliEnv = process.env,
  deps: HermesProvisionerCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const command = argv[0] ?? 'process-once';

  if (command === 'help' || command === '--help' || command === '-h') {
    stdout([
      'sidekick-provisioner process-once   # claim one queued paid user and request Railway Hermes runner deployment',
      'sidekick-provisioner readiness-once # claim one private runner readiness probe and update Supabase',
      'sidekick-provisioner cleanup-test-runner <user-id> <railway-project-id> # delete one verified test runner project and requeue it',
      'sidekick-provisioner preflight      # validate non-secret operational readiness flags',
      'sidekick-provisioner series4:provision-once # Series 4 — claim one queued user and deploy a per-user Fly runner',
      'sidekick-provisioner series4:grace-expiry-once # Series 4 — claim one sleeping user past grace and force-delete the Fly app/Machine/volume',
      'sidekick-provisioner series4:resize-once # Series 4 — claim one runner whose plan tier drifted from its machine size and resize it in place',
      'sidekick-provisioner series4:account-deletion-once # Series 4 — claim one durable account deletion request and force-delete the snapshotted Fly workspace',
      'sidekick-provisioner series4:suspend <user-id> # Series 4 — mark a user\'s runner sleeping (Option A) and start the grace window',
    ].join('\n'));
    return 0;
  }

  const supabase = supabasePreflight(env);
  const railway = preflightRailwayProvisioner({
    env,
    image: nonEmptyEnv(env, 'SIDEKICK_RUNNER_IMAGE'),
    workerProxyUrl: nonEmptyEnv(env, 'SIDEKICK_WORKER_PROXY_URL'),
    runnerSharedSecret: nonEmptyEnv(env, 'SIDEKICK_RUNNER_SHARED_SECRET'),
    runnerServerUrl: nonEmptyEnv(env, 'SIDEKICK_RUNNER_SERVER_URL'),
    tierId: 'studio',
  });

  if (command === 'preflight') {
    writeJson(stdout, {
      status: supabase.ok && railway.ok ? 'ready' : 'blocked',
      supabase,
      railway,
    });
    return supabase.ok && railway.ok ? 0 : 2;
  }

  if (
    command !== 'process-once'
    && command !== 'provision-once'
    && command !== 'readiness-once'
    && command !== 'cleanup-test-runner'
    && command !== 'series4:provision-once'
    && command !== 'series4:grace-expiry-once'
    && command !== 'series4:account-deletion-once'
    && command !== 'series4:reimage-once'
    && command !== 'series4:resize-once'
    && command !== 'series4:stuck-readiness-once'
    && command !== 'series4:storage-usage-once'
    && command !== 'series4:suspend-stop-once'
    && command !== 'series4:suspend'
  ) {
    writeJson(stderr, { status: 'failed', errorCode: 'unknown_command' });
    return 64;
  }

  // Series 4 commands have their own preflight (they need FLY_* env, not
  // Railway env) and their own store.
  if (command === 'series4:provision-once' || command === 'series4:grace-expiry-once' || command === 'series4:account-deletion-once' || command === 'series4:reimage-once' || command === 'series4:resize-once' || command === 'series4:stuck-readiness-once' || command === 'series4:storage-usage-once' || command === 'series4:suspend-stop-once' || command === 'series4:suspend') {
    if (!supabase.ok) {
      writeJson(stderr, {
        status: 'blocked',
        missingVariables: supabase.missingVariables,
        missingSecrets: supabase.missingSecrets,
      });
      return 2;
    }

    try {
      const supabaseUrl = nonEmptyEnv(env, 'SUPABASE_URL');
      const serviceRoleKey = nonEmptyEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
      if (!supabaseUrl || !serviceRoleKey) throw new Error('supabase_service_role_config_missing');
      const client = createSupabaseServiceRoleRestClient({
        supabaseUrl,
        serviceRoleKey,
        fetchImpl: deps.fetchImpl,
      });
      const series4Store = createSeries4SupabaseLifecycleStore(client);

      if (command === 'series4:provision-once') {
        const result = await processNextSeries4FlyProvisioningJob({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' || result.status === 'reconcile_required' ? 1
          : result.status === 'blocked' ? 2
          : 0;
      }
      if (command === 'series4:grace-expiry-once') {
        const result = await processNextSeries4GraceExpiry({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:account-deletion-once') {
        const result = await processNextAccountDeletionRequest({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:reimage-once') {
        const result = await processNextCoworkerReimage({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:resize-once') {
        const result = await processNextSeries4RunnerResize({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:storage-usage-once') {
        const result = await processSeries4StorageUsageSweep({ env }, { store: series4Store });
        writeJson(stdout, result);
        // A per-user read failure is reported but does not fail the tick: the
        // sweep is best-effort telemetry and retries on the next run.
        return result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:suspend-stop-once') {
        const result = await processSeries4SuspendedRunnerStop({ env }, { store: series4Store });
        writeJson(stdout, result);
        // A per-user stop failure is reported but does not fail the tick: the
        // machine is retried on the next run and the grace-expiry job is the
        // backstop.
        return result.status === 'blocked' ? 2 : 0;
      }
      if (command === 'series4:stuck-readiness-once') {
        const result = await processNextSeries4StuckReadiness({ env }, { store: series4Store });
        writeJson(stdout, result);
        return result.status === 'failed' ? 1 : 0;
      }
      // series4:suspend
      const userId = nonEmptyArg(argv[1]) ?? nonEmptyEnv(env, 'SIDEKICK_SUSPEND_USER_ID');
      if (!userId) {
        writeJson(stderr, { status: 'failed', errorCode: 'suspend_user_id_required' });
        return 2;
      }
      const result = await processSeries4SubscriptionSuspension({ env, userId }, { store: series4Store });
      writeJson(stdout, result);
      return 0;
    } catch (error) {
      writeJson(stderr, { status: 'failed', errorCode: sanitizeCliErrorCode(error) });
      return 1;
    }
  }

  if (command === 'cleanup-test-runner') {
    const cleanupTarget = cleanupTargetFromArgs(argv, env);
    const cleanupMissingVariables = [
      ...(!cleanupTarget.userId ? ['SIDEKICK_CLEANUP_USER_ID'] : []),
      ...(!cleanupTarget.railwayProjectId ? ['SIDEKICK_CLEANUP_RAILWAY_PROJECT_ID'] : []),
      ...(env.SIDEKICK_ALLOW_RAILWAY_DELETE === 'true' ? [] : ['SIDEKICK_ALLOW_RAILWAY_DELETE']),
    ];
    const cleanupMissingSecrets = nonEmptyEnv(env, 'RAILWAY_API_TOKEN') ? [] : ['RAILWAY_API_TOKEN'];
    if (!supabase.ok || cleanupMissingVariables.length > 0 || cleanupMissingSecrets.length > 0) {
      writeJson(stderr, {
        status: 'blocked',
        missingVariables: [...supabase.missingVariables, ...cleanupMissingVariables],
        missingSecrets: [...supabase.missingSecrets, ...cleanupMissingSecrets],
      });
      return 2;
    }

    try {
      const store = createStore(env, deps);
      const result = await cleanupHermesTestRunner({
        userId: cleanupTarget.userId!,
        railwayProjectId: cleanupTarget.railwayProjectId!,
        railwayToken: nonEmptyEnv(env, 'RAILWAY_API_TOKEN')!,
        allowRailwayDelete: true,
        protectedRailwayProjectId: nonEmptyEnv(env, 'RAILWAY_PROJECT_ID'),
      }, {
        store,
        railway: deps.railway,
      });
      writeJson(stdout, result);
      return 0;
    } catch (error) {
      writeJson(stderr, { status: 'failed', errorCode: sanitizeCliErrorCode(error) });
      return 1;
    }
  }

  if (!supabase.ok) {
    writeJson(stderr, {
      status: 'blocked',
      missingVariables: supabase.missingVariables,
      missingSecrets: supabase.missingSecrets,
    });
    return 2;
  }

  try {
    const store = createStore(env, deps);
    if (command === 'readiness-once') {
      const domainDiscovery = await processNextHermesRunnerDomainDiscoveryJob({ env }, {
        store,
        railway: deps.railway,
      });
      if (domainDiscovery.status === 'domain_pending' || domainDiscovery.status === 'failed') {
        writeJson(stdout, domainDiscovery);
        return domainDiscovery.status === 'failed' ? 1 : 0;
      }

      const result = await processNextHermesRunnerReadinessCheck({}, {
        store,
        runnerHealth: deps.runnerHealth ?? createHermesRunnerHealthClient(),
      });
      writeJson(stdout, domainDiscovery.status === 'domain_found' && result.status === 'idle' ? domainDiscovery : result);
      return result.status === 'failed' ? 1 : 0;
    }

    const result = await processNextHermesProvisioningJob({ env }, {
      store,
      railway: deps.railway,
    });
    writeJson(stdout, result);
    return result.status === 'failed' || result.status === 'reconcile_required' ? 1 : 0;
  } catch (error) {
    writeJson(stderr, { status: 'failed', errorCode: sanitizeCliErrorCode(error) });
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runHermesProvisionerCli(process.argv.slice(2), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(JSON.stringify({ status: 'failed', errorCode: sanitizeCliErrorCode(error) }));
    process.exitCode = 1;
  });
}
