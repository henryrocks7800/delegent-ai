import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AREAS, FEATURES } from './parity-inventory.mjs';

// Holds the parity inventory to account. See parity-inventory.mjs for why this
// exists; the short version is that "every screen renders" was passing while
// the browser app was missing the voice orb.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = new Map();

function read(relative) {
  if (!source.has(relative)) {
    const path = join(ROOT, relative);
    source.set(relative, existsSync(path) ? readFileSync(path, 'utf8') : null);
  }
  return source.get(relative);
}

const STATES = new Set(['parity', 'gap', 'web-only', 'n-a']);

test('every entry is filled in', () => {
  const seen = new Set();
  for (const feature of FEATURES) {
    assert.ok(feature.id, `an entry has no id: ${JSON.stringify(feature).slice(0, 80)}`);
    assert.ok(!seen.has(feature.id), `duplicate id ${feature.id}`);
    seen.add(feature.id);
    assert.ok(feature.what, `${feature.id} does not say what it is`);
    assert.ok(feature.mobile, `${feature.id} does not say where it lives on the phone`);
    assert.ok(AREAS.includes(feature.area), `${feature.id} is in an unknown area ${feature.area}`);
    assert.ok(STATES.has(feature.state), `${feature.id} has an unknown state ${feature.state}`);
  }
});

test('anything claimed as built can be pointed at', () => {
  for (const feature of FEATURES.filter((f) => f.state === 'parity' || f.state === 'web-only')) {
    assert.ok(feature.proof?.file, `${feature.id} claims to be built but names no file`);
    const text = read(feature.proof.file);
    assert.ok(text !== null, `${feature.id} points at ${feature.proof.file}, which does not exist`);
    for (const marker of feature.proof.contains) {
      assert.ok(
        text.includes(marker),
        `${feature.id} ("${feature.what}") claims parity, but ${feature.proof.file} no longer contains ${JSON.stringify(marker)}. ` +
          'Either the feature was removed, or the proof needs updating to point at whatever replaced it.',
      );
    }
  }
});

test('every gap is a decision someone wrote down', () => {
  for (const feature of FEATURES.filter((f) => f.state === 'gap' || f.state === 'n-a')) {
    assert.ok(
      feature.why && feature.why.length > 30,
      `${feature.id} is recorded as ${feature.state} with no reason. A gap without a reason is an oversight, and this list exists so oversights cannot hide in it.`,
    );
  }
});

// The list is only worth anything if it is current, and the way a list like
// this rots is that someone builds the feature and never comes back to it. So
// finding the feature is also a failure.
test('a gap that has been filled has to be moved up the list', () => {
  const filled = FEATURES.filter((f) => f.state === 'gap' && f.proof).filter((f) => {
    const text = read(f.proof.file);
    return text !== null && f.proof.contains.every((marker) => text.includes(marker));
  });
  assert.deepEqual(
    filled.map((f) => f.id),
    [],
    'These are recorded as gaps but the browser source now has them. Change their state to "parity".',
  );
});

test('the voice orb and dictation are both on, and the toolbar guide follows', () => {
  // Named separately from the inventory because this is the exact defect Alex
  // reported: two flags on one line, and turning either off silently removes a
  // control from the composer and a row from the guide.
  const chat = read('src/features/chat/ChatScreen.tsx');
  assert.match(chat, /voiceMode:\s*true/, 'the voice orb is switched off again');
  assert.match(chat, /voiceCapture:\s*canRecord\(\)/, 'dictation is switched off again');
  assert.ok(
    !/voiceCapture:\s*false/.test(chat),
    'dictation is hard-coded off; it should be reported from what the browser can actually do',
  );
});

test('the microphone is allowed at every layer that can block it', () => {
  const chat = read('src/features/chat/ChatScreen.tsx');
  assert.match(chat, /allow="[^"]*microphone/, 'the chat iframe does not allow the microphone');

  const hosting = JSON.parse(read('firebase.json'));
  const headers = hosting.hosting.headers.flatMap((rule) => rule.headers);
  const policy = headers.find((header) => header.key === 'Permissions-Policy');
  assert.ok(policy, 'no Permissions-Policy header is set');
  assert.match(
    policy.value,
    /microphone=\(self\)/,
    'hosting sends microphone=() which kills voice in production while it still works in dev',
  );
});

test('a momentary outage is not reported as a workspace still being built', () => {
  const api = read('src/lib/api.ts');
  assert.ok(
    !/if \(status === 503\) return 'not_ready'/.test(api),
    'every 503 maps to "coming online" again, which tells long-standing users to wait for something that already happened',
  );
  assert.match(api, /NOT_READY_CODES/);
});

test('the browser holds a real share of the phone', () => {
  const counted = FEATURES.filter((f) => f.state !== 'n-a' && f.state !== 'web-only');
  const built = counted.filter((f) => f.state === 'parity');
  const share = built.length / counted.length;
  // A ratchet, not a target. Raise it as gaps close; it exists so parity can
  // never quietly go backwards by deleting features instead of building them.
  assert.ok(
    share >= 0.75,
    `only ${built.length} of ${counted.length} phone features are on the browser (${Math.round(share * 100)}%)`,
  );
});
