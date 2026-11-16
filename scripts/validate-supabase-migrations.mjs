import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { findUnscopedSurvivingPolicies } from './lib/rls-policy-scope.mjs';
import { GRANTS_REQUIRED_FROM_MIGRATION, findUngrantedPublicTables, migrationNumber } from './lib/migration-grants.mjs';

// Discover migrations from disk so newly-added migrations are validated
// automatically, rather than requiring this list to be kept in sync by hand.
const MIGRATIONS_DIR = 'supabase/migrations';
const migrationFiles = existsSync(resolve(MIGRATIONS_DIR))
  ? readdirSync(resolve(MIGRATIONS_DIR))
      .filter((entry) => entry.endsWith('.sql'))
      .filter((entry) => statSync(resolve(MIGRATIONS_DIR, entry)).isFile())
      .sort()
      .map((entry) => `${MIGRATIONS_DIR}/${entry}`)
  : [];

if (migrationFiles.length === 0) {
  console.error('No Supabase migrations found in supabase/migrations/.');
  process.exit(1);
}

for (const file of migrationFiles) {
  if (!existsSync(resolve(file))) {
    console.error(`Missing migration file: ${file}`);
    process.exit(1);
  }
}

const sql = migrationFiles
  .map((file) => readFileSync(resolve(file), 'utf8'))
  .join('\n')
  .toLowerCase()
  .replace(/\s+/g, ' ');

const productMigrationSql = readFileSync(resolve('supabase/migrations/0002_product_state_foundation.sql'), 'utf8')
  .toLowerCase()
  .replace(/\s+/g, ' ');

