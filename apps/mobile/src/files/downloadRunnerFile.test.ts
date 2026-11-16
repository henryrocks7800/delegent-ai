import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safeDownloadFileName } from './downloadRunnerFile';

// This file is TYPECHECKED, unlike the .mjs suites next door, and two things
// bite there. readFileSync's overloads reject a URL object under our tsconfig,
// and `new URL(...)` resolves to the DOM URL (the config includes the DOM lib),
// which is not assignable to Node's. Passing the href STRING sidesteps both.
const source = readFileSync(fileURLToPath(new URL('./downloadRunnerFile.ts', import.meta.url).href), 'utf8');
const appSource = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url).href), 'utf8');

// The old implementation was `Linking.openURL(file.downloadUrl)`. Android's
// browser saves that; iOS opens Safari, which saves nothing and renders
// nothing, so Alex got a blank screen and no file (2026-08-13). The Worker was
// already forcing content-disposition: attachment, so the fault was purely the
// client hand-off being wrong for the platform.
test('download hands the file to the share sheet, never to the browser', () => {
  // Match the CALL, not the phrase: the replacement carries a comment
  // explaining what it replaced, and a naive search finds its own documentation.
  assert.doesNotMatch(
    appSource,
    /await Linking\.openURL\(file\.downloadUrl\)/,
    'handing the download URL to the OS browser is the defect this replaced',
  );
  assert.match(appSource, /downloadRunnerFileToPhone\(file\)/);

  // Download into the sandbox, then share. Both steps, in that order.
  assert.match(source, /FileSystem\.File\.downloadFileAsync\(file\.downloadUrl, destination\)/);
  assert.match(source, /Sharing\.shareAsync\(downloaded\.uri/);
  assert.ok(
    source.indexOf('downloadFileAsync') < source.indexOf('shareAsync'),
    'the file must exist locally before it is shared',
  );
  // The SDK 55 API, not the legacy one. cacheDirectory/downloadAsync moved to
  // expo-file-system/legacy and do not exist on the modern entry point; CI's
  // typecheck caught the difference.
  assert.match(source, /FileSystem\.Paths\.cache/);
  assert.doesNotMatch(source, /FileSystem\.cacheDirectory/);
  // Check the IMPORT, not the file text: the code explains in a comment which
  // API it deliberately avoids, and a whole-file search finds that sentence.
  // Exactly the mistake made twice already in this file's tests.
  assert.doesNotMatch(source, /await import\('expo-file-system\/legacy'\)/);
  assert.match(source, /await import\('expo-file-system'\)/);
});

test('native modules are loaded lazily, the house rule since the 2026-07-19 crash', () => {
  // Expo binds native modules on first property access, not at import, so a
  // static import evaluates on a binary built before the module existed and
  // crashes at launch. That is exactly what ExponentImagePicker did.
  assert.match(source, /await import\('expo-file-system'\)/);
  assert.match(source, /await import\('expo-sharing'\)/);
  assert.doesNotMatch(source, /^import .*expo-file-system/m);
  assert.doesNotMatch(source, /^import .*expo-sharing/m);
});

// A failed fetch writes its body to disk as happily as real content, and our
// download route answers JSON on failure. Sharing that would hand the user a
// file containing our error and look like success.
test('a download that did not produce a real file is a failure, not a file', () => {
  assert.match(source, /!downloaded\?\.uri \|\| !downloaded\.exists/);
  assert.match(source, /downloaded\.size === 0/);
  assert.match(source, /reason: 'download_failed'/);
});

test('a stale file from a previous run does not block a re-download', () => {
  assert.match(source, /if \(destination\.exists\) destination\.delete\(\)/);
});

test('the filename from the runner is never trusted onto the filesystem', () => {
  // A slash would write outside the intended directory; a colon or a leading
  // dot breaks on some filesystems. The name comes from the runner, so it is
  // not ours to trust.
  // An ordinary name passes through untouched.
  assert.equal(safeDownloadFileName('report.pdf'), 'report.pdf');
  assert.equal(safeDownloadFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeDownloadFileName('.hidden'), '_hidden');
  assert.equal(safeDownloadFileName(''), 'download');
  assert.equal(safeDownloadFileName('   '), 'download');

  // The PROPERTY that matters, asserted as a property rather than as one
  // hand-computed string: nothing that could escape the directory survives.
  for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', 'a/../../b', './../x']) {
    const safe = safeDownloadFileName(hostile);
    assert.ok(!safe.includes('/'), `forward slash survived in "${safe}"`);
    assert.ok(!safe.includes('\\'), `backslash survived in "${safe}"`);
    assert.ok(!safe.startsWith('.'), `leading dot survived in "${safe}"`);
  }

  // Bounded, so a pathological name cannot blow a filesystem limit.
  assert.equal(safeDownloadFileName('x'.repeat(500)).length, 120);
});

test('a device with no share sheet is refused honestly rather than silently', () => {
  assert.match(source, /Sharing\.isAvailableAsync\(\)/);
  assert.match(source, /reason: 'unsupported'/);
});
