// Spec-driven regression: an automated provisioner scheduler MUST exist.
//
// Source of truth: docs/architecture/SYSTEM_ARCHITECTURE.md §6 (sign-up
// sequence diagram, step 14: "Cron tick — every few minutes" and step 18:
// "Readiness loop ticks until ready") and §13 (provisioning lifecycle state
// machine, which requires the cron to advance `queued → provisioning`).
//
// Why this regression exists: in the 2026-05-21 defect hunt we found that
// every paying user was sitting at `hermes_instances.status = queued`
// forever because no scheduler was deployed. The Cloudflare Worker had no
// `scheduled()` handler, the wrangler.toml had no [triggers.crons] block,
// there were no GitHub Actions workflows, and OPERATIONS_TRACKER.md J3
// asserted the cron was wired when it wasn't. None of the existing 700+
// tests caught it because they all stub the provider/store in-process.
//
// This test fails CLOSED: any deployment that ships without a scheduler
// will fail this assertion. Pick ONE of the three accepted schedulers:
//   1. GitHub Actions workflow under .github/workflows/ with a cron schedule
//      that runs `series4:provision-once`
//   2. Cloudflare Worker `scheduled()` handler PLUS a [triggers.crons] block
//      in apps/worker/wrangler.toml
//   3. Fly cron Machine declared in a tracked manifest (e.g. fly.toml or
//      similar) — recognised here by a `.fly/cron-*.toml` convention.
//
// At least one of those three must be present; the test prints which path
// was matched so deploy reviewers can confirm. The actual deployment of
// the scheduler (e.g. setting GitHub Actions secrets) is operator work
// outside the repo — but this contract guarantees the *code-level* shape
// is committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function readSafe(rel) {
  try { return readFileSync(join(REPO, rel), 'utf8'); } catch { return null; }
}

function listSafe(rel) {
  try { return readdirSync(join(REPO, rel)); } catch { return []; }
}

function fileExists(rel) {
  try { return statSync(join(REPO, rel)).isFile(); } catch { return false; }
}

// --- 1. GitHub Actions ------------------------------------------------------

function detectGitHubActionsCron() {
  const workflows = listSafe('.github/workflows').filter((n) => /\.ya?ml$/i.test(n));
  for (const name of workflows) {
    const body = readSafe(`.github/workflows/${name}`);
    if (!body) continue;
    // Must declare a cron schedule AND invoke the provision-once script.
    const hasSchedule = /^\s*on:[\s\S]*?\bschedule:\s*\n[\s\S]*?-\s*cron:\s*['"][^'"\n]+['"]/m.test(body);
    const hasProvisionOnce = /(series4:provision-once|series4-fly-provision-once\.mjs)/.test(body);
    if (hasSchedule && hasProvisionOnce) {
      return { path: `.github/workflows/${name}` };
    }
  }
  return null;
}

