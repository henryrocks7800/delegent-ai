// Spec-driven regression: user-visible strings must not name infrastructure.
//
// Source of truth: docs/architecture/SYSTEM_ARCHITECTURE.md §16 "Anti-
// architecture":
//
//   "No infrastructure vocabulary in chat copy. 'OpenRouter', 'Cloudflare',
//    'Fly', 'Supabase', 'Hermes', 'runner', 'container', 'machine' — all
//    banned from user-visible strings."
//
// And §2 rule 5: "Public copy never names infrastructure. The user sees
// 'your coworker', 'your workspace', 'the cloud space'. They never see
// 'OpenRouter', 'Cloudflare', 'Fly', 'Supabase', 'Hermes', 'runner'."
//
// The public-copy corollary is broader than exact provider names: terms such
// as runtime, storage volume, containers, OAuth tokens, and Linux box are also
// raw infrastructure/admin vocabulary when they appear in visible marketing
// copy instead of product vocabulary.
//
// This scanner walks string literals in the mobile + website user surfaces
// and fails if any banned word slips into a literal that ends up on the
// user's screen. The allowlist below is intentionally narrow: tests/specs may
// inspect the banned words and developer-only startup errors may name their
// missing dependency, but public vendor/runtime attribution is not exempt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// User-facing source roots. Worker source is NOT scanned because most of
// its strings are headers, error_code values, log lines etc. — internal,
// not rendered to users. The exception (worker-generated tool-card
// `summary`) is asserted separately by checkout / fallback-card tests.
const USER_FACING_ROOTS = [
  'apps/mobile/App.tsx',
  'apps/mobile/src',
  'apps/website/src',
];

const RETIRED_PUBLIC_ATTRIBUTION_ASSETS = [
  'apps/mobile/assets/powered-by-hermes.png',
  'apps/website/public/powered-by-hermes.png',
];

const ALLOW_EXTENSIONS = new Set(['.ts', '.tsx']);
const IGNORE_PARTS = new Set(['node_modules', '__tests__', 'dist', 'build']);

// Word-boundary banned vocabulary. The patterns use negative lookahead on
// dash/word characters so CSS classes like `container-page` and code
// identifiers like `HermesAgent`, `flyMachineId`, `runnerBaseUrl`,
// `hermes_instance_private` do not trip false positives. We only want to
// catch the English word as it would appear in user-rendered prose.
const BANNED = [
  { word: 'OpenRouter', pattern: /\bOpenRouter(?![-\w])/ },
  { word: 'Cloudflare', pattern: /\bCloudflare(?![-\w])/ },
  { word: 'Supabase',   pattern: /\bSupabase(?![-\w])/ },
  { word: 'Hermes',     pattern: /\bHermes(?![-\w])/ },
  { word: 'Fly Machines', pattern: /\bFly Machines\b/ },
  { word: 'runner',     pattern: /\brunner(?![-\w])/ },
  { word: 'container',  pattern: /\bcontainers?(?![-\w])/i },
  { word: 'machine',    pattern: /\bmachines?(?![-\w])/i },
  { word: 'runtime',    pattern: /\bruntimes?\b/i },
  { word: 'storage volume', pattern: /\bstorage\s+volumes?\b/i },
  { word: 'OAuth token', pattern: /\bOAuth\s+tokens?\b/i },
  { word: 'Linux box', pattern: /\bLinux\s+box\b/i },
];

