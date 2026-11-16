import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DELEGENT_CHAT_COMMANDS,
  DELEGENT_FAQ_ORDERED,
  DELEGENT_HOWTO_SECTIONS,
  DELEGENT_USE_CASE_CATEGORIES,
  SIDEKICK_PLAN_TIERS,
  ACKNOWLEDGEMENT_TEXT,
  ACKNOWLEDGEMENT_VERSION,
  WEB_APP_URL,
  WEB_APP_DISPLAY_URL,
} from '@sidekick/shared';

// The whole point of the web app sharing packages/shared is that editing the
// how-to guide once updates the phone and the browser together. These tests fail
// if a screen ever starts keeping its own copy of that copy.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, '../src', relative), 'utf8');

test('the shared content package actually has content', () => {
  assert.ok(DELEGENT_HOWTO_SECTIONS.length > 0);
  assert.ok(DELEGENT_FAQ_ORDERED.length > 0);
  assert.ok(SIDEKICK_PLAN_TIERS.length === 3);
  assert.ok(ACKNOWLEDGEMENT_TEXT.length > 40);
  assert.equal(typeof ACKNOWLEDGEMENT_VERSION, 'string');
});

test('the how-to guide is rendered from shared, not retyped', () => {
  const help = read('features/help/HelpScreen.tsx');
  assert.match(help, /DELEGENT_HOWTO_SECTIONS/);
  assert.match(help, /from '@sidekick\/shared'/);
  // Any section heading appearing as a string literal means someone pasted it in.
  for (const section of DELEGENT_HOWTO_SECTIONS) {
    assert.equal(help.includes(`'${section.title}'`), false, `HelpScreen hard-codes "${section.title}"`);
  }
});

test('the FAQ is rendered from shared, not retyped', () => {
  const faq = read('features/help/FaqScreen.tsx');
  assert.match(faq, /DELEGENT_FAQ_ORDERED/);
  // Agent-engine accounts get the engine's answers, not the workspace ones
  // that promise a private cloud computer (2026-09-22).
  assert.match(faq, /useCoworkerEngine\(\) === 'agent' \? AGENT_FAQ_ORDERED : DELEGENT_FAQ_ORDERED/);
  for (const entry of DELEGENT_FAQ_ORDERED) {
    assert.equal(faq.includes(`'${entry.question}'`), false, `FaqScreen hard-codes "${entry.question}"`);
  }
});

test('the skills catalogue is one list, read by both surfaces', () => {
  // The shared guide and FAQ tell every reader to open "Skills and use cases".
  // That instruction was wrong on the web because the catalogue was declared
  // inline in the phone app, so it now lives in shared and both screens read it.
  assert.ok(DELEGENT_USE_CASE_CATEGORIES.length > 0);

  const skills = read('features/skills/SkillsScreen.tsx');
  assert.match(skills, /DELEGENT_USE_CASE_CATEGORIES/);
  for (const category of DELEGENT_USE_CASE_CATEGORIES) {
    assert.equal(skills.includes(category.title), false, `SkillsScreen hard-codes "${category.title}"`);
  }

  const mobile = readFileSync(resolve(here, '../../mobile/App.tsx'), 'utf8');
  assert.match(mobile, /DELEGENT_USE_CASE_CATEGORIES/);
  for (const category of DELEGENT_USE_CASE_CATEGORIES) {
    assert.equal(mobile.includes(category.hook), false, `App.tsx still declares the ${category.key} category`);
  }
});

test('the commands catalogue is one list, read by both surfaces', () => {
  assert.ok(DELEGENT_CHAT_COMMANDS.length >= 5);

  const commands = read('features/commands/CommandsScreen.tsx');
  assert.match(commands, /DELEGENT_CHAT_COMMANDS/);
  for (const command of DELEGENT_CHAT_COMMANDS) {
    assert.equal(commands.includes(command.name), false, `CommandsScreen hard-codes "${command.name}"`);
  }

  const mobile = readFileSync(resolve(here, '../../mobile/App.tsx'), 'utf8');
  assert.match(mobile, /const CHAT_COMMANDS = DELEGENT_CHAT_COMMANDS;/);
  for (const command of DELEGENT_CHAT_COMMANDS) {
    assert.equal(mobile.includes(command.why), false, `App.tsx still declares the ${command.key} command`);
  }
});

