import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FILES_EXPANDED_FOLDERS_STORAGE_KEY,
  allCollapsibleKeys,
  buildFolderGroups,
  collapsedKeysFromExpanded,
  fileIdsInFolderTree,
  isHiddenByCollapsedAncestor,
  parseExpandedKeys,
  recentFiles,
  runSelectionDelete,
  serializeExpandedKeys,
  toggleFolderTree,
} from '@sidekick/shared';

// The browser drew its own version of the Files screen: its own noise list, no
// placeholder folders, no collapse, no way to take a folder in one go, and a
// rename that sat there until the runner answered. These tests hold it to the
// phone's behaviour, and to the one thing the browser has to get right on its
// own: dates arrive here as ISO strings, not epoch milliseconds.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, relative), 'utf8');

const SCREEN = read('../src/features/files/FilesScreen.tsx');
const API = read('../src/features/files/filesApi.ts');
const FOLDERS = read('../src/features/files/folders.ts');

// Rows exactly as the Worker sends them to a browser: modifiedAt is an ISO
// string. The phone sends a number for the same field.
const FILES = [
  { id: 'a', name: 'notes.md', relativeName: 'documents/notes.md', modifiedAt: '2026-07-01T09:00:00.000Z' },
  { id: 'b', name: 'q3.csv', relativeName: 'documents/reports/q3.csv', modifiedAt: '2026-07-20T09:00:00.000Z' },
  { id: 'c', name: 'logo.png', relativeName: 'pictures/logo.png', modifiedAt: '2026-07-10T09:00:00.000Z' },
  { id: 'd', name: 'readme.txt', relativeName: 'readme.txt', modifiedAt: '2026-06-01T09:00:00.000Z' },
  { id: 'noise', name: 'x.pyc', relativeName: 'documents/__pycache__/x.pyc', modifiedAt: '2026-07-26T09:00:00.000Z' },
];

test('an ISO date sorts like a date, not like a string', () => {
  // The browser used to sort with localeCompare on the raw field. That happens
  // to work for one fixed ISO format and silently reverses the moment a value
  // arrives with an offset instead of a Z, which is the sort of thing that
  // shows the wrong file at the top of Recent and is never traced back.
  const mixed = [
    { id: 'older', name: 'older.txt', modifiedAt: '2026-07-20T23:00:00+02:00' },
    { id: 'newer', name: 'newer.txt', modifiedAt: '2026-07-20T22:00:00Z' },
  ];
  assert.deepEqual(recentFiles(mixed, 2).map((f) => f.id), ['newer', 'older']);
});

test('the recent strip is the newest real files, noise excluded', () => {
  // The __pycache__ entry is the most recently written file in the workspace.
  // Letting it top the strip is how a reader ends up looking at toolchain
  // droppings instead of the document their coworker just wrote.
  assert.deepEqual(recentFiles(FILES, 3).map((f) => f.id), ['b', 'c', 'a']);
});

test('folders start collapsed, and only the ones opened by hand are open', () => {
  const groups = buildFolderGroups(FILES);
  const collapsible = allCollapsibleKeys(groups);
  assert.ok(collapsible.includes('documents'));
  assert.ok(collapsible.includes('documents/reports'));
  // Placeholder folders with nothing in them have nothing to hide.
  assert.equal(collapsible.includes('downloads'), false);

  const nothingOpened = collapsedKeysFromExpanded(collapsible, new Set());
  assert.deepEqual([...nothingOpened].sort(), [...collapsible].sort());

  const documentsOpen = collapsedKeysFromExpanded(collapsible, new Set(['documents']));
  assert.equal(documentsOpen.has('documents'), false);
  // The subfolder is still folded, and folding the parent hides it either way.
  assert.equal(documentsOpen.has('documents/reports'), true);
  assert.equal(isHiddenByCollapsedAncestor('documents/reports', new Set(['documents'])), true);
});

test('the folders you left open survive the next visit', () => {
  const raw = serializeExpandedKeys(new Set(['documents', 'documents/reports']));
  assert.deepEqual([...parseExpandedKeys(raw)].sort(), ['documents', 'documents/reports']);
  assert.deepEqual([...parseExpandedKeys('not json at all')], []);
  assert.deepEqual([...parseExpandedKeys(null)], []);
  // Pinned so the browser and the phone cannot drift onto two different keys.
  assert.match(SCREEN, /FILES_EXPANDED_FOLDERS_STORAGE_KEY/);
  assert.equal(FILES_EXPANDED_FOLDERS_STORAGE_KEY, 'delegent.files.expandedFolders.v1');
});

test('selecting a folder takes it in its entirety, and nothing outside it', () => {
  assert.deepEqual(fileIdsInFolderTree(FILES, 'documents').sort(), ['a', 'b']);
  assert.deepEqual(fileIdsInFolderTree(FILES, 'documents/reports'), ['b']);
  // Root is its own loose files only. If it meant "everything", one tick on the
  // top folder would arm a delete of the whole workspace.
  assert.deepEqual(fileIdsInFolderTree(FILES, ''), ['d']);
});