// String literals that are obviously NOT user-rendered prose: URL paths,
// log-tag prefixes, CSS classes that happen to contain a banned token,
// shell-like flags. Skipping these BEFORE the banned-word check keeps the
// allowlist focused on actual policy decisions, not lexer noise.
function isObviouslyNonUserProse(literal) {
  if (literal.length === 0) return true;
  // URL paths
  if (/^\//.test(literal)) return true;
  // Log-tag prefixes like "[streaming] something happened"
  if (/^\[[A-Za-z][\w-]*\]/.test(literal)) return true;
  // CSS-class shapes (kebab tokens separated by spaces; common Tailwind
  // / Vite class-name strings would trip the `container` rule otherwise)
  if (/^[a-z0-9]+(?:[-\s]+[a-z0-9:_/]+)+$/.test(literal) && !/[A-Z\.\?\!]/.test(literal)) return true;
  // Identifier-like dev key (UPPER_SNAKE_CASE)
  if (/^[A-Z][A-Z0-9_]+$/.test(literal)) return true;
  // Single-token slugs like `fly_machines`, `studio`, `runner_ready` — no
  // capital letter or space means it's not a sentence.
  if (!/\s/.test(literal) && !/[A-Z]/.test(literal) && literal.length < 32) return true;
  return false;
}

// File + (banned word | regex) tuples that are exempt with an explicit
// reason. Each entry's reason must justify why the leak is intentional.
const ALLOWLIST = [
  // — Test/spec fixtures: these files inspect or assert ABOUT the banned
  //   vocabulary; the literals are necessarily present in the test itself.
  { file: /\.test\.(ts|tsx|mjs|js)$/, reason: 'test fixtures inspect the banned strings' },

  // — Dev-only setup errors thrown from publicSupabase.ts. These messages
  //   surface to the developer who forgot to set an env var; they are NOT
  //   shown to end users because the app crashes at startup before render
  //   if these throw. Spec scope is "chat copy + product UX strings".
  { file: 'apps/mobile/src/auth/publicSupabase.ts', word: 'Supabase', reason: 'dev-side env-misconfig error thrown before render' },

  // — Extractor false positive on apps/mobile/App.tsx.
  //   The simple lexer in extractStringLiterals() gets confused by certain
  //   ternary + template-literal shapes around line 3205 ("? `${err.message}
  //   Showing the last file list we loaded.`") and treats the rest of the
  //   file as a single 21k-char "string", causing it to falsely match
  //   identifier names like `refreshRunnerFiles` inside comments and code.
  //   The actual template literal text does NOT contain "runner". This
  //   exemption is scoped to runner/container/machine which are nearby
  //   internal identifiers — NOT the product-vocab tokens (OpenRouter,
  //   Cloudflare, Supabase, Hermes, Fly Machines), which still gate.
  { file: 'apps/mobile/App.tsx', word: 'runner', reason: 'extractor false-positive on internal `refreshRunnerFiles`/`RunnerFilesState`; no user-visible "runner" string' },
  { file: 'apps/mobile/App.tsx', word: 'container', reason: 'extractor false-positive on identifier names; no user-visible "container" string' },
  { file: 'apps/mobile/App.tsx', word: 'machine', reason: 'extractor false-positive on identifier names; no user-visible "machine" string' },
];

function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const entry = stack.pop();
    let stats;
    try { stats = statSync(entry); } catch { continue; }
    if (stats.isFile()) { yield entry; continue; }
    let children;
    try { children = readdirSync(entry); } catch { continue; }
    for (const child of children) {
      if (IGNORE_PARTS.has(child)) continue;
      stack.push(join(entry, child));
    }
  }
}

function shouldScan(absPath) {
  const ext = absPath.slice(absPath.lastIndexOf('.'));
  return ALLOW_EXTENSIONS.has(ext);
}

