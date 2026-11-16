// Paperclip attachment picker, wraps expo-document-picker behind a
// narrow, testable API.
//
// Safety rules baked in:
//   * Strip absolute file paths from the value passed to the assistant
//     UI (only the chosen name + size + mime survive).
//   * Cap file size at 25 MB, the chat composer rejects bigger.
//   * Only accept a whitelist of mime types we know how to surface to
//     the runner sanely (text, JSON, CSV, MD, common images, PDF).
//   * Generate a fresh client-side id so attachments are correlatable
//     in the message metadata without leaking the local path.
//
// [#2 / #7] For small TEXT-like attachments we now read the file body
// from the local cache URI on pick and surface it as `inlineContent`.
// HomeChatPanel.handleSend prepends that content to the chat
// instruction before dispatching, so the runner actually sees the
// file's words. Binary attachments and oversized text files still
// fall back to metadata-only (the previous MVP behaviour) — those
// will need a real upload path later.

import type { ChatAttachment } from './chatClient';

export type AttachmentPickResult =
  | { status: 'picked'; attachment: ChatAttachment; localUri: string; inlineContent: string | null }
  | { status: 'cancelled' }
  | { status: 'too-large' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

// Max number of UTF-8 bytes we will inline into a chat instruction.
// Anything larger keeps the chip but won't be read by the agent until
// the proper upload path lands. 64 KB is enough for a typical
// markdown / CSV / receipt-text payload while leaving room for the
// surrounding instruction inside the worker's CHAT_MESSAGE_MAX_CHARS.
export const ATTACHMENT_INLINE_MAX_BYTES = 64 * 1024;
const INLINEABLE_MIME_PREFIXES: readonly string[] = ['text/'];
const INLINEABLE_MIME_EXACT: readonly string[] = [
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
];

function isInlineableMime(mime: string): boolean {
  if (INLINEABLE_MIME_EXACT.includes(mime)) return true;
  return INLINEABLE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

async function readSmallTextFile(localUri: string): Promise<string | null> {
  // Android allows fetch() on file:// URIs when the file lives in the
  // app's own cache (expo-document-picker copies into cache when
  // copyToCacheDirectory is true). We bound the read with an
  // AbortController on a small timeout so a hostile content-resolver
  // URI can't hang the composer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(localUri, { signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 25 MB matches the deployed Worker + runner contract (MAX_UPLOAD_BYTES on
// both sides) and the Files-tab cap (MOBILE_RUNNER_UPLOAD_MAX_BYTES). It is
// also the practical ceiling: the file crosses the Worker as base64 inside a
// JSON body, so a 25 MB file already peaks near ~90 MB of the Worker's 128 MB
// isolate memory. Raising further needs a streaming transport, not a constant.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME_PREFIXES: readonly string[] = [
  'text/',
  'image/',
  'application/json',
  'application/pdf',
  'application/zip',
];
const ALLOWED_MIME_EXACT: readonly string[] = [
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

function isMimeAllowed(mime: string): boolean {
  if (ALLOWED_MIME_EXACT.includes(mime)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function freshAttachmentId(): string {
  // 16 random hex chars, collision-safe within a single user's queue.
  const random = (globalThis.crypto?.getRandomValues?.(new Uint8Array(8)) ?? new Uint8Array(8));
  if (!random[0] && !random[7]) {
    // Fallback when crypto.getRandomValues isn't available (very rare on
    // React Native; covers test environments). Date.now() + Math.random
    // is good enough for an id that's never used as a security token.
    return 'att_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  }
  return 'att_' + Array.from(random).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CHAT-EASY-05: the attachment menu wants distinct entry points for
// general files vs images. `pickChatAttachment` keeps the existing
// generic behaviour (any allowed MIME) so callers that haven't moved
// to the menu still work. `pickImageAttachment` narrows the picker
// `type` filter to images, which Expo's document picker resolves to
// an image-only system surface on supported platforms.
export type AttachmentPickerKind = 'any' | 'image';

export async function pickChatAttachment(
  kind: AttachmentPickerKind = 'any',
): Promise<AttachmentPickResult> {
  let docPicker: typeof import('expo-document-picker');
  try {
    docPicker = await import('expo-document-picker');
  } catch {
    return { status: 'unsupported' };
  }

  const type = kind === 'image' ? ['image/*'] : '*/*';
  let result: Awaited<ReturnType<typeof docPicker.getDocumentAsync>>;
  try {
    result = await docPicker.getDocumentAsync({
      type,
      multiple: false,
      copyToCacheDirectory: true,
    });
  } catch (err) {
    return { status: 'error', message: (err as Error)?.message ?? 'Picker failed.' };
  }

  if (result.canceled) return { status: 'cancelled' };
  const asset = result.assets?.[0];
  if (!asset) return { status: 'cancelled' };

  const sizeBytes = typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : 0;
  if (sizeBytes > MAX_BYTES) return { status: 'too-large' };

  const mimeType = typeof asset.mimeType === 'string' && asset.mimeType.trim()
    ? asset.mimeType.trim()
    : 'application/octet-stream';
  if (!isMimeAllowed(mimeType)) {
    return { status: 'error', message: "That file type isn't supported yet." };
  }

  const name = typeof asset.name === 'string' && asset.name.trim()
    ? asset.name.trim().slice(0, 240)
    : 'attachment';

  // Read the file body for small text-like attachments so the chat
  // instruction can inline it. Large or binary files keep the chip
  // but won't be readable by the agent until the upload path lands.
  let inlineContent: string | null = null;
  if (
    isInlineableMime(mimeType)
    && sizeBytes > 0
    && sizeBytes <= ATTACHMENT_INLINE_MAX_BYTES
  ) {
    inlineContent = await readSmallTextFile(asset.uri);
    if (inlineContent && inlineContent.length > ATTACHMENT_INLINE_MAX_BYTES) {
      // Defensive trim if the file declared a small size but the read
      // returned more (e.g. utf-8 expansion). Same bound either way.
      inlineContent = inlineContent.slice(0, ATTACHMENT_INLINE_MAX_BYTES);
    }
  }

  return {
    status: 'picked',
    attachment: {
      id: freshAttachmentId(),
      name,
      mimeType,
      sizeBytes,
    },
    // localUri is kept OUT of the message payload sent to the backend;
    // it's only here so the UI can show a preview if it wants. Never
    // pass this URI to the assistant rendering layer.
    localUri: asset.uri,
    inlineContent,
  };
}

// Convenience wrapper so the AttachmentMenu's Images button doesn't
// have to know about the picker's `kind` parameter.
export function pickImageAttachment(): Promise<AttachmentPickResult> {
  return pickChatAttachment('image');
}

// Exported for unit tests + readiness assertions that need to verify
// the inline-content gate (MIME allowlist + size cap).
export const __attachmentPickerInternals = {
  isInlineableMime,
  ATTACHMENT_INLINE_MAX_BYTES,
};
