// Static RLS-coverage guard (closes SEC-RLS-001 / the 2026-06-03 review P1).
//
// The mobile app reads Supabase directly with the public ANON key, so the ONLY
// thing stopping one user from reading another's rows is Row Level Security.
// There was no automated guard on that: a future migration could add a
// user-scoped table and forget the policy, shipping a cross-tenant read with no
// test failure. This parses the migration corpus and asserts:
//   1. EVERY user-scoped table (has a user_id column, or is `profiles`) has
//      `enable row level security` — the universal invariant (no table is
//      world-readable by default).
//   2. Every table the mobile app reads via the anon key has an `auth.uid()`
//      policy (service-only tables like hermes_instance_private are correctly
//      RLS-on with NO policy = default-deny, so they're excluded from #2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
  .join('\n')
  .toLowerCase();

// Org-level / non-per-user tables: may have RLS without an auth.uid() user policy.
const NON_USER_TABLES = new Set(['delegent_billing_guard']);

// Tables the mobile app reads DIRECTLY with the anon key — each MUST carry an
// auth.uid() policy or one user could read another's rows. (Service-only tables
// e.g. hermes_instance_private / billing_events / gateway_* are RLS default-deny
// and intentionally NOT here.)
const MOBILE_READABLE = [
  'profiles', 'subscriptions', 'hermes_instances', 'usage_quotas',
  'token_usage_events', 'messages', 'task_runs', 'artifacts',
  'provisioning_events', 'usage_violations', 'scheduled_tasks', 'acknowledgements',
];

function discoverUserScopedTables() {
  const out = new Set();
  const re = /create table (?:if not exists )?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, name, body] = m;
    if (name === 'profiles' || /\buser_id\b/.test(body)) out.add(name);
  }
  return out;
}
const userTables = discoverUserScopedTables();

test('RLS is ENABLED on every user-scoped table (the core anon-read isolation invariant)', () => {
  const missing = [...userTables].filter(
    (t) => !NON_USER_TABLES.has(t) && !new RegExp(`alter table public\\.${t} enable row level security`).test(sql),
  );
  assert.deepEqual(missing, [], `user-scoped tables WITHOUT "enable row level security": ${missing.join(', ')}`);
});

test('every mobile-readable table has an auth.uid() policy', () => {
  const missing = MOBILE_READABLE.filter(
    (t) => !new RegExp(`create policy[^;]*on public\\.${t}[\\s\\S]*?auth\\.uid\\(\\)`, 'i').test(sql),
  );
  assert.deepEqual(missing, [], `mobile-readable tables WITHOUT an auth.uid() policy: ${missing.join(', ')}`);
});

test('discovery sanity: the known user-scoped tables were found', () => {
  for (const t of ['messages', 'usage_quotas', 'hermes_instances', 'token_usage_events', 'subscriptions', 'hermes_instance_private']) {
    assert.ok(userTables.has(t), `expected ${t} to be discovered as user-scoped`);
  }
});
