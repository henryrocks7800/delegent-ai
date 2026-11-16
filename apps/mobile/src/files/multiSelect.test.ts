import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleSelectedFile,
  selectAllInFolder,
  selectAllInFolderTree,
  fileIdsInFolderTree,
  toggleFolderTree,
  deleteSelectionConfirmCopy,
  deleteSelectionOutcomeCopy,
  runSelectionDelete,
  DELETE_SELECTION_CONCURRENCY,
} from './multiSelect';
import type { MobileRunnerFile, RunnerFileMutationResult } from './mobileRunnerFiles';

let seq = 0;
function f(relativeName: string): MobileRunnerFile {
  seq += 1;
  const name = relativeName.split('/').pop() || relativeName;
  return {
    id: `file_${seq.toString(16).padStart(32, '0')}`,
    name,
    relativeName,
    sizeBytes: 10,
    modifiedAt: seq,
    mimeType: 'text/plain',
    downloadable: true,
    downloadUrl: 'https://x/api/files/runner/file_x?token=v1.a',
  };
}

test('toggleSelectedFile adds, removes, and never mutates the input set', () => {
  const start = new Set<string>();
  const withA = toggleSelectedFile(start, 'a');
  assert.deepEqual(Array.from(withA), ['a']);
  assert.equal(start.size, 0, 'input set must not be mutated');
  const withAB = toggleSelectedFile(withA, 'b');
  assert.deepEqual(Array.from(withAB).sort(), ['a', 'b']);
  const withoutA = toggleSelectedFile(withAB, 'a');
  assert.deepEqual(Array.from(withoutA), ['b']);
});

test('selectAllInFolder covers the current folder ONLY: no subfolders, no other folders, no noise', () => {
  const docReport = f('documents/report.md');
  const docInvoice = f('documents/invoice.pdf');
  const docNested = f('documents/archive/old.md'); // subfolder: NOT covered
  const noteTodo = f('notes/todo.txt'); // other folder: NOT covered
  const rootLoose = f('readme.txt'); // root: NOT covered
  const docNoise = f('documents/__pycache__/x.pyc'); // noise: never selectable
  const files = [docReport, docInvoice, docNested, noteTodo, rootLoose, docNoise];

  const selected = selectAllInFolder(files, 'documents', new Set());
  assert.deepEqual(
    Array.from(selected).sort(),
    [docReport.id, docInvoice.id].sort(),
    'select all must cover exactly the direct files of the anchor folder',
  );

  // Files already selected elsewhere stay selected (select all only ADDS).
  const merged = selectAllInFolder(files, 'documents', new Set([noteTodo.id]));
  assert.ok(merged.has(noteTodo.id), 'a file selected in another folder must stay selected');
  assert.equal(merged.size, 3);

  // Root anchor covers only loose root files.
  const rootSelected = selectAllInFolder(files, '', new Set());
  assert.deepEqual(Array.from(rootSelected), [rootLoose.id]);
});

test('fileIdsInFolderTree selects a folder IN ITS ENTIRETY: folder + subfolders, not other folders, not noise', () => {
  const docReport = f('documents/report.md');
  const docNested = f('documents/archive/old.md');       // subfolder: INCLUDED
  const docDeep = f('documents/archive/2025/q1/x.md');    // deep subfolder: INCLUDED
  const noteTodo = f('notes/todo.txt');                   // other folder: excluded
  const rootLoose = f('readme.txt');                      // root: excluded
  const docNoise = f('documents/__pycache__/x.pyc');      // noise: excluded
  const files = [docReport, docNested, docDeep, noteTodo, rootLoose, docNoise];

  const ids = fileIdsInFolderTree(files, 'documents');
  assert.deepEqual(ids.sort(), [docReport.id, docNested.id, docDeep.id].sort());

  // Root ('') is only its own loose files, never "everything" - a folder select
  // can never accidentally grab the whole workspace.
  assert.deepEqual(fileIdsInFolderTree(files, ''), [rootLoose.id]);
});