test('a folder already fully selected is cleared by the same tick', () => {
  const all = toggleFolderTree(FILES, 'documents', new Set());
  assert.deepEqual([...all].sort(), ['a', 'b']);
  assert.deepEqual([...toggleFolderTree(FILES, 'documents', all)], []);
  // Part-selected adds the rest rather than clearing, which is what the
  // half-tick on the header promises.
  assert.deepEqual([...toggleFolderTree(FILES, 'documents', new Set(['a']))].sort(), ['a', 'b']);
});

test('the folder tick has a half state, because a part-selected folder is neither', () => {
  // Without indeterminate the header reads as "nothing selected" while two of
  // its four files are armed for deletion.
  assert.match(SCREEN, /node\.indeterminate = partial/);
  assert.match(SCREEN, /partial=\{treeSelected > 0 && treeSelected < treeIds\.length\}/);
  assert.match(SCREEN, /checked=\{treeSelected === treeIds\.length\}/);
});

test('a file that was already gone counts as deleted, not as a failure', () => {
  // A 404 is the outcome the reader asked for. Counting it as a failure puts a
  // row that does not exist back into the list and apologises for succeeding.
  return runSelectionDelete(
    ['a', 'b'],
    async (id) => (id === 'a' ? { ok: true } : { ok: false, message: 'gone', error: 'not_found' }),
  ).then(({ failedIds }) => assert.deepEqual(failedIds, []));
});

test('only the rows that actually failed come back', () => {
  return runSelectionDelete(
    ['a', 'b', 'c'],
    async (id) => (id === 'b' ? { ok: false, message: 'nope' } : { ok: true }),
  ).then(({ failedIds }) => assert.deepEqual(failedIds, ['b']));
});

test('the API tells the failures apart so the screen can say which one happened', () => {
  assert.match(API, /result\.status === 404[\s\S]{0,120}error: 'not_found'/);
  assert.match(API, /status === 409[\s\S]{0,120}error: 'file_exists'/);
  assert.match(API, /status === 400[\s\S]{0,120}error: 'invalid_file_name'/);
});

test('a delete happens on screen before the request, not after it', () => {
  // On a cold runner the round trip is seconds. Awaiting it with the dialog up
  // is what Alex read as "it seems to take a long time".
  const body = SCREEN.slice(SCREEN.indexOf('async function runDelete'), SCREEN.indexOf('function submitRename'));
  const removed = body.indexOf('setFiles((current) => current.filter');
  const request = body.indexOf('await runSelectionDelete');
  assert.notEqual(removed, -1, 'the rows are never removed locally');
  assert.notEqual(request, -1, 'the batched delete is not run');
  assert.ok(removed < request, 'the rows are only removed after the server answers');
  // And a refusal has to put back exactly the subset that failed.
  assert.match(body, /failed\.has\(file\.id\)/);
  assert.match(body, /deleteSelectionOutcomeCopy/);
});

test('a rename shows the new name at once and rolls it back if it is refused', () => {
  const body = SCREEN.slice(SCREEN.indexOf('function submitRename'), SCREEN.indexOf('// Uploading into a workspace'));
  const closed = body.indexOf('setRenaming(null)');
  const applied = body.indexOf('withRenamedPath');
  const request = body.indexOf('renameRunnerFile(');
  // -1 satisfies "comes first", so each has to be found before it is ordered.
  assert.notEqual(applied, -1, 'the new name is never shown before the server agrees');
  assert.notEqual(closed, -1, 'the dialog is never closed');
  assert.notEqual(request, -1, 'the rename is never sent');
  assert.ok(closed < request, 'the dialog waits on the network before it closes');
  assert.ok(applied < request, 'the row waits on the network before it shows the new name');
  // The rollback restores the row object we started with, not a guess at it.
  assert.match(body, /file\.id === target\.id \? target : file/);
  // Every refusal the runner can give says something different.
  for (const reason of ['file_exists', 'invalid_file_name', 'not_found']) {
    assert.match(body, new RegExp(`result\\.error === '${reason}'`), `no message for ${reason}`);
  }
  // Caught locally so the dialog can answer instantly for the obvious case.
  assert.match(body, /\[\\\\\/\]/);
});

test('the browser no longer keeps its own copy of the folder rules', () => {
  // Two implementations of "which folder is this file in" drift until the same
  // workspace looks different depending on what you opened it on.
  assert.equal(/function buildFolderGroups/.test(FOLDERS), false, 'folders.ts still groups files itself');
  assert.equal(/function isNoiseFile/.test(FOLDERS), false, 'folders.ts still has its own noise list');
  assert.match(SCREEN, /buildFolderGroups,[\s\S]{0,600}from '@sidekick\/shared'/);
});
