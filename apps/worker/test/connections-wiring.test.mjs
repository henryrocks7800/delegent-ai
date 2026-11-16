// The seams between a Connection's THREE moving parts, which is where every
// connection failure so far has actually happened. None of them were caught by
// the existing tests, because each part was individually fine.
//
//   1. The catalogue entry     packages/shared/src/connections.ts   (the card)
//   2. The Worker provider row apps/worker/src/connections-oauth.ts (the OAuth)
//   3. The agent's recipe      connected-services SKILL.md          (the usage)
//
// The scars these encode:
//
//  - **Slack, 2026-08-01.** Shipped live with parts 1 and 2 perfect and no part
//    3. The agent held a valid token, had no idea what to call, and told a user
//    the connection was broken. "Shipping the plumbing is not shipping the
//    connection."
//  - **FreeAgent, 2026-08-05.** Part 3 existed but contained `bank_account=$ACC`,
//    a shell variable nothing ever set. It expanded to empty, FreeAgent replied
//    "Resource not found", and that reads exactly like a permissions failure.
//    First real use by the owner of the business, on the day it shipped.
//
// These are static checks on purpose: no network, no credentials, they run in
// CI on every PR, and they fail in seconds rather than in front of a customer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not url.pathname: on Windows the latter yields "/C:/..." and
// every path built from it silently misses.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const SKILL = readFileSync(
  join(REPO, 'services', 'hermes-runner', 'skills', 'delegent', 'skills', 'connected-services', 'SKILL.md'),
  'utf8',
);
const PROVIDERS_SRC = readFileSync(join(REPO, 'apps', 'worker', 'src', 'connections-oauth.ts'), 'utf8');
const CATALOGUE_SRC = readFileSync(join(REPO, 'packages', 'shared', 'src', 'connections.ts'), 'utf8');

/** The ids registered in the Worker's PROVIDERS map: the source of truth for
 *  what a user can actually complete a hand-off against. */
