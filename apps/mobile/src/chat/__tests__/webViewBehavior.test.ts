// Behavioral tests for the WebView chat HTML — these actually evaluate the
// inline <script> in a vm.Context with a minimal DOM shim and verify the
// state machine. Where the sibling WebViewChatScreen.test.tsx only string-
// asserts the HTML, these tests catch race conditions, message-handler
// regressions, and other behavioral bugs.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

const htmlPath = resolve(__dirname, '../../../assets/chat-webview/index.html');

function extractScript(html: string): string {
  // Take the LAST <script> block — that's the runtime, not the inline JSON.
  const matches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(matches.length > 0, 'no <script> found in chat HTML');
  return matches[matches.length - 1][1];
}

interface FakeNode {
  id: string;
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  style: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  dataset: Record<string, string>;
  addEventListener: (..._args: unknown[]) => void;
  classList: {
    add(_c: string): void;
    remove(_c: string): void;
    toggle(_c: string, _force?: boolean): void;
    contains(_c: string): boolean;
  };
  appendChild: (_n: FakeNode) => void;
  click: () => void;
  focus: () => void;
}

function makeNode(id: string): FakeNode {
  // Real class tracking, not a no-op: show/hide is the whole observable
  // behaviour of several components (the long-run card, the quota banner), so a
  // stub classList would let a card that never appears pass its own test.
  const classes = new Set<string>();
  return {
    id,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    placeholder: '',
    disabled: false,
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    addEventListener: () => undefined,
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    appendChild: () => undefined,
    click: () => undefined,
    focus: () => undefined,
  };
}

interface SandboxOptions {
  postedToNative: Array<{ type: string; rest: Record<string, unknown> }>;
  fetchImpl?: (_url: string, _opts?: unknown) => Promise<unknown>;
}

function buildSandbox(options: SandboxOptions): vm.Context {
  const nodes = new Map<string, FakeNode>();
  for (const id of [
    'input', 'sendBtn', 'stopBtn', 'messages', 'modelName', 'statusDot',
    'statusLabel', 'statusSep',
    'resetModal', 'resetConfirm', 'resetDismiss', 'sessionTime',
    'quotaBanner', 'quotaBannerText', 'quotaBannerCta',
    'quotaModal', 'quotaModalTitle', 'quotaModalBody', 'quotaModalCta', 'quotaModalDismiss',
    'attachBtn', 'attachChips',
  ]) {
    nodes.set(id, makeNode(id));
  }

  const listeners: Array<(_e: { data: string }) => void> = [];
  // Queue rather than drop deferred work, so a test can fire it with
  // __runTimers(). Nothing schedules a timer at load, so this stays inert until
  // a test asks for it.
  const timers: Array<() => void> = [];

  const sandbox: Record<string, unknown> = {
    console,
    setInterval: () => undefined,
    clearInterval: () => undefined,
    setTimeout: (fn: unknown) => { if (typeof fn === 'function') timers.push(fn as () => void); return 0; },
    __runTimers: () => { for (const fn of timers.splice(0)) fn(); },
    document: {
      getElementById: (id: string) => nodes.get(id) || makeNode(id),
      addEventListener: () => undefined,
      createElement: (_tag: string) => {
        // Used by the esc() helper which sets textContent then reads
        // innerHTML for HTML-escape. We approximate with a minimal
        // setter/getter that does the entity replacement directly.
        let stored = '';
        return {
          get textContent() { return stored; },
          set textContent(v: string) {
            stored = String(v)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          },
          get innerHTML() { return stored; },
        };
      },
    },
    fetch: options.fetchImpl ?? (async () => ({ ok: false, status: 500, json: async () => ({}) })),
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    Promise,
    Error,
    String,
    TextDecoder: class { decode() { return ''; } },
    MessageEvent: class { data: unknown; constructor(_t: string, init: { data: unknown }) { this.data = init.data; } },
    AbortSignal,
    AbortController: class {
      signal = { aborted: false };
      abort() { (this.signal as { aborted: boolean }).aborted = true; }
    },
  };

  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: (_e: { data: string }) => void) => {
      if (type === 'message') listeners.push(listener);
    },
    dispatchEvent: (event: { data?: string; type?: string }) => {
      if ('data' in event && typeof event.data === 'string') {
        for (const l of listeners) l({ data: event.data });
      }
    },
    ReactNativeWebView: {
      postMessage(serialized: string) {
        try {
          const parsed = JSON.parse(serialized) as { type: string; [k: string]: unknown };
          const { type, ...rest } = parsed;
          options.postedToNative.push({ type, rest });
        } catch { /* ignore */ }
      },
    },
  };
  sandbox.window = window;

  return vm.createContext(sandbox);
}

function runWebViewScript(html: string, options: SandboxOptions): vm.Context {
  const script = extractScript(html);
  const ctx = buildSandbox(options);
  vm.runInContext(script, ctx, { timeout: 2000 });
  return ctx;
}

describe('chat controls and older history', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const setup = (fetchImpl: SandboxOptions['fetchImpl']) => {
    const ctx = runWebViewScript(html, { postedToNative: [], fetchImpl });
    vm.runInContext("Object.assign(bridge.config, { initComplete:true, userId:'owner', apiBaseUrl:'https://test.invalid', accessToken:'test' });", ctx);
    return ctx;
  };
  it('Stop leaves the stream running while cancellation is unconfirmed or refused', async () => {
    let respond!: (value: unknown) => void;
    const requests: string[] = [];
    const ctx = setup(async url => { requests.push(url); return new Promise(resolve => { respond = resolve; }); });
    vm.runInContext("streaming=true; activeAbortController=new AbortController(); messages=[{ id:'a', role:'assistant', taskRunId:'run-a', streaming:true, content:'partial' }];", ctx);
    const stopping = vm.runInContext('stopStreaming()', ctx);
    assert.equal(vm.runInContext('activeAbortController.signal.aborted', ctx), false);
    assert.ok(requests[0].endsWith('/api/chat/runs/run-a/stop'));
    respond({ ok: false, status: 503 });
    await stopping;
    assert.equal(vm.runInContext('activeAbortController.signal.aborted', ctx), false);
    assert.equal(vm.runInContext('streaming', ctx), true);
    assert.equal(vm.runInContext('messages[0].streaming', ctx), true);
  });
  it('Start fresh waits for confirmation, then for the server acknowledgment', async () => {
    let respond!: (value: unknown) => void;
    const requests: unknown[] = [];
    const ctx = setup(async (_url, opts) => { requests.push(opts); return new Promise(resolve => { respond = resolve; }); });
    const resetting = vm.runInContext('startFreshChat()', ctx);
    assert.equal(requests.length, 0);
    vm.runInContext("document.getElementById('resetConfirm').onclick()", ctx);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse((requests[0] as { body: string }).body).confirmed, true);
    assert.equal(vm.runInContext('freshChatMarkers.length', ctx), 0);
    respond({ ok: true });
    await resetting;
    assert.equal(vm.runInContext('freshChatMarkers.length', ctx), 1);
  });
  it('cancelling the reset dialog leaves the conversation intact and sends nothing', async () => {
    let requests = 0;
    const ctx = setup(async () => { requests += 1; return { ok: true }; });
    const resetting = vm.runInContext('startFreshChat()', ctx);
    vm.runInContext("document.getElementById('resetDismiss').onclick()", ctx);
    await resetting;
    assert.equal(requests, 0);
    assert.equal(vm.runInContext('freshChatMarkers.length', ctx), 0);
  });
  it('a typed reset uses the same confirmation and creates no optimistic chat pair', async () => {
    const requests: unknown[] = [];
    const ctx = setup(async (_url, opts) => { requests.push(opts); return {ok: true}; });
    vm.runInContext("$input.value='/reset'", ctx);
    const sending = vm.runInContext('sendMessage()', ctx);
    assert.equal(requests.length, 0);
    assert.equal(vm.runInContext('messages.length', ctx), 0);
    vm.runInContext("document.getElementById('resetConfirm').onclick()", ctx);
    await sending;
    assert.equal(requests.length, 1);
    assert.equal(vm.runInContext("messages.filter(m=>m.role!=='divider').length", ctx), 0);
    assert.equal(vm.runInContext('$input.value', ctx), '');
  });
  it('merging a new page retains older rows and updates the existing reply once', () => {
    const ctx = setup(undefined);
    const result = vm.runInContext(`mergeHistoryPage(
      [{id:'old', role:'user', createdAt:'2026-09-01T10:00:00Z', content:'older'},
       {id:'a-temp', role:'assistant', taskRunId:'task-a', createdAt:'2026-09-02T10:00:00Z', content:'partial'}],
      [{id:'a-stored', role:'assistant', taskRunId:'task-a', createdAt:'2026-09-02T10:00:00Z', content:'complete'}])`, ctx);
    assert.deepEqual(Array.from(result, (m: { id: string }) => m.id), ['old', 'a-stored']);
    assert.equal(result[1].content, 'complete');
  });
  it('loads the next older page using the server cursor and preserves the recent rows', async () => {
    let requested = '';
    const ctx = setup(async url => {
      requested = url;
      return { ok: true, json: async () => ({ messages: [{ id:'old', role:'user', content:'older', createdAt:'2026-09-01T10:00:00Z' }], nextBeforeId:null }) };
    });
    vm.runInContext("messages=[{id:'recent', role:'user', content:'recent', createdAt:'2026-09-02T10:00:00Z'}]; olderHistoryCursor='cursor-id';", ctx);
    await vm.runInContext('loadOlderHistory()', ctx);
    assert.ok(requested.includes('beforeId=cursor-id'));
    assert.equal(vm.runInContext('messages.length', ctx), 2);
    assert.equal(vm.runInContext('messages[0].id', ctx), 'old');
    assert.equal(vm.runInContext('olderHistoryCursor', ctx), null);
  });
});

