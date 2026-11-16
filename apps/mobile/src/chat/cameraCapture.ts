// Pure, dependency-injected core for the "take a photo with the camera →
// upload it to your coworker" chat flow. This is the camera sibling of the
// paperclip's pickAndUploadChatAttachment (chatAttachmentUpload.ts): it returns
// the SAME ChatAttachmentUploadOutcome shape so the native handler in
// WebViewChatScreen can treat the camera button and the paperclip symmetrically.
//
// It imports nothing native (only `import type`, which is erased at runtime) so
// it can be unit-tested under tsx with fake camera + upload dependencies,
// exactly like runnerFileUpload.ts. The production wiring (real
// expo-image-picker + the real runner upload) lives in chatAttachmentUpload.ts.

import type { ChatAttachmentUploadOutcome } from './chatAttachmentUpload';
import type { RunnerFileUploadResult } from '../files/runnerFileUpload';

// Surfaced verbatim when the user declines the OS camera permission. It points
// them at Settings because a hard "deny / don't ask again" can only be undone
// there, not by re-prompting.
export const CAMERA_PERMISSION_DENIED_MESSAGE =
  'Camera permission is needed to take a photo. You can enable it in Settings.';

// Photos are captured as JPEG (launchCameraAsync's default encoding), so the
// mime is image/jpeg and the derived name carries a .jpg extension.
export const CAPTURED_PHOTO_MIME = 'image/jpeg';

// A minimal, provider-agnostic view of a captured photo. The production wiring
// maps expo-image-picker's ImagePickerResult onto this so the core never
// depends on the native module's exact shape.
export type CameraCaptureResult =
  | { cancelled: true }
  | { cancelled: false; uri: string; fileName?: string | null; mimeType?: string | null };

export type CaptureAndUploadPhotoDeps = {
  // Resolves the OS camera permission; `granted` gates the capture.
  requestCameraPermission: () => Promise<{ granted: boolean }>;
  // Opens the camera and returns the captured photo (or a cancel).
  launchCamera: () => Promise<CameraCaptureResult>;
  // Reads the captured file's bytes as base64 (no `data:` prefix), or null on
  // failure. Production passes readLocalFileAsBase64.
  readAsBase64: (localUri: string) => Promise<string | null>;
  // Uploads the bytes to the runner workspace. Production passes
  // uploadRunnerFile, which enforces the SAME 25 MB cap the paperclip honors.
  upload: (args: { name: string; mimeType: string; contentBase64: string }) => Promise<RunnerFileUploadResult>;
  // Injectable clock so the derived filename is deterministic in tests.
  now?: () => number;
};

// A timestamped name so multiple snaps in one session never collide, and the
// coworker sees a sensible "photo-<ts>.jpg" rather than a raw cache path.
export function capturedPhotoFileName(now: number): string {
  return `photo-${now}.jpg`;
}

// Never throws to the UI: every failure becomes a typed `error` outcome with a
// friendly message; a user cancel (permission ok but they backed out of the
// camera) becomes `cancelled` with nothing surfaced.
export async function captureAndUploadPhotoCore(
  deps: CaptureAndUploadPhotoDeps,
  hooks: { onPicked?: (name: string) => void } = {},
): Promise<ChatAttachmentUploadOutcome> {
  let permission: { granted: boolean };
  try {
    permission = await deps.requestCameraPermission();
  } catch {
    return { status: 'error', message: CAMERA_PERMISSION_DENIED_MESSAGE };
  }
  if (!permission?.granted) {
    return { status: 'error', message: CAMERA_PERMISSION_DENIED_MESSAGE };
  }

  let shot: CameraCaptureResult;
  try {
    shot = await deps.launchCamera();
  } catch {
    return { status: 'error', message: "The camera couldn't be opened. Try again." };
  }
  if (shot.cancelled || !shot.uri) return { status: 'cancelled' };

  return uploadCapturedPhotoCore(deps, shot, hooks);
}

// A photo that has ALREADY been captured (just a local uri), ready to upload.
// The live path narrows CameraCaptureResult to this; the crash-recovery path
// (chatAttachmentUpload.getPendingCameraCaptures) builds it from the OS-stashed
// result.
export type CapturedPhoto = { uri: string; fileName?: string | null; mimeType?: string | null };

// Only the deps the upload tail needs (no camera/permission), so a recovered
// photo can be uploaded without re-opening the camera.
export type UploadCapturedPhotoDeps = Pick<CaptureAndUploadPhotoDeps, 'readAsBase64' | 'upload' | 'now'>;

// The read + upload tail shared by the live capture path (captureAndUploadPhotoCore
// above) and the crash-recovery path. Given an already-captured photo it derives
// the timestamped name, fires the "uploading…" chip, reads the bytes, and uploads
// them through the same runner path + 25 MB cap as the paperclip. Split out so a
// photo recovered after the OS killed the app mid-camera travels the EXACT same
// upload path as a live snap. Never throws: every failure is a typed error outcome.
export async function uploadCapturedPhotoCore(
  deps: UploadCapturedPhotoDeps,
  photo: CapturedPhoto,
  hooks: { onPicked?: (name: string) => void } = {},
): Promise<ChatAttachmentUploadOutcome> {
  const now = (deps.now ?? Date.now)();
  const name = capturedPhotoFileName(now);
  const mimeType = CAPTURED_PHOTO_MIME;

  // Fire the "uploading…" chip immediately, before the (slower) read + upload,
  // mirroring pickAndUploadChatAttachment's onPicked contract.
  hooks.onPicked?.(name);

  const contentBase64 = await deps.readAsBase64(photo.uri);
  if (!contentBase64) {
    return { status: 'error', message: "That photo couldn't be read for upload. Try again." };
  }

  const result = await deps.upload({ name, mimeType, contentBase64 });
  if (!result.ok) return { status: 'error', message: result.error.message };

  const file = result.file;
  return {
    status: 'uploaded',
    file: {
      id: file.id,
      name: file.name,
      relativeName: file.relativeName || file.name,
      mimeType: file.mimeType || mimeType,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : 0,
    },
  };
}
