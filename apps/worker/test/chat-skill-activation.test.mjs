// Deterministic skill activation (2026-06-17). The agent would not reliably pick
// our curated skills on its own (live-tested: "be my accountant" continued a prior
// Docker/Firefly thread; "manage my inbox" grabbed a generic built-in email skill).
// buildStreamingChatInput now injects a hard directive when the user's message
// matches a headline operator phrase, so the agent opens and follows THAT skill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStreamingChatInput, buildDelegentDispatchText, detectSkillActivation, namesAConnectedService } from '../dist/index.js';

const FIXED = new Date('2026-06-17T12:00:00Z');

test('detectSkillActivation maps the menu trigger phrases to the right skill', () => {
  assert.equal(detectSkillActivation('be my accountant'), 'autonomous-bookkeeper');
  assert.equal(detectSkillActivation('Can you do my bookkeeping please?'), 'autonomous-bookkeeper');
  // safe-inbox-manager was deleted on 2026-09-03: its whole job was walking the
  // user through Google Cloud Console to mint a Gmail credential, and Gmail is a
  // Connections card now. An inbox ask must reach the brokered path, so the
  // right answer here is "no skill claims it" rather than a skill that would
  // send the user back to a developer console.
  assert.equal(detectSkillActivation('manage my inbox'), null);
  assert.equal(detectSkillActivation('please sort my email'), null);
  assert.equal(detectSkillActivation('update my website'), 'website-builder');
  assert.equal(detectSkillActivation('make it live'), 'website-builder');
  assert.equal(detectSkillActivation('be my operations manager'), 'operations-manager');
  assert.equal(detectSkillActivation('run my day'), 'operations-manager');
});

test('detectSkillActivation does NOT fire on ordinary chat', () => {
  assert.equal(detectSkillActivation('what is 17 times 23?'), null);
  assert.equal(detectSkillActivation('summarise this pdf and give me the actions'), null);
  assert.equal(detectSkillActivation('what time is it in Tokyo'), null);
  assert.equal(detectSkillActivation(''), null);
});

test('buildStreamingChatInput injects a hard skill directive on a trigger phrase', () => {
  const input = buildStreamingChatInput([], 'be my accountant', { agentName: 'Hassan', historyUnavailable: false });
  assert.match(input, /SYSTEM DIRECTIVE/);
  assert.match(input, /autonomous-bookkeeper/);
  assert.match(input, /do not set up any other software or product/i);
  assert.match(input, /Current request from user: be my accountant/);
});

test('the directive explicitly overrides a prior off-track thread in the history', () => {
  const history = [
    { role: 'user', content: 'set up my bookkeeping' },
    { role: 'assistant', content: 'I will install Docker and run Firefly III for you' },
  ];
  const input = buildStreamingChatInput(history, 'be my accountant', { agentName: 'Hassan', historyUnavailable: false });
  assert.match(input, /disregard it and follow the "autonomous-bookkeeper" skill/);
});

test('buildStreamingChatInput stays clean (no directive) for non-skill messages', () => {
  const input = buildStreamingChatInput([], 'hello there', { agentName: 'Hassan', historyUnavailable: false });
  assert.doesNotMatch(input, /SYSTEM DIRECTIVE/);
  assert.match(input, /Current request from user: hello there/);
});

// Route B is the ACTIVE path: the worker sends only buildDelegentDispatchText
// (not buildStreamingChatInput). The directive MUST land here or the agent never
// sees it (the 2026-06-17 bug: directive was only in the legacy fallback path).
test('buildDelegentDispatchText injects the directive on a trigger phrase (Route B active path)', () => {
  const { text, isSlashCommand } = buildDelegentDispatchText('be my accountant', FIXED);
  assert.equal(isSlashCommand, false);
  assert.match(text, /SYSTEM DIRECTIVE/);
  assert.match(text, /autonomous-bookkeeper/);
  assert.match(text, /Current date:/); // date stamp still present
  assert.match(text, /be my accountant$/);
});

test('buildDelegentDispatchText leaves ordinary turns + slash commands untouched', () => {
  const normal = buildDelegentDispatchText('what is 17 times 23?', FIXED);
  assert.doesNotMatch(normal.text, /SYSTEM DIRECTIVE/);
  assert.match(normal.text, /Current date:/);
  const slash = buildDelegentDispatchText('/new', FIXED);
  assert.equal(slash.isSlashCommand, true);
  assert.equal(slash.text, '/new');
});

