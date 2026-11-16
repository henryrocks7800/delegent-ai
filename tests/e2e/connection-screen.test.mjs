import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
function compile(source, dependencies = {}, globals = {}, fileName = 'fixture.ts') {
  const code = ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(globals), code)(name => {
    if (name === '@sidekick/shared') return shared;
    assert.ok(Object.hasOwn(dependencies, name), 'unmocked dependency ' + name); return dependencies[name];
  }, exports, ...Object.values(globals));
  return exports;
}
const logic = compile(read('apps/mobile/src/connections/connections.ts'));
const inventoryLogic = compile(read('apps/mobile/src/connections/connectionInventory.ts'));
const handoffLogic = compile(read('apps/mobile/src/connections/connectionHandoff.ts'), { './connectionInventory': inventoryLogic });
const storeLogic = compile(read('apps/mobile/src/connections/connectionHandoffStore.ts'));
const protocolLogic = compile(read('apps/mobile/src/connections/connectionProtocol.ts'));
// Stands in for AsyncStorage and sessionStorage. Held outside screen() so a
// second mount over the same map is a restart rather than a fresh device.
const memoryStorage = (state = new Map()) => ({ state,
  async getItem(key) { return state.has(key) ? state.get(key) : null; },
  async setItem(key, value) { state.set(key, String(value)); },
  async removeItem(key) { state.delete(key); } });
const native = label => ({ states: [{ provider: 'freeagent', status: 'connected', accountLabel: label, connectedAt: null }], available: ['freeagent'], brokerUnavailable: false });
const composio = (connected = true) => ({ ids: connected ? ['gmail'] : [], offered: ['gmail'],
  connectedAccounts: connected ? [{ id: 'gmail', connectedAccountId: 'ca_fixture' }] : [], brokerUnavailable: false });
