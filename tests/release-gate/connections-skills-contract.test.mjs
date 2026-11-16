import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Connections <-> skills contract.
//
// The Connections screen (brokered OAuth via the Worker) and the curated
// skills library both know about the same providers, and every incident in
// this family came from them drifting apart:
//
//   2026-07-25/28  cloud-storage skill taught a user to create a Dropbox app
//                  and paste a token while the brokered Dropbox connection was
//                  already live. Two flat "I cannot access your Dropbox"
//                  replies to the owner's own account.
//   2026-08-01     Slack went live with no recipe; the agent ran `which
//                  slack`, found nothing, and told a paying user the
//                  connection was not authenticating.
//   2026-08-01     Outlook and Teams went live the same day the recipes skill
//                  was written and were NOT in it; found only by hand-audit.
//   2026-08-02     The agent forgot the sh -c wrapper, got not_authed, and
//                  reported a healthy connection as "a real platform gap".
//
// This test derives the provider list FROM THE WORKER SOURCE, so a provider
// going live in code without skill support fails CI instead of failing a
// customer. No live calls; static, fast, deterministic.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const workerOauthSource = readFileSync(join(ROOT, 'apps', 'worker', 'src', 'connections-oauth.ts'), 'utf8');
const SKILLS_DIR = join(ROOT, 'services', 'hermes-runner', 'skills', 'delegent', 'skills');
const connectedServicesMd = readFileSync(join(SKILLS_DIR, 'connected-services', 'SKILL.md'), 'utf8');

// Providers whose OAuth plumbing exists in the Worker but that are NOT yet
// live for users (secrets deliberately withheld pending provider review), so
// connected-services carries no recipe for them yet. The companion assertion
// below fails the moment a recipe IS added while the provider still sits here,
// so this list cannot rot into a permanent exemption: shipping the provider
// means removing it from here and adding the recipe in the same change.
// 2026-08-05: google_calendar came OFF this list while still awaiting Google's
// verification, which is a deliberate change to the rule above. The card is
// already shipped and merely hidden by availability gating, so the day Google
// approves, a secret lands in Doppler and the provider goes live with NO code
// change and NO chance to add a recipe first. "Remember to write it at approval
// time" is exactly how Slack shipped recipe-less. The recipe is agent-facing
// instructions, not a user-facing claim, and it opens by telling the agent the
// card is dark and to say so plainly, so nothing is over-promised by it
// existing early.
// yahoo_mail (2026-09-25): read by the agent engine itself (apps/agent/src/inboxYahoo.ts,
// Money Finder), not through a runner recipe, and dark until Yahoo approves our
// Mail API access. It stays pending while it has no card.
const PENDING_PROVIDERS = new Set(['yahoo_mail']);

// Scrape the PROVIDERS registry keys from the Worker source. The registry is
// the single map every OAuth route resolves through, so its keys ARE the
// provider surface. The regex is anchored to the declaration to avoid matching
// unrelated object literals.
function workerProviderIds() {
  const decl = workerOauthSource.match(/const PROVIDERS[^=]*=\s*\{([\s\S]*?)\};/);
  assert.ok(decl, 'could not find the PROVIDERS registry in connections-oauth.ts; if it was renamed, update this test');
  const ids = [...decl[1].matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gm)].map((m) => m[1]);
  // Sanity check on the parse, not on how many providers we ship. This was
  // `>= 5` while we brokered six OAuth providers ourselves. On 2026-09-03 all
  // six moved to Composio and FreeAgent is the only native provider left, so
  // the floor is 1: Composio lists a freeagent toolkit with zero actions, which
  // means it can never move and this number can never legitimately reach 0.
  assert.ok(ids.length >= 1, `PROVIDERS registry parse looks broken: found ${ids.length} ids (${ids.join(', ')})`);
  return ids;
}

test('every live provider in the Worker has a recipe in connected-services', () => {
  const missing = [];
  for (const id of workerProviderIds()) {
    if (PENDING_PROVIDERS.has(id)) continue;
    // A recipe means the agent is told the exact call shape: a
    // `delegent-connect run --service <id>` example must exist for the id.
    const recipe = new RegExp(`delegent-connect run --service ${id}\\b`);
    if (!recipe.test(connectedServicesMd)) missing.push(id);
  }
  assert.deepEqual(
    missing,
    [],
    `providers live in the Worker but with NO recipe in connected-services/SKILL.md: ${missing.join(', ')}. ` +
      'This is the Slack/Outlook/Teams failure repeating: the agent will hunt for a CLI that does not exist ' +
      'and report the connection as broken. Add the recipe (call shape, wrapper, gotchas) before shipping the provider.',
  );
});

