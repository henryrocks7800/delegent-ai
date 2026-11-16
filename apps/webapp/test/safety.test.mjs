import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The web app is the first Delegent surface a stranger can reach without
// installing anything, so the trust boundary is checked here in the same terms
// CLAUDE.md states it: no server secrets, no provider internals, no payment
// redirect that can be pointed somewhere else.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

const FILES = sourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const read = (relative) => readFileSync(resolve(SRC, relative), 'utf8');

/** Comments explain why a rule exists and often name the thing the rule forbids. */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('there is something to scan', () => {
  assert.ok(FILES.length >= 20, `only found ${FILES.length} source files`);
});

test('no server secret is referenced anywhere in the client', () => {
  const forbidden = [
    'SERVICE_ROLE',
    'STRIPE_SECRET',
    'STRIPE_WEBHOOK',
    'FLY_API_TOKEN',
    'OPENROUTER',
    'SIDEKICK_RUNNER_SHARED_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'SENTRY_AUTH_TOKEN',
    'RESEND_API_KEY',
  ];
  for (const { path, text } of FILES) {
    for (const name of forbidden) {
      assert.equal(text.includes(name), false, `${path} mentions ${name}`);
    }
  }
});

test('no provider internal is surfaced to the user', () => {
  // Fly app names, Machine IDs, volume IDs and runner URLs are infrastructure the
  // product deliberately never shows.
  const forbidden = [/delegent-runner-/, /fly\.io/, /machine[iI]d/, /volumeId/, /\.fly\.dev/];
  for (const { path, text } of FILES) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`);
    }
  }
});

test('the only origins the app talks to are our own API and Supabase', () => {
  const hosts = new Set();
  for (const { text } of FILES) {
    for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(match[1].toLowerCase());
  }
  const allowed = new Set([
    'api.delegantai.co.uk',
    'app.delegentai.co.uk',
    'delegent-app.web.app',
    'checkout.stripe.com',
    'billing.stripe.com',
    // Google's sign-in script, loaded so the account picker runs on our own
    // origin instead of redirecting through the Supabase host.
    'accounts.google.com',
  ]);
  for (const host of hosts) {
    assert.ok(allowed.has(host), `unexpected origin in the client: ${host}`);
  }
});

test('checkout returns to a hard-coded origin of ours, never to whatever page asked', () => {
  const billing = read('features/billing/billingApi.ts');
  // The current origin is only honoured when it is already on this list, so an
  // unrecognised host falls back to production rather than naming itself as the
  // post-payment destination. It also keeps localhost out of a payment allowlist.
  // The fallback is RETURN_ORIGINS[0], so the address that actually resolves
  // has to be first: app.delegentai.co.uk never finished verifying and answers
  // NXDOMAIN, which would have sent an unrecognised host to a dead domain after
  // payment. Keep this pinned so a tidy-up cannot reorder it back.
  assert.match(billing, /RETURN_ORIGINS = \['https:\/\/delegent-app\.web\.app', 'https:\/\/app\.delegentai\.co\.uk'\]/);
  assert.match(billing, /RETURN_ORIGINS\.find\(\(origin\) => origin === current\) \?\? RETURN_ORIGINS\[0\]/);
  assert.equal(/successUrl:\s*`\$\{window/.test(billing), false);
  assert.equal(withoutComments(billing).includes('localhost'), false);
});

test('the app and the Worker agree on where checkout may return to', () => {
  const wrangler = readFileSync(resolve(here, '../../worker/wrangler.toml'), 'utf8');
  const line = wrangler.match(/^SIDEKICK_CHECKOUT_REDIRECT_ORIGINS = "([^"]+)"/m);
  assert.ok(line, 'the Worker declares no checkout redirect allowlist');
  const workerOrigins = line[1].split(',');
  const billing = read('features/billing/billingApi.ts');
  for (const origin of [...billing.matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1])) {
    if (!origin.includes('stripe.com')) {
      assert.ok(workerOrigins.includes(origin), `${origin} would be rejected by the Worker as a return URL`);
    }
  }
});

test('only a Stripe-hosted URL is ever navigated to', () => {
  const billing = read('features/billing/billingApi.ts');
  assert.match(billing, /parsed\.protocol !== 'https:'/);
  assert.match(billing, /checkout\.stripe\.com/);
  assert.match(billing, /billing\.stripe\.com/);
});

test('the access token is attached by the fetch helper and cannot be overridden', () => {
  const api = read('lib/api.ts');
  // Spreading the caller's headers first means a caller-supplied authorization
  // loses to ours rather than replacing it.
  assert.match(api, /\{ \.\.\.init\.headers, authorization: `Bearer \$\{token\}` \}/);
});

test('the server error code is validated before anything reads it', () => {
  const api = read('lib/api.ts');
  assert.match(api, /\/\^\[a-z0-9_\]\{1,64\}\$\//);
});

test('the chat frame only trusts messages from our own origin', () => {
  const chat = read('features/chat/ChatScreen.tsx');
  assert.match(chat, /if \(event\.origin !== window\.location\.origin\) return;/);
  assert.equal(chat.includes("postMessage(serialized, '*')"), false);
});

test('the avatar image cannot be pointed at a non-https URL', () => {
  const auth = read('features/auth/useAuth.ts');
  assert.match(auth, /safeAvatarUrl/);
  assert.match(auth, /'https:'/);
});

test('the page is kept out of search results while it is not announced', () => {
  const html = readFileSync(resolve(here, '../index.html'), 'utf8');
  assert.match(html, /name="robots"[^>]*noindex/);
});

// Connection outcomes and read failure handling run through the actual
// screen and shared hook in tests/e2e/connection-screen.test.mjs.
