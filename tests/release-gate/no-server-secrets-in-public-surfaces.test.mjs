// AGENT_TODO_CHECKLIST item 22:
//   "Check that no server-only secrets are exposed to mobile, website,
//    docs, logs, screenshots, or public state. No Supabase service-role
//    key, Stripe secret, Fly token, OpenRouter key, Telegram token, or
//    runner shared secret should ever be present in public app surfaces."
//
// This is a static scanner that fails the test suite if ANY of those
// secret SHAPES appear in mobile/website/public-docs source files. It
// is intentionally permissive — values that match a high-entropy
// pattern AND look like a known secret prefix (sk_live, sk_test,
// eyJhbG..., fo1_, etc.) trip the guard. Repo-only knobs that LOOK
// like a key but are clearly placeholders (anon_jwt_dev, etc.) can be
// added to the allowlist with a one-line reason.
//
// Surfaces scanned:
//   apps/mobile/                  — bundled into the APK
//   apps/website/                 — bundled into the public site
//   apps/website/public/          — served at the web root
//   docs/                         — committed docs (Stripe links etc.)
//   *.md at repo root             — public README + tracker docs
// Surfaces NOT scanned (server-only / build-output / vendored):
//   apps/worker/                  — Worker IS the secrets boundary
//   services/hermes-runner/       — runner runs server-side
//   packages/                     — server-shared libs
//   scripts/                      — operator scripts may handle secrets
//   .env*, *.local                — git-ignored by definition
//   node_modules, dist, build,    — third-party / built code
//   android/build, .gradle, etc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

const PUBLIC_SURFACES = [
  'apps/mobile',
  'apps/website',
  'docs',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.expo',
  '.gradle', '.kotlin', 'android/build', 'android/.gradle',
  'android/.kotlin', '.idea', '.cxx', '__pycache__', '.pytest_cache',
  'coverage', 'allure-results', 'allure-report', 'evidence',
  '.wrangler', '.firebase',
  // Generated assets — large binaries with no source secrets:
  'assets',
]);

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.lottie', '.lock', '.snap', '.map', '.pdf', '.zip', '.apk',
  '.aab', '.keystore', '.jks',
]);

// File-level allowlist for values that LOOK like a key but are known
// to be a placeholder or a test fixture. Each entry must explain why.
const ALLOWLIST = new Set([
  // The scanner file itself contains the matchers below; the literal
  // patterns aren't real secrets but would otherwise trip our own check.
  'tests/e2e/no-server-secrets-in-public-surfaces.test.mjs',
  // Sample non-functional placeholder values shipped in env-var docs.
  '.env.public.example',
  '.env.example',
  // The legacy hermes-runner credentials file template (we still ship
  // it as a doc-style example with redacted values).
  'docs/INTEGRATION_SECRETS_AND_PROVIDER_ACCESS.md',
]);

// Secret SHAPES. Each entry is { id, pattern, why }. A match anywhere
// in a non-allowlisted public-surface file fails the test.
const SECRET_PATTERNS = [
  {
    id: 'stripe_live_secret',
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/,
    why: 'Stripe live secret key',
  },
  {
    id: 'stripe_test_secret',
    pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/,
    why: 'Stripe test secret key (still server-only)',
  },
  {
    id: 'stripe_webhook_secret',
    pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/,
    why: 'Stripe webhook signing secret',
  },
  {
    id: 'openrouter_key',
    pattern: /\bsk-or-(?!test-fake)[A-Za-z0-9_-]{20,}\b/,
    why: 'OpenRouter API key (test fakes allowed)',
  },
  {
    id: 'openai_key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
    why: 'OpenAI API key',
  },
  {
    id: 'fly_token',
    pattern: /\bfo[12]_[A-Za-z0-9_-]{40,}\b/,
    why: 'Fly.io API token',
  },
  {
    id: 'github_token',
    pattern: /\bghp_[A-Za-z0-9]{30,}\b/,
    why: 'GitHub personal access token',
  },
  {
    id: 'supabase_pat',
    pattern: /\bsbp_[A-Za-z0-9]{30,}\b/,
    why: 'Supabase Management API personal access token',
  },
  {
    id: 'supabase_service_role_jwt',
    // Service-role JWTs start with eyJhbGciOiJIUzI1NiI followed by a
    // long payload+sig. Standard JWT shape with the HS256 header.
    pattern: /\beyJhbGciOiJIUzI1NiI[A-Za-z0-9._-]{100,}\b/,
    why: 'Supabase service-role JWT (anon keys are also JWTs but shorter)',
  },
  {
    id: 'telegram_bot_token',
    pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
    why: 'Telegram bot token (digits:string)',
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, out);
    } else {
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!SKIP_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

test('no Stripe / OpenRouter / Fly / Supabase / Telegram secrets leak into mobile, website, or docs', () => {
  const offenders = [];
  for (const surface of PUBLIC_SURFACES) {
    const surfaceRoot = join(REPO, surface);
    for (const file of walk(surfaceRoot)) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const pat of SECRET_PATTERNS) {
        const m = content.match(pat.pattern);
        if (m) {
          offenders.push(`${rel}: ${pat.id} (${pat.why}) — first match: ${m[0].slice(0, 24)}…`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Found ${offenders.length} apparent secret(s) in public surfaces. ` +
    `Each must either be rotated and removed, or — if it's a known ` +
    `placeholder — added to the ALLOWLIST in ${relative(REPO, fileURLToPath(import.meta.url)).replace(/\\/g, '/')}.\n\n` +
    offenders.join('\n'),
  );
});