test('pending providers must NOT have recipes yet (keeps the pending list honest)', () => {
  const stale = [];
  for (const id of PENDING_PROVIDERS) {
    if (new RegExp(`delegent-connect run --service ${id}\\b`).test(connectedServicesMd)) stale.push(id);
  }
  assert.deepEqual(
    stale,
    [],
    `these providers have recipes but are still marked pending in this test: ${stale.join(', ')}. ` +
      'Remove them from PENDING_PROVIDERS so the parity contract starts guarding them.',
  );
});

test('every delegent-connect run example is wrapped in sh -c / bash -c', () => {
  // The token is injected into the CHILD process environment; a bare
  // $DELEGENT_ACCESS_TOKEN on the command line is expanded by the agent's own
  // shell (which does not hold it) and the provider sees an empty bearer.
  // That failure reads exactly like a broken connection and was reported to a
  // paying user as one on 2026-08-02.
  const offenders = [];
  for (const dir of readdirSync(SKILLS_DIR)) {
    const mdPath = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const md = readFileSync(mdPath, 'utf8');
    for (const m of md.matchAll(/delegent-connect run --service \S+ --(.*)/g)) {
      const rest = m[1];
      if (!/\s(sh|bash) -c\b/.test(` ${rest}`)) {
        offenders.push(`${dir}: ${m[0].slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `delegent-connect run examples missing the sh -c wrapper (the not_authed trap):\n  ${offenders.join('\n  ')}`,
  );
});

test('skills that name a brokered provider check the brokered route before any manual setup', () => {
  // The Dropbox incident: a skill led with "create an app in the provider's
  // console" while the brokered connection already existed. The rule since the
  // 2026-08-02 audit: any skill whose body names a brokered provider must
  // instruct `delegent-connect list` BEFORE any manual-credential path, so the
  // agent discovers the existing connection first.
  const providerWords = /\b(dropbox|slack|github|google drive|outlook|microsoft teams)\b/i;
  const manualSetup = /(app console|developer console|create (an? )?(api key|oauth (client|app))|generate (an? )?access token)/i;
  const offenders = [];
  for (const dir of readdirSync(SKILLS_DIR)) {
    const mdPath = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const md = readFileSync(mdPath, 'utf8');
    if (!providerWords.test(md)) continue;
    const listAt = md.search(/delegent-connect list/);
    if (listAt === -1) {
      offenders.push(`${dir}: names a brokered provider but never checks delegent-connect list`);
      continue;
    }
    const manual = manualSetup.exec(md);
    if (manual && md.indexOf(manual[0]) < listAt) {
      offenders.push(`${dir}: manual setup ("${manual[0]}") appears BEFORE the delegent-connect list check`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `brokered-first rule violated (the "create a Dropbox app" incident recurs through these):\n  ${offenders.join('\n  ')}`,
  );
});

test('tripwire: a brokered Gmail/Google-mail provider must retire safe-inbox-manager manual OAuth', () => {
  // safe-inbox-manager currently walks the user through creating their own
  // Google Cloud OAuth client. That is the accepted route TODAY because no
  // brokered Gmail connection exists. The moment one lands in the Worker's
  // registry, that walkthrough becomes the google-workspace hijack all over
  // again, in our own skill. This fails on that day so it cannot ship quietly.
  const gmailBrokered = workerProviderIds().some((id) => /gmail|google_mail|google_email/.test(id));
  if (!gmailBrokered) return; // vacuously fine today
  const md = readFileSync(join(SKILLS_DIR, 'safe-inbox-manager', 'SKILL.md'), 'utf8');
  assert.ok(
    !/google cloud console|create (an? )?oauth client/i.test(md),
    'a brokered Gmail provider now exists but safe-inbox-manager still teaches manual Google Cloud OAuth; rewrite it brokered-first',
  );
});
