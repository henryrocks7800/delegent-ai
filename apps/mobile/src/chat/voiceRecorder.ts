// v1.2.8 DN6, in-app voice recorder + transcription client.
//
// Tap-to-record flow:
//   1. startRecording(), asks the user for mic permission once, then
//      begins capturing MPEG-4 audio. Returns a handle the UI uses for
//      "stop" actions.
//   2. stopRecording(handle), closes the recording, returns a URI on
//      the device sandbox.
//   3. transcribeRecording(uri), uploads the audio to the Worker
//      `/api/audio/transcribe` route, which proxies to OpenAI Whisper
//      and returns the transcript. The Worker holds the OpenAI key
//      (operator runs `wrangler secret put OPENAI_API_KEY --env
//      production` once); mobile never sees provider secrets.

// Type-only: erased at compile time, so importing it costs nothing at runtime.
import type { Audio as AudioTypes } from 'expo-av';

import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { getFreshMobileAccessToken, mobileSupabase } from '../auth/supabaseClient';
import { normalizePublicApiBaseUrl } from '../billing/mobileCheckout';

// expo-av is loaded LAZILY, at first recording attempt, not at module import.
// Why: expo-av's native iOS module no longer compiles against the current
// ExpoModulesCore (EAS build 9b6e4bfa, 2026-08-04: 'EXEventEmitter.h' file not
// found), so the iOS build excludes the pod entirely (package.json
// expo.autolinking.apple.exclude) until the proper expo-audio migration, the
// same swap the July iOS fork made and documented as deviation D-11. A
// top-level import would crash iOS at app startup for a feature the user may
// never touch; the lazy load turns it into the recorder's existing
// 'recorder_unavailable' answer instead. Android behaviour is unchanged: same
// module, loaded a moment later.
function loadAudio(): typeof AudioTypes | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('expo-av') as { Audio: typeof AudioTypes }).Audio;
  } catch {
    return null;
  }
}

declare const process: { env: Record<string, string | undefined> };

const expoApiBase =
  generatedExpoPublicEnv.EXPO_PUBLIC_SIDEKICK_API_BASE_URL ||
  process.env.EXPO_PUBLIC_SIDEKICK_API_BASE_URL;

const TRANSCRIBE_PATH = '/api/audio/transcribe';

export type VoiceRecorderHandle = AudioTypes.Recording;

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: 'unauthenticated' | 'permission_denied' | 'voice_quota_exhausted' | 'transcribe_unavailable' | 'transcribe_empty' };

export async function startRecording(): Promise<VoiceRecorderHandle | { error: 'permission_denied' | 'recorder_unavailable' }> {
  const Audio = loadAudio();
  if (!Audio) return { error: 'recorder_unavailable' };
  try {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) return { error: 'permission_denied' };
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await recording.startAsync();
    return recording;
  } catch {
    return { error: 'recorder_unavailable' };
  }
}

export async function stopRecording(handle: VoiceRecorderHandle): Promise<{ uri: string; durationSeconds: number } | null> {
  try {
    const status = await handle.getStatusAsync().catch(() => null);
    await handle.stopAndUnloadAsync();
    const uri = handle.getURI();
    if (!uri) return null;
    const durationMillis = typeof status?.durationMillis === 'number' ? status.durationMillis : 0;
    return { uri, durationSeconds: Math.max(1, Math.ceil(durationMillis / 1000)) };
  } catch {
    return null;
  }
}

export async function transcribeRecording(uri: string, durationSeconds: number): Promise<TranscribeResult> {
  const apiBase = normalizePublicApiBaseUrl(expoApiBase);
  if (!apiBase) return { ok: false, error: 'transcribe_unavailable' };

  const token = await getFreshMobileAccessToken(mobileSupabase);
  if (!token) return { ok: false, error: 'unauthenticated' };

  // React Native's fetch supports `file://` URIs as multipart parts via
  // the `{ uri, name, type }` shape. Whisper expects a known audio
  // extension so we tag it as audio/m4a (expo-av's HIGH_QUALITY preset
  // writes an AAC-in-MP4 container on Android).
  const form = new FormData();
  form.append('audio', {
    uri,
    name: 'voice.m4a',
    type: 'audio/m4a',
    // FormData typing in RN is loose; cast is intentional.
  } as unknown as Blob);
  form.append('duration_seconds', String(Math.max(1, Math.ceil(durationSeconds))));

  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, '')}${TRANSCRIBE_PATH}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
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