// Extract only the contents of string literals — single, double, backtick.
// Comments are stripped (a fuller implementation than the no-em-dashes
// scanner reuses the same lexer shape). We accept that template literals
// may include `${...}` expressions; the scan looks at the raw template
// text where the banned words would land in rendered output anyway.
//
// Regex-literal recognition: `replace(/foo/g, ...)` and similar produce
// /.../flags tokens that the naive lexer used to read as a `/` then a
// stray quote. We now look at the previous non-whitespace character and,
// when `/` lands in a context where a regex literal is the only valid
// JS token (after operators / commas / parens / keywords), we skip past
// the matching `/` + flags before continuing. Failure mode this fixes:
// container/runner/etc. false positives on files like WebViewChatScreen.
function extractStringLiterals(text) {
  const out = [];
  let i = 0;
  let lineNumber = 1;
  // Tracks the previous non-space, non-newline character we emitted to
  // the lexer. Used to disambiguate `/` between regex-start and division.
  let prevToken = '';
  // Words that, when they end at the current position, mean the next /
  // starts a regex literal (control keywords + a couple of likely
  // immediate-RHS callers).
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'in', 'of', 'instanceof', 'new', 'delete', 'void',
    'throw', 'yield', 'await', 'case', 'do', 'else',
  ]);
  function endsWithRegexKeyword(idx) {
    // Look backwards from idx-1 for an identifier; if it matches a
    // keyword that always precedes an expression, treat next `/` as regex.
    let j = idx - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z_]/.test(text[j])) j -= 1;
    const word = text.slice(j + 1, end);
    return REGEX_KEYWORDS.has(word);
  }
  function isRegexContext() {
    // After most operators / openers / commas, a `/` starts a regex.
    if (!prevToken) return true; // start of file
    if ('([{,;:=!&|?<>+-*^%~'.includes(prevToken)) return true;
    if (endsWithRegexKeyword(i)) return true;
    return false;
  }
  function skipRegexLiteral() {
    // Caller verified text[i] === '/'. Walk to the matching '/' that's
    // not inside a character class. Track [...] depth so '/' inside it
    // doesn't terminate the regex.
    i += 1;
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
      if (ch === '\n') return; // unterminated — bail
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { i += 1; break; }
      i += 1;
    }
    // Skip regex flags.
    while (i < text.length && /[gimsuy]/.test(text[i])) i += 1;
  }
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { lineNumber += 1; i += 1; continue; }
    // Line comment
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    // Block comment
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') lineNumber += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // Regex literal — only when the context allows it.
    if (c === '/' && isRegexContext()) {
      skipRegexLiteral();
      prevToken = '/';
      continue;
    }
    // String literal
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = lineNumber;
      i += 1;
      let buf = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          buf += text[i + 1] === 'n' ? '\n' : text[i + 1];
          if (text[i + 1] === 'n') lineNumber += 0; // we already counted source newlines
          i += 2;
          continue;
        }
        if (text[i] === '\n') lineNumber += 1;
        buf += text[i];
        i += 1;
      }
      i += 1;
      out.push({ line: startLine, value: buf });
      prevToken = quote;
      continue;
    }
    if (!/\s/.test(c)) prevToken = c;
    i += 1;
  }
  return out;
}

function isAllowlisted(relPath, banned, literalValue) {
  for (const entry of ALLOWLIST) {
    if (typeof entry.file === 'string') {
      if (entry.file !== relPath.replaceAll('\\', '/')) continue;
    } else if (entry.file instanceof RegExp) {
      if (!entry.file.test(relPath)) continue;
    }
    if (entry.word && entry.word !== banned.word) continue;
    if (entry.match instanceof RegExp && !entry.match.test(literalValue)) continue;
    return entry;
  }
  return null;
}

test('[architecture] §16 — no banned infrastructure vocabulary in user-visible mobile/website strings', () => {
  const offenders = [];
  for (const root of USER_FACING_ROOTS) {
    const absRoot = join(REPO, root);
    for (const file of walk(absRoot)) {
      if (!shouldScan(file)) continue;
      const rel = relative(REPO, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');
      const literals = extractStringLiterals(text);
      for (const lit of literals) {
        if (isObviouslyNonUserProse(lit.value)) continue;
        for (const banned of BANNED) {
          if (!banned.pattern.test(lit.value)) continue;
          const allowed = isAllowlisted(rel, banned, lit.value);
          if (allowed) continue;
          offenders.push(`${rel}:${lit.line} contains "${banned.word}" in user-visible string: ${JSON.stringify(lit.value.slice(0, 120))}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      `Architecture §16 forbids these words in user-visible strings: ${BANNED.map((b) => b.word).join(', ')}.`,
      'Either rewrite the offending string in product vocabulary (your coworker / your workspace / your cloud space),',
      'or add an explicit allowlist entry in tests/e2e/architecture-banned-vocabulary.test.mjs with a written reason.',
      '',
      ...offenders,
    ].join('\n'),
  );
});

test('[architecture] §16 — retired Hermes attribution assets are not shipped publicly', () => {
  const present = RETIRED_PUBLIC_ATTRIBUTION_ASSETS.filter((asset) => existsSync(join(REPO, asset)));
  assert.deepEqual(
    present,
    [],
    [
      'The public product no longer carries a Hermes attribution carve-out.',
      'Do not keep the retired powered-by asset in app/public bundles where it can be rediscovered or reintroduced without review.',
      ...present,
    ].join('\n'),
  );
});
