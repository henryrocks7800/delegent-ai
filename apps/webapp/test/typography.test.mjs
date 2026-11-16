import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import tailwindConfig from '../tailwind.config.js';

// Tailwind silently emits nothing for a class it does not know. Screen titles
// shipped as `text-h2` and the wordmark as `font-serif` for exactly that
// reason: both looked deliberate in the source and rendered at body size in
// Georgia in the browser. These tests read the theme rather than a snapshot, so
// they keep working when the scale changes.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '../src');

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles(srcRoot);
const fontSizes = new Set(Object.keys(tailwindConfig.theme.extend.fontSize));
const fontFamilies = new Set(Object.keys(tailwindConfig.theme.extend.fontFamily));
const colours = new Set(Object.keys(tailwindConfig.theme.extend.colors));

// Tailwind's own scale, which stays available alongside the extensions.
const BUILT_IN_SIZES = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
]);
const BUILT_IN_FAMILIES = new Set(['sans', 'serif', 'mono']);

test('every text size used in the app is one the design scale defines', () => {
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    for (const [, name] of body.matchAll(/\btext-([a-z][a-z0-9-]*)\b/g)) {
      // text-* is also the colour utility, so a name that is a colour is fine.
      if (colours.has(name) || fontSizes.has(name) || BUILT_IN_SIZES.has(name)) continue;
      // Alignment and decoration share the prefix too.
      if (['left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip'].includes(name)) continue;
      assert.fail(`${file.slice(srcRoot.length + 1)} uses text-${name}, which Tailwind will not generate`);
    }
  }
});

test('the brand wordmark uses the brand family, not the default serif', () => {
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    assert.equal(
      /\bfont-serif\b/.test(body),
      false,
      `${file.slice(srcRoot.length + 1)} uses font-serif, which resolves to Georgia rather than Instrument Serif`,
    );
    for (const [, name] of body.matchAll(/\bfont-([a-z][a-z0-9-]*)\b/g)) {
      if (fontFamilies.has(name) || BUILT_IN_FAMILIES.has(name)) continue;
      if (['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'].includes(name)) continue;
      assert.fail(`${file.slice(srcRoot.length + 1)} uses font-${name}, which Tailwind will not generate`);
    }
  }
});

test('the nav draws real icons, not emoji', () => {
  // Emoji render in a different typeface on every operating system and read as
  // a different product beside the phone app's Feather glyphs.
  const shell = readFileSync(resolve(srcRoot, 'components/Shell.tsx'), 'utf8');
  assert.equal(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(shell),
    false,
    'Shell.tsx still contains an emoji',
  );
  assert.match(shell, /from '\.\/Icon'/);
});