// Same class of bug as the directive above, one release later. The connected
// services were stated only on the LEGACY path, so on Route B the agent was
// merely TOLD to go and run `delegent-connect list`, which it did not do: it
// answered from its own earlier refusal replayed out of the durable session
// (live 2026-07-28, Dropbox connected, agent offered to walk the user through
// the Dropbox App Console). The fact has to be in the turn.
test('buildDelegentDispatchText states the connected services on the Route B turn', () => {
  const { text } = buildDelegentDispatchText('look in my Dropbox', FIXED, [
    { provider: 'dropbox', displayName: 'Dropbox', status: 'connected', accountLabel: 'alex@example.com' },
  ]);
  assert.match(text, /Connected services/);
  assert.match(text, /Dropbox/);
  assert.match(text, /alex@example\.com/);
  assert.match(text, /delegent-connect run --service dropbox/);
  assert.match(text, /out of\s+date/, 'must override the agent\'s own earlier refusal');
  assert.match(text, /look in my Dropbox$/, 'the user message stays last');
  assert.ok(!text.includes('—'), 'no em-dash characters in agent-facing copy');
});

test('buildDelegentDispatchText says nothing when nothing is connected', () => {
  // An empty "connected services" line reads as a denial, which is the exact
  // failure this stamp exists to prevent.
  const none = buildDelegentDispatchText('hello', FIXED, []);
  assert.doesNotMatch(none.text, /Connected services/);
  assert.equal(none.text, buildDelegentDispatchText('hello', FIXED).text);
});

// R-CHAT-09 (2026-07-30): the gateway's /status and /usage replies were reaching
// customers verbatim, heading, raw session id, model and provider name included.
// Dropping the menu cards on 2026-07-24 only hid the buttons; the commands stayed
// typeable and the gateway kept answering them. These pin the rewrite.
test('buildDelegentDispatchText defuses the leaky diagnostic commands', () => {
  for (const cmd of ['/status', '/usage', '/STATUS', '  /status  ']) {
    const out = buildDelegentDispatchText(cmd, FIXED);
    assert.equal(out.isSlashCommand, false,
      `"${cmd}" must NOT dispatch as a slash command, or the gateway answers with raw diagnostics`);
    assert.doesNotMatch(out.text, /\n\s*\/\w+\s*$/, 'the rewritten message must not still be a slash command');
    assert.match(out.text, /plain language/i);
    assert.ok(!out.text.includes('—'), 'no em-dash characters in agent-facing copy');
  }
});

test('buildDelegentDispatchText leaves the real control commands alone', () => {
  // These are genuine gateway commands the product depends on. Defusing one by
  // accident would silently break it.
  for (const cmd of ['/new', '/stop', '/model', '/goal', '/reset', '/clear', '/compress']) {
    const out = buildDelegentDispatchText(cmd, FIXED);
    assert.equal(out.isSlashCommand, true, `"${cmd}" must still dispatch as a slash command`);
    assert.equal(out.text, cmd, `"${cmd}" must be forwarded verbatim`);
  }
});

test('buildDelegentDispatchText does not defuse ordinary text that mentions status', () => {
  const out = buildDelegentDispatchText('what is the status of my order?', FIXED);
  assert.equal(out.isSlashCommand, false);
  assert.match(out.text, /what is the status of my order\?$/);
});

test('buildDelegentDispatchText routes a lapsed sign-in back to the Connections screen', () => {
  const { text } = buildDelegentDispatchText('check my files', FIXED, [
    { provider: 'dropbox', displayName: 'Dropbox', status: 'needs_reauth', accountLabel: null },
  ]);
  assert.match(text, /sign-in needs attention/);
  assert.match(text, /Connections screen/);
  assert.doesNotMatch(text, /connected and usable right now/);
});

test('naming a connected service beats every skill directive', () => {
  // 2026-09-03 (Alex): "if anyone ever says Gmail or Trello, instantly make
  // sure that the connection is used rather than a skill." A skill directive is
  // a hard order, so a skill winning here sends the customer to a developer
  // console while a working connection sits one command away.
  for (const said of [
    'sort my Gmail please',
    'do my books in QuickBooks',
    'chase my invoices in FreeAgent',
    'put this on my Trello board',
    'what is on my Google Calendar',
    'check my Slack',
    'update my website in Webflow',
    'read this with PDF.co',
  ]) {
    assert.equal(detectSkillActivation(said), null, `"${said}" was claimed by a skill instead of a connection`);
  }
});

test('the trigger words do not fire on ordinary words that happen to appear', () => {
  // "drive" and "teams" are real words. Matching them loosely would suppress
  // every skill in ordinary conversation, which is the opposite failure.
  assert.equal(namesAConnectedService('I will drive to the meeting'), 'drive');
  assert.equal(namesAConnectedService('driving to the meeting'), null);
  assert.equal(namesAConnectedService('teamwork makes it easier'), null);
  assert.equal(namesAConnectedService('what is 17 times 23?'), null);
  assert.equal(namesAConnectedService('be my bookkeeper'), null);
  assert.equal(detectSkillActivation('be my bookkeeper'), 'autonomous-bookkeeper');
});
