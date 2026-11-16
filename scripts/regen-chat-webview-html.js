#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'apps/mobile/assets/chat-webview/index.html');
const tsPath = path.join(root, 'apps/mobile/src/chat/chatWebViewHtml.ts');

const html = fs.readFileSync(htmlPath, 'utf8');
const escaped = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$');

const out = `// Auto-generated from apps/mobile/assets/chat-webview/index.html — do not edit directly.
// Regenerate with: node scripts/regen-chat-webview-html.js
export const CHAT_WEBVIEW_HTML = \`${escaped}\`;
`;

fs.writeFileSync(tsPath, out);
console.log(`Wrote ${path.relative(root, tsPath)} (${out.length} bytes from ${html.length} bytes HTML)`);
