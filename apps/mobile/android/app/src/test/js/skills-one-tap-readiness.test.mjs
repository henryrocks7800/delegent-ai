import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-24 (Alex, roadmap #2): the Skills drawer used to show each skill's
// trigger phrase as a "copy to clipboard" chip, so using a skill meant copy,
// switch to Chat, paste, send. This guards the one-tap replacement: tapping a
// phrase now sends it straight into chat (same dispatch path as the
// Commands/personality options) and lands the user on Chat. If someone reverts
// the wiring (drops onUse, or stops passing runSkillPhrase), this fails closed.

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');

test('SayChip is a one-tap send action, not a clipboard copy', () => {
  // The chip must dispatch through its onUse callback with the phrase.
  assert.match(appSource, /function SayChip\(\{ phrase, testID, onUse \}/);
  assert.match(appSource, /onPress=\{\(\) => onUse\(phrase\)\}/);
  // The old copy-to-clipboard behaviour must be gone (no expo-clipboard).
  assert.ok(!appSource.includes('expo-clipboard'), 'expo-clipboard import should be removed');
  assert.ok(!appSource.includes('Clipboard.setStringAsync'), 'SayChip must not copy to clipboard anymore');
});

test('runSkillPhrase sends the phrase to chat and opens the Chat tab', () => {
  const match = appSource.match(/const runSkillPhrase = \(phrase: string\) => \{([\s\S]*?)\n {2}\};/);
  assert.ok(match, 'runSkillPhrase handler not found');
  const body = match[1];
  assert.match(body, /DeviceEventEmitter\.emit\('delegent:menuCommand', \{ command: phrase, mode: 'send' \}\)/);
  assert.match(body, /openTab\('dashboard'\)/);
});

test('the skills surfaces describe, and no longer fire a phrase', () => {
  // 2026-09-03 (Alex): "remove the invocation of the skill at the bottom of the
  // skill which says like be my bookkeeper." The Skills drawer is now a
  // description of what the coworker can do; a connection is reached by asking
  // for it by name. The chips are gone from BOTH the category headline and the
  // per-skill rows, and the catalogue no longer carries a phrase to fire.
  assert.equal(/<SayChip phrase=\{category\.tryPhrase\}/.test(appSource), false, 'the category try chip is back');
  assert.equal(/<SayChip phrase=\{skill\.say\}/.test(appSource), false, 'the per-skill say chip is back');

  const catalogue = readFileSync(
    new URL('../../../../../../../packages/shared/src/content/skills.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/\bsay: '/.test(catalogue), false, 'the catalogue carries a say phrase again');
  assert.equal(/\btryPhrase: '/.test(catalogue), false, 'the catalogue carries a tryPhrase again');
});