const requiredFragments = [
  'create table public.profiles',
  'create table public.acknowledgements',
  'create table public.subscriptions',
  'create table public.hermes_instances',
  'create table public.messages',
  'create table public.token_usage_events',
  'create table public.usage_quotas',
  'create table public.provisioning_events',
  'create table if not exists public.billing_events',
  'create table if not exists public.task_runs',
  'create table if not exists public.artifacts',
  'create table if not exists public.hermes_instance_private',
  'create or replace view public.my_product_state',
  'create or replace function public.handle_new_user()',
  'create trigger on_auth_user_created',
  'create index if not exists messages_user_created_idx',
  'create index if not exists token_usage_events_user_created_idx',
  'create index if not exists provisioning_events_user_created_idx',
  'create unique index if not exists billing_events_provider_event_id_idx',
  'create unique index if not exists billing_events_idempotency_key_idx',
  'create index if not exists billing_events_user_created_idx',
  'billing_events_provider_check',
  'billing_events_payload_hash_shape_check',
  'billing_events_processing_lease_check',
  'processing_expires_at',
  'subscriptions_period_order_check',
  'subscriptions_active_requires_provider_ids_check',
  'subscriptions_provider_updated_active_check',
  'provider_updated_at',
  'provisioning_idempotency_key',
  'hermes_instances_queued_idx',
  'hermes_instances_claimable_idx',
  'claim_next_hermes_provisioning_job',
  'for update skip locked',
  'hp.railway_project_id is not null',
  'record_hermes_provisioning_output',
  'p_runner_base_url text',
  'p_runner_shared_secret text',
  'locked.provisioning_idempotency_key is distinct from p_idempotency_key',
  'locked.provisioning_claimed_at is distinct from p_claimed_at',
  'insert into public.hermes_instance_private',
  'on conflict (user_id) do update',
  'revoke all on function public.claim_next_hermes_provisioning_job',
  'grant execute on function public.claim_next_hermes_provisioning_job',
  'revoke all on function public.record_hermes_provisioning_output',
  'grant execute on function public.record_hermes_provisioning_output',
  'to service_role',
  'railway_workflow_id',
  'railway_template_id',
  'volume_mount_path',
  'volume_gb',
  'create policy "messages insert own user messages"',
  "role = 'user'",
  'revoke select on public.hermes_instances from authenticated',
  'grant select on public.my_product_state to authenticated',
  'create table if not exists public.gateway_connections',
  'create table if not exists public.gateway_connect_codes',
  'create table if not exists public.gateway_task_events',
  'alter table public.gateway_connections enable row level security',
  'alter table public.gateway_connect_codes enable row level security',
  'alter table public.gateway_task_events enable row level security',
  'gateway_connections_gateway_id_check',
  'gateway_connections_status_check',
  'gateway_connect_codes_hash_shape_check',
  'gateway_task_events_identifiers_not_blank_check',
  'create unique index if not exists gateway_connections_connected_source_idx',
  'create unique index if not exists gateway_connect_codes_gateway_code_hash_idx',
  'create unique index if not exists gateway_task_events_gateway_idempotency_idx',
  'revoke all on public.gateway_connections from anon, authenticated',
  'revoke all on public.gateway_connect_codes from anon, authenticated',
  'revoke all on public.gateway_task_events from anon, authenticated',
  'grant select, insert, update on public.gateway_connections to service_role',
  'grant select, insert, update on public.gateway_connect_codes to service_role',
  'grant select, insert, update on public.gateway_task_events to service_role',
  'create or replace function public.claim_gateway_task_event',
  'security definer',
  'set search_path = public, pg_temp',
  'insert into public.gateway_task_events',
  'insert into public.messages',
  'insert into public.task_runs',
  'update public.gateway_task_events',
  'revoke all on function public.claim_gateway_task_event',
  'grant execute on function public.claim_gateway_task_event',
  "gc.gateway_id = 'telegram'",
  "gc.status = 'connected'",
  'telegram_connected',
  'create unique index if not exists gateway_connections_one_active_provider_per_user_idx',
  "check (gateway_id in ('telegram', 'whatsapp', 'signal'))",
  'create or replace function public.set_active_gateway_connection',
  'update public.gateway_connections set status = \'disconnected\'',
  'grant execute on function public.set_active_gateway_connection',
  'active_gateway_id',
  'messaging_provider_connections',
  // Series 4 — Fly Machines provider columns + lifecycle RPCs (0021).
  'hermes_instances_provider_check',
  "check (provider in ('railway_legacy', 'fly_machines'))",
  'hermes_instances_status_check',
  "check (status in ( 'not_requested', 'queued', 'provisioning', 'ready', 'degraded', 'error', 'sleeping', 'deleting', 'deleted' ))",
  'hermes_instances_suspend_window_check',
  'hermes_instance_private_fly_complete_check',
  'hermes_instance_private_fly_app_name_idx',
  'fly_app_name',
  'fly_machine_id',
  'fly_volume_id',
  'fly_region',
  'image_digest',
  'volume_retention_until',
  'create or replace function public.record_hermes_fly_provisioning_output',
  'create or replace function public.mark_hermes_runner_suspended',
  'create or replace function public.mark_hermes_runner_resumed',
  'create or replace function public.claim_next_hermes_runner_grace_expired',
  'create or replace function public.record_hermes_runner_deleted',
  'revoke all on function public.record_hermes_fly_provisioning_output',
  'revoke all on function public.mark_hermes_runner_suspended',
  'revoke all on function public.mark_hermes_runner_resumed',
  'revoke all on function public.claim_next_hermes_runner_grace_expired',
  'revoke all on function public.record_hermes_runner_deleted',
  'grant execute on function public.record_hermes_fly_provisioning_output',
  'grant execute on function public.mark_hermes_runner_suspended',
  'grant execute on function public.mark_hermes_runner_resumed',
  'grant execute on function public.claim_next_hermes_runner_grace_expired',
  'grant execute on function public.record_hermes_runner_deleted',
  // #12 — reclaim runners stuck in 'deleting' after a partial teardown (0040).
  'hermes_instances_stuck_deleting_idx',
  "or (hi.status = 'deleting'",
  // #27 — scheduled-tasks RPCs must be executable by service_role (0041).
  'grant execute on function public.claim_due_scheduled_tasks(integer) to service_role',
  'grant execute on function public.record_scheduled_task_dispatch(uuid, uuid, boolean) to service_role',
  // Durable account deletion queue + processor RPCs (0028).
  'create table if not exists public.account_deletion_requests',
  'account_deletion_requests_status_check',
  "check (status in ('requested', 'processing', 'completed', 'failed', 'canceled'))",
  'account_deletion_requests_open_user_idx',
  'account_deletion_requests_queue_idx',
  'alter table public.account_deletion_requests enable row level security',
  'revoke all on public.account_deletion_requests from public, anon, authenticated',
  'grant select, insert, update on public.account_deletion_requests to service_role',
  'create or replace function public.claim_next_account_deletion_request',
  'create or replace function public.record_account_deletion_request_completed',
  'create or replace function public.record_account_deletion_request_failed',
  'for update of adr skip locked',
  'processing_expires_at',
  'revoke all on function public.claim_next_account_deletion_request',
  'revoke all on function public.record_account_deletion_request_completed',
  'revoke all on function public.record_account_deletion_request_failed',
  'grant execute on function public.claim_next_account_deletion_request',
  'grant execute on function public.record_account_deletion_request_completed',
  'grant execute on function public.record_account_deletion_request_failed',
  // First-run acknowledgement v2 contract (0029).
  "p_acknowledgement_text_version <> 'v2'",
  "with check (auth.uid() = user_id and text_version = 'v2')",
  "(ack.user_id is not null and ack.text_version = 'v2') as acknowledgement_accepted",
  "ack.text_version <> 'v2'",
];

