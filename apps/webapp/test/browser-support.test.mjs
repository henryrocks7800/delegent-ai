import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The phone runs this code in Android's WebView, which is Chromium, so a feature
// Safari lacks has never once shown up there. On the web it goes to whatever
// browser the reader has. The ones below are worse than a failed call: they are
// parse errors, so one of them takes down the whole file and leaves a blank
// screen with nothing in the console to explain it.
//
// The floor is Safari 15.4 (March 2022), which is as far as an iPhone 6s or 7
// can be updated. Raising it means deciding those readers get a blank page.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '../..');

const CHAT_DOCUMENT = resolve(repo, 'apps/mobile/assets/chat-webview/index.html');

const PARSE_ERRORS_BELOW_THE_FLOOR = [
  {
    pattern: /\(\?<[=!]/,
    what: 'regular expression lookbehind',
    since: 'Safari 16.4',
    instead: 'capture the leading character and put it back: /(^|[^*])\\*/ rather than /(?<!\\*)\\*/',
  },
  {
    pattern: /\bstatic\s*\{/,
    what: 'class static initialisation block',
    since: 'Safari 16.4',
    instead: 'assign the static field directly',
  },
];

// Deliberately not scanned: the regular expression v flag. Finding a regex
// literal with a regex cannot be done reliably, and the attempt flagged three
// comments and an import path. A rule that cries wolf gets switched off, which
// costs more than the rule was worth.

// These parse fine and fail at the call, so they only break the feature rather
// than the page. Still worth naming, because the failure is silent.
const MISSING_BELOW_THE_FLOOR = [
  { pattern: /\.toSorted\(|\.toReversed\(|\.findLast\(|\.with\(/, what: 'the 2023 array methods', since: 'Safari 16.4' },
  { pattern: /Object\.groupBy|Map\.groupBy/, what: 'groupBy', since: 'Safari 17.4' },
  { pattern: /URL\.canParse/, what: 'URL.canParse', since: 'Safari 17' },
  { pattern: /\bnavigator\.clipboard\.read\b/, what: 'clipboard read', since: 'not in Safari at all' },
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function scan(files, rules) {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const rule of rules) {
      const hit = text.match(rule.pattern);
      if (!hit) continue;
      const line = text.slice(0, hit.index).split('\n').length;
      found.push(
        `${file.replace(repo, '.')}:${line} uses ${rule.what} (${rule.since})` +
          (rule.instead ? `. Use ${rule.instead}` : ''),
      );
    }
  }
  return found;
}

test('the chat document parses on every browser we support', () => {
  // This one is not transpiled by anything. It ships to the browser as written.
  assert.deepEqual(scan([CHAT_DOCUMENT], PARSE_ERRORS_BELOW_THE_FLOOR), []);
});

test('the chat document does not call for what is not there', () => {
  assert.deepEqual(scan([CHAT_DOCUMENT], MISSING_BELOW_THE_FLOOR), []);
});

test('the web app source stays inside the same floor', () => {
  // Vite lowers syntax to es2020, but it never rewrites a regular expression,
  // so a lookbehind survives the build untouched and lands in the bundle.
  const files = [...sourceFiles(resolve(root, 'src')), ...sourceFiles(resolve(repo, 'packages/shared/src'))];
  assert.ok(files.length > 20, 'found suspiciously few source files to scan');
  assert.deepEqual(scan(files, [...PARSE_ERRORS_BELOW_THE_FLOOR, ...MISSING_BELOW_THE_FLOOR]), []);
});

test('every surface says which colour scheme it is', () => {
  // Chrome on Android force-darkens pages that express no preference, and there
  // is exactly one theme here. A surface that stays quiet gets repainted by the
  // browser, which is not a failure any test of ours would otherwise see.
  for (const file of [resolve(root, 'src/styles.css'), CHAT_DOCUMENT]) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /color-scheme:\s*light/, `${file.replace(repo, '.')} does not declare a colour scheme`);
  }
});

test('the built bundle carries nothing a dependency smuggled in', () => {
  const assets = resolve(root, 'dist/assets');
  if (!existsSync(assets)) return; // Nothing built yet; the gate builds after this.
  const bundles = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(assets, name));
  assert.deepEqual(scan(bundles, [PARSE_ERRORS_BELOW_THE_FLOOR[0]]), []);
});
