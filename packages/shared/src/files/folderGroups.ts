// Folder grouping, noise filtering and collapse logic for the Files surface.
//
// This started life inside the phone app. It moved here when the browser needed
// the same behaviour, because two copies of "which folder does this file belong
// to" is exactly the kind of thing that drifts until the same workspace looks
// different depending on what you opened it on.
//
// Pure: no React, no native, no DOM. Generic over the file shape so the phone
// (modifiedAt as epoch ms) and the browser (modifiedAt as an ISO string) can
// both pass their own rows in without a conversion layer.

export interface WorkspaceFileLike {
  id: string;
  name: string;
  relativeName?: string;
  modifiedAt?: string | number;
}

/** Epoch milliseconds for a row, whichever way the surface carries the date. */
export function modifiedAtMs(file: WorkspaceFileLike): number {
  const value = file.modifiedAt;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// The folders a reader always sees, even before the workspace is online or any
// file has been saved, so the shape is familiar from the first visit. Icons are
// Feather names; each surface maps them to its own icon component.
export const DEFAULT_FOLDERS: readonly { key: string; label: string; icon: string }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'documents', label: 'Documents', icon: 'file-text' },
  { key: 'pictures', label: 'Pictures', icon: 'image' },
  { key: 'downloads', label: 'Downloads', icon: 'download' },
  { key: 'notes', label: 'Notes', icon: 'edit-3' },
];

export const FOLDER_ORDER: readonly string[] = DEFAULT_FOLDERS.map((f) => f.key);
const FOLDER_LABELS: Record<string, string> = Object.fromEntries(DEFAULT_FOLDERS.map((f) => [f.key, f.label]));
const FOLDER_ICONS: Record<string, string> = Object.fromEntries(DEFAULT_FOLDERS.map((f) => [f.key, f.icon]));

/** Full lowercase directory path (everything before the last '/'); '' at root. */
export function fullDirectoryPath(file: WorkspaceFileLike): string {
  const rel = (file.relativeName ?? file.name).replace(/\\+/g, '/');
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash >= 0 ? rel.slice(0, lastSlash).toLowerCase() : '';
}

// Build-artifact and VCS noise. A cloned repo or a pip install used to dump
// hundreds of __pycache__ entries, which ate the listing cap and turned the
// screen into an endless flat scroll of toolchain internals.
const NOISE_DIR_SEGMENTS: readonly string[] = ['__pycache__', 'node_modules', '.git', '.venv', 'venv', '.next', '.cache', '.pytest_cache', '.mypy_cache'];
const NOISE_DIR_SUFFIXES: readonly string[] = ['.egg-info'];
const NOISE_NAME_SUFFIXES: readonly string[] = ['.pyc', '.pyo', '.class', '.ds_store', '.map.js', '.map'];

export function isNoiseFile(file: WorkspaceFileLike): boolean {
  const rel = (file.relativeName ?? file.name).replace(/\\+/g, '/').toLowerCase();
  for (const seg of rel.split('/')) {
    if (NOISE_DIR_SEGMENTS.includes(seg)) return true;
    if (NOISE_DIR_SUFFIXES.some((s) => seg.endsWith(s))) return true;
  }
  return NOISE_NAME_SUFFIXES.some((s) => rel.endsWith(s));
}

export interface FolderGroup<T extends WorkspaceFileLike> {
  /** Full directory path, lowercase and slash-separated; '' for root. */
  key: string;
  depth: number;
  label: string;
  /** Feather icon name; each surface casts to its own icon type at render. */
  icon: string;
  files: T[];
  /** Files in this directory plus every subdirectory. */
  descendantFileCount: number;
}

