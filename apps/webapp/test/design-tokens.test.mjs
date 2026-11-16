import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import tailwindConfig from '../tailwind.config.js';

// The web app's colours are transcribed from the phone app's design tokens so
// the two, and the chat frame they share, read as one product. Nothing checked
// that until the 2026-09-28 Pearl redesign moved the phone's accent from sage
// to ink and the web app kept sage: the config's comment promised this test,
// but the file did not exist.

const here = dirname(fileURLToPath(import.meta.url));
const tokensSource = readFileSync(resolve(here, '../../mobile/src/design/tokens.ts'), 'utf8');

/** The phone app's light theme, as name -> value, read from its source. */
function phoneLightColours() {
  const start = tokensSource.indexOf('light: {');
  assert.ok(start >= 0, 'could not find the light theme in apps/mobile/src/design/tokens.ts');
  const end = tokensSource.indexOf('\n  },', start);
  const block = tokensSource.slice(start, end);
  const colours = {};
  for (const match of block.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) colours[match[1]] = match[2];
  return colours;
}

test('every web colour that shares a name with a phone colour has the same value', () => {
  const phone = phoneLightColours();
  const web = tailwindConfig.theme.extend.colors;
  const shared = Object.keys(web).filter((name) => name in phone);
  // The core of the palette must be shared, or this test proves nothing.
  for (const name of ['bg', 'surfaceHigh', 'border', 'textPrimary', 'textSecondary', 'accent', 'accentMuted', 'accentText']) {
    assert.ok(shared.includes(name), `${name} should exist in both the phone tokens and the web config`);
  }
  const drift = shared
    .filter((name) => web[name].toLowerCase() !== phone[name].toLowerCase())
    .map((name) => `${name}: web ${web[name]}, phone ${phone[name]}`);
  assert.deepEqual(drift, [], `web colours drifted from the phone app:\n${drift.join('\n')}`);
});
