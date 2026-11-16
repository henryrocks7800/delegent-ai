/**
 * PDFs for the coworker, from off-the-shelf parts:
 *   - Cloudflare Browser Rendering (headless Chrome as a Worker binding) prints
 *     an HTML document the model writes to a real PDF, with proper fonts, tables
 *     and the £ sign. Composio's text-to-PDF tool was tried first and could not
 *     draw a table or a pound sign (2026-09-15).
 *   - Composio's file staging (request an upload URL, PUT the bytes, pass the
 *     returned key as `s3key`) is how a file becomes an attachment for an app
 *     action such as GMAIL_SEND_EMAIL. Documented at
 *     https://docs.composio.dev/reference/api-reference/files/postFilesUploadRequest
 */
import puppeteer from '@cloudflare/puppeteer';

export async function htmlToPdf(browserBinding: Parameters<typeof puppeteer.launch>[0], html: string): Promise<Uint8Array> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    // The document is written by the model: nothing in it needs to run.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' }
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

/** The Composio toolkit a tool belongs to, from its slug (GMAIL_SEND_EMAIL -> gmail). */
export function toolkitOfTool(toolSlug: string): string | null {
  const known = [
    'GOOGLEDRIVE',
    'GOOGLEDOCS',
    'ONE_DRIVE',
    'MICROSOFT_TEAMS',
    'AGENT_MAIL',
    'OUTLOOK',
    'GMAIL',
    'DROPBOX',
    'SLACK',
    'NOTION'
  ];
  const prefix = known.find((k) => toolSlug.startsWith(`${k}_`));
  return prefix ? prefix.toLowerCase() : null;
}

/**
 * Where a file can go, and the argument of that action that takes it. Read from
 * Composio's schemas on 2026-09-23. The model sometimes names the app instead of
 * the action ("googledrive"): the file was then not staged, and it fell back to
 * an upload-from-URL action pointed at our own download link, which Drive could
 * not fetch (live QA, 2026-09-23). Naming the app now picks its upload action.
 */
export const FILE_ARGUMENTS: Record<string, string> = {
  GMAIL_SEND_EMAIL: 'attachment',
  GMAIL_CREATE_EMAIL_DRAFT: 'attachment',
  GMAIL_REPLY_TO_THREAD: 'attachment',
  OUTLOOK_SEND_EMAIL: 'attachment',
  OUTLOOK_CREATE_DRAFT: 'attachment',
  OUTLOOK_REPLY_EMAIL: 'attachment',
  GOOGLEDRIVE_UPLOAD_FILE: 'file_to_upload',
  DROPBOX_UPLOAD_FILE: 'content',
  ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: 'file',
  SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK: 'file',
};
const APP_DEFAULT_TARGET: Record<string, string> = {
  googledrive: 'GOOGLEDRIVE_UPLOAD_FILE',
  google_drive: 'GOOGLEDRIVE_UPLOAD_FILE',
  drive: 'GOOGLEDRIVE_UPLOAD_FILE',
  dropbox: 'DROPBOX_UPLOAD_FILE',
  onedrive: 'ONE_DRIVE_ONEDRIVE_UPLOAD_FILE',
  one_drive: 'ONE_DRIVE_ONEDRIVE_UPLOAD_FILE',
  gmail: 'GMAIL_SEND_EMAIL',
  outlook: 'OUTLOOK_SEND_EMAIL',
  slack: 'SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK',
};

/** The action a file is staged for, from an action slug or an app name; null if neither is known. */
export function resolveFileTarget(attachTo: string): { tool: string; argument: string | null } | null {
  const value = attachTo.trim();
  const byApp = APP_DEFAULT_TARGET[value.toLowerCase().replace(/[\s-]+/g, '_')];
  const tool = byApp ?? (/^[A-Z0-9_]+$/.test(value) && toolkitOfTool(value) ? value : null);
  return tool ? { tool, argument: FILE_ARGUMENTS[tool] ?? null } : null;
}

async function md5Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type StagedFile = { name: string; mimetype: string; s3key: string };

/** Stage a file with Composio so an app action can take it as an attachment. */
export async function stageForTool(
  apiKey: string,
  toolSlug: string,
  filename: string,
  mimetype: string,
  bytes: Uint8Array
): Promise<StagedFile> {
  const toolkit = toolkitOfTool(toolSlug);
  if (!toolkit) throw new Error(`no known app for ${toolSlug}`);
  const response = await fetch('https://backend.composio.dev/api/v3.1/files/upload/request', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      toolkit_slug: toolkit,
      tool_slug: toolSlug,
      filename,
      mimetype,
      md5: await md5Hex(bytes)
    })
  });
  if (!response.ok) throw new Error(`file staging HTTP ${response.status}`);
  const slot = (await response.json()) as {
    key?: string;
    new_presigned_url?: string;
    metadata?: { storage_backend?: string };
  };
  if (!slot.key) throw new Error('file staging returned no key');
  if (slot.new_presigned_url) {
    const put = await fetch(slot.new_presigned_url, {
      method: 'PUT',
      headers: {
        'content-type': mimetype,
        ...(slot.metadata?.storage_backend === 'azure_blob_storage' ? { 'x-ms-blob-type': 'BlockBlob' } : {})
      },
      body: new Uint8Array(bytes)
    });
    if (!put.ok) throw new Error(`file upload HTTP ${put.status}`);
  }
  return { name: filename, mimetype, s3key: slot.key };
}
