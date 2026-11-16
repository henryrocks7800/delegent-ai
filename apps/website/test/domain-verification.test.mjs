// Meta domain verification must stay STATIC in the served HTML.
//
// Why this is worth a test for a single meta tag.
//
// Verifying delegentai.co.uk with Meta is the prerequisite for configuring web
// conversion events on the Pixel and for Aggregated Event Measurement. Without
// it a campaign can optimise for a click and nothing better.
//
// The failure mode is silent and total. If the tag is removed, or moved into a
// React component, or into a Helmet-style head manager, Meta's crawler reads
// the page BEFORE any of that runs, sees nothing, and the domain quietly drops
// to unverified. Nothing breaks loudly. The site still works, the Pixel still
// loads, and the only symptom is that conversion optimisation stops being
// available in Ads Manager, which nobody connects back to a tidy-up of
// index.html weeks earlier.
//
// Meta's own instruction is explicit: "Verification will fail if the meta-tag
// code is outside of the <head> section or in a section loaded dynamically by
// JavaScript." This site is a Vite React SPA, so "loaded dynamically by
// JavaScript" describes almost everything in it. The tag has to be in the
// static shell, and this test is what stops it being helpfully relocated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** Issued by Meta for business portfolio "Delegent AI" (0000000000000000),
 *  domain id 0000000000000000, on 2026-09-03. Public by design. */
const TOKEN = 'wrf052fy6uswd8furjwbc2kyixo3pb';

test('the Meta domain verification tag is present', () => {
  assert.match(
    html,
    /<meta\s+name="facebook-domain-verification"\s+content="[^"]+"\s*\/?>/,
    'the facebook-domain-verification meta tag is gone from index.html',
  );
});

test('it carries the token Meta actually issued', () => {
  const m = /name="facebook-domain-verification"\s+content="([^"]+)"/.exec(html);
  assert.ok(m, 'could not read the verification token');
  assert.equal(
    m[1],
    TOKEN,
    'the verification token changed. If Meta reissued it, update TOKEN here too, '
    + 'then redeploy the site AND press Verify in Business Manager.',
  );
});

test('it is inside <head>, where the crawler will actually see it', () => {
  const headStart = html.indexOf('<head');
  const headEnd = html.indexOf('</head>');
  assert.ok(headStart >= 0 && headEnd > headStart, 'index.html has no <head> block');
  const head = html.slice(headStart, headEnd);
  assert.ok(
    head.includes('facebook-domain-verification'),
    'the verification tag is outside <head>. Meta will not find it there.',
  );
});

test('it is NOT rendered by React', () => {
  // The whole point. A tag injected at runtime is invisible to a crawler that
  // reads the HTML and does not execute the bundle.
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(
    !src.includes('facebook-domain-verification'),
    'the verification tag has been moved into React, where Meta cannot see it',
  );
});
