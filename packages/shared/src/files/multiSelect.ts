// Multi-select and batched delete for the Files surface, shared by the phone and
// the browser so a selection behaves the same in both.
//
// Locked decisions: "Select all" covers the CURRENT FOLDER ONLY (the folder the
// selection started in), selecting a folder header takes the whole subtree, and
// there is no undo. The count-confirm dialog is the safety net.

import { fullDirectoryPath, isNoiseFile, type WorkspaceFileLike } from './folderGroups.ts';

/** Result shape a delete has to answer with. `not_found` counts as deleted. */
export interface FileMutationOutcome {
  ok: boolean;
  error?: string;
}

/** Always returns a new Set, so React state sees a fresh reference. */
export function toggleSelectedFile(selected: ReadonlySet<string>, fileId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(fileId)) next.delete(fileId);
  else next.add(fileId);
  return next;
}

// Scoped to one folder: every visible file whose DIRECT folder is `folderKey`,
// matching exactly the rows drawn under that header. Subfolders are untouched,
// and a selection made elsewhere survives.
export function selectAllInFolder<T extends WorkspaceFileLike>(
  files: readonly T[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  for (const file of files) {
    if (isNoiseFile(file)) continue;
    if (fullDirectoryPath(file) === folderKey) next.add(file.id);
  }
  return next;
}

// Root is treated as its own loose files only, never "everything", so picking a
// folder can never quietly select the whole workspace.
function isInFolderTree(dir: string, folderKey: string): boolean {
  if (folderKey === '') return dir === '';
  return dir === folderKey || dir.startsWith(`${folderKey}/`);
}

export function fileIdsInFolderTree<T extends WorkspaceFileLike>(
  files: readonly T[],
  folderKey: string,
): string[] {
  const ids: string[] = [];
  for (const file of files) {
    if (isNoiseFile(file)) continue;
    if (isInFolderTree(fullDirectoryPath(file), folderKey)) ids.push(file.id);
  }
  return ids;
}

export function selectAllInFolderTree<T extends WorkspaceFileLike>(
  files: readonly T[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  for (const id of fileIdsInFolderTree(files, folderKey)) next.add(id);
  return next;
}

// If everything under the folder is already selected, take it all out;
// otherwise add whatever is missing.
export function toggleFolderTree<T extends WorkspaceFileLike>(
  files: readonly T[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const treeIds = fileIdsInFolderTree(files, folderKey);
  const next = new Set(selected);
  const allSelected = treeIds.length > 0 && treeIds.every((id) => next.has(id));
  for (const id of treeIds) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function deleteSelectionConfirmCopy(count: number): { title: string; message: string } {
  return {
    title: `Delete ${count} ${count === 1 ? 'file' : 'files'}?`,
    message: "This can't be undone.",
  };
}

// A clean sweep needs no alert: the rows have already gone. A partial failure
// says exactly how far it got, and a total failure mirrors the single-delete
// apology.
export function deleteSelectionOutcomeCopy(
  deletedCount: number,
  totalCount: number,
): { title: string; message: string } | null {
  if (deletedCount >= totalCount) return null;
  if (deletedCount === 0) {
    return {
      title: 'Delete failed',
      message: totalCount === 1
        ? "Couldn't delete that file just now, so it's back in the list. Try again in a moment."
        : "Couldn't delete those files just now, so they're back in the list. Try again in a moment.",
    };
  }
  const failed = totalCount - deletedCount;
  return {
    title: `Deleted ${deletedCount} of ${totalCount}`,
    message: failed === 1
      ? "1 file couldn't be deleted, so it's back in the list. Try again in a moment."
      : `${failed} files couldn't be deleted, so they're back in the list. Try again in a moment.`,
  };
}

// A few at a time: enough to feel quick, small enough not to fire one request
// per selected file at the signed proxy all at once.
export const DELETE_SELECTION_CONCURRENCY = 3;

// Runs the deletes through the existing single-file call. Returns the ids that
// failed, in selection order, so the caller restores exactly that subset.
export async function runSelectionDelete(
  fileIds: readonly string[],
  deleteOne: (fileId: string) => Promise<FileMutationOutcome>,
  concurrency: number = DELETE_SELECTION_CONCURRENCY,
): Promise<{ failedIds: string[] }> {
  const deleted: boolean[] = new Array(fileIds.length).fill(false);
  let cursor = 0;
  const worker = async () => {
    while (cursor < fileIds.length) {
      const index = cursor;
      cursor += 1;
      const id = fileIds[index]!;
      try {
        const result = await deleteOne(id);
        deleted[index] = result.ok || result.error === 'not_found';
      } catch {
        deleted[index] = false;
      }
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, fileIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { failedIds: fileIds.filter((_, index) => !deleted[index]) };
}
