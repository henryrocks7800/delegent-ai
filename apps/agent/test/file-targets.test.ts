import assert from 'node:assert/strict';
import test from 'node:test';
import { FILE_ARGUMENTS, resolveFileTarget } from '../src/pdf.ts';

test("an app name picks that app's upload action and names the argument (live QA, 2026-09-23)", () => {
  assert.deepEqual(resolveFileTarget('googledrive'), { tool: 'GOOGLEDRIVE_UPLOAD_FILE', argument: 'file_to_upload' });
  assert.deepEqual(resolveFileTarget('Google Drive'), { tool: 'GOOGLEDRIVE_UPLOAD_FILE', argument: 'file_to_upload' });
  assert.deepEqual(resolveFileTarget('dropbox'), { tool: 'DROPBOX_UPLOAD_FILE', argument: 'content' });
  assert.deepEqual(resolveFileTarget('onedrive'), { tool: 'ONE_DRIVE_ONEDRIVE_UPLOAD_FILE', argument: 'file' });
  assert.deepEqual(resolveFileTarget('gmail'), { tool: 'GMAIL_SEND_EMAIL', argument: 'attachment' });
});

test('an action slug is kept, with its argument when known; anything else is refused', () => {
  assert.deepEqual(resolveFileTarget('OUTLOOK_SEND_EMAIL'), { tool: 'OUTLOOK_SEND_EMAIL', argument: 'attachment' });
  assert.deepEqual(resolveFileTarget('GMAIL_REPLY_TO_THREAD'), { tool: 'GMAIL_REPLY_TO_THREAD', argument: 'attachment' });
  assert.deepEqual(resolveFileTarget('NOTION_ADD_PAGE_CONTENT'), { tool: 'NOTION_ADD_PAGE_CONTENT', argument: null });
  assert.equal(resolveFileTarget('SHOPIFY_CREATE_PRODUCT'), null);
  assert.equal(resolveFileTarget('instagram'), null);
  for (const tool of Object.keys(FILE_ARGUMENTS)) assert.equal(resolveFileTarget(tool)?.tool, tool);
});