describe('native review moment after successful work', () => {
  it('waits for streaming, voice and typing to finish before notifying native', () => {
    const postedToNative: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(readFileSync(htmlPath, 'utf8'), { postedToNative });
    postedToNative.length = 0;
    vm.runInContext("bridge.config.userId='account-a'; bridge.config.nativeStoreReview=true; streaming=true; queueNativeReviewMoment(); __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
    vm.runInContext("streaming=false; vm={}; __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
    vm.runInContext("vm=null; voiceState='recording'; __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
    vm.runInContext("voiceState='idle'; $input.value='draft'; __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
    vm.runInContext("$input.value=''; __runTimers();", ctx);
    assert.deepEqual(postedToNative, [{ type: 'store_review_ready', rest: { userId: 'account-a' } }]);
  });
  it('drops a pending completion when the account changes', () => {
    const postedToNative: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(readFileSync(htmlPath, 'utf8'), { postedToNative });
    postedToNative.length = 0;
    vm.runInContext("bridge.config.userId='account-a'; bridge.config.nativeStoreReview=true; queueNativeReviewMoment(); bridge.config.userId='account-b'; __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
  });
  it('the web host never schedules a native review request', () => {
    const postedToNative: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(readFileSync(htmlPath, 'utf8'), { postedToNative });
    postedToNative.length = 0;
    vm.runInContext("queueNativeReviewMoment(); __runTimers();", ctx);
    assert.equal(postedToNative.length, 0);
  });
});

describe('WebView behavior — init handshake', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('starts with initComplete=false and disabled send button', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    const bridge = vm.runInContext('bridge', ctx) as { config: { initComplete: boolean } };
    assert.equal(bridge.config.initComplete, false, 'initComplete must start false');

    // The HTML should have posted 'ready' to native at script bottom
    assert.ok(posted.some((m) => m.type === 'ready'), 'script must post ready to native');
  });

  it('window.__sidekickReceive bridges a synthetic message into the handler', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    const receive = vm.runInContext('window.__sidekickReceive', ctx) as (_p: string) => void;
    assert.equal(typeof receive, 'function', 'window.__sidekickReceive must be exposed');
  });

  it('init message populates bridge.config and flips initComplete to true', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    const initPayload = JSON.stringify({
      type: 'init',
      apiBaseUrl: 'https://example.test/worker',
      accessToken: 'tok_real',
      userId: 'user_xyz',
      agentName: 'Atlas',
      hasActiveSubscription: true,
      hardLimited: false,
      nextResetAtIso: null,
    });
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(initPayload)})`, ctx);

    const bridge = vm.runInContext('bridge', ctx) as { config: { initComplete: boolean; apiBaseUrl: string; userId: string; agentName: string } };
    assert.equal(bridge.config.initComplete, true, 'initComplete must flip to true after init with all 3 fields');
    assert.equal(bridge.config.apiBaseUrl, 'https://example.test/worker');
    assert.equal(bridge.config.userId, 'user_xyz');
    assert.equal(bridge.config.agentName, 'Atlas');
  });

  it('init with empty apiBaseUrl leaves initComplete=false (gates send)', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({
      type: 'init',
      apiBaseUrl: '',
      accessToken: 'tok',
      userId: 'u',
      agentName: 'A',
    }))})`, ctx);
    const bridge = vm.runInContext('bridge', ctx) as { config: { initComplete: boolean } };
    assert.equal(bridge.config.initComplete, false, 'empty apiBaseUrl must NOT mark init complete');
  });

  it('init_failed surfaces a clear placeholder, not a silent failure', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({
      type: 'init_failed',
      reason: 'no_token',
    }))})`, ctx);
    // Verify the placeholder text changed to the recovery hint
    const inputPlaceholder = vm.runInContext(`document.getElementById('input').placeholder`, ctx) as string;
    assert.match(inputPlaceholder, /sign in/i, 'no_token init_failed must show a sign-in hint');
  });

  it('status-bar is the first flex child of #app (so it stays at top during keyboard)', () => {
    // #app is `flex-direction: column`, .status-bar is the first child,
    // .messages is `flex: 1 1 0` (shrinks). That layout keeps the bar
    // pinned to the top of the visible viewport when the keyboard
    // opens. Do NOT use `position: sticky` — on Android System WebView
    // it collapses the row to zero height in a flex parent.
    const stickyRegion = html.match(/\.status-bar\s*\{[^}]+\}/);
    assert.ok(stickyRegion, '.status-bar rule must exist');
    // Only match the CSS declaration (semicolon-terminated), not the
    // explanatory comment that warns against it.
    assert.ok(!/position:\s*sticky\s*;/.test(stickyRegion![0]),
      'avoid position: sticky on Android WebView — collapses the row');
    const messagesRegion = html.match(/\.messages\s*\{[^}]+\}/);
    assert.match(messagesRegion![0], /flex:\s*1\s+1\s+0/,
      '.messages must be flex: 1 1 0 so it absorbs the keyboard delta');
  });

  it('Defect C regression — WebView source object is memoized so productState refreshes do not remount', () => {
    // 2026-05-28 forensic: Alex saw the chat WebView "jumping up and
    // down" during provisioning. Root cause was `source={{ html, baseUrl }}`
    // — a fresh literal each render — which made RN-WebView treat the
    // source as changed and remount + re-bootstrap on every productState
    // poll. The fix is `useMemo` in WebViewChatScreen.tsx. This regression
    // test asserts the structural pattern stays in place.
    const here = fileURLToPath(import.meta.url);
    const screenPath = resolve(here, '../../WebViewChatScreen.tsx');
    const screen = readFileSync(screenPath, 'utf8');
    // useMemo import present.
    assert.match(screen, /\buseMemo\b/);
    // The source prop must reference the memoized variable, not an
    // inline object literal.
    assert.match(screen, /source=\{webViewSource\}/);
    // The memo dependency array must be empty so the source stays
    // stable across the component's entire lifetime (apiBaseUrl is
    // read at construction and doesn't change at runtime).
    assert.match(screen, /useMemo\([\s\S]*?CHAT_WEBVIEW_HTML[\s\S]*?\[\],\s*\)/);
  });

  it('background palette is the light Quiet brand (warm paper canvas + near-black ink)', () => {
    // Rebranded (defects #50/#57): the chat moved OFF the legacy dark Hermes
    // palette onto the light "Quiet" brand so the chat slab matches the rest of
    // the warm off-white mobile shell. So --bg is a light warm paper colour
    // (e.g. #F5F3ED) and --text is a warm near-black ink (e.g. #1C1A15), the
    // inverse of the old dark+cream tokens.
    const bgVar = html.match(/--bg:\s*(#[0-9a-f]+)/i);
    assert.ok(bgVar, '--bg variable must be defined');
    assert.match(bgVar![1], /^#[ef]/i, `--bg should be a light warm paper colour (was ${bgVar![1]})`);
    const textVar = html.match(/--text:\s*(#[0-9a-f]{6})/i);
    assert.ok(textVar, '--text must be defined');
    const textHex = textVar![1].toLowerCase();
    assert.match(textHex, /^#[0-3][0-9a-f]{5}$/i,
      `--text must be a dark warm ink for readability on the light paper bg (was ${textHex})`);
  });

  it('loadHistory shows a "Loading conversation…" placeholder, not the welcome', () => {
    assert.ok(html.includes('historyLoading'), 'must track an in-flight history fetch');
    assert.ok(html.includes('Loading conversation') || html.includes('Loading…'),
      'render() must show a loading placeholder when historyLoading is true');
  });

  it('does NOT advertise or handle slash commands client-side (a /message goes to the agent)', () => {
    // 2026-06-07: we no longer fake or advertise slash commands. The autocomplete
    // drawer must never populate (SLASH_COMMANDS is empty), there is no "/help"
    // welcome hint, and the composer must NOT intercept any /command client-side -
    // every /message is sent to the agent like ordinary text.
    assert.ok(/const SLASH_COMMANDS = \[\s*\]/.test(html), 'SLASH_COMMANDS must be empty (no advertised commands)');
    assert.ok(!html.includes('function maybeHandleClientSlash'), 'maybeHandleClientSlash must be removed');
    assert.ok(!/maybeHandleClientSlash\(/.test(html), 'composer must not intercept slash commands client-side');
    assert.ok(!html.includes('/help for commands'), 'the welcome line must not advertise /help');
  });

  it('loadHistory does NOT reverse the worker response (worker is already asc)', () => {
    // The previous .reverse() inverted chat order when history was
    // re-fetched after a tab change — turned the chat into newest-first.
    const loadFn = html.match(/async function loadHistory[\s\S]*?\n\}/);
    assert.ok(loadFn, 'loadHistory must exist');
    assert.ok(!/\.map\(norm\)\.reverse\(\)/.test(loadFn![0]),
      'loadHistory must not .reverse() — worker returns ascending');
  });

  it('quota_update propagates hardLimited / hasActiveSubscription into bridge', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({
      type: 'quota_update',
      hasActiveSubscription: false,
      hardLimited: false,
      nextResetAtIso: null,
    }))})`, ctx);
    const bridge = vm.runInContext('bridge', ctx) as { config: { hasActiveSubscription: boolean; hardLimited: boolean } };
    assert.equal(bridge.config.hasActiveSubscription, false);
    assert.equal(bridge.config.hardLimited, false);
  });
});