function workerProviderIds() {
  const block = PROVIDERS_SRC.match(/const PROVIDERS:[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the PROVIDERS registry; this test needs updating');
  return [...block[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)].map((m) => m[1]);
}

/**
 * The ids shipped in the user-facing catalogue, NATIVE ones only.
 *
 * `backend: 'composio'` cards are excluded on purpose. They are brokered by a
 * third party and deliberately have no entry in the Worker's PROVIDERS map, so
 * including them would make this contract demand a native provider that must
 * not exist. The parity rule below still holds for everything we broker
 * ourselves, which is what it was written to protect.
 */
function catalogueIds() {
  const block = CATALOGUE_SRC.match(/export const CONNECTABLE_SERVICES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'could not find CONNECTABLE_SERVICES; this test needs updating');
  const constNames = block[1].split(',').map((s) => s.trim()).filter(Boolean);
  return constNames.flatMap((name) => {
    const entry = CATALOGUE_SRC.match(
      new RegExp(`const ${name}: ConnectableService = \\{([\\s\\S]*?)\\n\\};`),
    );
    assert.ok(entry, `could not read catalogue entry ${name}`);
    const id = entry[1].match(/id: '([^']+)'/);
    assert.ok(id, `could not read the id of catalogue entry ${name}`);
    const backend = entry[1].match(/backend: '([a-z]+)'/);
    assert.ok(backend, `${id[1]} declares no backend; it must say native or composio`);
    return backend[1] === 'native' ? [id[1]] : [];
  });
}

// Providers built and deployed but deliberately without a card yet. yahoo_mail
// (2026-09-25) is dark until Yahoo approves our Mail API access; its card is
// added, and it is removed from this set, in the same change that switches it on.
const PENDING_CARDS = new Set(['yahoo_mail']);

test('every Worker provider has a card, and every card has a Worker provider', () => {
  const providers = workerProviderIds().filter((id) => !PENDING_CARDS.has(id)).sort();
  assert.ok(PENDING_CARDS.size <= 1, 'pending providers should not pile up');
  const cards = catalogueIds().sort();
  // A provider with no card is unreachable: nothing renders a Connect button.
  // A card with no provider is worse: the button exists and the hand-off 404s.
  assert.deepEqual(providers, cards, `Worker providers ${providers} do not match catalogue cards ${cards}`);
});

// NOTE: "every provider has a recipe" and "every example uses the sh -c wrapper"
// are NOT duplicated here. tests/release-gate/connections-skills-contract.test.mjs
// already holds both, derived from the same Worker source, and two copies of a
// rule drift apart and then argue with each other. This file covers only what
// that one does not.

test('no recipe contains an undefined shell placeholder', () => {
  // The FreeAgent bug, exactly. Inside `delegent-connect run -- sh -c '...'` the
  // ONLY variable that exists is the token the runner injects. Any other $NAME
  // expands to empty, and the resulting request fails in a way that looks like
  // a broken connection rather than a broken command.
  const ALLOWED = new Set(['DELEGENT_ACCESS_TOKEN']);
  const offenders = [];
  for (const block of SKILL.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const body = block[1];
    if (!body.includes('delegent-connect')) continue;
    for (const v of body.matchAll(/\$([A-Z][A-Z0-9_]*)/g)) {
      // A variable assigned inside the same block is fine; it is the ones that
      // arrive from nowhere that break.
      const assignedHere = new RegExp(`(^|\\n)\\s*${v[1]}=`).test(body);
      if (!ALLOWED.has(v[1]) && !assignedHere) offenders.push(v[1]);
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `undefined placeholders in connected-services recipes: ${[...new Set(offenders)]}. `
      + 'Inside sh -c these expand to empty and the provider returns a misleading error. '
      + 'Substitute a real value, or fetch it in a prior step and inline it.',
  );
});

/** Catalogue ids for one backend. */
function catalogueIdsFor(backend) {
  const block = CATALOGUE_SRC.match(/export const CONNECTABLE_SERVICES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'could not find CONNECTABLE_SERVICES; this test needs updating');
  return block[1].split(',').map((s) => s.trim()).filter(Boolean).flatMap((name) => {
    const entry = CATALOGUE_SRC.match(new RegExp(String.raw`const ${name}: ConnectableService = \{([\s\S]*?)\n\};`));
    assert.ok(entry, `could not read catalogue entry ${name}`);
    const id = entry[1].match(/id: '([^']+)'/);
    const declared = entry[1].match(/backend: '([a-z]+)'/);
    assert.ok(id && declared, `${name} must declare an id and a backend`);
    return declared[1] === backend ? [id[1]] : [];
  });
}

test('every Composio card has a recipe the agent can actually run', () => {
  // **Gmail, 2026-09-01.** The card shipped, the consent worked, the grant was
  // stored, and the agent still told the customer Gmail was not connected. It
  // had no command for it and no instructions about it, so it looked in our own
  // broker, did not find it, and answered honestly.
  //
  // This is the same rule as the Slack scar at the top of this file, applied to
  // the backend that was EXEMPT from it. Exempting them is what let this
  // through: the parity test above cannot cover Composio cards, because they
  // deliberately have no Worker provider, so the recipe rule has to be stated
  // separately or it does not exist for them at all.
  // The tool prefix is Composio's toolkit SLUG upper-cased, which is not always
  // the catalogue id: google_calendar's tools are GOOGLECALENDAR_*. Deriving the
  // prefix from the id failed the day the second Google connector landed.
  const WORKER_SRC = readFileSync(join(REPO, 'apps', 'worker', 'src', 'composio.ts'), 'utf8');
  const toolPrefixFor = (id) => {
    const row = WORKER_SRC.match(new RegExp(`slug: '([a-z0-9_]+)'[^}]*connectionId: '${id}'`));
    assert.ok(row, `${id} has a card but no COMPOSIO_TOOLKITS row, so there is nothing for the agent to call`);
    return row[1].toUpperCase();
  };
  for (const id of catalogueIdsFor('composio')) {
    assert.match(
      SKILL,
      new RegExp(`delegent-connect exec --tool ${toolPrefixFor(id)}_`),
      `the ${id} card has no exec recipe in connected-services/SKILL.md. A connection `
        + 'the agent cannot use is not a connection: it renders a Connect button, the '
        + 'customer grants access, and then nothing can act on it.',
    );
  }
});

test('the runner has a door onto Composio, not just the app', () => {
  // The app could list and connect; the workspace could do neither. Both halves
  // have to exist or a connected service is inert.
  const ROUTES = readFileSync(join(REPO, 'apps', 'worker', 'src', 'composio-routes.ts'), 'utf8');
  assert.match(ROUTES, /isComposioRunnerPath/, 'the Worker must expose a runner-authenticated Composio surface');
  assert.match(ROUTES, /\/api\/runner\/connections\/composio\/execute/, 'the runner needs an execute route');
  const CLI = readFileSync(join(REPO, 'services', 'hermes-runner', 'bin', 'delegent-connect'), 'utf8');
  assert.match(CLI, /add_parser\('exec'/, 'delegent-connect needs an exec subcommand or the agent cannot call it');
});

// Card reachability is verified using offered-but-unconnected accounts in
// both actual screens, tests/e2e/connection-screen.test.mjs.

test('the safety sheet never promises narrower access than the grant allows', () => {
  // FreeAgent has no scopes: approving gives full read AND write, including
  // delete. Stripe was rejected outright for the same reason. If a card that
  // cannot be narrowed ever stops saying so, the user is being misled about
  // what they are handing over.
  const freeagent = CATALOGUE_SRC.match(/const FREEAGENT: ConnectableService = \{[\s\S]*?\n\};/);
  assert.ok(freeagent, 'FreeAgent catalogue entry not found');
  assert.match(
    freeagent[0],
    /Full access to your FreeAgent account/,
    'the FreeAgent card must state full access plainly: it has no scope system, so read-only is not on offer',
  );
});

test('no skill tells the agent to borrow a token for a Composio service', () => {
  // **Alex, 2026-09-01, 21:48.** Gmail was connected and healthy. The agent
  // reached for `delegent-connect run --service gmail`, got "not connected",
  // and sent him round a disconnect/reconnect loop that could never have
  // helped. There is no token to borrow for a Composio service, so `run` can
  // only ever fail there, and it fails in the shape of a broken connection.
  const composio = catalogueIdsFor('composio');
  const root = join(REPO, 'services', 'hermes-runner', 'skills');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('SKILL.md'))
    .map((p) => join(root, p));
  assert.ok(files.length > 5, 'expected to find the skill pack; path may have moved');

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const id of composio) {
      // A line is only allowed to mention it inside an explicit warning, which
      // is how the skills teach the distinction. The earlier version of this
      // check used a loose lookahead for "not", which with /i also matched the
      // word "Note", so "Note: run --service gmail" sailed through. Match the
      // instruction, then exempt on a real negation phrase.
      const needle = `--service ${id}`;
      const NEGATION = /(?:does not|do not|never|cannot|not work|instead of|will not)/i;
      const offending = src.split(/\r?\n/).some((line) => line.includes(needle) && !NEGATION.test(line));
      assert.ok(
        !offending,
        `${file.replace(REPO, '')} instructs the agent to run --service ${id}. `
          + 'A Composio service has no borrowable token; this reads to the user as a broken connection.',
      );
    }
  }
});

