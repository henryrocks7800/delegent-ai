import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Looking inside a file is how you check that the thing your coworker just
// wrote is the thing you asked for. The browser could only hand the file to the
// operating system, so these tests hold the inline preview to the phone's rules
// and to the one server-side condition it depends on.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, relative), 'utf8');

const WEB_API = read('../src/features/files/filesApi.ts');
const WEB_SCREEN = read('../src/features/files/FilesScreen.tsx');
const MOBILE = read('../../mobile/App.tsx');
const WORKER_INDEX = read('../../worker/src/index.ts');
const WORKER_FILES = read('../../worker/src/files.ts');

test('neither surface owns its own preview limits', () => {
  // These used to be declared twice and compared by reading both files. That
  // caught a mismatch but only after one had already been changed, and it could
  // not catch the two copies of the truncation rule drifting apart. Both now
  // import from @sidekick/shared, so there is nothing left to compare.
  for (const [surface, source] of [['the browser', WEB_API], ['the phone', MOBILE]]) {
    assert.equal(
      /^\s*(?:export )?const PREVIEW_(?:BYTE|LINE)_LIMIT\s*=/m.test(source),
      false,
      `${surface} declares its own preview limit instead of importing the shared one`,
    );
    assert.equal(
      /function isPreviewableFile\s*\(/.test(source),
      false,
      `${surface} declares its own isPreviewableFile instead of importing the shared one`,
    );
  }
});

test('both surfaces reach the same verdict on what the reader is looking at', () => {
  // Truncation is the whole point of the preview: a reader told nothing assumes
  // the file ends where the panel does. One shared function, called by both.
  assert.match(WEB_API, /buildFilePreview\(raw, file\.sizeBytes\)/);
  assert.match(MOBILE, /buildFilePreview\(raw, file\.sizeBytes\)/);
});

test('a fully consumed range of non-ASCII text still counts as truncated', async () => {
  // The range is asked for in bytes; a string is measured in UTF-16 code units.
  // Comparing one against the other meant 8 KB of Arabic arrived as about 4000
  // units, never reached the limit, and was shown as if it were the whole file.
  const { buildFilePreview, PREVIEW_BYTE_LIMIT } = await import('@sidekick/shared');
  const arabic = 'ا'.repeat(PREVIEW_BYTE_LIMIT / 2);
  assert.equal(arabic.length < PREVIEW_BYTE_LIMIT, true, 'the sample is not shorter than the byte limit');
  assert.equal(buildFilePreview(arabic).truncated, true);
  // And the listing's own size wins when we have it, whatever the bytes measure.
  assert.equal(buildFilePreview('short', PREVIEW_BYTE_LIMIT + 1).truncated, true);
  assert.equal(buildFilePreview('short', 5).truncated, false);
});

test('a preview asks for a range rather than the whole file', () => {
  // Without this a preview of a 90 MB log downloads 90 MB to show 40 lines.
  assert.match(WEB_API, /range: `bytes=0-\$\{PREVIEW_BYTE_LIMIT - 1\}`/);
});

test('the Worker lets a browser send a range header', () => {
  // `range` is not CORS-safelisted, so the preflight fails without it and the
  // preview can only ever show its "could not load" state.
  const allowed = WORKER_INDEX.match(/SIDEKICK_CORS_ALLOWED_HEADERS = '([^']+)'/);
  assert.ok(allowed, 'the allowed-headers constant was not found');
  assert.ok(
    allowed[1].split(',').map((value) => value.trim()).includes('range'),
    'the Worker does not allow the range header, so file preview cannot work in a browser',
  );
});

test('the Worker still validates the range it is given', () => {
  // Allowing the header through CORS must not be mistaken for trusting it.
  assert.match(WORKER_FILES, /safeRunnerFileRangeHeader/);
  assert.match(WORKER_FILES, /maxBytes/);
});

test('a 206 is accepted, not treated as a failure', () => {
  // A partial response is the successful answer to a range request. Checking
  // only response.ok would reject every preview that actually worked.
  assert.match(WEB_API, /response\.status !== 206/);
});

test('the preview is fetched without attaching a bearer token', () => {
  // The download URL carries its own signed token. Adding an Authorization
  // header would add a second credential to a cross-origin request for no gain.
  const body = WEB_API.slice(WEB_API.indexOf('export async function fetchFilePreview'));
  assert.equal(/authorization/i.test(body), false, 'the preview fetch attaches an Authorization header');
  assert.equal(/apiFetch/.test(body), false, 'the preview goes through apiFetch, which signs the request');
});

