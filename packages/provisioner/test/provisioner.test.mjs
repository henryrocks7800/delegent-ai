import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HERMES_AGENT_RAILWAY_TEMPLATE,
  RAILWAY_GRAPHQL_ENDPOINT,
  RAILWAY_PROJECT_DELETE_MUTATION,
  RAILWAY_PROJECT_RUNNER_ENDPOINT_QUERY,
  RAILWAY_RUNNER_SERVICE_INSTANCE_REDEPLOY_MUTATION,
  RAILWAY_RUNNER_SERVICE_INSTANCE_UPDATE_MUTATION,
  RAILWAY_RUNNER_SERVICE_ENDPOINT_QUERY,
  RAILWAY_RUNNER_SERVICE_CONNECT_MUTATION,
  RAILWAY_RUNNER_VARIABLE_COLLECTION_UPSERT_MUTATION,
  RAILWAY_RUNNER_VOLUME_INSTANCE_UPDATE_MUTATION,
  RAILWAY_TEMPLATE_DEPLOY_V2_MUTATION,
  SIDEKICK_RUNNER_RUNTIME_BASE_IMAGE,
  buildHermesRunnerEnvironment,
  buildRailwayProvisioningPlan,
  buildRailwayTemplateDeployInput,
  cleanupHermesTestRunner,
  createHermesRunnerHealthClient,
  createRailwayGraphqlClient,
  createSupabaseServiceRoleRestClient,
  createSupabaseHermesProvisioningStore,
  createSeries4SupabaseLifecycleStore,
  preflightRailwayProvisioner,
  processNextHermesProvisioningJob,
  processNextHermesRunnerDomainDiscoveryJob,
  processNextHermesRunnerReadinessCheck,
  provisionHermesWorker,
} from '../dist/index.js';
import { runHermesProvisionerCli } from '../dist/cli.js';

const input = {
  userId: 'user_123',
  railwayToken: 'fixture_railway_token',
  railwayWorkspaceId: 'workspace_123',
  adminUsername: 'admin',
  adminPassword: 'fixture_admin_password',
  image: 'ghcr.io/sidekick/hermes-runner:latest',
  workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
  runnerSharedSecret: 'fixture_runner_secret',
  runnerServerUrl: 'https://your-project-ref.supabase.co/storage/v1/object/public/sidekick-runner-artifacts/hermes-runner-server-fixture.py',
  tierId: 'pro-office',
  agentName: 'Ruben',
};

function readAllSupabaseMigrations() {
  const migrationsDir = resolve('../../supabase/migrations');
  return readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => readFileSync(resolve(migrationsDir, entry), 'utf8'))
    .join('\n');
}

function latestFunctionDefinition(functionName) {
  const migrations = readAllSupabaseMigrations();
  const marker = `create or replace function public.${functionName}`;
  const start = migrations.lastIndexOf(marker);
  assert.notEqual(start, -1, `expected latest ${functionName} definition in Supabase migrations`);
  const bodyStart = migrations.indexOf('as $$', start);
  assert.notEqual(bodyStart, -1, `expected ${functionName} to use a dollar-quoted body`);
  const end = migrations.indexOf('$$;', bodyStart);
  assert.notEqual(end, -1, `expected ${functionName} body terminator`);
  return migrations.slice(start, end + '$$;'.length);
}

function localAdapterKey(secret = input.runnerSharedSecret) {
  return `sidekick-local.${createHmac('sha256', secret).update('sidekick-local-adapter:v1').digest('hex')}`;
}

test('Railway GraphQL client uses the public API endpoint accepted by account tokens', () => {
  assert.equal(RAILWAY_GRAPHQL_ENDPOINT, 'https://api.railway.app/graphql/v2');
});

test('Railway Hermes template metadata bootstraps the Sidekick runner from a public artifact without private GitHub access', () => {
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.code, 'hermes-agent-ai');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.id, '0aff3c95-d48f-45c0-9fb9-81d1324091db');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef, 'cc1c77a9-ba80-4ba2-834d-d280903ff225');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.sourceRepo, 'https://github.com/praveen-ks-2001/hermes-agent-template');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.sourceRootDirectory, null);
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.runnerServerUrlVariable, 'SIDEKICK_RUNNER_SERVER_URL');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.port, '8642');
  assert.equal(HERMES_AGENT_RAILWAY_TEMPLATE.volumeMountPath, '/data');
  assert.equal(SIDEKICK_RUNNER_RUNTIME_BASE_IMAGE, 'ghcr.io/astral-sh/uv:python3.12-bookworm-slim');
});