describe('WebView behavior — paperclip attachments (2026-06-05 restore)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('composer markup has a paperclip attach button + chip container', () => {
    assert.ok(/id="attachBtn"/.test(html), 'must have an attachBtn element');
    assert.ok(/class="attach-btn"/.test(html), 'paperclip must use the attach-btn class');
    assert.ok(/id="attachChips"/.test(html), 'must have the attachChips container');
  });

  it('requestAttachment posts pick_attachment to native only after init + active sub', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    // Gated before init — a tap must not open the picker against a dead bridge.
    vm.runInContext('requestAttachment()', ctx);
    assert.ok(!posted.some((m) => m.type === 'pick_attachment'), 'must NOT pick before init');
    vm.runInContext('bridge.config.initComplete = true; bridge.config.hasActiveSubscription = true; bridge.config.hardLimited = false;', ctx);
    vm.runInContext('requestAttachment()', ctx);
    assert.ok(posted.some((m) => m.type === 'pick_attachment'), 'must post pick_attachment once ready');
  });

  it('requestCamera posts pick_camera to native only after init + active sub (camera-to-chat)', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    // Same gate as the paperclip: no camera open against a dead / unpaid bridge.
    vm.runInContext('requestCamera()', ctx);
    assert.ok(!posted.some((m) => m.type === 'pick_camera'), 'must NOT open the camera before init');
    vm.runInContext('bridge.config.initComplete = true; bridge.config.hasActiveSubscription = true; bridge.config.hardLimited = false;', ctx);
    vm.runInContext('requestCamera()', ctx);
    assert.ok(posted.some((m) => m.type === 'pick_camera'), 'must post pick_camera once ready');
  });

  it('attachment_uploading→added stages a ready chip; attachment_error clears it', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({ type: 'attachment_uploading', localId: 'L1', name: 'receipt.jpg' }))})`, ctx);
    let staged = vm.runInContext('stagedAttachments', ctx) as Array<{ status: string; relativeName?: string }>;
    assert.equal(staged.length, 1);
    assert.equal(staged[0].status, 'uploading');
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({ type: 'attachment_added', localId: 'L1', id: 'file_abc', name: 'receipt.jpg', relativeName: 'uploads/receipt.jpg' }))})`, ctx);
    staged = vm.runInContext('stagedAttachments', ctx) as Array<{ status: string; relativeName?: string }>;
    assert.equal(staged[0].status, 'ready');
    assert.equal(staged[0].relativeName, 'uploads/receipt.jpg');
    vm.runInContext(`window.__sidekickReceive(${JSON.stringify(JSON.stringify({ type: 'attachment_error', localId: 'L1', message: 'Upload could not finish.' }))})`, ctx);
    staged = vm.runInContext('stagedAttachments', ctx) as Array<{ status: string; relativeName?: string }>;
    assert.equal(staged.length, 0, 'an upload error must clear the staged chip');
  });

  it('sendMessage with a ready attachment sends the workspace preamble + metadata, then clears staged', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    let captured: { url: string; opts: { body?: string } } | null = null;
    const ctx = runWebViewScript(html, {
      postedToNative: posted,
      fetchImpl: async (url: string, opts?: unknown) => {
        captured = { url, opts: (opts as { body?: string }) || {} };
        return { ok: false, status: 500, json: async () => ({}) };
      },
    });
    vm.runInContext(`
      bridge.config.initComplete = true;
      bridge.config.apiBaseUrl = 'https://example.test';
      bridge.config.userId = 'u1';
      bridge.config.accessToken = 't1';
      bridge.config.hasActiveSubscription = true;
      stagedAttachments = [{ localId:'L1', id:'file_abc', name:'receipt.jpg', relativeName:'uploads/receipt.jpg', mimeType:'image/jpeg', sizeBytes:1234, status:'ready' }];
      $input.value = 'here is my receipt';
    `, ctx);
    vm.runInContext('sendMessage()', ctx);

    const staged = vm.runInContext('stagedAttachments', ctx) as unknown[];
    assert.equal(staged.length, 0, 'staged attachments clear once the send fires');
    assert.ok(captured, 'a fetch must have fired to /api/chat/runs');
    const body = JSON.parse((captured as { opts: { body?: string } }).opts.body || '{}');
    assert.match(body.message, /uploads\/receipt\.jpg/, 'agent message must reference the uploaded file path');
    assert.match(body.message, /here is my receipt/, 'agent message must keep the typed text');
    assert.equal(body.attachments.length, 1, 'attachment metadata must be sent');
    assert.equal(body.attachments[0].name, 'receipt.jpg');
  });

  it('sendMessage refuses to fire while an attachment is still uploading', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    let captured: unknown = null;
    const ctx = runWebViewScript(html, {
      postedToNative: posted,
      fetchImpl: async (url: string, opts?: unknown) => { captured = { url, opts }; return { ok: false, status: 500, json: async () => ({}) }; },
    });
    vm.runInContext(`
      bridge.config.initComplete = true;
      bridge.config.apiBaseUrl = 'https://example.test';
      bridge.config.userId = 'u1';
      bridge.config.accessToken = 't1';
      bridge.config.hasActiveSubscription = true;
      stagedAttachments = [{ localId:'L1', name:'receipt.jpg', status:'uploading' }];
      $input.value = 'process this please';
    `, ctx);
    vm.runInContext('sendMessage()', ctx);
    assert.equal(captured, null, 'must NOT POST while a file is still uploading');
    const messages = vm.runInContext('messages', ctx) as Array<{ content: string }>;
    assert.match(messages[messages.length - 1].content, /uploading/i, 'must surface a "still uploading" hint');
  });
});

