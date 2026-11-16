// Every feature the Android app has, and what the browser app does about it.
//
// This file exists because the browser app shipped without the voice orb and
// with half a help tray, and every test we had passed. Those tests asked "does
// this screen render, and are its failures visible", which is a different
// question from "does the browser have what the phone has". Nothing was
// checking the second question, so nothing caught it, and the person who found
// it was Alex.
//
// So this is the list, and parity.test.mjs holds it to account in both
// directions:
//
//   state: 'parity'  -> the proof MUST be found in the browser source.
//                       Delete the feature and the test goes red.
//   state: 'gap'     -> the proof must NOT be found. Build the feature and the
//                       test goes red too, telling you to move the entry up to
//                       'parity'. That is deliberate: a stale list is worse
//                       than no list, because it reads as reassurance.
//   state: 'web-only'-> exists here and not on the phone.
//   state: 'n-a'     -> cannot exist in a browser, with the reason written out.
//
// Adding a feature to the phone means adding a row here. There is no way to
// add one quietly.

export const AREAS = [
  'Sign in',
  'Shell',
  'Chat',
  'Files',
  'Plan',
  'Capacity',
  'Profile',
  'Routines',
  'Connections',
  'Skills',
  'Commands',
  'Help',
  'Onboarding',
  'Support',
];

/**
 * `proof.contains` entries are matched against the file's text. Prefer an
 * identifier that only exists because the feature is wired (an imported API
 * function, a handler name) over a piece of copy, which changes for reasons
 * that have nothing to do with whether the feature is there.
 */
