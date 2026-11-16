import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  FILES_EXPANDED_FOLDERS_STORAGE_KEY,
  PREVIEW_RETRY_LABEL,
  PROVISIONING_NOTICE_TITLE,
  allCollapsibleKeys,
  buildFolderGroups,
  collapsedKeysFromExpanded,
  deleteSelectionConfirmCopy,
  deleteSelectionOutcomeCopy,
  fileIdsInFolderTree,
  fullDirectoryPath,
  isHiddenByCollapsedAncestor,
  parseExpandedKeys,
  recentFiles,
  runSelectionDelete,
  serializeExpandedKeys,
  toggleFolderTree,
  toggleSelectedFile,
} from '@sidekick/shared';
import { Icon, type IconName } from '../../components/Icon';
import { ConfirmDialog, EmptyState, Notice, Screen, Spinner } from '../../components/ui';
import {
  PREVIEW_LINE_LIMIT,
  deleteRunnerFile,
  fetchFilePreview,
  fetchRunnerFiles,
  formatFileSize,
  renameRunnerFile,
  uploadRunnerFile,
  type FilesListing,
  type RunnerFile,
} from './filesApi';
import { displayName, withRenamedPath } from './folders';

/**
 * The workspace, drawn the way the phone draws it.
 *
 * Three things were different here and all three came from this screen owning
 * its own copy of the rules. Folders are grouped by @sidekick/shared now, so a
 * workspace looks the same whichever surface you opened it on; they collapse,
 * and the folders you left open are still open next visit; and a whole folder
 * can be selected at once.
 *
 * Renames and deletes are optimistic. The old screen awaited the round trip
 * with the dialog still up, which on a cold runner is several seconds of a
 * screen that looks stuck. The row changes now and the request runs behind it;
 * a refusal puts the row back exactly as it was and says why.
 */
