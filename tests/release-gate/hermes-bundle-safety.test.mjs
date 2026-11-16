// Things that compile, typecheck, lint and pass every unit test, and then kill
// the release build inside the Hermes bytecode compiler.
//
// WHY THIS FILE EXISTS
//   Build 38 (2026-08-19) died with:
//     main.jsbundle:331655:32: error: Invalid expression encountered
//   The cause was a dynamic import written with a TEMPLATE literal:
//     const moduleName = 'expo-iap';
//     await import(`${moduleName}`)
//   Metro can only rewrite a dynamic import into a lazy require when the
//   specifier is statically known. An unresolvable one survives into
//   main.jsbundle as a real import() expression, and Hermes rejects it.
//
//   Nothing local caught it. Typecheck passes, lint passes, all 326 mobile
//   tests pass, because they are source-string tests and TypeScript is
//   perfectly happy with a template-literal import. It only fails when Hermes
//   compiles the release bundle, i.e. five minutes into a cloud build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// URL.pathname yields "/C:/..." on Windows and is not a filesystem path.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE = join(REPO, 'apps', 'mobile');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'android' || entry === 'ios' || entry === '.expo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments and string bodies, preserving offsets and newlines.
 *
 * Needed because the fix for this very bug documents the broken pattern in a
 * comment, and a regex scan without this flags the documentation as the
 * defect. Naive comment stripping is not enough either: `'https://x'` would
 * lose the rest of its line. So this walks the source tracking whether it is
 * inside a string, template, line comment or block comment, and replaces the
 * CONTENTS with spaces rather than deleting them, so reported line numbers
 * still point at the real thing.
 */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) break;
        j += 1;
      }
      // Keep the quote characters themselves: the scan below needs to see that
      // a specifier STARTS with a quote.
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

test('every dynamic import in the mobile app uses a static string specifier', () => {
  const offenders = [];

  for (const file of sourceFiles(MOBILE)) {
    const source = blankCommentsAndStrings(readFileSync(file, 'utf8'));
    // Find each `import(` that is a call, not the `import x from` statement,
    // then look at the first meaningful character of the specifier. A leading
    // block comment (Metro/webpack pragmas like /* webpackIgnore: true */) is
    // skipped, because it is legal and not what breaks Hermes.
    const callSites = [...source.matchAll(/\bimport\s*\(/g)];
    for (const match of callSites) {
      let rest = source.slice(match.index + match[0].length);
      rest = rest.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '');
      if (rest.startsWith("'") || rest.startsWith('"')) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${relative(REPO, file).replace(/\\/g, '/')}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These dynamic imports do not use a plain string literal, so Metro cannot '
    + 'resolve them and Hermes will fail the release bundle with "Invalid '
    + 'expression encountered". Use await import(\'the-module\') and rely on '
    + 'try/catch for optionality:\n  ' + offenders.join('\n  '),
  );
});
