import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A nav link pointing at a path with no route renders the "Page not found"
// screen. That is the cheapest defect in the app to ship and the most obvious
// one to a user, so it is checked here rather than left to a click-through.

const here = dirname(fileURLToPath(import.meta.url));
const src = (relative) => resolve(here, '../src', relative);
const read = (relative) => readFileSync(src(relative), 'utf8');

const APP = read('App.tsx');
const SHELL = read('components/Shell.tsx');

const routePaths = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
const navTargets = [...SHELL.matchAll(/\{\s*to:\s*'([^']+)'/g)].map((match) => match[1]);

test('the app declares routes and the shell declares links', () => {
  assert.ok(routePaths.length >= 14, `only found ${routePaths.length} routes`);
  assert.equal(navTargets.length, 13);
});

test('every navigation link has a matching route', () => {
  for (const target of navTargets) {
    assert.ok(routePaths.includes(target), `${target} is linked in the shell but has no route`);
  }
});

// Routes that are DELIBERATELY unlinked. Each entry needs a reason, because an
// unlisted unlinked route is still the cheapest defect to ship (a screen nobody
// can reach), and this set must never become a dumping ground for those.
const DELIBERATELY_UNLINKED = new Map([
  [
    '/admin',
    '2026-08-04: the owner dashboard. The Worker enforces its admin allowlist server-side; the URL is bookmark-only so ordinary users never see an admin affordance that would refuse them.',
  ],
]);

test('every route except the catch-all is reachable from the shell', () => {
  const reachable = new Set([...navTargets, '/', '*', ...DELIBERATELY_UNLINKED.keys()]);
  for (const path of routePaths) {
    assert.ok(reachable.has(path), `${path} has a route but nothing links to it`);
  }
});

test('deliberately unlinked routes actually exist and stay unlinked', () => {
  for (const [path, reason] of DELIBERATELY_UNLINKED) {
    assert.ok(reason.length > 20, `${path} needs a real documented reason`);
    assert.ok(routePaths.includes(path), `${path} is listed as unlinked but has no route at all`);
    assert.ok(!navTargets.includes(path), `${path} is documented as unlinked but the shell now links it; remove it from this list`);
  }
});

test('there is a catch-all and a landing redirect', () => {
  assert.ok(routePaths.includes('*'), 'an unknown URL would render nothing at all');
  assert.match(APP, /<Route path="\/" element=\{<Navigate to="\/chat" replace \/>\}/);
});

test('no route path is declared twice', () => {
  assert.equal(new Set(routePaths).size, routePaths.length);
});

test('every screen the app imports exists on disk', () => {
  const imports = [...APP.matchAll(/from '(\.\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(imports.length > 5);
  for (const specifier of imports) {
    const base = resolve(src('.'), specifier.replace(/^\.\//, ''));
    const found = ['.tsx', '.ts'].some((extension) => existsSync(`${base}${extension}`));
    assert.ok(found, `${specifier} is imported by App.tsx but no file matches`);
  }
});

test('the four surfaces a user touches constantly are the bottom tab bar', () => {
  assert.match(SHELL, /PRIMARY_NAV/);
  const primary = SHELL.slice(SHELL.indexOf('PRIMARY_NAV'), SHELL.indexOf('SECONDARY_NAV'));
  for (const path of ['/chat', '/files', '/routines', '/connections']) {
    assert.ok(primary.includes(`'${path}'`), `${path} is missing from the primary nav`);
  }
});

test('the phone layout and the wide layout come from the same nav lists', () => {
  // Two hand-maintained menus drift. The rail renders both lists spread into one.
  assert.match(SHELL, /\[\.\.\.primaryNav, \.\.\.SECONDARY_NAV\]/);
  // An agent-engine account runs nothing on a schedule, so it gets no Routines tab (2026-09-23).
  assert.match(SHELL, /const primaryNav = agentEngine \? PRIMARY_NAV\.filter\(\(item\) => item\.to !== '\/routines'\) : PRIMARY_NAV;/);
});

const MOBILE_APP = readFileSync(resolve(here, '../../mobile/App.tsx'), 'utf8');

test('the header says what the workspace is doing, even when it is fine', () => {
  // The banner below it only appears when something needs saying, so without
  // this the browser is silent on a good day while the phone shows a green dot
  // and the word Ready.
  assert.match(SHELL, /function StatusChip\(\)/);
  assert.match(SHELL, /<StatusChip \/>/);
});

test('the status label rules are the phone rules', () => {
  // Two gate kinds have labels that make no sense in three words on their own,
  // and the phone rewrites both. Rewriting only one would show "Choose a plan"
  // to somebody whose workspace is still being built.
  for (const source of [SHELL, MOBILE_APP]) {
    assert.match(source, /'needs_acknowledgement'/);
    assert.match(source, /'subscribed_pending_worker' \|\| gate\.kind === 'provisioning_worker'/);
    assert.match(source, /'Preparing workspace'/);
  }
  assert.match(SHELL, /return gate\.label;/);
});

test('the dot colour follows the gate tone, on the same three-way split as the phone', () => {
  assert.match(SHELL, /gate\.tone === 'live'/);
  assert.match(SHELL, /gate\.tone === 'accent'/);
  // success is the web name for the token the phone calls live; both are #4A7A4A.
  assert.match(SHELL, /bg-success/);
});

test('the slide-over closes on the press, not only on a route change', () => {
  // Tapping the entry for the page you are already on leaves the path
  // identical, so a close that hangs off location.pathname never fires and the
  // menu sits there over the content, looking like it ignored the tap. The
  // phone closes on the press itself, whether or not the destination changed.
  assert.match(MOBILE_APP, /onSelectTab\(tab\);\s*\n\s*onClose\(\);/, 'the phone no longer closes its drawer on the press');

  assert.match(SHELL, /function RailLink\(\{ item, onNavigate \}/, 'the shell links cannot close the menu');
  assert.match(SHELL, /<NavLink\s*\n\s*to=\{item\.to\}\s*\n\s*onClick=\{onNavigate\}/, 'RailLink ignores onNavigate');

  // Every link inside the slide-over, not just the section that happened to be
  // checked. The rail is always visible and has no menu to close, so it passes
  // nothing, which is why this counts occurrences rather than asserting on all.
  const drawer = SHELL.slice(SHELL.indexOf('role="dialog"'));
  const wired = drawer.match(/<RailLink key=\{item\.to\} item=\{item\} onNavigate=\{closeMenu\} \/>/g) ?? [];
  const total = drawer.match(/<RailLink /g) ?? [];
  assert.equal(wired.length, total.length, 'a link in the slide-over does not close it');
  assert.equal(total.length, 2, 'the slide-over no longer renders both nav lists');
});

test('the chip is not a second live region', () => {
  // The banner already announces the states worth interrupting a screen reader
  // for. Two announcements of one change is worse than one.
  const chip = SHELL.slice(SHELL.indexOf('function StatusChip()'), SHELL.indexOf('const TONE'));
  assert.equal(/role="status"|aria-live/.test(chip), false, 'the status chip announces itself as well as the banner');
  assert.match(chip, /aria-hidden="true"/);
});
