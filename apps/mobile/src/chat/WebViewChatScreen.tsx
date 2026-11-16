import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, Keyboard, Linking, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { keyboardOverlapDp } from './keyboardOverlap';
import { LIVE_TALK_HOST, MODEL_NAME_PUBLIC } from '@sidekick/shared';
/**
 * Live Talk keeps the screen on (2026-09-28). The native module ships inside
 * `expo`, proven in the Android binary, but it is loaded lazily and inside a
 * try: an OTA that imports a native module a binary lacks crashes on launch
 * (the Sentry crash of August), so a missing module only means no keep-awake.
 */
function setTalkKeepAwake(on: boolean): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keepAwake = require('expo-keep-awake') as typeof import('expo-keep-awake');
    if (on) void keepAwake.activateKeepAwakeAsync('live-talk').catch(() => {});
    else void Promise.resolve(keepAwake.deactivateKeepAwake('live-talk')).catch(() => {});
  } catch {
    // No native module in this binary: the screen just follows its timeout.
  }
}
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { getFreshMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { mobileChatApiBaseUrl, warmRunner } from './chatClient';
import { CHAT_WEBVIEW_HTML } from './chatWebViewHtml';
import {
  captureAndUploadChatPhoto,
  getPendingCameraCaptures,
  pickAndUploadChatAttachment,
  uploadCapturedChatPhoto,
} from './chatAttachmentUpload';
import { startRecording, stopRecording, transcribeRecording, type VoiceRecorderHandle } from './voiceRecorder';
import { reportChatFrameError } from '../observability/sentry';
import { createFirstTaskReview } from '../reviews/firstTaskReview';
import { claimFirstTaskReview, isNativeReviewAvailable, requestNativeTaskReview } from '../reviews/nativeTaskReview';

// 2026-07-16: every piloted chat feature is GA (friendly cards + push-to-talk
// 07-14, voice mode + Telegram connect 07-16), so the chat surface no longer
// consults the pilot allowlist. src/state/pilotFeatures.ts remains for future
// pilots; the init flags below keep the WebView contract shape unchanged.

// Hard client-side ceiling so a forgotten live mic can't record (and bill
// voice-seconds) indefinitely; the worker meters by duration on top of this.
const VOICE_MAX_RECORDING_MS = 120_000;

interface WebViewChatScreenProps {
  conversationId: string;
  agentName: string;
  hasActiveSubscription: boolean;
  hardLimited: boolean;
  /**
   * True at 80% of the monthly token allowance (packages/shared: `ratio >=
   * 0.8`), same threshold the native capacity screen already uses. Added
   * 2026-08-26 because `hardLimited` alone left a gap: it only flips at
   * usedTokens >= quota, a coarse boundary, while a SPECIFIC request can be
   * refused for costing more than what little is left days before that
   * count is reached. In that gap the WebView had no signal at all, so its
   * "This chat: loads of room" context label kept reassuring someone with
   * a few thousand tokens left in the entire month.
   */
  nearLimit: boolean;
  nextResetAtIso: string | null;
  // This screen stays mounted behind every other tab so a reply in flight
  // survives leaving chat, which means unmount is not a signal that the user
  // has gone. This is.
  active: boolean;
  onOpenBillingPortal: () => void;
  // PREOP-H01/H02: a file tap inside chat must route to the Files tab and
  // focus the file there, instead of the inert preview affordance.
  onOpenFile?: (path: string) => void;
  /** The account is on the agent engine (src/state/coworkerEngine.ts): no workspace, no Telegram. */
  agentEngine?: boolean;
}

export function WebViewChatScreen({
  conversationId,
  agentName,
  hasActiveSubscription,
  hardLimited,
  nearLimit,
  nextResetAtIso,
  active,
  onOpenBillingPortal,
  onOpenFile,
  agentEngine = false,
}: WebViewChatScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const tokenRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Flipped once the chat document has announced itself. The navigation policy
  // below needs it to tell the document's own initial load apart from a later
  // navigation to the same URL, which must not be allowed to replace it.
  const documentReadyRef = useRef(false);
  // Bumped to rebuild the WebView after Android destroys its renderer process.
  const [webViewGeneration, setWebViewGeneration] = useState(0);
  // STATE mirror of documentReadyRef, purely so the rebuilding overlay can
  // render. The ref is what the navigation policy reads on every callback and
  // must stay a ref (a stale closure there would reject the document's own
  // load); a ref alone cannot drive a re-render, so the overlay would appear
  // and never leave. Both are set together, always.
  const [frameReady, setFrameReady] = useState(true);
  // Mirror of the `active` prop for event callbacks, plus the deferral flag
  // for a kill that arrives while the chat tab is hidden. Remounting a
  // WKWebView inside a hidden (zero-layout) pane is exactly how you get the
  // half-painted corpse Alex reported on 2026-08-13: WKWebView loaded at zero
  // size renders partially and our scrollEnabled={false} removes the repaint
  // nudge a scroll would give it. So a hidden kill only records the debt, and
  // the remount happens on the next return to the tab, when the fresh WebView
  // gets real layout from its first frame.
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const pendingRemountRef = useRef(false);
  // Liveness probe timer: armed on each return to the chat tab, cleared by the
  // page answering. Outlives the arming effect via this ref.
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 2026-07-08 (live user report, Samsung on Android 15): with targetSdk >= 35
  // the OS enforces edge-to-edge and `adjustResize` no longer shrinks the
  // window, so this WebView keeps its full height and the composer (bottom of
  // the HTML document) disappears behind the soft keyboard. Older Androids DO
  // still resize the window, so a blind paddingBottom = keyboardHeight would
  // double-compensate there and float the composer a keyboard-height too
  // high. Measure the ACTUAL overlap between the container's bottom edge and
  // the keyboard's top edge instead: ~0 on resize devices, exactly the
  // covered height on enforced-edge-to-edge devices. Re-measured on container
  // relayout (onLayout) so a late resize pass corrects an early estimate.
  const containerRef = useRef<View>(null);
  const keyboardTopRef = useRef<number | null>(null);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const measureKeyboardOverlap = useCallback(() => {
    // Refresh the keyboard's CURRENT top edge first: GBoard grows after its
    // initial keyboardDidShow (suggestion/toolbar strip lands late) and
    // Android fires no follow-up event, so the event payload alone
    // under-measures by the strip height (observed on the API 33 lab
    // emulator: composer still clipped ~100px).
    const metrics = Keyboard.metrics?.();
    if (metrics && typeof metrics.screenY === 'number') {
      keyboardTopRef.current = metrics.screenY;
    }
    const keyboardTop = keyboardTopRef.current;
    const node = containerRef.current;
    if (keyboardTop === null || !node) return;
    node.measureInWindow((_x, y, _width, height) => {
      if (keyboardTopRef.current === null) return; // keyboard hid mid-measure
      // measureInWindow counts from below the status bar and the keyboard from
      // the top of the screen; see keyboardOverlapDp.
      setKeyboardOverlap(keyboardOverlapDp({ viewY: y, viewHeight: height, viewportTop: StatusBar.currentHeight ?? 0, keyboardTop }));
    });
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      const top = event.endCoordinates?.screenY;
      if (typeof top !== 'number') return;
      keyboardTopRef.current = top;
      measureKeyboardOverlap();
      // A resize-mode relayout or a late keyboard-strip growth can land well
      // after keyboardDidShow; re-measure on a short settle schedule so every
      // ordering converges on the true overlap.
      for (const delay of [120, 400, 800]) {
        timers.push(setTimeout(measureKeyboardOverlap, delay));
      }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTopRef.current = null;
      setKeyboardOverlap(0);
    });
    return () => {
      show.remove();
      hide.remove();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [measureKeyboardOverlap]);

  // Native→HTML transport: `webView.postMessage` is unreliable on Android
  // RNWebView 13.x release builds (observed silently failing in production
  // smoke testing). We use `injectJavaScript` to call a global receiver
  // exposed by the HTML (window.__sidekickReceive), which dispatches a
  // synthetic MessageEvent that the HTML's existing handler reads.
  const deliverToWebView = useCallback((payload: object) => {
    if (!webViewRef.current) return;
    const serialized = JSON.stringify(payload);
    // JSON.stringify-ing the already-serialized string yields a complete,
    // correctly quoted JS string literal (quotes, backslashes, newlines,
    // U+2028/U+2029 all escaped) — hand-rolled escaping missed \r and the
    // line separators, which terminate a single-quoted literal.
    webViewRef.current.injectJavaScript(`window.__sidekickReceive && window.__sidekickReceive(${JSON.stringify(serialized)}); true;`);
  }, []);

  const injectInit = useCallback(async () => {
    const token = await getFreshMobileAccessToken(mobileSupabase);
    if (!token || !webViewRef.current) {
      // Surface the no-token case so the WebView can show a sign-in
      // recovery hint instead of silently leaving the composer disabled.
      deliverToWebView({
        type: 'init_failed',
        reason: !token ? 'no_token' : 'no_webview_ref',
      });
      return;
    }

    deliverToWebView({
      type: 'init',
      apiBaseUrl: mobileChatApiBaseUrl || '',
      accessToken: token,
      userId: conversationId,
      agentName: agentName || 'Nova',
      hasActiveSubscription,
      hardLimited,
      nearLimit,
      nextResetAtIso,
      // The document adapts per-OS where WebView engines genuinely differ.
      // First user: voice mode goes half-duplex on iOS, because WKWebView's
      // echo cancellation is ineffective and the speaker feeds the mic.
      platform: Platform.OS,
      // Named only in the Talk beta note (and the FAQ), from one constant.
      modelName: MODEL_NAME_PUBLIC,
      // Live Talk's voice Worker; the page keeps the orb on iPhone itself.
      liveTalkHost: LIVE_TALK_HOST,
      nativeStoreReview: true,
      // Both features GA'd to all users 2026-07-16 after Alex's pilot round.
      //
      // voiceCapture (push-to-talk dictation) is ANDROID-ONLY. expo-av's
      // native pod is excluded from Apple builds (deviation D-11, see
      // voiceRecorder.ts), and on TestFlight build 32 tapping the dictate mic
      // KILLED THE APP: the ASC crash log (2026-08-13, incident 49B119CF)
      // shows RCTFatal via RCTExceptionsManager out of a void TurboModule
      // invocation, an exception path that surfaces on the native queue where
      // voiceRecorder's try/catch provably cannot reach it. False hides the
      // mic button and its tour row in the WebView, so iOS never enters the
      // path. Voice MODE (the live conversation) runs on WebRTC inside the
      // WebView, needs no expo-av, and stays on for both platforms.
      pilotFeatures: { telegramConnect: true, voiceMode: true, voiceCapture: Platform.OS !== 'ios' },
      // Telegram reaches a workspace, so an agent-engine account is not offered
      // it. Overrides the shape above, which every other account gets.
      ...(agentEngine ? { pilotFeatures: { telegramConnect: false, voiceMode: true, voiceCapture: Platform.OS !== 'ios' } } : {}),
      agentEngine,
    });
  }, [conversationId, agentName, hasActiveSubscription, hardLimited, nearLimit, nextResetAtIso, deliverToWebView, agentEngine]);

  useEffect(() => {
    deliverToWebView({
      type: 'quota_update',
      hasActiveSubscription,
      hardLimited,
      nearLimit,
      nextResetAtIso,
    });
  }, [hasActiveSubscription, hardLimited, nearLimit, nextResetAtIso, deliverToWebView]);

  // 2026-07-16 (Alex): messages that arrive while the app is backgrounded
  // (Telegram-side turns, voice-filed task results) only showed after a full
  // app kill. Nudge the WebView to quietly re-sync whenever we return to the
  // foreground; the WebView's own 30s ambient refresh covers the open-app case.
  // 2026-09-24 (Alex): after about an hour in the background the WebView's
  // token has expired (the 45s refresh timer is paused while backgrounded), so
  // this refresh was refused with a 401 and dropped, and the transcript only
  // caught up on the next 30s tick. Hand over a fresh token first, then refresh.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void (async () => {
        try {
          const token = await getFreshMobileAccessToken(mobileSupabase);
          if (token) deliverToWebView({ type: 'token_refresh', accessToken: token });
        } catch { /* The WebView retries on its own when a fresh token arrives. */ }
        deliverToWebView({ type: 'history_refresh' });
      })();
    });
    return () => sub.remove();
  }, [deliverToWebView]);

  // Cold-boot mitigation. NOTE (2026-08-03): autostop is currently OFF in
  // production (FLY_RUNNER_AUTOSTOP='off', .github/workflows/series4-cron.yml),
  // switched off after the 2026-07-09 incident where a stop transition
  // black-holed a paying user's dispatches for 13+ minutes. So there is no cold
  // boot to mitigate today and this ping is close to a no-op. It is kept
  // deliberately: it is harmless, and it is the groundwork if scale-to-zero is
  // ever re-enabled. See docs/AUTO_SLEEP_ANALYSIS.md.
  //
  // The original comment, left for context: the per-user runner uses autostop=stop (scale to
  // zero), so the FIRST message of a session waits tens of seconds for a Fly
  // cold boot. Fire a best-effort warm ping when the chat mounts and each time
  // the app returns to the foreground, so the box is already booting while the
  // user reads / types. Only worth it for subscribers with a live runner; the
  // Worker no-ops otherwise. Fully fire-and-forget: errors are swallowed.
  useEffect(() => {
    if (!hasActiveSubscription) return;
    void warmRunner().catch(() => undefined);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void warmRunner().catch(() => undefined);
    });
    return () => sub.remove();
  }, [hasActiveSubscription]);

  // "Start fresh chat" command from the ☰ menu Commands area (App.tsx emits on
  // the shared event bus). The chat WebView is always mounted (the dashboard
  // pane is hidden, not unmounted), so this listener is reliably alive whichever
  // tab the menu was opened from. The reset logic + divider live in the WebView.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('delegent:startFreshChat', () => {
      deliverToWebView({ type: 'start_fresh_chat' });
    });
    return () => sub.remove();
  }, [deliverToWebView]);

  // Other ☰ menu Commands (usage, status, tidy up, memory, personality, goal).
  // 'send' runs the command immediately in-chat; 'compose' pre-types it into the
  // composer so the user finishes it (e.g. adds their goal) and sends.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('delegent:menuCommand', (payload?: { command?: string; mode?: string }) => {
      const command = typeof payload?.command === 'string' ? payload.command : '';
      if (!command) return;
      const mode = payload?.mode === 'compose' ? 'compose' : 'send';
      deliverToWebView({ type: 'menu_command', command, mode });
    });
    return () => sub.remove();
  }, [deliverToWebView]);

  useEffect(() => {
    tokenRefreshInterval.current = setInterval(async () => {
      const token = await getFreshMobileAccessToken(mobileSupabase);
      if (token) {
        deliverToWebView({ type: 'token_refresh', accessToken: token });
      }
    }, 45_000);

    return () => {
      if (tokenRefreshInterval.current) clearInterval(tokenRefreshInterval.current);
    };
  }, [deliverToWebView]);

  // Chat paperclip: the WebView composer can't reach the native file picker
  // or the runner-upload plumbing, so it asks us to do it. We open the same
  // expo-document-picker the Files tab uses, upload the bytes to the runner
  // workspace (POST /api/files/runner → stored under uploads/, readable by the
  // agent's file/vision tools), and report progress back to the WebView so it
  // can show a chip and reference the file in the next message. A user cancel
  // is silent; every failure becomes a friendly attachment_error.
  const onPickAttachment = useCallback(async () => {
    const localId = `att-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const outcome = await pickAndUploadChatAttachment('any', {
      onPicked: (name) => deliverToWebView({ type: 'attachment_uploading', localId, name }),
    });
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'error') {
      deliverToWebView({ type: 'attachment_error', localId, message: outcome.message });
      return;
    }
    deliverToWebView({
      type: 'attachment_added',
      localId,
      id: outcome.file.id,
      name: outcome.file.name,
      relativeName: outcome.file.relativeName,
      mimeType: outcome.file.mimeType,
      sizeBytes: outcome.file.sizeBytes,
    });
  }, [deliverToWebView]);

  // Camera button: the WhatsApp-style "take a photo and send it" affordance.
  // The WebView owns the button; native owns the camera + the runner upload,
  // mirroring onPickAttachment exactly (same localId scheme, same
  // attachment_uploading / attachment_added / attachment_error messages) so the
  // WebView renders an identical chip whether the photo came from the paperclip
  // or the camera. A permission denial / capture failure becomes a friendly
  // attachment_error; a user cancel is silent.
  const onPickCamera = useCallback(async () => {
    const localId = `cam-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const outcome = await captureAndUploadChatPhoto({
      onPicked: (name) => deliverToWebView({ type: 'attachment_uploading', localId, name }),
    });
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'error') {
      deliverToWebView({ type: 'attachment_error', localId, message: outcome.message });
      return;
    }
    deliverToWebView({
      type: 'attachment_added',
      localId,
      id: outcome.file.id,
      name: outcome.file.name,
      relativeName: outcome.file.relativeName,
      mimeType: outcome.file.mimeType,
      sizeBytes: outcome.file.sizeBytes,
    });
  }, [deliverToWebView]);

  // Camera crash-recovery: on a low-RAM device Android can kill the app while
  // the camera activity is foreground, so the promise onPickCamera awaited never
  // resolves and the photo is lost on return. expo-image-picker stashes that
  // capture; once the WebView signals `ready` (so window.__sidekickReceive
  // exists to render chips) we replay it through the SAME upload + chip path as
  // a live capture, under a fresh localId. getPendingResultAsync self-clears and
  // the ref guards a WebView reload re-firing `ready`, so a photo is recovered
  // at most once. The `attachment_added` handler in the WebView tolerates a
  // never-seen localId (it pushes a fresh ready chip), so a dropped
  // "uploading…" beat can't strand the recovered photo.
  const pendingCameraRecovered = useRef(false);
  const recoverPendingCameraPhotos = useCallback(async () => {
    if (pendingCameraRecovered.current) return;
    pendingCameraRecovered.current = true;
    const photos = await getPendingCameraCaptures();
    for (const photo of photos) {
      const localId = `cam-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const outcome = await uploadCapturedChatPhoto(photo, {
        onPicked: (name) => deliverToWebView({ type: 'attachment_uploading', localId, name }),
      });
      if (outcome.status === 'cancelled') continue;
      if (outcome.status === 'error') {
        deliverToWebView({ type: 'attachment_error', localId, message: outcome.message });
        continue;
      }
      deliverToWebView({
        type: 'attachment_added',
        localId,
        id: outcome.file.id,
        name: outcome.file.name,
        relativeName: outcome.file.relativeName,
        mimeType: outcome.file.mimeType,
        sizeBytes: outcome.file.sizeBytes,
      });
    }
  }, [deliverToWebView]);

  // Push-to-talk (pilot): the WebView owns the button, native owns the
  // recorder (expo-av) + the transcribe upload, mirroring the attachment
  // picker split. One recording at a time; a hard timeout stops a forgotten
  // live mic and still delivers the transcript.
  const voiceHandleRef = useRef<VoiceRecorderHandle | null>(null);
  const voiceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // startRecording asks for mic permission, so on a first tap it can sit on a
  // system dialog for seconds. The WebView lets the user tap stop during that
  // window, and a stop that arrives before the handle exists has nothing to
  // cancel unless the in-flight start is told to throw its recorder away.
  const voiceStartingRef = useRef(false);
  const voiceCancelledRef = useRef(false);

  const onVoiceStop = useCallback(async () => {
    if (voiceTimeoutRef.current) {
      clearTimeout(voiceTimeoutRef.current);
      voiceTimeoutRef.current = null;
    }
    const handle = voiceHandleRef.current;
    voiceHandleRef.current = null;
    if (!handle) {
      if (voiceStartingRef.current) {
        // The mic is still opening. Left alone it would go live moments later
        // and run the full two-minute timeout, then splice a transcript of
        // whatever it overheard into the composer of a user who had already
        // stopped. An empty transcript puts the composer back to idle with
        // nothing added, which is what "you stopped before it started" means.
        voiceCancelledRef.current = true;
        deliverToWebView({ type: 'voice_transcript', text: '' });
        return;
      }
      deliverToWebView({ type: 'voice_error', reason: 'transcribe_unavailable' });
      return;
    }
    const stopped = await stopRecording(handle);
    if (!stopped) {
      deliverToWebView({ type: 'voice_error', reason: 'transcribe_unavailable' });
      return;
    }
    const result = await transcribeRecording(stopped.uri, stopped.durationSeconds);
    if (result.ok) deliverToWebView({ type: 'voice_transcript', text: result.text });
    else deliverToWebView({ type: 'voice_error', reason: result.error });
  }, [deliverToWebView]);

  const onVoiceStart = useCallback(async () => {
    if (voiceHandleRef.current || voiceStartingRef.current) return; // already recording or opening
    voiceStartingRef.current = true;
    voiceCancelledRef.current = false;
    const started = await startRecording();
    voiceStartingRef.current = false;
    const cancelled = voiceCancelledRef.current;
    voiceCancelledRef.current = false;
    if (typeof started === 'object' && started !== null && 'error' in started) {
      if (!cancelled) deliverToWebView({ type: 'voice_error', reason: started.error });
      return;
    }
    if (cancelled) {
      // Stop or unmount landed while the mic was opening. Release it and stay
      // quiet: whoever cancelled has already been answered.
      void stopRecording(started);
      return;
    }
    voiceHandleRef.current = started;
    deliverToWebView({ type: 'voice_started' });
    voiceTimeoutRef.current = setTimeout(() => void onVoiceStop(), VOICE_MAX_RECORDING_MS);
  }, [deliverToWebView, onVoiceStop]);

  const releaseMicrophone = useCallback(() => {
    if (voiceTimeoutRef.current) {
      clearTimeout(voiceTimeoutRef.current);
      voiceTimeoutRef.current = null;
    }
    // A start still waiting on the permission dialog holds no handle yet, so
    // without this the mic would open after the screen is gone.
    if (voiceStartingRef.current) voiceCancelledRef.current = true;
    const handle = voiceHandleRef.current;
    voiceHandleRef.current = null;
    if (!handle) return;
    void stopRecording(handle);
    // The composer inside the WebView is still on its recording state, and the
    // user is not looking at it. An empty transcript is the settled way to put
    // it back to idle with nothing added; the alternative is a chat that says it
    // is listening when the mic has already been closed.
    deliverToWebView({ type: 'voice_transcript', text: '' });
  }, [deliverToWebView]);

  // Leaving chat mid-recording must release the mic. This hangs off the tab
  // rather than off unmount alone, because this screen stays mounted behind
  // every other tab so a reply in flight survives the trip, which means unmount
  // never fires while the app is running. The recording used to keep going, run
  // the full two-minute ceiling, and then splice a transcript of whatever the
  // room had said into a composer the user had walked away from, with Android
  // showing the mic indicator the whole time.
  useEffect(() => {
    if (active) return;
    releaseMicrophone();
  }, [active, releaseMicrophone]);

  useEffect(() => {
    return () => releaseMicrophone();
  }, [releaseMicrophone]);

  const [reviewPending, setReviewPending] = useState<string | null>(null);
  const reviewMountedRef = useRef(true);
  useEffect(() => {
    reviewMountedRef.current = true;
    return () => { reviewMountedRef.current = false; };
  }, []);
  const reviewUserRef = useRef(conversationId);
  reviewUserRef.current = conversationId;
  const requestFirstTaskReview = useMemo(() => createFirstTaskReview({
    isAvailable: isNativeReviewAvailable,
    claim: () => claimFirstTaskReview(conversationId),
    requestReview: requestNativeTaskReview,
    canPresent: () => reviewMountedRef.current && reviewUserRef.current === conversationId && activeRef.current
      && AppState.currentState === 'active' && keyboardTopRef.current === null
      && !voiceHandleRef.current && !voiceStartingRef.current,
  }), [conversationId]);
  useEffect(() => {
    if (reviewPending !== conversationId || !active) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      const outcome = await requestFirstTaskReview();
      if (!cancelled && (outcome === 'finished' || ++attempts >= 5)) setReviewPending(null);
    };
    // Leave time to read the completed reply. Brief retries cover the gap
    // between the terminal stream event and its durable task-status update.
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [reviewPending, active, requestFirstTaskReview, conversationId]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'store_review_ready' && msg.userId === conversationId) setReviewPending(conversationId);
      if (msg.type === 'pong' || msg.type === 'ready') {
        // Either answer settles an in-flight liveness probe: the document is
        // demonstrably alive (pong), or a fresh one just announced itself
        // (ready) and the probe's target no longer exists.
        if (probeTimerRef.current) {
          clearTimeout(probeTimerRef.current);
          probeTimerRef.current = null;
        }
      }
      if (msg.type === 'ready') {
        documentReadyRef.current = true;
        setFrameReady(true);
        injectInit();
        // The WebView is now able to render chips: replay any photo the OS
        // dropped by killing us mid-camera (no-op when nothing is pending).
        void recoverPendingCameraPhotos();
      }
      if (msg.type === 'pick_attachment') {
        void onPickAttachment();
      }
      if (msg.type === 'pick_camera') {
        void onPickCamera();
      }
      if (msg.type === 'voice_start' && Platform.OS === 'ios') {
        // Belt to the voiceCapture:false brace above: a document that somehow
        // still shows the mic (stale bundle, race before init) must get the
        // polite refusal, never the native recorder path that killed the app.
        deliverToWebView({ type: 'voice_error', reason: 'recorder_unavailable' });
        return;
      }
      if (msg.type === 'voice_start') {
        void onVoiceStart();
      }
      if (msg.type === 'voice_stop') {
        void onVoiceStop();
      }
      if (msg.type === 'keep_awake') setTalkKeepAwake(msg.on === true);
      if (msg.type === 'open_file') {
        // PREOP-H01/H02: route the chat file tap to the Files tab + focus the
        // file there. Previously this was an inert stub, so tapping a file in
        // chat showed a preview affordance but performed no action.
        if (typeof msg.path === 'string' && msg.path.length > 0) onOpenFile?.(msg.path);
      }
      if (msg.type === 'open_billing') {
        onOpenBillingPortal();
      }
      if (msg.type === 'webview_error') {
        // A throw inside the chat frame cannot reach the crash reporter on its
        // own: the frame catches it and hands it to us, and before this we
        // dropped it. The chat is the product, so a silent freeze there is the
        // single worst thing to have no signal for.
        reportChatFrameError(String(msg.stage || 'unknown'), String(msg.message || ''));
      }
    } catch {}
  }, [deliverToWebView, injectInit, onOpenBillingPortal, onOpenFile, onPickAttachment, onPickCamera, onVoiceStart, onVoiceStop, recoverPendingCameraPhotos, conversationId]);

  // CRITICAL: memoise the `source` object. RN WebView treats source by
  // reference — passing a fresh `{ html, baseUrl }` literal on every
  // render makes it remount + re-load + re-flash, which is what Alex
  // observed as "the HTML screen is jumping up and down" during the
  // provisioning state (productState refreshes every few seconds while
  // the runner warms up, triggering a re-render of this component, and
  // a fresh source literal made the WebView re-bootstrap each time).
  const webViewSource = useMemo(
    () => ({ html: CHAT_WEBVIEW_HTML, baseUrl: mobileChatApiBaseUrl || 'https://sidekick.invalid' }),
    [],
  );

  // The chat surface is a single inline-HTML document: the ONLY in-WebView
  // navigation we ever want is its own initial load. Anything else (a tapped
  // link, or a navigation forced by hostile assistant markup) leaves the app
  // surface: plain web links go to the system browser; javascript:/data:/
  // intent:/file: and friends are dropped outright.
  const handleShouldStartLoad = useCallback((request: { url: string }) => {
    const url = request.url || '';
    const ownOrigin = mobileChatApiBaseUrl || 'https://sidekick.invalid';
    // Only BEFORE the document is ready, because the inline chat is served at
    // this very origin: once it has loaded, a link pointing at the origin root
    // is a link like any other, and letting it through navigated the WebView
    // off the chat and onto the API's JSON error body. Nothing brings it back
    // (no history gestures, the source object never changes, and the screen
    // stays mounted behind every tab), so the chat was gone until the app was
    // killed. After ready it falls through to the browser hand-off below.
    if (!documentReadyRef.current && (url === 'about:blank' || url === ownOrigin || url === `${ownOrigin}/`)) {
      return true;
    }
    // The chat origin is the Worker's API root, which serves "Not found" to a
    // browser. AFTER the document is ready, a navigation there is never a link
    // a user wants followed: on iOS it is the reload a dying WKWebView issues
    // against its baseUrl, and handing that to the generic branch below opened
    // Safari on the Worker's 404 page (Alex, 2026-08-13, "says not found and
    // opens another window"). Refuse it silently; the content-process handler
    // owns the actual recovery.
    if (url === ownOrigin || url === `${ownOrigin}/`) {
      return false;
    }
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      // mailto: matches safeLinkHref's allow-list in the chat HTML, so a
      // rendered mail link must reach the system handler, not die here.
      Linking.openURL(url).catch(() => {});
      return false;
    }
    return false;
  }, []);

  // Android kills a WebView's renderer process under memory pressure. The
  // native client survives it (returning false there would crash the app) and
  // hands us the event, but the WebView it leaves behind is dead: blank, inert,
  // and never rebuilt on its own, because the source object is memoised, the
  // screen stays mounted behind every tab and no navigation can reach it. The
  // chat was gone until the user killed the app. Remounting on a fresh key is
  // the only recovery. Clearing documentReadyRef is the half that makes it
  // work: handleShouldStartLoad only lets the document's OWN initial load
  // through while that flag is false, so leaving it set would have the new
  // WebView reject its own load and stay just as blank.
  const handleRenderProcessGone = useCallback(() => {
    documentReadyRef.current = false;
    setFrameReady(false);
    reportChatFrameError('render_process_gone', 'Android destroyed the chat WebView renderer; remounting');
    setWebViewGeneration((n) => n + 1);
  }, []);

  // iOS has the same disease under a different name: WKWebView's content
  // process is terminated under memory pressure, preferentially while the
  // WebView sits hidden behind another tab — which is exactly how this screen
  // lives (mounted once, hidden during Files). Found on TestFlight build 32
  // (2026-08-13): open chat, visit Files, return, and the chat is a corpse
  // that tries to reload its baseUrl, which the navigation policy used to
  // bounce to Safari showing the Worker's "Not found". Same recovery as
  // Android, deliberately duplicated rather than shared so each platform's
  // handler stays independently pinned by its tests: clear the ready flag so
  // the fresh document's own load is allowed through, report, remount.
  const handleContentProcessTerminated = useCallback(() => {
    documentReadyRef.current = false;
    setFrameReady(false);
    reportChatFrameError('content_process_terminated', 'iOS terminated the chat WebView content process; remounting');
    // Rebuild NOW only if the chat is on screen. iOS kills the content process
    // preferentially while the tab is hidden, and a WKWebView remounted into a
    // hidden zero-layout pane paints half a page (see the refs above). Hidden
    // kills are deferred to the next tab activation instead.
    if (activeRef.current) {
      setWebViewGeneration((n) => n + 1);
    } else {
      pendingRemountRef.current = true;
    }
  }, []);

  // Recovery that does not depend on iOS delivering the terminate event at
  // all, because nothing proves it always does (mobile Sentry was inert on
  // 2026-08-13, so there was no telemetry to confirm it fired). On each return
  // to the chat tab: first pay any deferred remount; otherwise, if we believe
  // the document is alive, challenge it. The injected line needs no page
  // cooperation beyond the bridge itself, a dead content process simply never
  // answers, and 1.5s later the frame is declared a corpse and rebuilt, now
  // safely on screen. A healthy page answers in milliseconds and nothing
  // happens. Leaving the tab cancels an in-flight verdict.
  // Returning to the chat TAB refreshes the transcript, not just returning to
  // the app. The document already refreshes ambiently every 30s and native
  // already refreshes on foreground, but neither covers "was on Files, came
  // back": a turn that landed from another device (or Telegram) in that window
  // sat invisible until the 30s tick or an app restart, which is what Alex saw
  // comparing his Android and iOS phones. Cheap, and it cannot duplicate
  // anything: refreshHistoryQuietly no-ops while streaming or already in
  // flight, and repaints only when the server list actually differs.
  useEffect(() => {
    if (!active) return;
    deliverToWebView({ type: 'history_refresh' });
  }, [active, deliverToWebView]);

  useEffect(() => {
    if (!active) return undefined;
    if (pendingRemountRef.current) {
      pendingRemountRef.current = false;
      setWebViewGeneration((n) => n + 1);
      return undefined;
    }
    if (!documentReadyRef.current || !webViewRef.current) return undefined;
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    probeTimerRef.current = setTimeout(() => {
      probeTimerRef.current = null;
      documentReadyRef.current = false;
      setFrameReady(false);
      reportChatFrameError('probe_timeout', 'chat WebView did not answer the liveness probe on tab return; remounting');
      setWebViewGeneration((n) => n + 1);
    }, 1500);
    webViewRef.current.injectJavaScript(
      `window.ReactNativeWebView && window.ReactNativeWebView.postMessage('{"type":"pong"}'); true;`,
    );
    return () => {
      if (probeTimerRef.current) {
        clearTimeout(probeTimerRef.current);
        probeTimerRef.current = null;
      }
    };
  }, [active]);

  return (
    <View
      ref={containerRef}
      onLayout={measureKeyboardOverlap}
      style={[styles.container, keyboardOverlap > 0 ? { paddingBottom: 8 + keyboardOverlap } : null]}
      testID="home.chatPanel"
    >
      {/* Recovery is honest about itself. When iOS has killed the chat's engine
          we rebuild it, and for about a second the frame is legitimately empty:
          Alex read that blank as "it crashed and came back" (2026-08-13). It
          had not crashed, it was being rebuilt, and saying so costs nothing.
          Shown only for a REBUILD (generation > 0), never on first load, which
          has its own history-loading state inside the document. */}
      {webViewGeneration > 0 && !frameReady ? (
        <View style={styles.reloadingOverlay} pointerEvents="none" testID="home.chatPanel.reloading">
          <Text style={styles.reloadingText}>Reconnecting your chat…</Text>
        </View>
      ) : null}
      <WebView
        key={webViewGeneration}
        ref={webViewRef}
        testID="home.chatPanel.webview"
        // baseUrl set to the worker origin so the WebView treats inline
        // HTML as coming from that origin. Without this the WebView's
        // implicit origin is `data:` or `about:blank`, and Chrome blocks
        // any fetch to the worker as cross-origin (preflight CORS) — the
        // visible failure was a generic `TypeError: Failed to fetch`.
        // Setting baseUrl makes the request same-origin so CORS is moot.
        source={webViewSource}
        style={styles.webview}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        onRenderProcessGone={handleRenderProcessGone}
        onContentProcessDidTerminate={handleContentProcessTerminated}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="never"
        // Voice mode (pilot): the page calls getUserMedia inside the WebView.
        // The app already holds RECORD_AUDIO; this grants the WebView's own
        // permission request without a second in-page prompt. JS-side prop,
        // so it ships via OTA.
        mediaCapturePermissionGrantType="grant"
        // 2026-07-15 voice-mode bug (Alex: "no sound at all"): Android System
        // WebView defaults mediaPlaybackRequiresUserAction=true, which BLOCKS
        // autoplay of the incoming WebRTC audio track — the mic worked and the
        // model replied, but the reply audio never played. Allow programmatic
        // playback so Barry can actually be heard. JS-side prop, OTA-shippable.
        mediaPlaybackRequiresUserAction={false}
        onMessage={handleMessage}
        onLoadEnd={() => injectInit()}
        startInLoadingState={false}
        showsVerticalScrollIndicator={false}
        keyboardDisplayRequiresUserAction={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        overScrollMode="never"
        bounces={false}
        // Disable the native WebView scroll. With it on, focusing the
        // composer causes Android System WebView to auto-scroll the
        // entire page so the input is centered — which pushes the
        // status-bar above the visible top. Our HTML handles its own
        // scrolling inside `.messages`, so the outer scroll is just
        // friction.
        scrollEnabled={false}
        nestedScrollEnabled={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        textInteractionEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The container hosts the WebView inside a rounded, brand-aligned slab.
  // Padding gives it margin off the surrounding shell on all four sides so
  // the slab reads as a card, not as a screen-edge bleed. The inner
  // WebView has matching radius on all four corners + overflow:hidden so
  // the dark content clips cleanly inside the rounded rectangle. Tokens:
  // warm off-white shell, brand-warm dark slab (lighter than pure black
  // so the chat reads as the same family as the rest of the cream UI),
  // radius=lg (14).
  // Sits over the rebuilding frame. Matches the chat's own warm paper so the
  // recovery reads as a pause rather than a flash of a different surface.
  reloadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFAF7',
  },
  reloadingText: {
    fontSize: 14,
    color: '#6B6B63',
  },
  // 2026-09-27 redesign: the chat is no longer a rounded slab inside the
  // shell. The frame is transparent (the document marks itself html.in-app and
  // drops its own background), so the ambient light painted behind the whole
  // app shows through, and the header and the conversation read as one
  // surface. The bottom padding stays: it is the gap under the composer, and
  // the keyboard overlap is added to it above.
  container: {
    flex: 1,
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 8,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
