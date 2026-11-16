import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-23 (Alex): guards the ☰ menu "Commands" area so a broken menu command
// can't ship again. Real bugs that prompted this suite:
//   * /personality returned a "none configured" message (the gateway command is
//     real but needs personalities seeded in config.yaml, which they aren't).
//   * /goal used 'compose' mode (pre-typed the text) so tapping it looked like
//     it "did nothing".
//   * /memory returned "Unknown /memory subcommand..." (the gateway command is a
//     write-approval review tool, not a "show what you remember" surface).
// The lesson: several gateway slash commands are real but produce developer
// facing output. So the safer default for these cards is a plain instruction the
// coworker acts on. The suite fails closed: add a new menu command and you must
// prove it sends a real gateway command, a plain instruction, or a style option.

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
// The catalogue moved into @sidekick/shared so the web menu renders the same
// cards; the phone reads it from there. Scrape the shared source, not App.tsx.
const commandsSource = readFileSync(
  new URL('../../../../../../../packages/shared/src/content/commands.ts', import.meta.url),
  'utf8',
);
const webViewSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const chatHtmlSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
const chatHtmlTsSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');

// Slash commands the bundled Hermes gateway actually implements (handlers live in
// gateway/slash_commands.py of NousResearch/hermes-agent). A menu command that
// SENDS a bare slash command (send mode, no style options) must be one of these,
// otherwise it is a fake command Hermes answers with an error reply. If you add a
// menu command with a new slash, confirm the gateway implements it first.
// NOTE: /status was removed from the menu on 2026-07-24 (Alex: "get rid of
// status") because it leaked the raw session id + model/provider name. /usage
// was removed on 2026-07-24 too (Alex, roadmap #8): it leaked provider internals
// (model + provider name, token counts) into the chat, and the friendly capacity
// figure now lives only on the Profile capacity card. Both are intentionally NOT
// in this allowlist: re-adding a /status or /usage card would now fail this suite.
const REAL_GATEWAY_SLASH_COMMANDS = new Set([
  '/new', '/stop', '/model', '/goal', '/reset', '/clear',
  '/compress',
]);

function parseChatCommands() {
  const blockMatch = commandsSource.match(/const DELEGENT_CHAT_COMMANDS: ChatCommand\[\] = \[([\s\S]*?)\n\];/);
  assert.ok(blockMatch, 'DELEGENT_CHAT_COMMANDS array not found in packages/shared');
  const inner = blockMatch[1];
  // Top-level command objects open with exactly two-space indentation ("  {");
  // option objects are indented deeper (six spaces), so this split isolates the
  // top-level commands only.
  const chunks = inner.split(/\n {2}\{\n/).slice(1);
  return chunks.map((text) => {
    const key = text.match(/^ {4}key: '([^']+)',/m)?.[1] ?? null;
    const command = text.match(/^ {4}command: '((?:[^'\\]|\\.)*)',/m)?.[1] ?? null;
    const mode = text.match(/^ {4}mode: '(send|compose)',/m)?.[1] ?? null;
    const hasOptions = /^ {4}options: \[/m.test(text);
    const optionKeys = [...text.matchAll(/^ {8}key: '([^']+)',/gm)].map((m) => m[1]);
    const optionInstructions = [...text.matchAll(/^ {8}instruction: '((?:[^'\\]|\\.)*)',/gm)].map((m) => m[1]);
    return { key, command, mode, hasOptions, optionKeys, optionInstructions, text };
  });
}

const commands = parseChatCommands();

test('every menu command parses with a key, command and mode', () => {
  assert.ok(commands.length >= 5, `expected the full commands set, parsed ${commands.length}`);
  for (const c of commands) {
    assert.ok(c.key, `a command is missing its key: ${c.text.slice(0, 60)}`);
    assert.ok(c.command, `command "${c.key}" is missing its command string`);
    assert.ok(c.mode, `command "${c.key}" is missing its mode`);
  }
  const keys = commands.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'menu command keys must be unique');
});