const missing = requiredFragments.filter((fragment) => !sql.includes(fragment));

if (missing.length > 0) {
  console.error('Supabase product-state migration validation failed. Missing fragments:');
  for (const fragment of missing) console.error(`- ${fragment}`);
  process.exit(1);
}

const requiredRemediations = [
  'drop policy if exists "own messages" on public.messages',
  'drop policy if exists "own acknowledgements" on public.acknowledgements',
  'create policy "messages read own" on public.messages for select',
  'create policy "acknowledgements insert own" on public.acknowledgements for insert',
];

const missingRemediations = requiredRemediations.filter((fragment) => !productMigrationSql.includes(fragment));
if (missingRemediations.length > 0) {
  console.error('Supabase migration is missing broad-policy remediations:');
  for (const fragment of missingRemediations) console.error(`- ${fragment}`);
  process.exit(1);
}

const clientSurfaceHardening = [
  'drop policy if exists "own subscriptions read" on public.subscriptions',
  'drop policy if exists "own hermes read" on public.hermes_instances',
  'drop policy if exists "own usage read" on public.token_usage_events',
  'drop policy if exists "own quotas read" on public.usage_quotas',
  'drop policy if exists "own provisioning read" on public.provisioning_events',
  'revoke all on public.subscriptions from anon, authenticated',
  'revoke all on public.hermes_instances from anon, authenticated',
  'revoke all on public.token_usage_events from anon, authenticated',
  'revoke all on public.usage_quotas from anon, authenticated',
  'revoke all on public.provisioning_events from anon, authenticated',
  'grant select on public.my_product_state to authenticated',
  'grant select on public.task_runs to authenticated',
  'grant select on public.artifacts to authenticated',
];

const missingClientSurfaceHardening = clientSurfaceHardening.filter((fragment) => !sql.includes(fragment));
if (missingClientSurfaceHardening.length > 0) {
  console.error('Supabase migrations are missing client-surface hardening fragments:');
  for (const fragment of missingClientSurfaceHardening) console.error(`- ${fragment}`);
  process.exit(1);
}

const serviceOwnedTables = [
  'subscriptions',
  'hermes_instances',
  'token_usage_events',
  'usage_quotas',
  'provisioning_events',
  'billing_events',
  'hermes_instance_private',
  'gateway_connections',
  'gateway_connect_codes',
  'gateway_task_events',
];