describe('WebView behavior — command approval (2026-06-06)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });
  const FENCE = 'String.fromCharCode(96,96,96)'; // ``` evaluated inside the vm

  it('extractApproval pulls the action from a fenced approval block, null otherwise', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const found = vm.runInContext(`extractApproval("Sure.\\n" + ${FENCE} + "approval\\nInstall buku\\n" + ${FENCE})`, ctx) as { action: string } | null;
    assert.equal(found?.action, 'Install buku');
    assert.equal(vm.runInContext(`extractApproval("a normal reply with no block")`, ctx), null);
  });

  it('md strips the raw approval block so it never renders as prose', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const out = vm.runInContext(`md("Before " + ${FENCE} + "approval\\nSECRETACTION\\n" + ${FENCE} + " after")`, ctx) as string;
    assert.ok(!out.includes('SECRETACTION'), 'the approval body must be stripped from the prose (it shows as a card)');
  });

  it('approvalDecision sends the matching reply through the normal send path', () => {
    for (const [kind, re] of [['always', /do not ask me again/i], ['once', /approved/i], ['deny', /don't|no\b/i]] as const) {
      let captured: { body?: string } | null = null;
      const ctx = runWebViewScript(html, {
        postedToNative: [],
        fetchImpl: async (_url: string, opts?: unknown) => { captured = (opts as { body?: string }) || {}; return { ok: false, status: 500, json: async () => ({}) }; },
      });
      vm.runInContext("bridge.config.initComplete = true; bridge.config.apiBaseUrl = 'https://x'; bridge.config.userId = 'u'; bridge.config.accessToken = 't'; bridge.config.hasActiveSubscription = true;", ctx);
      vm.runInContext(`approvalDecision('${kind}')`, ctx);
      assert.ok(captured, `approvalDecision('${kind}') must fire a send`);
      const body = JSON.parse((captured as { body?: string }).body || '{}');
      assert.match(body.message, re, `approvalDecision('${kind}') reply must match ${re}`);
    }
  });

  // 2026-06-14: Hermes' OWN native dangerous-command gate (--accept-hooks) emits
  // free-text "respond with /approve", not our fenced block. We surface the same
  // card, but its buttons must send the LITERAL slash command (prose is a no-op
  // against the gate's threading.Event).
  it('extractHermesApproval detects the native gate prose (all 3 markers) and ignores casual mentions', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const prompt = 'Dangerous command requires approval: rm -rf /tmp/x. Reply /approve to execute, /approve always, or /deny to cancel.';
    const hit = vm.runInContext(`extractHermesApproval(${JSON.stringify(prompt)})`, ctx) as { native?: boolean } | null;
    assert.equal(hit?.native, true, 'native gate prose must be detected');
    // casual mention (missing the other markers) must NOT render a card
    assert.equal(vm.runInContext(`extractHermesApproval("you can respond with /approve later if you like")`, ctx), null);
    assert.equal(vm.runInContext(`extractHermesApproval("a normal reply")`, ctx), null);
  });

  it('approvalDecision(kind, true) sends the LITERAL slash command the gate needs', () => {
    for (const [kind, expected] of [['once', '/approve'], ['always', '/approve always'], ['deny', '/deny']] as const) {
      let captured: { body?: string } | null = null;
      const ctx = runWebViewScript(html, {
        postedToNative: [],
        fetchImpl: async (_url: string, opts?: unknown) => { captured = (opts as { body?: string }) || {}; return { ok: false, status: 500, json: async () => ({}) }; },
      });
      vm.runInContext("bridge.config.initComplete = true; bridge.config.apiBaseUrl = 'https://x'; bridge.config.userId = 'u'; bridge.config.accessToken = 't'; bridge.config.hasActiveSubscription = true;", ctx);
      vm.runInContext(`approvalDecision('${kind}', true)`, ctx);
      const body = JSON.parse((captured as unknown as { body?: string })?.body || '{}');
      assert.equal(body.message, expected, `native approvalDecision('${kind}') must send exactly "${expected}"`);
    }
  });

  // 2026-07-17 (Alex): after "Always approve", the same turn keeps streaming.
  // The resolved card must be FROZEN into the parts stream at the point it was
  // answered, so the continuing tool cards + cursor render BELOW it, not above a
  // card pinned to the message bottom.
  it('gate approval freezes a resolved card into the stream so continuing activity renders BELOW it', async () => {
    const ctx = runWebViewScript(html, {
      postedToNative: [],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    vm.runInContext("bridge.config.initComplete = true; bridge.config.apiBaseUrl='https://x'; bridge.config.userId='u'; bridge.config.accessToken='t'; bridge.config.hasActiveSubscription = true;", ctx);
    vm.runInContext(`
      messages.length = 0;
      messages.push({
        id: 'a1', role: 'assistant', streaming: true, status: 'streaming',
        createdAt: new Date().toISOString(),
        parts: [{ type: 'tool', tool: 'terminal', summary: 'ls', status: 'done', elapsed: null }],
        pendingApproval: { approvalId: 'ap1', command: 'rm x', description: 'delete a file', choices: ['once','always','deny'], resolved: null },
      });
    `, ctx);
    await vm.runInContext(`gateApprovalDecision('ap1','always')`, ctx);
    const state = vm.runInContext(`(function(){ const m = messages[0]; const ap = m.parts.filter(p=>p.type==='approval'); return { pending: m.pendingApproval, count: ap.length, first: ap.length ? ap[0].approval.resolved : null }; })()`, ctx) as { pending: unknown; count: number; first: string | null };
    assert.equal(state.pending, null, 'the trailing pending card must be cleared on resolve');
    assert.equal(state.count, 1, 'exactly one resolved approval part must be frozen into the parts stream');
    assert.equal(state.first, 'always', 'the frozen approval part must record the choice');
    // The turn continues: a newly-streamed tool part must render BELOW the box.
    vm.runInContext(`messages[0].parts.push({ type:'tool', tool:'terminal', summary:'AFTERCARD', status:'running', elapsed:null });`, ctx);
    const bodyHtml = vm.runInContext(`assistantInner(messages[0], true)`, ctx) as string;
    const idxApproval = bodyHtml.indexOf('Always approved');
    const idxAfter = bodyHtml.indexOf('AFTERCARD');
    assert.ok(idxApproval !== -1, 'the resolved approval card must render');
    assert.ok(idxAfter !== -1, 'the continuing activity must render');
    assert.ok(idxAfter > idxApproval, 'continuing activity must render BELOW the resolved approval box');
  });

  // A decision that never reached the backend used to put the card back in
  // silence. The turn is paused on the other side waiting for that decision, so
  // a reader who reads the revert as a glitch and walks away leaves it paused
  // for good. The card has to say so, in the card, under the buttons.
  for (const [label, fetchImpl] of [
    ['a refused POST', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['an unreachable backend', async () => { throw new Error('network'); }],
  ] as Array<[string, () => Promise<unknown>]>) {
    it(`gate approval says so and offers the buttons again after ${label}`, async () => {
      const ctx = runWebViewScript(html, { postedToNative: [], fetchImpl });
      vm.runInContext("bridge.config.initComplete = true; bridge.config.apiBaseUrl='https://x'; bridge.config.userId='u'; bridge.config.accessToken='t'; bridge.config.hasActiveSubscription = true;", ctx);
      vm.runInContext(`
        messages.length = 0;
        messages.push({
          id: 'a1', role: 'assistant', streaming: true, status: 'streaming',
          createdAt: new Date().toISOString(), parts: [],
          pendingApproval: { approvalId: 'ap1', command: 'rm x', description: 'delete a file', choices: ['once','always','deny'], resolved: null },
        });
      `, ctx);
      await vm.runInContext(`gateApprovalDecision('ap1','once')`, ctx);

      const state = vm.runInContext(
        `(function(){ const m = messages[0]; return { pending: !!m.pendingApproval, resolved: m.pendingApproval && m.pendingApproval.resolved, error: m.pendingApproval && m.pendingApproval.error, frozen: (m.parts||[]).filter(p=>p.type==='approval').length }; })()`,
        ctx,
      ) as { pending: boolean; resolved: string | null; error: string | null; frozen: number };
      assert.equal(state.pending, true, 'the card must come back so the decision can be made again');
      assert.equal(state.resolved, null, 'a decision that did not arrive must not be recorded as answered');
      assert.equal(state.frozen, 0, 'the optimistic frozen card must be removed again');
      assert.ok(state.error && state.error.length > 0, 'the failure must be carried on the approval, not dropped');
      assert.match(state.error as string, /nothing has run yet/, 'the reader must be told the command has not run');

      const cardHtml = vm.runInContext(`renderGateApprovalCard(messages[0].pendingApproval)`, ctx) as string;
      assert.match(cardHtml, /home\.chatPanel\.gateApprovalError/, 'the failure must render inside the approval card');
      assert.match(cardHtml, /nothing has run yet/);
      assert.ok(
        cardHtml.indexOf('gateApprovalError') > cardHtml.indexOf('approval-actions'),
        'the failure must sit BELOW the buttons that produced it, not above the card',
      );

      // A second attempt that succeeds must not leave the old failure behind.
      vm.runInContext(`fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });`, ctx);
      await vm.runInContext(`gateApprovalDecision('ap1','once')`, ctx);
      const after = vm.runInContext(
        `(function(){ const p = (messages[0].parts||[]).filter(x=>x.type==='approval'); return { pending: !!messages[0].pendingApproval, error: p.length ? p[0].approval.error : 'missing' }; })()`,
        ctx,
      ) as { pending: boolean; error: string | null };
      assert.equal(after.pending, false, 'a retry that works must resolve the card');
      assert.equal(after.error, null, 'a retry that works must clear the earlier failure');
    });
  }
});

describe('WebView behavior — stop button (v1.3.2)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('HTML defines a stopBtn element next to sendBtn', () => {
    assert.ok(/id="stopBtn"/.test(html), 'must have a stopBtn element');
    assert.ok(/class="send-btn stop-btn hidden"/.test(html),
      'stopBtn must start hidden (mutually exclusive with sendBtn)');
  });

  it('exposes activeAbortController + lastUserMessage state', () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted });
    // Both must be declared and initialised to null at script load.
    const abortCtl = vm.runInContext('activeAbortController', ctx);
    const lastMsg = vm.runInContext('lastUserMessage', ctx);
    assert.equal(abortCtl, null, 'activeAbortController must start null');
    assert.equal(lastMsg, null, 'lastUserMessage must start null');
  });



  it('Stop aborts the local stream only after the runner acknowledges cancellation', async () => {
    const posted: SandboxOptions['postedToNative'] = [];
    const ctx = runWebViewScript(html, { postedToNative: posted, fetchImpl: async () => ({ ok: true }) });
    // Simulate an in-flight stream.
    vm.runInContext(`
      streaming = true;
      activeAbortController = new AbortController();
      messages.push({ id:'a1', taskRunId:'run-a', role:'assistant', content:'partial', status:'queued', streaming:true, createdAt:new Date().toISOString(), toolCalls:[] });
    `, ctx);
    await vm.runInContext(`stopStreaming()`, ctx);

    // After stop, activeAbortController is nulled and streaming flips false.
    const stillStreaming = vm.runInContext('streaming', ctx) as boolean;
    const ctlAfter = vm.runInContext('activeAbortController', ctx);
    assert.equal(stillStreaming, false, 'streaming must clear after stop');
    assert.equal(ctlAfter, null, 'activeAbortController must be nulled after stop');
    // The mid-stream assistant message must be marked failed with a clear note.
    const messages = vm.runInContext('messages', ctx) as Array<{ status: string; content: string; streaming: boolean }>;
    const last = messages[messages.length - 1];
    assert.equal(last.streaming, false);
    assert.equal(last.status, 'failed');
    assert.match(last.content, /Stopped/i, 'stopped message must surface the "Stopped" marker');
  });

  it('showSendOrStop toggles the hidden class based on streaming flag', () => {
    // Pure structural: the function exists and references both buttons +
    // .hidden in both branches. Runtime DOM toggle is observed end-to-end
    // in the emulator smoke test (see docs/AUDIT_RESULTS_2026-05-27.md).
    const fn = html.match(/function showSendOrStop\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fn, 'showSendOrStop must exist');
    assert.ok(/\$sendBtn\.classList\.add\('hidden'\)/.test(fn![0]) &&
              /\$sendBtn\.classList\.remove\('hidden'\)/.test(fn![0]),
      'showSendOrStop must hide/show $sendBtn');
    assert.ok(/\$stopBtn\.classList\.add\('hidden'\)/.test(fn![0]) &&
              /\$stopBtn\.classList\.remove\('hidden'\)/.test(fn![0]),
      'showSendOrStop must hide/show $stopBtn');
  });

});

