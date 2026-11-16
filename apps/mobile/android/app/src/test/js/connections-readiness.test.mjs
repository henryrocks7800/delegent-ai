import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-25 (Alex): Connections. The encrypted vault already existed on each
// user's own workspace; the only way to load a key into it was to type the key
// into chat, which left the plaintext in the message history and in the model's
// context. This suite guards the surface that replaces that.
//
// 2026-07-28: the surface went further. The screen used to offer a second way in
// for services we could not broker, where the reader typed a password into a
// field we drew. That went with the mailbox that was its only user, so the
// invariant is now stronger and simpler: there is no credential input on either
// surface at all, and every connection is a hand-off to the provider's own
// sign-in. These tests hold that line rather than the older one.

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const connectionsSource = readFileSync(new URL('../../../../../src/connections/connections.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../../../../src/connections/connectionsApi.ts', import.meta.url), 'utf8');
const catalogueSource = readFileSync(new URL('../../../../../../../packages/shared/src/connections.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../../../../../../../apps/worker/src/index.ts', import.meta.url), 'utf8');

// Several of these hold the two surfaces to the same behaviour, so the browser
// screen is read here rather than in a suite the phone cannot see.
const webScreen = () =>
  readFileSync(new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url), 'utf8');

// Scoped, not searched for across the whole file. Several drawers hold a
// `loadState`, so an unscoped match for one of these lines passes on another
// screen's copy of it and the assertion proves nothing about this one.
const connectionsDrawer = () => {
  const body = appSource.match(/function ConnectionsDrawer[\s\S]*?\n\}\n/);
  assert.ok(body, 'ConnectionsDrawer not found');
  return body[0];
};

test('Connections is reachable as its own burger-menu section', () => {
  assert.match(appSource, /testID="menu\.connectionsRow"/, 'no Connections row in the menu');
  assert.match(appSource, /'connections'/, 'connections is not a DrawerView');
  assert.match(appSource, /view === 'connections' \? <ConnectionsDrawer/, 'the connections view renders nothing');
  assert.match(appSource, /view === 'connections' \? 'Connections'/, 'the connections subview has no header title');
});

// Error wording and HTTP status/code distinctions now run through the complete
// mobile and web clients in tests/e2e/connection-client.test.mjs.

test('the connect controls expose stable testIDs keyed by service', () => {
  assert.match(appSource, /testID=\{`connections\.connect\.\$\{service\.id\}`\}/);
  assert.match(appSource, /testID=\{`connections\.disconnect\.\$\{service\.id\}`\}/);
  assert.ok(appSource.includes('testID="connections.notice"'));
  // The chat-setup control went with 'guided' mode. Only the phone ever drew it,
  // so it was a route the browser could not follow.
  assert.equal(appSource.includes('connections.guided.'), false, 'the guided control came back');
});

// The strongest form of "a typed password cannot leak" is that there is nowhere
// to type one. Both surfaces are held to that rather than to the old rules
// about masking and trimming what the reader typed.
test('neither surface offers anywhere to type a credential', () => {
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url),
    'utf8',
  );
  const drawer = appSource.match(/function ConnectionsDrawer[\s\S]*?\n\}\n/);
  assert.ok(drawer, 'ConnectionsDrawer not found');
  assert.equal(/<TextInput/.test(drawer[0]), false, 'the drawer draws a credential field again');
  assert.equal(/<input/.test(webScreen), false, 'the web screen draws a credential field again');
  for (const [name, source] of [['app', appSource], ['web', webScreen]]) {
    assert.equal(/putConnection|buildConnectionSecret/.test(source), false, `${name} can write a typed secret again`);
  }
});