const unsafeClientGrants = [];
for (const tableName of serviceOwnedTables) {
  const grantPattern = new RegExp(`grant\\s+select[^;]*on\\s+public\\.${tableName}\\s+to\\s+(?:anon|authenticated)`, 'i');
  if (grantPattern.test(sql)) unsafeClientGrants.push(`public.${tableName}`);
}
if (unsafeClientGrants.length > 0) {
  console.error('Service-owned tables must not grant direct client SELECT; expose safe fields through public.my_product_state instead:');
  for (const tableName of unsafeClientGrants) console.error(`- ${tableName}`);
  process.exit(1);
}

const mustNotExposeInView = [
  'railway_project_id',
  'railway_service_id',
  'railway_volume_id',
  'runner_base_url',
  'runner_shared_secret',
  'raw_error',
  'stripe_customer_id',
  'stripe_subscription_id',
  'price_id',
  'billing_events',
  'provider_event_id',
  'payload_hash',
  'source_conversation_id',
  'source_message_id',
  'source_event_id',
  'code_hash',
  'idempotency_key',
];
const latestViewStart = sql.lastIndexOf('create or replace view public.my_product_state');
const latestViewEnd = latestViewStart === -1 ? -1 : sql.indexOf('grant select on public.my_product_state', latestViewStart);
const viewSql = latestViewStart === -1
  ? ''
  : sql.slice(latestViewStart, latestViewEnd === -1 ? undefined : latestViewEnd);
