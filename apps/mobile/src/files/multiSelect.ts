// The multi-select rules live in @sidekick/shared, because the browser draws the
// same Files screen and a selection that behaves differently depending on what
// you opened the workspace on is worse than no selection at all. This narrows
// the generics to the phone's row type so App.tsx and the tests beside it read
// exactly as they did.

import {
  selectAllInFolder as selectAllInFolderShared,
  fileIdsInFolderTree as fileIdsInFolderTreeShared,
  selectAllInFolderTree as selectAllInFolderTreeShared,
  toggleFolderTree as toggleFolderTreeShared,
  runSelectionDelete as runSelectionDeleteShared,
  DELETE_SELECTION_CONCURRENCY,
} from '@sidekick/shared';
import type { MobileRunnerFile, RunnerFileMutationResult } from './mobileRunnerFiles';

export {
  toggleSelectedFile,
  deleteSelectionConfirmCopy,
  deleteSelectionOutcomeCopy,
  DELETE_SELECTION_CONCURRENCY,
} from '@sidekick/shared';

export function selectAllInFolder(
  files: readonly MobileRunnerFile[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  return selectAllInFolderShared(files, folderKey, selected);
}

export function fileIdsInFolderTree(
  files: readonly MobileRunnerFile[],
  folderKey: string,
): string[] {
  return fileIdsInFolderTreeShared(files, folderKey);
}

export function selectAllInFolderTree(
  files: readonly MobileRunnerFile[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  return selectAllInFolderTreeShared(files, folderKey, selected);
}

export function toggleFolderTree(
  files: readonly MobileRunnerFile[],
  folderKey: string,
  selected: ReadonlySet<string>,
): Set<string> {
  return toggleFolderTreeShared(files, folderKey, selected);
}

export async function runSelectionDelete(
  fileIds: readonly string[],
  deleteOne: (fileId: string) => Promise<RunnerFileMutationResult>,
  concurrency: number = DELETE_SELECTION_CONCURRENCY,
): Promise<{ failedIds: string[] }> {
  return runSelectionDeleteShared(fileIds, deleteOne, concurrency);
}
