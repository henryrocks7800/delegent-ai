import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/repo/..." and
// join() then produces "C:\C:\repo\...", which ENOENTs the whole file.
const root = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const appSource = readFileSync(join(root, 'apps/mobile/App.tsx'), 'utf8');
// Folder grouping/collapse logic was extracted out of App.tsx into a pure,
// unit-testable module (2026-06-06), then moved again into @sidekick/shared
// (2026-07-27) so the browser draws the same folders from the same code.
// src/files/folderGroups.ts is now the phone's narrowing adapter over it.
// Pure-logic selectors below assert against the shared module; render-side
// selectors stay against App.tsx.
const folderGroupsSource = readFileSync(join(root, 'packages/shared/src/files/folderGroups.ts'), 'utf8');
const folderGroupsAdapterSource = readFileSync(join(root, 'apps/mobile/src/files/folderGroups.ts'), 'utf8');

// v1.2.1 chat-first selectors. Telegram-connection selectors are gone
// because the messenger surface is retired from the active user
// journey; the runner-binding plumbing remains in the worker.
//
// This list is also documented in docs/mobile-lab/visual-review.md
// (Stable testID audit) and is what the Agentic Mobile Test Lab
// heuristic (scripts/mobile-lab/visual-review.mjs) relies on. Adding
// a new entry here is the way to make a new testID a hard requirement.
const requiredSelectors = [
  // Top bar (always visible in the authenticated shell)
  'main-menu-button',
  'header.profileButton',
  // Login (passwordless: Google SSO + email-OTP)
  'login.googleButton',
  'login.emailButton',
  'login.emailInput',
  'login.emailSubmit',
  // Onboarding
  'onboarding.agentNameInput',
  'onboarding.termsCheckbox',
  'onboarding.finishButton',
  'onboarding.signOutButton',
  // Plan picker + billing
  'setup.stepIndicator',
  'billing.checkoutButton',
  // Chat home composer. The live chat surface is the WebView
  // (WebViewChatScreen + chatWebViewHtml); only the container + the
  // webview itself are RN-addressable. The remaining home.chatPanel.*
  // literals are pinned in App.tsx's production-harness selector
  // comment block so Maestro flow ids can't silently drift.
  // (home.chatPanel.messageList / .thinkingDots were native-panel-only
  // testIDs and were retired with HomeChatPanel on 2026-06-10.)
  'home.chatPanel',
  'home.chatPanel.webview',
  'home.chatPanel.input',
  'home.chatPanel.attachButton',
  'home.chatPanel.sendButton',
  // (home.chatPanel.micButton retired 2026-07-08: the in-app voice recorder
  // was never wired to a rendered control — no Maestro flow references it.)
  // v1.2.7 D4 — single persistent chat header avatar
  'home.chatPanel.header',
  'home.chatPanel.header.name',
  // v1.2.7 D2 — OTP code entry on login screen
  'login.emailOtpInput',
  'login.emailOtpVerify',
  // 2026-05-17 — status text after email-submit, used by the
  // Maestro flow to detect success-or-explicit-failure without
  // matching the volatile literal copy.
  'login.emailStatus',
  // Bottom tab bar
  'tab.${tab}',
  // Files
  'files.refreshButton',
  'files.runnerFileList',
  // Profile
  'profile.signOutButton',
  'profile.managePlanButton',
  'profile.displayNameInput',
  'profile.agentNameInput',
  'profile.regionInput',
  'profile.saveButton',
  // Side menu
  'menu.homeRow',
  'menu.filesRow',
  'menu.setupGuideRow',
  // Shell loading marker
  'shell.productStateLoading',
];