const leaked = mustNotExposeInView.filter((fragment) => viewSql.includes(fragment));
if (leaked.length > 0) {
  console.error('Client-facing product-state view exposes private infrastructure fields:');
  for (const fragment of leaked) console.error(`- ${fragment}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// RLS coverage: every `create table public.<name>` (and `if not exists`
// variant) must be paired with a matching `alter table public.<name> enable
// row level security` in the same migration set. RLS-on-by-default is the
// most important Supabase invariant — silently shipping a table without it
// leaks data to every authenticated user. The validator catches forgotten
// enables before they reach review.
// -----------------------------------------------------------------------------
const TABLES_EXEMPT_FROM_RLS = new Set([
  // Add fully-public tables here only with a written justification.
]);

const rawSql = migrationFiles.map((file) => readFileSync(resolve(file), 'utf8')).join('\n');
const lowerRawSql = rawSql.toLowerCase();
const tablePattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/g;
const definedTables = new Set();
let tableMatch;
while ((tableMatch = tablePattern.exec(lowerRawSql)) !== null) {
  definedTables.add(tableMatch[1]);
}

const tablesMissingRls = [];
for (const tableName of definedTables) {
  if (TABLES_EXEMPT_FROM_RLS.has(tableName)) continue;
  const enablePattern = new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${tableName}\\b[^;]*enable\\s+row\\s+level\\s+security`,
    'i',
  );
  if (!enablePattern.test(lowerRawSql)) {
    tablesMissingRls.push(tableName);
  }
}

if (tablesMissingRls.length > 0) {
  console.error('Supabase migrations defined tables without enabling row level security:');
  for (const tableName of tablesMissingRls) console.error(`- public.${tableName}`);
  console.error('Add `alter table public.<name> enable row level security;` and matching policies, or list the table in TABLES_EXEMPT_FROM_RLS with a justification.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// SECURITY DEFINER functions must lock down `search_path`. The canonical
// Supabase recommendation is `set search_path = public, pg_temp`. We assert
// that any `security definer` block in the latest definition of a function
// is paired with a hardened search_path setting.
// -----------------------------------------------------------------------------
// `create or replace function` is idempotent: the LAST definition in
// migration order is what actually runs in the DB. We collect the most
// recent SECURITY DEFINER block per function name and check only that one,
// so a hardening migration can supersede an earlier looser definition
// without the validator complaining about the historical record.
const securityDefinerPattern = /create\s+or\s+replace\s+function\s+([\w.]+)[\s\S]*?security\s+definer[\s\S]*?\$\$/gi;
const latestDefinerByFn = new Map();
let definerMatch;
while ((definerMatch = securityDefinerPattern.exec(rawSql)) !== null) {
  latestDefinerByFn.set(definerMatch[1].toLowerCase(), definerMatch[0]);
}
const definerIssues = [];
for (const [fnName, block] of latestDefinerByFn) {
  const lower = block.toLowerCase();
  const searchPathMatch = /set\s+search_path\s*=\s*([^;\n]+)/.exec(lower);
  const list = searchPathMatch ? searchPathMatch[1] : '';
  if (!searchPathMatch || !/\bpublic\b/.test(list) || !/\bpg_temp\b/.test(list)) {
    definerIssues.push(fnName);
  }
}
if (definerIssues.length > 0) {
  console.error('SECURITY DEFINER functions are missing a hardened `search_path`:');
  for (const fn of definerIssues) console.error(`- ${fn}`);
  console.error('Add `set search_path = public, pg_temp` to each `create or replace function ... security definer` block.');
  process.exit(1);
}

// #31 — block fully-permissive RLS policy clauses. A `using (true)` / `with
// check (true)` policy on a client-readable table would expose every tenant's
// rows; the corpus scopes every policy to auth.uid() today, and this keeps it
// that way (add a justified allowlist if a service-role-only table ever needs one).
const permissivePolicies = rawSql.match(/\b(?:using|with\s+check)\s*\(\s*true\s*\)/gi) ?? [];
if (permissivePolicies.length > 0) {
  console.error('Supabase migrations contain fully-permissive RLS policy clause(s):');
  for (const clause of permissivePolicies) console.error(`- ${clause}`);
  console.error('Scope every policy to auth.uid(), or revoke the table from anon/authenticated and rely on service-role.');
  process.exit(1);
}

// #31 (second half) — every policy SURVIVING the full migration sequence must
// scope by auth.uid() (or carry an explicit `-- rls-scope-exempt: <reason>`
// comment). using(true) is the loud failure mode; a policy keyed on anything
// other than the requesting user is the quiet one, and both grant strangers'
// rows. Final-state semantics: an early offender cured by a later
// `drop policy` passes.
const unscopedPolicies = findUnscopedSurvivingPolicies(rawSql);
if (unscopedPolicies.length > 0) {
  console.error('Supabase migrations contain surviving RLS policies without an auth.uid() scope:');
  for (const { table, policy } of unscopedPolicies) console.error(`- public.${table} :: "${policy}"`);
  console.error('Scope the policy to auth.uid(), drop it in a later migration, or add `-- rls-scope-exempt: <reason>`.');
  process.exit(1);
}

// Supabase, from 2026-10-30: a new table in `public` gets no Data API
// privileges unless its migration grants them (scripts/lib/migration-grants.mjs).
// Checked from the first migration written after their notice.
const grantIssues = migrationFiles
  .filter((file) => migrationNumber(file) >= GRANTS_REQUIRED_FROM_MIGRATION)
  .flatMap((file) => findUngrantedPublicTables(readFileSync(resolve(file), 'utf8')).map((issue) => ({ file, ...issue })));
if (grantIssues.length > 0) {
  console.error('New public tables need explicit grants (Supabase default change, 2026-10-30):');
  for (const { file, table, problem } of grantIssues) console.error(`- ${file}: public.${table}: ${problem}`);
  console.error('Add `grant select, insert, update, delete on public.<table> to service_role;` (and to authenticated where the app reads it directly), plus `grant usage, select on sequence ...` for identity columns.');
  process.exit(1);
}

console.log(`Supabase product-state migration validation passed (checked ${migrationFiles.length} file(s), ${definedTables.size} table(s) RLS-enabled).`);
