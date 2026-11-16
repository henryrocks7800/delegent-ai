// Brand readiness: no user-facing "Coworker AI" strings remain.
//
// Defect 14 (2026-05-14 production-mobile-ui audit) called out that a Stripe
// logout/portal/return page still said "Coworker AI" instead of "Delegent AI".
// This scanner walks the repo for the literal string and fails if a non-
// allowlisted, user-facing file still contains it.
//
// The allowlist below is deliberately narrow and explicit. Each entry has a
// short comment explaining *why* the string is allowed to remain. Anything
// outside that list MUST flip to "Delegent AI".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Directories never scanned (vendored, build output, irrelevant).
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.expo',
  'dist',
  'build',
  '.gradle',
  '.idea',
  'coverage',
  'allure-results',
  'allure-report',
  '.wrangler',
  '__pycache__',
  '.pytest_cache',
  '.claude',
  'evidence', // generated provider evidence dumps may include redacted historical names
]);

// File extensions where the string would only ever be visible to engineers
// (build configs, lockfiles, vendored binary assets). The scanner skips them.
const SKIP_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.lottie',
  '.json', // package-lock.json + generated json — explicit doc indexes covered below
  '.lock',
  '.snap',
  '.map',
  '.pdf',
]);

// Files that are deliberately allowed to keep the historical brand. Each row
// names a file (path relative to repo root) and the reason it is exempt.
const ALLOWLIST = [
  // ---- internal naming (asset filenames, scripts, config templates) ----
  { path: '.env.public.example', reason: 'env-var template — references historical asset filename, not user-visible copy' },
  { path: 'CLAUDE.md', reason: 'agent-instructions file mentioning legacy package names' },
  { path: 'apps/mobile/assets/coworker-ai-signal-droid.svg', reason: 'asset filename (internal); content is SVG markup' },
  { path: 'apps/mobile/scripts/generate-coworker-brand-assets.mjs', reason: 'internal script that generates brand assets — script name is historical' },
  { path: 'scripts/delegent-doc-rename.sh', reason: 'rename helper script — the historical string is the source-of-truth pattern it removes' },
  { path: 'scripts/mission-evidence.mjs', reason: 'evidence-tooling script that references historical evidence directories' },
  { path: 'coworker-ai-design-principles.md', reason: 'design doc kept under its historical filename for git history continuity' },
  { path: 'desktop/docs/parity-specs/shared-content.md', reason: 'parity spec that documents this very brand ban and must quote the banned literal to describe it' },
  { path: '.github/ISSUE_TEMPLATE/bug_report.yml', reason: 'engineer-facing GitHub issue template' },
  { path: '.github/ISSUE_TEMPLATE/feature_request.yml', reason: 'engineer-facing GitHub issue template' },
  { path: '.github/ISSUE_TEMPLATE/config.yml', reason: 'engineer-facing GitHub issue template' },

  // ---- internal historical docs (rolled forward separately) ----
  // Many pre-launch planning docs were moved to docs/archive/2026-05-28/
  // on the v1.3.2 cleanup; they're now allow-listed via the
  // `docs/archive/` prefix below.
  // docs/ROADMAP.md was retired to docs/archive/2026-08-03-prelaunch-trackers/
  // on 2026-08-03 (it was a prototype-to-launch checklist for a product that
  // has launched), so the `docs/archive/` prefix below now covers it. The
  // prototype integration roadmap followed on 2026-09-30 (the docs scrub).
  { path: 'docs/ANDROID_TEST_PACK.md', reason: 'internal test pack doc' },

  // ---- maestro flow tolerance (Stripe-dashboard rename is a separate manual step) ----
  {
    path: 'apps/mobile/android/integration/maestro/production/billing.upgrade_plan_portal.yaml',
    reason: 'Stripe customer-portal product name may still show the historical brand until the dashboard is renamed; the assertion accepts either',
  },

  // ---- the scanner itself ----
  {
    path: 'tests/release-gate/brand-strings-scan.test.mjs',
    reason: 'this scanner file naturally contains the literal string being matched against',
  },
  {
    path: 'tests/release-gate/README.md',
    reason: 'category README documents the brand-strings-scan and necessarily mentions the legacy string',
  },
  {
    path: 'tests/README.md',
    reason: 'master tests README references the brand-strings test',
  },

  // ---- test files that pin allow-listed historical strings ----
  {
    path: 'packages/provisioner/test/provisioner.test.mjs',
    reason: 'pins the SQL migration 0009 historical "Coworker AI is online." string; the SQL itself is allow-listed under supabase/migrations/',
  },
  {
    path: 'apps/website/test/website-content-scanner.test.mjs',
    reason: 'sibling scanner that asserts the historical brand string is absent from the website — necessarily contains the literal it scans for',
  },

  // ---- internal historical docs that quote the legacy brand in audit/rollout context ----
  { path: 'docs/mobile-lab/WEBSITE_MOBILE.md', reason: 'mobile-lab acceptance criterion that requires the absence of the historical brand' },

  // ---- D39 — Stripe-dashboard rename is operator-only, so the verifier scripts must quote the legacy string verbatim ----
  { path: 'scripts/internal/verify-stripe-product-brand.mjs', reason: 'operator-runnable script that greps Stripe products for the legacy label — must contain the string it scans for' },
  { path: 'scripts/internal/rename-stripe-products.mjs', reason: 'operator-runnable Stripe migration script that must quote the legacy product label it replaces' },
  { path: 'scripts/mobile-lab/checks/assert-no-legacy-brand.sh', reason: 'mobile-lab verifier script that must quote the legacy brand string it scans for in UI hierarchy dumps' },
  { path: 'apps/mobile/android/integration/maestro/spec/NEWUSER-01.full_new_user_journey.yaml', reason: 'Maestro release flow pins a negative assertion against the legacy brand string on Stripe Checkout' },
];

