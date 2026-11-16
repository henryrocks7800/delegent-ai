import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Firebase Hosting resolves a static file before it applies the SPA rewrite, so
// anything sitting in public/ silently outranks the React route of the same
// name. That is how /chat came to serve the bare chat document, with no shell,
// no nav and no auth, to anyone who refreshed or shared the app's default
// landing URL. The dev server resolves paths differently and saw nothing wrong,
// so only a real Hosting request caught it. These tests are the cheap version.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function appRoutes() {
  const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8');
  const found = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(found.length > 5, 'could not read the route table out of App.tsx');
  return found.filter((path) => path !== '*' && path !== '/');
}

function publicEntries() {
  return readdirSync(resolve(root, 'public'), { withFileTypes: true });
}

test('nothing in public/ shadows a route the app owns', () => {
  const routes = new Set(appRoutes().map((path) => path.replace(/^\//, '')));
  for (const entry of publicEntries()) {
    // A file keeps its extension in the URL, but cleanUrls also serves
    // "foo.html" at "/foo", so both forms have to clear the route table.
    const names = [entry.name, entry.name.replace(/\.html$/, '')];
    for (const name of names) {
      assert.equal(
        routes.has(name),
        false,
        `public/${entry.name} would be served instead of the /${name} screen`,
      );
    }
  }
});

test('the chat document is served from a path no route claims', () => {
  const names = publicEntries().map((entry) => entry.name);
  assert.ok(names.includes('chat-frame'), 'the chat document has not been synced into public/');
  assert.equal(names.includes('chat'), false, 'public/chat/ collides with the /chat screen');
});

test('the chat screen points at the document where it is actually served', () => {
  const screen = readFileSync(resolve(root, 'src/features/chat/ChatScreen.tsx'), 'utf8');
  const src = screen.match(/const CHAT_DOCUMENT = '([^']+)'/)?.[1];
  assert.ok(src, 'CHAT_DOCUMENT is not where this test expected it');
  assert.match(src, /^\/chat-frame\//);
});

test('hosting still rewrites everything else to the app shell', () => {
  const hosting = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8')).hosting;
  assert.deepEqual(hosting.rewrites, [{ source: '**', destination: '/index.html' }]);
  // Both of these change how a URL resolves, so a collision test that did not
  // know their values would be testing a different server than the one we run.
  assert.equal(hosting.cleanUrls, true);
  assert.equal(hosting.trailingSlash, false);
});