test('no menu command sends a fake slash command', () => {
  for (const c of commands) {
    // fresh-chat is special-cased (its own reset path); style-option commands
    // dispatch their option instruction, never the top-level command string.
    if (c.key === 'fresh-chat' || c.hasOptions) continue;
    if (c.mode === 'send' && c.command.startsWith('/')) {
      assert.ok(
        REAL_GATEWAY_SLASH_COMMANDS.has(c.command),
        `command "${c.key}" sends "${c.command}" which is not a real Hermes gateway command — it will just produce a chat reply. Send a plain instruction or use a real command.`,
      );
    }
  }
});

test('the personality command uses a style picker, not a fake /personality slash', () => {
  const personality = commands.find((c) => c.key === 'personality');
  assert.ok(personality, 'personality command missing');
  assert.ok(personality.hasOptions, 'personality must offer style options');
  assert.ok(personality.optionKeys.length >= 3, 'expected several personality styles');
  assert.equal(personality.optionInstructions.length, personality.optionKeys.length, 'every style option needs an instruction');
  for (const instruction of personality.optionInstructions) {
    assert.ok(instruction.length > 0, 'style instruction must not be empty');
    assert.ok(!instruction.startsWith('/'), `style instruction must be plain English, got "${instruction}"`);
  }
  // The run handler must dispatch the option instruction (send mode), never the
  // bare /personality command.
  assert.match(appSource, /DeviceEventEmitter\.emit\('delegent:menuCommand', \{ command: option\.instruction, mode: 'send' \}\)/);
});

test('the goal command sends an instruction (not left pre-typed in the composer)', () => {
  const goal = commands.find((c) => c.key === 'goal');
  assert.ok(goal, 'goal command missing');
  assert.equal(goal.mode, 'send', "goal must send so tapping it does something visible, not sit in 'compose'");
  assert.ok(!goal.command.startsWith('/'), 'goal now sends a plain instruction so the coworker asks for the goal, not a raw /goal slash');
  assert.match(goal.command, /goal/i, 'goal instruction should mention setting a goal');
});

test('the memory command asks the coworker, not the raw /memory write-approval tool', () => {
  // /memory in the gateway is a write-approval review surface: with nothing
  // pending (the default) it returns "Unknown /memory subcommand...". The card
  // promises "see what it saves about you", so we ask the coworker in plain
  // language instead of sending the raw slash.
  const memory = commands.find((c) => c.key === 'memory');
  assert.ok(memory, 'memory command missing');
  assert.equal(memory.mode, 'send');
  assert.ok(!memory.command.startsWith('/'), 'memory must send a plain instruction, not the raw /memory slash');
  assert.match(memory.command, /remember|memory/i, 'memory instruction should ask what the coworker remembers');
});

test('menu-command plumbing is intact end to end', () => {
  // App side: emits the event for options and for plain commands.
  assert.match(appSource, /DeviceEventEmitter\.emit\('delegent:menuCommand', \{ command: command\.command, mode: command\.mode \}\)/);
  assert.match(appSource, /DeviceEventEmitter\.emit\('delegent:startFreshChat'\)/);
  // WebView bridge: listens and forwards into the WebView.
  assert.match(webViewSource, /DeviceEventEmitter\.addListener\('delegent:menuCommand'/);
  assert.match(webViewSource, /deliverToWebView\(\{ type: 'menu_command', command, mode \}\)/);
  // WebView HTML: handles the message and both modes.
  assert.match(chatHtmlSource, /function runMenuCommand\(command, mode\)/);
  assert.match(chatHtmlSource, /if \(mode === 'compose'\)/);
  assert.match(chatHtmlSource, /void sendMessage\(\)/);
  // Generated HTML string must be regenerated from the source HTML.
  assert.ok(chatHtmlTsSource.includes('runMenuCommand'), 'chatWebViewHtml.ts is stale — run scripts/regen-chat-webview-html.js');
});

test('user-facing menu copy uses no em dashes', () => {
  // House rule: never em dashes in anything a user reads. Commas / brackets / full stops.
  const blockMatch = commandsSource.match(/const DELEGENT_CHAT_COMMANDS: ChatCommand\[\] = \[([\s\S]*?)\n\];/);
  const strings = [...blockMatch[1].matchAll(/(?:name|short|why|actionLabel|label): '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.ok(strings.length > 0, 'expected to find menu copy strings');
  for (const s of strings) {
    assert.ok(!s.includes('—'), `menu copy contains an em dash: "${s}"`);
  }
});
