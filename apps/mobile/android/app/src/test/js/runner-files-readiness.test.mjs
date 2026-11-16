import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');
const runnerFilesUrl = new URL('../../../../../src/files/mobileRunnerFiles.ts', import.meta.url);
const runnerFilesSource = existsSync(runnerFilesUrl) ? readFileSync(runnerFilesUrl, 'utf8') : '';
const webRunnerFilesUrl = new URL('../../../../../../../apps/web/lib/server/runnerFilesFlow.ts', import.meta.url);
const webRunnerFilesSource = existsSync(webRunnerFilesUrl) ? readFileSync(webRunnerFilesUrl, 'utf8') : '';
const webRunnerFilesRouteUrl = new URL('../../../../../../../apps/web/app/api/files/runner/route.ts', import.meta.url);
const webRunnerFilesDownloadRouteUrl = new URL('../../../../../../../apps/web/app/api/files/runner/[fileId]/route.ts', import.meta.url);
const workerIndexUrl = new URL('../../../../../../../apps/worker/src/index.ts', import.meta.url);
const workerFilesUrl = new URL('../../../../../../../apps/worker/src/files.ts', import.meta.url);
const workerIndexSource = existsSync(workerIndexUrl) ? readFileSync(workerIndexUrl, 'utf8') : '';
const workerFilesSource = existsSync(workerFilesUrl) ? readFileSync(workerFilesUrl, 'utf8') : '';

function extractFunctionSource(source, name) {
  const plainStart = source.indexOf(`function ${name}(`);
  const exportStart = source.indexOf(`export function ${name}(`);
  const start = plainStart >= 0 ? plainStart : exportStart;
  assert.notEqual(start, -1, `${name} source should be present`);
  const openBrace = source.indexOf('{', start);
  assert.notEqual(openBrace, -1, `${name} body should be present`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).replace(/^export\s+/, '');
    }
  }
  assert.fail(`${name} body should close`);
}