test('Hermes runner files fail closed instead of hiding install/startup failures', () => {
  const dockerfile = readFileSync(resolve('../../services/hermes-runner/Dockerfile'), 'utf8');
  const server = readFileSync(resolve('../../services/hermes-runner/server.py'), 'utf8');
  assert.match(dockerfile, /hermes-agent/i);
  assert.doesNotMatch(dockerfile, /\|\|\s*true/);
  assert.match(dockerfile, /EXPOSE 8642/);
  assert.doesNotMatch(dockerfile, /sh\s*,\s*["']-c/);
  assert.match(dockerfile, /--port", "8642/);
  assert.match(server, /\/v1\/chat\/completions/);
  assert.match(server, /x-sidekick-runner-token/);
  assert.match(server, /hermes/i);
});

test('Supabase claim and output RPCs avoid duplicate live Railway provisioning after a worker claim', () => {
  const migration = [
    readFileSync(resolve('../../supabase/migrations/0006_hermes_railway_provisioning_contract.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0009_hermes_runner_readiness_contract.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0011_provisioning_agent_name_command.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0016_fix_hermes_provisioning_claim_lock.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0017_hermes_test_runner_cleanup.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0019_reclaim_expired_hermes_provisioning_leases.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0020_hermes_runner_domain_discovery.sql'), 'utf8'),
  ].join('\n');
  assert.match(migration, /hi\.status = 'queued'/);
  assert.match(migration, /hi\.status = 'provisioning'[\s\S]*hi\.provisioning_lease_expires_at is not null[\s\S]*hi\.provisioning_lease_expires_at <= p_claimed_at/);
  assert.match(migration, /and not exists \([\s\S]*public\.hermes_instance_private hp[\s\S]*hp\.railway_project_id is not null[\s\S]*hp\.railway_workflow_id is not null[\s\S]*hp\.runner_base_url is not null/);
  assert.match(migration, /for update of hi skip locked/);
  assert.doesNotMatch(migration, /left join public\.profiles p on p\.id = hi\.user_id[\s\S]{0,600}for update skip locked/);
  assert.match(migration, /create or replace function public\.record_hermes_provisioning_output/);
  assert.match(migration, /p_runner_base_url text/);
  assert.match(migration, /p_runner_shared_secret text/);
  assert.match(migration, /runner_shared_secret/);
  assert.match(migration, /locked\.status <> 'provisioning'[\s\S]*locked\.provisioning_idempotency_key is distinct from p_idempotency_key[\s\S]*locked\.provisioning_claimed_at is distinct from p_claimed_at/);
  assert.match(migration, /insert into public\.hermes_instance_private[\s\S]*runner_base_url,[\s\S]*runner_shared_secret[\s\S]*on conflict \(user_id\) do update/);
  assert.match(migration, /revoke all on function public\.claim_next_hermes_provisioning_job/);
  assert.match(migration, /grant execute on function public\.claim_next_hermes_provisioning_job\(timestamptz, integer\) to service_role/);
  assert.match(migration, /returns table\(user_id uuid, tier_id text, idempotency_key text, claimed_at timestamptz, agent_name text\)/);
  assert.match(migration, /left join public\.profiles p on p\.id = hi\.user_id/);
  assert.match(migration, /coalesce\(nullif\(btrim\(p\.agent_name\), ''\), 'Ruben'\) as agent_name/);
  assert.match(migration, /revoke all on function public\.record_hermes_provisioning_output/);
  assert.match(migration, /create or replace function public\.verify_hermes_test_runner_cleanup_target/);
  assert.match(migration, /create or replace function public\.cleanup_hermes_test_runner/);
  assert.match(migration, /hp\.railway_project_id = btrim\(p_railway_project_id\)/);
  assert.match(migration, /project_deleted', true/);
  assert.match(migration, /revoke all on function public\.verify_hermes_test_runner_cleanup_target\(uuid, text\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.verify_hermes_test_runner_cleanup_target\(uuid, text\) to service_role/);
  assert.match(migration, /revoke all on function public\.cleanup_hermes_test_runner\(uuid, text, timestamptz\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.cleanup_hermes_test_runner\(uuid, text, timestamptz\) to service_role/);
  assert.match(migration, /create or replace function public\.claim_next_hermes_runner_domain_discovery/);
  assert.match(migration, /nullif\(btrim\(hp\.runner_base_url\), ''\) is null/);
  assert.match(migration, /create or replace function public\.record_hermes_runner_domain_discovered/);
  assert.match(migration, /runner_base_url = btrim\(p_runner_base_url\)/);
  assert.match(migration, /hi\.last_health_at is null[\s\S]*or hi\.updated_at is null[\s\S]*or hi\.updated_at <= now\(\) - make_interval\(secs => 60\)/);
  assert.match(migration, /grant execute on function public\.claim_next_hermes_runner_domain_discovery\(timestamptz, integer\) to service_role/);
  assert.match(migration, /grant execute on function public\.record_hermes_runner_domain_discovered\(uuid, text, text, timestamptz, text, text, timestamptz\) to service_role/);
  const provisioningOutputSignature = 'uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, int, timestamptz';
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.record_hermes_provisioning_output\\(${provisioningOutputSignature}\\) from public, anon, authenticated`),
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.record_hermes_provisioning_output\\(${provisioningOutputSignature}\\) to service_role`),
  );
});

test('latest workspace provisioning/readiness claims keep trial and payment-grace users moving', () => {
  const latestProvisioningClaim = readFileSync(resolve('../../supabase/migrations/0019_reclaim_expired_hermes_provisioning_leases.sql'), 'utf8');
  const latestDomainAndReadinessClaims = readFileSync(resolve('../../supabase/migrations/0020_hermes_runner_domain_discovery.sql'), 'utf8');
  const entitlementClause = /coalesce\(s\.status, 'inactive'\) in \('active', 'trialing', 'past_due'\)/;
  const entitlementClauseGlobal = new RegExp(entitlementClause.source, 'g');

  assert.match(
    latestProvisioningClaim,
    entitlementClause,
    'newly-paid trial/payment-grace users must be claimable for initial workspace provisioning',
  );
  assert.doesNotMatch(
    latestProvisioningClaim,
    /coalesce\(s\.status, 'inactive'\) = 'active'/,
    'latest provisioning claim must not strand trialing or payment-grace users behind an active-only gate',
  );

  const lifecycleEntitlementClauses = latestDomainAndReadinessClaims.match(entitlementClauseGlobal) ?? [];
  assert.equal(
    lifecycleEntitlementClauses.length,
    2,
    'domain discovery and readiness health-check claims must both keep entitled trial/payment-grace workspaces moving',
  );
  assert.doesNotMatch(
    latestDomainAndReadinessClaims,
    /coalesce\(s\.status, 'inactive'\) = 'active'/,
    'latest domain/readiness claims must not regress to active-only entitlement',
  );
});

test('latest workspace provisioning claim ignores deleted private bindings but still blocks live bindings', () => {
  const definition = latestFunctionDefinition('claim_next_hermes_provisioning_job');

  assert.match(
    definition,
    /from public\.hermes_instance_private hp[\s\S]*where hp\.user_id = hi\.user_id[\s\S]*hp\.deleted_at is null[\s\S]*and \(/,
    'deleted private bindings are audit rows and must not strand a fresh paid Fly provisioning job',
  );
  assert.match(definition, /hp\.railway_project_id is not null/);
  assert.match(definition, /hp\.railway_workflow_id is not null/);
  assert.match(definition, /hp\.runner_base_url is not null/);
  assert.match(definition, /hp\.fly_app_name is not null/);
  assert.match(definition, /hp\.fly_machine_id is not null/);
  assert.match(definition, /hp\.fly_volume_id is not null/);
});

test('Supabase readiness RPCs mark workers ready only after private runner health and stay service-role-only', () => {
  const migration = [
    readFileSync(resolve('../../supabase/migrations/0009_hermes_runner_readiness_contract.sql'), 'utf8'),
    readFileSync(resolve('../../supabase/migrations/0020_hermes_runner_domain_discovery.sql'), 'utf8'),
  ].join('\n');
  assert.match(migration, /alter table public\.hermes_instance_private add column if not exists runner_shared_secret text/);
  assert.match(migration, /create or replace function public\.claim_next_hermes_readiness_check/);
  assert.match(migration, /create or replace function public\.record_hermes_runner_ready/);
  assert.match(migration, /from public\.hermes_instance_private hp/);
  assert.match(migration, /hp\.runner_base_url is not null/);
  assert.match(migration, /hp\.runner_shared_secret is not null/);
  assert.match(migration, /runner_shared_secret/);
  assert.match(migration, /claimed_at/);
  assert.match(migration, /hi\.updated_at = p_claimed_at/);
  assert.match(migration, /status in \('provisioning', 'ready', 'degraded'\)/);
  assert.match(migration, /last_health_at is null[\s\S]*last_health_at <= now\(\) - make_interval\(secs => greatest\(60, p_stale_after_seconds\)\)/);
  assert.match(migration, /hp\.runner_base_url = p_runner_base_url/);
  assert.match(migration, /status = 'ready'/);
  assert.match(migration, /last_health_at = p_checked_at/);
  assert.match(migration, /ready_at = coalesce\(ready_at, p_checked_at\)/);
  // SQL migration 0009 was authored under the historical brand and is kept
  // verbatim in version control (see tests/e2e/brand-strings-scan.test.mjs
  // allowlist). At runtime the same status message is produced by
  // packages/provisioner/src/index.ts under the new brand. This assertion
  // pins the SQL string as the migration originally shipped.
  assert.match(migration, /Coworker AI is online\./);
  assert.doesNotMatch(migration, /runner_base_url[\s\S]{0,200}grant select/i);
  assert.match(migration, /revoke all on function public\.claim_next_hermes_readiness_check/);
  assert.match(migration, /grant execute on function public\.claim_next_hermes_readiness_check\(integer\) to service_role/);
  assert.match(migration, /revoke all on function public\.record_hermes_runner_ready/);
  assert.match(migration, /grant execute on function public\.record_hermes_runner_ready\(uuid, text, timestamptz, timestamptz\) to service_role/);
});

test('provisioning plan is idempotent, Hermes-backed, template-based, and redacts secrets', () => {
  const plan = buildRailwayProvisioningPlan(input);

  assert.equal(plan.engine, 'hermes-agent');
  assert.equal(plan.deploymentMode, 'railway-template');
  assert.equal(plan.idempotencyKey, 'sidekick-user-user_123');
  assert.equal(plan.persistentVolumeGb, 40);
  assert.equal(plan.serviceImage, 'ghcr.io/sidekick/hermes-runner:latest');
  assert.equal(plan.template.id, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(plan.templateDeployInput.templateId, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(plan.templateDeployInput.workspaceId, 'workspace_123');

  const service = plan.templateDeployInput.serializedConfig.services[HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef];
  assert.equal(service.source.repo, HERMES_AGENT_RAILWAY_TEMPLATE.sourceRepo);
  assert.equal(service.source.rootDirectory, HERMES_AGENT_RAILWAY_TEMPLATE.sourceRootDirectory);
  assert.equal(service.source.rootDirectory, null);
  assert.match(service.deploy.startCommand, /SIDEKICK_RUNNER_SERVER_URL/);
  assert.match(service.deploy.startCommand, /fastapi==0\.115\.6/);
  assert.match(service.deploy.startCommand, /uvicorn\[standard\]==0\.34\.0/);
  assert.match(service.deploy.startCommand, /git clone --depth 1 --branch v2026\.5\.7 https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
  assert.match(service.deploy.startCommand, /exec python \/tmp\/sidekick-runner-server\.py/);
  assert.deepEqual(service.deploy.preDeployCommand, ['/bin/true']);
  assert.equal(service.deploy.healthcheckPath, '/healthz');
  assert.equal(service.variables.PORT.defaultValue, '8642');
  assert.equal(service.variables.HERMES_HOME.defaultValue, '/data/hermes');
  assert.equal(service.variables.SIDEKICK_ALLOW_UNSIGNED_HEALTH.defaultValue, 'true');
  assert.equal(service.variables.SIDEKICK_RUNNER_SERVER_URL.defaultValue, input.runnerServerUrl);
  assert.equal(service.variables.ADMIN_USERNAME.defaultValue, 'admin');
  assert.equal(service.variables.ADMIN_PASSWORD.defaultValue, '[REDACTED]');
  assert.equal(service.variables.SIDEKICK_WORKER_PROXY_URL.defaultValue, 'https://worker.sidekick.dev/v1/chat/completions');
  assert.equal(service.variables.SIDEKICK_RUNNER_SHARED_SECRET.defaultValue, '[REDACTED]');
  assert.equal(service.variables.OPENAI_API_KEY.defaultValue, '[REDACTED]');
  assert.equal(service.variables.HERMES_API_KEY.defaultValue, '[REDACTED]');
  assert.equal(service.variables.CUSTOM_BASE_URL.defaultValue, 'http://127.0.0.1:8642/v1');
  assert.equal(service.variables.OPENAI_BASE_URL.defaultValue, 'http://127.0.0.1:8642/v1');
  assert.equal('OPENROUTER_API_KEY' in service.variables, false);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in service.variables, false);
  assert.equal(service.volumeMounts[HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef].mountPath, '/data');
  assert.deepEqual(service.networking.serviceDomains['<hasDomain>'], {});

  const text = JSON.stringify(plan);
  assert.equal(text.includes('fixture_railway_token'), false);
  assert.equal(text.includes('fixture_admin_password'), false);
  assert.equal(text.includes('fixture_runner_secret'), false);
});

test('actual Railway template deploy input includes only the deploy-time admin password, not the Railway API token', () => {
  const deployInput = buildRailwayTemplateDeployInput(input, { includeSecrets: true });
  const service = deployInput.serializedConfig.services[HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef];

  assert.equal(deployInput.templateId, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(service.variables.ADMIN_PASSWORD.defaultValue, 'fixture_admin_password');
  assert.equal(service.variables.SIDEKICK_RUNNER_SHARED_SECRET.defaultValue, 'fixture_runner_secret');
  assert.equal(service.variables.SIDEKICK_WORKER_PROXY_URL.defaultValue, 'https://worker.sidekick.dev/v1/chat/completions');
  assert.equal(service.variables.SIDEKICK_RUNNER_SERVER_URL.defaultValue, input.runnerServerUrl);
  assert.equal(service.variables.SIDEKICK_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(service.variables.HERMES_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(service.variables.OPENAI_API_KEY.defaultValue, localAdapterKey());
  assert.equal(service.variables.HERMES_API_KEY.defaultValue, localAdapterKey());
  assert.equal(service.variables.OPENAI_API_KEY.defaultValue === 'fixture_runner_secret', false);
  assert.equal('OPENROUTER_API_KEY' in service.variables, false);
  assert.equal(JSON.stringify(deployInput).includes('fixture_railway_token'), false);
  assert.match(RAILWAY_TEMPLATE_DEPLOY_V2_MUTATION, /templateDeployV2/);
  assert.match(RAILWAY_TEMPLATE_DEPLOY_V2_MUTATION, /TemplateDeployV2Input/);
});

test('runner environment derives safe toolsets from the verified product tier and routes Hermes through the local Worker-signing adapter', () => {
  const studio = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: '  Ruben\n  Assistant  ',
  });

  // Split the assertion into:
  //   (a) the static infra-and-tier env we can deepEqual cleanly,
  //   (b) the Delegent personality knobs which have a long template + agent-name
  //       interpolation — those are asserted by the dedicated personality tests
  //       below (system prompt / wake message / example prompts / static knobs).
  const {
    HERMES_SYSTEM_PROMPT: _systemPrompt,
    HERMES_WAKE_MESSAGE: _wakeMessage,
    HERMES_EXAMPLE_PROMPTS: _examplePrompts,
    HERMES_TURN_VERBOSITY: turnVerbosity,
    HERMES_EMOJI_LEVEL: emojiLevel,
    HERMES_GREETING_TONE: greetingTone,
    HERMES_TOOL_APPROVAL: toolApproval,
    HERMES_MEMORY_ENABLED: memoryEnabled,
    ...staticEnv
  } = studio;

  assert.deepEqual(staticEnv, {
    PORT: '8642',
    HERMES_HOME: '/data/hermes',
    SIDEKICK_USER_ID: 'user_123',
    SIDEKICK_TIER_ID: 'studio',
    SIDEKICK_AGENT_NAME: 'Ruben Assistant',
    HERMES_AGENT_NAME: 'Ruben Assistant',
    SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.dev/v1/chat/completions',
    SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
    SIDEKICK_ALLOW_UNSIGNED_HEALTH: 'true',
    // Capability parity (2026-05-30): toolsets are no longer tier-gated. Every
    // plan gets the full Hermes toolset out of the box; tiers differ only by
    // compute (server size) + monthly token allowance, never by capability.
    // 2026-06-10: session_search removed (the gateway path keeps no resumable
    // sessions, so it always returned empty and made the agent deny real chat
    // history). The volume-backed `memory` toolset stays for durable recall.
    HERMES_TOOLSETS: 'file,web,search,terminal,process,browser,code_execution,memory,cronjob,vision,todo,clarify,delegate_task,skills,debugging',
    HERMES_MODEL_PROVIDER: 'custom',
    HERMES_MODEL: 'openai/gpt-6-luna',
    HERMES_MODEL_BASE_URL: 'http://127.0.0.1:8642/v1',
    CUSTOM_BASE_URL: 'http://127.0.0.1:8642/v1',
    OPENAI_BASE_URL: 'http://127.0.0.1:8642/v1',
    OPENAI_API_KEY: localAdapterKey(),
    HERMES_API_KEY: localAdapterKey(),
    DELEGENT_SKILLS_DIR: '/opt/delegent/skills',
    // R-INT-04 / R-AGENT-34 — per-user inbound agent email surfaced via
    // env. Derived from userId so the same user gets a stable address
    // across re-provisions; format documented in
    // buildDelegentAgentInboundEmail (packages/provisioner/src/index.ts).
    HERMES_AGENT_EMAIL: 'user_123@agent.delegentai.co.uk',
  });

  // Personality static knobs (per HERMES_PERSONALITY_AND_OPENING.md §6.2 recommendations).
  assert.equal(turnVerbosity, 'balanced');
  assert.equal(emojiLevel, 'natural');
  assert.equal(greetingTone, 'warm');
  assert.equal(toolApproval, 'auto');
  assert.equal(memoryEnabled, 'true');

  const text = JSON.stringify(studio);
  assert.equal(text.includes('OPENROUTER_API_KEY'), false);
  assert.equal(text.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
  assert.equal(text.includes('or_test_secret'), false);

  assert.throws(() => buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: '',
    tierId: 'studio',
  }), /runnerSharedSecret required/);

  // normalizeToolsets still rejects toolsets outside the allowed set (defence in
  // depth against a caller requesting something the image cannot honour).
  // `terminal` is now allowed for every tier, so we assert with a
  // genuinely-unknown toolset to keep the negative-path coverage.
  assert.throws(() => buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    allowedToolsets: ['definitely-not-a-real-toolset'],
  }), /toolset not allowed/);
});

test('Delegent system prompt interpolates the agent name in first-person voice', () => {
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  // Agent name appears (in the opening "You are X" line AND in the
  // infrastructure-leak-guard paragraph as "you are simply X").
  assert.match(prompt, /^You are Atlas,/);
  assert.match(prompt, /You are simply Atlas\./);
  // Brand name "Delegent AI" appears exactly once (no keyword-stuffing).
  const brandHits = (prompt.match(/Delegent AI/g) ?? []).length;
  assert.equal(brandHits, 1, `expected exactly one "Delegent AI" mention, got ${brandHits}`);
});

test('Delegent system prompt mandates verify-before-claim for file work (2026-07-22)', () => {
  // Live incident: the agent told the user a script was "built and ready"
  // that never existed, and reported "5 test files created" when two were
  // never written and one filename was garbled in the actual tool call. The
  // prompt must force an ls-verify after file writes and forbid claiming a
  // file exists (including from an earlier conversation) without checking.
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  assert.match(prompt, /run one ls over the exact paths/, 'must mandate an ls verification after creating files');
  assert.match(prompt, /copying each file name from the ls output/, 'must pin names to the verified listing (garbled-name guard)');
  assert.match(prompt, /which files exist and which do not/, 'must demand honest partial-failure reporting');
  assert.match(prompt, /in this turn or from an earlier conversation, unless you have verified it exists right now/, 'must cover stale claims remembered from prior chats');
});

test('Delegent system prompt forbids declaring a tool broken without a fresh attempt (2026-07-22)', () => {
  // Live incident: web_search failed at 16:20, was FIXED, and at 17:13 the
  // agent told the user "search is down" from session memory without even
  // attempting the tool. The durable session makes learned defeatism sticky,
  // so the prompt must force a fresh attempt each turn before any
  // "unavailable" claim, and mark saved broken-capability notes as stale.
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  assert.match(prompt, /Attempt the tool fresh in THIS turn first/, 'must mandate a fresh attempt before an unavailable claim');
  assert.match(prompt, /based on a failure from an earlier turn or conversation/, 'must name the stale-failure trap');
  assert.match(prompt, /treat it as stale until retested/, 'saved broken-capability notes must be treated as stale');
});

test('Delegent system prompt gives safe script/automation guidance (Dan-testing lessons, 2026-07-22)', () => {
  // Harvested from a tester's real inbox-monitor build: hardcoded live
  // credentials, an auto-send loop that duplicated emails, a self-installed
  // CLI that vanished on restart, swallowed errors, and UTC times. These are
  // GENERIC safety rules (no property/landlord/Dan specifics leak in).
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  assert.match(prompt, /NEVER hardcode a password, API key, token or app password into a script/, 'creds must go to the vault, never inline');
  assert.match(prompt, /prefer Python's standard library and tools already installed/, 'unattended jobs prefer stdlib/baked tools over self-installed binaries');
  assert.match(prompt, /let real errors surface \(log and raise\) rather than swallowing them/, 'fail-loud persistence');
  assert.match(prompt, /set the user's timezone explicitly at the top/, 'time-displaying scripts must set local tz, not raw UTC');
  assert.match(prompt, /default to draft-and-notify/, 'scheduled outward actions never auto-send');
  // Must NOT leak the tester's specifics into every user's prompt.
  assert.doesNotMatch(prompt, /Gran Terreno|granterreno|landlord|tenancy|boiler/i, 'no tester-specific use case in the shared prompt');
});

test('Delegent system prompt forbids em-dashes both as instruction and by example', () => {
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  // The prompt must instruct the model not to use em-dashes.
  assert.match(prompt, /em-dash/i);
  // And the prompt itself must contain ZERO U+2014 characters, leading by example.
  assert.equal(prompt.includes('—'), false, 'system prompt must not contain any U+2014 em-dash characters');
});

test('Delegent system prompt blocks every infrastructure leak by abstract category (no literal infra word)', () => {
  // Updated 2026-05-21 for R-STYLE-02: the forensic spec demands the
  // prompt contain ZERO literal banned words (OpenRouter, Cloudflare,
  // Supabase, Fly, Hermes, runners) because anything in the system
  // prompt is what the LLM sees and is most likely to echo back. The
  // boundary text now names the categories abstractly (the hosting
  // provider, the model gateway, the database, the per-user compute,
  // the agent runtime) so the agent still knows what NOT to expose
  // without us putting the exact strings in front of it.
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const prompt = env.HERMES_SYSTEM_PROMPT;
  // Negative: no literal banned word.
  for (const banned of ['OpenRouter', 'Cloudflare', 'Supabase', 'Fly', 'Hermes', 'runners', 'container', 'machine']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`, 'i').test(prompt), `system prompt MUST NOT contain banned word "${banned}"`);
  }
  // Positive: the prompt does have a leak-guard guidance that names the abstract categories.
  for (const phrase of ['hosting provider', 'model gateway', 'database', 'per-user compute', 'agent runtime']) {
    assert.ok(prompt.toLowerCase().includes(phrase), `system prompt must reference abstract category "${phrase}" so the agent knows the leak surface`);
  }
});

test('Delegent wake message greets by name and leads with connecting a service', () => {
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Nova',
  });
  const wake = env.HERMES_WAKE_MESSAGE;
  assert.match(wake, /^Hi, I'm Nova\./);
  // 2026-09-03 (Alex): the first thing a new user sees must push them at a
  // CONNECTION. Everything this product does well gets better the moment it can
  // see their real inbox, files or numbers, and the old version offered five
  // generic prompts written before Connections existed.
  assert.ok(wake.includes('Connections'), 'the wake message must name the Connections screen');
  for (const service of ['Gmail', 'Outlook', 'Google Drive', 'Google Calendar']) {
    assert.ok(wake.includes(service), `wake message should name ${service} as an obvious first connection`);
  }
  // A named service beats a category: "open Connections" is an instruction,
  // "Gmail or Outlook" is a decision they can make in a second.
  for (const marker of ['📧', '📁', '📅', '💷']) {
    assert.ok(wake.includes(marker), `wake message missing emoji "${marker}"`);
  }
  // It must still degrade gracefully for someone who connects nothing on day one.
  assert.ok(wake.includes('Nothing connected yet?'), 'the wake message must still give a job to someone with no connections');
  // Never advertise gateway internals. A new user's SECOND message was once
  // "/help shows the available commands", which dumped Hermes internals.
  assert.equal(/\/help|\/new|\/compress/.test(wake), false, 'the wake message must never mention a slash command');
  // Avoid the "How can I assist you" chatbot trope.
  assert.equal(/how can i assist you/i.test(wake), false);
  // Wake message must also be em-dash-free.
  assert.equal(wake.includes('—'), false);
});

test('Delegent example prompts env value joins the full 10-prompt set newline-delimited', () => {
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const lines = env.HERMES_EXAMPLE_PROMPTS.split('\n');
  assert.equal(lines.length, 10);
  // Spot-check the first and last to confirm ordering matches docs/FIRST_RUN_AND_WEBSITE_MOBILE_AUDIT.md §6.5.
  assert.match(lines[0], /^Summarise this PDF/);
  assert.match(lines[9], /^Save the last thing/);
  // 2026-09-03: half the set predated Connections. The replacements are the
  // asks that only work BECAUSE something is connected, which is the point.
  const joined = lines.join('\n');
  for (const connectionLed of ['Read my emails', 'calendar this week', 'saved in Drive', 'came in on Stripe']) {
    assert.ok(joined.includes(connectionLed), `example prompts should include the connection-led ask "${connectionLed}"`);
  }
});

test('Delegent personality knobs do not leak any server secret into the env value', () => {
  const env = buildHermesRunnerEnvironment({
    userId: 'user_123',
    workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'studio',
    agentName: 'Atlas',
  });
  const personalityPayload = [
    env.HERMES_SYSTEM_PROMPT,
    env.HERMES_WAKE_MESSAGE,
    env.HERMES_EXAMPLE_PROMPTS,
  ].join('\n');
  // Stripe / OpenAI / Supabase / Fly / GitHub / Telegram secret SHAPES must not appear.
  for (const shape of [/sk_live_/, /sk_test_/, /sk-or-/, /sk-/, /whsec_/, /fo1_/, /fo2_/, /sbp_/, /ghp_/, /eyJ[A-Za-z0-9-_]+\./]) {
    assert.equal(shape.test(personalityPayload), false, `personality env value must not contain secret-shaped string matching ${shape}`);
  }
  // Hardcoded sample-secret strings must not appear either.
  for (const literal of ['or_test_secret', 'fixture_runner_secret']) {
    assert.equal(personalityPayload.includes(literal), false, `personality env value leaked literal "${literal}"`);
  }
});

test('provisioner validates server-owned infrastructure inputs', () => {
  // Image allow-list: only canonical Sidekick registries are accepted when a custom image is provided.
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, image: 'evil.example.com/other:latest' }), /Sidekick Hermes runner image/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, image: 'evil.example.com/sidekick/hermes-runner-fake:latest' }), /Sidekick Hermes runner image/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, image: 'ghcr.io/attacker-sidekick/hermes-runner:latest' }), /Sidekick Hermes runner image/);

  // Worker proxy URL guarantees: HTTPS only, no embedded credentials, suffix allow-list.
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'http://worker.sidekick.dev/v1/chat/completions' }), /HTTPS/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://example.com/v1/chat/completions' }), /Sidekick-owned/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://evil.sidekick.attacker.com/v1/chat/completions' }), /Sidekick-owned/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://sidekick.evil.com/v1/chat/completions' }), /Sidekick-owned/);
  assert.throws(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://user:pass@worker.sidekick.dev/v1/chat/completions' }), /credentials/);

  assert.doesNotThrow(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions' }));
  assert.doesNotThrow(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://worker.sidekick.app/v1/chat/completions' }));
  assert.doesNotThrow(() => buildRailwayProvisioningPlan({ ...input, workerProxyUrl: 'https://sidekick-worker.acme.workers.dev/v1/chat/completions' }));
});

test('Railway preflight is fail-closed and reports names without leaking secret values', () => {
  const missing = preflightRailwayProvisioner({
    env: {
      RAILWAY_API_TOKEN: '',
      RAILWAY_WORKSPACE_ID: '',
      SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
    },
    image: input.image,
    workerProxyUrl: input.workerProxyUrl,
    runnerServerUrl: input.runnerServerUrl,
    tierId: 'pro-office',
  });

  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingSecrets, ['RAILWAY_API_TOKEN', 'HERMES_ADMIN_PASSWORD']);
  assert.deepEqual(missing.missingVariables, ['RAILWAY_WORKSPACE_ID']);
  const missingRailwayTarget = missing.checks.find((check) => check.id === 'railway-target');
  assert.ok(missingRailwayTarget);
  assert.deepEqual(missingRailwayTarget.missingNames, ['RAILWAY_WORKSPACE_ID']);
  assert.equal(missing.checks.some((check) => check.id === 'railway-template-contract' && check.ok), true);
  assert.doesNotMatch(JSON.stringify(missing), /fixture_runner_secret|fixture_railway_token/i);

  const missingTargetAndProxy = preflightRailwayProvisioner({
    env: {
      RAILWAY_API_TOKEN: '',
      RAILWAY_WORKSPACE_ID: '',
      HERMES_ADMIN_PASSWORD: '',
    },
    image: input.image,
    runnerServerUrl: input.runnerServerUrl,
    tierId: 'pro-office',
  });
  const missingTargetAndProxyRailwayCheck = missingTargetAndProxy.checks.find((check) => check.id === 'railway-target');
  assert.ok(missingTargetAndProxyRailwayCheck);
  assert.deepEqual(missingTargetAndProxy.missingVariables, ['RAILWAY_WORKSPACE_ID', 'SIDEKICK_WORKER_PROXY_URL']);
  assert.deepEqual(missingTargetAndProxyRailwayCheck.missingNames, ['RAILWAY_WORKSPACE_ID']);

  const missingRunnerArtifact = preflightRailwayProvisioner({
    env: {
      RAILWAY_API_TOKEN: 'fixture_railway_token',
      RAILWAY_WORKSPACE_ID: 'workspace_123',
      HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
      SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
      SIDEKICK_WORKER_PROXY_URL: input.workerProxyUrl,
    },
    image: input.image,
    workerProxyUrl: input.workerProxyUrl,
    runnerSharedSecret: 'fixture_runner_secret',
    tierId: 'pro-office',
  });
  assert.equal(missingRunnerArtifact.ok, false);
  assert.equal(missingRunnerArtifact.missingVariables.includes('SIDEKICK_RUNNER_SERVER_URL'), true);
  const missingArtifactCheck = missingRunnerArtifact.checks.find((check) => check.id === 'runner-artifact');
  assert.ok(missingArtifactCheck);
  assert.deepEqual(missingArtifactCheck.missingNames, ['SIDEKICK_RUNNER_SERVER_URL']);

  const readyDryRun = preflightRailwayProvisioner({
    env: {
      RAILWAY_API_TOKEN: 'fixture_railway_token',
      RAILWAY_WORKSPACE_ID: 'workspace_123',
      HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
      SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
      SIDEKICK_WORKER_PROXY_URL: input.workerProxyUrl,
      SIDEKICK_RUNNER_SERVER_URL: input.runnerServerUrl,
    },
    image: input.image,
    workerProxyUrl: input.workerProxyUrl,
    runnerSharedSecret: 'fixture_runner_secret',
    runnerServerUrl: input.runnerServerUrl,
    tierId: 'pro-office',
  });

  assert.equal(readyDryRun.ok, true);
  assert.deepEqual(readyDryRun.missingSecrets, []);
  assert.deepEqual(readyDryRun.missingVariables, []);
  assert.doesNotMatch(JSON.stringify(readyDryRun), /fixture_runner_secret|fixture_railway_token|fixture_admin_password/i);

  const missingRunnerSecret = preflightRailwayProvisioner({
    env: {
      RAILWAY_API_TOKEN: 'fixture_railway_token',
      RAILWAY_WORKSPACE_ID: 'workspace_123',
      HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
      SIDEKICK_WORKER_PROXY_URL: input.workerProxyUrl,
      SIDEKICK_RUNNER_SERVER_URL: input.runnerServerUrl,
    },
    image: input.image,
    workerProxyUrl: input.workerProxyUrl,
    runnerServerUrl: input.runnerServerUrl,
    tierId: 'pro-office',
  });
  assert.equal(missingRunnerSecret.ok, false);
  assert.equal(missingRunnerSecret.missingSecrets.includes('SIDEKICK_RUNNER_SHARED_SECRET'), true);
  assert.deepEqual(missingRunnerSecret.missingVariables, []);
  assert.doesNotMatch(JSON.stringify(missingRunnerSecret), /fixture_railway_token|fixture_admin_password/i);
});

test('provisioner calls Railway templateDeployV2 and never returns placeholder infrastructure IDs', async () => {
  const calls = [];
  const result = await provisionHermesWorker(input, {
    railway: {
      async templateDeployV2(deployInput, railwayToken) {
        calls.push({ deployInput, railwayToken });
        return {
          projectId: 'project_live_from_railway',
          workflowId: 'workflow_live_from_railway',
          runnerBaseUrl: 'https://runner.sidekick.dev',
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].railwayToken, 'fixture_railway_token');
  assert.equal(calls[0].deployInput.templateId, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(result.status, 'provisioning');
  assert.equal(result.railwayProjectId, 'project_live_from_railway');
  assert.equal(result.railwayWorkflowId, 'workflow_live_from_railway');
  assert.equal(result.runnerBaseUrl, 'https://runner.sidekick.dev');
  assert.equal(result.runnerSharedSecret, 'fixture_runner_secret');
  assert.equal(result.templateId, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.doesNotMatch(JSON.stringify(result), /fixture_railway_token|fixture_admin_password/i);

  await assert.rejects(() => provisionHermesWorker({
    ...input,
    railwayToken: '',
  }, { railway: calls[0] }), /railwayToken required/);

  await assert.rejects(() => provisionHermesWorker({
    ...input,
    adminPassword: '',
  }, { railway: calls[0] }), /adminPassword required/);
});

test('Railway GraphQL client returns a sanitized provider error code without leaking tokens', async () => {
  const client = createRailwayGraphqlClient({
    async fetchImpl(_url, init) {
      assert.equal(init.headers.authorization, 'Bearer fixture_railway_token');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            errors: [{
              message: 'Free plan resource provision limit exceeded. Please upgrade to provision more resources!',
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            }],
          };
        },
      };
    },
  });

  await assert.rejects(
    () => client.templateDeployV2(buildRailwayTemplateDeployInput(input, { includeSecrets: false }), 'fixture_railway_token'),
    /railway_free_plan_resource_provision_limit_exceeded_please_upgrade_to_provision_/,
  );
});

test('Railway GraphQL client deletes a verified test project without leaking tokens', async () => {
  const client = createRailwayGraphqlClient({
    async fetchImpl(url, init) {
      assert.equal(url, RAILWAY_GRAPHQL_ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer fixture_railway_token');
      const body = JSON.parse(init.body);
      assert.match(body.query, /projectDelete/);
      assert.deepEqual(body.variables, { id: 'project_live_from_railway' });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { projectDelete: true } };
        },
      };
    },
  });

  assert.match(RAILWAY_PROJECT_DELETE_MUTATION, /projectDelete/);
  assert.equal(await client.projectDelete('project_live_from_railway', 'fixture_railway_token'), true);
});

test('Railway GraphQL client discovers the generated Hermes service domain after template deploy', async () => {
  const fetches = [];
  const client = createRailwayGraphqlClient({
    async fetchImpl(url, init) {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      assert.equal(init.headers.authorization, 'Bearer fixture_railway_token');
      const body = JSON.parse(init.body);
      if (body.query === RAILWAY_PROJECT_RUNNER_ENDPOINT_QUERY) {
        assert.deepEqual(body.variables, { projectId: 'project_live_from_railway' });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                project: {
                  services: { edges: [{ node: { id: 'service_live', name: 'Hermes Agent', templateServiceId: HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef } }] },
                  environments: { edges: [{ node: { id: 'env_live', name: 'production' } }] },
                  volumes: { edges: [{ node: { id: 'volume_live', name: 'hermes-agent-volume' } }] },
                },
              },
            };
          },
        };
      }
      assert.equal(body.query, RAILWAY_RUNNER_SERVICE_ENDPOINT_QUERY);
      assert.deepEqual(body.variables, { projectId: 'project_live_from_railway', serviceId: 'service_live', environmentId: 'env_live' });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              domains: {
                serviceDomains: [{ domain: 'hermes-agent-production-a0b2.up.railway.app', syncStatus: 'ACTIVE', targetPort: null }],
                customDomains: [],
              },
              serviceInstance: {
                latestDeployment: { status: 'SUCCESS', staticUrl: 'hermes-agent-production-a0b2.up.railway.app', url: null },
                activeDeployments: [],
              },
            },
          };
        },
      };
    },
  });

  const result = await client.discoverHermesRunnerEndpoint('project_live_from_railway', 'fixture_railway_token');
  assert.deepEqual(result, {
    projectId: 'project_live_from_railway',
    environmentId: 'env_live',
    serviceId: 'service_live',
    volumeId: 'volume_live',
    runnerBaseUrl: 'https://hermes-agent-production-a0b2.up.railway.app',
    deploymentStatus: 'SUCCESS',
  });
  assert.equal(fetches.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /fixture_railway_token/i);
});

test('Railway GraphQL client patches the generated service instance before redeploying the Sidekick runner artifact', async () => {
  const calls = [];
  const client = createRailwayGraphqlClient({
    async fetchImpl(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      assert.equal(init.headers.authorization, 'Bearer fixture_railway_token');
      const body = JSON.parse(init.body);
      if (body.query === RAILWAY_RUNNER_SERVICE_CONNECT_MUTATION) {
        assert.deepEqual(body.variables, {
          serviceId: 'service_live',
          input: {
            image: SIDEKICK_RUNNER_RUNTIME_BASE_IMAGE,
          },
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { serviceConnect: { id: 'service_live' } } };
          },
        };
      }
      if (body.query === RAILWAY_RUNNER_VOLUME_INSTANCE_UPDATE_MUTATION) {
        assert.deepEqual(body.variables, {
          volumeId: 'volume_live',
          environmentId: 'env_live',
          input: {
            serviceId: 'service_live',
            mountPath: '/data',
          },
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { volumeInstanceUpdate: true } };
          },
        };
      }
      if (body.query === RAILWAY_RUNNER_VARIABLE_COLLECTION_UPSERT_MUTATION) {
        assert.deepEqual(body.variables, {
          input: {
            projectId: 'project_live',
            environmentId: 'env_live',
            serviceId: 'service_live',
            skipDeploys: true,
            variables: {
              SIDEKICK_ALLOW_UNSIGNED_HEALTH: 'true',
            },
          },
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { variableCollectionUpsert: true } };
          },
        };
      }
      if (body.query === RAILWAY_RUNNER_SERVICE_INSTANCE_UPDATE_MUTATION) {
        assert.deepEqual(body.variables, {
          serviceId: 'service_live',
          environmentId: 'env_live',
          input: {
            preDeployCommand: body.variables.input.preDeployCommand,
            startCommand: body.variables.input.startCommand,
            healthcheckPath: '/healthz',
            healthcheckTimeout: 900,
            railwayConfigFile: '/sidekick-runner-no-railway-config.toml',
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 10,
          },
        });
        assert.equal(body.variables.input.preDeployCommand, '/bin/true');
        assert.match(body.variables.input.startCommand, /fastapi==0\.115\.6/);
        assert.match(body.variables.input.startCommand, /git clone --depth 1 --branch v2026\.5\.7 https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
        assert.match(body.variables.input.startCommand, /SIDEKICK_RUNNER_SERVER_URL/);
        assert.match(body.variables.input.startCommand, /exec python \/tmp\/sidekick-runner-server\.py/);
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { serviceInstanceUpdate: true } };
          },
        };
      }
      assert.equal(body.query, RAILWAY_RUNNER_SERVICE_INSTANCE_REDEPLOY_MUTATION);
      assert.deepEqual(body.variables, { serviceId: 'service_live', environmentId: 'env_live' });
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { serviceInstanceRedeploy: true } };
        },
      };
    },
  });

  await client.configureHermesRunnerServiceInstance({
    projectId: 'project_live',
    serviceId: 'service_live',
    environmentId: 'env_live',
    volumeId: 'volume_live',
  }, 'fixture_railway_token');

  assert.equal(calls.length, 5);
  assert.equal(calls[0].body.query, RAILWAY_RUNNER_SERVICE_CONNECT_MUTATION);
  assert.equal(calls[1].body.query, RAILWAY_RUNNER_VOLUME_INSTANCE_UPDATE_MUTATION);
  assert.equal(calls[2].body.query, RAILWAY_RUNNER_VARIABLE_COLLECTION_UPSERT_MUTATION);
  assert.equal(calls[3].body.query, RAILWAY_RUNNER_SERVICE_INSTANCE_UPDATE_MUTATION);
  assert.equal(calls[4].body.query, RAILWAY_RUNNER_SERVICE_INSTANCE_REDEPLOY_MUTATION);
});

test('Hermes test-runner cleanup verifies ownership before deleting Railway and requeueing DB state', async () => {
  const calls = [];
  const result = await cleanupHermesTestRunner({
    userId: '00000000-0000-4000-8000-000000000123',
    railwayProjectId: 'project_live_from_railway',
    railwayToken: 'fixture_railway_token',
    allowRailwayDelete: true,
  }, {
    store: {
      async verifyHermesTestRunnerCleanupTarget(target) {
        calls.push({ op: 'verify', target });
      },
      async markHermesTestRunnerCleanedUp(target) {
        calls.push({ op: 'mark-cleaned', target });
      },
    },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete(projectId, railwayToken) {
        calls.push({ op: 'delete', projectId, railwayToken });
        return true;
      },
    },
  });

  assert.deepEqual(result, { status: 'deleted', railwayProjectId: 'project_live_from_railway' });
  assert.deepEqual(calls.map((call) => call.op), ['verify', 'delete', 'mark-cleaned']);
  assert.equal(calls[0].target.userId, '00000000-0000-4000-8000-000000000123');
  assert.equal(calls[1].projectId, 'project_live_from_railway');
  assert.equal(calls[1].railwayToken, 'fixture_railway_token');
  assert.doesNotMatch(JSON.stringify(result), /fixture_railway_token/i);
});

test('Hermes test-runner cleanup refuses Railway deletes without the explicit allow flag', async () => {
  let deleted = false;
  await assert.rejects(() => cleanupHermesTestRunner({
    userId: '00000000-0000-4000-8000-000000000123',
    railwayProjectId: 'project_live_from_railway',
    railwayToken: 'fixture_railway_token',
  }, {
    store: {
      async verifyHermesTestRunnerCleanupTarget() {
        throw new Error('cleanup should stop before Supabase verification');
      },
      async markHermesTestRunnerCleanedUp() {
        throw new Error('cleanup should stop before DB mutation');
      },
    },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete() {
        deleted = true;
        return true;
      },
    },
  }), /railway_delete_not_allowed/);

  assert.equal(deleted, false);
});

test('Hermes test-runner cleanup refuses to delete the configured shared Railway project', async () => {
  let verified = false;
  let deleted = false;
  await assert.rejects(() => cleanupHermesTestRunner({
    userId: '00000000-0000-4000-8000-000000000123',
    railwayProjectId: 'project_parent_from_env',
    protectedRailwayProjectId: 'project_parent_from_env',
    railwayToken: 'fixture_railway_token',
    allowRailwayDelete: true,
  }, {
    store: {
      async verifyHermesTestRunnerCleanupTarget() {
        verified = true;
      },
      async markHermesTestRunnerCleanedUp() {},
    },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete() {
        deleted = true;
        return true;
      },
    },
  }), /railway_cleanup_target_matches_configured_project/);

  assert.equal(verified, false);
  assert.equal(deleted, false);
});

test('provisioning processor fails closed before claiming jobs when Railway config is missing', async () => {
  const store = {
    claimCount: 0,
    async claimNextQueuedHermesJob() {
      this.claimCount += 1;
      throw new Error('should not claim without config');
    },
    async markHermesProvisioningRequested() {},
    async markHermesProvisioningFailed() {},
    async markHermesProvisioningReconciliationRequired() {},
  };

  const result = await processNextHermesProvisioningJob({
    env: {
      RAILWAY_API_TOKEN: '',
      RAILWAY_WORKSPACE_ID: '',
      HERMES_ADMIN_PASSWORD: '',
    },
  }, { store });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.missingSecrets, ['RAILWAY_API_TOKEN', 'HERMES_ADMIN_PASSWORD', 'SIDEKICK_RUNNER_SHARED_SECRET']);
  assert.deepEqual(result.missingVariables, ['RAILWAY_WORKSPACE_ID', 'SIDEKICK_WORKER_PROXY_URL', 'SIDEKICK_RUNNER_SERVER_URL']);
  assert.equal(store.claimCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture_railway_token|fixture_admin_password|token_value/i);
});

test('provisioning processor claims one queued Hermes job and records real Railway output', async () => {
  const calls = [];
  const completed = [];
  const failed = [];
  const reconciliation = [];
  const store = {
    claimCount: 0,
    async claimNextQueuedHermesJob() {
      this.claimCount += 1;
      return {
        userId: 'user_queued_123',
        tierId: 'pro-office',
        idempotencyKey: 'hermes-provisioning:evt_paid_123',
        claimedAt: '2026-05-06T10:00:00.000Z',
        agentName: 'Ruben',
      };
    },
    async markHermesProvisioningRequested(job, result) {
      completed.push({ job, result });
    },
    async markHermesProvisioningFailed(job, failure) {
      failed.push({ job, failure });
    },
    async markHermesProvisioningReconciliationRequired(job, failure) {
      reconciliation.push({ job, failure });
    },
  };

  const result = await processNextHermesProvisioningJob({
    env: {
      RAILWAY_API_TOKEN: 'fixture_railway_token',
      RAILWAY_WORKSPACE_ID: 'workspace_123',
      RAILWAY_ENVIRONMENT_ID: 'environment_123',
      HERMES_ADMIN_USERNAME: 'admin',
      HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
      SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.dev/v1/chat/completions',
      SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
      SIDEKICK_RUNNER_SERVER_URL: input.runnerServerUrl,
    },
  }, {
    store,
    railway: {
      async templateDeployV2(deployInput, railwayToken) {
        calls.push({ deployInput, railwayToken });
        return {
          projectId: 'project_live_from_railway',
          workflowId: 'workflow_live_from_railway',
          runnerBaseUrl: 'https://runner.sidekick.dev',
        };
      },
    },
  });

  assert.equal(store.claimCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].railwayToken, 'fixture_railway_token');
  assert.equal(calls[0].deployInput.templateId, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(calls[0].deployInput.environmentId, 'environment_123');
  const service = calls[0].deployInput.serializedConfig.services[HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef];
  assert.equal(service.variables.SIDEKICK_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(service.variables.HERMES_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
  assert.equal(reconciliation.length, 0);
  assert.equal(completed[0].job.idempotencyKey, 'hermes-provisioning:evt_paid_123');
  assert.equal(completed[0].result.railwayProjectId, 'project_live_from_railway');
  assert.equal(completed[0].result.railwayWorkflowId, 'workflow_live_from_railway');
  assert.equal(completed[0].result.runnerBaseUrl, 'https://runner.sidekick.dev');
  assert.equal(completed[0].result.runnerSharedSecret, 'fixture_runner_secret');
  assert.equal(result.status, 'provisioning');
  assert.equal(result.railwayProjectId, 'project_live_from_railway');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'runnerBaseUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'runnerSharedSecret'), false);
  assert.doesNotMatch(JSON.stringify(result), /fixture_railway_token|fixture_admin_password|fixture_runner_secret|runner\.sidekick\.dev/i);
});

test('provisioning processor leaves post-Railway persistence failures in manual reconciliation instead of retryable error', async () => {
  const calls = [];
  const completed = [];
  const failed = [];
  const reconciliation = [];
  const store = {
    async claimNextQueuedHermesJob() {
      return {
        userId: 'user_queued_123',
        tierId: 'pro-office',
        idempotencyKey: 'hermes-provisioning:evt_paid_123',
        claimedAt: '2026-05-06T10:00:00.000Z',
      };
    },
    async markHermesProvisioningRequested(job, result) {
      completed.push({ job, result });
      throw new Error('record_hermes_provisioning_output_failed');
    },
    async markHermesProvisioningFailed(job, failure) {
      failed.push({ job, failure });
    },
    async markHermesProvisioningReconciliationRequired(job, failure) {
      reconciliation.push({ job, failure });
    },
  };

  const result = await processNextHermesProvisioningJob({
    env: {
      RAILWAY_API_TOKEN: 'fixture_railway_token',
      RAILWAY_WORKSPACE_ID: 'workspace_123',
      HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
      SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.dev/v1/chat/completions',
      SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
      SIDEKICK_RUNNER_SERVER_URL: input.runnerServerUrl,
    },
  }, {
    store,
    railway: {
      async templateDeployV2(deployInput, railwayToken) {
        calls.push({ deployInput, railwayToken });
        return {
          projectId: 'project_live_from_railway',
          workflowId: 'workflow_live_from_railway',
          runnerBaseUrl: 'https://runner.sidekick.dev',
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
  assert.equal(reconciliation.length, 1);
  assert.equal(result.status, 'reconcile_required');
  assert.equal(reconciliation[0].failure.publicStatusMessage, 'Delegent AI setup needs a manual Railway check before continuing.');
});

test('Hermes domain discovery processor stores generated Railway domain privately before readiness probes', async () => {
  const claimed = [];
  const discovered = [];
  const railwayCalls = [];
  const result = await processNextHermesRunnerDomainDiscoveryJob({
    env: { RAILWAY_API_TOKEN: 'fixture_railway_token' },
  }, {
    store: {
      async claimNextHermesRunnerDomainDiscovery() {
        return {
          userId: 'user_domain_123',
          railwayProjectId: 'project_live_from_railway',
          claimedAt: '2026-05-13T14:20:00.000Z',
        };
      },
      async markHermesRunnerDomainDiscovered(job, endpoint) {
        claimed.push(job);
        discovered.push(endpoint);
      },
    },
    railway: {
      async templateDeployV2() {
        throw new Error('domain discovery must not deploy');
      },
      async discoverHermesRunnerEndpoint(projectId, railwayToken) {
        railwayCalls.push({ projectId, railwayToken });
        return {
          projectId,
          serviceId: 'service_live',
          volumeId: 'volume_live',
          runnerBaseUrl: 'https://runner.sidekick.dev',
          deploymentStatus: 'SUCCESS',
        };
      },
    },
  });

  assert.deepEqual(result, { status: 'domain_found' });
  assert.deepEqual(railwayCalls, [{ projectId: 'project_live_from_railway', railwayToken: 'fixture_railway_token' }]);
  assert.equal(claimed[0].userId, 'user_domain_123');
  assert.equal(discovered[0].runnerBaseUrl, 'https://runner.sidekick.dev');
  assert.equal(discovered[0].serviceId, 'service_live');
  assert.equal(discovered[0].volumeId, 'volume_live');
  assert.doesNotMatch(JSON.stringify(result), /runner\.sidekick\.dev|project_live_from_railway|fixture_railway_token/i);
});

test('Hermes domain discovery processor is backward-compatible when the live RPC migration is not applied yet', async () => {
  let railwayCalled = false;
  const result = await processNextHermesRunnerDomainDiscoveryJob({
    env: { RAILWAY_API_TOKEN: 'fixture_railway_token' },
  }, {
    store: {
      async claimNextHermesRunnerDomainDiscovery() {
        throw new Error('Could not find the function public.claim_next_hermes_runner_domain_discovery in the schema cache');
      },
      async markHermesRunnerDomainDiscovered() {
        throw new Error('must not record without a claim');
      },
    },
    railway: {
      async templateDeployV2() {
        throw new Error('domain discovery must not deploy');
      },
      async discoverHermesRunnerEndpoint() {
        railwayCalled = true;
        throw new Error('must not call Railway without a DB claim');
      },
    },
  });

  assert.deepEqual(result, { status: 'idle' });
  assert.equal(railwayCalled, false);
});

test('Hermes runner health client signs private readiness probes without leaking the shared secret', async () => {
  const fetches = [];
  const client = createHermesRunnerHealthClient({
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, engine: 'hermes-agent' };
        },
      };
    },
  });

  const health = await client.fetchHealth({
    url: 'https://runner.sidekick.dev/health',
    userId: 'user_ready_123',
    runnerSharedSecret: 'runner_health_secret_fixture',
  });

  assert.deepEqual(health, { ok: true, engine: 'hermes-agent' });
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://runner.sidekick.dev/health');
  assert.equal(fetches[0].init.method, 'GET');
  assert.equal(fetches[0].init.headers['x-sidekick-user-id'], 'user_ready_123');
  assert.match(fetches[0].init.headers['x-sidekick-runner-token'], /^v1\.[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(fetches).includes('runner_health_secret_fixture'), false);
});

test('Hermes runner health client aborts hung readiness probes instead of hanging the worker', async () => {
  const client = createHermesRunnerHealthClient({
    timeoutMs: 10,
    fetchImpl(_url, init) {
      return new Promise((_resolve, reject) => {
        assert.ok(init.signal, 'health probe should include an AbortSignal');
        init.signal.addEventListener('abort', () => reject(new Error('runner_health_timeout_aborted')), { once: true });
      });
    },
  });

  await assert.rejects(
    () => client.fetchHealth({
      url: 'https://runner.sidekick.dev/health',
      userId: 'user_ready_123',
      runnerSharedSecret: 'runner_health_secret_fixture',
    }),
    /runner_health_timeout_aborted/,
  );
});

test('Hermes readiness processor marks workers ready only after product-safe runner health passes', async () => {
  const ready = [];
  const failed = [];
  const store = {
    async claimNextHermesReadinessCheck() {
      return {
        userId: 'user_ready_123',
        runnerBaseUrl: 'https://runner.sidekick.dev',
        runnerSharedSecret: 'runner_health_secret_fixture',
        claimedAt: '2026-05-07T10:00:00.000Z',
      };
    },
    async markHermesRunnerReady(job) {
      ready.push(job);
    },
    async markHermesRunnerReadinessFailed(job, failure) {
      failed.push({ job, failure });
    },
  };
  const healthCalls = [];

  const result = await processNextHermesRunnerReadinessCheck({}, {
    store,
    runnerHealth: {
      async fetchHealth(request) {
        healthCalls.push(request);
        return { ok: true, engine: 'hermes-agent', privateUrl: 'https://runner.sidekick.dev' };
      },
    },
  });

  assert.deepEqual(healthCalls, [{
    url: 'https://runner.sidekick.dev/health',
    userId: 'user_ready_123',
    runnerSharedSecret: 'runner_health_secret_fixture',
  }]);
  assert.deepEqual(result, { status: 'ready' });
  assert.equal(ready.length, 1);
  assert.equal(failed.length, 0);
  assert.equal(ready[0].userId, 'user_ready_123');
  assert.equal(ready[0].runnerBaseUrl, 'https://runner.sidekick.dev');
  assert.equal(ready[0].claimedAt, '2026-05-07T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /runner\.sidekick\.dev|railway|project|token|secret/i);
});

test('Hermes readiness processor keeps workers private and provisioning when health is not ready', async () => {
  const ready = [];
  const failed = [];
  const store = {
    async claimNextHermesReadinessCheck() {
      return {
        userId: 'user_not_ready_123',
        runnerBaseUrl: 'https://runner.sidekick.dev',
        runnerSharedSecret: 'runner_health_secret_fixture',
        claimedAt: '2026-05-07T10:05:00.000Z',
      };
    },
    async markHermesRunnerReady(job) {
      ready.push(job);
    },
    async markHermesRunnerReadinessFailed(job, failure) {
      failed.push({ job, failure });
    },
  };

  const result = await processNextHermesRunnerReadinessCheck({}, {
    store,
    runnerHealth: {
      async fetchHealth() {
        return { ok: false, engine: 'booting' };
      },
    },
  });

  assert.deepEqual(result, { status: 'not_ready', errorCode: 'runner_health_not_ready' });
  assert.equal(ready.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].failure.publicStatusMessage, 'Delegent AI is still coming online.');
  assert.doesNotMatch(JSON.stringify(result), /runner\.sidekick\.dev|railway|project|token|secret/i);
  assert.doesNotMatch(JSON.stringify(failed[0].failure), /runner\.sidekick\.dev|railway|project|token|secret/i);
});

test('Hermes readiness processor rejects unsafe runner URLs before fetching health', async () => {
  const failed = [];
  const store = {
    async claimNextHermesReadinessCheck() {
      return {
        userId: 'user_unsafe_123',
        runnerBaseUrl: 'http://user:pass@127.0.0.1:8642',
        runnerSharedSecret: 'runner_health_secret_fixture',
        claimedAt: '2026-05-07T10:10:00.000Z',
      };
    },
    async markHermesRunnerReady() {
      throw new Error('unsafe readiness URL must not be marked ready');
    },
    async markHermesRunnerReadinessFailed(job, failure) {
      failed.push({ job, failure });
    },
  };
  let fetched = false;

  const result = await processNextHermesRunnerReadinessCheck({}, {
    store,
    runnerHealth: {
      async fetchHealth() {
        fetched = true;
        throw new Error('unsafe readiness URL must not be fetched');
      },
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, { status: 'not_ready', errorCode: 'runner_health_not_ready' });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].failure.publicStatusMessage, 'Delegent AI is still coming online.');
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|user:pass|token|secret/i);
});

test('Supabase provisioning store supports runner readiness RPCs without exposing private URLs publicly', async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ op: 'rpc', name, args });
      if (name === 'claim_next_hermes_provisioning_job') return { data: [], error: null };
      if (name === 'claim_next_hermes_runner_domain_discovery') {
        return {
          data: [{
            user_id: '00000000-0000-4000-8000-000000000456',
            railway_project_id: 'project_live_from_railway',
            claimed_at: '2026-05-07T10:14:00.000Z',
          }],
          error: null,
        };
      }
      if (name === 'claim_next_hermes_readiness_check') {
        return {
          data: [{
            user_id: '00000000-0000-4000-8000-000000000456',
            runner_base_url: 'https://runner.sidekick.dev',
            runner_shared_secret: 'runner_health_secret_fixture',
            claimed_at: '2026-05-07T10:15:00.000Z',
          }],
          error: null,
        };
      }
      if (name === 'record_hermes_runner_domain_discovered') return { data: true, error: null };
      if (name === 'record_hermes_runner_ready') return { data: true, error: null };
      if (name === 'record_hermes_runner_readiness_failure') return { data: true, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table) {
      return {
        update(row) {
          calls.push({ op: 'update', table, row });
          return {
            match(filters) {
              calls.push({ op: 'match', table, filters });
              return this;
            },
            eq(column, value) {
              calls.push({ op: 'eq', table, column, value });
              return this;
            },
            select(columns) {
              calls.push({ op: 'select', table, columns });
              return { data: [{ user_id: '00000000-0000-4000-8000-000000000456' }], error: null };
            },
          };
        },
      };
    },
  };

  const store = createSupabaseHermesProvisioningStore(client);
  const domainJob = await store.claimNextHermesRunnerDomainDiscovery();
  assert.deepEqual(domainJob, {
    userId: '00000000-0000-4000-8000-000000000456',
    railwayProjectId: 'project_live_from_railway',
    claimedAt: '2026-05-07T10:14:00.000Z',
  });
  await store.markHermesRunnerDomainDiscovered(domainJob, {
    projectId: 'project_live_from_railway',
    serviceId: 'service_live',
    volumeId: 'volume_live',
    runnerBaseUrl: 'https://runner.sidekick.dev',
  });
  const job = await store.claimNextHermesReadinessCheck();
  assert.deepEqual(job, {
    userId: '00000000-0000-4000-8000-000000000456',
    runnerBaseUrl: 'https://runner.sidekick.dev',
    runnerSharedSecret: 'runner_health_secret_fixture',
    claimedAt: '2026-05-07T10:15:00.000Z',
  });
  await store.markHermesRunnerReady(job);
  await store.markHermesRunnerReadinessFailed(job, {
    errorCode: 'runner_health_not_ready',
    publicStatusMessage: 'Delegent AI is still coming online.',
  });

  assert.equal(calls.some((call) => call.name === 'record_hermes_runner_ready'), true);
  assert.equal(calls.some((call) => call.name === 'record_hermes_runner_readiness_failure'), true);
  const readyRpc = calls.find((call) => call.name === 'record_hermes_runner_ready');
  const failureRpc = calls.find((call) => call.name === 'record_hermes_runner_readiness_failure');
  assert.equal(readyRpc.args.p_claimed_at, '2026-05-07T10:15:00.000Z');
  assert.equal(failureRpc.args.p_claimed_at, '2026-05-07T10:15:00.000Z');
  assert.equal(JSON.stringify(calls).includes('runner_health_secret_fixture'), false);
  const visibleWrites = calls.filter((call) => call.op === 'update' && call.table === 'hermes_instances');
  assert.equal(JSON.stringify(visibleWrites).includes('runner.sidekick.dev'), false);
});

test('Supabase provisioning store claims queued jobs and records private Railway output atomically', async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ op: 'rpc', name, args });
      if (name === 'claim_next_hermes_provisioning_job') {
        return {
          data: [{
            user_id: '00000000-0000-4000-8000-000000000123',
            tier_id: 'pro-office',
            idempotency_key: 'hermes-provisioning:evt_paid_123',
            claimed_at: '2026-05-06T10:00:00.000Z',
            agent_name: 'Ruben',
          }],
          error: null,
        };
      }
      if (name === 'record_hermes_provisioning_output') {
        return { data: true, error: null };
      }
      if (name === 'verify_hermes_test_runner_cleanup_target') {
        return { data: true, error: null };
      }
      if (name === 'cleanup_hermes_test_runner') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table) {
      return {
        update(row) {
          calls.push({ op: 'update', table, row });
          const builder = {
            filters: null,
            match(filters) {
              this.filters = filters;
              calls.push({ op: 'match', table, filters });
              return this;
            },
            eq(column, value) {
              this.filters = { ...(this.filters ?? {}), [column]: value };
              calls.push({ op: 'eq', table, column, value });
              return this;
            },
            select(columns) {
              calls.push({ op: 'select', table, columns, filters: this.filters });
              return { data: [{ user_id: '00000000-0000-4000-8000-000000000123' }], error: null };
            },
          };
          return builder;
        },
      };
    },
  };

  const store = createSupabaseHermesProvisioningStore(client);
  const job = await store.claimNextQueuedHermesJob();
  assert.deepEqual(job, {
    userId: '00000000-0000-4000-8000-000000000123',
    tierId: 'pro-office',
    idempotencyKey: 'hermes-provisioning:evt_paid_123',
    claimedAt: '2026-05-06T10:00:00.000Z',
    agentName: 'Ruben',
  });

  await store.markHermesProvisioningRequested(job, {
    railwayProjectId: 'project_live_from_railway',
    railwayWorkflowId: 'workflow_live_from_railway',
    runnerBaseUrl: 'https://runner.sidekick.dev',
    runnerSharedSecret: 'fixture_runner_secret',
    status: 'provisioning',
    volumeGb: 40,
    volumeMountPath: '/data',
    idempotencyKey: 'sidekick-user-00000000-0000-4000-8000-000000000123',
    templateId: HERMES_AGENT_RAILWAY_TEMPLATE.id,
    templateCode: HERMES_AGENT_RAILWAY_TEMPLATE.code,
    adminUsername: 'admin',
  });

  await store.markHermesProvisioningFailed(job, {
    errorCode: 'railway_graphql_error',
    publicStatusMessage: 'Delegent AI setup paused because the workspace could not be prepared. We will check it before continuing.',
  });

  await store.markHermesProvisioningReconciliationRequired(job, {
    errorCode: 'record_hermes_provisioning_output_failed',
    publicStatusMessage: 'Delegent AI setup needs a manual Railway check before continuing.',
  });

  await store.verifyHermesTestRunnerCleanupTarget({
    userId: '00000000-0000-4000-8000-000000000123',
    railwayProjectId: 'project_live_from_railway',
  });
  await store.markHermesTestRunnerCleanedUp({
    userId: '00000000-0000-4000-8000-000000000123',
    railwayProjectId: 'project_live_from_railway',
  });

  const claimRpc = calls.find((call) => call.op === 'rpc' && call.name === 'claim_next_hermes_provisioning_job');
  assert.deepEqual(claimRpc.args, { p_lease_seconds: 1800 });

  const recordRpc = calls.find((call) => call.op === 'rpc' && call.name === 'record_hermes_provisioning_output');
  assert.equal(recordRpc.args.p_user_id, '00000000-0000-4000-8000-000000000123');
  assert.equal(recordRpc.args.p_idempotency_key, 'hermes-provisioning:evt_paid_123');
  assert.equal(recordRpc.args.p_claimed_at, '2026-05-06T10:00:00.000Z');
  assert.equal(recordRpc.args.p_railway_project_id, 'project_live_from_railway');
  assert.equal(recordRpc.args.p_runner_base_url, 'https://runner.sidekick.dev');
  assert.equal(recordRpc.args.p_runner_shared_secret, 'fixture_runner_secret');
  assert.equal(recordRpc.args.p_railway_workflow_id, 'workflow_live_from_railway');
  assert.equal(recordRpc.args.p_railway_template_id, HERMES_AGENT_RAILWAY_TEMPLATE.id);
  assert.equal(recordRpc.args.p_volume_mount_path, '/data');
  assert.equal(recordRpc.args.p_volume_gb, 40);
  assert.match(recordRpc.args.p_recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.some((call) => call.op === 'upsert'), false);
  assert.equal(calls.some((call) => call.op === 'update' && call.table === 'hermes_instances' && call.row.status === 'provisioning'), true);
  assert.equal(calls.some((call) => call.op === 'update' && call.table === 'hermes_instances' && call.row.status === 'error'), true);
  assert.equal(calls.some((call) => call.op === 'update' && call.table === 'hermes_instances' && call.row.status === 'provisioning' && call.row.provisioning_claimed_at === undefined), true);
  const cleanupVerifyRpc = calls.find((call) => call.op === 'rpc' && call.name === 'verify_hermes_test_runner_cleanup_target');
  const cleanupRpc = calls.find((call) => call.op === 'rpc' && call.name === 'cleanup_hermes_test_runner');
  assert.deepEqual(cleanupVerifyRpc.args, {
    p_user_id: '00000000-0000-4000-8000-000000000123',
    p_railway_project_id: 'project_live_from_railway',
  });
  assert.deepEqual(cleanupRpc.args, {
    p_user_id: '00000000-0000-4000-8000-000000000123',
    p_railway_project_id: 'project_live_from_railway',
  });
});

test('Supabase service-role REST client performs only service-role RPC/update calls for the provisioner', async () => {
  const fetches = [];
  const client = createSupabaseServiceRoleRestClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service_role_secret',
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/rpc/claim_next_hermes_provisioning_job')) {
            return [{
              user_id: '00000000-0000-4000-8000-000000000123',
              tier_id: 'pro-office',
              idempotency_key: 'hermes-provisioning:evt_paid_123',
              claimed_at: '2026-05-06T10:00:00.000Z',
              agent_name: 'Ruben',
            }];
          }
          return [{ user_id: '00000000-0000-4000-8000-000000000123' }];
        },
      };
    },
  });

  const claim = await client.rpc('claim_next_hermes_provisioning_job', { p_lease_seconds: 1800 });
  const update = await client.from('hermes_instances').update({ status: 'error' }).match({
    user_id: '00000000-0000-4000-8000-000000000123',
    status: 'provisioning',
  }).select('user_id');

  assert.equal(claim.error, null);
  assert.equal(update.error, null);
  assert.equal(fetches[0].url, 'https://project.supabase.co/rest/v1/rpc/claim_next_hermes_provisioning_job');
  assert.equal(fetches[0].init.method, 'POST');
  assert.equal(fetches[0].init.headers.authorization, 'Bearer service_role_secret');
  assert.equal(fetches[1].init.method, 'PATCH');
  assert.match(fetches[1].url, /\/rest\/v1\/hermes_instances\?/);
  assert.match(fetches[1].url, /user_id=eq\.00000000-0000-4000-8000-000000000123/);
  assert.match(fetches[1].url, /status=eq\.provisioning/);
  assert.equal(JSON.stringify(fetches).includes('anon'), false);
});

test('Series 4 service-role store claims and records durable account deletion requests through RPCs only', async () => {
  const fetches = [];
  const client = createSupabaseServiceRoleRestClient({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service_role_secret',
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/rpc/claim_next_account_deletion_request')) {
            return [{
              id: '44444444-4444-4444-8444-444444444444',
              user_id: '00000000-0000-4000-8000-000000000123',
              user_email: 'alex@example.test',
              claimed_at: '2026-05-22T11:00:00.000Z',
              teardown_by: '2026-05-23T11:00:00.000Z',
              teardown_snapshot: {
                private_teardown_target: {
                  provider: 'fly_machines',
                  fly_org: 'personal',
                  fly_app_name: 'delegent-user-abc123',
                  fly_machine_id: 'machine_abc123',
                  fly_volume_id: 'vol_abc123',
                  fly_region: 'lhr',
                },
              },
              processing_token: '55555555-5555-4555-8555-555555555555',
              auth_deleted_at: '2026-05-22T10:59:00.000Z',
              connections_cleared_at: null,
              infrastructure_cleared_at: null,
              pending_cleanup: [{ broker: 'composio', account_id: 'ca_stuck' }],
            }];
          }
          if (url.endsWith('/rpc/record_account_deletion_phase')) return true;
          if (url.endsWith('/rpc/record_account_deletion_request_completed')) return true;
          if (url.endsWith('/rpc/record_account_deletion_request_failed')) return true;
          throw new Error(`unexpected fetch ${url}`);
        },
      };
    },
  });
  const store = createSeries4SupabaseLifecycleStore(client);

  const claim = await store.claimNextAccountDeletionRequest();
  await store.recordAccountDeletionPhase(claim.id, claim.processingToken, 'infrastructure');
  await store.recordAccountDeletionRequestCompleted(claim.id, claim.processingToken, {
    provider: 'fly_machines',
    flyAppName: 'delegent-user-abc123',
    flyMachineId: 'machine_abc123',
    flyVolumeId: 'vol_abc123',
  });
  await store.recordAccountDeletionRequestFailed(claim.id, {
    errorCode: 'fly_account_delete_failed_503',
    publicStatusMessage: 'Delegent AI account deletion needs an operator check before continuing.',
  });

  assert.equal(claim.id, '44444444-4444-4444-8444-444444444444');
  assert.equal(claim.userId, '00000000-0000-4000-8000-000000000123');
  assert.equal(claim.userEmail, 'alex@example.test');
  assert.equal(claim.teardownSnapshot.private_teardown_target.fly_app_name, 'delegent-user-abc123');
  // The phases the claim arrives with, so a worker knows what somebody else
  // already finished and what is still owed.
  assert.equal(claim.processingToken, '55555555-5555-4555-8555-555555555555');
  assert.equal(claim.authDeletedAt, '2026-05-22T10:59:00.000Z');
  assert.equal(claim.connectionsClearedAt, null);
  assert.deepEqual(claim.pendingCleanup, [{ broker: 'composio', account_id: 'ca_stuck' }]);

  assert.equal(fetches.length, 4);
  assert.equal(fetches[0].url, 'https://project.supabase.co/rest/v1/rpc/claim_next_account_deletion_request');
  assert.equal(fetches[0].init.method, 'POST');
  assert.equal(fetches[0].init.headers.authorization, 'Bearer service_role_secret');
  assert.equal(JSON.parse(fetches[0].init.body).p_processing_lease_seconds, 900);
  assert.equal(fetches[1].url, 'https://project.supabase.co/rest/v1/rpc/record_account_deletion_phase');
  assert.equal(JSON.parse(fetches[1].init.body).p_processing_token, claim.processingToken);
  assert.equal(fetches[2].url, 'https://project.supabase.co/rest/v1/rpc/record_account_deletion_request_completed');
  assert.equal(JSON.parse(fetches[2].init.body).p_request_id, claim.id);
  // Without the token an expired claimant can complete a newer claimant's row,
  // which live SQL allowed because completion took only the request id.
  assert.equal(JSON.parse(fetches[2].init.body).p_processing_token, claim.processingToken);
  assert.equal(JSON.parse(fetches[2].init.body).p_result.flyAppName, 'delegent-user-abc123');
  assert.equal(fetches[3].url, 'https://project.supabase.co/rest/v1/rpc/record_account_deletion_request_failed');
  assert.equal(JSON.parse(fetches[3].init.body).p_error_code, 'fly_account_delete_failed_503');
  assert.equal(JSON.stringify(fetches).includes('anon'), false);
  assert.doesNotMatch(JSON.stringify(fetches), /runner_shared_secret/);
});

test('provisioner CLI exposes series4:account-deletion-once and leaves secrets out of idle output', async () => {
  const fetches = [];
  let stdout = '';
  let stderr = '';
  const exitCode = await runHermesProvisionerCli(['series4:account-deletion-once'], {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
    FLY_API_TOKEN: 'FlyV1 fm2_test_token_value_that_must_not_leak',
    FLY_ORG: 'personal',
    FLY_PRIMARY_REGION: 'lhr',
  }, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/rpc/claim_next_account_deletion_request')) return [];
          throw new Error(`unexpected fetch ${url}`);
        },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).status, 'idle');
  assert.equal(fetches.some((call) => call.url.endsWith('/rpc/claim_next_account_deletion_request')), true);
  assert.doesNotMatch(stdout + stderr, /service_role_secret|fm2_test_token_value/i);
});

test('provisioner CLI processes one queued job with Supabase service-role storage and agent-name Railway env', async () => {
  const fetches = [];
  const railwayCalls = [];
  let stdout = '';
  let stderr = '';
  const exitCode = await runHermesProvisionerCli(['process-once'], {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
    RAILWAY_API_TOKEN: 'fixture_railway_token',
    RAILWAY_WORKSPACE_ID: 'workspace_123',
    HERMES_ADMIN_PASSWORD: 'fixture_admin_password',
    SIDEKICK_WORKER_PROXY_URL: 'https://worker.sidekick.dev/v1/chat/completions',
    SIDEKICK_RUNNER_SHARED_SECRET: 'fixture_runner_secret',
    SIDEKICK_RUNNER_SERVER_URL: input.runnerServerUrl,
  }, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/rpc/claim_next_hermes_provisioning_job')) {
            return [{
              user_id: '00000000-0000-4000-8000-000000000123',
              tier_id: 'pro-office',
              idempotency_key: 'hermes-provisioning:evt_paid_123',
              claimed_at: '2026-05-06T10:00:00.000Z',
              agent_name: 'Ruben',
            }];
          }
          if (url.endsWith('/rpc/record_hermes_provisioning_output')) return true;
          return [];
        },
      };
    },
    railway: {
      async templateDeployV2(deployInput, railwayToken) {
        railwayCalls.push({ deployInput, railwayToken });
        return {
          projectId: 'project_live_from_railway',
          workflowId: 'workflow_live_from_railway',
          runnerBaseUrl: 'https://runner.sidekick.dev',
        };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(fetches.some((call) => call.url.endsWith('/rpc/claim_next_hermes_provisioning_job')), true);
  assert.equal(fetches.some((call) => call.url.endsWith('/rpc/record_hermes_provisioning_output')), true);
  assert.equal(railwayCalls.length, 1);
  const service = railwayCalls[0].deployInput.serializedConfig.services[HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef];
  assert.equal(service.variables.SIDEKICK_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(service.variables.HERMES_AGENT_NAME.defaultValue, 'Ruben');
  assert.equal(JSON.parse(stdout).status, 'provisioning');
  assert.doesNotMatch(stdout + stderr, /service_role_secret|fixture_railway_token|fixture_admin_password|fixture_runner_secret|runner\.sidekick\.dev/i);
});

test('provisioner CLI blocks test-runner cleanup unless Railway deletion is explicitly enabled', async () => {
  let stdout = '';
  let stderr = '';
  let deleted = false;
  const exitCode = await runHermesProvisionerCli([
    'cleanup-test-runner',
    '00000000-0000-4000-8000-000000000123',
    'project_live_from_railway',
  ], {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
    RAILWAY_API_TOKEN: 'fixture_railway_token',
  }, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete() {
        deleted = true;
        return true;
      },
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout, '');
  assert.equal(deleted, false);
  const body = JSON.parse(stderr);
  assert.equal(body.status, 'blocked');
  assert.equal(body.missingVariables.includes('SIDEKICK_ALLOW_RAILWAY_DELETE'), true);
  assert.doesNotMatch(stdout + stderr, /service_role_secret|fixture_railway_token/i);
});

test('provisioner CLI blocks cleanup when the target is the configured shared Railway project', async () => {
  let stdout = '';
  let stderr = '';
  let deleted = false;
  const exitCode = await runHermesProvisionerCli([
    'cleanup-test-runner',
    '00000000-0000-4000-8000-000000000123',
    'project_parent_from_env',
  ], {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
    RAILWAY_API_TOKEN: 'fixture_railway_token',
    RAILWAY_PROJECT_ID: 'project_parent_from_env',
    SIDEKICK_ALLOW_RAILWAY_DELETE: 'true',
  }, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete() {
        deleted = true;
        return true;
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.equal(deleted, false);
  assert.equal(JSON.parse(stderr).errorCode, 'railway_cleanup_target_matches_configured_project');
  assert.doesNotMatch(stdout + stderr, /service_role_secret|fixture_railway_token/i);
});

test('provisioner CLI deletes one verified test runner and resets Supabase state', async () => {
  const fetches = [];
  const railwayDeletes = [];
  let stdout = '';
  let stderr = '';
  const exitCode = await runHermesProvisionerCli([
    'cleanup-test-runner',
    '00000000-0000-4000-8000-000000000123',
    'project_live_from_railway',
  ], {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
    RAILWAY_API_TOKEN: 'fixture_railway_token',
    SIDEKICK_ALLOW_RAILWAY_DELETE: 'true',
  }, {
    stdout: (line) => { stdout += `${line}\n`; },
    stderr: (line) => { stderr += `${line}\n`; },
    async fetchImpl(url, init) {
      fetches.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith('/rpc/verify_hermes_test_runner_cleanup_target')) return true;
          if (url.endsWith('/rpc/cleanup_hermes_test_runner')) return true;
          throw new Error(`unexpected fetch ${url}`);
        },
      };
    },
    railway: {
      async templateDeployV2() {
        throw new Error('cleanup must not deploy');
      },
      async projectDelete(projectId, railwayToken) {
        railwayDeletes.push({ projectId, railwayToken });
        return true;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { status: 'deleted', railwayProjectId: 'project_live_from_railway' });
  assert.deepEqual(railwayDeletes, [{ projectId: 'project_live_from_railway', railwayToken: 'fixture_railway_token' }]);
  assert.equal(fetches[0].url, 'https://project.supabase.co/rest/v1/rpc/verify_hermes_test_runner_cleanup_target');
  assert.equal(fetches[1].url, 'https://project.supabase.co/rest/v1/rpc/cleanup_hermes_test_runner');
  assert.equal(fetches.every((call) => call.init.headers.authorization === 'Bearer service_role_secret'), true);
  assert.doesNotMatch(stdout + stderr, /service_role_secret|fixture_railway_token/i);
});
