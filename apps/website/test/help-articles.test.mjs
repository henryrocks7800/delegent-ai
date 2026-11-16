// The help articles (growth plan, 2026-09-23): pages written to be found in
// search and prerendered to static HTML by scripts/prerender-articles.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLES, ARTICLE_AUTHOR } from '../src/content/articles.mjs';
import { renderArticle, renderIndex } from '../scripts/prerender-articles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allText = (a) => [a.title, a.description, a.intro, ...a.sections.flatMap((s) => [s.title, ...s.body])].join('\n');

test('every article is complete, search-sized and addressable', () => {
  assert.ok(ARTICLES.length >= 3);
  const slugs = new Set();
  for (const a of ARTICLES) {
    assert.match(a.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, a.slug);
    assert.ok(!slugs.has(a.slug), `duplicate slug ${a.slug}`);
    slugs.add(a.slug);
    assert.ok(a.title.length >= 20 && a.title.length <= 60, `${a.slug}: title ${a.title.length} chars (search shows about 60)`);
    assert.ok(a.description.length >= 70 && a.description.length <= 170, `${a.slug}: description ${a.description.length} chars`);
    assert.match(a.published, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(a.sections.length >= 3 && a.sections.every((s) => s.title && s.body.length));
  }
});

test('Alex\'s house style: no em or en dashes anywhere in the copy', () => {
  for (const a of ARTICLES) assert.doesNotMatch(allText(a), /[\u2014\u2013]/, a.slug);
});

test('every page is under Jess\'s name (Alex, 2026-09-23)', () => {
  assert.equal(ARTICLE_AUTHOR.name, 'The Delegent AI team');
  for (const a of ARTICLES) {
    const html = renderArticle(a);
    assert.match(html, /By The Delegent AI team, Delegent AI/);
    assert.match(html, /"author":\{"@type":"Person","name":"The Delegent AI team"/);
  }
});

test('the copy promises nothing the product does not do', () => {
  for (const a of ARTICLES) {
    const text = allText(a).toLowerCase();
    assert.doesNotMatch(text, /into folders|files your (e)?mail|auto-?file/, `${a.slug}: filing mail is not claimed (not proven live)`);
    assert.doesNotMatch(text, /books? (it|the \w+) for you|pays? (it|the \w+) for you/, `${a.slug}: it never books or pays itself`);
    assert.doesNotMatch(text, /uk servers|hosted in the uk|data stays in the uk/, `${a.slug}: unsupported hosting claim`);
    assert.doesNotMatch(text, /@delegentai\.co\.uk/, `${a.slug}: mailboxes live in the page footer only`);
  }
});

test('the prerendered page carries its own title, description, canonical and a single h1', () => {
  for (const a of ARTICLES) {
    const html = renderArticle(a);
    assert.match(html, new RegExp(`<title>${a.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#39;')} · Delegent AI</title>`));
    assert.match(html, new RegExp(`<link rel="canonical" href="https://delegentai\\.co\\.uk/help/${a.slug}" />`));
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.match(html, /<meta name="description" content="[^"]{70,}" \/>/);
    assert.match(html, /href="\/install"/, 'every page leads to the install page');
    assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/, 'no scripts beyond structured data');
  }
  const index = renderIndex(ARTICLES);
  for (const a of ARTICLES) assert.match(index, new RegExp(`href="/help/${a.slug}"`));
});

test('the sitemap lists the help index and every article', () => {
  const sitemap = readFileSync(resolve(ROOT, 'public', 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/delegentai\.co\.uk\/help<\/loc>/);
  for (const a of ARTICLES) assert.match(sitemap, new RegExp(`<loc>https://delegentai\\.co\\.uk/help/${a.slug}</loc>`));
});

test('the build writes the pages, and the footer links to them', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /node scripts\/prerender-articles\.mjs/);
  const footer = readFileSync(resolve(ROOT, 'src', 'sections', 'Footer.tsx'), 'utf8');
  assert.match(footer, /href="\/help"/);
});