test('a command chosen off the chat route is played once the chat has caught up', () => {
  // The phone keeps its chat mounted, so a menu command reaches it at once. Here
  // the chat is a route that unmounts, and its document replaces the whole
  // message list when history lands, so a command played earlier loses its own
  // bubble. The queue plus the document's history_loaded signal is what makes
  // tapping a command or a skill phrase actually land in the conversation.
  const chat = read('features/chat/ChatScreen.tsx');
  assert.match(chat, /case 'history_loaded'/);
  assert.match(chat, /takeChatCommand\(\)/);
  assert.match(chat, /type: 'start_fresh_chat'/);
  assert.match(chat, /type: 'menu_command'/);

  const chatDoc = readFileSync(resolve(here, '../../mobile/assets/chat-webview/index.html'), 'utf8');
  // In `finally`, so the early return and the catch both still report. Without
  // that a failed history fetch would strand the queued command forever.
  assert.match(chatDoc, /\} finally \{[\s\S]{0,400}?bridge\.postToNative\('history_loaded', \{\}\);/);

  // Skills stopped queueing anything on 2026-09-03: the drawer describes what
  // the coworker can do rather than offering a phrase to fire. Commands still
  // queue, and that is the path this test exists to protect.
  for (const screen of ['features/commands/CommandsScreen.tsx']) {
    const source = read(screen);
    assert.match(source, /queueChatCommand\(/, `${screen} does not queue anything`);
    assert.match(source, /navigate\('\/chat'\)/, `${screen} queues a command but never opens the chat`);
  }
  const skills = read('features/skills/SkillsScreen.tsx');
  assert.equal(/queueChatCommand\(/.test(skills), false, 'the skills screen fires a phrase again');
});

test('every destination the guide sends people to exists in the web menu', () => {
  // The guide is shared, so an instruction like "open Monthly capacity in the
  // menu" is printed to web readers whether or not the web has that screen.
  // Each entry below is a phrase the shared copy uses, paired with the route it
  // must resolve to here.
  const named = [
    [/Skills & use cases/, '/skills'],
    [/Open .?Routines/, '/routines'],
    [/Open .?Connections/, '/connections'],
    [/Monthly capacity/, '/capacity'],
    [/Help & suggestions/, '/support'],
  ];
  const guide = [
    ...DELEGENT_HOWTO_SECTIONS.flatMap((section) => section.body),
    ...DELEGENT_FAQ_ORDERED.map((entry) => `${entry.question} ${entry.answer}`),
  ].join(' ');
  const shell = read('components/Shell.tsx');
  for (const [phrase, route] of named) {
    // Asserted, not skipped: if a rewording stops matching, the pairing is no
    // longer being checked at all, and a silently vacuous test is worse than a
    // noisy one.
    assert.match(guide, phrase, `the shared guide no longer says ${phrase}, so this pairing needs revisiting`);
    assert.ok(shell.includes(`'${route}'`), `the guide points at ${phrase} but the web menu has no ${route}`);
  }
});

test('the legal documents come from shared', () => {
  const legal = read('features/legal/LegalScreen.tsx');
  assert.match(legal, /from '@sidekick\/shared'/);
  for (const name of ['PRIVACY', 'TERMS', 'DELETION', 'NOTICES']) {
    assert.ok(legal.includes(name), `LegalScreen is missing the ${name} document`);
  }
});

test('plan prices come from shared, so the phone and the web cannot disagree', () => {
  const plan = read('features/billing/PlanScreen.tsx');
  assert.match(plan, /SIDEKICK_PLAN_TIERS/);
  assert.match(plan, /formatGbp/);
  for (const tier of SIDEKICK_PLAN_TIERS) {
    assert.equal(plan.includes(`£${tier.priceGbpMonthly}`), false, `PlanScreen hard-codes the ${tier.id} price`);
  }
});

test('the allowance is described once, in the audited wording', () => {
  // The tier note already states the allowance. A second, screen-authored line
  // beside it read the token count out as a word count, which is both a
  // duplicate and a claim we cannot stand behind.
  const plan = read('features/billing/PlanScreen.tsx');
  assert.equal(/million words/.test(plan), false, 'PlanScreen describes tokens as words');
  assert.match(plan, /tier\.inferenceNote/);
  for (const tier of SIDEKICK_PLAN_TIERS) {
    if (!tier.inferenceNote) continue;
    assert.equal(plan.includes(tier.inferenceNote), false, `PlanScreen hard-codes the ${tier.id} allowance note`);
  }
});

test('the guide names the one feature the web app does not have', () => {
  // The shared guide is written for both surfaces, and filtering it per surface
  // would reintroduce exactly the drift this package exists to prevent. So the
  // screen carries the difference instead: Telegram connect is phone-only.
  const help = read('features/help/HelpScreen.tsx');
  assert.match(help, /phone app/i);
  assert.match(help, /Telegram/i);
  assert.equal(
    /voice.{0,60}phone app only/is.test(help),
    false,
    'the guide still tells web readers voice is phone-only, which it no longer is',
  );
});

test('the chat frame is told Telegram is off on the web', () => {
  // Telegram's connect card is still native-only, so it has to ship dark here.
  // The voice flags are the opposite case and are held to account in
  // parity.test.mjs, because turning either off is the defect Alex reported.
  const chat = read('features/chat/ChatScreen.tsx');
  assert.match(chat, /telegramConnect: false/);
});

test('a control the web cannot answer is not left on screen', () => {
  // The mic posts voice_start and then waits for a transcript. A host that
  // cannot answer would strand the composer on "Listening…" with no way back,
  // so the document has to be able to hide the control, and to hide the tour
  // rows describing controls which are not there. This is the mechanism; which
  // way the flags are actually set is parity.test.mjs's business.
  const chatDoc = readFileSync(
    resolve(here, '../../mobile/assets/chat-webview/index.html'),
    'utf8',
  );
  assert.match(chatDoc, /voiceCapture: !\(msg\.pilotFeatures && msg\.pilotFeatures\.voiceCapture === false\)/);
  assert.match(chatDoc, /\$micBtn\.classList\.toggle\('hidden', !bridge\.config\.voiceCapture\)/);
  assert.match(chatDoc, /row\('tourRowVoice', voice\)/);
  assert.match(chatDoc, /row\('tourRowTalk', talk\)/);
  assert.match(chatDoc, /row\('tourFootVoice', voice && talk\)/);

  // This document has no blanket .hidden rule, only per-component ones, so
  // adding the class to something new hides nothing at all until a rule exists.
  assert.match(chatDoc, /\.tt-row\.hidden \{ display: none; \}/);
  assert.match(chatDoc, /\.tt-foot\.hidden \{ display: none; \}/);
  assert.match(chatDoc, /\.mic-btn\.hidden \{ display: none; \}/);

  // Every action the document can ask its host to perform must be one the web
  // host actually handles, or it is a dead control by another name.
  const chatScreen = read('features/chat/ChatScreen.tsx');
  const asked = [...chatDoc.matchAll(/postToNative\('([a-z_]+)'/g)].map((m) => m[1]);
  const hostOnly = ['ready', 'webview_error'];
  for (const action of new Set(asked)) {
    if (hostOnly.includes(action)) continue;
    assert.ok(chatScreen.includes(`case '${action}'`), `the web host ignores ${action}`);
  }
});

test('the shared copy points a desk reader at the web app, and promises no Windows download', () => {
  // The FAQ used to send readers to "delegentai.co.uk/windows" to download a
  // desktop app. There is no desktop app and no such page, so the answer was a
  // dead end printed inside the product. The browser version is the real answer
  // to "can I use this on a computer".
  const copy = [
    ...DELEGENT_HOWTO_SECTIONS.flatMap((section) => section.body),
    ...DELEGENT_FAQ_ORDERED.map((entry) => `${entry.question} ${entry.answer}`),
  ].join(' ');

  assert.doesNotMatch(copy, /delegentai\.co\.uk\/windows/i, 'shared copy links to a Windows download that does not exist');
  assert.doesNotMatch(copy, /download the desktop app/i, 'shared copy offers a desktop app that does not exist');

  const devices = DELEGENT_FAQ_ORDERED.find((entry) => /which devices/i.test(entry.question));
  assert.ok(devices, 'the "which devices" FAQ entry is gone or was renamed');
  assert.ok(devices.answer.includes(WEB_APP_DISPLAY_URL), 'the devices answer does not name the web app address');

  const computer = DELEGENT_FAQ_ORDERED.find((entry) => /on my computer/i.test(entry.question));
  assert.ok(computer, 'nothing in the FAQ answers the question people actually ask');
  assert.ok(computer.answer.includes(WEB_APP_DISPLAY_URL), 'the computer answer does not say where to go');
  assert.match(computer.answer, /sign in the way you always do/i, 'the computer answer does not say how to get in');
});

test('the web app address is derived, not retyped, so one edit moves every mention', () => {
  assert.equal(WEB_APP_DISPLAY_URL, WEB_APP_URL.replace(/^https?:\/\//, ''));
  const source = readFileSync(resolve(here, '../../../packages/shared/src/content/webApp.ts'), 'utf8');
  const literals = source.match(/delegent-app\.web\.app/g) ?? [];
  assert.equal(literals.length, 1, 'the address is typed more than once, so a change will half-land');
});