const failure = { error: { message: 'Fixture connection read unavailable. Try again.' } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

// The real inventory hook and complete screen bodies run together. Mobile's
// entire named component is extracted with the TS parser because App.tsx also
// boots unrelated native services. No handler or branch is substituted.
function screen(surface, { nativeRead = async () => native('Fixture A'), composioRead = async () => composio(), query = '',
  browserTimeoutMs, storage = memoryStorage(), userId = 'account_fixture', initialUrl = null, preferencesRead = async () => [] } = {}) {
  // Each screen() is a fresh app launch, so nothing is remembered from the last
  // test; remembering within one session has its own tests below.
  inventoryLogic.forgetConnectionInventory();
  const slots = [], effects = [], reads = { native: [], composio: [] }, listeners = {};
  let cursor = 0, mounted = true, lateWrites = 0, tree, params = new URLSearchParams(query);
  const pendingEffects = [];
  const actionCalls = { complete: [], start: [], open: [], disconnect: [], alerts: [] };
  let completeAction = async () => ({ ok: true });
  let startAction = async () => { throw new Error('Unexpected start'); };
  let openAction = async () => {};
  let disconnectAction = async () => ({ ok: true });
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        if (!mounted) lateWrites++;
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0]; },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!effects[index] || !same(effects[index].deps, deps)) {
        const previous = effects[index]; effects[index] = { deps, fn };
        pendingEffects.push(() => { previous?.cleanup?.(); effects[index].cleanup = fn(); });
      }
    },
  };
  const hook = compile(read('apps/mobile/src/connections/useConnectionInventory.ts'), { react, './connectionInventory': inventoryLogic });
  const jsx = (type, props, key) => ({ type, props, key });
  const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
  const surfaceResult = result => surface !== 'web' ? result
    : 'error' in result ? { ok: false, message: result.error.message } : { ok: true, ...result };
  const api = {
    async fetchConnectionStates(options) { reads.native.push(options); return surfaceResult(await nativeRead(options)); },
    async fetchComposioConnections(options) { reads.composio.push(options); return surfaceResult(await composioRead(options)); },
    async completeConnection(...args) { actionCalls.complete.push(args); return completeAction(...args); },
    async startConnection(...args) { actionCalls.start.push(args); return startAction(...args); },
    async startComposioConnection(...args) { actionCalls.start.push(args); return startAction(...args); },
    async disconnectConnection(...args) { actionCalls.disconnect.push(args); return disconnectAction(...args); },
    async disconnectComposioService(...args) { actionCalls.disconnect.push(args); return disconnectAction(...args); },
  };
  const setSearchParams = next => { params = new URLSearchParams(next); };
  let component;
  if (surface === 'web') {
    component = compile(read('apps/webapp/src/features/connections/ConnectionsScreen.tsx'), {
      react, 'react/jsx-runtime': jsxRuntime, 'react-router-dom': { Link: 'Link', useSearchParams: () => [params, setSearchParams] },
      '@mobile-logic/connections/connections': logic, '@mobile-logic/connections/connectionInventory': inventoryLogic,
      '@mobile-logic/connections/useConnectionInventory': hook,
      '../../components/ui': { ConfirmDialog: 'ConfirmDialog', Notice: 'Notice', Screen: 'Screen', Spinner: 'Spinner' },
      '../../lib/useRearmOnBack': { useRearmOnBack() {} }, './connectionsApi': api,
      '@mobile-logic/connections/connectionHandoff': handoffLogic,
      '@mobile-logic/connections/connectionHandoffStore': { ...storeLogic, sessionConnectionHandoffStorage: () => storage },
    }, { window: { location: { assign(url) { actionCalls.open.push(url); } } } }, 'fixture.tsx').ConnectionsScreen;
  } else {
    const source = ts.createSourceFile('App.tsx', read('apps/mobile/App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const named = name => {
      const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(node, 'component/function exists: ' + name); return node.getText(source);
    };
    const addListener = kind => (_event, handle) => { listeners[kind] = handle; return { remove() { delete listeners[kind]; } }; };
    component = compile(named('connectionReturnFromUrl') + '\nexport ' + named('ConnectionsDrawer'), { 'react/jsx-runtime': jsxRuntime }, {
      ...react, ...shared, ...logic, ...inventoryLogic, ...handoffLogic, ...storeLogic, ...hook, ...api,
      connectionHandoffStorage: storage, AsyncStorage: storage,
      loadOnboardingApps: preferencesRead,
      // These fixtures are a workspace account; the agent engine branch is pinned
      // in apps/mobile/android/app/src/test/js/agent-engine-readiness.test.mjs.
      useIsAgentEngine: () => false,
      sameWording: (text) => text,
      connectionRequest: (operation, failure, options) => protocolLogic.connectionRequest(operation, failure, { ...options, timeoutMs: browserTimeoutMs }),
      Stack: 'Stack', Text: 'Text', Button: 'Button', Surface: 'Surface', ConnectionCard: 'ConnectionCard', BrandMarkGlyph: 'BrandMarkGlyph',
      space: { 4: 16 }, styles: { flexText: {} }, Alert: { alert: (...args) => actionCalls.alerts.push(args) },
      Linking: { addEventListener: addListener('url'), openURL: async url => { actionCalls.open.push(url); return openAction(url); } },
      AppState: { addEventListener: addListener('appState') },
      // Only the cold-start read is answered. The poller's peek stays empty, so
      // a relaunched process sees exactly one link, as the platform delivers it.
      readSidekickNativeDeepLink: async method => (method === 'getInitialUrl' ? initialUrl : null),
      setInterval: () => 1, clearInterval() {},
      CONNECTION_RETURN_LINK_GRACE_MS: 1,
    }, 'fixture.tsx').ConnectionsDrawer;
  }
  function render() {
    cursor = 0; tree = component({ visible: true, onStartInChat() {}, userId });
    pendingEffects.splice(0).forEach(run => run());
    const nodes = [], texts = [];
    const visit = node => {
      if (typeof node === 'string') { texts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object') { nodes.push(node); visit(node.props?.children); }
    };
    visit(tree);
    return { nodes, text: texts.join(' '), card: id => nodes.find(node => node.props?.row?.service.id === id),
      byId: id => nodes.find(node => node.props?.testID === id || node.props?.['data-testid'] === id) };
  }
  return { render, reads, listeners, api, actionCalls, storage,
    async settle() { await flush(); await flush(); await flush(); return render(); },
    setNative(fn) { nativeRead = fn; }, setComposio(fn) { composioRead = fn; },
    setQuery(value) { params = new URLSearchParams(value); },
    setComplete(fn) { completeAction = fn; }, setStart(fn) { startAction = fn; }, setOpen(fn) { openAction = fn; },
    setDisconnect(fn) { disconnectAction = fn; },
    confirmDisconnect(id) { render().card(id).props.onDisconnect(); actionCalls.alerts.at(-1)[2][1].onPress(); },
    start(id) {
      const card = render().card(id); assert.ok(card); (card.props.onOpen ?? card.props.onSetUp)();
      const view = render(), button = view.byId(`connections.continue.${id}`);
      if (button) button.props.onPress(); else view.nodes.find(node => node.props?.service?.id === id && node.props.onContinue).props.onContinue();
    },
    retryReturn() { const button = render().byId('connections.returnRetry'); assert.ok(button); (button.props.onPress ?? button.props.onClick)(); },
    retry() { const button = render().byId('connections.retry'); assert.ok(button); (button.props.onPress ?? button.props.onClick)(); },
    unmount() { mounted = false; effects.forEach(effect => effect?.cleanup?.()); },
    replayEffects() { effects.forEach(effect => effect?.cleanup?.()); effects.forEach(effect => { if (effect) effect.cleanup = effect.fn(); }); },
    get lateWrites() { return lateWrites; },
  };
}

for (const surface of ['mobile', 'web']) {
  test(`${surface}: either successful feed renders before the other finishes`, async () => {
    for (const slow of ['native', 'composio']) {
      const wait = deferred();
      const s = screen(surface, slow === 'native' ? { nativeRead: () => wait.promise } : { composioRead: () => wait.promise });
      assert.equal(s.render().nodes.some(node => node.props?.row), false);
      const first = await s.settle();
      assert.equal(s.reads.native.length, 1); assert.equal(s.reads.composio.length, 1);
      assert.equal(first.card(slow === 'native' ? 'gmail' : 'freeagent')?.props.row.status, 'connected');
      wait.resolve(failure); const failed = await s.settle();
      assert.ok(failed.byId('connections.retry')); assert.equal(failed.byId('connections.retry').props.disabled, false);
      assert.equal(failed.card(slow === 'native' ? 'gmail' : 'freeagent')?.props.row.status, 'connected');
      s.unmount();
    }
  });

  test(`${surface}: partial refresh preserves cached cards and a later confirmed empty read clears them`, async () => {
    // Begin with one failed feed to expose the real retry button.
    const s = screen(surface, { nativeRead: async () => failure }); s.render(); await s.settle();
    assert.equal(s.render().card('gmail').props.row.status, 'connected');
    s.setNative(async () => native('Fresh B')); s.setComposio(async () => failure); s.retry();
    // Cards stay visible during the refresh as well as after failure.
    assert.equal(s.render().card('gmail').props.row.status, 'connected');
    const partial = await s.settle();
    assert.equal(partial.card('gmail').props.row.status, 'connected');
    assert.equal(partial.card('freeagent').props.row.detail, 'Fresh B');
    assert.match(partial.text, /last known connection status/);
    assert.ok(partial.byId('connections.retry'));
    s.setComposio(async () => composio(false)); s.retry(); const fresh = await s.settle();
    assert.equal(fresh.card('gmail').props.row.status, 'not_connected');
    assert.equal(fresh.byId('connections.retry'), undefined);
    s.unmount();
  });

  test(`${surface}: offered empty accounts have a card, and opening consent does not clear a read failure`, async () => {
    const s = screen(surface, { nativeRead: async () => failure, composioRead: async () => composio(false) });
    s.render(); const view = await s.settle(); assert.equal(view.card('gmail').props.row.status, 'not_connected');
    (view.card('gmail').props.onOpen ?? view.card('gmail').props.onSetUp)();
    assert.ok(s.render().byId('connections.retry')); assert.match(s.render().text, /Fixture connection read unavailable/);
    s.unmount();
  });

  test(`${surface}: unmount aborts reads and prevents late publication into the retired account`, async () => {
    const wait = deferred();
    const a = screen(surface, { nativeRead: () => wait.promise, composioRead: () => wait.promise }); a.render();
    a.unmount(); assert.ok(a.reads.native[0].signal.aborted); assert.ok(a.reads.composio[0].signal.aborted);
    const b = screen(surface, { nativeRead: async () => native('Account B'), composioRead: async () => composio(false) }); b.render(); await b.settle();
    wait.resolve(native('Account A')); await flush();
    assert.equal(a.lateWrites, 0); assert.equal(b.render().card('freeagent').props.row.detail, 'Account B');
    assert.equal(b.render().card('gmail').props.row.status, 'not_connected'); b.unmount();
  });

  test(`${surface}: StrictMode cleanup/setup remains usable and ignores the older reads`, async () => {
    const old = deferred(); let calls = 0;
    const s = screen(surface, { nativeRead: () => ++calls === 1 ? old.promise : Promise.resolve(native('Newest')) });
    s.render(); s.replayEffects(); await s.settle();
    assert.equal(s.render().card('freeagent').props.row.detail, 'Newest');
    assert.ok(s.reads.native[0].signal.aborted);
    old.resolve(native('Obsolete')); await s.settle(); assert.equal(s.render().card('freeagent').props.row.detail, 'Newest');
    s.unmount();
  });
}

test('web return uses the service-owning feed and retains a retry until that feed answers', async () => {
  const s = screen('web', { query: 'provider=gmail&connected=1', composioRead: async () => failure });
  s.render(); await s.settle();
  assert.equal(s.render().byId('connections.announcement'), undefined);
  assert.doesNotMatch(s.render().text, /nothing was connected/);
  assert.ok(s.render().byId('connections.retry'));
  s.setComposio(async () => composio()); s.retry(); await s.settle();
  assert.ok(s.render().byId('connections.announcement')); s.unmount();
});

test('mobile successful native completion cannot clear a different feed outage', async () => {
  const s = screen('mobile', { composioRead: async () => failure }); s.render(); await s.settle();
  s.listeners.url({ url: 'sidekick://connections/return?provider=freeagent&connection_state=fixture&connection_code=fixture' });
  await s.settle(); assert.ok(s.render().byId('connections.announcement'));
  assert.ok(s.render().byId('connections.retry')); assert.match(s.render().text, /Fixture connection read unavailable/);
  s.unmount();
});

test('mobile cannot confirm a returned connection using its cached native card after a failed read', async () => {
  const s = screen('mobile'); s.render(); await s.settle();
  s.setNative(async () => failure);
  s.listeners.url({ url: 'sidekick://connections/return?provider=freeagent&connection_state=fixture&connection_code=fixture' });
  await s.settle();
  assert.equal(s.render().card('freeagent').props.row.status, 'connected');
  assert.equal(s.render().byId('connections.announcement'), undefined);
  assert.doesNotMatch(s.render().text, /nothing was connected/);
  assert.ok(s.render().byId('connections.retry')); s.unmount();
});

test('mobile retains an acknowledged completion across a failed read, and retry never completes it twice', async () => {
  const s = screen('mobile'); s.render(); await s.settle(); s.setNative(async () => failure);
  const url = 'sidekick://connections/return?provider=freeagent&connection_state=once&connection_code=fixture';
  s.listeners.url({ url }); await s.settle();
  assert.equal(s.actionCalls.complete.length, 1);
  assert.equal(s.render().byId('connections.announcement'), undefined);
  assert.match(s.render().text, /could not confirm whether FreeAgent finished connecting/);
  s.setNative(async () => native('New account')); s.retry(); await s.settle();
  assert.ok(s.render().byId('connections.announcement'));
  assert.equal(s.render().byId('connections.notice'), undefined);
  s.listeners.url({ url }); await s.settle(); assert.equal(s.actionCalls.complete.length, 1);
  s.unmount();
});

test('mobile never announces an existing connection after failed or unknown completion, even on retry', async () => {
  for (const code of ['wrong_account', 'invalid_state', 'complete_unconfirmed', 'store_failed', 'exchange_failed']) {
    const s = screen('mobile'); s.setComplete(async () => ({ code })); s.render(); await s.settle();
    s.listeners.url({ url: 'sidekick://connections/return?provider=freeagent&connection_state=once&connection_code=fixture' });
    await s.settle(); assert.equal(s.render().card('freeagent').props.row.status, 'connected');
    assert.equal(s.render().byId('connections.announcement'), undefined);
    assert.ok(s.render().byId('connections.notice'));
    s.retryReturn(); await s.settle(); assert.equal(s.actionCalls.complete.length, 1);
    assert.equal(s.render().byId('connections.announcement'), undefined);
    if (['complete_unconfirmed', 'store_failed', 'exchange_failed'].includes(code)) {
      assert.match(s.render().text, /could not confirm whether FreeAgent finished connecting/);
      assert.doesNotMatch(s.render().text, /nothing was connected/);
    }
    s.unmount();
  }
});

test('mobile browser context exists before openURL resolves, and late resolution cannot erase its successful return', async () => {
  const browser = deferred();
  const s = screen('mobile', { nativeRead: async () => ({ states: [], available: ['freeagent'], brokerUnavailable: false }) });
  s.setStart(async () => ({ authorizeUrl: 'https://provider.fixture.test?state=fast' }));
  s.setComplete(async () => { s.setNative(async () => native('New account')); return { ok: true }; });
  s.setOpen(() => {
    s.listeners.url({ url: 'sidekick://connections/return?provider=freeagent&connection_state=fast&connection_code=fixture' });
    return browser.promise;
  });
  s.render(); await s.settle(); s.start('freeagent'); await s.settle();
  assert.ok(s.render().byId('connections.announcement')); assert.equal(s.actionCalls.start.length, 1);
  browser.resolve(); await s.settle(); assert.ok(s.render().byId('connections.announcement'));
  assert.equal(s.actionCalls.complete.length, 1); s.unmount();
});

test('mobile Composio return verifies the initiated account id among all active grants, not any old grant', async () => {
  const s = screen('mobile', { composioRead: async () => composio(false) });
  s.setStart(async () => ({ authorizeUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_started' }));
  s.render(); await s.settle(); s.start('gmail'); await s.settle();
  s.setComposio(async () => composio()); s.listeners.appState('active'); await s.settle();
  assert.equal(s.render().byId('connections.announcement'), undefined);
  assert.match(s.render().text, /could not confirm whether Gmail finished connecting/);
  s.setComposio(async () => ({ ...composio(), connectedAccounts: [
    { id: 'gmail', connectedAccountId: 'ca_started' }, ...composio().connectedAccounts,
  ] }));
  s.retryReturn(); await s.settle(); assert.ok(s.render().byId('connections.announcement'));
  assert.equal(s.actionCalls.complete.length, 0); assert.equal(s.actionCalls.start.length, 1); s.unmount();
});

test('mobile refused starts and browser-open failures stay beside the consent button and retain read errors', async () => {
  for (const failureAt of ['start', 'open']) {
    const s = screen('mobile', { composioRead: async () => failure }); s.render(); await s.settle();
    s.setStart(async () => failureAt === 'start' ? { error: { message: 'Fixture start refused' } }
      : { authorizeUrl: 'https://provider.fixture.test?state=refused' });
    s.setOpen(async () => { throw new Error('Fixture browser refused'); });
    s.start('freeagent'); const view = await s.settle();
    assert.match(view.byId('connections.sheetError').props.children,
      failureAt === 'start' ? /Fixture start refused/ : /could not open your browser/);
    assert.ok(view.byId('connections.retry')); assert.match(view.text, /Fixture connection read unavailable/);
    assert.equal(view.byId('connections.notice'), undefined);
    assert.equal(view.byId('connections.continue.freeagent').props.disabled, false);
    assert.equal(s.actionCalls.open.length, failureAt === 'start' ? 0 : 1); s.unmount();
  }
});

test('mobile refused disconnect reaches its own card while preserving the other broker outage', async () => {
  const s = screen('mobile', { composioRead: async () => failure }); s.render(); await s.settle();
  s.setDisconnect(async () => ({ error: { message: 'Fixture disconnect refused' } }));
  s.confirmDisconnect('freeagent'); const view = await s.settle();
  assert.equal(view.card('freeagent').props.error, 'Fixture disconnect refused');
  assert.equal(view.card('freeagent').props.row.status, 'connected');
  assert.ok(view.byId('connections.retry')); assert.match(view.text, /Fixture connection read unavailable/);
  assert.equal(view.byId('connections.notice'), undefined); assert.equal(s.actionCalls.disconnect.length, 1); s.unmount();
});

test('mobile action replies arriving after unmount cannot open a browser or publish state', async () => {
  for (const action of ['start', 'complete']) {
    const response = deferred(); const s = screen('mobile'); s.render(); await s.settle();
    if (action === 'start') { s.setStart(() => response.promise); s.start('gmail'); }
    else { s.setComplete(() => response.promise); s.listeners.url({ url: 'sidekick://connections/return?provider=freeagent&connection_state=late&connection_code=fixture' }); }
    await s.settle(); s.unmount();
    const call = s.actionCalls[action][0]; assert.ok(call.at(-1).signal.aborted);
    response.resolve(action === 'start' ? { authorizeUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_late' } : { ok: true });
    await flush(); assert.equal(s.actionCalls.open.length, 0); assert.equal(s.lateWrites, 0);
  }
});

test('mobile StrictMode action cleanup leaves unknown completion retryable and fences a retired start from a new action', async () => {
  const completion = deferred(); const s = screen('mobile'); s.setComplete(() => completion.promise); s.render(); await s.settle();
  const url = 'sidekick://connections/return?provider=freeagent&connection_state=strict&connection_code=fixture';
  s.listeners.url({ url }); await s.settle(); assert.ok(s.render().byId('connections.finishing'));
  s.replayEffects(); await s.settle(); assert.equal(s.render().byId('connections.finishing'), undefined);
  s.listeners.url({ url }); s.retryReturn(); await s.settle(); assert.equal(s.actionCalls.complete.length, 1);
  completion.resolve({ ok: true }); await s.settle(); assert.equal(s.render().byId('connections.announcement'), undefined); s.unmount();

  const old = deferred(), fresh = deferred(); const t = screen('mobile'); t.render(); await t.settle();
  t.setStart(() => old.promise); t.start('gmail'); await t.settle(); t.replayEffects(); await t.settle();
  t.setStart(() => fresh.promise); t.start('freeagent'); await t.settle();
  old.resolve({ authorizeUrl: 'https://connect.fixture.test', connectedAccountId: 'ca_old' }); await t.settle();
  assert.equal(t.render().byId('connections.continue.freeagent').props.disabled, true);
  assert.equal(t.actionCalls.open.length, 0);
  fresh.resolve({ authorizeUrl: 'https://provider.fixture.test?state=fresh' }); await t.settle();
  assert.equal(t.actionCalls.open.length, 1); t.unmount();
});

test('mobile stalled browser opening releases the button while retaining context for a later real return', async () => {
  const browser = deferred(); const s = screen('mobile', { composioRead: async () => composio(false), browserTimeoutMs: 5 });
  s.setStart(async () => ({ authorizeUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_fixture' }));
  s.setOpen(() => browser.promise); s.render(); await s.settle(); s.start('gmail');
  await new Promise(resolve => setTimeout(resolve, 20)); const view = await s.settle();
  assert.equal(view.byId('connections.continue.gmail').props.disabled, false);
  assert.match(view.text, /could not confirm your browser opened/);
  s.setComposio(async () => composio()); s.listeners.appState('active'); await s.settle();
  assert.ok(s.render().byId('connections.announcement')); browser.resolve(); await s.settle();
  assert.equal(s.actionCalls.start.length, 1); s.unmount();
});

test('mobile disconnect confirmation and completion cannot outlive the signed-in screen', async () => {
  for (const confirmed of [false, true]) {
    const response = deferred(), s = screen('mobile'); s.setDisconnect(() => response.promise); s.render(); await s.settle();
    s.render().card('gmail').props.onDisconnect(); const confirm = s.actionCalls.alerts.at(-1)[2][1].onPress;
    if (confirmed) { confirm(); await s.settle(); }
    s.unmount();
    if (confirmed) {
      assert.ok(s.actionCalls.disconnect[0].at(-1).signal.aborted);
      response.resolve({ ok: true }); await flush(); assert.equal(s.lateWrites, 0);
    } else { confirm(); await flush(); assert.equal(s.actionCalls.disconnect.length, 0); }
  }
});

test('concurrent refreshes ignore both old broker results and only fresh own-broker reads prove status', async () => {
  const oldNative = deferred(), oldComposio = deferred(); let generation = 0;
  const reader = inventoryLogic.createConnectionInventory(() => generation === 0 ? oldNative.promise : Promise.resolve(native('Newest')),
    () => generation === 0 ? oldComposio.promise : Promise.resolve(composio(false)));
  const views = []; const oldRead = reader.refresh(view => views.push(view)); generation = 1;
  const current = await reader.refresh(view => views.push(view)); const count = views.length;
  oldNative.resolve(native('Obsolete')); oldComposio.resolve(composio());
  assert.equal(await oldRead, null); assert.equal(views.length, count);
  assert.equal(current.states[0].accountLabel, 'Newest');
  assert.deepEqual(inventoryLogic.connectionStatesForService(current, shared.findConnectableService('gmail')), []);
  assert.equal(inventoryLogic.connectionStatesForService({ ...current, composio: { ...current.composio, status: 'unreadable', data: composio() } }, shared.findConnectableService('gmail')), null);
  reader.invalidate();
});

test('legacy native availability cannot invent Composio cards or confirm a migrated native grant', async () => {
  const reader = inventoryLogic.createConnectionInventory(async () => ({ ...native('fixture'), available: null,
    states: [...native('fixture').states, { provider: 'gmail', status: 'connected', accountLabel: 'old native grant', connectedAt: null }] }), async () => failure);
  const result = await reader.refresh(() => {});
  assert.deepEqual(result.available, ['freeagent']); assert.deepEqual(result.states.map(row => row.provider), ['freeagent']);
  assert.equal(inventoryLogic.connectionStatesForService(result, shared.findConnectableService('gmail')), null);
  reader.invalidate();
});

test('the real signed-in web route remounts the connection screen for a different account', () => {
  const source = ts.createSourceFile('App.tsx', read('apps/webapp/src/App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SignedInApp');
  assert.ok(component);
  const jsx = (type, props, key) => ({ type, props, key });
  const names = ['Shell', 'Screen', 'Notice', 'ChatSurface', 'Routes', 'Route', 'Navigate', 'FilesScreen', 'RoutinesScreen',
    'ConnectionsScreen', 'SkillsScreen', 'CommandsScreen', 'HelpScreen', 'FaqScreen', 'PlanScreen', 'CapacityScreen',
    'SupportScreen', 'ProfileScreen', 'LegalScreen', 'AdminScreen', 'NotFound', 'FullScreenSpinner', 'OnboardingScreen'];
  const { SignedInApp } = compile('export ' + component.getText(source), {
    'react/jsx-runtime': { jsx, jsxs: jsx },
  }, { ...Object.fromEntries(names.map(name => [name, name])), useProductStateContext: () => ({ status: 'ready' }) }, 'fixture.tsx');
  for (const id of ['account_A', 'account_B']) {
    const tree = SignedInApp({ user: { id } });
    const routes = tree.props.children.find(node => node.type === 'Routes');
    const connection = routes.props.children.find(node => node.props?.path === '/connections').props.element;
    assert.equal(connection.type, 'ConnectionsScreen'); assert.equal(connection.key, id);
  }
});

// ---------------------------------------------------------------------------
// Surviving a restart. Every case below builds a second screen over the SAME
// backing store, which is what the phone being evicted while the reader is at
// the provider, or the browser tab being replaced by a full-page navigation,
// actually leaves behind. Nothing mounted carries over; only the record does.
// ---------------------------------------------------------------------------

const startResultFor = (surface, result) => (surface === 'web' ? { ok: true, ...result } : result);
const composioWith = id => ({ ...composio(), connectedAccounts: [{ id: 'gmail', connectedAccountId: id }] });

async function startComposioHandoff(surface, disk, { userId } = {}) {
  const s = screen(surface, { storage: disk, composioRead: async () => composio(false), ...(userId ? { userId } : {}) });
  s.setStart(async () => startResultFor(surface, { authorizeUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_started' }));
  s.render(); await s.settle(); s.start('gmail'); await s.settle();
  assert.equal(s.actionCalls.open.length, 1);
  return s;
}

for (const surface of ['mobile', 'web']) {
  test(surface + ': a Composio hand-off is recorded before the browser opens, never with a credential', async () => {
    const disk = memoryStorage();
    const s = await startComposioHandoff(surface, disk);
    const written = [...disk.state.values()];
    assert.equal(written.length, 1);
    const record = JSON.parse(written[0]);
    assert.equal(record.serviceId, 'gmail');
    assert.equal(record.backend, 'composio');
    assert.equal(record.connectedAccountId, 'ca_started');
    assert.equal(record.completionSent, false);
    assert.equal(record.receipt, null);
    // The whitelist in the store is what keeps this true: no code, no token,
    // and no stray field a future writer might hang off the same object.
    assert.deepEqual(Object.keys(record).sort(),
      ['attemptId', 'backend', 'completionSent', 'connectedAccountId', 'receipt', 'serviceId', 'startedAt', 'state'].sort());
    s.unmount();
  });

  test(surface + ': a restart confirms the exact grant it started, and an older grant is not it', async () => {
    const disk = memoryStorage();
    (await startComposioHandoff(surface, disk)).unmount();

    // Back to a screen that knows nothing, with only the pre-existing grant.
    const stale = screen(surface, { storage: disk, composioRead: async () => composio() });
    stale.render(); await stale.settle();
    assert.equal(stale.render().byId('connections.announcement'), undefined);
    assert.match(stale.render().text, /could not confirm whether Gmail finished connecting/);
    assert.ok(stale.render().byId('connections.returnRetry'));
    assert.equal(stale.actionCalls.complete.length, 0);
    stale.unmount();

    const landed = screen(surface, { storage: disk, composioRead: async () => composioWith('ca_started') });
    landed.render(); await landed.settle();
    assert.ok(landed.render().byId('connections.announcement'));
    assert.equal(landed.actionCalls.complete.length, 0);
    // Answered once. A third mount must not re-announce it.
    assert.equal(disk.state.size, 0);
    landed.unmount();

    const again = screen(surface, { storage: disk, composioRead: async () => composioWith('ca_started') });
    again.render(); await again.settle();
    assert.equal(again.render().byId('connections.announcement'), undefined);
    again.unmount();
  });

  test(surface + ': another account cannot read or answer for this one and does not disturb it', async () => {
    const disk = memoryStorage();
    (await startComposioHandoff(surface, disk, { userId: 'account_A' })).unmount();
    assert.equal(disk.state.size, 1);

    const other = screen(surface, { storage: disk, userId: 'account_B', composioRead: async () => composioWith('ca_started') });
    other.render(); await other.settle();
    assert.equal(other.render().byId('connections.announcement'), undefined);
    assert.equal(other.render().byId('connections.notice'), undefined);
    other.unmount();

    // Still intact for the account that started it.
    const owner = screen(surface, { storage: disk, userId: 'account_A', composioRead: async () => composioWith('ca_started') });
    owner.render(); await owner.settle();
    assert.ok(owner.render().byId('connections.announcement'));
    owner.unmount();
  });

  test(surface + ': a hand-off older than its lifetime is forgotten rather than answered for', async () => {
    const disk = memoryStorage();
    (await startComposioHandoff(surface, disk)).unmount();
    const [key, value] = [...disk.state.entries()][0];
    const aged = JSON.parse(value);
    aged.startedAt -= storeLogic.CONNECTION_HANDOFF_LIFETIME_MS + 1000;
    disk.state.set(key, JSON.stringify(aged));

    const s = screen(surface, { storage: disk, composioRead: async () => composioWith('ca_started') });
    s.render(); await s.settle();
    assert.equal(s.render().byId('connections.announcement'), undefined);
    assert.equal(s.render().byId('connections.notice'), undefined);
    assert.equal(disk.state.size, 0);
    s.unmount();
  });

  test(surface + ': a new hand-off retires the previous record on disk', async () => {
    const disk = memoryStorage();
    const s = await startComposioHandoff(surface, disk);
    const first = JSON.parse([...disk.state.values()][0]).attemptId;
    s.setStart(async () => startResultFor(surface, { authorizeUrl: 'https://provider.fixture.test?state=second' }));
    s.start('freeagent'); await s.settle();
    assert.equal(disk.state.size, 1);
    const second = JSON.parse([...disk.state.values()][0]);
    assert.equal(second.serviceId, 'freeagent');
    assert.equal(second.backend, 'native');
    assert.equal(second.state, 'second');
    assert.notEqual(second.attemptId, first);
    s.unmount();
  });
}

test('mobile completes a native return that arrives on a cold start, fenced by the record', async () => {
  const disk = memoryStorage();
  const s = screen('mobile', { storage: disk, nativeRead: async () => ({ states: [], available: ['freeagent'], brokerUnavailable: false }) });
  s.setStart(async () => ({ authorizeUrl: 'https://provider.fixture.test?state=coldstart' }));
  s.render(); await s.settle(); s.start('freeagent'); await s.settle();
  s.unmount();

  const link = 'sidekick://connections/return?provider=freeagent&connection_state=coldstart&connection_code=secretcode';
  const relaunched = screen('mobile', { storage: disk, initialUrl: link });
  relaunched.render(); await relaunched.settle();
  assert.equal(relaunched.actionCalls.complete.length, 1);
  assert.deepEqual(relaunched.actionCalls.complete[0].slice(0, 3), ['freeagent', 'coldstart', 'secretcode']);
  assert.ok(relaunched.render().byId('connections.announcement'));
  assert.equal(disk.state.size, 0);
  relaunched.unmount();
});

test('mobile refuses a cold-start return whose state is not the one this account started', async () => {
  const disk = memoryStorage();
  const s = screen('mobile', { storage: disk });
  s.setStart(async () => ({ authorizeUrl: 'https://provider.fixture.test?state=mine' }));
  s.render(); await s.settle(); s.start('freeagent'); await s.settle(); s.unmount();

  const relaunched = screen('mobile', { storage: disk,
    initialUrl: 'sidekick://connections/return?provider=freeagent&connection_state=someone_elses&connection_code=secretcode' });
  relaunched.render(); await relaunched.settle();
  assert.equal(relaunched.actionCalls.complete.length, 0);
  assert.equal(relaunched.render().byId('connections.announcement'), undefined);
  relaunched.unmount();
});

test('mobile never replays a completion that may already have been sent, and keeps a read-only retry', async () => {
  const disk = memoryStorage();
  const stalled = deferred();
  const s = screen('mobile', { storage: disk, nativeRead: async () => ({ states: [], available: ['freeagent'], brokerUnavailable: false }) });
  s.setStart(async () => ({ authorizeUrl: 'https://provider.fixture.test?state=inflight' }));
  s.setComplete(() => stalled.promise);
  s.render(); await s.settle(); s.start('freeagent'); await s.settle();
  const link = 'sidekick://connections/return?provider=freeagent&connection_state=inflight&connection_code=secretcode';
  s.listeners.url({ url: link }); await s.settle();
  assert.equal(s.actionCalls.complete.length, 1);
  // Killed with the exchange still in the air. The record says it went out,
  // and says so without ever having held what was exchanged.
  assert.equal(JSON.parse([...disk.state.values()][0]).completionSent, true);
  assert.doesNotMatch([...disk.state.values()].join(''), /secretcode/);
  s.unmount();

  const relaunched = screen('mobile', { storage: disk, initialUrl: link });
  relaunched.render(); await relaunched.settle();
  assert.equal(relaunched.actionCalls.complete.length, 0);
  assert.equal(relaunched.render().byId('connections.announcement'), undefined);
  assert.match(relaunched.render().text, /could not confirm whether FreeAgent finished connecting/);
  const retry = relaunched.render().byId('connections.returnRetry');
  assert.ok(retry);
  retry.props.onPress(); await relaunched.settle();
  assert.equal(relaunched.actionCalls.complete.length, 0);
  relaunched.unmount();
});

test('web resolves a Composio return that carries no service id from the record it started', async () => {
  for (const [connected, landed] of [['ok', true], ['failed', false]]) {
    const disk = memoryStorage();
    (await startComposioHandoff('web', disk)).unmount();
    const s = screen('web', { storage: disk, query: 'connected=' + connected,
      composioRead: async () => (landed ? composioWith('ca_started') : composio(false)) });
    s.render(); await s.settle();
    if (landed) {
      assert.ok(s.render().byId('connections.announcement'));
      assert.equal(s.render().byId('connections.notice'), undefined);
    } else {
      assert.equal(s.render().byId('connections.announcement'), undefined);
      assert.match(s.render().text, /could not finish connecting Gmail/);
    }
    assert.equal(s.actionCalls.complete.length, 0);
    s.unmount();
  }
});

test('web believes its own read over a Composio callback that claims the grant failed', async () => {
  const disk = memoryStorage();
  (await startComposioHandoff('web', disk)).unmount();
  const s = screen('web', { storage: disk, query: 'connected=failed', composioRead: async () => composioWith('ca_started') });
  s.render(); await s.settle();
  assert.ok(s.render().byId('connections.announcement'));
  assert.doesNotMatch(s.render().text, /could not finish connecting/);
  s.unmount();
});

test('web strips the return out of the address bar and does not re-announce it on a reload', async () => {
  const disk = memoryStorage();
  (await startComposioHandoff('web', disk)).unmount();
  const s = screen('web', { storage: disk, query: 'connected=ok', composioRead: async () => composioWith('ca_started') });
  s.render(); await s.settle();
  assert.ok(s.render().byId('connections.announcement'));
  s.unmount();
  // Same tab, reloaded. The query is gone and so is the record.
  const reloaded = screen('web', { storage: disk, composioRead: async () => composioWith('ca_started') });
  reloaded.render(); await reloaded.settle();
  assert.equal(reloaded.render().byId('connections.announcement'), undefined);
  reloaded.unmount();
});

// The consent sheet is its own component, so the button lives on its props
// rather than in the rendered tree this harness walks.
const sheet = view => view.nodes.find(node => node.props?.service?.id && node.props.onContinue);

test('web holds Continue through the navigation and re-arms it only when the hand-off is refused', async () => {
  // The source contract in apps/webapp/test/recovery.test.mjs says where the
  // clears may live. This says what the reader sees.
  const accepted = screen('web', { composioRead: async () => composio(false) });
  accepted.setStart(async () => ({ ok: true, authorizeUrl: 'https://connect.fixture.test/path', connectedAccountId: 'ca_held' }));
  accepted.render(); await accepted.settle(); accepted.start('gmail'); await accepted.settle();
  assert.equal(accepted.actionCalls.open.length, 1);
  assert.equal(sheet(accepted.render()).props.busy, true,
    'a second press during the unload window mints a second state, and the loser reads as an expired link');
  accepted.unmount();

  for (const refusal of ['refused', 'unusable']) {
    const s = screen('web', { composioRead: async () => composio(false) });
    s.setStart(async () => (refusal === 'refused'
      ? { ok: false, message: 'Fixture start refused' }
      // Accepted, but with no grant id to confirm the return against later.
      : { ok: true, authorizeUrl: 'https://connect.fixture.test/path' }));
    s.render(); await s.settle(); s.start('gmail'); await s.settle();
    assert.equal(s.actionCalls.open.length, 0);
    const consent = sheet(s.render());
    assert.equal(consent.props.busy, false);
    assert.match(consent.props.error, refusal === 'refused' ? /Fixture start refused/ : /could not prepare that connection/);
    s.unmount();
  }
});

// Alex, 2026-09-28: Connections showed two connections and then all of them, on
// every open, because each broker publishes as it answers and a new drawer
// started from nothing. An account's last settled read now fills in for a broker
// that has not answered yet, and the menu reads ahead as it opens.
test('a remembered account opens with every card, still unproven until its own reads', async () => {
  const key = 'account_remembered';
  inventoryLogic.forgetConnectionInventory();
  const first = inventoryLogic.createConnectionInventory(async () => native('Fixture A'), async () => composio(), key);
  await first.refresh(() => {});
  const slowComposio = deferred();
  const second = inventoryLogic.createConnectionInventory(async () => native('Fixture A'), () => slowComposio.promise, key);
  const views = [];
  const running = second.refresh(view => views.push(view));
  await flush();
  const partial = views.at(-1);
  assert.equal(partial.pending, true);
  assert.ok(partial.states.some(state => state.provider === 'gmail'), 'the remembered Composio card stays while that broker is out');
  assert.equal(inventoryLogic.connectionStatesForService(partial, shared.findConnectableService('gmail')), null, 'remembered cards prove nothing about a return');
  slowComposio.resolve(composio());
  const done = await running;
  assert.equal(done.pending, false);
  inventoryLogic.forgetConnectionInventory(key);
  const forgotten = inventoryLogic.createConnectionInventory(async () => native('x'), () => new Promise(() => {}), key);
  assert.equal(forgotten.snapshot().states.length, 0, 'forgetting clears the remembered cards');
  forgotten.invalidate();
});

test('without an account key nothing is remembered (onboarding and the web keep their behaviour)', async () => {
  inventoryLogic.forgetConnectionInventory();
  const reader = inventoryLogic.createConnectionInventory(async () => native('A'), async () => composio());
  await reader.refresh(() => {});
  const next = inventoryLogic.createConnectionInventory(async () => native('A'), () => new Promise(() => {}));
  assert.equal(next.snapshot().states.length, 0);
  next.invalidate();
});

test('the menu prefetch reads once, then skips while the read is fresh', async () => {
  const key = 'account_prefetch';
  inventoryLogic.forgetConnectionInventory();
  let reads = 0;
  const readNative = async () => { reads++; return native('P'); };
  await Promise.all([
    inventoryLogic.prefetchConnectionInventory(key, readNative, async () => composio()),
    inventoryLogic.prefetchConnectionInventory(key, readNative, async () => composio()),
  ]);
  await inventoryLogic.prefetchConnectionInventory(key, readNative, async () => composio());
  assert.equal(reads, 1, 'concurrent and fresh calls share one read');
  const opened = inventoryLogic.createConnectionInventory(async () => native('P'), () => new Promise(() => {}), key);
  assert.ok(opened.snapshot().states.some(state => state.provider === 'gmail'), 'Connections opens complete after the prefetch');
  opened.invalidate();
  inventoryLogic.forgetConnectionInventory();
});