describe('WebView behavior — streamed Hermes events render (payload.* regression guard)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  // The Worker normalises every Hermes/OpenAI SSE event into our vocabulary and
  // nests the data under `payload`: payload.delta (text chunk), payload.finalText
  // (completed reply), payload.tool / payload.summary (tool calls),
  // payload.message (failures). handleEvent MUST read ev.payload.*. Before the
  // 2026-05-30 fix it read top-level ev.delta / ev.tool / ev.content / ev.error,
  // so assistant bubbles streamed in EMPTY and tool cards showed generic
  // defaults even though the run completed + persisted correctly. These tests
  // drive the real handleEvent reducer with payload-shaped events and would FAIL
  // against that pre-fix code — they are the regression guard for the empty-
  // bubble defect AND the demonstration that tool-calling + chattiness render.
  // As of the sequential-ordering fix, an assistant message is an ORDERED
  // `parts` array ({type:'text'|'tool'|'reasoning'}) rather than a flat content
  // string + toolCalls array, so text and tool calls interleave in true arrival
  // order. These helpers read the equivalent values out of parts.
  type Part = { type: string; text?: string; tool?: string; summary?: string; status?: string };
  type FedMsg = { parts: Part[]; status: string; streaming: boolean };
  const msgText = (m: FedMsg) => (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
  const msgTools = (m: FedMsg) => (m.parts || []).filter((p) => p.type === 'tool');
  function feed(events: Array<Record<string, unknown>>): FedMsg {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    // One empty, streaming assistant placeholder — exactly what sendMessage
    // pushes before the first SSE event arrives (now a `parts` array).
    vm.runInContext(
      `messages.push({ id:'a-stream', role:'assistant', parts:[], status:'queued', streaming:true, createdAt:new Date().toISOString() });`,
      ctx,
    );
    for (const ev of events) {
      vm.runInContext(`handleEvent(${JSON.stringify(ev)}, messages[messages.length-1])`, ctx);
    }
    return vm.runInContext('messages[messages.length-1]', ctx) as FedMsg;
  }

  it('assistant.text.delta appends visible text from payload.delta (empty-bubble regression)', () => {
    const m = feed([
      { type: 'assistant.text.delta', payload: { delta: 'Hi' } },
      { type: 'assistant.text.delta', payload: { delta: ' there' } },
      { type: 'assistant.text.delta', payload: { delta: '!' } },
    ]);
    assert.equal(msgText(m), 'Hi there!',
      'text deltas must accumulate from payload.delta into an ordered text part');
  });

  it('run.completed backfills the full reply from payload.finalText (never a blank bubble)', () => {
    const m = feed([
      { type: 'run.completed', payload: { finalText: 'Hey there! I am Bazzer.' } },
    ]);
    assert.equal(msgText(m), 'Hey there! I am Bazzer.',
      'an empty bubble must be backfilled from run.completed payload.finalText');
    assert.equal(m.status, 'complete');
    assert.equal(m.streaming, false);
  });

  it('text deltas + a terminal run.completed.finalText agree (no duplication / no loss)', () => {
    const m = feed([
      { type: 'assistant.text.delta', payload: { delta: 'Hey there!' } },
      { type: 'run.completed', payload: { finalText: 'Hey there!' } },
    ]);
    assert.equal(msgText(m), 'Hey there!', 'finalText must not double-append already-streamed text');
    assert.equal(m.status, 'complete');
  });

  it('tool.started renders a tool card with the REAL tool name + summary (chattiness)', () => {
    const m = feed([
      { type: 'tool.started', payload: { toolCallId: 'tc1', tool: 'write_file', summary: 'Writing budget.xlsx' } },
    ]);
    const tools = msgTools(m);
    assert.equal(tools.length, 1, 'tool.started must push a tool part');
    assert.equal(tools[0].tool, 'write_file',
      'tool card must show the real tool name from payload.tool, not the generic "tool" default');
    assert.equal(tools[0].summary, 'Writing budget.xlsx');
    assert.equal(tools[0].status, 'running');
  });

  it('tool.started -> tool.completed updates the SAME card to done (tool lifecycle)', () => {
    const m = feed([
      { type: 'tool.started', payload: { toolCallId: 'tc1', tool: 'write_file', summary: 'Writing budget.xlsx' } },
      { type: 'tool.completed', payload: { toolCallId: 'tc1', tool: 'write_file', summary: 'Wrote budget.xlsx (1.2 KB)' } },
    ]);
    const tools = msgTools(m);
    assert.equal(tools.length, 1, 'completion must update the same card, not add a second');
    assert.equal(tools[0].status, 'done');
    assert.equal(tools[0].summary, 'Wrote budget.xlsx (1.2 KB)');
  });

  it('interleaves text and tool calls in TRUE arrival order (the sequential-reply fix)', () => {
    // text "Sure" -> a tool -> more text must render text→tool→text, NOT
    // all-tool-cards-then-all-text (the defect Alex reported: the "let me do
    // that" intro kept getting pinned below the stacked tool cards).
    const m = feed([
      { type: 'assistant.text.delta', payload: { delta: 'Sure, on it.' } },
      { type: 'tool.started', payload: { tool: 'write_file', summary: 'a.txt' } },
      { type: 'tool.completed', payload: { summary: 'a.txt' } },
      { type: 'assistant.text.delta', payload: { delta: ' Done.' } },
    ]);
    // Spread into a test-realm array first: m.parts comes from the vm context,
    // so its Array prototype differs and deepStrictEqual would reject it on
    // prototype alone even when the contents match.
    assert.deepEqual([...m.parts.map((p) => p.type)], ['text', 'tool', 'text'],
      'parts must preserve text→tool→text arrival order');
    assert.equal(m.parts[0].text, 'Sure, on it.');
    assert.equal(m.parts[2].text, ' Done.');
  });

  it('a full tool run (delta -> tool -> delta -> run.completed) renders interleaved text + a done card', () => {
    const m = feed([
      { type: 'assistant.text.delta', payload: { delta: 'On it — building your spreadsheet.' } },
      { type: 'tool.started', payload: { toolCallId: 'tc1', tool: 'write_file', summary: 'Writing budget.xlsx' } },
      { type: 'tool.completed', payload: { toolCallId: 'tc1', tool: 'write_file', summary: 'Wrote budget.xlsx' } },
      { type: 'assistant.text.delta', payload: { delta: ' Done — budget.xlsx is ready.' } },
      { type: 'run.completed', payload: { finalText: 'On it — building your spreadsheet. Done — budget.xlsx is ready.' } },
    ]);
    assert.match(msgText(m), /budget\.xlsx is ready/, 'streamed reply text must render');
    const tools = msgTools(m);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'done', 'the tool card must end in the done state');
    assert.equal(m.status, 'complete');
    // run.completed must NOT duplicate already-streamed text into the bubble.
    assert.equal((msgText(m).match(/On it/g) || []).length, 1, 'no duplication of streamed text on finalize');
  });

  it('run.failed surfaces an honest message from payload.message (never a blank bubble)', () => {
    const m = feed([
      { type: 'run.failed', payload: { errorCode: 'runner_error', message: 'Your coworker took too long to finish that one.' } },
    ]);
    assert.equal(m.status, 'failed');
    assert.match(msgText(m), /took too long/,
      'a failed run with no streamed text must show payload.message, not stay empty');
    assert.equal(m.streaming, false);
  });

  it('still tolerates the legacy top-level event shape (back-compat fallback)', () => {
    const m = feed([
      { type: 'assistant.text.delta', delta: { content: 'legacy ' } },
      { type: 'assistant.text.delta', content: 'shape' },
    ]);
    assert.equal(msgText(m), 'legacy shape',
      'the ev.delta.content / ev.content fallbacks must remain so older runners still render');
  });
});

describe('WebView behavior — chat layout and honest context display', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('auto-scroll only sticks to the bottom when already there (no snap-back on scroll-up)', () => {
    // Alex: scrolling up snapped straight back to the bottom. Every auto-scroll
    // is now gated on isNearBottom() instead of an unconditional
    // scrollTop = scrollHeight on each render / streamed token / keyboard event.
    assert.ok(/function isNearBottom\(\)/.test(html), 'must define isNearBottom()');
    assert.ok(/const wasAtBottom = stuckToBottom \|\| isNearBottom\(\)/.test(html),
      'render/renderActive must capture wasAtBottom before scrolling');
  });

  it('a change of size keeps a reader at the bottom where they were (QA, 2026-09-23)', () => {
    // Android lifts the whole chat for the keyboard, and that resize has already
    // happened by the time any event runs, so "at the bottom?" measured then was
    // always no: the latest messages dropped out of sight as the keyboard opened
    // and replies landed below the fold. The reader's last scroll decides now.
    assert.match(html, /\$messages\.addEventListener\('scroll', \(\) => \{ stuckToBottom = isNearBottom\(\); \}/);
    assert.match(html, /new ResizeObserver\(\(\) => \{ if \(stuckToBottom\) \$messages\.scrollTop = \$messages\.scrollHeight; \}\)\.observe\(\$messages\)/);
  });

  it('keyboard-closed layout fills 100% (no dead band below the message bar)', () => {
    // The chat under-filled when the keyboard was down. #app now fills 100% when
    // closed and only clamps to the visible viewport when the keyboard is open
    // (detected via the tallest viewport seen).
    assert.ok(/let maxViewportHeight = 0/.test(html), 'must track the keyboard-closed height');
    assert.ok(/const keyboardOpen = visualH < maxViewportHeight/.test(html),
      'must detect keyboard-open via the viewport drop');
    assert.ok(/keyboardOpen \? \(visualH \+ 'px'\) : '100%'/.test(html),
      'must fill 100% when the keyboard is closed, clamp only when open');
  });

  it('composer is a single line by default but grows with content', () => {
    // Alex rolled back the 3-line default — a tall box pushed the send button
    // out of alignment. The composer is one line, expanding only when you add
    // line breaks; the freed vertical space goes to the message history (which
    // is flex: 1 1 0, asserted above).
    const rule = html.match(/\.composer-input\s*\{[^}]+\}/);
    assert.ok(rule, '.composer-input rule must exist');
    assert.ok(!/min-height:\s*\d/.test(rule![0]),
      'composer must NOT force a multi-line min-height (single-line default)');
    assert.match(html, /rows="1"/, 'textarea defaults to a single row');
    assert.match(html, /Math\.min\(\$input\.scrollHeight,\s*100\)/,
      'autoResize grows the box with content up to ~100px (multi-line expands naturally)');
  });

  it('does not present display history as a model context meter', () => {
    assert.doesNotMatch(html, /id="contextBarWrap"|id="contextLabel"|id="freshChatNudge"/);
  });

  it('the message box has a label of its own, not just a placeholder (QA, 2026-09-23)', () => {
    assert.match(html, /<textarea[^>]*id="input"[^>]*aria-label="Message your coworker"/);
  });

  it('the status row ends with the coworker name, not a separator with nothing after it (QA, 2026-09-23)', () => {
    const row = html.match(/<div class="status-bar">[\s\S]*?<\/div>/);
    assert.ok(row, 'the status row exists');
    assert.doesNotMatch(row![0].replace(/<!--[\s\S]*?-->/g, ''), /id="modelName">[^<]*<\/span>\s*<span class="sep">/);
  });

});