test('critical mobile flows expose stable testIDs for rendered and Android tests', () => {
  // Live chat surface: WebViewChatScreen carries the RN-addressable
  // home.chatPanel / home.chatPanel.webview testIDs. (The legacy
  // native HomeChatPanel was deleted 2026-06-10.)
  const webViewChatSource = readFileSync(join(root, 'apps/mobile/src/chat/WebViewChatScreen.tsx'), 'utf8');
  for (const selector of requiredSelectors) {
    assert.match(appSource + webViewChatSource, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${selector} should be present`);
  }
});

test('stable selectors are attached to interactive controls or durable screen containers', () => {
  assert.match(appSource, /testID="login\.googleButton"[\s\S]*?accessibilityRole="button"/);
  assert.match(appSource, /testID="login\.emailInput"[\s\S]*?accessibilityLabel="Email address"/);
  assert.match(appSource, /testID="login\.emailSubmit"[\s\S]*?accessibilityRole="button"/);
  assert.match(appSource, /testID="onboarding\.termsCheckbox"[\s\S]*?accessibilityRole="checkbox"/);
  assert.match(appSource, /testID=\{`setup\.plan\.\$\{tier\.id\}`\}/);
  assert.match(appSource, /testID=\{`tab\.\$\{tab\}`\}/);
  assert.match(appSource, /testID="billing\.checkoutButton"[\s\S]*?variant="primary"/);
  // v1.2.8 — Files tab now groups files by their top-level Linux
  // directory via RunnerFilesByDirectory. The list still carries the
  // files.runnerFileList testID at the outer Stack.
  assert.match(appSource, /testID="files\.runnerFileList"/);
  assert.match(appSource, /RunnerFilesByDirectory/);
});

test('Files tab nests subfolders under their parent (Documents/2026/q1 produces three rows with progressive indent) via buildFolderGroups', () => {
  // Pure grouping logic lives in packages/shared/src/files/folderGroups.ts,
  // and the phone reaches it through its adapter rather than its own copy.
  assert.match(folderGroupsSource, /export function buildFolderGroups/);
  assert.match(folderGroupsSource, /interface FolderGroup<[^>]*>\s*\{[\s\S]*?depth: number;/);
  assert.match(folderGroupsAdapterSource, /from '@sidekick\/shared'/);
  assert.doesNotMatch(folderGroupsAdapterSource, /const DEFAULT_FOLDERS\b[^=]*=\s*\[/);
  // Ancestors are seeded so the hierarchy renders even when only the
  // leaf has a file. This is the test the user asked for: "create
  // folders and nest files within them and more nested files".
  assert.match(folderGroupsSource, /while \(cursor\.includes\('\/'\)\)\s*\{[\s\S]*?if \(!map\.has\(cursor\)\) map\.set\(cursor, \[\]\);/);
  // The render gate hides empty subfolder rows (avoids clutter)
  // while keeping default top-level placeholders.
  assert.match(appSource, /if \(!isTop && isEmpty\) return null;/);
  // Each row is indented by depth × 16 px.
  assert.match(appSource, /indentPaddingLeft\s*=\s*4 \+ group\.depth \* 16/);
});

test('Files tab always renders the user-friendly default folder set (Home, Documents, Pictures, Downloads, Notes) as placeholders, even before the workspace is online', () => {
  // The default folder list (pure logic, packages/shared/src/files/folderGroups.ts)
  // must include Pictures so the user sees a recognisable home-directory shape,
  // and must NOT include technical folders like "Code".
  assert.match(folderGroupsSource, /const DEFAULT_FOLDERS\b[^=]*=\s*\[/);
  assert.match(folderGroupsSource, /key:\s*'home'/);
  assert.match(folderGroupsSource, /key:\s*'documents'/);
  assert.match(folderGroupsSource, /key:\s*'pictures'/);
  assert.match(folderGroupsSource, /key:\s*'downloads'/);
  assert.match(folderGroupsSource, /key:\s*'notes'/);
  // The grouped list seeds every default folder so the placeholder rows
  // render even when files.length === 0.
  assert.match(folderGroupsSource, /for \(const folder of DEFAULT_FOLDERS\)\s*map\.set\(folder\.key,\s*\[\]\)/);
  // The empty-state "Your coworker's workspace is ready" hero card is
  // gone — placeholders + per-folder rows take its place. (Render: App.tsx.)
  assert.doesNotMatch(appSource, /Your coworker's workspace is ready/);
  // Empty folders surface "Empty" copy in the per-folder header so the
  // user sees there is nothing in them yet.
  assert.match(appSource, /isEmpty \? 'Empty' :/);
  // While the runner is provisioning we show a calm "Workspace coming
  // online" banner above the folder list — the placeholders stay
  // visible underneath.
  assert.match(appSource, /testID="files\.workspaceComingOnlineBanner"/);
  assert.match(appSource, /Workspace coming online/);
});