function evaluateRunnerDownloadUrl(rawDownloadUrl, apiBaseUrl) {
  const snippet = `
    const RUNNER_FILES_PATH = '/api/files/runner';
    function normalizePublicApiBaseUrl(raw) {
      const parsed = new URL(raw);
      return parsed.origin;
    }
    ${extractFunctionSource(runnerFilesSource, 'safeRunnerFileDownloadUrl')}
    ${extractFunctionSource(runnerFilesSource, 'isLocalDevelopmentHost')}
    ${extractFunctionSource(runnerFilesSource, 'nonEmptyString')}
    globalThis.__result = safeRunnerFileDownloadUrl(${JSON.stringify(rawDownloadUrl)}, ${JSON.stringify(apiBaseUrl)});
  `;
  const js = ts.transpileModule(snippet, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const sandbox = { URL };
  vm.runInNewContext(js, sandbox);
  return sandbox.__result;
}

test('mobile runner file download guard accepts same-origin private LAN API links used by device builds', () => {
  const apiBaseUrl = 'http://192.168.1.42:3000';
  const downloadPath = '/api/files/runner/file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?token=v1.local-signed-token';

  assert.equal(
    evaluateRunnerDownloadUrl(downloadPath, apiBaseUrl),
    `${apiBaseUrl}${downloadPath}`,
    'a valid same-origin LAN runner file link must not be filtered out of the Files tab',
  );
});

test('mobile runner files client calls authenticated backend proxy and accepts only safe download URLs', () => {
  assert.ok(existsSync(runnerFilesUrl), 'src/files/mobileRunnerFiles.ts should exist');
  assert.match(runnerFilesSource, /EXPO_PUBLIC_SIDEKICK_API_BASE_URL/);
  assert.match(runnerFilesSource, /generatedExpoPublicEnv\.EXPO_PUBLIC_SIDEKICK_API_BASE_URL \|\|\s*process\.env\.EXPO_PUBLIC_SIDEKICK_API_BASE_URL/);
  assert.match(runnerFilesSource, /\/api\/files\/runner/);
  assert.match(runnerFilesSource, /getFreshMobileAccessToken\(mobileSupabase\)/);
  assert.match(runnerFilesSource, /getRememberedMobileAccessToken\(\)/);
  assert.match(runnerFilesSource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(runnerFilesSource, /safeRunnerFileDownloadUrl/);
  assert.match(runnerFilesSource, /downloadUrl/);
  assert.doesNotMatch(runnerFilesSource, /SERVICE_ROLE|RUNNER_SHARED_SECRET|STRIPE_SECRET|WEBHOOK_SECRET|OPENROUTER|RAILWAY|BOT_TOKEN/i);
});

test('mobile runner files client exposes an authenticated upload-to-coworker path', () => {
  // uploadRunnerFile is the public entry point (re-exported from
  // mobileRunnerFiles.ts) that App.tsx imports. The network/validation core
  // lives in the pure runnerFileUpload.ts sibling so it can be unit-tested
  // without the native Supabase import chain.
  assert.match(runnerFilesSource, /export\s+async\s+function\s+uploadRunnerFile\b/);
  assert.match(runnerFilesSource, /uploadRunnerFileCore/);
  const uploadCoreUrl = new URL('../../../../../src/files/runnerFileUpload.ts', import.meta.url);
  assert.ok(existsSync(uploadCoreUrl), 'src/files/runnerFileUpload.ts should exist');
  const uploadCoreSource = readFileSync(uploadCoreUrl, 'utf8');
  // Same wire contract as the listing proxy: POST the same path, bearer auth,
  // JSON body, with a 25 MB decoded-size ceiling enforced before sending.
  assert.match(uploadCoreSource, /\/api\/files\/runner/);
  assert.match(uploadCoreSource, /method:\s*'POST'/);
  assert.match(uploadCoreSource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(uploadCoreSource, /'content-type':\s*'application\/json'/);
  assert.match(uploadCoreSource, /MOBILE_RUNNER_UPLOAD_MAX_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/);
  assert.match(uploadCoreSource, /contentBase64/);
  // The upload core must not leak any server-only secret material either.
  assert.doesNotMatch(uploadCoreSource, /SERVICE_ROLE|RUNNER_SHARED_SECRET|STRIPE_SECRET|WEBHOOK_SECRET|OPENROUTER|RAILWAY|BOT_TOKEN/i);
});

test('Files screen exposes an Upload button that uploads through the runner files client', () => {
  assert.match(appSource, /testID="files\.uploadButton"/);
  assert.match(appSource, /uploadRunnerFile/);
  // The picker + base64 read + refresh-on-success flow must be wired up.
  assert.match(appSource, /pickChatAttachment\('any'\)/);
  assert.match(appSource, /readLocalFileAsBase64/);
});

test('Files screen wires through runner storage and opens safe downloads', () => {
  assert.match(appSource, /requestRunnerFiles/);
  assert.match(appSource, /RunnerFilesState/);
  assert.match(appSource, /refreshRunnerFiles/);
  assert.match(appSource, /runnerFilesState\.files/);
  assert.match(appSource, /openRunnerFile/);
  assert.match(appSource, /Linking\.openURL\(file\.downloadUrl\)/);
  // v1.2.2 Files redesign — header copy invites the user to ask their
  // coworker to save something, instead of the legacy "In your cloud
  // space" section header.
  assert.match(appSource, /Anything your coworker saves|No files yet/);
  assert.match(appSource, /onRunnerFilesRefresh/);
});

test('Files folders default to collapsed and persist expand/collapse across navigations', () => {
  const dirStart = appSource.indexOf('function RunnerFilesByDirectory(');
  const dirEnd = appSource.indexOf('\nfunction ProfileInfoRow', dirStart);
  assert.ok(dirStart >= 0 && dirEnd > dirStart, 'RunnerFilesByDirectory source should be present');
  const dirSource = appSource.slice(dirStart, dirEnd);
  // Collapse state comes from the persisted hook, not an in-component useState
  // that dies when the Files tab unmounts on a tab switch.
  assert.match(dirSource, /useFolderCollapse\(\)/);
  assert.match(dirSource, /collapsedKeysFromExpanded\(collapsibleKeys, expanded\)/, 'collapsed set derives from persisted expanded keys (default collapsed)');
  // A "Collapse all / Expand all" control must be present.
  assert.match(dirSource, /testID="files\.collapseToggle"/);
  assert.match(dirSource, /anyExpanded \? collapseAll\(\) : expandAll\(collapsibleKeys\)/);
  // The persistence hook writes the expanded-folder set to AsyncStorage.
  const hookUrl = new URL('../../../../../src/files/useFolderCollapse.ts', import.meta.url);
  assert.ok(existsSync(hookUrl), 'useFolderCollapse hook should exist');
  const hookSource = readFileSync(hookUrl, 'utf8');
  assert.match(hookSource, /@react-native-async-storage\/async-storage/);
  assert.match(hookSource, /FILES_EXPANDED_FOLDERS_STORAGE_KEY/);
});

test('Files tab surfaces the coworker\'s most recent files at the top so agent output is visible', () => {
  const dirStart = appSource.indexOf('function RunnerFilesByDirectory(');
  const dirEnd = appSource.indexOf('\nfunction ProfileInfoRow', dirStart);
  const dirSource = appSource.slice(dirStart, dirEnd);
  assert.match(dirSource, /recentFiles\(files, \d+\)/, 'a Recent group must be computed from the newest files');
  assert.match(dirSource, /testID="files\.recent"/);
  assert.match(dirSource, /keyPrefix="files\.recent\.card"/, 'recent cards use a distinct testID namespace to stay unique');
});

test('Files tab shows an inline recovery message when Android cannot open a runner file download', () => {
  const cardStart = appSource.indexOf('function RunnerFileCard(');
  const cardEnd = appSource.indexOf('\nfunction RunnerFilesStateCard', cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart, 'RunnerFileCard source should be present');
  const cardSource = appSource.slice(cardStart, cardEnd);
  assert.match(cardSource, /openErrorMessage/);
  assert.match(cardSource, /setOpenErrorMessage\(null\)/);
  assert.match(cardSource, /await onOpen\(file\)/);
  assert.match(cardSource, /Couldn.t open that file/);
  // The card's testID namespace is templated (keyPrefix) so the same file can
  // appear in both the "Recent" group and its folder with unique testIDs; the
  // default prefix keeps the folder cards on the historical `files.card.*` id.
  assert.match(cardSource, /keyPrefix = 'files\.card'/);
  assert.match(cardSource, /testID=\{`\$\{keyPrefix\}\.\$\{file\.id\}\.openError`\}/);

  const opener = appSource.match(/const openRunnerFile = useCallback\(async \(file: MobileRunnerFile\) => \{(?<body>[\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(opener, 'Shell openRunnerFile callback should be present');
  // 2026-08-13: the body moved into src/files/downloadRunnerFile.ts, because
  // the old one-liner handed the URL to the OS browser, which saves nothing on
  // iOS. The contract this test protects is unchanged: the callback still
  // answers a plain boolean, and a failed open still must not be reported as a
  // failure of the whole Files listing.
  assert.match(opener.groups.body, /downloadRunnerFileToPhone\(file\)/, 'the shell should delegate to the download helper');
  assert.match(opener.groups.body, /return result\.ok/, 'the callback must still answer a boolean the card can act on');
  assert.doesNotMatch(opener.groups.body, /setRunnerFilesState/, 'file-open failures should not masquerade as a global Files refresh failure');
});

test('non-downloadable workspace files stay visible without promising an unavailable phone download', () => {
  const cardStart = appSource.indexOf('function RunnerFileCard(');
  const cardEnd = appSource.indexOf('\nfunction RunnerFilesStateCard', cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart, 'RunnerFileCard source should be present');
  const cardSource = appSource.slice(cardStart, cardEnd);

  assert.match(cardSource, /file\.downloadable \? \(/, 'phone-download button must stay behind the downloadable flag');
  assert.match(cardSource, /Saved to cloud space/, 'non-downloadable files should remain visible as cloud-saved work');
  assert.match(cardSource, /phone download (?:isn.t|is not|isn’t) available/i, 'non-downloadable preview copy must explain why the phone download action is absent');
  assert.doesNotMatch(cardSource, /Download the file to see the rest\./, 'truncated previews must not always promise a download action');
  assert.doesNotMatch(cardSource, /Try downloading the file instead\./, 'preview failures must not always point users to a missing download action');
  assert.doesNotMatch(cardSource, /download it to open with the right app\./, 'non-previewable files must not always point users to a missing download action');

  // The downloadable guard moved with the body into the download helper on
  // 2026-08-13. Assert it where it now lives, so the protection is still
  // pinned rather than quietly dropped when the code moved.
  const downloadHelper = readFileSync(new URL('../../../../../src/files/downloadRunnerFile.ts', import.meta.url), 'utf8');
  assert.match(
    downloadHelper,
    /if \(file\.downloadable === false\) return \{ ok: false, reason: 'unsupported' \}/,
    'a non-downloadable cloud file must be refused before any download is attempted',
  );
});

test('opening the Files tab refreshes the runner listing so newly-created assistant files appear without a manual refresh', () => {
  const selector = appSource.match(/const selectShellTab = useCallback\(\(tab: Tab\) => \{(?<body>[\s\S]*?)\n  \}, \[refreshRunnerFiles\]\);/);
  assert.ok(selector, 'Shell should route every tab change through selectShellTab with refreshRunnerFiles in its dependency list');
  const body = selector.groups.body;
  assert.match(body, /setActiveTab\(tab\)/, 'tab selection should still update the active tab');
  assert.match(body, /if \(tab === 'artifacts'\) void refreshRunnerFiles\(\)/, 'opening Files must fetch the latest runner listing');
  assert.match(appSource, /<TabButton key=\{tab\} tab=\{tab\} activeTab=\{activeTab\} setActiveTab=\{selectShellTab\} \/>/, 'bottom Files tab must use the refreshing selector');
  assert.match(appSource, /onSelectTab=\{selectShellTab\}/, 'drawer Files route must use the refreshing selector too');
});

test('Files shell remains reachable for canceled users whose workspace files are retained', () => {
  assert.match(appSource, /if \(appOpenPaywallOpen && !productView\.hasActiveSubscription\)/, 'the app-open paywall must remain conditional');
  assert.match(
    appSource,
    /const closeSetup = \(\) => \{[\s\S]*?setPaywallDismissed\(true\);[\s\S]*?setAppOpenPaywallOpen\(false\);[\s\S]*?setSetupOpen\(false\);/,
    'Not now must make the shell and retained files reachable without paying or signing out',
  );
  assert.match(appSource, /testID="paywall.notNow"[\s\S]*?dismissPaywall\('not_now'\)/);
});

test('Files refresh errors keep the last visible runner files instead of making saved work look lost', () => {
  const refresh = appSource.match(/const refreshRunnerFiles = useCallback\(async \(options\?: \{ silent\?: boolean \}\) => \{(?<body>[\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(refresh, 'refreshRunnerFiles callback should be present (with the silent-resync option)');
  const body = refresh.groups.body;

  assert.match(body, /status:\s*'loading',\s*files:\s*current\.files/, 'loading refreshes should preserve the visible list');
  assert.match(body, /status:\s*'error',[\s\S]*files:\s*current\.files/, 'transient refresh errors should keep the last visible saved files');
  assert.match(body, /status:\s*'not_ready',[\s\S]*files:\s*current\.files/, 'a stale not-ready refresh should keep the last visible saved files');
  assert.doesNotMatch(body, /status:\s*'error',[\s\S]{0,120}files:\s*\[\]/, 'refresh errors must not clear saved files from the Files tab');
  assert.doesNotMatch(body, /status:\s*'not_ready',[\s\S]{0,120}files:\s*\[\]/, 'not-ready refreshes must not clear saved files from the Files tab');
  // Silent resyncs (after optimistic delete/rename) must not flash the loading
  // card, and a FAILED silent resync must not surface an error card the user
  // never asked for.
  assert.match(body, /if \(!options\?\.silent\) \{\s*setRunnerFilesState\(\(current\) => \(\{ status: 'loading'/, 'silent refreshes must skip the visible loading state');
  const errorBranch = body.match(/if \('error' in result\) \{(?<inner>[\s\S]*?)\n    \}/);
  assert.ok(errorBranch, 'refresh error branch should be present');
  assert.match(errorBranch.groups.inner, /if \(options\?\.silent\) return;/, 'a failed silent resync must keep the optimistic list instead of showing an error card');
});

test('Files delete + rename are optimistic: the list updates immediately and rolls back on failure', () => {
  const screenStart = appSource.indexOf('function ArtifactsScreen(');
  const screenEnd = appSource.indexOf('\nfunction RunnerFilesByDirectory', screenStart);
  assert.ok(screenStart >= 0 && screenEnd > screenStart, 'ArtifactsScreen source should be present');
  const screenSource = appSource.slice(screenStart, screenEnd);

  // Delete: fade + local removal happen BEFORE the network call resolves, and
  // the card is restored (with an apology) when the server refuses.
  const deleteHandler = screenSource.match(/const handleDeleteFile = useCallback\((?<body>[\s\S]*?)\n  \}, \[/);
  assert.ok(deleteHandler, 'handleDeleteFile should be present');
  const deleteBody = deleteHandler.groups.body;
  const removeIndex = deleteBody.indexOf('onRunnerFileRemovedLocally(file.id)');
  const requestIndex = deleteBody.indexOf('void deleteRunnerFile(file.id)');
  assert.ok(removeIndex >= 0, 'delete must remove the card locally');
  assert.ok(requestIndex >= 0, 'delete must still call the signed proxy');
  assert.ok(removeIndex < requestIndex, 'the local removal must come before the network call (optimistic)');
  assert.match(deleteBody, /animateNextFilesChange\(\)/, 'delete should animate the card away (fade)');
  assert.match(deleteBody, /onRunnerFileRestoredLocally\(file\)/, 'a failed delete must restore the card');
  assert.match(deleteBody, /onRunnerFilesRefresh\(\{ silent: true \}\)/, 'a successful delete resyncs silently');

  // Rename: the modal closes and the row renames immediately; failures roll
  // the name back and explain what happened.
  const renameHandler = screenSource.match(/const submitRename = useCallback\((?<body>[\s\S]*?)\n  \}, \[/);
  assert.ok(renameHandler, 'submitRename should be present');
  const renameBody = renameHandler.groups.body;
  const localRenameIndex = renameBody.indexOf('onRunnerFileRenamedLocally(target.id, nextName)');
  const renameRequestIndex = renameBody.indexOf('void renameRunnerFile(target.id, nextName)');
  assert.ok(localRenameIndex >= 0, 'rename must apply the new name locally');
  assert.ok(renameRequestIndex >= 0, 'rename must still call the signed proxy');
  assert.ok(localRenameIndex < renameRequestIndex, 'the local rename must come before the network call (optimistic)');
  assert.match(renameBody, /onRunnerFileRenamedLocally\(target\.id, target\.name\)/, 'a failed rename must roll the visible name back');
  assert.match(renameBody, /onRunnerFilesRefresh\(\{ silent: true \}\)/, 'a successful rename resyncs silently (the file id changes)');

  // The shell owns the optimistic mutations against runnerFilesState.
  assert.match(appSource, /const removeRunnerFileLocally = useCallback/, 'shell should own the local remove mutation');
  assert.match(appSource, /const restoreRunnerFileLocally = useCallback/, 'shell should own the local restore mutation');
  assert.match(appSource, /const renameRunnerFileLocally = useCallback/, 'shell should own the local rename mutation');
  assert.match(appSource, /function withRunnerFiles\(/, 'a status-preserving files updater should exist');
});

test('Files multi-select: long-press enters the mode, X and Android back exit it', () => {
  const screenStart = appSource.indexOf('function ArtifactsScreen(');
  const screenEnd = appSource.indexOf('\nfunction RunnerFilesByDirectory', screenStart);
  assert.ok(screenStart >= 0 && screenEnd > screenStart, 'ArtifactsScreen source should be present');
  const screenSource = appSource.slice(screenStart, screenEnd);

  // Entering: the mode is anchored to the long-pressed card's folder.
  assert.match(screenSource, /const enterSelectionMode = useCallback/, 'a selection-mode entry callback should exist');
  assert.match(screenSource, /fullDirectoryPath\(file\)/, 'selection mode must anchor to the long-pressed card\'s folder');
  // The card wires long-press to entry (and to toggle once the mode is on).
  const cardStart = appSource.indexOf('function RunnerFileCard(');
  const cardEnd = appSource.indexOf('\nfunction RunnerFilesStateCard', cardStart);
  const cardSource = appSource.slice(cardStart, cardEnd);
  assert.match(cardSource, /onLongPress=\{onEnterSelectionMode/, 'long-pressing a file card must enter selection mode');
  assert.match(cardSource, /selectionMode \? \(\) => onToggleSelect\?\.\(file\) : \(\) => void togglePreview\(\)/, 'while the mode is on, a tap toggles selection instead of opening the preview');
  assert.match(cardSource, /name=\{selected \? 'check-circle' : 'circle'\}/, 'each card shows a Feather tick circle on the left in selection mode');

  // Exiting: the X control and the Android hardware back both leave the mode.
  assert.match(screenSource, /testID="files\.selectionBar\.exit"/, 'the contextual bar must have an X to exit');
  const backEffect = screenSource.match(/if \(!selectionMode\) return;\s*const subscription = BackHandler\.addEventListener\('hardwareBackPress', \(\) => \{(?<body>[\s\S]*?)\}\);/);
  assert.ok(backEffect, 'a hardware-back listener must be registered only while selection mode is active');
  assert.match(backEffect.groups.body, /exitSelectionMode\(\)/, 'Android back must exit selection mode');
  assert.match(backEffect.groups.body, /return true/, 'the back press must be swallowed so tab navigation does not also run');

  // The contextual action bar replaces the Files header while the mode is on.
  assert.match(screenSource, /testID="files\.selectionBar"/);
  assert.match(screenSource, /testID="files\.selectionBar\.count"/);
  assert.match(screenSource, /\$\{selectedFiles\.length\} selected/, 'the bar shows the live selected count');
  assert.match(screenSource, /testID="files\.selectionBar\.selectAll"/);
  assert.match(screenSource, /testID="files\.selectionBar\.delete"/);
});

test('Files multi-select: select all covers the anchor folder in its entirety (folder + subfolders), never other folders', () => {
  const screenStart = appSource.indexOf('function ArtifactsScreen(');
  const screenEnd = appSource.indexOf('\nfunction RunnerFilesByDirectory', screenStart);
  const screenSource = appSource.slice(screenStart, screenEnd);
  // Select all now clears the anchor folder IN ITS ENTIRETY - the folder plus
  // its subfolders (2026-07-23) - but still never other top-level folders.
  assert.match(screenSource, /selectAllInFolderTree\(runnerFilesState\.files, current\.folderKey, current\.ids\)/, 'select all must cover the anchor folder subtree');
  // The rules moved into @sidekick/shared (2026-07-27) so the browser's Files
  // screen selects and deletes identically; the phone keeps a narrowing adapter.
  const adapterUrl = new URL('../../../../../src/files/multiSelect.ts', import.meta.url);
  assert.ok(existsSync(adapterUrl), 'src/files/multiSelect.ts should exist');
  const adapterSource = readFileSync(adapterUrl, 'utf8');
  assert.match(adapterSource, /from '@sidekick\/shared'/, 'the phone must reach the shared rules, not keep its own copy');
  const multiSelectUrl = new URL('../../../../../../../packages/shared/src/files/multiSelect.ts', import.meta.url);
  assert.ok(existsSync(multiSelectUrl), 'packages/shared/src/files/multiSelect.ts should exist');
  const multiSelectSource = readFileSync(multiSelectUrl, 'utf8');
  assert.match(multiSelectSource, /dir === folderKey \|\| dir\.startsWith\(`\$\{folderKey\}\/`\)/, 'the subtree helper matches the folder AND its subfolders');
  assert.match(multiSelectSource, /if \(folderKey === ''\) return dir === '';/, "root ('') is only its own loose files, never the whole workspace");
  // test:ts discovers every .test.ts/.test.tsx under src, including multiSelect.
  // Its executed behavior tests belong to that run, not a source-list assertion.
});

test('Files multi-select: long-pressing a FOLDER header selects the whole folder', () => {
  const screenStart = appSource.indexOf('function ArtifactsScreen(');
  const screenEnd = appSource.indexOf('\nfunction RunnerFilesByDirectory', screenStart);
  const screenSource = appSource.slice(screenStart, screenEnd);
  // Shell owns folder-level entry + toggle, driven by the subtree helpers.
  assert.match(screenSource, /const enterFolderSelectionMode = useCallback/, 'a folder-level selection entry callback must exist');
  assert.match(screenSource, /fileIdsInFolderTree\(runnerFilesState\.files, folderKey\)/, 'entering a folder selection selects its whole subtree');
  assert.match(screenSource, /const toggleFolderSelection = useCallback/, 'tapping a folder header in selection mode toggles its subtree');
  assert.match(screenSource, /toggleFolderTree\(runnerFilesState\.files, folderKey, current\.ids\)/, 'the folder toggle must route through the subtree helper');

  // The folder header wires long-press to folder-selection and shows a tick.
  const dirStart = appSource.indexOf('function RunnerFilesByDirectory(');
  const dirEnd = appSource.indexOf('\nfunction ProfileInfoRow', dirStart);
  const dirSource = appSource.slice(dirStart, dirEnd);
  assert.match(dirSource, /onEnterFolderSelectionMode\(group\.key\)/, 'long-pressing a folder header enters folder selection');
  assert.match(dirSource, /onToggleFolderSelection\?\.\(group\.key\)/, 'tapping a folder header in selection mode toggles the folder');
  assert.match(dirSource, /name=\{folderAllSelected \? 'check-circle' : 'circle'\}/, 'a selected folder header shows a tick');
});

test('Files multi-select delete: count-confirm, group fade, failed-subset rollback, no duplicate cards on resync', () => {
  const screenStart = appSource.indexOf('function ArtifactsScreen(');
  const screenEnd = appSource.indexOf('\nfunction RunnerFilesByDirectory', screenStart);
  const screenSource = appSource.slice(screenStart, screenEnd);
  const handler = screenSource.match(/const handleDeleteSelected = useCallback\((?<body>[\s\S]*?)\n  \}, \[/);
  assert.ok(handler, 'handleDeleteSelected should be present');
  const body = handler.groups.body;

  // One confirm, with the exact count of files about to be deleted.
  assert.match(body, /deleteSelectionConfirmCopy\(targets\.length\)/, 'the confirm dialog must carry the selected count');
  // Optimistic: the whole selected group fades out (one layout pass) BEFORE
  // the network calls, which run through the existing single-file endpoint.
  const removeIndex = body.indexOf('onRunnerFilesRemovedLocally(targets.map((f) => f.id))');
  const requestIndex = body.indexOf('void runSelectionDelete(');
  assert.ok(removeIndex >= 0, 'all selected cards must be removed locally in one pass');
  assert.ok(requestIndex >= 0, 'the batch must run through runSelectionDelete');
  assert.ok(removeIndex < requestIndex, 'the local removal must come before the network batch (optimistic)');
  assert.match(body, /animateNextFilesChange\(\)/, 'the group removal must reuse the optimistic fade');
  assert.match(body, /\(fileId\) => deleteRunnerFile\(fileId\)/, 'each delete must go through the existing single-file client call');

  // Partial failure: ONLY the failed subset returns, with the honest count.
  assert.match(body, /targets\.filter\(\(f\) => failedIdSet\.has\(f\.id\)\)/, 'rollback must restore only the failed files');
  assert.match(body, /onRunnerFilesRestoredLocally\(failedFiles\)/, 'the failed subset is what comes back');
  assert.match(body, /deleteSelectionOutcomeCopy\(targets\.length - failedFiles\.length, targets\.length\)/, 'the alert must report deleted-of-total');
  assert.match(body, /if \(failedIds\.length === 0\) \{\s*onRunnerFilesRefresh\(\{ silent: true \}\);/, 'a clean sweep resyncs silently');

  // Resync can never duplicate cards: the shell's batch restore de-dupes
  // against the current list before appending.
  const restore = appSource.match(/const restoreRunnerFilesLocally = useCallback\(\(files: readonly MobileRunnerFile\[\]\) => \{(?<body>[\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(restore, 'shell should own the batch restore mutation');
  assert.match(restore.groups.body, /files\.filter\(\(f\) => !present\.has\(f\.id\)\)/, 'restore must skip files already back in the list (no duplicates)');
  assert.match(appSource, /const removeRunnerFilesLocally = useCallback/, 'shell should own the batch remove mutation');
});

test('Files screen shows both date and time for runner files so current-run evidence is comparable', () => {
  assert.match(appSource, /function formatFileUpdatedAt\(modifiedAt: number\): string/);
  assert.match(appSource, /toLocaleDateString\(\[\], \{ day: '2-digit', month: 'short' \}\)/);
  assert.match(appSource, /toLocaleTimeString\(\[\], \{ hour: '2-digit', minute: '2-digit'/);
  assert.match(appSource, /Updated \$\{formatFileUpdatedAt\(file\.modifiedAt\)\}/);
});

test('Files preview uses a bounded byte range all the way through the private file proxy', () => {
  assert.match(appSource, /headers:\s*\{ range: `bytes=0-\$\{PREVIEW_BYTE_LIMIT - 1\}` \}/);
  assert.match(webRunnerFilesSource, /safeRunnerFileRangeHeader/);
  assert.match(webRunnerFilesSource, /content-range/);
  assert.match(webRunnerFilesSource, /accept-ranges/);
  assert.match(workerFilesSource, /safeRunnerFileRangeHeader/);
  assert.match(workerFilesSource, /content-range/);
  assert.match(workerFilesSource, /accept-ranges/);
});

test('web runner files proxy signs runner requests and keeps secrets server-side', () => {
  assert.ok(existsSync(webRunnerFilesUrl), 'apps/web/lib/server/runnerFilesFlow.ts should exist');
  assert.ok(existsSync(webRunnerFilesRouteUrl), 'apps/web/app/api/files/runner/route.ts should exist');
  assert.ok(existsSync(webRunnerFilesDownloadRouteUrl), 'apps/web/app/api/files/runner/[fileId]/route.ts should exist');
  assert.match(webRunnerFilesSource, /createHmac\('sha256'/);
  assert.match(webRunnerFilesSource, /x-sidekick-runner-token/);
  assert.match(webRunnerFilesSource, /runner_shared_secret/);
  assert.match(webRunnerFilesSource, /downloadToken/);
  assert.match(webRunnerFilesSource, /cache-control': 'private, no-store'|"cache-control": "private, no-store"/);
});

test('Worker runner files proxy is available at the mobile API base', () => {
  assert.ok(existsSync(workerFilesUrl), 'apps/worker/src/files.ts should exist');
  assert.match(workerIndexSource, /\/api\/files\/runner/);
  assert.match(workerIndexSource, /handleRunnerFilesListFromWorker/);
  assert.match(workerIndexSource, /handleRunnerFileDownloadFromWorker/);
  assert.match(workerFilesSource, /runner_base_url,runner_shared_secret/);
  assert.match(workerFilesSource, /x-sidekick-runner-token/);
  assert.match(workerFilesSource, /downloadUrl/);
  assert.match(workerFilesSource, /cache-control': 'private, no-store'|"cache-control": "private, no-store"/);
  assert.doesNotMatch(workerFilesSource, /OPENROUTER_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|TELEGRAM_BOT_TOKEN/);
});

test('mobile test suite includes runner file regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /runner-files-readiness\.test\.mjs/);
});