export function FilesScreen() {
  const [listing, setListing] = useState<FilesListing | null>(null);
  // Held apart from `listing` because a rename or delete edits it before the
  // server has agreed, and a rollback has to be able to put a row back.
  const [files, setFiles] = useState<readonly RunnerFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<{ file: RunnerFile; value: string } | null>(null);
  // Kept apart from `error`. The rename dialog covers the page, so a failure
  // reported up there is a message the reader is looking straight past.
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<readonly RunnerFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async (options?: { signal?: AbortSignal; keepError?: boolean }) => {
    const result = await fetchRunnerFiles(options?.signal);
    if (options?.signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (!options?.keepError) setError(null);
    setListing(result.listing);
    setFiles(result.listing.files);
    // Drop selections for files that are no longer there, so a stale id can
    // never be part of a later delete.
    const ids = new Set(result.listing.files.map((file) => file.id));
    setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  // The set stored is the EXPANDED folders, the exceptions. Everything else is
  // collapsed, which is what stops a cloned repo rendering as one endless flat
  // scroll the first time it is opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    try {
      return parseExpandedKeys(window.localStorage.getItem(FILES_EXPANDED_FOLDERS_STORAGE_KEY));
    } catch {
      return new Set();
    }
  });
  const writeExpanded = useCallback((next: Set<string>) => {
    setExpanded(next);
    try {
      window.localStorage.setItem(FILES_EXPANDED_FOLDERS_STORAGE_KEY, serializeExpandedKeys(next));
    } catch {
      // Private browsing refuses the write. The folders still open, they just
      // do not survive the next visit, which is better than throwing here.
    }
  }, []);

  const groups = useMemo(() => buildFolderGroups(files), [files]);
  const collapsibleKeys = useMemo(() => allCollapsibleKeys(groups), [groups]);
  const collapsed = useMemo(
    () => collapsedKeysFromExpanded(collapsibleKeys, expanded),
    [collapsibleKeys, expanded],
  );
  const anyExpanded = useMemo(
    () => collapsibleKeys.some((key) => expanded.has(key)),
    [collapsibleKeys, expanded],
  );
  const recent = useMemo(() => recentFiles(files, 6), [files]);
  const selectedFiles = useMemo(() => files.filter((file) => selected.has(file.id)), [files, selected]);

  // Chat sends the reader here with the file it was talking about. Landing on
  // the whole list and having to find it again is the same as not being sent.
  const [params, setParams] = useSearchParams();
  const focusPath = params.get('focus');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusTarget = useMemo(() => {
    if (!focusPath) return null;
    const wanted = focusPath.replace(/^\.?\//, '');
    return (
      files.find((file) => (file.relativeName ?? file.name) === wanted) ??
      files.find((file) => (file.relativeName ?? file.name).endsWith(`/${wanted}`)) ??
      files.find((file) => file.name === wanted) ??
      null
    );
  }, [focusPath, files]);

  useEffect(() => {
    if (!focusTarget) return;
    setFocusedId(focusTarget.id);
    // Folders start collapsed, so the file chat pointed at is usually inside a
    // folded folder. Open its ancestors or the reader is sent to a row that is
    // not on the page.
    const dir = fullDirectoryPath(focusTarget);
    if (dir) {
      const next = new Set(expanded);
      const segments = dir.split('/');
      let cursor = '';
      for (const segment of segments) {
        cursor = cursor ? `${cursor}/${segment}` : segment;
        next.add(cursor);
      }
      writeExpanded(next);
    }
    // Wait for the folder to open before scrolling; the row does not exist in
    // the document until the expand has rendered.
    const timer = window.setTimeout(() => {
      document.getElementById(`file-${focusTarget.id}`)?.scrollIntoView({ block: 'center' });
    }, 0);
    // Spend the parameter once. Otherwise a reload, or the back button, drags
    // the reader to a file they have long since moved on from.
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('focus');
        return next;
      },
      { replace: true },
    );
    return () => window.clearTimeout(timer);
    // `expanded` is read to extend it, not to react to it; listing it here
    // would re-run the focus every time a folder is opened by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget, setParams, writeExpanded]);

  async function onPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    const result = await uploadRunnerFile(file);
    setUploading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await load();
  }

  // The rows go now and the deletes run behind them. A refusal restores exactly
  // the subset that failed, and nothing else, so a partly successful batch does
  // not resurrect the files that really did go.
  async function runDelete(targets: readonly RunnerFile[]) {
    const ids = targets.map((file) => file.id);
    const removing = new Set(ids);
    setConfirmDelete(null);
    setSelected((current) => new Set([...current].filter((id) => !removing.has(id))));
    setFiles((current) => current.filter((file) => !removing.has(file.id)));
    setError(null);

    const { failedIds } = await runSelectionDelete(ids, (fileId) => deleteRunnerFile(fileId));
    const failed = new Set(failedIds);
    if (failed.size > 0) {
      setFiles((current) => [...current, ...targets.filter((file) => failed.has(file.id))]);
      setSelected(new Set(failedIds));
    }
    const outcome = deleteSelectionOutcomeCopy(ids.length - failedIds.length, ids.length);
    await load({ keepError: outcome !== null });
    if (outcome) setError(`${outcome.title}. ${outcome.message}`);
  }

  function submitRename() {
    if (!renaming) return;
    const target = renaming.file;
    const wasCalled = displayName(target);
    const nextName = renaming.value.trim();
    if (!nextName || nextName === wasCalled) {
      setRenaming(null);
      return;
    }
    // Caught here so the dialog can explain it straight away, rather than
    // optimistically showing a name the runner is certain to refuse.
    if (/[\\/]/.test(nextName)) {
      setRenameError("That name isn't allowed. Use a plain file name, no slashes.");
      return;
    }
    setRenaming(null);
    setRenameError(null);
    setError(null);
    setFiles((current) => current.map((file) => (file.id === target.id ? withRenamedPath(file, nextName) : file)));

    void renameRunnerFile(target.id, nextName).then(async (result) => {
      if (result.ok) {
        // The id changes on rename, so a refresh swaps in the fresh id and
        // download link. It is silent: nothing on screen should flicker.
        await load();
        return;
      }
      setFiles((current) => current.map((file) => (file.id === target.id ? target : file)));
      if (result.error === 'not_found') await load({ keepError: true });
      setError(
        result.error === 'file_exists'
          ? `A file called "${nextName}" already exists there, so "${wasCalled}" kept its name.`
          : result.error === 'invalid_file_name'
            ? `That name isn't allowed, so "${wasCalled}" kept its name. Use a plain file name, no slashes.`
            : result.error === 'not_found'
              ? 'That file was moved or removed, so the list has been refreshed.'
              : `Couldn't rename "${wasCalled}" just now, so it kept its name. Try again in a moment.`,
      );
    });
  }

  // Uploading into a workspace that has not finished provisioning can only fail,
  // so the control waits with the user rather than handing them an error.
  const canUpload = !loading && listing?.storageStatus !== 'not_ready';

  // The coworker writes files into this workspace while the screen is open, and
  // until now the only way to see one was to reload the page. The empty states
  // each carried their own way back, so the one arrangement with nothing to
  // press was the ordinary one: a list that had loaded and then gone stale. The
  // phone has always kept a Refresh in this header.
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const action = (
    <div className="flex gap-2">
      <button
        className="btn-secondary"
        type="button"
        onClick={() => void refresh()}
        disabled={refreshing || loading}
        data-testid="files.refresh"
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      {canUpload ? (
        <button className="btn-secondary" type="button" onClick={() => picker.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      ) : null}
    </div>
  );

  const confirmCopy = confirmDelete ? deleteSelectionConfirmCopy(confirmDelete.length) : null;

  return (
    <Screen title="Files" subtitle="Everything your coworker has made or you have shared." action={action}>
      {/* Kept outside the header action: the empty state has its own upload
          button, and it needs this input to exist even when the header one
          is not shown. */}
      <input ref={picker} type="file" className="hidden" onChange={onPicked} />

      {/* Suppressed when the failed-read card below says the same thing; an
          upload, rename or delete failure still gets its notice. */}
      {error && listing ? <Notice tone="danger">{error}</Notice> : null}

      {loading ? (
        <Spinner label="Loading your files…" />
      ) : listing?.storageStatus === 'not_ready' ? (
        <EmptyState
          // The same sentence the banner above uses, rather than a second
          // opinion: this screen used to promise "a minute or two" while the
          // shell said up to ten, on the same page, about the same wait.
          title={PROVISIONING_NOTICE_TITLE}
          body={listing.publicMessage ?? 'Your files will appear here once it is ready. This usually takes a few minutes.'}
          action={
            <button className="btn-secondary" type="button" onClick={() => void load()}>
              Check again
            </button>
          }
        />
      ) : error && !listing ? (
        // Never claim the folder is empty on the strength of a read that failed.
        // The notice above says what happened; this offers the way back.
        <EmptyState
          title="We could not load your files"
          body="They are still there. This is a problem reaching your workspace, not a problem with your files."
          action={
            <button className="btn-secondary" type="button" onClick={() => void load()}>
              Try again
            </button>
          }
        />
      ) : files.length === 0 ? (
        <EmptyState
          title="No files yet"
          body="Anything your coworker writes, and anything you upload, lands here."
          action={
            <button className="btn-primary" type="button" onClick={() => picker.current?.click()}>
              Upload a file
            </button>
          }
        />
      ) : (
        <>
          {listing?.truncated ? (
            <Notice tone="info">Showing the most recent files. Ask your coworker if you need something older.</Notice>
          ) : null}

          {recent.length > 0 ? (
            <section className="card mb-3 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3">
                <Icon name="clock" size={14} className="shrink-0 text-accent" />
                <span className="text-caption font-medium uppercase tracking-wide text-textSecondary">Recent</span>
                <span className="truncate text-caption text-textSecondary">Latest saved by your coworker</span>
              </div>
              <ul className="border-t border-border">
                {recent.map((file) => (
                  <FileRow
                    key={`recent-${file.id}`}
                    file={file}
                    idPrefix="recent"
                    focused={false}
                    selected={selected.has(file.id)}
                    onToggleSelect={() => setSelected((current) => toggleSelectedFile(current, file.id))}
                    onRename={() => {
                      setRenameError(null);
                      setRenaming({ file, value: displayName(file) });
                    }}
                    onDelete={() => setConfirmDelete([file])}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {collapsibleKeys.length > 0 ? (
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                className="flex min-h-11 items-center gap-1.5 rounded-md px-3 text-body-sm text-textSecondary hover:bg-surfaceHigh"
                onClick={() => writeExpanded(anyExpanded ? new Set() : new Set(collapsibleKeys))}
              >
                <Icon name={anyExpanded ? 'chevrons-up' : 'chevrons-down'} size={14} />
                {anyExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          ) : null}

          {groups.map((group) => {
            const isRoot = group.key === '';
            // Root counts only its own loose files; every other folder counts
            // its whole subtree, so `home` reads "247 files" even when they all
            // live in home/buku. Counting direct files only is what made the
            // old view read as a flat list of nothing in particular.
            const total = isRoot ? group.files.length : group.descendantFileCount;
            if (total === 0) return null;
            if (isHiddenByCollapsedAncestor(group.key, collapsed)) return null;

            const isCollapsed = collapsed.has(group.key);
            const treeIds = isRoot ? [] : fileIdsInFolderTree(files, group.key);
            const treeSelected = treeIds.filter((id) => selected.has(id)).length;

            return (
              <section
                key={group.key || 'root'}
                className="card mb-3 overflow-hidden"
                style={{ marginLeft: group.depth * 16 }}
              >
                <div className="flex items-center gap-1 px-2 py-1">
                  {treeIds.length > 0 ? (
                    <FolderCheckbox
                      label={group.label}
                      checked={treeSelected === treeIds.length}
                      partial={treeSelected > 0 && treeSelected < treeIds.length}
                      onChange={() => setSelected((current) => toggleFolderTree(files, group.key, current))}
                    />
                  ) : (
                    <span className="w-11" />
                  )}
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surfaceHigh"
                    onClick={() => {
                      const next = new Set(expanded);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      writeExpanded(next);
                    }}
                    aria-expanded={!isCollapsed}
                  >
                    <Icon
                      name={isCollapsed ? 'chevron-right' : 'chevron-down'}
                      size={14}
                      className="shrink-0 text-textSecondary"
                    />
                    <Icon
                      name={folderIcon(group.icon)}
                      size={group.depth === 0 ? 14 : 12}
                      className={`shrink-0 ${group.depth === 0 ? 'text-accent' : 'text-textSecondary'}`}
                    />
                    <span
                      className={`min-w-0 truncate text-body font-medium text-textPrimary ${
                        group.depth === 0 ? 'uppercase tracking-wide text-body-sm' : ''
                      }`}
                    >
                      {group.label}
                    </span>
                    {/* textSecondary, not textTertiary: the lighter token
                        measures 2.43:1 on this card and the count is
                        information, not decoration. */}
                    <span className="shrink-0 text-body-sm text-textSecondary">
                      {total} {total === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                </div>

                {isCollapsed || group.files.length === 0 ? null : (
                  <ul className="border-t border-border">
                    {group.files.map((file) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        focused={focusedId === file.id}
                        selected={selected.has(file.id)}
                        onToggleSelect={() => setSelected((current) => toggleSelectedFile(current, file.id))}
                        onRename={() => {
                          setRenameError(null);
                          setRenaming({ file, value: displayName(file) });
                        }}
                        onDelete={() => setConfirmDelete([file])}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}

      {selectedFiles.length > 0 ? (
        <div
          className="sticky bottom-0 -mx-4 mt-3 flex items-center justify-between gap-3 border-t border-border bg-surfaceHigh px-4 py-3"
          style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.75rem)' }}
        >
          <span className="text-body-sm text-textSecondary">{selectedFiles.length} selected</span>
          <div className="flex gap-2">
            <button className="btn-secondary" type="button" onClick={() => setSelected(new Set())}>
              Clear
            </button>
            <button className="btn-danger" type="button" onClick={() => setConfirmDelete(selectedFiles)}>
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {confirmDelete && confirmCopy ? (
        <ConfirmDialog
          title={confirmCopy.title}
          message={`${confirmCopy.message} Your coworker will no longer be able to read ${confirmDelete.length === 1 ? 'it' : 'them'}.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => void runDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}

      {renaming ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center">
          <div className="card w-full max-w-sm p-5" role="dialog" aria-modal="true" aria-label="Rename file">
            <label className="label" htmlFor="rename-input">
              New name
            </label>
            <input
              id="rename-input"
              className="field"
              value={renaming.value}
              onChange={(event) => setRenaming({ file: renaming.file, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitRename();
              }}
              autoFocus
            />
            {/* Inside the dialog, not above the page. A failure reported behind
                this scrim leaves the reader with a live Save button and no sign
                the last press did anything, so they press it again. */}
            {renameError ? (
              <p className="mt-3 text-body-sm text-danger" role="alert">
                {renameError}
              </p>
            ) : null}
            <div className="mt-5 flex gap-2">
              <button
                className="btn-secondary flex-1"
                type="button"
                onClick={() => {
                  setRenaming(null);
                  setRenameError(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary flex-1"
                type="button"
                onClick={submitRename}
                disabled={!renaming.value.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}

// Feather names come out of @sidekick/shared as plain strings, because the phone
// and the browser draw them with different components. Anything unrecognised
// falls back to a plain folder rather than rendering nothing.
const FOLDER_ICONS: readonly IconName[] = ['home', 'file-text', 'image', 'download', 'edit-3', 'folder', 'hard-drive'];
function folderIcon(name: string): IconName {
  return (FOLDER_ICONS as readonly string[]).includes(name) ? (name as IconName) : 'folder';
}

/**
 * The three-state tick a file manager puts next to a folder: on when the whole
 * folder is selected, half when part of it is, off when none of it is. Half is
 * not an HTML attribute, so it has to be set on the node.
 */
function FolderCheckbox({
  label,
  checked,
  partial,
  onChange,
}: {
  label: string;
  checked: boolean;
  partial: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        className="h-5 w-5 accent-accent"
        checked={checked}
        ref={(node) => {
          if (node) node.indeterminate = partial;
        }}
        onChange={onChange}
        aria-label={checked ? `Deselect everything in ${label}` : `Select everything in ${label}`}
      />
    </label>
  );
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; body: string; truncated: boolean }
  | { status: 'unsupported' }
  | { status: 'unavailable' };

/**
 * One file, with the first forty lines of it a click away.
 *
 * Before this, the only way to see what was inside a file in a browser was to
 * download it and open it in something else, which is a poor way to check
 * whether the thing your coworker just wrote is the thing you asked for. The
 * phone has always shown it inline. The preview state lives here rather than on
 * the screen so opening one file does not close another, and so a list of
 * several hundred files is not re-rendered every time one of them is expanded.
 */
function FileRow({
  file,
  focused,
  selected,
  idPrefix,
  onToggleSelect,
  onRename,
  onDelete,
}: {
  file: RunnerFile;
  focused: boolean;
  selected: boolean;
  idPrefix?: string;
  onToggleSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const name = displayName(file);
  // The Recent strip draws the same file a second time, and two nodes with the
  // same id would send a focus jump to whichever the browser found first. Only
  // the duplicate is prefixed; the row in the tree keeps the id a link from
  // chat scrolls to and the preview panel the audit opens.
  const rowId = idPrefix ? `${idPrefix}-file-${file.id}` : `file-${file.id}`;
  const panelId = idPrefix ? `preview-${idPrefix}-${file.id}` : `preview-${file.id}`;

  const loadPreview = useCallback(async () => {
    setPreview({ status: 'loading' });
    const result = await fetchFilePreview(file);
    if (result.ok) setPreview({ status: 'ready', body: result.body, truncated: result.truncated });
    else setPreview({ status: result.reason });
  }, [file]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // Read again only when there is nothing to show. 'ready' is already here
    // and the file has not changed underneath us, and 'unsupported' is a fact
    // about the file type that asking a second time cannot change.
    //
    // 'unavailable' is the one that can change, and it used to be cached with
    // the rest: a preview that failed once stayed failed for the life of the
    // page, so closing the row and opening it again produced the identical
    // sentence and there was no other way to ask. The phone has always tried
    // again on the next open.
    if (preview.status !== 'idle' && preview.status !== 'unavailable') return;
    await loadPreview();
  }

  return (
    <li id={rowId} className={`border-b border-border last:border-b-0 ${focused ? 'bg-[#EEF2EC]' : ''}`}>
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* The tick stays 20px because a 44px checkbox looks broken; the label
            around it is what the thumb hits, and a click anywhere in it
            reaches the input. */}
        <label className="-my-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            className="h-5 w-5 accent-accent"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${name}`}
          />
        </label>
        <button
          type="button"
          className="-my-2 flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
          onClick={() => void toggle()}
          aria-expanded={open}
          aria-controls={panelId}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-textPrimary">{name}</span>
            <span className="block text-caption text-textSecondary">
              {[formatFileSize(file.sizeBytes), formatDate(file.modifiedAt)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="shrink-0 text-textSecondary" />
        </button>
      </div>

      <div id={panelId} hidden={!open} className="px-4 pb-3">
        {preview.status === 'loading' ? (
          <p className="text-body-sm text-textSecondary">Loading the first {PREVIEW_LINE_LIMIT} lines…</p>
        ) : preview.status === 'ready' ? (
          <>
            {/* Wrapped, not side-scrolling. The phone renders this as ordinary
                text, so a long log line folds there; a <pre> left to itself
                would put a second horizontal scrollbar inside the page and
                hide the end of every line on a 390px screen. */}
            <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surfaceHigh p-3 text-caption text-textPrimary">
              {preview.body || '(this file is empty)'}
            </pre>
            {preview.truncated ? (
              <p className="mt-2 text-caption text-textSecondary">
                Showing the first {PREVIEW_LINE_LIMIT} lines. Download the file to see the rest.
              </p>
            ) : null}
          </>
        ) : preview.status === 'unsupported' ? (
          <p className="text-body-sm text-textSecondary">
            {/* Naming the reason beats a blank panel: nothing is broken, this
                kind of file simply has nothing readable to show inline. */}
            There is no inline preview for this kind of file. Download it to open it in the right app.
          </p>
        ) : preview.status === 'unavailable' ? (
          <>
            <p className="text-body-sm text-textSecondary">
              We could not load a preview just now. The file is still safe in your workspace, and Download still works.
            </p>
            {/* The read can succeed on a second attempt, so there has to be a
                second attempt to make. Closing the row and opening it again
                also retries now, but that is not a thing anyone would guess. */}
            <button
              type="button"
              className="mt-2 flex min-h-11 items-center rounded-lg border border-border px-3 text-body-sm text-textPrimary hover:bg-surfaceHigh"
              onClick={() => void loadPreview()}
              data-testid="files.previewRetry"
            >
              {PREVIEW_RETRY_LABEL}
            </button>
          </>
        ) : null}

        {/* Actions live in the open panel, exactly where the phone puts them.
            Three text buttons per row is about 220px of fixed width, which on a
            320px screen leaves the file name nothing and squeezes the preview
            control down to nothing to tap. Opening a file is also when a reader
            decides to rename or bin it. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {file.downloadUrl ? (
            <a
              className="flex min-h-11 items-center rounded-lg bg-accent px-3 text-body-sm text-accentText"
              href={file.downloadUrl}
              download={name}
            >
              Download
            </a>
          ) : (
            <span className="flex min-h-11 items-center rounded-lg bg-surfaceHigh px-3 text-body-sm text-textSecondary">
              Saved to your cloud space
            </span>
          )}
          <button
            type="button"
            className="flex min-h-11 items-center rounded-lg border border-border px-3 text-body-sm text-textPrimary hover:bg-surfaceHigh"
            onClick={onRename}
          >
            Rename
          </button>
          <button
            type="button"
            className="flex min-h-11 items-center rounded-lg px-3 text-body-sm text-textSecondary hover:bg-surfaceHigh"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
