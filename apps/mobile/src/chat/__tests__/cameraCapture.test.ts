// Unit tests for captureAndUploadPhotoCore, the dependency-injected core that
// backs captureAndUploadChatPhoto (the chat composer's camera button). Runs
// under tsx via test:ts (node --test --import tsx). The core imports nothing
// native, so these tests inject FAKE camera + upload dependencies (the exact
// seam the production wrapper fills with expo-image-picker + uploadRunnerFile)
// and assert the permission / cancel / capture-and-upload branches.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_PERMISSION_DENIED_MESSAGE,
  CAPTURED_PHOTO_MIME,
  capturedPhotoFileName,
  captureAndUploadPhotoCore,
  uploadCapturedPhotoCore,
  type CaptureAndUploadPhotoDeps,
  type CameraCaptureResult,
  type UploadCapturedPhotoDeps,
} from '../cameraCapture';
import type { RunnerFileUploadResult } from '../../files/runnerFileUpload';

const FIXED_NOW = 1_700_000_000_000;
const VALID_FILE_ID = 'file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// A successful upload result echoing the uploaded photo, shaped like
// uploadRunnerFile's real return value.
function okUpload(overrides: Record<string, unknown> = {}): RunnerFileUploadResult {
  return {
    ok: true,
    file: {
      id: VALID_FILE_ID,
      name: 'photo-1700000000000.jpg',
      relativeName: 'uploads/photo-1700000000000.jpg',
      sizeBytes: 4321,
      modifiedAt: FIXED_NOW,
      mimeType: 'image/jpeg',
      downloadable: true,
      downloadUrl: 'https://api.example.com/api/files/runner/x?token=v1.abc',
      ...overrides,
    },
  };
}

type UploadCall = { name: string; mimeType: string; contentBase64: string };

// Build a deps object with sensible defaults (granted permission, a captured
// photo, a readable file, a successful upload) plus a recording array so each
// test can assert what the core did / did not upload.
function makeDeps(over: Partial<CaptureAndUploadPhotoDeps> = {}): {
  deps: CaptureAndUploadPhotoDeps;
  uploads: UploadCall[];
} {
  const uploads: UploadCall[] = [];
  const deps: CaptureAndUploadPhotoDeps = {
    requestCameraPermission: async () => ({ granted: true }),
    launchCamera: async (): Promise<CameraCaptureResult> => ({
      cancelled: false,
      uri: 'file:///cache/IMG_0007.jpg',
      fileName: 'IMG_0007.jpg',
      mimeType: 'image/jpeg',
    }),
    readAsBase64: async () => 'aGVsbG8=', // "hello"
    upload: async (args) => {
      uploads.push(args);
      return okUpload();
    },
    now: () => FIXED_NOW,
    ...over,
  };
  return { deps, uploads };
}

test('capturedPhotoFileName derives a timestamped .jpg name', () => {
  assert.equal(capturedPhotoFileName(FIXED_NOW), 'photo-1700000000000.jpg');
});

test('permission granted + a captured photo uploads it and returns an uploaded file', async () => {
  const picked: string[] = [];
  const { deps, uploads } = makeDeps();
  const outcome = await captureAndUploadPhotoCore(deps, { onPicked: (n) => picked.push(n) });

  assert.equal(outcome.status, 'uploaded');
  if (outcome.status !== 'uploaded') return; // narrow for TS
  assert.equal(outcome.file.id, VALID_FILE_ID);
  assert.equal(outcome.file.name, 'photo-1700000000000.jpg');
  assert.equal(outcome.file.relativeName, 'uploads/photo-1700000000000.jpg');
  assert.equal(outcome.file.mimeType, 'image/jpeg');
  assert.equal(outcome.file.sizeBytes, 4321);

  // The upload used the derived name + JPEG mime + the read bytes.
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], {
    name: 'photo-1700000000000.jpg',
    mimeType: CAPTURED_PHOTO_MIME,
    contentBase64: 'aGVsbG8=',
  });

  // The "uploading…" chip fired once, before the upload, with the derived name.
  assert.deepEqual(picked, ['photo-1700000000000.jpg']);
});

test('permission denied returns a friendly error and never opens the camera or uploads', async () => {
  const picked: string[] = [];
  let launched = 0;
  const { deps, uploads } = makeDeps({
    requestCameraPermission: async () => ({ granted: false }),
    launchCamera: async () => { launched += 1; return { cancelled: true }; },
  });
  const outcome = await captureAndUploadPhotoCore(deps, { onPicked: (n) => picked.push(n) });

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.equal(outcome.message, CAMERA_PERMISSION_DENIED_MESSAGE);
  assert.match(outcome.message, /Settings/);
  assert.equal(launched, 0, 'must NOT open the camera without permission');
  assert.equal(uploads.length, 0, 'must NOT upload without permission');
  assert.deepEqual(picked, [], 'no chip when permission is denied');
});

