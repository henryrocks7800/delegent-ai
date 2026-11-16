import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url);
const envPublicExampleUrl = new URL('.env.public.example', repoRoot);
const envExampleUrl = new URL('.env.example', repoRoot);
const gitignoreUrl = new URL('.gitignore', repoRoot);

// Regression: `.env.public.example` was previously created but silently
// excluded by the broad `.env.*` rule in `.gitignore`. The mobile auth and
// connections readiness tests both `readFileSync` it, so a missing file
// breaks the suite — but the failure mode is opaque (`ENOENT`). These tests
// fail loudly the moment the file disappears or the whitelist regresses.

test('repository ships .env.public.example with the public Expo mobile shape', () => {
  assert.ok(existsSync(envPublicExampleUrl), '.env.public.example must exist at repo root');

  const source = readFileSync(envPublicExampleUrl, 'utf8');
  const assignmentNames = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split('=')[0]);

  for (const required of [
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
    'EXPO_PUBLIC_SIDEKICK_API_BASE_URL',
  ]) {
    assert.ok(
      assignmentNames.includes(required),
      `${required} must be documented in .env.public.example`,
    );
  }

  // Public means public — server-only secret names have no business in the
  // public Expo template. Anything Expo bundles ships inside the APK.
  assert.ok(
    assignmentNames.every((name) => !/(SERVICE_ROLE|SECRET|PRIVATE|BOT_TOKEN)/i.test(name)),
    `public env example must not document private values: ${assignmentNames.join(', ')}`,
  );

  // The bodies should be empty placeholders so this file never carries real
  // credentials in git history.
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    assert.equal(match[2], '', `${match[1]} must be an empty placeholder in .env.public.example`);
  }
});

test('.gitignore explicitly whitelists the public Expo example so it stays in git', () => {
  const gitignore = readFileSync(gitignoreUrl, 'utf8');
  assert.match(
    gitignore,
    /^!\.env\.public\.example$/m,
    '.gitignore must keep `!.env.public.example` whitelisted alongside `!.env.example`',
  );

  // Confirm the running git index agrees with our reading of the file: if a
  // future contributor rewrites `.gitignore`, `git check-ignore` is the
  // source of truth.
  //
  // `git check-ignore -v <path>` exits 0 when *any* gitignore pattern
  // matches (including `!`-prefixed whitelists), and exits 1 when nothing
  // matches. We need to inspect the matching pattern to distinguish ignored
  // from whitelisted: a pattern starting with `!` means the file is *not*
  // ignored, which is the outcome we want.
  let matchedOutput = '';
  let exitStatus = 0;
  try {
    matchedOutput = execFileSync('git', ['check-ignore', '-v', '--no-index', '.env.public.example'], {
      cwd: new URL('.', repoRoot),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    exitStatus = error && typeof error === 'object' && 'status' in error ? error.status : -1;
    if (exitStatus !== 1) throw error;
  }

  if (exitStatus === 1) return; // No matching pattern — file is trackable.
  // Output line shape: "<source>:<line>:<pattern>\t<pathname>".
  const pattern = matchedOutput.split('\t')[0]?.split(':')[2] ?? '';
  assert.ok(
    pattern.startsWith('!'),
    `expected .env.public.example to match a whitelist pattern, got: ${matchedOutput.trim()}`,
  );
});

test('.env.example documents only server-only secrets and never EXPO_PUBLIC_ values', () => {
  const source = readFileSync(envExampleUrl, 'utf8');
  const assignments = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join('\n');
  assert.doesNotMatch(
    assignments,
    /EXPO_PUBLIC_/,
    'EXPO_PUBLIC_* belongs in .env.public.example; .env.example is server-only',
  );
});
