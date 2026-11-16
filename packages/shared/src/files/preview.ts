// The inline first-look at a text file, and the one line that says it is a
// first look rather than the whole thing.
//
// Both surfaces ask the file proxy for the same bounded byte range and then
// have to decide whether what came back is all of it. Getting that wrong is
// quiet and one-directional: a reader who is told nothing assumes they are
// looking at the complete file, and acts on it.

export const PREVIEW_BYTE_LIMIT = 8 * 1024;
export const PREVIEW_LINE_LIMIT = 40;

// A preview that failed used to end in a sentence and nothing to press. The
// phone would quietly try again if the reader happened to close the row and
// open it a second time, and the browser cached the failure so it would never
// try again at all. Neither surface said which of those it was doing.
export const PREVIEW_RETRY_LABEL = 'Try again';

export type PreviewableFile = { name: string; mimeType?: string };

export function isPreviewableFile(file: PreviewableFile): boolean {
  return (
    /^text\//i.test(file.mimeType ?? '') ||
    /\.(txt|md|markdown|json|csv|log|tsv|yml|yaml|xml|html|ini)$/i.test(file.name)
  );
}

// The range header is counted in bytes; a JavaScript string is counted in
// UTF-16 code units. For plain ASCII the two agree, which is why comparing a
// string length against a byte limit looked right for as long as nobody
// previewed a file with an accent in it. A full 8 KB of Arabic or emoji
// arrives as roughly 4000 or 2000 code units, so the old test never fired and
// the reader was shown a fragment with nothing to say it was one.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one four-byte character; skip its low half.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export type FilePreview = { body: string; truncated: boolean };

/**
 * Cuts the fetched range down to the lines shown, and says whether anything
 * was left behind.
 *
 * `sizeBytes` is the listing's own figure for the whole file and is the
 * trustworthy answer when we have it: bigger than the range we asked for means
 * we are holding a fragment, whatever the fragment happens to measure. The
 * byte count of what arrived is the fallback for a file whose size the listing
 * did not carry.
 */
export function buildFilePreview(raw: string, sizeBytes?: number): FilePreview {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const wholeFileIsBigger =
    typeof sizeBytes === 'number' && Number.isFinite(sizeBytes)
      ? sizeBytes > PREVIEW_BYTE_LIMIT
      : utf8ByteLength(raw) >= PREVIEW_BYTE_LIMIT;
  return {
    body: lines.slice(0, PREVIEW_LINE_LIMIT).join('\n'),
    truncated: lines.length > PREVIEW_LINE_LIMIT || wholeFileIsBigger,
  };
}