test('a cancelled capture returns cancelled and uploads nothing (no error surfaced)', async () => {
  const picked: string[] = [];
  const { deps, uploads } = makeDeps({
    launchCamera: async () => ({ cancelled: true }),
  });
  const outcome = await captureAndUploadPhotoCore(deps, { onPicked: (n) => picked.push(n) });

  assert.equal(outcome.status, 'cancelled');
  assert.equal(uploads.length, 0, 'a cancel must not upload');
  assert.deepEqual(picked, [], 'a cancel must not stage a chip');
});

test('a photo that cannot be read becomes a friendly error (no upload)', async () => {
  const { deps, uploads } = makeDeps({ readAsBase64: async () => null });
  const outcome = await captureAndUploadPhotoCore(deps);
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.message, /couldn't be read/);
  assert.equal(uploads.length, 0, 'a read failure must short-circuit before upload');
});

test('an upload failure propagates the upload error message', async () => {
  const { deps } = makeDeps({
    upload: async (): Promise<RunnerFileUploadResult> => ({
      ok: false,
      error: { reason: 'too_large', message: 'That file is too large to upload. The limit is 25 MB.' },
    }),
  });
  const outcome = await captureAndUploadPhotoCore(deps);
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.message, /25 MB/, 'the 25 MB cap message from the shared upload path must surface');
});

test('a thrown camera error becomes an error outcome, never throwing to the UI', async () => {
  const { deps } = makeDeps({
    launchCamera: async () => { throw new Error('camera busy'); },
  });
  const outcome = await captureAndUploadPhotoCore(deps);
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.message, /camera/i);
});

// --- uploadCapturedPhotoCore: the read+upload tail used by BOTH the live path
// (captureAndUploadPhotoCore delegates to it) and the crash-recovery path
// (getPendingCameraCaptures → uploadCapturedChatPhoto), which uploads a photo
// the OS stashed after killing the app mid-camera. It never re-opens the
// camera or re-checks permission — it's handed an already-captured uri.

// A minimal deps builder for the tail (no permission/launch needed).
function makeTailDeps(over: Partial<UploadCapturedPhotoDeps> = {}): {
  deps: UploadCapturedPhotoDeps;
  uploads: UploadCall[];
} {
  const uploads: UploadCall[] = [];
  const deps: UploadCapturedPhotoDeps = {
    readAsBase64: async () => 'aGVsbG8=',
    upload: async (args) => {
      uploads.push(args);
      return okUpload();
    },
    now: () => FIXED_NOW,
    ...over,
  };
  return { deps, uploads };
}

const RECOVERED_PHOTO = { uri: 'file:///cache/pending/IMG_0009.jpg', fileName: 'IMG_0009.jpg', mimeType: 'image/jpeg' };

test('uploadCapturedPhotoCore uploads an already-captured photo and fires the chip', async () => {
  const picked: string[] = [];
  const { deps, uploads } = makeTailDeps();
  const outcome = await uploadCapturedPhotoCore(deps, RECOVERED_PHOTO, { onPicked: (n) => picked.push(n) });

  assert.equal(outcome.status, 'uploaded');
  if (outcome.status !== 'uploaded') return;
  assert.equal(outcome.file.id, VALID_FILE_ID);
  assert.equal(outcome.file.name, 'photo-1700000000000.jpg');
  // A recovered photo uploads with the SAME derived name + JPEG mime + bytes as
  // a live snap — the whole point of sharing this tail.
  assert.deepEqual(uploads, [{
    name: 'photo-1700000000000.jpg',
    mimeType: CAPTURED_PHOTO_MIME,
    contentBase64: 'aGVsbG8=',
  }]);
  assert.deepEqual(picked, ['photo-1700000000000.jpg']);
});

test('uploadCapturedPhotoCore surfaces a read failure without uploading', async () => {
  const { deps, uploads } = makeTailDeps({ readAsBase64: async () => null });
  const outcome = await uploadCapturedPhotoCore(deps, RECOVERED_PHOTO);
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.message, /couldn't be read/);
  assert.equal(uploads.length, 0, 'a read failure must short-circuit before upload');
});

test('uploadCapturedPhotoCore propagates the 25 MB upload error message', async () => {
  const { deps } = makeTailDeps({
    upload: async (): Promise<RunnerFileUploadResult> => ({
      ok: false,
      error: { reason: 'too_large', message: 'That file is too large to upload. The limit is 25 MB.' },
    }),
  });
  const outcome = await uploadCapturedPhotoCore(deps, RECOVERED_PHOTO);
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.message, /25 MB/, 'the recovery path must honor the same 25 MB cap as the paperclip');
});
