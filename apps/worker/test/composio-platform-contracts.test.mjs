// Platform-level contracts for Composio connectors: things that must hold once,
// whichever connector is being added. Each one is a defect found on the
// 2026-09-02 review of Gmail, AFTER every connector-level contract was green.
// None of them is visible from a phone, which is exactly why they are here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// fileURLToPath, not url.pathname: on Windows the latter yields "/C:/..."
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

test('the system prompt tells the agent about exec and that a connection beats a skill', () => {
  // The agent reads this on every turn, before any skill. The old text named
  // `delegent-connect run` as THE command for OAuth connections, so however
  // good the skills were, the prompt itself pointed at a command that cannot
  // work for a brokered service. This is the "connections trump skills" rule,
  // enforced at the only level that outranks a SKILL.md.
  const PROMPT = read('packages', 'provisioner', 'src', 'delegentAgentDefaults.ts');
  assert.match(PROMPT, /delegent-connect exec/, 'the prompt must name the exec command');
  assert.match(PROMPT, /"backend": "composio"/, 'the prompt must tell the agent how to recognise a brokered service');
  assert.match(PROMPT, /ALWAYS WINS OVER A SKILL/, 'the prompt must state that a listed connection beats any skill');
});

test('account deletion revokes Composio grants as well as our own', () => {
  // The native sweep only sees our own table. Without this a deleted account
  // left its Gmail grant live at Composio, contradicting the privacy policy.
  const INDEX = read('apps', 'worker', 'src', 'index.ts');
  assert.match(INDEX, /revokeAllComposioConnections\(env, auth\.user\.id/,
    'the account-deletion path must sweep Composio, best effort, like the native providers');
});

// Client API surface/body and visible Composio cards are executed in
// tests/e2e/connection-client.test.mjs and connection-screen.test.mjs.

test('the CLI treats a provider refusal as a failure, not a success', () => {
  // Composio answers HTTP 200 with successful:false when the provider refused
  // the action. Exiting 0 there let the agent read a refusal as a success.
  const CLI = read('services', 'hermes-runner', 'bin', 'delegent-connect');
  assert.match(CLI, /get\('successful'\) is False/, 'exec must inspect successful and exit non-zero on a refusal');
  assert.match(CLI, /not a broken connection/, 'the refusal must say what it is not, or the agent tells the user to reconnect');
});

test('the broker asks Composio for ACTIVE accounts only', () => {
  const WORKER = read('apps', 'worker', 'src', 'composio.ts');
  assert.match(WORKER, /statuses=ACTIVE/, 'abandoned Connect taps pile up as dead records and can hide the live one');
  assert.match(WORKER, /AbortSignal\.timeout/, 'a hung Composio call must not hang the runner turn');
});

test('no skill points the agent at the old Gmail client ahead of the connection', () => {
  // operations-manager used to say "reuse safe-inbox-manager's gmail_client.py",
  // which is the manual-wizard client and knows nothing about Composio.
  const OPS = read('services', 'hermes-runner', 'skills', 'delegent', 'skills', 'operations-manager', 'SKILL.md');
  const line = OPS.split(/\r?\n/).find((l) => l.includes('gmail_client.py')) || '';
  assert.match(line, /delegent-connect list/, 'the pointer at the old client must tell the agent to check the connection first');
});
