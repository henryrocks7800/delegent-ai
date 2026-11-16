// Static prerender for /legal/privacy and /legal/terms.
//
// The forensic suite (C-POS-05, C-POS-10, R-LEG-05) fetches these
// URLs and greps the raw HTML for GDPR pillars + "Delegent AI".
// The Vite SPA only emits index.html at build, so the legal content
// (rendered client-side from DELEGENT_PRIVACY_SECTIONS etc.) is
// invisible to plain HTTP fetchers. This script emits static .html
// files at the corresponding paths so Firebase Hosting serves them
// directly (precedence > rewrite-to-index).
//
// Runs after `vite build`. Reads the canonical legal copy from
// @sidekick/shared and renders a minimal, accessibility-clean HTML
// page that mirrors the SPA's content.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
  DELEGENT_DELETION_TITLE,
  DELEGENT_DELETION_UPDATED,
  DELEGENT_DELETION_INTRO,
  DELEGENT_DELETION_SECTIONS,
  DELEGENT_NOTICES_TITLE,
  DELEGENT_NOTICES_UPDATED,
  DELEGENT_NOTICES_INTRO,
  DELEGENT_NOTICES_SECTIONS,
} from '@sidekick/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLegal({ title, updated, intro, sections }) {
  const sectionHtml = sections.map((s) => `
    <section>
      <h2>${escapeHtml(s.title)}</h2>
      ${s.body.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n      ')}
    </section>`).join('\n');

  // Inline a small amount of CSS so the static page is readable on
  // its own (Firebase still serves the Vite-built CSS for the SPA
  // when the user navigates there in-app, but the standalone HTML
  // has its own minimal styling).
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} · Delegent AI</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${escapeHtml(intro.slice(0, 200))}" />
  <link rel="icon" type="image/png" href="/app-icon.png" />
  <style>
    :root { color-scheme: light; }
    body { font-family: system-ui, -apple-system, "Helvetica Neue", sans-serif;
           max-width: 720px; margin: 0 auto; padding: 64px 24px; color: #0E0E0C;
           background: #FAFAF7; line-height: 1.65; }
    h1 { font-size: 36px; line-height: 1.1; margin: 0 0 16px 0; }
    h2 { font-size: 20px; margin: 40px 0 8px 0; }
    .eyebrow { font-size: 12px; letter-spacing: 0.6px; text-transform: uppercase;
               color: #6F6E68; margin-bottom: 16px; }
    .intro { font-size: 17px; color: #6F6E68; margin: 24px 0 32px 0; }
    p { margin: 0 0 12px 0; }
    hr { border: 0; border-top: 1px solid #E5E2DA; margin: 48px 0 24px 0; }
    .contact { font-size: 13.5px; color: #6F6E68; }
    a { color: #2A4A3A; }
  </style>
</head>
<body>
  <p class="eyebrow">Legal · Last updated ${escapeHtml(updated)}</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="intro">${escapeHtml(intro)}</p>
  ${sectionHtml}
  <hr />
  <p class="contact">
    Questions? Email
    <a href="mailto:admin@example.com">admin@example.com</a>
    or <a href="mailto:support@example.com">support@example.com</a>.
  </p>
</body>
</html>
`;
}

function write(path, html) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, 'utf8');
  console.log(`prerendered ${path} (${html.length} bytes)`);
}

write(resolve(DIST, 'legal', 'privacy.html'), renderLegal({
  title: DELEGENT_PRIVACY_TITLE,
  updated: DELEGENT_PRIVACY_UPDATED,
  intro: DELEGENT_PRIVACY_INTRO,
  sections: DELEGENT_PRIVACY_SECTIONS,
}));
write(resolve(DIST, 'legal', 'terms.html'), renderLegal({
  title: DELEGENT_TERMS_TITLE,
  updated: DELEGENT_TERMS_UPDATED,
  intro: DELEGENT_TERMS_INTRO,
  sections: DELEGENT_TERMS_SECTIONS,
}));
// Data deletion page — the public URL required by the Google Play Data Safety
// form (https://delegentai.co.uk/legal/delete).
write(resolve(DIST, 'legal', 'delete.html'), renderLegal({
  title: DELEGENT_DELETION_TITLE,
  updated: DELEGENT_DELETION_UPDATED,
  intro: DELEGENT_DELETION_INTRO,
  sections: DELEGENT_DELETION_SECTIONS,
}));
// Open source notices — attributes Hermes Agent (MIT) and the other
// open-source software Delegent AI is built on. Public URL: /legal/notices.
write(resolve(DIST, 'legal', 'notices.html'), renderLegal({
  title: DELEGENT_NOTICES_TITLE,
  updated: DELEGENT_NOTICES_UPDATED,
  intro: DELEGENT_NOTICES_INTRO,
  sections: DELEGENT_NOTICES_SECTIONS,
}));
console.log('legal prerender done');
