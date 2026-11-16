import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNoiseFile,
  buildFolderGroups,
  allCollapsibleKeys,
  collapsedKeysFromExpanded,
  isHiddenByCollapsedAncestor,
  recentFiles,
  parseExpandedKeys,
  serializeExpandedKeys,
} from './folderGroups';
import type { MobileRunnerFile } from './mobileRunnerFiles';

let seq = 0;
function f(relativeName: string, modifiedAt = ++seq): MobileRunnerFile {
  const name = relativeName.split('/').pop() || relativeName;
  return { id: `file_${(seq).toString(16).padStart(32, '0')}`, name, relativeName, sizeBytes: 10, modifiedAt, mimeType: 'text/plain', downloadable: true, downloadUrl: 'https://x/api/files/runner/file_x?token=v1.a' };
}
const find = (groups: ReturnType<typeof buildFolderGroups>, key: string) => groups.find((g) => g.key === key);

test('isNoiseFile flags build-artifact / VCS clutter but keeps real files', () => {
  assert.equal(isNoiseFile(f('home/buku/__pycache__/buku.cpython-311.pyc')), true);
  assert.equal(isNoiseFile(f('home/buku/buku.egg-info/PKG-INFO')), true);
  assert.equal(isNoiseFile(f('home/proj/node_modules/left-pad/index.js')), true);
  assert.equal(isNoiseFile(f('home/proj/.git/config')), true);
  assert.equal(isNoiseFile(f('home/app/main.pyc')), true);
  assert.equal(isNoiseFile(f('documents/invoice-march.pdf')), false);
  assert.equal(isNoiseFile(f('home/buku/README.md')), false);
  assert.equal(isNoiseFile(f('notes.txt')), false);
});

test('buildFolderGroups filters noise so the listing is real files only', () => {
  const groups = buildFolderGroups([
    f('home/buku/__pycache__/x.pyc'),
    f('home/buku/README.md'),
    f('documents/report.md'),
  ]);
  const all = groups.flatMap((g) => g.files.map((x) => x.relativeName));
  assert.ok(all.includes('home/buku/README.md'));
  assert.ok(all.includes('documents/report.md'));
  assert.ok(!all.some((p) => p?.includes('__pycache__')), 'noise must be filtered out');
});

test('buildFolderGroups seeds default folders + computes whole-subtree counts', () => {
  const groups = buildFolderGroups([
    f('home/buku/README.md'),
    f('home/buku/src/main.py'),
    f('home/buku/src/util.py'),
    f('documents/report.md'),
  ]);
  // default folders always present
  for (const key of ['home', 'documents', 'pictures', 'downloads', 'notes']) assert.ok(find(groups, key), `${key} folder missing`);
  // home holds 3 files across its subtree even though none are direct children
  assert.equal(find(groups, 'home')!.descendantFileCount, 3);
  assert.equal(find(groups, 'home/buku')!.descendantFileCount, 3);
  assert.equal(find(groups, 'home/buku/src')!.descendantFileCount, 2);
  assert.equal(find(groups, 'documents')!.descendantFileCount, 1);
  assert.equal(find(groups, 'pictures')!.descendantFileCount, 0);
});

test('allCollapsibleKeys returns every non-root folder that holds files (empty placeholders excluded)', () => {
  const groups = buildFolderGroups([
    f('home/buku/README.md'),
    f('home/buku/src/main.py'),
    f('documents/note.md'),
  ]);
  const keys = allCollapsibleKeys(groups);
  assert.ok(keys.includes('home'), 'home holds files -> collapsible');
  assert.ok(keys.includes('home/buku'), 'nested folder with files -> collapsible');
  assert.ok(keys.includes('home/buku/src'), 'deeper folder with files -> collapsible');
  assert.ok(keys.includes('documents'), 'documents holds a file -> collapsible');
  assert.ok(!keys.includes('pictures'), 'empty default folder is NOT collapsible');
  assert.ok(!keys.includes(''), 'root is never collapsible');
});

test('collapsedKeysFromExpanded: every collapsible folder is collapsed unless explicitly expanded (default collapsed)', () => {
  const groups = buildFolderGroups([f('home/buku/README.md'), f('documents/note.md')]);
  const keys = allCollapsibleKeys(groups);
  // No expansions -> everything collapsed (the default-collapsed behaviour).
  const noneExpanded = collapsedKeysFromExpanded(keys, new Set());
  assert.equal(noneExpanded.size, keys.length);
  assert.ok(noneExpanded.has('home'));
  assert.ok(noneExpanded.has('documents'));
  // Expanding 'home' removes only it from the collapsed set.
  const homeExpanded = collapsedKeysFromExpanded(keys, new Set(['home']));
  assert.ok(!homeExpanded.has('home'));
  assert.ok(homeExpanded.has('documents'));
});

test('recentFiles returns the newest real files across all folders, noise filtered', () => {
  const files = [
    f('documents/old.md', 100),
    f('home/buku/__pycache__/x.pyc', 999), // noise, must be excluded even though newest
    f('documents/report.pdf', 500),
    f('downloads/data.csv', 400),
  ];
  const recent = recentFiles(files, 2);
  assert.deepEqual(recent.map((r) => r.relativeName), ['documents/report.pdf', 'downloads/data.csv']);
  assert.ok(!recent.some((r) => r.relativeName?.includes('__pycache__')), 'noise excluded from recent');
  assert.equal(recentFiles(files, 0).length, 0);
});

test('expanded-key persistence round-trips and tolerates junk', () => {
  const set = new Set(['home', 'documents/reports']);
  assert.deepEqual(parseExpandedKeys(serializeExpandedKeys(set)), set);
  assert.deepEqual(parseExpandedKeys(null), new Set());
  assert.deepEqual(parseExpandedKeys('not json'), new Set());
  assert.deepEqual(parseExpandedKeys('{"a":1}'), new Set(), 'non-array JSON -> empty');
  assert.deepEqual(parseExpandedKeys('["ok", 3, "", "two"]'), new Set(['ok', 'two']), 'non-string / empty entries dropped');
});

test('isHiddenByCollapsedAncestor folds an entire subtree under a collapsed parent', () => {
  const collapsed = new Set<string>(['home']);
  assert.equal(isHiddenByCollapsedAncestor('home', collapsed), false, 'the collapsed folder itself stays visible');
  assert.equal(isHiddenByCollapsedAncestor('home/buku', collapsed), true);
  assert.equal(isHiddenByCollapsedAncestor('home/buku/src', collapsed), true);
  assert.equal(isHiddenByCollapsedAncestor('documents', collapsed), false);
  assert.equal(isHiddenByCollapsedAncestor('', collapsed), false);
  // collapsing a deeper node only hides its own descendants
  const deep = new Set<string>(['home/buku']);
  assert.equal(isHiddenByCollapsedAncestor('home', deep), false);
  assert.equal(isHiddenByCollapsedAncestor('home/buku/src', deep), true);
});
