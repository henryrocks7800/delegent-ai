// The folder-grouping logic lives in @sidekick/shared, because the browser
// draws the same Files screen and two copies of "which folder is this file in"
// drift until the same workspace looks different depending on what you opened
// it on. This narrows the generic to the phone's row type so App.tsx and the
// tests beside it read exactly as they did.

import {
  buildFolderGroups as buildFolderGroupsShared,
  allCollapsibleKeys as allCollapsibleKeysShared,
  recentFiles as recentFilesShared,
  type FolderGroup as SharedFolderGroup,
} from '@sidekick/shared';
import type { MobileRunnerFile } from './mobileRunnerFiles';

export {
  DEFAULT_FOLDERS,
  FOLDER_ORDER,
  FILES_EXPANDED_FOLDERS_STORAGE_KEY,
  fullDirectoryPath,
  isNoiseFile,
  serializeExpandedKeys,
  parseExpandedKeys,
  collapsedKeysFromExpanded,
  isHiddenByCollapsedAncestor,
} from '@sidekick/shared';

export type FolderGroup = SharedFolderGroup<MobileRunnerFile>;

export function buildFolderGroups(files: readonly MobileRunnerFile[]): FolderGroup[] {
  return buildFolderGroupsShared(files);
}

export function allCollapsibleKeys(groups: readonly FolderGroup[]): string[] {
  return allCollapsibleKeysShared(groups);
}

export function recentFiles(files: readonly MobileRunnerFile[], limit = 6): MobileRunnerFile[] {
  return recentFilesShared(files, limit);
}