// Allowlist whole subtrees for archival/historical content.
const ALLOWLIST_PREFIXES = [
  { prefix: 'docs/archive/', reason: 'archived historical docs — preserved verbatim under docs/archive/' },
  { prefix: 'docs/mission/', reason: 'mission evidence archive — historical artifacts only' },
  { prefix: 'docs/mobile-lab/maestro-evidence/', reason: 'historical Maestro evidence dumps — the failing assertions naturally include the brand-matrix regex' },
  { prefix: 'docs/plans/', reason: 'historical planning docs' },
  { prefix: 'docs/reports/', reason: 'internal generated checkpoint reports preserved as historical evidence' },
  { prefix: 'releases/', reason: 'historical release plans preserved verbatim under releases/' },
  { prefix: 'sketches/', reason: 'design sketches preserved verbatim for git history' },
  { prefix: 'supabase/migrations/', reason: 'SQL migration comments preserved verbatim' },
  { prefix: 'branding_options/', reason: 'design exploration kept verbatim' },
];

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name);
}

function shouldSkipFile(relativePath) {
  const lower = relativePath.toLowerCase();
  for (const ext of SKIP_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isAllowlisted(relativePath) {
  // Normalize Windows separators for consistent matching when this test runs
  // from a Windows-side worktree.
  const normalized = relativePath.split('\\').join('/');
  for (const entry of ALLOWLIST) {
    if (normalized === entry.path) return entry;
  }
  for (const entry of ALLOWLIST_PREFIXES) {
    if (normalized.startsWith(entry.prefix)) return entry;
  }
  return null;
}

function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      // Consented mailbox trial evidence is private data, never shipping copy.
      // Exclude before reading, so assertion output cannot quote an email.
      const relativeDir = relative(REPO_ROOT, join(dir, entry.name)).split('\\').join('/');
      if (relativeDir === 'artifacts/typesafe/private') continue;
      collectFiles(join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

test('no user-facing "Coworker AI" strings remain outside the explicit allowlist', () => {
  const files = collectFiles(REPO_ROOT);
  const offenders = [];

  for (const absPath of files) {
    const rel = relative(REPO_ROOT, absPath);
    if (shouldSkipFile(rel)) continue;
    if (isAllowlisted(rel)) continue;

    // Skip very large files (we never expect product strings in giant assets).
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      continue;
    }
    if (size > 2_000_000) continue;

    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('Coworker AI')) continue;

    // Each match is reported with its first occurrence line for debuggability.
    const lines = content.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => line.includes('Coworker AI'));
    offenders.push(`${rel.split('\\').join('/')}:${lineIndex + 1}: ${lines[lineIndex].trim().slice(0, 160)}`);
  }

  if (offenders.length > 0) {
    const message = [
      'Found user-facing "Coworker AI" strings in non-allowlisted files.',
      'Either rebrand them to "Delegent AI" or, if the string is genuinely',
      'internal/historical (asset filename, script name, archived doc),',
      'add an explicit allowlist entry with a reason in this test file.',
      '',
      ...offenders,
    ].join('\n');
    assert.fail(message);
  }
});

test('allowlist entries reference real files (no stale exemptions)', () => {
  const missing = [];
  for (const entry of ALLOWLIST) {
    const abs = join(REPO_ROOT, entry.path);
    try {
      statSync(abs);
    } catch {
      missing.push(entry.path);
    }
  }
  assert.deepEqual(missing, [], `Allowlist references missing files: ${missing.join(', ')}`);
});

test('allowlist entries each carry a written reason', () => {
  for (const entry of [...ALLOWLIST, ...ALLOWLIST_PREFIXES]) {
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 12,
      `Allowlist entry for ${entry.path ?? entry.prefix} needs a written justification`,
    );
  }
});
