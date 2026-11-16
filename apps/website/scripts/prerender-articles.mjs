// Static prerender for the help articles: /help and /help/<slug>.
//
// Same reason as prerender-legal.mjs: the Vite SPA only emits index.html, so a
// page rendered client-side shows search engines the home page's title and no
// text. These are the pages meant to be found in search, so each is written as
// its own HTML file with its own title, description, canonical URL, byline and
// structured data. Firebase Hosting serves a static file ahead of the SPA
// rewrite, and cleanUrls maps /help/<slug> to help/<slug>.html.
//
// Runs after `vite build`. The copy lives in src/content/articles.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLES, ARTICLE_AUTHOR } from '../src/content/articles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const ORIGIN = 'https://delegentai.co.uk';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const STYLE = `
    :root { color-scheme: light; }
    body { font-family: system-ui, -apple-system, "Helvetica Neue", sans-serif; margin: 0; color: #0E0E0C;
           background: #FAFAF7; line-height: 1.65; }
    header, main, footer { max-width: 720px; margin: 0 auto; padding: 0 24px; }
    header { padding-top: 28px; }
    header a { font-weight: 600; color: #0E0E0C; text-decoration: none; }
    main { padding-top: 40px; padding-bottom: 32px; }
    h1 { font-size: 34px; line-height: 1.15; margin: 0 0 12px 0; }
    h2 { font-size: 20px; margin: 36px 0 8px 0; }
    .eyebrow { font-size: 12px; letter-spacing: 0.6px; text-transform: uppercase; color: #6F6E68; margin: 0 0 14px 0; }
    .byline { font-size: 14px; color: #6F6E68; margin: 0 0 24px 0; }
    .intro { font-size: 17px; color: #3a382f; margin: 0 0 8px 0; }
    p { margin: 0 0 12px 0; }
    .template p { margin: 0 0 10px 0; }
    .template { background: #FFFFFF; border: 1px solid #E5E2DA; border-radius: 12px; padding: 20px 22px; }
    .cta { display: inline-block; margin-top: 8px; padding: 12px 20px; border-radius: 999px; background: #2A4A3A;
           color: #FFFFFF; text-decoration: none; font-weight: 600; }
    ul.articles { list-style: none; padding: 0; margin: 24px 0 0 0; }
    ul.articles li { margin: 0 0 22px 0; }
    ul.articles a { font-size: 18px; font-weight: 600; color: #2A4A3A; }
    footer { border-top: 1px solid #E5E2DA; padding-top: 20px; padding-bottom: 48px; font-size: 13.5px; color: #6F6E68; }
    a { color: #2A4A3A; }`;

function page({ title, description, path, body, jsonLd }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} · Delegent AI</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${ORIGIN}${path}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${ORIGIN}${path}" />
  <meta property="og:site_name" content="Delegent AI" />
  <link rel="icon" type="image/png" href="/app-icon.png" />
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <style>${STYLE}
  </style>
</head>
<body>
  <header><a href="/">Delegent AI</a></header>
  <main>
${body}
  </main>
  <footer>
    <p><a href="/help">More help articles</a> · <a href="/guides">Guides</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a></p>
    <p>Delegent AI, registered in England and Wales. Questions? <a href="mailto:support@example.com">support@example.com</a></p>
  </footer>
</body>
</html>
`;
}

export function renderArticle(article) {
  const path = `/help/${article.slug}`;
  const sections = article.sections.map((s) => {
    const paragraphs = s.body.map((p) => `        <p>${escapeHtml(p)}</p>`).join('\n');
    const inner = s.title === 'The template' ? `      <div class="template">\n${paragraphs}\n      </div>` : paragraphs;
    return `    <section>\n      <h2>${escapeHtml(s.title)}</h2>\n${inner}\n    </section>`;
  }).join('\n');
  const body = `    <article>
    <p class="eyebrow"><a href="/help">Help</a></p>
    <h1>${escapeHtml(article.title)}</h1>
    <p class="byline">By ${escapeHtml(ARTICLE_AUTHOR.name)}, ${escapeHtml(ARTICLE_AUTHOR.role)} · ${escapeHtml(longDate(article.published))}</p>
    <p class="intro">${escapeHtml(article.intro)}</p>
${sections}
    <p><a class="cta" href="/install">Get Delegent AI, first month free</a></p>
    </article>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: article.title,
        description: article.description,
        datePublished: article.published,
        dateModified: article.published,
        author: { '@type': 'Person', name: ARTICLE_AUTHOR.name, jobTitle: ARTICLE_AUTHOR.role },
        publisher: { '@type': 'Organization', name: 'Delegent AI', url: ORIGIN },
        mainEntityOfPage: `${ORIGIN}${path}`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Help', item: `${ORIGIN}/help` },
          { '@type': 'ListItem', position: 2, name: article.title, item: `${ORIGIN}${path}` },
        ],
      },
    ],
  };
  return page({ title: article.title, description: article.description, path, body, jsonLd });
}

export function renderIndex(articles) {
  const items = articles.map((a) => `      <li><a href="/help/${a.slug}">${escapeHtml(a.title)}</a><br />${escapeHtml(a.description)}</li>`).join('\n');
  const body = `    <h1>Help articles</h1>
    <p class="intro">Practical guides to everyday admin, with or without an AI assistant.</p>
    <ul class="articles">
${items}
    </ul>
    <p><a class="cta" href="/install">Get Delegent AI, first month free</a></p>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Help articles',
    url: `${ORIGIN}/help`,
    publisher: { '@type': 'Organization', name: 'Delegent AI', url: ORIGIN },
  };
  return page({ title: 'Help articles', description: 'Practical guides to everyday admin, with or without an AI assistant, from Delegent AI.', path: '/help', body, jsonLd });
}

function write(path, html) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, 'utf8');
  console.log(`prerendered ${path} (${html.length} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const article of ARTICLES) write(resolve(DIST, 'help', `${article.slug}.html`), renderArticle(article));
  write(resolve(DIST, 'help.html'), renderIndex(ARTICLES));
  console.log('articles prerender done');
}