test('nothing a connection touches reaches the chat transcript', () => {
  const drawer = appSource.match(/function ConnectionsDrawer[\s\S]*?\n\}\n/);
  assert.ok(drawer, 'ConnectionsDrawer not found');
  assert.equal(/DeviceEventEmitter/.test(drawer[0]), false, 'the drawer must not emit chat events directly');
  // Every phrase handed to chat comes off the catalogue, so no wording the
  // reader supplied can end up in the message history.
  const phrases = [...drawer[0].matchAll(/onStartInChat\(([^\n]*)/g)].map((m) => m[1]);
  assert.ok(phrases.length > 0, 'nothing is handed to chat at all');
  for (const phrase of phrases) {
    assert.match(phrase, /service\.|announcedService\.|tool\.prompt|`/, `a phrase does not come from the catalogue: ${phrase}`);
  }
  // The agent engine's built-in tools hand over their prompt from the shared
  // catalogue (packages/shared/src/content/agentEngine.ts), never reader text:
  // the drawer only renders the tools the section builder took off that list.
  if (/tool\.prompt/.test(drawer[0])) {
    assert.match(drawer[0], /buildAgentConnectionSections\(rows, chosenIds\)\.map\(\(section\) =>[\s\S]*?section\.tools\.map\(\(tool\) =>/);
    assert.match(connectionsSource, /\.map\(\(id\) => AGENT_EVERYDAY_TOOLS\.find\(\(tool\) => tool\.id === id\)\)/);
  }
});

// [2026-08-01] The "try what you just connected" card is a receipt for a
// hand-off, not a standing item. The drawer is a Modal, and a hidden Modal does
// not unmount its children, so the card outlived the visit that produced it:
// Alex reopened Connections days after connecting Slack and found it still
// sitting at the top, reading as an unfinished task.
test('the connection announcement is single use and does not outlive the visit', () => {
  const drawer = appSource.match(/function ConnectionsDrawer[\s\S]*?\n\}\n/);
  assert.ok(drawer, 'ConnectionsDrawer not found');

  // Acting on it spends it.
  assert.match(
    drawer[0],
    /setAnnouncement\(null\);\s*\n\s*setAnnouncedService\(null\);\s*\n\s*onStartInChat\(/,
    'tapping the card must clear it before handing the phrase to chat',
  );

  // Closing the drawer spends it too, for the reader who never taps.
  assert.match(
    drawer[0],
    /useEffect\(\(\) => \{\s*\n\s*if \(visible\) return;/,
    'the drawer must clear the announcement when it is hidden',
  );
});

test('the app never persists a credential locally', () => {
  for (const source of [appSource, apiSource, connectionsSource]) {
    assert.equal(/AsyncStorage[\s\S]{0,80}secret/i.test(source), false);
    assert.equal(/SecureStore[\s\S]{0,80}secret/i.test(source), false);
  }
});

test('the read path is a status feed that cannot carry a secret', () => {
  assert.equal(/api_token|app_password|client_secret/.test(connectionsSource), false);
  const mapper = connectionsSource.match(/export function mapConnectionStates[\s\S]*?\n\}/);
  assert.ok(mapper);
  // A provider, a status, an account label and a timestamp, and nothing that
  // could carry a grant. Mapping anything else off the wire would be the first
  // step toward rendering a token.
  for (const field of ['provider', 'status', 'accountLabel', 'connectedAt']) {
    assert.ok(mapper[0].includes(field), `the status mapper dropped ${field}`);
  }
  assert.equal(/secret|token|password|refresh/i.test(mapper[0]), false, 'the status mapper reads a credential');
});

test('every catalogue id survives the worker path validation', () => {
  const pattern = workerSource.match(/\/\^\[a-z0-9_-\]\{1,64\}\$\/\.test\(service\)/);
  assert.ok(pattern, 'the worker no longer validates the service path segment');
  const ids = [...catalogueSource.matchAll(/^\s*id: '([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 1, `the catalogue is empty, so Connections has nothing to show`);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9_-]{1,64}$/, `catalogue id ${id} would be rejected by the API`);
  }
});

// Availability/error semantics are exercised through both complete HTTP clients
// in tests/e2e/connection-client.test.mjs. A status-code source pattern used
// to require every 503 to mean "not configured", including real outages.

// This screen used to read two feeds: the broker, and the workspace's own vault
// for the services whose credential the reader typed. Looking a provider up in
// the wrong one showed a connected account as disconnected, which is the one
// failure a connections screen must never have. The second feed is gone, so the
// guard is that it does not come back.
test('the screen reads one feed, so a connection cannot be looked up in the wrong one', () => {
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url),
    'utf8',
  );
  const webApiSource = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/connectionsApi.ts', import.meta.url),
    'utf8',
  );
  for (const [name, source] of [['app', appSource], ['web', webScreen]]) {
    assert.equal(/fetchConnections\b/.test(source), false, `${name} reads a second connection feed again`);
    assert.equal(/vaultUnavailable/.test(source), false, `${name} still reports a vault it no longer reads`);
  }
  for (const [name, source] of [['app', apiSource], ['web', webApiSource]]) {
    // The vault route itself. Every remaining call is under the oauth path.
    assert.equal(/'\/api\/connections'/.test(source), false, `${name} still calls the vault route`);
  }
});

test('the consent sheet can be read from the top on a short browser window', () => {
  // 2026-07-28 (Alex): "you can't scroll up and down so you can't actually read
  // the whole message. The top bit is out of sight." The backdrop was the flex
  // container itself, so a sheet taller than the viewport overflowed a
  // fixed-height box in both directions and the part above the top edge could
  // not be scrolled to. Consent nobody can read is not consent, so the scroller
  // has to stay a plain block with the centring box inside it at min-h-full.
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url),
    'utf8',
  );
  const overlay = webScreen.match(/function Overlay\([\s\S]*?\n\}/);
  assert.ok(overlay, 'the shared dialog backdrop is gone');
  assert.match(overlay[0], /fixed inset-0[^"]*overflow-y-auto/, 'the backdrop is not the scroll container');
  assert.equal(/fixed inset-0[^"]*\bflex\b/.test(overlay[0]), false, 'the scroll container centres its own child again');
  assert.match(overlay[0], /flex min-h-full/, 'the inner box does not grow with the sheet');
  // The consent sheet is the only dialog left on this screen, and it is the one
  // that has to be readable from the top.
  assert.equal((webScreen.match(/<Overlay>/g) ?? []).length, 1, 'a dialog is bypassing the scrollable backdrop');
  assert.equal(/fixed inset-0/.test(webScreen.replace(/function Overlay[\s\S]*?\n\}/, '')), false);

  // The phone renders the sheet inline inside the drawer's ScrollView rather
  // than as a fixed overlay, so it grows the scroll content and has never had
  // this problem. Pinned so a future move to a modal has to think about it.
  const renderedAt = appSource.indexOf("view === 'connections' ? <ConnectionsDrawer");
  assert.ok(renderedAt > 0, 'the connections drawer is not rendered');
  // Animated.ScrollView since 2026-09-03: the drawer scrollers take their
  // scrollEnabled through Reanimated animatedProps so the swipe-to-close
  // gesture can freeze them without a React render. Still a scroll container.
  const enclosing = appSource.slice(0, renderedAt).lastIndexOf('<Animated.ScrollView contentContainerStyle={styles.drawerScroll}');
  assert.ok(enclosing > 0, 'the connections drawer has no scroll container above it');
  assert.equal(
    appSource.slice(enclosing, renderedAt).includes('</ScrollView>'),
    false,
    'the connections drawer sits outside the scroll container, so a tall consent sheet would clip',
  );
});

test('a provider brand mark comes from the catalogue and is optional', () => {
  // Alex asked for the Dropbox logo next to the name. It is path data on the
  // catalogue entry, not an image fetch and not a per-provider component, so
  // the third provider is one more field rather than more rendering code.
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.match(catalogueSource, /brandMark: BrandMark \| null/, 'the catalogue carries no brand mark');
  const mobileIdentity = readFileSync(new URL('../../../../../src/connections/ConnectionIdentity.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /import \{ BrandMarkGlyph, ConnectionIdentity \} from '.\/src\/connections\/ConnectionIdentity'/);
  for (const [name, source] of [['app', mobileIdentity], ['web', webScreen]]) {
    assert.match(source, /function BrandMarkGlyph/, `${name} does not draw the mark`);
    // Every provider on the list has a mark today, but the type still allows
    // none, so both surfaces have to degrade to the name alone rather than
    // drawing a placeholder shape.
    assert.match(source, /brandMark \? <BrandMarkGlyph/, `${name} assumes every provider has a mark`);
    assert.match(source, /d=\{mark\.path\}/, `${name} does not draw the catalogue path`);
    assert.match(source, /mark\.color/, `${name} recolours the provider glyph`);
  }
});

test('the list says more connections are coming, once, from shared copy', () => {
  const webScreen = readFileSync(
    new URL('../../../../../../webapp/src/features/connections/ConnectionsScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.match(catalogueSource, /export const CONNECTIONS_MORE_COMING_NOTE/);
  for (const [name, source] of [['app', appSource], ['web', webScreen]]) {
    assert.match(source, /CONNECTIONS_MORE_COMING_NOTE/, `${name} never renders the sign-off`);
  }
  // It used to be hard-coded into the phone's intro paragraph. Saying it at the
  // top and again at the foot is one screen making the same promise twice.
  assert.equal(/More to plug into is on the way/.test(appSource), false, 'the old header sentence is still there');
});

test('the worker refuses an oversized credential body', () => {
  assert.match(workerSource, /MAX_CONNECTION_SECRET_BYTES/);
  assert.match(workerSource, /credential_too_large/);
});

// Partial reads, retained cards, retries and stale responses are executed
// through both complete components in tests/e2e/connection-screen.test.mjs.

// Opening a consent sheet does not resolve a read the broker never answered, and
// on the browser it also took away the retry attached to that line.
test('pressing Connect does not wipe the account of a read that failed', () => {
  const drawer = connectionsDrawer();
  const mobileOpen = drawer.slice(drawer.indexOf('onOpen={() => {'), drawer.indexOf('onDisconnect={() => confirmDisconnect(service)}'));
  assert.ok(mobileOpen.includes('setReviewingId(service.id)'), 'the card no longer opens the sheet');
  assert.equal(/setNotice\(null\)/.test(mobileOpen), false, 'opening the sheet clears the read failure again');

  const webSetUp = webScreen().slice(webScreen().indexOf('onSetUp={() => {'), webScreen().indexOf('onDisconnect={() => setDisconnecting(row.service)}'));
  assert.ok(webSetUp.includes('setReviewing(row.service)'), 'the card no longer opens the sheet');
  assert.equal(/setError\(null\)/.test(webSetUp), false, 'pressing Connect clears the read failure again');
});

// The browser already held this apart, deliberately. The phone sent it to the
// top of the drawer, which on a list of ten services is most of a scroll away
// from the button that was just pressed.
test('a hand-off that would not open is reported beside the button that was pressed', () => {
  for (const [name, source] of [['app', connectionsDrawer()], ['web', webScreen()]]) {
    assert.match(source, /const \[sheetError, setSheetError\] = useState<string \| null>\(null\)/, `${name} has no sheet-level error`);
  }
  // Actual refused starts and browser-open failures are executed through the
  // complete drawer in tests/e2e/connection-screen.test.mjs.
  // Rendered inside the sheet, not at the top of the drawer.
  const sheet = appSource.slice(appSource.indexOf('if (reviewingId === service.id) {'), appSource.indexOf('testID={`connections.cancelReview'));
  assert.match(sheet, /testID="connections\.sheetError"/, 'the sheet does not show its own failure');
});

test('a disconnect that was refused is said in the card it was refused for', () => {
  // Both surfaces sent it to the page-level notice at the very top, above ten
  // cards in four groups. The confirmation closes on the press, so the only
  // thing that changed was a line the reader had scrolled well past, and it
  // never named which account was still connected. The read failure and the
  // return notice stay at the top: those are about the screen, not a card.
  const drawer = connectionsDrawer();
  const web = webScreen();
  for (const [name, source] of [['app', drawer], ['web', web]]) {
    assert.match(
      source,
      /const \[rowError, setRowError\] = useState<\{ id: string; message: string \} \| null>\(null\)/,
      `${name} does not carry the service the failure belongs to`,
    );
  }

  // The executed drawer test verifies a refused disconnect reaches only its
  // own card and cannot clear an unrelated broker-read failure.

  const webDisconnect = web.match(/async function confirmDisconnect\(\) \{[\s\S]*?\n  \}/);
  assert.ok(webDisconnect, 'the browser disconnect handler is gone');
  assert.match(webDisconnect[0], /setRowError\(\{ id: target\.id, message: result\.message \}\)/);
  assert.equal(/setError\(/.test(webDisconnect[0]), false, 'a refused disconnect still writes the page-level error');

  // Only the card it happened to is told, and only the card draws it.
  assert.match(drawer, /error=\{rowError\?\.id === service\.id \? rowError\.message : null\}/);
  assert.match(web, /error=\{rowError\?\.id === row\.service\.id \? rowError\.message : null\}/);
  const mobileCard = appSource.slice(
    appSource.indexOf('function ConnectionCard({'),
    appSource.indexOf('function ConnectionsDrawer'),
  );
  const webCard = web.slice(web.indexOf('function ConnectionCard({'));
  for (const [name, card] of [['app', mobileCard], ['web', webCard]]) {
    assert.ok(card.length > 0, `${name} has no connection card`);
    assert.equal(
      (card.match(/\{error\}/g) || []).length,
      1,
      `exactly one place in the ${name} card should draw the row failure`,
    );
    assert.ok(
      card.indexOf('{error}') > card.indexOf('onDisconnect}'),
      `the ${name} card draws it above the button that produces it`,
    );
  }
  assert.match(mobileCard, /testID=\{`connections\.rowError\.\$\{service\.id\}`\}/);
  assert.match(webCard, /role="alert"/, 'the browser failure is not announced');
});
