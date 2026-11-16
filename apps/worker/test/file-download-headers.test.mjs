// "Download to phone" (2026-07-18): a full-file browser download must SAVE the
// file to the phone's Downloads, not render it inline (Android browsers preview
// PDFs / office / code files and render them badly). Full downloads force
// octet-stream; range requests (inline preview + streaming) keep the true type.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDownloadContentType } from '../dist/files.js';

test('full download forces octet-stream so the browser saves it, never renders', () => {
  assert.equal(resolveDownloadContentType(false, 'application/pdf'), 'application/octet-stream');
  assert.equal(resolveDownloadContentType(false, 'text/html'), 'application/octet-stream');
  assert.equal(resolveDownloadContentType(false, 'image/png'), 'application/octet-stream');
  assert.equal(resolveDownloadContentType(false, null), 'application/octet-stream');
});

test('range requests (inline preview / streaming) keep the true content-type', () => {
  assert.equal(resolveDownloadContentType(true, 'text/plain'), 'text/plain');
  assert.notEqual(resolveDownloadContentType(true, 'application/pdf'), 'application/octet-stream');
});