describe('WebView behavior — markdown XSS hardening (2026-06-10 defect hunt)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  // The shared sandbox's createElement encodes quotes, which real browsers do
  // NOT do for textContent->innerHTML serialization. Swap in a browser-
  // faithful shim so these tests exercise the real attack surface: esc()
  // itself must supply the quote encoding.
  function browserFaithfulContext(): vm.Context {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    (ctx as unknown as { document: { createElement: () => unknown } }).document.createElement = () => {
      let stored = '';
      return {
        get textContent() { return stored; },
        set textContent(v: string) {
          stored = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
        get innerHTML() { return stored; },
      };
    };
    return ctx;
  }

  it('a list is one list: no line breaks between items, and numbered steps keep their numbers (QA, 2026-09-23)', () => {
    const ctx = browserFaithfulContext();
    const bullets = vm.runInContext(`md('- one\\n- two\\n- three\\n\\nThe budget is **£38,500**.')`, ctx) as string;
    assert.match(bullets, /<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/, bullets);
    assert.doesNotMatch(bullets, /<\/li><br>|<br><\/ul>/, 'a <br> inside a list is a blank line between bullets');
    assert.match(bullets, /<\/ul><\/p><p>The budget/, 'a blank line after the list is still a new paragraph');
    const steps = vm.runInContext(`md('To connect Gmail:\\n1. Open Connections.\\n2. Tap Gmail.\\nThen tell me.')`, ctx) as string;
    assert.match(steps, /<ol><li>Open Connections\.<\/li><li>Tap Gmail\.<\/li><\/ol>Then tell me\./, steps);
    assert.doesNotMatch(steps, /data-n/);
  });

  it('esc() encodes both quote styles even when the DOM does not', () => {
    const ctx = browserFaithfulContext();
    const out = vm.runInContext(`esc('a"b\\'c')`, ctx) as string;
    assert.ok(!out.includes('"'), `double quote must be entity-encoded (got ${out})`);
    assert.ok(!out.includes("'"), `single quote must be entity-encoded (got ${out})`);
    assert.ok(out.includes('&quot;') && out.includes('&#39;'), `expected encoded quotes (got ${out})`);
  });

  it('markdown link cannot break out of the href attribute (token-exfil vector)', () => {
    const ctx = browserFaithfulContext();
    const out = vm.runInContext(
      `md('[hi](x" onpointerenter="stealToken(1))')`,
      ctx,
    ) as string;
    assert.ok(!/<a\s[^>]*onpointerenter/.test(out),
      `attribute injection must not survive md() (got ${out})`);
    assert.ok(!out.includes('<a '), `a non-https pseudo-URL must not become an anchor at all (got ${out})`);
  });

  it('javascript:/intent: links render as text; https links stay anchors', () => {
    const ctx = browserFaithfulContext();
    const js = vm.runInContext(`md('[click](javascript:alert(1))')`, ctx) as string;
    assert.ok(!js.includes('<a '), `javascript: must not become an anchor (got ${js})`);
    assert.ok(js.includes('click'), 'the label text must still render');

    const intent = vm.runInContext(`md('[open](intent://scan/#Intent;end)')`, ctx) as string;
    assert.ok(!intent.includes('<a '), `intent: must not become an anchor (got ${intent})`);

    const ok = vm.runInContext(`md('[site](https://example.com/page)')`, ctx) as string;
    assert.ok(ok.includes('<a href="https://example.com/page"'), `https links must still work (got ${ok})`);
    assert.ok(ok.includes('rel="noopener noreferrer"'), 'anchor must keep noopener');
  });

  it('the link rule routes through the safeLinkHref allow-list', () => {
    assert.ok(/function safeLinkHref\(/.test(html), 'safeLinkHref() must exist');
    assert.ok(!/<a href="\$2"/.test(html),
      'the raw $2 href interpolation (pre-allowlist link rule) must be gone');
  });
});

describe('WebView behavior — chat-run idempotency sender (2026-06-10)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('every send mints a clientRunId for the worker replay check (migration 0039)', () => {
    assert.ok(/function mintClientRunId\(/.test(html), 'mintClientRunId() must exist');
    assert.ok(/clientRunId: mintClientRunId\(\)/.test(html),
      'the /api/chat/runs body must carry a fresh clientRunId per send');
  });

  it('mintClientRunId yields a v4-shaped id even without crypto.randomUUID', () => {
    // The sandbox has no window.crypto, so this exercises the fallback path.
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const id = vm.runInContext('mintClientRunId()', ctx) as string;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      `fallback id must be v4-shaped (got ${id})`);
  });
});

describe('WebView behavior — voice tool-call dedup (2026-07-18 Marcelo incident)', () => {
  // Root cause of the 2026-07-18 voice failure: the realtime model over-fired
  // start_task ~3x for one spoken request (two byte-identical), each dispatched
  // with a fresh clientRunId and no dedup, so three concurrent runs collided on
  // the single-session runner and hung. The voice var `vm` is a script-scoped
  // `let`, and the real entry point needs WebRTC, so these lock the two guards
  // in structurally (same style as the mintClientRunId tests above).
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('dedupes voice tool calls by call_id so a re-delivered function_call cannot dispatch twice', () => {
    assert.ok(/handledCallIds/.test(html), 'response.done must track handled call_ids');
    assert.match(html, /handledCallIds\.has\(item\.call_id\)\)\s*continue/,
      'a call_id already handled this session must be skipped, not re-dispatched');
    assert.match(html, /handledCallIds\.add\(item\.call_id\)/,
      'each dispatched call_id must be recorded so a repeat is caught');
  });

  it('collapses an identical start_task burst fired under distinct call_ids (content debounce)', () => {
    assert.match(html, /vm\.lastTaskText === text/,
      'start_task must compare against the last dispatched task text');
    assert.match(html, /status: 'already_started'/,
      'a debounced duplicate must be acknowledged, not started as a second run');
    assert.match(html, /vm\.lastTaskText = text;\s*vm\.lastTaskAt = Date\.now\(\)/,
      'a genuinely-new task must record its text + timestamp for the debounce window');
  });
});

describe('WebView behavior — voice connect ping + proactive greeting (VOICE-1/2)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('plays a connect ping the moment the data channel opens', () => {
    assert.match(html, /function vmPlayConnectPing\(/, 'a connect-ping helper must exist');
    assert.match(html, /dc\.onopen = \(\) => \{[^}]*vmPlayConnectPing\(\)/,
      'the ping must fire on dc.onopen (the audible "connected" cue)');
  });

  it('greets once when the session goes live (proactive opening line)', () => {
    assert.match(html, /t === 'session\.created'/, 'must react to session.created');
    assert.match(html, /vm\.greeted = true/, 'the greeting must be one-shot per session');
    assert.match(html, /type: 'response\.create'/, 'the greeting triggers a response.create');
  });
});

// 2026-09-09 (Alex, Android): the orb greeted twice in quick succession, or
// said "got it, I'll send that to Barry" into silence and filed a task lifted
// from its own instructions. The mic streamed from getUserMedia onwards, so
// the connect chime, the phone being handled and the greeting's own tail all
// reached the turn detector as a phantom first turn. Structural pins, same
// style as the guards above.
describe('WebView behavior — voice start-up mic gate (every platform)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('adds the mic track DISABLED so nothing heard while connecting can become a turn', () => {
    assert.match(html, /getAudioTracks\(\)\.forEach\(\(t\) => \{ t\.enabled = false; \}\)[\s\S]{0,800}pc\.addTrack\(t, mic\)/,
      'the track must be disabled before it is added to the peer connection');
    assert.match(html, /startupDone: false, startupTimer: null/, 'the session object carries the gate state');
  });

  it('keeps Android full duplex after start-up: closing is refused once the gate has opened', () => {
    assert.match(html, /if \(bridge\.config\.platform !== 'ios' && !open && vm\.startupDone\) return;/,
      'Android may only close the mic while the start-up gate is still on');
    assert.match(html, /if \(open\) \{\s*vm\.startupDone = true;/, 'the first open ends the gate');
  });

  it('opens the mic on measured quiet after the greeting, and never later than 12s after connect', () => {
    // Second report the same day: the server-side "stopped" event fires while
    // the phone is still draining the greeting's tail, and an open mic under
    // that tail fed the greeting back in as a turn. Android's start-up gate
    // therefore waits for the analyser to measure silence.
    assert.match(html, /if \(vm && !vm\.startupDone && bridge\.config\.platform !== 'ios'\) vmArmMicReopenWhenQuiet\(\);\s*else vmMicOpen\(true\);/,
      'the Android start-up gate opens on measured quiet, iOS keeps its immediate open');
    assert.match(html, /vm\.startupTimer = setTimeout\(\(\) => \{ if \(vm && !vm\.startupDone\) vmMicOpen\(true\); \}, 12000\);/,
      'a lost greeting must not leave the session deaf');
    assert.match(html, /if \(v\.startupTimer\) clearTimeout\(v\.startupTimer\);/, 'ending the session clears the safety timer');
  });

  it('shows what the session heard, verbatim, from the input transcription', () => {
    assert.match(html, /id="voiceHeard"/, 'the overlay has a "Heard" line');
    assert.match(html, /t === 'conversation\.item\.input_audio_transcription\.completed'/, 'reacts to the transcript event');
    assert.match(html, /\$voiceHeard\.textContent = verdict === 'real' \? `Heard: “\$\{heard\}”`/, 'renders a real transcript verbatim');
    // iOS re-sends audio.input on connect; it must carry the Worker's minted
    // settings (noise reduction AND transcription) or the update drops them
    // (same trap as noise_reduction, 2026-09-08). They are spread from the
    // mint response: the release gate forbids model names in the bundle.
    assert.match(html, /session\.inputAudio/, 'the iOS session.update reads the minted input settings');
    assert.match(html, /\.\.\.minted,[\s\S]{0,300}turn_detection: \{ type: 'server_vad'/,
      'the minted settings are spread first, then only the turn detector is swapped');
    assert.doesNotMatch(html, /gpt-4o-mini-transcribe/, 'no transcription model name in the app bundle');
  });
});

