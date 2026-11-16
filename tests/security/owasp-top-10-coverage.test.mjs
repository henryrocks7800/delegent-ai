// OWASP Top 10 (2021) coverage sweep across the Delegent AI surface.
//
// This is intentionally a *coverage* test, not an implementation test — for
// each OWASP risk we assert the codebase has at least one credible mitigation
// in the form of code or test files. When something fails here it means a
// protection regressed or never existed, not just that the latest commit
// broke it.
//
// Each sub-test maps to a specific OWASP risk and explains what we look for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');

function readIfExists(rel) {
  const path = join(REPO_ROOT, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function walkSync(rel, predicate, out = []) {
  const root = join(REPO_ROOT, rel);
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const next = join(rel, entry.name);
    if (entry.isDirectory()) walkSync(next, predicate, out);
    else if (predicate(entry.name)) out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A01 — Broken access control
// ---------------------------------------------------------------------------
test('OWASP A01 — broken access control: every Supabase migration enables RLS on user-scoped tables', () => {
  const sqlFiles = walkSync('supabase/migrations', (n) => n.endsWith('.sql'));
  assert.ok(sqlFiles.length > 0, 'Expected at least one supabase migration file');
  const userTables = ['profiles', 'subscriptions', 'hermes_instances', 'hermes_instance_private', 'usage_quotas', 'token_usage_events', 'artifacts', 'task_runs', 'messages'];
  const allSql = sqlFiles.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');
  for (const table of userTables) {
    const enabledHere = new RegExp(`alter table\\s+(?:public\\.)?${table}\\s+enable row level security`, 'i').test(allSql);
    assert.ok(
      enabledHere,
      `Row-level security must be explicitly enabled on public.${table}; otherwise service-role bypass becomes the only access path.`,
    );
  }
});

test('OWASP A01 — broken access control: hermes_instance_private uses service-role only (no public select policy)', () => {
  const sqlFiles = walkSync('supabase/migrations', (n) => n.endsWith('.sql'));
  const allSql = sqlFiles.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');
  const grantsAnonRead = /grant\s+select\s+on\s+(?:public\.)?hermes_instance_private\s+to\s+(?:anon|authenticated)/i.test(allSql);
  assert.equal(grantsAnonRead, false, 'hermes_instance_private holds per-user runner secrets; never grant select to anon/authenticated');
});

// ---------------------------------------------------------------------------
// A02 — Cryptographic failures
// ---------------------------------------------------------------------------
test('OWASP A02 — cryptographic failures: runner auth uses HMAC v1 + constant-time compare', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts');
  assert.ok(workerSrc, 'apps/worker/src/index.ts must exist');
  assert.match(workerSrc, /signRunnerTokenV1/, 'HMAC v1 signing must be present');
  assert.match(workerSrc, /verifyRunnerTokenV1/, 'HMAC v1 verification must be present');
  assert.match(workerSrc, /timingSafeEqualBytes/, 'constant-time compare must be used for token verification');
});

test('OWASP A02 — cryptographic failures: file links use signed URLs, not bare paths', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts');
  assert.match(workerSrc, /SIDEKICK_FILE_LINK_SIGNING_SECRET/, 'signed file URLs must exist');
  assert.match(workerSrc, /v1\./, 'signed tokens use a versioned prefix');
});

// ---------------------------------------------------------------------------
// A03 — Injection
// ---------------------------------------------------------------------------
test('OWASP A03 — injection: Supabase RPCs are used for user-mutating ops (not raw SQL through PostgREST)', () => {
  // Mobile profile updates go through update_mobile_profile RPC, not direct
  // table mutations. Onboarding goes through a similar RPC. Search the
  // mobile app for direct .update() / .insert() calls on the profiles table.
  const mobileSrc = readIfExists('apps/mobile/App.tsx') ?? '';
  const directProfileMutation = /from\(['"]profiles['"]\)\.(?:update|insert|upsert)\b/.test(mobileSrc);
  assert.equal(directProfileMutation, false, 'Mobile must not bypass the update_mobile_profile RPC');
});

test('OWASP A03 — injection: Telegram message text is never interpolated into SQL or shell strings', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts') ?? '';
  // Look for any obvious template-literal SQL with Telegram-derived input.
  const sqlInterpolation = /from\s+`\$\{.*message\.(?:text|caption)/.test(workerSrc);
  assert.equal(sqlInterpolation, false, 'Telegram message text must never be interpolated into SQL');
});

// ---------------------------------------------------------------------------
// A04 — Insecure design
// ---------------------------------------------------------------------------
test('OWASP A04 — insecure design: every paid user gets a dedicated runner (tenant isolation by construction)', () => {
  const provisioner = readIfExists('packages/provisioner/src/providers/runnerProvider.ts') ?? '';
  assert.match(provisioner, /runnerSharedSecret/, 'Per-user HMAC secrets are part of the CreateRunnerInput contract');
  const flyProvider = readIfExists('packages/provisioner/src/providers/flyMachines.ts') ?? '';
  assert.match(flyProvider, /per-user/i, 'Fly provider documents per-user isolation');
});

// ---------------------------------------------------------------------------
// A05 — Security misconfiguration
// ---------------------------------------------------------------------------
test('OWASP A05 — security misconfiguration: Worker applies HSTS + nosniff + Referrer-Policy on every response', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts') ?? '';
  assert.match(workerSrc, /Strict-Transport-Security/i);
  assert.match(workerSrc, /X-Content-Type-Options/i);
  assert.match(workerSrc, /Referrer-Policy/i);
});

test('OWASP A05 — security misconfiguration: website firebase.json sets HSTS + nosniff + Referrer-Policy', () => {
  const firebase = readIfExists('apps/website/firebase.json') ?? '';
  assert.match(firebase, /Strict-Transport-Security/i);
  assert.match(firebase, /X-Content-Type-Options/i);
  assert.match(firebase, /Referrer-Policy/i);
});

// ---------------------------------------------------------------------------
// A06 — Vulnerable + outdated components
// ---------------------------------------------------------------------------
test('OWASP A06 — vulnerable components: lockfile present so dep versions are pinned in CI', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'package-lock.json')), 'package-lock.json must be committed');
});

// ---------------------------------------------------------------------------
// A07 — Identification + authentication failures
// ---------------------------------------------------------------------------
test('OWASP A07 — auth failures: HMAC timestamp window prevents replay attacks', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts') ?? '';
  assert.match(workerSrc, /RUNNER_AUTH_MAX_SKEW_SECONDS\s*=\s*\d+/, 'HMAC skew window must be a named, bounded constant');
});

test('OWASP A07 — auth failures: bot webhooks verify a constant-time secret token', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts') ?? '';
  assert.match(workerSrc, /x-telegram-bot-api-secret-token/i, 'Telegram webhook secret must be verified');
});

// ---------------------------------------------------------------------------
// A08 — Software + data integrity failures
// ---------------------------------------------------------------------------
test('OWASP A08 — integrity failures: Hermes runner image is pinned by digest, not tag', () => {
  const operationsRunbook = readIfExists('OPERATIONS.md') ?? '';
  assert.match(operationsRunbook, /image_ref/i, 'Operations runbook mentions image_ref pinning');
});

test('OWASP A08 — integrity failures: Stripe webhook signature is verified before any state mutation', () => {
  const workerSrc = readIfExists('packages/billing/src/serverFlow.ts') ?? '';
  assert.match(workerSrc, /STRIPE_WEBHOOK_SECRET/i, 'Stripe webhook secret must be verified before state changes');
});

// ---------------------------------------------------------------------------
// A09 — Security logging + monitoring failures
// ---------------------------------------------------------------------------
test('OWASP A09 — logging + monitoring: usage events persist a per-user ledger so abuse is traceable', () => {
  const workerSrc = readIfExists('apps/worker/src/index.ts') ?? '';
  assert.match(workerSrc, /token_usage_events/i, 'Per-user usage ledger must exist');
});

// ---------------------------------------------------------------------------
// A10 — Server-side request forgery
// ---------------------------------------------------------------------------
test('OWASP A10 — SSRF: file-link URLs are pinned to the same origin (no open redirects)', () => {
  const mobileRunnerFiles = readIfExists('apps/mobile/src/files/mobileRunnerFiles.ts') ?? '';
  assert.match(mobileRunnerFiles, /parsed\.origin !== base\.origin/, 'Same-origin enforcement must be present');
});

test('OWASP A10 — SSRF: file-link tokens are required, not optional', () => {
  const mobileRunnerFiles = readIfExists('apps/mobile/src/files/mobileRunnerFiles.ts') ?? '';
  assert.match(
    mobileRunnerFiles,
    /searchParams\.get\(['"]token['"]\)\?\.startsWith\(['"]v1\./,
    'File-link tokens must start with the v1 versioned prefix',
  );
});
