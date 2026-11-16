// Shared "pick a file → read its bytes → upload to the coworker" flow.
//
// This is the ONE place the app turns a user-picked file into a real file in
// the runner's workspace (POST /api/files/runner → the runner stores it under
// `uploads/`, where the agent's file/vision tools can read it). Both the Files
// tab upload button (App.tsx) and the chat paperclip (WebViewChatScreen) use
// this so the base64 read + upload contract has a single source of truth.
//
// The base64 reader lived inline in App.tsx until 2026-06-05; it moved here
// when the chat paperclip was restored (the WebView chat had shipped without
// any attachment affordance — the legacy native HomeChatPanel kept its
// paperclip but is no longer the rendered surface).

import { pickChatAttachment, type AttachmentPickerKind } from './attachmentPicker';
import { uploadRunnerFile } from '../files/mobileRunnerFiles';
import { captureAndUploadPhotoCore, uploadCapturedPhotoCore, type CapturedPhoto } from './cameraCapture';

export type ChatAttachmentUploadOutcome =
  | { status: 'cancelled' }
  | {
      status: 'uploaded';
      file: { id: string; name: string; relativeName: string; mimeType: string; sizeBytes: number };
    }
  | { status: 'error'; message: string };

// Read a picked file's bytes off its local cache URI and return them as a
// base64 string (no `data:` prefix). expo-document-picker copies the
// selection into the app cache with copyToCacheDirectory:true, so the URI
// is a readable file://. We prefer expo-file-system's readAsStringAsync
// when it's exposed, fall back to the SDK 55 File().base64() API, and as a
// last resort fetch the URI into a Blob and base64-encode it via
// FileReader. Returns null on any failure so the caller surfaces a single
// honest "couldn't read" error instead of a raw exception.
export async function readLocalFileAsBase64(localUri: string): Promise<string | null> {
  try {
    const fs = (await import('expo-file-system')) as unknown as {
      readAsStringAsync?: (uri: string, opts?: { encoding?: string }) => Promise<string>;
      EncodingType?: { Base64?: string };
      File?: new (uri: string) => { base64: () => Promise<string> };
    };
    if (typeof fs.readAsStringAsync === 'function') {
      const encoding = fs.EncodingType?.Base64 ?? 'base64';
      const result = await fs.readAsStringAsync(localUri, { encoding });
      if (typeof result === 'string' && result.length > 0) return stripBase64DataPrefix(result);
    }
    if (typeof fs.File === 'function') {
      const result = await new fs.File(localUri).base64();
      if (typeof result === 'string' && result.length > 0) return stripBase64DataPrefix(result);
    }
  } catch {
    // Fall through to the fetch/FileReader path below.
  }

  try {
    const response = await fetch(localUri);
    if (!response.ok) return null;
    const blob = await response.blob();
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.readAsDataURL(blob);
    });
    if (!dataUrl) return null;
    const stripped = stripBase64DataPrefix(dataUrl);
    return stripped.length > 0 ? stripped : null;
  } catch {
    return null;
  }
}

// FileReader.readAsDataURL yields "data:<mime>;base64,<payload>"; the proxy
// wants just the payload. readAsStringAsync already returns raw base64, but
// strip defensively in case a platform prepends the prefix.
export function stripBase64DataPrefix(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}