export const FEATURES = [
  // ---------------------------------------------------------------- Sign in
  {
    id: 'auth.email-code',
    area: 'Sign in',
    what: 'Sign in with an eight-digit emailed code',
    mobile: 'apps/mobile/src/auth/emailOtp.ts',
    state: 'parity',
    proof: { file: 'src/features/auth/useAuth.ts', contains: ['signInWithOtp', 'verifyOtp', "normalizeOtpCode(rawCode, 8)"] },
  },
  {
    id: 'auth.google',
    area: 'Sign in',
    what: 'Continue with Google',
    mobile: 'apps/mobile/src/auth/googleSignIn.ts (native picker + signInWithIdToken)',
    state: 'parity',
    note: 'The browser uses the redirect flow rather than a native picker, but it lands on the same Supabase account, keyed on the email address.',
    proof: {
      file: 'src/features/auth/useAuth.ts',
      contains: ['signInWithOAuth', "provider: 'google'", 'exchangeCodeForSession'],
    },
  },
  {
    id: 'auth.google-button',
    area: 'Sign in',
    what: 'Google button on the sign-in screen',
    mobile: 'apps/mobile/App.tsx sign-in screen',
    state: 'parity',
    proof: { file: 'src/features/auth/SignIn.tsx', contains: ['Continue with Google', 'signInWithGoogle'] },
  },
  {
    id: 'auth.resend-throttle',
    area: 'Sign in',
    what: 'Resend is held for 30 seconds with a visible countdown',
    mobile: 'apps/mobile/App.tsx:143 resend cooldown',
    state: 'parity',
    proof: { file: 'src/features/auth/SignIn.tsx', contains: ['RESEND_COOLDOWN_SECONDS', 'Send a new code in'] },
  },
  {
    id: 'auth.spent-code-keeps-session',
    area: 'Sign in',
    what: 'A replayed sign-in return does not sign an existing session out',
    mobile: 'apps/mobile/src/auth/emailLinkFailure.ts (PR #264)',
    state: 'parity',
    proof: { file: 'src/features/auth/useAuth.ts', contains: ['data.session ? null : GOOGLE_RETURN_FAILED'] },
  },
  {
    id: 'auth.sign-out',
    area: 'Sign in',
    what: 'Sign out',
    mobile: 'apps/mobile/App.tsx menu drawer',
    state: 'parity',
    proof: { file: 'src/features/auth/useAuth.ts', contains: ['export async function signOut'] },
  },

  // ------------------------------------------------------------------ Shell
  {
    id: 'shell.primary-nav',
    area: 'Shell',
    what: 'Primary navigation to chat, files and profile',
    mobile: 'apps/mobile/App.tsx:2526 TabButton',
    state: 'parity',
    proof: { file: 'src/components/Shell.tsx', contains: ['PRIMARY_NAV'] },
  },
  {
    id: 'shell.menu',
    area: 'Shell',
    what: 'Slide-out menu of the secondary screens',
    mobile: 'apps/mobile/App.tsx:4086 MenuDrawer',
    state: 'parity',
    proof: { file: 'src/components/Shell.tsx', contains: ['SECONDARY_NAV'] },
  },
  {
    id: 'shell.gate-notice',
    area: 'Shell',
    what: 'Provisioning and subscription notices, from the shared gate',
    mobile: 'apps/mobile/App.tsx:4466 ProductStateNotice',
    state: 'parity',
    proof: { file: 'src/components/Shell.tsx', contains: ['gateNotice', 'GateNoticeBanner'] },
  },
  {
    id: 'shell.provisioning-stall',
    area: 'Shell',
    what: 'Setup that has sat past the stall timeout says so, on the notice rather than as an error',
    mobile: 'apps/mobile/App.tsx ProvisioningWaitNotice, stalled prop',
    state: 'parity',
    note: 'Both surfaces used to raise `status` to error for this. On the phone the shell suppresses that banner for anyone who has ever loaded live data, which is everyone this can fire for, so it reached nobody. In the browser it replaced the whole app with "Something went wrong" and switched off the poll that would have noticed the workspace arriving. Both now latch a flag the always-on notice reads.',
    proof: { file: 'src/components/Shell.tsx', contains: ['provisioningStalled', 'PROVISIONING_STALLED_MESSAGE'] },
  },
  {
    id: 'shell.transient-503-is-not-provisioning',
    area: 'Shell',
    what: 'A momentary 503 is reported as a retry, not as "your workspace is coming online"',
    mobile: 'apps/mobile/src/files/mobileRunnerFiles.ts:139 trusts an explicit field, not the status code',
    state: 'parity',
    note: 'This is the defect behind Alex reporting that his chat said "coming online" on a workspace that has existed for weeks.',
    proof: { file: 'src/lib/api.ts', contains: ['NOT_READY_CODES', 'runner_not_ready'] },
  },
  {
    id: 'shell.status-chip',
    area: 'Shell',
    what: 'Live status dot and label in the header',
    mobile: 'apps/mobile/App.tsx:1070',
    state: 'parity',
    note: 'The banner only appears when something is wrong, so on a good day the browser said nothing about the workspace at all. The chip is the quiet always-on half, using the phone\'s own label and dot-colour rules.',
    proof: { file: 'src/components/Shell.tsx', contains: ['StatusChip', 'statusDot', 'statusLabel'] },
  },
  {
    id: 'shell.manual-refresh',
    area: 'Shell',
    what: 'Refresh the workspace by hand',
    mobile: 'apps/mobile/App.tsx RefreshControl on every screen',
    state: 'gap',
    why: 'Pull-to-refresh has no browser equivalent, but the need behind it does: when something looks stale there is currently no way to ask for fresh data short of reloading the page.',
  },

  // ------------------------------------------------------------------- Chat
  {
    id: 'chat.same-document',
    area: 'Chat',
    what: 'The chat surface is the same document the phone runs',
    mobile: 'apps/mobile/assets/chat-webview/index.html',
    state: 'parity',
    note: 'Checked byte-for-byte by chat-webview-sync.test.mjs, so a chat fix lands on both surfaces from one edit.',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['/chat-frame/index.html'] },
  },
  {
    id: 'chat.send',
    area: 'Chat',
    what: 'Send a message and stream the reply',
    mobile: 'shared chat document',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ["type: 'init'", 'accessToken'] },
  },
  {
    id: 'chat.voice-mode',
    area: 'Chat',
    what: 'Live voice conversation (the orb)',
    mobile: 'chat document voiceModeBtn, gated on pilotFeatures.voiceMode',
    state: 'parity',
    note: 'The orb is WebRTC the browser runs itself. It was switched off here on the assumption it was native, which it never was.',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['voiceMode: true'] },
  },
  {
    id: 'chat.voice-dictation',
    area: 'Chat',
    what: 'Hold the mic to dictate a message',
    mobile: 'apps/mobile/src/chat/voiceRecorder.ts (expo-av) answering voice_start',
    state: 'parity',
    note: 'MediaRecorder here, expo-av on the phone, same upload to the same Worker route. Reported honestly: a browser that cannot record says so, and the mic button hides rather than hanging on "Listening…".',
    proof: {
      file: 'src/features/chat/ChatScreen.tsx',
      contains: ['voiceCapture: canRecord()', "type: 'voice_started'", "type: 'voice_transcript'", "type: 'voice_error'"],
    },
  },
  {
    id: 'chat.voice-mic-permission',
    area: 'Chat',
    what: 'The page is actually allowed to use the microphone',
    mobile: 'Android runtime permission',
    state: 'parity',
    note: 'Two separate gates, and the feature is dead if either is shut: the hosting header and the iframe attribute.',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['allow="microphone; clipboard-write"'] },
  },
  {
    id: 'chat.voice-timeout',
    area: 'Chat',
    what: 'A forgotten live microphone stops on its own',
    mobile: 'apps/mobile/src/chat/WebViewChatScreen.tsx:22 VOICE_MAX_RECORDING_MS',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['VOICE_MAX_RECORDING_MS = 120_000'] },
  },
  {
    id: 'chat.voice-release-on-leave',
    area: 'Chat',
    what: 'Leaving chat mid-recording releases the microphone',
    // Both surfaces hung this off unmount, and both keep the chat mounted behind
    // every other screen so a reply in flight survives leaving it, so on both
    // the release could never fire. The proof points at the route signal that
    // does run, and the phone at the tab signal.
    mobile: 'apps/mobile/src/chat/WebViewChatScreen.tsx releaseMicrophone + the active-tab effect',
    state: 'parity',
    proof: {
      file: 'src/features/chat/ChatScreen.tsx',
      contains: ['const releaseMicrophone = useCallback(', "if (location.pathname === '/chat') return;"],
    },
  },
  {
    id: 'chat.toolbar-guide',
    area: 'Chat',
    what: 'The toolbar guide describes all four controls',
    mobile: 'chat document #toolbarTour, rows filtered by applyTourVisibility()',
    state: 'parity',
    note: 'Not a separate feature: the guide reads the same two voice flags, which is why Alex counted two rows instead of four. Covered live by the browser pack.',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['voiceMode: true', 'canRecord()'] },
  },
  {
    id: 'chat.attach-file',
    area: 'Chat',
    what: 'Attach a file to a message',
    mobile: 'chat document pick_attachment, answered by native',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ["case 'pick_attachment'", 'uploadRunnerFile'] },
  },
  {
    id: 'chat.camera',
    area: 'Chat',
    what: 'Send a photo from the camera',
    mobile: 'chat document pick_camera',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ["case 'pick_camera'", 'capture="environment"'] },
  },
  {
    id: 'chat.token-refresh',
    area: 'Chat',
    what: 'The session is topped up mid-conversation so sending never silently fails',
    mobile: 'apps/mobile/src/chat/WebViewChatScreen.tsx token refresh',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['TOKEN_REFRESH_MS', "type: 'token_refresh'"] },
  },
  {
    id: 'chat.quota-banner',
    area: 'Chat',
    what: 'Plan and quota changes reach the composer',
    mobile: 'chat document quota_update',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ["type: 'quota_update'"] },
  },
  {
    id: 'chat.queued-command',
    area: 'Chat',
    what: 'A command picked on Skills or Commands runs when chat opens',
    mobile: 'apps/mobile/App.tsx menu command dispatch',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['takeChatCommand', "type: 'menu_command'"] },
  },
  {
    id: 'chat.open-billing',
    area: 'Chat',
    what: 'A quota message in chat can reach the plan screen',
    mobile: 'chat document open_billing, handled in App.tsx by opening the plan picker',
    state: 'parity',
    // This was certified as parity while the phone did something else: it fired
    // the Stripe portal straight from the chat tab. That portal is cancel-only
    // under our config, and the chat tab is the one surface that does not draw
    // billingPortalState, so a failed open changed nothing on screen at all.
    note: 'Both surfaces send the reader to the in-app plan picker rather than to Stripe.',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ["case 'open_billing'", "navigate('/plan')"] },
  },
  {
    id: 'chat.telegram-card',
    area: 'Chat',
    what: 'Telegram connect card',
    mobile: 'chat document, pilot allowlist only',
    state: 'n-a',
    why: 'Dark on the phone too, outside a pilot allowlist the browser has no way to compute. Turning it on here would show every reader a card the phone deliberately hides.',
  },
  {
    id: 'chat.open-file',
    area: 'Chat',
    what: 'Tapping a file in chat opens that file',
    mobile: 'apps/mobile/App.tsx files.focusedFromChat',
    state: 'parity',
    proof: { file: 'src/features/chat/ChatScreen.tsx', contains: ['/files?focus='] },
  },
  {
    id: 'chat.prewarm',
    area: 'Chat',
    what: 'The runner is woken early, so the first reply is not a cold start',
    mobile: 'apps/mobile/src/chat/WebViewChatScreen.tsx warms on mount and on AppState active',
    state: 'parity',
    // This used to claim a browser tab had no equivalent of the phone returning to
    // the foreground, which is wrong: visibilitychange is exactly that moment.
    note: 'Both surfaces warm once at the start and again whenever the reader comes back to the app.',
    proof: {
      file: 'src/features/chat/ChatScreen.tsx',
      contains: ['/api/chat/warm', "document.addEventListener('visibilitychange', onVisible)"],
    },
  },
  {
    id: 'chat.survives-navigation',
    area: 'Chat',
    what: 'Leaving chat and coming back keeps the draft, the scroll and a running reply',
    mobile: 'apps/mobile/App.tsx keeps the WebView mounted across tabs',
    state: 'parity',
    note: 'The frame is hoisted out of the router and hidden, rather than unmounted, so a visit to Files during a long answer does not lose it.',
    proof: { file: 'src/App.tsx', contains: ['ChatSurface', "location.pathname === '/chat'"] },
  },

  // ------------------------------------------------------------------ Files
  {
    id: 'files.list',
    area: 'Files',
    what: 'List the workspace files',
    mobile: 'apps/mobile/App.tsx:1591',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['buildFolderGroups'] },
  },
  {
    id: 'files.upload',
    area: 'Files',
    what: 'Upload a file',
    mobile: 'apps/mobile/App.tsx files upload',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['onPicked'] },
  },
  {
    id: 'files.download',
    area: 'Files',
    what: 'Download a file',
    mobile: 'apps/mobile/App.tsx:1400',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['download'] },
  },
  {
    id: 'files.rename',
    area: 'Files',
    what: 'Rename a file',
    mobile: 'apps/mobile/App.tsx:1440',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['submitRename'] },
  },
  {
    id: 'files.delete',
    area: 'Files',
    what: 'Delete a file, behind a confirmation',
    mobile: 'apps/mobile/App.tsx:1470 native Alert',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['runDelete', 'ConfirmDialog'] },
  },
  {
    id: 'files.provisioning-banner',
    area: 'Files',
    what: 'A workspace that is genuinely still being built says so',
    mobile: 'apps/mobile/App.tsx:1966',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['PROVISIONING_NOTICE_TITLE', "storageStatus === 'not_ready'"] },
  },
  {
    id: 'files.preview',
    area: 'Files',
    what: 'Preview a file without downloading it',
    mobile: 'apps/mobile/App.tsx:1296 RunnerFileCard',
    state: 'parity',
    note: 'Same 8 KB / 40 line ceiling as the phone, read with a Range request so a large file is not pulled down whole. Needs `range` in the Worker CORS allow-list, which is why files-preview.test.mjs pins that too.',
    proof: {
      file: 'src/features/files/FilesScreen.tsx',
      contains: ['fetchFilePreview', 'aria-expanded={open}'],
    },
  },
  {
    id: 'files.multi-select',
    area: 'Files',
    what: 'Select several files and delete them together',
    mobile: 'apps/mobile/App.tsx:1591',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['selectedFiles', 'selected.has(file.id)'] },
  },
  {
    id: 'files.focused-from-chat',
    area: 'Files',
    what: 'A file opened from chat is the one you land on',
    mobile: 'apps/mobile/App.tsx files.focusedFromChat',
    state: 'parity',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['focusTarget', 'scrollIntoView'] },
  },
  {
    id: 'files.recent-strip',
    area: 'Files',
    what: 'A recent-files strip above the folders',
    mobile: 'apps/mobile/App.tsx:2057',
    state: 'parity',
    note: 'Folders start collapsed, so without this a document the coworker just wrote is behind a fold the moment it is saved.',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['recentFiles(files, 6)', 'Latest saved by your coworker'] },
  },
  {
    id: 'files.shared-grouping',
    area: 'Files',
    what: 'Folders are grouped the same way on both surfaces',
    mobile: '@mobile-logic folderGroups.ts',
    state: 'parity',
    note: 'Both surfaces now call buildFolderGroups from @sidekick/shared, so the noise list, the placeholder folders and the subtree counts are one implementation.',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['buildFolderGroups', "from '@sidekick/shared'"] },
  },
  {
    id: 'files.folder-collapse',
    area: 'Files',
    what: 'Folders collapse, and the ones you left open stay open',
    mobile: 'apps/mobile/App.tsx:2091 useFolderCollapse',
    state: 'parity',
    note: 'Collapsed is the default on both surfaces. The persisted set is the EXPANDED folders, so a folder the coworker creates later arrives folded rather than dumping its contents into the list.',
    proof: {
      file: 'src/features/files/FilesScreen.tsx',
      contains: ['FILES_EXPANDED_FOLDERS_STORAGE_KEY', 'collapsedKeysFromExpanded', 'Collapse all'],
    },
  },
  {
    id: 'files.folder-select',
    area: 'Files',
    what: 'Select a whole folder, subfolders included, and delete it in one go',
    mobile: 'apps/mobile/App.tsx:2167 long-press a folder header',
    state: 'parity',
    note: 'The phone long-presses the header; a browser cannot, so the header carries the three-state tick a file manager uses. Same selection logic underneath.',
    proof: { file: 'src/features/files/FilesScreen.tsx', contains: ['toggleFolderTree', 'fileIdsInFolderTree', 'indeterminate'] },
  },
  {
    id: 'files.optimistic-mutations',
    area: 'Files',
    what: 'A rename or delete happens on screen at once, and rolls back if it is refused',
    mobile: 'apps/mobile/App.tsx:1698 handleDeleteFile, :1733 submitRename',
    state: 'parity',
    note: 'Awaiting the round trip meant several seconds of a screen that looked stuck on a cold runner. The row changes now; a refusal restores exactly the rows that failed and says why.',
    proof: {
      file: 'src/features/files/FilesScreen.tsx',
      contains: ['runSelectionDelete', 'withRenamedPath', 'deleteSelectionOutcomeCopy'],
    },
  },

  // ------------------------------------------------------------------- Plan
  {
    id: 'plan.tiers',
    area: 'Plan',
    what: 'See the plans and what each includes',
    mobile: 'apps/mobile/App.tsx:1140 PlanCard',
    state: 'parity',
    proof: { file: 'src/features/billing/PlanScreen.tsx', contains: ['PlanCard'] },
  },
  {
    id: 'plan.checkout',
    area: 'Plan',
    what: 'Subscribe through Stripe Checkout',
    mobile: 'apps/mobile/App.tsx:4028',
    state: 'parity',
    proof: { file: 'src/features/billing/PlanScreen.tsx', contains: ['startCheckout'] },
  },
  {
    id: 'plan.manage',
    area: 'Plan',
    what: 'Open the Stripe billing portal',
    mobile: 'apps/mobile/App.tsx manage plan',
    state: 'parity',
    proof: { file: 'src/features/billing/PlanScreen.tsx', contains: ['openBillingPortal'] },
  },
  {
    id: 'plan.change-tier',
    area: 'Plan',
    what: 'Change tier while already subscribed',
    mobile: 'apps/mobile/App.tsx:5111 opens the portal with a targetTierId',
    state: 'parity',
    note: 'Naming the tier on the portal call is what makes it a plan change rather than a cancel-only portal visit. A downgrade never leaves the app: the Worker books it for the renewal date and the screen says so.',
    proof: {
      file: 'src/features/billing/PlanScreen.tsx',
      contains: ['openBillingPortal(tierId, confirmScheduledPlanChange)', 'Switch to'],
    },
  },
  {
    id: 'plan.unsubscribed-block',
    area: 'Plan',
    what: 'Without a subscription the app holds you on the plan screen',
    mobile: 'apps/mobile/App.tsx:5424 SetupWizard gate',
    state: 'gap',
    why: 'The browser app is fully browsable while unsubscribed. Nothing sensitive leaks, but it is a different product shape from the phone and it lets someone wander into screens that cannot do anything for them.',
  },

  // --------------------------------------------------------------- Capacity
  {
    id: 'capacity.usage',
    area: 'Capacity',
    what: 'How much of the month has been used',
    mobile: 'apps/mobile/App.tsx:3730',
    state: 'parity',
    proof: { file: 'src/features/billing/CapacityScreen.tsx', contains: ['CapacityCard'] },
  },
  {
    id: 'capacity.on-profile',
    area: 'Capacity',
    what: 'A usage summary on the profile screen',
    mobile: 'apps/mobile/App.tsx:2254',
    state: 'gap',
    why: 'On the phone the profile screen answers "how am I doing this month" without a second trip. In the browser it is a separate screen you have to know about.',
  },

  // ---------------------------------------------------------------- Profile
  {
    id: 'profile.rename-coworker',
    area: 'Profile',
    what: "Change the coworker's name",
    mobile: 'apps/mobile/App.tsx profile',
    state: 'parity',
    proof: { file: 'src/features/profile/ProfileScreen.tsx', contains: ['updateProfile'] },
  },
  {
    id: 'profile.save-feedback-is-visible',
    area: 'Profile',
    what: 'The result of pressing Save appears where the reader is looking',
    mobile: 'apps/mobile/App.tsx inline notice',
    state: 'parity',
    note: 'Both the confirmation and the failure used to render four fields above the button that produced them.',
    proof: { file: 'src/features/profile/ProfileScreen.tsx', contains: ['Saved.'] },
  },
  {
    id: 'profile.versions',
    area: 'Profile',
    what: 'Engine and app version rows',
    mobile: 'apps/mobile/App.tsx:2254',
    state: 'gap',
    why: 'It is the first thing anyone asks for when reporting a problem, and the browser cannot answer it.',
  },

  // --------------------------------------------------------------- Routines
  {
    id: 'routines.list',
    area: 'Routines',
    what: 'See the routines',
    mobile: 'apps/mobile/App.tsx:3015',
    state: 'parity',
    proof: { file: 'src/features/routines/RoutinesScreen.tsx', contains: ['fetchRoutines'] },
  },
  {
    id: 'routines.create',
    area: 'Routines',
    what: 'Create a routine',
    mobile: 'apps/mobile/App.tsx:3015',
    state: 'parity',
    proof: { file: 'src/features/routines/RoutinesScreen.tsx', contains: ['createRoutine'] },
  },
  {
    id: 'routines.pause',
    area: 'Routines',
    what: 'Pause and resume a routine',
    mobile: 'apps/mobile/App.tsx:3015',
    state: 'parity',
    proof: { file: 'src/features/routines/RoutinesScreen.tsx', contains: ['setRoutinePaused'] },
  },
  {
    id: 'routines.delete',
    area: 'Routines',
    what: 'Delete a routine, behind a confirmation',
    mobile: 'apps/mobile/App.tsx:3015',
    state: 'parity',
    proof: { file: 'src/features/routines/RoutinesScreen.tsx', contains: ['deleteRoutine', 'ConfirmDialog'] },
  },
  {
    id: 'routines.name',
    area: 'Routines',
    what: 'Give a routine its own name',
    mobile: 'apps/mobile/App.tsx:3015 create form',
    state: 'gap',
    why: 'Without it a list of routines is a list of instructions, which is hard to scan once there is more than a couple.',
  },

  // ------------------------------------------------------------ Connections
  {
    id: 'connections.list',
    area: 'Connections',
    what: 'See what is connected',
    mobile: 'apps/mobile/App.tsx:3375',
    state: 'parity',
    proof: { file: 'src/features/connections/ConnectionsScreen.tsx', contains: ['buildConnectionRows'] },
  },
  {
    id: 'connections.connect',
    area: 'Connections',
    what: 'Connect an account by signing in at the provider',
    mobile: 'apps/mobile/App.tsx:3375',
    state: 'parity',
    proof: { file: 'src/features/connections/ConnectionsScreen.tsx', contains: ['startConnection', 'SafetySheet'] },
  },
  {
    id: 'connections.disconnect',
    area: 'Connections',
    what: 'Disconnect, behind a confirmation',
    mobile: 'apps/mobile/App.tsx:3375',
    state: 'parity',
    proof: { file: 'src/features/connections/ConnectionsScreen.tsx', contains: ['disconnectConnection', 'ConfirmDialog'] },
  },
  {
    id: 'connections.handoff-error-visible',
    area: 'Connections',
    what: 'A hand-off that will not open is reported inside the sheet, next to the button',
    mobile: 'apps/mobile/App.tsx inline notice',
    state: 'parity',
    proof: { file: 'src/features/connections/ConnectionsScreen.tsx', contains: ['sheetError'] },
  },

  // ----------------------------------------------------------------- Skills
  {
    id: 'skills.categories',
    area: 'Skills',
    what: 'Browse what the coworker can do',
    mobile: 'apps/mobile/App.tsx:2807',
    state: 'parity',
    proof: { file: 'src/features/skills/SkillsScreen.tsx', contains: ['DELEGENT_USE_CASE_CATEGORIES'] },
  },
  {
    id: 'skills.use-phrase',
    area: 'Skills',
    // Removed on both surfaces 2026-09-03 at Alex's request: "remove the
    // invocation of the skill at the bottom of the skill which says like be my
    // bookkeeper ... if the connection works properly and someone just says can
    // you connect to free agent for me, you don't need a skill that says be my
    // bookkeeper." Skills are now a description of what the coworker can do.
    // The row is kept as a 'gap' rather than deleted so the proof staying
    // absent is asserted, and re-adding the chip on the web without the phone
    // fails this test.
    what: 'Send an example straight to chat (removed: skills are descriptive now)',
    mobile: 'apps/mobile/App.tsx (removed 2026-09-03)',
    state: 'gap',
    why: 'Deliberately removed from BOTH surfaces on 2026-09-03. Alex: skills are a description of what the coworker can do, not a phrase to recite; a connection is reached by naming the service. Recorded as a gap rather than deleted so re-adding the chip on the web without the phone fails this test.',
    proof: { file: 'src/features/skills/SkillsScreen.tsx', contains: ['queueChatCommand'] },
  },
  {
    id: 'skills.category-detail',
    area: 'Skills',
    what: 'Open a category to read all of its examples',
    mobile: 'apps/mobile/App.tsx:2837 SkillCategoryDetail',
    state: 'gap',
    why: 'The browser shows a card per category with no way in, so the longer example lists are unreachable.',
  },

  // --------------------------------------------------------------- Commands
  {
    id: 'commands.list',
    area: 'Commands',
    what: 'See the chat commands and run one',
    mobile: 'apps/mobile/App.tsx:2898',
    state: 'parity',
    proof: { file: 'src/features/commands/CommandsScreen.tsx', contains: ['DELEGENT_CHAT_COMMANDS', 'queueChatCommand'] },
  },

  // ------------------------------------------------------------------- Help
  {
    id: 'help.screen',
    area: 'Help',
    what: 'Help screen',
    mobile: 'apps/mobile/App.tsx:3646',
    state: 'parity',
    proof: { file: 'src/features/help/HelpScreen.tsx', contains: ['export function HelpScreen'] },
  },
  {
    id: 'help.faq',
    area: 'Help',
    what: 'FAQ, from the same source as the phone',
    mobile: 'apps/mobile/App.tsx:3636',
    state: 'parity',
    proof: { file: 'src/features/help/FaqScreen.tsx', contains: ['DELEGENT_FAQ_ORDERED'] },
  },
  {
    id: 'help.legal',
    area: 'Help',
    what: 'Terms and privacy',
    mobile: 'apps/mobile/App.tsx:618',
    state: 'parity',
    proof: { file: 'src/features/legal/LegalScreen.tsx', contains: ['export function LegalScreen'] },
  },
  {
    id: 'help.notices',
    area: 'Help',
    what: 'Open-source attributions',
    mobile: 'apps/mobile/App.tsx:735 NoticesContent',
    state: 'gap',
    why: 'A licence obligation on the phone. The browser app ships different dependencies, so it needs its own list rather than a copy of that one.',
  },

  // ------------------------------------------------------------- Onboarding
  {
    id: 'onboarding.name-and-accept',
    area: 'Onboarding',
    what: 'Name the coworker and accept the terms before anything else loads',
    mobile: 'apps/mobile/App.tsx:4660',
    state: 'parity',
    proof: {
      file: 'src/features/onboarding/OnboardingScreen.tsx',
      contains: ['ACKNOWLEDGEMENT_TEXT', 'ACKNOWLEDGEMENT_VERSION', 'normalizeAgentName'],
    },
  },
  {
    id: 'onboarding.explicit-checkbox',
    area: 'Onboarding',
    what: 'Acceptance is a deliberate tick, not implied by pressing Continue',
    mobile: 'apps/mobile/App.tsx:4660',
    state: 'gap',
    why: 'The phone makes the reader tick a box. The browser records the same acknowledgement version off the Continue button, which is a weaker record of consent for the same legal text.',
  },

  // ---------------------------------------------------------------- Support
  {
    id: 'support.form',
    area: 'Support',
    what: 'Contact support without leaving the app',
    mobile: 'not on the phone',
    state: 'web-only',
    proof: { file: 'src/features/support/SupportScreen.tsx', contains: ['export function SupportScreen'] },
  },
  {
    id: 'platform.ota-banner',
    area: 'Shell',
    what: 'An update-available banner',
    mobile: 'apps/mobile/App.tsx:4617 UpdateAvailableBanner',
    state: 'n-a',
    why: 'A browser reload is the update. There is no bundle to download and nothing for a reader to agree to.',
  },
];