function detectGitHubActionsAccountDeletionCron() {
  const workflows = listSafe('.github/workflows').filter((n) => /\.ya?ml$/i.test(n));
  for (const name of workflows) {
    const body = readSafe(`.github/workflows/${name}`);
    if (!body) continue;
    const hasSchedule = /^\s*on:[\s\S]*?\bschedule:\s*\n[\s\S]*?-\s*cron:\s*['"][^'"\n]+['"]/m.test(body);
    const hasAccountDeletion = /series4:account-deletion-once|series4-account-deletion-once\.mjs/.test(body);
    const exposesManualDispatch = /options:\s*\n[\s\S]*?-\s*account-deletion-once/.test(body);
    const allowsFlyDestroy = /SIDEKICK_ALLOW_FLY_TEST_DESTROY:\s*['"]true['"]/.test(body);
    if (hasSchedule && hasAccountDeletion && exposesManualDispatch && allowsFlyDestroy) {
      return { path: `.github/workflows/${name}` };
    }
  }
  return null;
}

// --- 2. Cloudflare Worker scheduled() trigger -------------------------------

function detectCloudflareWorkerCron() {
  const wrangler = readSafe('apps/worker/wrangler.toml');
  const worker = readSafe('apps/worker/src/index.ts');
  if (!wrangler || !worker) return null;
  const hasCronBlock = /\[\s*triggers\s*\]\s*[\s\S]*?\bcrons\s*=\s*\[/.test(wrangler)
    || /\[\s*triggers\.crons\s*\]/.test(wrangler);
  const hasScheduledHandler = /\bscheduled\s*\(\s*[^)]*ScheduledController|async\s+scheduled\s*\(/.test(worker);
  const callsProvisionOnce = /processNextSeries4FlyProvisioningJob/.test(worker);
  if (hasCronBlock && hasScheduledHandler && callsProvisionOnce) {
    return { path: 'apps/worker/{wrangler.toml,src/index.ts}' };
  }
  return null;
}

// --- 3. Fly cron Machine (tracked manifest) ---------------------------------

function detectFlyCronMachine() {
  const candidates = [
    'fly.toml',
    '.fly/cron.toml',
    '.fly/series4-cron.toml',
    'services/series4-cron/fly.toml',
  ];
  for (const rel of candidates) {
    const body = readSafe(rel);
    if (!body) continue;
    const hasCronBlock = /\[\s*processes\s*\.\s*\w+\s*\][\s\S]*?(cron|schedule)/i.test(body)
      || /\bschedule\s*=\s*['"][^'"\n]+['"]/i.test(body);
    if (hasCronBlock && /(series4:provision-once|series4-fly-provision-once)/.test(body)) {
      return { path: rel };
    }
  }
  return null;
}

// 2026-09-18 (Alex): every account runs on the agent engine (apps/agent), the
// per-user Fly runners were destroyed and the Fly account closed. A scheduled
// provisioner is therefore no longer required; it is now the OPPOSITE that is
// guarded. A scheduled `series4:provision-once` against a closed Fly account
// would fail every hour and, worse, would mean somebody re-wired runner
// provisioning without a deliberate decision to bring the runner model back.
// The scripts and the provisioner package stay in the repo for that day; the
// golden image is archived at ghcr.io/delegent-ai-ltd/delegent-runner-images.
test('[series4-cron] no scheduled runner provisioner is committed (runners retired 2026-09-18)', () => {
  const matches = [
    detectGitHubActionsCron(),
    detectCloudflareWorkerCron(),
    detectFlyCronMachine(),
  ].filter(Boolean);

  assert.equal(
    matches.length,
    0,
    [
      'A scheduled runner provisioner is committed again:',
      ...matches.map((m) => `  - ${m.path}`),
      'The Fly runner fleet was retired on 2026-09-18 and the Fly account closed.',
      'Bringing the runner model back is a deliberate decision (restore the image',
      'from the GHCR archive in services/hermes-runner/RUNNER_IMAGE.lock.json,',
      'reopen a Fly org, re-add the steps to series4-cron.yml), not a side effect.',
    ].join('\n'),
  );
});

// Sanity guard: even if the workflow exists it must have non-trivial cadence
// (architecture §6 says "every few minutes"; an hourly cron would make UX
// indistinguishable from no cron from the user's POV).
test('[series4-cron] GitHub Actions cadence (if used) ticks at least every 15 minutes', () => {
  const ghMatch = detectGitHubActionsCron();
  if (!ghMatch) return; // the previous test will catch absence; nothing to gate here
  const body = readSafe(ghMatch.path) ?? '';
  const cronLines = [...body.matchAll(/-\s*cron:\s*['"]([^'"\n]+)['"]/g)].map((m) => m[1]);
  assert.ok(cronLines.length > 0, `expected at least one cron line in ${ghMatch.path}`);
  // Parse the minute field. Accept `*/N` patterns; fail anything coarser
  // than every-15-min (since architecture said "every few minutes").
  for (const expr of cronLines) {
    const [minuteField] = expr.trim().split(/\s+/);
    // Skip lines that are clearly NOT the provisioner tick (e.g. hourly
    // grace-expiry on the 0th minute is intentional).
    if (/^0$/.test(minuteField)) continue;
    if (minuteField === '*') continue;
    const interval = /^\*\/(\d+)$/.exec(minuteField);
    if (interval) {
      assert.ok(
        Number(interval[1]) <= 15,
        `cron cadence ${expr} is slower than every 15 minutes; architecture §6 asks for "every few minutes"`,
      );
    }
  }
});

test('[series4-cron] account-deletion processor is scheduled so Delete account does not depend on manual teardown', () => {
  const match = detectGitHubActionsAccountDeletionCron();

  assert.ok(
    match,
    [
      'No automated account-deletion processor scheduler is committed in the repo.',
      'R-BILL-12 promises that account deletion triggers guaranteed Fly app teardown within 24 hours.',
      'The one-shot command exists, but without a scheduled invocation every delete request can remain',
      '`account_deletion_requests.status = requested` until an operator manually runs',
      '`npm run series4:account-deletion-once`.',
      '',
      'Add a scheduled workflow job (or equivalent hosted scheduler) that runs',
      '`npm run series4:account-deletion-once`, exposes a workflow_dispatch option,',
      'and sets SIDEKICK_ALLOW_FLY_TEST_DESTROY=true for the destructive Fly teardown path.',
    ].join('\n'),
  );

  console.log(`[series4-cron] account-deletion scheduler detected: ${match.path}`);
});