// 2026-09-09, second report the same day, with the start-up gate already on
// the phone: greeting, silence, then "I'll pass that to Barry" and a task
// reading "act as my admin and handle my admin tasks". The turn detector took
// something (echo, room noise) for speech and the server answered it at once.
// Now the server never answers on its own: the phone creates the reply only
// when the turn's transcript shows real words that are not the orb's own line.
describe('WebView behavior — voice replies gated on the transcript', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  function judge(lastSpoken: string, heard: string): string {
    const ctx = vm.createContext({});
    const fnSrc = html.match(/function vmNormWords\([\s\S]*?\n\}\n[\s\S]*?function vmJudgeTranscript\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fnSrc.length > 0, 'vmNormWords + vmJudgeTranscript must exist');
    vm.runInContext(`var vm = { lastSpoken: ${JSON.stringify(lastSpoken)} }; ${fnSrc}`, ctx);
    return vm.runInContext(`vmJudgeTranscript(${JSON.stringify(heard)})`, ctx) as string;
  }

  it('the iOS override also turns create_response off', () => {
    assert.match(html, /type: 'server_vad', threshold: 0\.8, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: false, interrupt_response: true/);
  });

  it('a committed turn is answered only via vmRespond, with a 4s safety timer if no transcript arrives', () => {
    assert.match(html, /t === 'input_audio_buffer\.committed'/, 'reacts to the commit');
    assert.match(html, /vm\.turnTimer = setTimeout\(\(\) => \{ if \(vm && vm\.pendingTurnItem === ev\.item_id\) \{ vm\.pendingTurnItem = null; vmRespond\(\); \} \}, 4000\);/,
      'the safety timer answers a turn whose transcript never came');
    assert.match(html, /t === 'conversation\.item\.input_audio_transcription\.failed'\) \{[\s\S]{0,200}vmRespond\(\);/,
      'a failed transcription still gets a reply, the orb must never go mute');
    assert.match(html, /if \(v\.turnTimer\) clearTimeout\(v\.turnTimer\);/, 'ending the session clears the turn timer');
  });

  it('a real transcript creates the reply; an empty or echoed one deletes the phantom turn and stays listening', () => {
    assert.match(html, /if \(verdict === 'real'\) vmRespond\(\);/, 'real speech gets a reply');
    assert.match(html, /type: 'conversation\.item\.delete', item_id: ev\.item_id/, 'a phantom turn is deleted so the model never sees it');
    assert.match(html, /Heard nothing clear, still listening/, 'silence is named on screen');
    assert.match(html, /Heard my own voice, ignoring it/, 'echo is named on screen');
    assert.match(html, /t === 'response\.output_audio_transcript\.done'\) \{\s*if \(vm\) vm\.lastSpoken = /, 'the orb remembers its own last line');
  });

  it('judges transcripts the way the report needs', () => {
    const greeting = 'What would you like me to pass to Barry?';
    assert.equal(judge(greeting, ''), 'empty', 'silence');
    assert.equal(judge(greeting, '.'), 'empty', 'punctuation only');
    assert.equal(judge(greeting, 'What would you like me to pass to Barry?'), 'echo', 'the greeting fed back in');
    assert.equal(judge(greeting, 'would you like me to pass to'), 'echo', 'a partial echo');
    assert.equal(judge(greeting, 'Yes'), 'real', 'a one-word answer is real');
    assert.equal(judge(greeting, 'Barry'), 'real', 'a one-word name is real');
    assert.equal(judge(greeting, 'Ask Barry to find the weather for today and report it back'), 'real', 'a request sharing a few words with the greeting is real');
    assert.equal(judge('', 'Sort my inbox please'), 'real', 'with nothing spoken yet, real words are real');
  });
});

describe('WebView behavior — orb status text (the orb is the relay, not the agent)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('never labels the orb as the agent speaking', () => {
    assert.doesNotMatch(html, /\$\{bridge\.config\.agentName\} is speaking/,
      'the orb must not say "<agent> is speaking" — the orb speaks, not the agent');
    // The handler grew a body (iOS half-duplex mic gating, 2026-08-13), so
    // anchor the intent, not the old one-line shape: response.created's first
    // act is still the "Speaking…" status.
    assert.match(html, /t === 'response\.created'\) \{\s*\n\s*vmSetStatus\('Speaking…'/,
      'a plain spoken turn shows "Speaking…"');
  });

  it('shows a hand-off status naming the agent when passing a task over', () => {
    assert.match(html, /Passing this to \$\{bridge\.config\.agentName\}/,
      'start_task hand-off reads "Passing this to <agent>"');
  });
});

// 2026-07-26 (Alex, phase 2): making a long wait feel OK. A multi-minute job
// used to show only a ticking "Thinking… · 94s" in the header pill, so there was
// no on-screen answer to "is this still going, can I put my phone down?".
describe('WebView behavior — no long-run card', () => {
  // Removed 2026-09-23 (Alex): built for the old runners' multi-minute jobs; on
  // the fast engine it only turned up where it was not needed.
  it('the "Still working on this" card and its code are gone', () => {
    const html = readFileSync(htmlPath, 'utf8');
    assert.doesNotMatch(html, /id="longRunCard"|paintLongRunNotice|LONG_RUN_NOTICE_SECONDS/);
  });

  it('a finished turn still clears the run clock', () => {
    const html = readFileSync(htmlPath, 'utf8');
    assert.match(html, /if \(!showActivityPill\) runStartedAt = null;/);
  });
});

describe('WebView behavior — cold-start wait label', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('uses the ordinary wait label when the chat is already warm', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`messages = [{ id:'a', role:'assistant', createdAt: new Date(Date.now() - 30000).toISOString() }];`, ctx);
    assert.equal(vm.runInContext('firstWaitLabel()', ctx), 'thinking');
  });

  it('names the cold start after a long gap instead of sitting silent', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const gap = vm.runInContext('COLD_START_GAP_MS', ctx) as number;
    vm.runInContext(`messages = [{ id:'a', role:'assistant', createdAt: new Date(Date.now() - ${gap} - 60000).toISOString() }];`, ctx);
    const label = vm.runInContext('firstWaitLabel()', ctx) as string;
    assert.notEqual(label, 'thinking', 'a cold start must say so rather than reuse the generic label');
    assert.match(label, /waking/i);
  });

  it('does not treat a brand-new chat as a cold start', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`messages = [];`, ctx);
    assert.equal(vm.runInContext('firstWaitLabel()', ctx), 'thinking');
  });

  it('ignores fresh-chat dividers, which carry no real timestamp', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`messages = [{ id:'d', role:'divider' }];`, ctx);
    assert.equal(vm.runInContext('firstWaitLabel()', ctx), 'thinking');
  });

  it('reads the gap before the optimistic user bubble is pushed', () => {
    // Pushing first would always measure a zero gap, silently disabling this.
    assert.match(html, /const waitLabel = firstWaitLabel\(\);\s*\n\s*const optimisticUserMsg/,
      'firstWaitLabel must be called before the optimistic user message is added');
    assert.match(html, /setStatus\('thinking', waitLabel\)/,
      'the computed label must actually be used for the first status');
  });
});

describe('WebView behavior — composer left holding the sent message (2026-07-26)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  function composer(ctx: vm.Context): FakeNode {
    return vm.runInContext(`document.getElementById('input')`, ctx) as FakeNode;
  }

  it('clears text the keyboard re-commits after the send', () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    const sent = 'build me an app that tracks my expenses';
    // What Android does: the composition ends after our handler emptied the box,
    // so the keyboard puts its composing text straight back in.
    composer(ctx).value = sent;
    vm.runInContext(`dropSentTextResidue(${JSON.stringify(sent)}); __runTimers();`, ctx);
    assert.equal(composer(ctx).value, '', 'a copy of the sent message must not be left behind');
  });

  it('clears a partial re-commit, not just the whole message', () => {
    // Keyboards restore only the word they were composing at least as often as
    // they restore the lot.
    const ctx = runWebViewScript(html, { postedToNative: [] });
    composer(ctx).value = 'expenses';
    vm.runInContext(`dropSentTextResidue('build me an app that tracks my expenses'); __runTimers();`, ctx);
    assert.equal(composer(ctx).value, '');
  });

  it('drops a voice-typing re-commit that is LONGER than the sent text and adds punctuation (2026-09-19)', () => {
    // Alex's phone: "Hey how's it going? Tell me what the weather is" was sent,
    // and the keyboard's voice typing then committed its final version, with a
    // closing "?", into the emptied composer. A substring check in one
    // direction let that through.
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`dropSentTextResidue("Hey how's it going? Tell me what the weather is");`, ctx);
    composer(ctx).value = "Hey how's it going? Tell me what the weather is?";
    vm.runInContext(`__runTimers();`, ctx);
    assert.equal(composer(ctx).value, '');
  });

  it('never eats a new message typed straight after sending', () => {
    // This sweep runs a moment after send, so it has to be able to tell residue
    // from real typing. Eating a message would be worse than the bug it fixes.
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`dropSentTextResidue('build me an app');`, ctx);
    composer(ctx).value = 'actually make it a website';
    vm.runInContext(`__runTimers();`, ctx);
    assert.equal(composer(ctx).value, 'actually make it a website', 'genuinely new text must survive');
  });

  it('sweeps the composer as part of sending', () => {
    assert.match(html, /\$input\.value = '';\s*\n\s*autoResize\(\);\s*\n\s*updateSendBtn\(\);\s*\n\s*dropSentTextResidue\(text\);/,
      'the sweep must be wired into sendMessage right after the composer is emptied');
  });
});

describe('WebView behavior — Stop must not cancel a voice-filed run', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  // A task filed by the voice assistant is tracked DETACHED: trackVoiceRun holds
  // no reference to the voice session, so the run survives the session ending and
  // whatever the user does next in the chat. tryStream already honours that by
  // refusing the typed path's abort signal for a detached run. poll() did not:
  // it read the global pollCancelled, which the Stop button sets, so stopping a
  // LATER typed message also killed the voice run's tracking. Its indicator died,
  // its bubble froze half-written, and the real reply only reappeared whenever
  // the 30s ambient history refresh next ran.
  type Bubble = { streaming: boolean };

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  // sleep() resolves through the sandbox's queued setTimeout, so a poll only
  // advances when the test releases it. `releaseSleep` therefore chooses which
  // of poll's two cancellation checks the assertion is looking at: the one
  // before the wait, or the one after it.
  async function startBothPolls(ctx: vm.Context, releaseSleep: boolean) {
    vm.runInContext(`
      var __typed = { id:'a-typed', role:'assistant', parts:[], status:'queued', streaming:true };
      var __voiced = { id:'a-voiced', role:'assistant', parts:[], status:'queued', streaming:true };
      pollCancelled = true;
      poll('run-typed', __typed, { extended: true }).catch(() => {});
      poll('run-voiced', __voiced, { extended: true, detached: true }).catch(() => {});
    `, ctx);
    await settle();
    if (!releaseSleep) return;
    // The stubbed fetch answers 500, which poll treats as "no news" and loops.
    vm.runInContext('__runTimers();', ctx);
    for (let i = 0; i < 8; i++) await settle();
  }

  it('stops the typed run without waiting out the poll interval', async () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    await startBothPolls(ctx, false);
    const typed = vm.runInContext('__typed', ctx) as Bubble;
    assert.equal(typed.streaming, false, 'Stop must end the stopped turn at once, not up to a poll interval later');
  });

  it('leaves the detached voice run tracking across the poll interval', async () => {
    const ctx = runWebViewScript(html, { postedToNative: [] });
    await startBothPolls(ctx, true);
    const voiced = vm.runInContext('__voiced', ctx) as Bubble;
    assert.equal(voiced.streaming, true, 'a voice-filed run must outlive a Stop aimed at the typed composer');
  });

  it('tracks a voice-filed run detached on both the stream and the poll', () => {
    assert.ok(
      html.includes('if (!(await tryStream(runId, aMsg, { detached: true }))) await poll(runId, aMsg, { extended: true, detached: true });'),
      'trackVoiceRun must mark the poll fallback detached too, not just the stream',
    );
  });
});