test('every outcome the reader can hit says something', () => {
  // A panel that opens and stays blank reads as broken software.
  for (const state of ['loading', 'ready', 'unsupported', 'unavailable']) {
    assert.match(WEB_SCREEN, new RegExp(`preview\\.status === '${state}'`), `no branch for ${state}`);
  }
  assert.match(WEB_SCREEN, /no inline preview for this kind of file/i);
  assert.match(WEB_SCREEN, /still safe in your workspace/i);
  assert.match(WEB_SCREEN, /this file is empty/i);
});

test('a long line wraps rather than scrolling sideways inside the panel', () => {
  // The phone draws this as ordinary text, which folds. A <pre> left to its own
  // defaults puts a second horizontal scrollbar inside the page and hides the
  // end of every line on a 390px screen.
  const pre = WEB_SCREEN.slice(WEB_SCREEN.indexOf('<pre'), WEB_SCREEN.indexOf('</pre>'));
  assert.match(pre, /whitespace-pre-wrap/);
  assert.equal(/overflow-auto/.test(pre), false, 'the preview can still be scrolled sideways');
});

test('the expander is a real button that reports its state', () => {
  // Screen readers get nothing from a div that changes what is below it.
  assert.match(WEB_SCREEN, /aria-expanded=\{open\}/);
  assert.match(WEB_SCREEN, /aria-controls=\{panelId\}/);
});

test('opening a preview does not re-read a file already read', () => {
  // 'ready' is already on screen and the file has not changed underneath us,
  // and 'unsupported' is a fact about the file type, so neither is worth a
  // second request. 'unavailable' is excluded deliberately; see below.
  assert.match(WEB_SCREEN, /if \(preview\.status !== 'idle' && preview\.status !== 'unavailable'\) return;/);
});

test('a preview that failed can be asked for again, on both surfaces', () => {
  // The browser cached the failure alongside the successes, so a preview that
  // failed once stayed failed for the life of the page: closing the row and
  // opening it again produced the identical sentence, and there was no other
  // way to ask. The phone did re-read on the next open, but silently, so on
  // neither surface was there anything that looked like a second attempt.
  assert.match(WEB_SCREEN, /data-testid="files\.previewRetry"/, 'the browser has no retry control');
  assert.match(WEB_SCREEN, /onClick=\{\(\) => void loadPreview\(\)\}/, 'the browser retry does not re-read');
  assert.match(MOBILE, /testID=\{`\$\{keyPrefix\}\.\$\{file\.id\}\.previewRetry`\}/, 'the phone has no retry control');
  assert.match(MOBILE, /onPress=\{\(\) => void loadPreview\(\)\}/, 'the phone retry does not re-read');

  // Reopening the card retries on both surfaces too. Named explicitly because
  // the short-circuit is the whole rule: widening it to anything-not-idle is a
  // one-word edit that would silently cache the failure again.
  assert.match(
    MOBILE,
    /if \(previewState\.status === 'ready' \|\| previewState\.status === 'loading'\) return;/,
    'the phone caches a failed preview, so reopening the card cannot retry either',
  );

  // One label, so the two surfaces cannot drift into "Try again" and "Retry".
  for (const [surface, source] of [['the browser', WEB_SCREEN], ['the phone', MOBILE]]) {
    assert.match(source, /PREVIEW_RETRY_LABEL/, `${surface} writes its own retry wording`);
  }
});

test('a file type with nothing to show inline is not offered a retry', () => {
  // Asking a second time cannot change the answer, so a button here would be a
  // promise the screen has no way to keep.
  const mobilePanel = MOBILE.slice(
    MOBILE.indexOf('No inline preview for this file type'),
    MOBILE.indexOf('.previewRetry`}'),
  );
  assert.match(mobilePanel, /\{previewable \? \(/, 'the phone offers a retry for an unpreviewable file type');

  const webUnsupported = WEB_SCREEN.slice(
    WEB_SCREEN.indexOf("preview.status === 'unsupported'"),
    WEB_SCREEN.indexOf("preview.status === 'unavailable'"),
  );
  assert.equal(
    /previewRetry/.test(webUnsupported),
    false,
    'the browser offers a retry for an unpreviewable file type',
  );
});

test('a list that has gone stale can be read again without reloading the page', () => {
  // The coworker writes files into this workspace while the screen is open. Both
  // empty states carried their own way back, so the one arrangement with nothing
  // to press was the ordinary one: a list that loaded and then went stale. The
  // phone has always kept a Refresh in this header.
  assert.match(WEB_SCREEN, /data-testid="files\.refresh"/, 'the browser has no refresh control');
  assert.match(WEB_SCREEN, /onClick=\{\(\) => void refresh\(\)\}/, 'the browser refresh does not re-read');
  assert.match(WEB_SCREEN, /disabled=\{refreshing \|\| loading\}/, 'a second press can start a second read');
  assert.match(MOBILE, /testID="files\.refreshButton"/, 'the phone lost its refresh control');
});
