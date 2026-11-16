// EAS pre-install hook: shrink the monorepo to what a MOBILE build needs.
//
// Why: EAS Build clones the whole monorepo and runs `npm ci` at the root,
// which installs every workspace's dependencies, including Next.js
// (apps/web) and wrangler (apps/worker), both of which drag in `sharp`.
// sharp's native binary failed to install on the macOS build worker (build
// e0e2a9ed, 2026-08-04: check.js could not find the darwin-arm64 prebuilt and
// the from-source fallback died on node-addon-api), killing the first iOS
// build during Install dependencies, on a package the app does not use.
//
// Rather than fight sharp, remove the reason it is present: on the EAS worker
// only, rewrite the root workspaces to the two the mobile app consumes and
// drop the root lockfile so npm resolves just that subset. Fresh resolution
// is acceptable here because EAS builds are already fingerprinted, and the
// mobile workspace pins its own dependency versions.
//
// This file only ever runs as the `eas-build-pre-install` hook. Guarded on
// EAS_BUILD so a curious local invocation cannot rewrite the real repo.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.EAS_BUILD !== 'true') {
  console.log('[eas-prune] not an EAS build; refusing to touch the repo.');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const rootPackagePath = join(ROOT, 'package.json');

const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
const before = rootPackage.workspaces;
rootPackage.workspaces = ['apps/mobile', 'packages/shared'];
writeFileSync(rootPackagePath, JSON.stringify(rootPackage, null, 2) + '\n');
console.log(`[eas-prune] workspaces ${JSON.stringify(before)} -> ${JSON.stringify(rootPackage.workspaces)}`);

// REGENERATE the lockfile for the pruned set rather than deleting it. Build
// b96a0e0d proved deletion is wrong twice over: EAS's package-manager
// detection keys off the lockfile, so removing it flipped the install to
// "yarn install --frozen-lockfile", which then failed against a repo that has
// never had a yarn.lock. A pruned package-lock keeps EAS on npm and keeps
// `npm ci` deterministic. --ignore-scripts because this step only needs
// resolution, not native builds; the real install runs scripts as normal.
const lockPath = join(ROOT, 'package-lock.json');
if (existsSync(lockPath)) rmSync(lockPath);
execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', {
  cwd: ROOT,
  stdio: 'inherit',
});
console.log('[eas-prune] regenerated package-lock.json for the pruned workspace set.');
