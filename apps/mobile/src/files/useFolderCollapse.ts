import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FILES_EXPANDED_FOLDERS_STORAGE_KEY,
  parseExpandedKeys,
  serializeExpandedKeys,
} from './folderGroups';

// Files-tab folder collapse state, persisted across navigations.
//
// The Files tab (ArtifactsScreen) is UNMOUNTED whenever the user switches away
// from it, so a plain useState collapse set was wiped every time they left and
// came back. This hook lifts the state into AsyncStorage so the expand/collapse
// choices survive tab switches, app restarts and the periodic Files refresh.
//
// We store the set of EXPANDED folder keys (the exceptions). Folders default to
// COLLAPSED, so the tidy collapsed view renders immediately; any folder the user
// had expanded pops open once the async read resolves. Any folder key not in the
// set — including brand-new folders the coworker creates later — is collapsed.
export type FolderCollapseController = {
  expanded: Set<string>;
  hydrated: boolean;
  toggle: (key: string) => void;
  expandAll: (keys: readonly string[]) => void;
  collapseAll: () => void;
};

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export function useFolderCollapse(storage: AsyncStorageLike = AsyncStorage): FolderCollapseController {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const mountedRef = useRef(true);

  // Load persisted expansions once. Never throws to the UI: a read failure just
  // leaves every folder collapsed (the safe, tidy default).
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const raw = await storage.getItem(FILES_EXPANDED_FOLDERS_STORAGE_KEY);
        if (mountedRef.current && raw) setExpanded(parseExpandedKeys(raw));
      } catch {
        // best-effort — fall back to the all-collapsed default
      } finally {
        if (mountedRef.current) setHydrated(true);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [storage]);

  // Persist on every change AFTER hydration, so we never clobber the stored set
  // with the empty initial state before the load has resolved.
  useEffect(() => {
    if (!hydrated) return;
    void storage.setItem(FILES_EXPANDED_FOLDERS_STORAGE_KEY, serializeExpandedKeys(expanded)).catch(() => {});
  }, [expanded, hydrated, storage]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback((keys: readonly string[]) => {
    setExpanded(new Set(keys));
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  return { expanded, hydrated, toggle, expandAll, collapseAll };
}