test('no deleted connection-setup skill is still on the volume or in the manifest', () => {
  // 2026-09-03 (Alex): "any skill whose entire job is just to go in and make
  // sure that it can connect using an API key, we should just remove." These
  // four walked the user through a developer console to mint a credential, and
  // every service they covered is a Connections card now. The old test here
  // asserted safe-inbox-manager DEFERRED to Composio; deleting it is the
  // stronger version of the same thing, so this replaces it.
  const manifest = JSON.parse(readFileSync(join(REPO, 'services', 'hermes-runner', 'skills', 'delegent', 'MANIFEST.json'), 'utf8'));
  const slugs = new Set(manifest.skills.map((s) => s.slug));
  for (const gone of ['bank-and-accounting-setup', 'cloud-storage-manager', 'safe-inbox-manager', 'api-integration-builder']) {
    assert.equal(slugs.has(gone), false, `${gone} is back in the manifest`);
    assert.equal(
      existsSync(join(REPO, 'services', 'hermes-runner', 'skills', 'delegent', 'skills', gone, 'SKILL.md')),
      false,
      `${gone} is back on the volume`,
    );
  }
  // And nothing may still point at them.
  for (const s of manifest.skills) {
    for (const r of s.related || []) assert.ok(slugs.has(r), `${s.slug} relates to ${r}, which does not exist`);
  }
});

test('the CLI refuses run on a Composio service rather than misreporting it', () => {
  const cli = readFileSync(join(REPO, 'services', 'hermes-runner', 'bin', 'delegent-connect'), 'utf8');
  // Belt and braces for the skills above. Instructions can be missed; the tool
  // itself cannot be, and it is the last thing standing between a confused
  // agent and a user being told to reconnect something that works.
  assert.match(cli, /_composio_services/, 'delegent-connect must know which services are Composio-brokered');
  assert.match(cli, /brokered by Composio/, 'the refusal must name the right command, not just fail');
});

test('every Composio toolkit declares a read-only probe', () => {
  // Without one there is no cheap answer to "is this actually working for a
  // customer", which is the question that took six rounds to answer for Gmail.
  // scripts/ops/verify-composio-connector.mjs runs it against real accounts, so
  // it must be read-only, free and side-effect free.
  const WORKER = readFileSync(join(REPO, 'apps', 'worker', 'src', 'composio.ts'), 'utf8');
  const block = WORKER.match(/export const COMPOSIO_TOOLKITS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, 'could not find COMPOSIO_TOOLKITS; this test needs updating');
  // One nested brace level is allowed, for probeArgs: { ... } (Trello, 2026-09-02).
  const entries = [...block[1].matchAll(/\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  assert.ok(entries.length > 0, 'expected at least one Composio toolkit');
  for (const entry of entries) {
    const id = (entry[1].match(/connectionId:\s*'([^']+)'/) || [])[1] || '(unnamed)';
    assert.match(
      entry[1],
      /probeTool:\s*'[A-Z][A-Z0-9_]+'/,
      `the ${id} toolkit declares no probeTool. Add a read-only action so the connector can be `
        + 'verified against a live account without sending, writing or deleting anything.',
    );
  }
});