test('selectAllInFolderTree adds the whole subtree and keeps prior selections', () => {
  const a = f('documents/a.md');
  const b = f('documents/sub/b.md');
  const other = f('notes/n.txt');
  const merged = selectAllInFolderTree([a, b, other], 'documents', new Set([other.id]));
  assert.deepEqual(Array.from(merged).sort(), [a.id, b.id, other.id].sort());
});

test('toggleFolderTree: selects a folder if not all in, deselects when all already in', () => {
  const a = f('documents/a.md');
  const b = f('documents/sub/b.md');
  const files = [a, b];
  // none selected -> selects the whole folder
  const on = toggleFolderTree(files, 'documents', new Set());
  assert.deepEqual(Array.from(on).sort(), [a.id, b.id].sort());
  // all selected -> deselects the whole folder
  const off = toggleFolderTree(files, 'documents', on);
  assert.equal(off.size, 0);
  // partial -> fills the rest in
  const filled = toggleFolderTree(files, 'documents', new Set([a.id]));
  assert.deepEqual(Array.from(filled).sort(), [a.id, b.id].sort());
});

test('selectAllInFolder (direct-only, legacy) still excludes subfolders', () => {
  const a = f('documents/a.md');
  const nested = f('documents/sub/b.md');
  const only = selectAllInFolder([a, nested], 'documents', new Set());
  assert.deepEqual(Array.from(only), [a.id]);
});

test('delete confirm copy carries the exact selected count', () => {
  assert.deepEqual(deleteSelectionConfirmCopy(12), { title: 'Delete 12 files?', message: "This can't be undone." });
  assert.deepEqual(deleteSelectionConfirmCopy(1), { title: 'Delete 1 file?', message: "This can't be undone." });
});

test('partial-failure alert copy reads "Deleted N of M"', () => {
  const partial = deleteSelectionOutcomeCopy(10, 12);
  assert.ok(partial);
  assert.equal(partial.title, 'Deleted 10 of 12');
  assert.match(partial.message, /2 files couldn't be deleted, so they're back in the list/);

  const oneFailed = deleteSelectionOutcomeCopy(11, 12);
  assert.ok(oneFailed);
  assert.equal(oneFailed.title, 'Deleted 11 of 12');
  assert.match(oneFailed.message, /1 file couldn't be deleted, so it's back in the list/);

  const allFailed = deleteSelectionOutcomeCopy(0, 3);
  assert.ok(allFailed);
  assert.equal(allFailed.title, 'Delete failed');

  assert.equal(deleteSelectionOutcomeCopy(12, 12), null, 'a clean sweep needs no alert');
});

test('runSelectionDelete reports ONLY the failed subset, in original order; not_found counts as deleted', async () => {
  const results: Record<string, RunnerFileMutationResult> = {
    a: { ok: true },
    b: { ok: false, error: 'unavailable' },
    c: { ok: false, error: 'not_found' }, // already gone server-side = success
    d: { ok: false, error: 'unavailable' },
    e: { ok: true },
  };
  const calls: string[] = [];
  const { failedIds } = await runSelectionDelete(['a', 'b', 'c', 'd', 'e'], async (id) => {
    calls.push(id);
    return results[id]!;
  });
  assert.deepEqual(failedIds, ['b', 'd'], 'only genuine failures roll back, in selection order');
  assert.deepEqual(calls.sort(), ['a', 'b', 'c', 'd', 'e'], 'every selected file must be attempted');
});

test('runSelectionDelete treats a thrown delete as failed instead of losing the batch', async () => {
  const { failedIds } = await runSelectionDelete(['a', 'b'], async (id) => {
    if (id === 'a') throw new Error('network fell over');
    return { ok: true };
  });
  assert.deepEqual(failedIds, ['a']);
});

test('runSelectionDelete runs a few at a time, never the whole batch at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 10 }, (_, i) => `id_${i}`);
  await runSelectionDelete(ids, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { ok: true };
  });
  assert.ok(peak <= DELETE_SELECTION_CONCURRENCY, `peak concurrency ${peak} must respect the cap`);
  assert.ok(peak >= 2, 'the batch should actually overlap requests');
});
