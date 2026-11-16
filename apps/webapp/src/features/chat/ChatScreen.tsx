import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LIVE_TALK_HOST, MODEL_NAME_PUBLIC, isSubscriptionEntitled, type SidekickProductSnapshot } from '@sidekick/shared';
import { apiOrigin } from '../../lib/env';
import { apiFetch } from '../../lib/api';
import { getFreshAccessToken } from '../../lib/supabase';
import type { WebAuthUser } from '../auth/useAuth';
import { useProductStateContext } from '../state/productStateContext';
import { uploadRunnerFile } from '../files/filesApi';
import { takeChatCommand } from './pendingChatCommand';
import { canRecord, startRecording, transcribeRecording, type VoiceRecorderHandle } from './voiceRecorder';

// The chat surface is the same document the Android app runs, served from our
// own origin and synced at build time by scripts/sync-chat-webview.mjs. This
// component is the web half of the bridge the app's native code provides, so a
// chat fix lands on both surfaces from one edit to the shared HTML.

const TOKEN_REFRESH_MS = 45_000;
// Same ceiling the phone applies: a mic left live can't record, or bill voice
// seconds, forever. The Worker meters by duration on top of this.
const VOICE_MAX_RECORDING_MS = 120_000;
// Not /chat: Firebase Hosting resolves static files before the SPA rewrite, so a
// directory named chat/ would answer the app's own /chat route with the bare
// document. The explicit filename is the one form both the dev server and
// Hosting resolve; Hosting's cleanUrls turns it into one redirect per load.
const CHAT_DOCUMENT = '/chat-frame/index.html';

type NativeMessage = { type?: unknown; [key: string]: unknown };

function chatApiBaseUrl(): string {
  // The page treats an empty apiBaseUrl as "not initialised", and in dev the
  // Vite proxy serves /api from our own origin, so name that origin explicitly.
  return apiOrigin || window.location.origin;
}

