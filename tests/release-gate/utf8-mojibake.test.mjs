// No double-encoded UTF-8 anywhere a customer can see it.
//
// THE TRAP THIS EXISTS FOR, and it has already bitten once. From CLAUDE.md:
//
//   "Careful with PowerShell 5.1 and UTF-8. `Get-Content -Raw` on a UTF-8 file
//    with no BOM decodes it as ANSI, and writing it back double-encodes every
//    non-ASCII character. That is how a pound sign becomes mojibake in a file
//    that looked fine."
//
// It happened to apps/webapp/src/features/admin/AdminScreen.tsx, where the zero
// line of the revenue chart rendered as "Â£0" instead of "£0". Found on
// 2026-08-28 during a full audit, by which time it had been shipping.
//
// Nothing caught it because mojibake is VALID UTF-8. It compiles, it lints, it
// type-checks, it passes every other test. The only way to catch it is to look
// for the specific byte sequences that a UTF-8-through-ANSI round trip
// produces, which is what this does.
//
// The signatures below are the common ones. Each is what you get when a real
// character is encoded to UTF-8 and then re-decoded as cp1252:
//
//   £  ->  Â£        '  ->  â€™        "  ->  â€œ / â€\u009d
//   –  ->  â€“        —  ->  â€”        é  ->  Ã©
//   …  ->  â€¦        •  ->  â€¢        ­  ->  Â  (non-breaking space)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// URL.pathname is not a filesystem path on Windows; it yields /C:/... .
// fileURLToPath is the only correct conversion, and this repo has been bitten
// by that too.
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.expo',
  'android', 'ios', 'docs', 'tests', '.next', 'out',
]);

// Source that ships to a user. Deliberately excludes docs and archives: a
// historical note quoting mojibake is a record, not a defect.
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.html', '.json', '.css'];

const MOJIBAKE = [
  ['Â£', '£'],
  ['â€™', "'"],
  ['â€œ', '"'],
  ['â€“', '–'],
  ['â€”', '—'],
  ['â€¦', '…'],
  ['â€¢', '•'],
  ['Ã©', 'é'],
  ['Ã¨', 'è'],
  ['Ã¡', 'á'],
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

test('[encoding] no double-encoded UTF-8 in shipping source', () => {
  const files = walk(join(REPO, 'apps')).concat(walk(join(REPO, 'packages')));
  assert.ok(files.length > 100, `expected to scan the source tree, only found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [broken, intended] of MOJIBAKE) {
      let at = text.indexOf(broken);
      while (at !== -1) {
        const line = text.slice(0, at).split('\n').length;
        offenders.push(
          `${relative(REPO, file).split(sep).join('/')}:${line} contains "${broken}", which should be "${intended}"`,
        );
        at = text.indexOf(broken, at + broken.length);
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'Double-encoded UTF-8 found. This is what PowerShell 5.1 does to a UTF-8 file '
    + 'with no BOM when you read it with Get-Content -Raw and write it back. '
    + 'Fix it with the editing tools, NOT by round-tripping through the shell, '
    + 'or you will simply re-encode it a third time.\n\n'
    + offenders.join('\n'),
  );
});
