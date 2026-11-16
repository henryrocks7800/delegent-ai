// [Batch 6 §4.5] Release-gate scanner — fails if a U+2014 em-dash appears in
// any user-facing source file. The checklist directive:
//
//   "Add a lightweight check or release-gate search so obvious user-facing
//    em-dash characters do not come back."
//
// The Hermes-Agent style for Delegent AI prefers commas / colons / parentheses
// over em-dashes; the choice is editorial, not a typography rule. Code
// comments + tests + docs are allowed to use em-dashes (they're not rendered
// to users). Maestro evidence files + build artefacts are ignored.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const EM_DASH = '—';

// User-facing source roots — anything in these dirs that renders text to the
// user must use commas/colons/parentheses, not em-dashes.
const USER_FACING_ROOTS = [
  'apps/mobile/src',
  'apps/mobile/App.tsx',
  'apps/website/src',
  'apps/worker/src',
  'packages/shared/src',
];

const ALLOW_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// Files where em-dashes are explicitly OK (build-generated, never user-rendered).
const ALLOW_FILES = new Set([
  // Reserved for any place we deliberately ship the em-dash; empty by default.
]);

// Within the allowed roots, ignore these subpaths.
const IGNORE_SUBPATHS = [
  'node_modules',
  '__tests__',
  '.test.',
  '.spec.',
  'android/build',
  'allure-report',
];

function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const entry = stack.pop();
    let stats;
    try { stats = statSync(entry); } catch { continue; }
    if (stats.isFile()) {
      yield entry;
      continue;
    }
    let children;
    try { children = readdirSync(entry); } catch { continue; }
    for (const child of children) stack.push(join(entry, child));
  }
}

function shouldScan(absolutePath) {
  const rel = relative(REPO, absolutePath);
  if (ALLOW_FILES.has(rel)) return false;
  if (IGNORE_SUBPATHS.some((needle) => rel.includes(needle))) return false;
  const ext = absolutePath.slice(absolutePath.lastIndexOf('.'));
  return ALLOW_EXTENSIONS.has(ext);
}

// Strip line + block comments before scanning. The header comment is explicit
// that em-dashes in comments are OK ("Code comments + tests + docs are allowed
// to use em-dashes — they're not rendered to users"). The original line-level
// .includes() check ignored that — this trims comment regions so they don't
// produce false positives on developer notes / TODOs / explanations.
function stripCommentsForScan(text) {
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    let cleaned = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', cursor);
        if (end === -1) { cursor = line.length; break; }
        inBlockComment = false;
        cursor = end + 2;
        continue;
      }
      // Look for the next comment opener — // (line) or /* (block) — but only
      // outside of strings. The lexer below is intentionally simple: it tracks
      // basic single / double / backtick strings without escape recovery,
      // which is sufficient for this scan because we only need to *exclude*
      // comments, not parse them.
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      const before = cursor;
      while (cursor < line.length) {
        const ch = line[cursor];
        if (!inSingle && !inDouble && !inTemplate) {
          if (ch === '/' && line[cursor + 1] === '/') { break; }
          if (ch === '/' && line[cursor + 1] === '*') { break; }
        }
        if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
        else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
        else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate;
        cursor += 1;
      }
      cleaned += line.slice(before, cursor);
      if (cursor >= line.length) break;
      if (line[cursor] === '/' && line[cursor + 1] === '/') {
        // line comment — rest of line is comment
        cursor = line.length;
        break;
      }
      if (line[cursor] === '/' && line[cursor + 1] === '*') {
        inBlockComment = true;
        cursor += 2;
      }
    }
    out[i] = cleaned;
  }
  return out;
}

function scanFile(absolutePath) {
  const text = readFileSync(absolutePath, 'utf8');
  const codeLines = stripCommentsForScan(text);
  const hits = [];
  for (let i = 0; i < codeLines.length; i += 1) {
    if (codeLines[i].includes(EM_DASH)) {
      hits.push({ line: i + 1, snippet: codeLines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}

test('no em-dash (U+2014) in user-facing source files', () => {
  const offenders = [];
  for (const root of USER_FACING_ROOTS) {
    const absRoot = join(REPO, root);
    let stats;
    try { stats = statSync(absRoot); } catch { continue; }
    if (stats.isFile()) {
      if (shouldScan(absRoot)) {
        const hits = scanFile(absRoot);
        if (hits.length > 0) offenders.push({ file: relative(REPO, absRoot), hits });
      }
      continue;
    }
    for (const file of walk(absRoot)) {
      if (!shouldScan(file)) continue;
      const hits = scanFile(file);
      if (hits.length > 0) offenders.push({ file: relative(REPO, file), hits });
    }
  }

  if (offenders.length > 0) {
    const lines = ['Found em-dash (U+2014) in user-facing source files. Replace with comma / colon / parentheses / plain hyphen per the AGENT_TODO_CHECKLIST §4.5 directive.', ''];
    for (const o of offenders) {
      lines.push(`  ${o.file}:`);
      for (const h of o.hits) lines.push(`    line ${h.line}: ${h.snippet}`);
    }
    assert.fail(lines.join('\n'));
  }
});