// Pick a file, read it, and upload it to the coworker's workspace. `onPicked`
// fires after a successful pick but BEFORE the (potentially slow) read+upload,
// so the caller can show a pending/"uploading…" chip immediately. Never throws
// to the UI — every failure becomes a typed `error` outcome with a friendly
// message; a user cancel becomes `cancelled` (no error surfaced).
export async function pickAndUploadChatAttachment(
  kind: AttachmentPickerKind = 'any',
  hooks: { onPicked?: (name: string) => void } = {},
): Promise<ChatAttachmentUploadOutcome> {
  const picked = await pickChatAttachment(kind);
  if (picked.status === 'cancelled') return { status: 'cancelled' };
  if (picked.status === 'too-large') return { status: 'error', message: 'That file is over the 25 MB limit.' };
  if (picked.status === 'unsupported') return { status: 'error', message: "Attachments aren't available on this build yet." };
  if (picked.status === 'error') {
    return { status: 'error', message: picked.message || "That file couldn't be picked. Try a different one." };
  }

  hooks.onPicked?.(picked.attachment.name);

  const contentBase64 = await readLocalFileAsBase64(picked.localUri);
  if (!contentBase64) {
    return { status: 'error', message: "That file couldn't be read for upload. Try a different file." };
  }

  const result = await uploadRunnerFile({
    name: picked.attachment.name,
    mimeType: picked.attachment.mimeType,
    contentBase64,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  const file = result.file;
  return {
    status: 'uploaded',
    file: {
      id: file.id,
      name: file.name,
      relativeName: file.relativeName || file.name,
      mimeType: file.mimeType || picked.attachment.mimeType,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : picked.attachment.sizeBytes,
    },
  };
}

// Camera → take a photo → upload it to the coworker's workspace. The camera
// sibling of pickAndUploadChatAttachment: it returns the SAME
// ChatAttachmentUploadOutcome so WebViewChatScreen can treat the camera button
// and the paperclip symmetrically (same uploading / added / error chips). The
// real orchestration lives in captureAndUploadPhotoCore (dependency-injected,
// unit-tested); this wrapper supplies the native dependencies.
//
// expo-image-picker is loaded via a dynamic import so a build that shipped
// without the native module degrades to a friendly error instead of a hard
// crash. The 25 MB size cap is enforced inside uploadRunnerFile, exactly like
// the paperclip path, so a huge photo is refused with the same honest message.
export async function captureAndUploadChatPhoto(
  hooks: { onPicked?: (name: string) => void } = {},
): Promise<ChatAttachmentUploadOutcome> {
  let ImagePicker: typeof import('expo-image-picker');
  try {
    ImagePicker = await import('expo-image-picker');
  } catch {
    return { status: 'error', message: "The camera isn't available on this build yet." };
  }

  return captureAndUploadPhotoCore(
    {
      requestCameraPermission: async () => {
        const res = await ImagePicker.requestCameraPermissionsAsync();
        return { granted: res?.granted === true || res?.status === 'granted' };
      },
      launchCamera: async () => {
        const res = await ImagePicker.launchCameraAsync({
          // Only still images; quality 0.7 keeps the JPEG well under the 25 MB
          // upload cap while staying legible for the agent's vision tools.
          mediaTypes: ['images'],
          quality: 0.7,
        });
        if (res.canceled) return { cancelled: true };
        const asset = res.assets?.[0];
        if (!asset?.uri) return { cancelled: true };
        return {
          cancelled: false,
          uri: asset.uri,
          fileName: asset.fileName ?? null,
          mimeType: asset.mimeType ?? null,
        };
      },
      readAsBase64: readLocalFileAsBase64,
      upload: (args) => uploadRunnerFile(args),
    },
    hooks,
  );
}

// Recover a photo captured while Android killed the app mid-camera. On a
// low-RAM device the OS can destroy MainActivity while the camera activity is
// foreground; when it does, the launchCameraAsync promise captureAndUploadChatPhoto
// was awaiting is gone with the old JS context, so the photo is silently lost on
// return. expo-image-picker stashes that result and replays it exactly once via
// getPendingResultAsync. This returns the recovered photo as a raw CapturedPhoto
// (or [] when nothing is pending) so the caller can stage it through the SAME
// uploadCapturedChatPhoto path a live capture uses, under its own fresh localId +
// chips. getPendingResultAsync resolves to a SINGLE result (not an array) on
// SDK 55: a success (canceled:false + assets), a cancel (canceled:true), or an
// error object (code/message, no assets) — only a real capture with an asset uri
// is worth recovering. A cancel/error/absent-module is dropped silently: the
// original localId is long gone, so surfacing a stray error on app open would
// only confuse. Never throws.
export async function getPendingCameraCaptures(): Promise<CapturedPhoto[]> {
  // CRITICAL: the ENTIRE body must stay inside one try/catch. Expo binds a native
  // module lazily on FIRST PROPERTY ACCESS, so `ImagePicker.getPendingResultAsync`
  // (not just the `import`) throws "Cannot find native module 'ExponentImagePicker'"
  // on a build that shipped without expo-image-picker. An earlier version guarded
  // only the import and left that access outside the try, which crashed the app on
  // launch (this recovery runs automatically on chat open) for older builds that
  // received the camera JS over OTA. 2026-07-19 incident.
  try {
    const ImagePicker = await import('expo-image-picker');
    if (typeof ImagePicker.getPendingResultAsync !== 'function') return [];
    const pending = await ImagePicker.getPendingResultAsync();
    if (!pending || !('canceled' in pending) || pending.canceled) return [];
    const asset = pending.assets?.[0];
    if (!asset?.uri) return [];
    return [{ uri: asset.uri, fileName: asset.fileName ?? null, mimeType: asset.mimeType ?? null }];
  } catch {
    // Absent native module / dev build / any failure: no recovered photo, no crash.
    return [];
  }
}

// Upload an already-captured photo — the crash-recovery sibling of
// captureAndUploadChatPhoto (no permission prompt, no launchCamera; just read +
// upload). Fills uploadCapturedPhotoCore's DI seam with the real base64 reader +
// runner upload, so a photo recovered by getPendingCameraCaptures travels the
// exact same runner path — and the same 25 MB cap — as one taken live.
export async function uploadCapturedChatPhoto(
  photo: CapturedPhoto,
  hooks: { onPicked?: (name: string) => void } = {},
): Promise<ChatAttachmentUploadOutcome> {
  return uploadCapturedPhotoCore(
    { readAsBase64: readLocalFileAsBase64, upload: (args) => uploadRunnerFile(args) },
    photo,
    hooks,
  );
}