export function buildFolderGroups<T extends WorkspaceFileLike>(files: readonly T[]): FolderGroup<T>[] {
  const map = new Map<string, T[]>();

  for (const folder of DEFAULT_FOLDERS) map.set(folder.key, []);

  for (const file of files.filter((f) => !isNoiseFile(f))) {
    const dir = fullDirectoryPath(file);
    const bucket = map.get(dir) ?? [];
    bucket.push(file);
    map.set(dir, bucket);
    // Seed every ancestor so nested folders render as a hierarchy.
    let cursor = dir;
    while (cursor.includes('/')) {
      cursor = cursor.slice(0, cursor.lastIndexOf('/'));
      if (!map.has(cursor)) map.set(cursor, []);
    }
  }

  const keys = Array.from(map.keys());
  keys.sort((a, b) => {
    const aSegs = a === '' ? [''] : a.split('/');
    const bSegs = b === '' ? [''] : b.split('/');
    const aTop = aSegs[0]!;
    const bTop = bSegs[0]!;
    if (aTop !== bTop) {
      const aIdx = FOLDER_ORDER.indexOf(aTop);
      const bIdx = FOLDER_ORDER.indexOf(bTop);
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      if (aTop === '' && bTop !== '') return 1;
      if (bTop === '' && aTop !== '') return -1;
      return aTop.localeCompare(bTop);
    }
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const segs = key === '' ? [''] : key.split('/');
    const depth = key === '' ? 0 : segs.length - 1;
    const isTop = depth === 0;
    const label = isTop
      ? (FOLDER_LABELS[key] ?? (key === '' ? 'Root' : key.charAt(0).toUpperCase() + key.slice(1)))
      : (segs[segs.length - 1] ?? key);
    const icon = isTop ? (FOLDER_ICONS[key] ?? (key === '' ? 'hard-drive' : 'folder')) : 'folder';
    let descendantFileCount = 0;
    for (const [k, bucket] of map) {
      const isSelfOrDescendant = key === '' ? true : (k === key || k.startsWith(`${key}/`));
      if (isSelfOrDescendant) descendantFileCount += bucket.length;
    }
    return {
      key,
      depth,
      label,
      icon,
      files: (map.get(key) ?? []).sort((a, b) => modifiedAtMs(b) - modifiedAtMs(a)),
      descendantFileCount,
    };
  });
}

// Every folder the reader can collapse: any non-root group holding files in its
// subtree. An empty placeholder (Pictures with nothing in it) renders but has no
// chevron, because there is nothing behind it to hide.
export function allCollapsibleKeys<T extends WorkspaceFileLike>(groups: readonly FolderGroup<T>[]): string[] {
  return groups.filter((g) => g.key !== '' && g.descendantFileCount > 0).map((g) => g.key);
}

// The most recently touched files across the whole workspace, so a document the
// coworker just wrote is visible immediately instead of buried in a collapsed
// folder. That gap is the one that reads as "I asked for a document, where is
// it?".
export function recentFiles<T extends WorkspaceFileLike>(files: readonly T[], limit = 6): T[] {
  return files
    .filter((f) => !isNoiseFile(f))
    .slice()
    .sort((a, b) => modifiedAtMs(b) - modifiedAtMs(a))
    .slice(0, Math.max(0, limit));
}

// The persisted set is the EXPANDED keys, the exceptions. Everything else is
// collapsed, so the tidy view renders synchronously and the few open folders pop
// afterwards, rather than the whole tree flashing open on first paint.
export const FILES_EXPANDED_FOLDERS_STORAGE_KEY = 'delegent.files.expandedFolders.v1';

export function serializeExpandedKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify(Array.from(keys));
}

export function parseExpandedKeys(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string' && k.length > 0));
  } catch {
    return new Set();
  }
}

export function collapsedKeysFromExpanded(collapsibleKeys: readonly string[], expanded: ReadonlySet<string>): Set<string> {
  return new Set(collapsibleKeys.filter((key) => !expanded.has(key)));
}

// A group is hidden when any strict ancestor is collapsed: closing `home` folds
// away `home/buku`, its descendants, and all of their file rows.
export function isHiddenByCollapsedAncestor(key: string, collapsed: ReadonlySet<string>): boolean {
  if (key === '') return false;
  const segs = key.split('/');
  let cursor = '';
  for (let i = 0; i < segs.length - 1; i++) {
    cursor = cursor ? `${cursor}/${segs[i]}` : segs[i]!;
    if (collapsed.has(cursor)) return true;
  }
  return false;
}