describe('WebView behavior — a failed send hands the message back (2026-07-29)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  // The failed bubble alone does not keep the user's work: the ambient history
  // refresh rebuilds the list from the server within 30 seconds, and the server
  // never saw this message, so the bubble evaporates. Before this, the typed
  // text and the uploaded chips were consumed at send time and a refusal or a
  // dead network meant retyping the lot.
  function arm(ctx: vm.Context, text: string) {
    vm.runInContext(`
      bridge.config.initComplete = true;
      bridge.config.apiBaseUrl = 'https://example.test';
      bridge.config.userId = 'u1';
      bridge.config.accessToken = 't1';
      bridge.config.hasActiveSubscription = true;
      stagedAttachments = [{ localId:'L1', id:'file_abc', name:'receipt.jpg', relativeName:'uploads/receipt.jpg', mimeType:'image/jpeg', sizeBytes:1234, status:'ready' }];
      $input.value = ${JSON.stringify(text)};
    `, ctx);
  }

  it('a server refusal returns the text and the chips to the composer', async () => {
    const ctx = runWebViewScript(html, {
      postedToNative: [],
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    arm(ctx, 'here is my receipt');
    await vm.runInContext('sendMessage()', ctx);
    assert.equal(vm.runInContext('$input.value', ctx), 'here is my receipt', 'the typed text must come back for the retry');
    const staged = vm.runInContext('stagedAttachments', ctx) as Array<{ id: string; status: string }>;
    assert.equal(staged.length, 1, 'the uploaded chip must be re-staged, not lost');
    assert.equal(staged[0].id, 'file_abc');
    const bubble = vm.runInContext(`messages.find((m) => m.role === 'user')`, ctx) as { status: string };
    assert.equal(bubble.status, 'failed', 'the bubble must still read as unsent');
  });

  it('a network failure hands the work back too', async () => {
    const ctx = runWebViewScript(html, {
      postedToNative: [],
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    arm(ctx, 'quarterly numbers attached');
    await vm.runInContext('sendMessage()', ctx);
    assert.equal(vm.runInContext('$input.value', ctx), 'quarterly numbers attached');
    assert.equal((vm.runInContext('stagedAttachments', ctx) as unknown[]).length, 1);
  });

  it('the keyboard-residue sweep must not eat the restored text', async () => {
    // dropSentTextResidue schedules sweeps at 0ms and 120ms that clear composer
    // text matching what was just sent. A fetch that fails faster than that
    // (instant offline TypeError) restores the text first, and the late sweep
    // would then wipe the restore, because the refill matches sentText exactly.
    const ctx = runWebViewScript(html, {
      postedToNative: [],
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    arm(ctx, 'offline draft');
    await vm.runInContext('sendMessage()', ctx);
    vm.runInContext('__runTimers();', ctx);
    assert.equal(vm.runInContext('$input.value', ctx), 'offline draft',
      'the residue sweep must stand down once the restore has handed the text back');
  });

  it('never overwrites text the user has already started retyping', async () => {
    let ctxRef: vm.Context | null = null;
    const ctx = runWebViewScript(html, {
      postedToNative: [],
      fetchImpl: async () => {
        // The user starts a new draft while the doomed request is in flight.
        if (ctxRef) vm.runInContext(`$input.value = 'a different follow-up';`, ctxRef);
        return { ok: false, status: 500, json: async () => ({}) };
      },
    });
    ctxRef = ctx;
    arm(ctx, 'the original message');
    await vm.runInContext('sendMessage()', ctx);
    assert.equal(vm.runInContext('$input.value', ctx), 'a different follow-up', 'live typing must beat the restore');
  });
});

describe('WebView behavior — voice overlay cannot get stuck on a failed start (2026-07-29)', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(htmlPath, 'utf8'); });

  it('endVoiceMode with no session still hides the overlay', async () => {
    // startVoiceMode shows the overlay BEFORE getUserMedia, so a mic-permission
    // refusal reaches endVoiceMode with vm still null. The old early return
    // left a permanent "Connecting…" screen whose End button was equally dead.
    const ctx = runWebViewScript(html, { postedToNative: [] });
    vm.runInContext(`vmShowOverlay(true);`, ctx);
    assert.equal(vm.runInContext(`$voiceOverlay.classList.contains('hidden')`, ctx), false, 'precondition: overlay showing');
    await vm.runInContext(`endVoiceMode('start_failed')`, ctx);
    assert.equal(vm.runInContext(`$voiceOverlay.classList.contains('hidden')`, ctx), true,
      'a failed start (or the End button) must clear the overlay even before a session exists');
  });
});

/**
 * REGRESSION: nothing may stretch the full width of an iPad.
 *
 * Every rule in this stylesheet was written for a phone column about 390pt
 * wide. On an iPad the same rules run to roughly 1024pt, which reads as "not
 * designed for iPad" under Guideline 4.0 rather than as a bug.
 *
 * A @media (min-width: 700px) block gives the chat a 720px reading column.
 * The trap, and the reason this guard exists: constraining .messages and
 * .composer is NOT enough. Six components look like message content but are
 * actually SIBLINGS of it, direct flex children of #app, so they ignored the
 * reading column entirely and stretched. That was missed on the first pass
 * because the stylesheet reads as though they are nested. Only the DOM shows
 * otherwise.
 *
 * 700px is deliberate: the widest iPhone in landscape is 430pt, so no phone
 * ever crosses it and the shipped phone layout cannot regress.
 */
describe('iPad and wide-screen layout', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const wideBlock = (() => {
    const at = html.indexOf('@media (min-width: 700px)');
    if (at < 0) return '';
    // Walk to the matching brace so assertions cannot drift outside the block.
    const open = html.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < html.length; i += 1) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') {
        depth -= 1;
        if (depth === 0) return html.slice(at, i + 1);
      }
    }
    return '';
  })();

  it('has a reading column for wide viewports', () => {
    assert.ok(wideBlock.length > 0, 'the @media (min-width: 700px) block should exist');
    assert.match(wideBlock, /--chat-column:\s*\d+px/, 'the reading column width should be a variable');
  });

  it('constrains every direct child of #app that renders content', () => {
    // These are siblings of .messages, not children. Each one stretched.
    for (const selector of [
      'status-bar', 'quota-banner', 'attach-chips', 'slash-drawer',
      'toolbar-tour', 'freshchat-nudge',
    ]) {
      // A plain substring check on purpose. A built RegExp here needs its
      // backslashes escaped twice and silently degrades if they are lost:
      // `[,\s{]` became `[,s{]`, which matched a literal "s" and failed only
      // on the first selector, making it look like a CSS bug rather than a
      // test bug.
      assert.ok(
        wideBlock.includes(`.${selector}`),
        `.${selector} is a direct child of #app and is not constrained on wide screens, so it stretches the full iPad width`,
      );
    }
  });

  it('leaves the phone layout untouched', () => {
    // The floor argument of every max() must equal the phone padding, so the
    // narrow case computes to exactly what shipped.
    const maxCalls = [...wideBlock.matchAll(/max\((\d+)px,\s*calc\(\(100% - var\(--chat-column\)\) \/ 2\)\)/g)];
    assert.ok(maxCalls.length >= 6, `expected the max() padding idiom throughout, found ${maxCalls.length}`);
  });

  it('does not widen the quota dialog, which is correct at 340px', () => {
    assert.doesNotMatch(
      wideBlock, /\.quota-modal-card\s*\{[^}]*max-width:\s*var\(--chat-column\)/,
      'the quota dialog is a compact overlay; widening it to the reading column makes it a banner',
    );
  });
});

/**
 * REGRESSION (2026-09-28, found rendering the chat in WebKit): on a 390pt
 * iPhone or a 360dp Android the send button dropped onto a line of its own,
 * bottom left, because the wrapping composer row sized the tools by their full
 * width (`flex: 1 1 auto`) before shrinking. A zero basis keeps send beside
 * the tools, and the narrow-phone rules keep every tool visible.
 * The visual check itself: scripts/ops/chat-render-check.mjs (WebKit + Chrome).
 */
describe('composer on narrow phones', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const rule = (selector: string) => {
    const at = html.indexOf(`${selector} {`);
    return at < 0 ? '' : html.slice(at, html.indexOf('}', at) + 1);
  };

  it('sizes the tools row from zero so send never wraps to its own line', () => {
    assert.match(rule('.composer-tools'), /flex:\s*1 1 0;/);
    assert.match(rule('.composer-tools'), /min-width:\s*0/);
    assert.match(rule('.composer'), /flex-wrap:\s*wrap/);
  });

  it('tightens the tools for narrow phones and lets help step aside on the smallest', () => {
    assert.ok(html.includes('@media (max-width: 400px)'), 'narrow-phone tool spacing');
    assert.ok(html.includes('@media (max-width: 370px)'), 'narrower-phone tool spacing');
    assert.match(html, /@media \(max-width: 340px\) \{\s*\.attach-btn\.help-tool \{ display: none; \}/);
  });
});
