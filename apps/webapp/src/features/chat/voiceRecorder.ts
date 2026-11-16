// The browser half of the dictation bridge. The chat document owns the mic
// button and posts voice_start / voice_stop; whichever host it is running on
// answers with voice_started, then voice_transcript or voice_error. The phone
// answers with expo-av, so this file is the same contract written against
// MediaRecorder, and it uploads to the same Worker route with the same shape.

import { apiOrigin } from '../../lib/env';
import { getFreshAccessToken } from '../../lib/supabase';

const TRANSCRIBE_PATH = '/api/audio/transcribe';

export type VoiceErrorReason =
  | 'unauthenticated'
  | 'permission_denied'
  | 'recorder_unavailable'
  | 'voice_quota_exhausted'
  | 'transcribe_unavailable'
  | 'transcribe_empty';

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: VoiceErrorReason };

export type VoiceRecording = { blob: Blob; durationSeconds: number };

export type VoiceRecorderHandle = {
  stop: () => Promise<VoiceRecording | null>;
  cancel: () => void;
};

// OpenAI reads the container from the filename, and browsers disagree about
// what MediaRecorder produces: Chrome and Firefox give WebM/Opus, Safari gives
// MP4/AAC. Sending the wrong extension is a 400 from the provider, so pick the
// type up front and carry it through to the upload.
const CANDIDATE_TYPES: Array<{ mimeType: string; filename: string }> = [
  { mimeType: 'audio/webm;codecs=opus', filename: 'voice.webm' },
  { mimeType: 'audio/webm', filename: 'voice.webm' },
  { mimeType: 'audio/mp4', filename: 'voice.mp4' },
  { mimeType: 'audio/ogg;codecs=opus', filename: 'voice.ogg' },
];

function pickRecordingType(): { mimeType: string; filename: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate;
  }
  return null;
}

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export async function startRecording(): Promise<VoiceRecorderHandle | { error: VoiceErrorReason }> {
  if (!canRecord()) return { error: 'recorder_unavailable' };
  const type = pickRecordingType();
  if (!type) return { error: 'recorder_unavailable' };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // A blocked mic and an absent mic both land here, and the difference
    // matters to the reader: one is a setting they can change.
    const name = (err as { name?: string } | null)?.name ?? '';
    return { error: name === 'NotAllowedError' || name === 'SecurityError' ? 'permission_denied' : 'recorder_unavailable' };
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: type.mimeType });
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    return { error: 'recorder_unavailable' };
  }

  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const startedAt = Date.now();
  recorder.start();

  function release() {
    stream.getTracks().forEach((track) => track.stop());
  }

  return {
    stop() {
      return new Promise<VoiceRecording | null>((resolve) => {
        if (recorder.state === 'inactive') {
          release();
          resolve(null);
          return;
        }
        recorder.addEventListener(
          'stop',
          () => {
            release();
            const blob = new Blob(chunks, { type: type.mimeType });
            if (!blob.size) {
              resolve(null);
              return;
            }
            resolve({ blob, durationSeconds: Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)) });
          },
          { once: true },
        );
        recorder.stop();
      });
    },
    cancel() {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // Already torn down; the only thing that still matters is the mic.
      }
      release();
    },
  };
}

export async function transcribeRecording(recording: VoiceRecording): Promise<TranscribeResult> {
  // Raw supabase-js, so this really can reject. A rejection here escapes
  // onVoiceStop, which is called as a bare void, and the composer is left on
  // its recording state with no transcript and no error to clear it.
  let token: string | null;
  try {
    token = await getFreshAccessToken();
  } catch {
    token = null;
  }
  if (!token) return { ok: false, error: 'unauthenticated' };

  const base = (apiOrigin || window.location.origin).replace(/\/+$/, '');
  const extension = recording.blob.type.includes('mp4') ? 'mp4' : recording.blob.type.includes('ogg') ? 'ogg' : 'webm';

  const form = new FormData();
  form.append('audio', recording.blob, `voice.${extension}`);
  form.append('duration_seconds', String(Math.max(1, Math.ceil(recording.durationSeconds))));

  try {
    const response = await fetch(`${base}${TRANSCRIBE_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      body: form,
    });
    if (response.status === 401) return { ok: false, error: 'unauthenticated' };
    if (response.status === 402) return { ok: false, error: 'voice_quota_exhausted' };
    // The recording itself could not be read: "didn't catch that", not "try later".
    if (response.status === 422) return { ok: false, error: 'transcribe_empty' };
    if (!response.ok) return { ok: false, error: 'transcribe_unavailable' };
    const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return { ok: false, error: 'transcribe_empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'transcribe_unavailable' };
  }
}