export function ChatScreen({ user }: { user: WebAuthUser }) {
  const { snapshot, refresh: onRefreshState } = useProductStateContext();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const filePicker = useRef<HTMLInputElement>(null);
  const cameraPicker = useRef<HTMLInputElement>(null);
  const voiceHandle = useRef<VoiceRecorderHandle | null>(null);
  const voiceTimeout = useRef<number | null>(null);
  // startRecording asks for the mic, so on a first press it can sit on the
  // browser's permission prompt for seconds. The chat document lets the reader
  // press stop during that window, and a stop that arrives before the handle
  // exists has nothing to cancel unless the in-flight start is told to throw
  // its recorder away. Same guard the phone carries in WebViewChatScreen.
  const voiceStarting = useRef(false);
  const voiceCancelled = useRef(false);

  const send = useCallback((payload: Record<string, unknown>) => {
    const target = frame.current?.contentWindow as (Window & { __sidekickReceive?: (raw: string) => void }) | null;
    if (!target) return;
    const serialized = JSON.stringify(payload);
    // Same-origin, so the direct receiver the app injects is available. The
    // postMessage fallback keeps working if the document has not finished
    // evaluating its script tag yet.
    if (typeof target.__sidekickReceive === 'function') target.__sidekickReceive(serialized);
    else target.postMessage(serialized, window.location.origin);
  }, []);

  const sendInit = useCallback(async () => {
    // init_failed is what stops the chat sitting there uninitialised, and a
    // throw out of this raw supabase-js call would skip straight past it. The
    // reader would be left with a composer that never sends and no reason why.
    let token: string | null;
    try {
      token = await getFreshAccessToken();
    } catch {
      token = null;
    }
    if (!token) {
      send({ type: 'init_failed', reason: 'no_token' });
      return;
    }
    send({
      type: 'init',
      apiBaseUrl: chatApiBaseUrl(),
      accessToken: token,
      userId: user.id,
      agentName: snapshot?.profile?.agentName ?? 'Nova',
      hasActiveSubscription: snapshot ? isEntitled(snapshot) : true,
      hardLimited: snapshot?.usage.hardLimited ?? false,
      nextResetAtIso: snapshot?.subscription?.currentPeriodEnd ?? null,
      // The Telegram connect card is still native-only, so it ships dark here.
      // Voice is not: live Talk is WebRTC the browser runs itself, and
      // dictation is answered below, so both controls work and the toolbar
      // guide shows the same four rows the phone shows. voiceCapture is
      // reported honestly, because a host that cannot record but claims it can
      // strands the composer on "Listening…" forever.
      pilotFeatures: { telegramConnect: false, voiceMode: true, voiceCapture: canRecord() },
      // Named only in the Talk beta note (and the FAQ), from one constant.
      modelName: MODEL_NAME_PUBLIC,
      // Live Talk's voice Worker (browsers cancel echo, so the web gets it too).
      liveTalkHost: LIVE_TALK_HOST,
    });
  }, [send, snapshot, user.id]);

  const playQueuedCommand = useCallback(() => {
    const queued = takeChatCommand();
    if (!queued) return;
    if (queued.kind === 'fresh') send({ type: 'start_fresh_chat' });
    else send({ type: 'menu_command', command: queued.command, mode: queued.mode });
  }, [send]);

  // Arriving from Commands or Skills. The frame stays mounted for the session,
  // so coming back to chat reloads nothing and history_loaded never fires again;
  // without this the command a reader just tapped would land on a screen that
  // does nothing. Taking from the queue is what spends it, so the two drain
  // points cannot both play the same command.
  useEffect(() => {
    if (location.pathname !== '/chat' || !ready.current) return;
    playQueuedCommand();
  }, [location.pathname, playQueuedCommand]);

  const clearVoiceTimeout = useCallback(() => {
    if (voiceTimeout.current !== null) {
      window.clearTimeout(voiceTimeout.current);
      voiceTimeout.current = null;
    }
  }, []);

  const onVoiceStop = useCallback(async () => {
    clearVoiceTimeout();
    const handle = voiceHandle.current;
    voiceHandle.current = null;
    if (!handle) {
      if (voiceStarting.current) {
        // The mic is still opening. Left alone it would go live moments later
        // and run the full two minute timeout, then splice a transcript of
        // whatever it overheard into the composer of a reader who had already
        // stopped. An empty transcript puts the composer back to idle with
        // nothing added, which is what "you stopped before it started" means.
        voiceCancelled.current = true;
        send({ type: 'voice_transcript', text: '' });
      }
      return;
    }

    const recording = await handle.stop();
    if (!recording) {
      send({ type: 'voice_error', reason: 'transcribe_empty' });
      return;
    }
    const result = await transcribeRecording(recording);
    if (result.ok) send({ type: 'voice_transcript', text: result.text });
    else send({ type: 'voice_error', reason: result.error });
  }, [clearVoiceTimeout, send]);

  const onVoiceStart = useCallback(async () => {
    // A second start while one is live would leak the first mic stream.
    if (voiceHandle.current || voiceStarting.current) return;
    voiceStarting.current = true;
    voiceCancelled.current = false;
    const started = await startRecording();
    voiceStarting.current = false;
    const cancelled = voiceCancelled.current;
    voiceCancelled.current = false;
    if ('error' in started) {
      if (!cancelled) send({ type: 'voice_error', reason: started.error });
      return;
    }
    if (cancelled) {
      // Stop or leaving the screen landed while the mic was opening. Release it
      // and stay quiet: whoever cancelled has already been answered.
      started.cancel();
      return;
    }
    voiceHandle.current = started;
    send({ type: 'voice_started' });
    voiceTimeout.current = window.setTimeout(() => void onVoiceStop(), VOICE_MAX_RECORDING_MS);
  }, [onVoiceStop, send]);

  const releaseMicrophone = useCallback(() => {
    clearVoiceTimeout();
    // A start still waiting on the permission prompt holds no handle yet, so
    // without this the mic would open after the reader has gone and the browser
    // would keep showing the recording indicator.
    if (voiceStarting.current) voiceCancelled.current = true;
    const handle = voiceHandle.current;
    voiceHandle.current = null;
    if (!handle) return;
    handle.cancel();
    // The composer inside the document is still on its recording state, and the
    // reader is not looking at it. An empty transcript is the settled way to put
    // it back to idle with nothing added; the alternative is a chat that says it
    // is listening when the microphone has already been closed.
    send({ type: 'voice_transcript', text: '' });
  }, [clearVoiceTimeout, send]);

  // Leaving the chat mid-recording has to release the microphone, or the browser
  // keeps showing the recording indicator on a page nobody is talking to. This
  // hangs off the route rather than off unmount alone, because App holds this
  // surface mounted behind every other screen so a reply in flight survives a
  // trip to Files, which means unmount never fires while the app is running. The
  // recording used to keep going, run the full two minute ceiling, and then
  // splice a transcript of whatever the room had said into a composer the reader
  // had walked away from.
  useEffect(() => {
    if (location.pathname === '/chat') return;
    releaseMicrophone();
  }, [location.pathname, releaseMicrophone]);

  useEffect(() => {
    return () => releaseMicrophone();
  }, [releaseMicrophone]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { delegentChat?: boolean; payload?: unknown } | null;
      if (!data || data.delegentChat !== true || typeof data.payload !== 'string') return;

      let message: NativeMessage;
      try {
        message = JSON.parse(data.payload) as NativeMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case 'store_review_ready':
          // Native-only background signal, no web control or reply is waiting.
          // Never consume the account claim from the browser.
          break;
        case 'ready':
          ready.current = true;
          void sendInit();
          break;
        case 'history_loaded':
          // Only now is it safe to play a command queued on Commands or Skills:
          // the document has finished replacing its message list.
          playQueuedCommand();
          break;
        case 'open_file': {
          // Carry the path across. Without it the reader who tapped one named
          // file lands on the whole list and has to find it again.
          const path = typeof message.path === 'string' ? message.path : '';
          navigate(path ? `/files?focus=${encodeURIComponent(path)}` : '/files');
          break;
        }
        case 'open_billing':
          navigate('/plan');
          break;
        case 'pick_attachment':
          filePicker.current?.click();
          break;
        case 'pick_camera':
          cameraPicker.current?.click();
          break;
        case 'voice_start':
          void onVoiceStart();
          break;
        case 'voice_stop':
          void onVoiceStop();
          break;
        case 'keep_awake':
          // Live Talk asks to keep the screen on. The frame's own wake lock
          // covers a browser; nothing more to do on the desk.
          break;
        case 'webview_error': {
          // An exception raised inside the frame never surfaces in this window,
          // so the frame hands it out and this is the only place it can land.
          // Long token-shaped runs go first: a parse failure on the init message
          // can quote the access token it choked on.
          const stage = typeof message.stage === 'string' ? message.stage : 'unknown';
          const detail = (typeof message.message === 'string' ? message.message : '')
            .replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]')
            .slice(0, 500);
          console.error(`[chat-frame] ${stage}: ${detail}`);
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate, onVoiceStart, onVoiceStop, playQueuedCommand, send, sendInit]);

  // The runner scales to zero, so without this the first message of a session
  // waits out the whole machine boot. Poking it early means the box is already
  // coming up while the reader is still typing. Best effort: the answer is never
  // read and a failure changes nothing.
  const entitled = snapshot ? isEntitled(snapshot) : false;
  useEffect(() => {
    if (!entitled) return;
    const warm = () => void apiFetch('/api/chat/warm', { method: 'POST', body: {} });
    warm();
    // The phone warms again every time the app returns to the foreground. This is
    // the browser's version of that moment. Without it, a reader who left the tab
    // open for an hour came back to a box that had scaled to zero in the meantime
    // and waited out the whole cold boot on their next message, which is the exact
    // latency this is here to remove.
    const onVisible = () => {
      if (document.visibilityState === 'visible') warm();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [entitled]);

  // A token that expires mid-conversation presents as a silent failure to send,
  // so push a fresh one on the same cadence the app uses.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!ready.current) return;
      void getFreshAccessToken()
        .then((token) => {
          if (token) send({ type: 'token_refresh', accessToken: token });
        })
        // One failed refresh is not worth saying anything about: the interval
        // comes round again in forty five seconds. Swallowing it keeps a raw
        // supabase-js rejection from surfacing as an unhandled error.
        .catch(() => undefined);
    }, TOKEN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [send]);

  // Plan and quota changes made on another screen have to reach the composer,
  // which owns its own banner state.
  useEffect(() => {
    if (!ready.current || !snapshot) return;
    send({
      type: 'quota_update',
      hasActiveSubscription: isEntitled(snapshot),
      hardLimited: snapshot.usage.hardLimited,
      nextResetAtIso: snapshot.subscription?.currentPeriodEnd ?? null,
    });
  }, [send, snapshot]);

  async function onPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const localId = `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    send({ type: 'attachment_uploading', localId, name: file.name });

    const result = await uploadRunnerFile(file);
    if (!result.ok) {
      // The chat document drops the chip and writes the reason into the
      // conversation, next to the attempt it belongs to, which is where the
      // reader is looking and how the phone reports this. A second copy pinned
      // above the frame said the same sentence twice and had nothing to press,
      // so one failed upload left a red bar over the chat for the rest of the
      // session, long after it had stopped describing anything on screen.
      send({ type: 'attachment_error', localId, message: result.message });
      return;
    }

    send({
      type: 'attachment_added',
      localId,
      id: result.file.id,
      name: result.file.name,
      relativeName: result.file.relativeName ?? result.file.name,
      mimeType: result.file.mimeType ?? file.type ?? '',
      sizeBytes: result.file.sizeBytes ?? file.size,
    });
    onRefreshState();
  }

  return (
    <div className="flex h-full flex-col">
      <iframe
        ref={frame}
        className="chat-frame flex-1"
        src={CHAT_DOCUMENT}
        title="Chat with your coworker"
        allow="microphone; clipboard-write"
      />
      <input ref={filePicker} type="file" className="hidden" onChange={onPicked} />
      <input ref={cameraPicker} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPicked} />
    </div>
  );
}

function isEntitled(snapshot: SidekickProductSnapshot): boolean {
  return isSubscriptionEntitled(snapshot.subscription);
}
