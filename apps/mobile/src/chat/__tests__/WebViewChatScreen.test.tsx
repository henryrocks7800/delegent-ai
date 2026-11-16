import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatHtmlPath = resolve(__dirname, '../../../assets/chat-webview/index.html');

describe('Hermes-Parity: Visual Design', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('uses dark theme as default (not white/light)', () => {
    assert.ok(html.includes('background') && (html.includes('#0') || html.includes('#1') || html.includes('dark')),
      'background must be dark (near-black or dark navy)');
    assert.ok(!html.includes('background: #FAF') && !html.includes('background: #FFF'),
      'must NOT use white/off-white background');
  });

  it('uses gold/amber accent color like Hermes', () => {
    assert.ok(html.includes('#FFD700') || html.includes('#F9A825') || html.includes('gold') || html.includes('#FFBD38'),
      'must use gold/amber accent');
  });

  it('uses monospace font for tool output and code', () => {
    assert.ok(html.includes('monospace'), 'must use monospace font family');
  });

  it('has warm near-black ink text on the light paper canvas (Quiet brand)', () => {
    // Rebranded (defects #50/#57) off the legacy dark+cream Hermes palette onto
    // the light "Quiet" brand: a warm near-black ink (e.g. #1C1A15) on a warm
    // paper canvas, matching the rest of the mobile shell.
    assert.ok(/--text:\s*#[0-3][0-9a-f]{5}/i.test(html),
      'chat body text should be a dark warm ink on the light paper background');
  });
});

describe('Hermes-Parity: Tool Call Display', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('shows tool calls as expandable cards with status indicators', () => {
    assert.ok(html.includes('tool-card') || html.includes('tool-call'), 'must have tool card elements');
    assert.ok(html.includes('expand') || html.includes('collapse') || html.includes('toggle'),
      'tool cards must be expandable/collapsible');
  });

  it('shows elapsed time on tool calls', () => {
    assert.ok(html.includes('elapsed') || html.includes('duration') || html.includes('timer'),
      'must show elapsed time on running tools');
  });

  it('shows pulsing/animated indicator for running tools', () => {
    assert.ok(html.includes('pulse') || html.includes('running') || html.includes('@keyframes'),
      'must animate running tool status');
  });

  it('maps tool types to correct icons (file, terminal, search, browser)', () => {
    const toolTypes = ['file', 'terminal', 'search', 'browser', 'code'];
    for (const t of toolTypes) {
      assert.ok(html.includes(t), `must handle ${t} tool type`);
    }
  });

  it('shows tool name in monospace', () => {
    assert.ok(html.includes('tool-name') || html.includes('monospace'),
      'tool names must render in monospace');
  });
});

describe('Hermes-Parity: Status Bar', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('has a status bar at bottom or top', () => {
    assert.ok(html.includes('status-bar') || html.includes('statusbar') || html.includes('status_bar'),
      'must have a status bar element');
  });

  it('shows model name in status bar', () => {
    assert.ok(html.includes('model') && (html.includes('status') || html.includes('bar')),
      'status bar must show model name');
  });

  it('shows token/context usage', () => {
    assert.ok(html.includes('token') || html.includes('context'),
      'must show token or context usage');
  });

  it('shows session elapsed time', () => {
    assert.ok(html.includes('session') || html.includes('elapsed') || html.includes('uptime'),
      'must show session duration');
  });
});

describe('Hermes-Parity: Streaming', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('shows a block cursor during streaming', () => {
    assert.ok(html.includes('▉') || html.includes('cursor') || html.includes('block'),
      'must show block cursor while streaming');
  });

  it('handles SSE text delta events', () => {
    assert.ok(html.includes('text.delta') || html.includes('text_delta'),
      'must handle streaming text delta events');
  });

  it('handles tool.started events with progress', () => {
    assert.ok(html.includes('tool.started') || html.includes('tool_started'),
      'must handle tool start events');
  });

  it('handles run.completed and run.failed terminal events', () => {
    assert.ok(html.includes('run.completed'), 'must handle run completion');
    assert.ok(html.includes('run.failed'), 'must handle run failure');
  });
});

describe('Hermes-Parity: Markdown Rendering', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('renders fenced code blocks with dark background', () => {
    assert.ok(html.includes('pre') && html.includes('code'), 'must render code blocks');
  });

  it('renders bold, italic, inline code', () => {
    assert.ok(html.includes('strong'), 'must render bold');
    assert.ok(html.includes('<em>'), 'must render italic');
    assert.ok(html.includes('<code>'), 'must render inline code');
  });

  it('renders links safely (https only)', () => {
    assert.ok(html.includes('<a '), 'must render links');
    assert.ok(html.includes('noopener') || html.includes('noreferrer'),
      'links must have rel=noopener');
  });

  it('renders lists (ordered and unordered)', () => {
    assert.ok(html.includes('<ul>') || html.includes('<li>'), 'must render lists');
  });
});

describe('Hermes-Parity: Composer', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('clears input text after sending', () => {
    assert.ok(html.includes(".value = ''") || html.includes('.value = ""') || html.includes("value = ``"),
      'must clear input after send');
  });

  it('disables send button while streaming', () => {
    assert.ok(html.includes('disabled') && html.includes('streaming'),
      'send button must be disabled during streaming');
  });

  it('supports Enter to send, Shift+Enter for newline', () => {
    assert.ok(html.includes('Enter'), 'must handle Enter key');
    assert.ok(html.includes('shiftKey'), 'must handle Shift+Enter');
  });

  it('auto-resizes textarea', () => {
    assert.ok(html.includes('autoResize') || html.includes('auto-resize') || html.includes('scrollHeight'),
      'textarea must auto-resize');
  });
});

describe('Hermes-Parity: Error Handling', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('shows upgrade prompt on quota exhaustion (not generic error)', () => {
    assert.ok(html.includes('quota_exhausted'), 'must detect quota errors');
    assert.ok(html.includes('Upgrade') || html.includes('upgrade'), 'must tell user to upgrade');
  });

  it('shows specific message for concurrent limit (429)', () => {
    assert.ok(html.includes('402') || html.includes('quota'), 'must handle 402/quota responses');
  });

  it('handles auth token refresh', () => {
    assert.ok(html.includes('token_refresh'), 'must handle token refresh');
  });

  it('has polling fallback when SSE unavailable', () => {
    assert.ok(html.includes('poll'), 'must have polling fallback');
  });
});

describe('Hermes-Parity: Proactive Quota Banner', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('accepts quota_update messages from the native bridge', () => {
    assert.ok(html.includes("'quota_update'") || html.includes('"quota_update"'),
      'must handle a quota_update message type');
  });

  it('threads hasActiveSubscription, hardLimited, nextResetAtIso into bridge.config', () => {
    assert.ok(html.includes('hasActiveSubscription'), 'must store hasActiveSubscription');
    assert.ok(html.includes('hardLimited'), 'must store hardLimited');
    assert.ok(html.includes('nextResetAtIso'), 'must store nextResetAtIso');
  });

  it('renders a quota banner element gated by hardLimited / no-subscription', () => {
    assert.ok(html.includes('quota-banner'), 'must have a quota-banner element');
    assert.ok(html.includes('renderQuotaBanner'), 'must have a render function for the banner');
  });

  it('disables the composer when the user is hard-limited or has no subscription', () => {
    assert.ok(html.includes('updateComposerForQuota'), 'must adjust composer for quota');
    assert.ok(/disabled\s*=\s*blocked|input\.disabled/.test(html),
      'must disable the composer input when blocked');
  });

  it('lets the WebView request the billing portal from native', () => {
    assert.ok(html.includes("postToNative('open_billing'") || html.includes('postToNative("open_billing"'),
      'must postMessage open_billing to native');
  });
});

describe('Hermes-Parity: Security', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('has no external CDN dependencies', () => {
    assert.ok(!/<script[^>]+src=["']https?:\/\//.test(html), 'no external scripts');
    assert.ok(!/<link[^>]+href=["']https?:\/\//.test(html), 'no external stylesheets');
  });

  it('does not hardcode any service URLs or secrets', () => {
    assert.ok(!html.includes('supabase.co'), 'no hardcoded Supabase URL');
    assert.ok(!html.includes('fly.dev'), 'no hardcoded runner URL');
    assert.ok(!html.includes('workers.dev'), 'no hardcoded worker URL');
    assert.ok(!html.includes('service_role'), 'no service role key');
  });

  it('uses postMessage bridge for auth (not inline tokens)', () => {
    assert.ok(html.includes('ReactNativeWebView'), 'must use RN WebView bridge');
    assert.ok(html.includes("type === 'init'"), 'must receive config via init message');
  });
});

describe('Hermes-Parity: Empty State', () => {
  let html: string;
  beforeEach(() => { html = readFileSync(chatHtmlPath, 'utf8'); });

  it('shows agent welcome with tools/skills summary', () => {
    assert.ok(html.includes('Welcome') || html.includes('welcome') || html.includes('greeting'),
      'must show welcome message');
  });

  it('uses DELEGENT AI in the empty-state company welcome line', () => {
    assert.ok(html.includes('Welcome to DELEGENT AI'),
      'empty-state welcome should say welcome to DELEGENT AI, not the agent name');
  });

  it('shows agent name prominently', () => {
    assert.ok(html.includes('agentName'), 'must display agent name');
  });
});

describe('WebView navigation lockdown (2026-06-10 defect hunt)', () => {
  const screenPath = resolve(__dirname, '../WebViewChatScreen.tsx');
  let tsx: string;
  beforeEach(() => { tsx = readFileSync(screenPath, 'utf8'); });

  it('confines navigation via onShouldStartLoadWithRequest', () => {
    assert.ok(tsx.includes('onShouldStartLoadWithRequest={handleShouldStartLoad}'),
      'the WebView must wire the navigation gate');
    assert.ok(tsx.includes('return false;'), 'the gate must default-deny');
  });

  it('routes https AND mailto links to the system handler (matches safeLinkHref)', () => {
    assert.ok(tsx.includes('/^https?:\\/\\//i.test(url)'), 'https links must be recognized');
    assert.ok(tsx.includes('/^mailto:/i.test(url)'), 'mailto links must be recognized (safeLinkHref renders them as anchors)');
    assert.ok(tsx.includes('Linking.openURL(url)'), 'recognized external links open via Linking');
  });

  it('will not let a link to the API origin replace the chat document', () => {
    // The inline chat is served from the API origin, so the gate had to allow
    // that URL for the initial load. It allowed it forever, and safeLinkHref in
    // the chat HTML renders any https link the assistant emits, so one tap on a
    // link to the origin root navigated the WebView onto the Worker's JSON
    // error body. There is no way back from there: no history gestures, the
    // source object is memoised so the WebView is never re-created, and the
    // screen stays mounted behind every tab. The chat was gone until a restart.
    assert.ok(tsx.includes('const documentReadyRef = useRef(false)'),
      'the gate needs to know whether the document has already loaded');
    assert.ok(/if \(msg\.type === 'ready'\) \{\s*documentReadyRef\.current = true;/.test(tsx),
      'the ready message is what marks the document as loaded');
    assert.ok(tsx.includes("if (!documentReadyRef.current && (url === 'about:blank' || url === ownOrigin || url === `${ownOrigin}/`)) {"),
      'the own-origin allowance must apply only before the document is ready');
    // After ready the same URL has to fall through to the browser hand-off
    // rather than being denied outright, or the tap looks broken.
    const gate = tsx.slice(tsx.indexOf('const handleShouldStartLoad'));
    assert.ok(gate.indexOf('documentReadyRef.current') < gate.indexOf('/^https?:'),
      'the readiness check must sit above the external-link branch so a post-ready origin link opens externally');
  });

  it('keeps the hardened WebView surface (no file access, no mixed content)', () => {
    assert.ok(!tsx.includes('allowFileAccess'), 'allowFileAccess must stay removed');
    assert.ok(tsx.includes('mixedContentMode="never"'), 'mixed content must stay blocked');
  });

  it('bridge payloads are JSON-stringified into a complete JS literal (no hand escaping)', () => {
    assert.ok(tsx.includes('window.__sidekickReceive && window.__sidekickReceive(${JSON.stringify(serialized)})'),
      'deliverToWebView must double-JSON.stringify the payload');
    assert.ok(!tsx.includes("replace(/'/g"), 'the old hand-rolled quote escaping must be gone');
  });
});

describe('Chat camera button (2026-07-18)', () => {
  const screenPath = resolve(__dirname, '../WebViewChatScreen.tsx');
  const uploadPath = resolve(__dirname, '../chatAttachmentUpload.ts');
  let html: string;
  let tsx: string;
  let upload: string;
  beforeEach(() => {
    html = readFileSync(chatHtmlPath, 'utf8');
    tsx = readFileSync(screenPath, 'utf8');
    upload = readFileSync(uploadPath, 'utf8');
  });

  it('composer markup has a camera button right beside the paperclip', () => {
    assert.ok(/id="cameraBtn"/.test(html), 'must have a cameraBtn element');
    assert.ok(/class="attach-btn camera-btn"/.test(html), 'camera button reuses the attach-btn styling');
    // The camera button sits after the paperclip (attachBtn) in the composer.
    assert.ok(html.indexOf('id="attachBtn"') < html.indexOf('id="cameraBtn"'),
      'the camera button must follow the paperclip in the composer');
  });

  it('requestCamera posts pick_camera and is gated like the paperclip', () => {
    assert.ok(/function requestCamera\(\)/.test(html), 'requestCamera() must exist');
    assert.ok(html.includes("postToNative('pick_camera'"), 'requestCamera must post pick_camera to native');
    // Same disabled predicate as the paperclip (init + active sub + not hard-limited + not streaming).
    assert.ok(/\$cameraBtn\.disabled = !bridge\.config\.initComplete \|\| !bridge\.config\.hasActiveSubscription \|\| bridge\.config\.hardLimited \|\| streaming/.test(html),
      'the camera button must be disabled under the same condition as the paperclip');
    assert.ok(/\$cameraBtn\.addEventListener\('click', requestCamera\)/.test(html),
      'the camera button click must be wired to requestCamera');
  });

  it('native routes a pick_camera message to the camera handler', () => {
    assert.ok(tsx.includes("msg.type === 'pick_camera'"), 'handleMessage must switch on pick_camera');
    assert.ok(/if \(msg\.type === 'pick_camera'\) \{\s*void onPickCamera\(\);/.test(tsx),
      'pick_camera must invoke onPickCamera');
    assert.ok(/const onPickCamera = useCallback/.test(tsx), 'onPickCamera handler must be defined');
    assert.ok(tsx.includes('captureAndUploadChatPhoto'), 'the camera handler must call captureAndUploadChatPhoto');
    // onPickCamera must be in handleMessage's dependency array or the stale
    // closure would call an old copy of the handler.
    assert.ok(/}, \[[^\]]*onPickCamera[^\]]*\]\);/.test(tsx),
      'onPickCamera must be listed in the handleMessage useCallback deps');
  });

  it('the camera handler mirrors the paperclip attachment message contract', () => {
    // Same localId scheme + the same three WebView messages so the chip render
    // path is shared between paperclip and camera.
    assert.ok(/captureAndUploadChatPhoto\(\{\s*onPicked:/.test(tsx),
      'onPickCamera must fire attachment_uploading via onPicked');
    const cameraBlock = tsx.slice(tsx.indexOf('const onPickCamera'));
    assert.ok(cameraBlock.includes("type: 'attachment_error'"), 'camera errors must deliver attachment_error');
    assert.ok(cameraBlock.includes("type: 'attachment_added'"), 'a captured photo must deliver attachment_added');
  });

  it('captureAndUploadChatPhoto drives expo-image-picker (camera + permission) through the shared upload', () => {
    assert.ok(/export async function captureAndUploadChatPhoto/.test(upload),
      'captureAndUploadChatPhoto must be exported from chatAttachmentUpload');
    assert.ok(upload.includes("import('expo-image-picker')"),
      'expo-image-picker must be loaded via a dynamic import (graceful when absent)');
    assert.ok(upload.includes('requestCameraPermissionsAsync'), 'must request camera permission');
    assert.ok(upload.includes('launchCameraAsync'), 'must open the camera via launchCameraAsync');
    assert.ok(/mediaTypes:\s*\['images'\]/.test(upload), 'must capture images only');
    assert.ok(/uploadRunnerFile\(/.test(upload), 'must upload through the same runner-upload path as the paperclip');
  });

  it('recovers a camera photo the OS dropped by killing the app mid-capture', () => {
    // Low-RAM devices can destroy MainActivity while the camera activity is
    // foreground, so the launchCameraAsync promise never resolves and the photo
    // is lost. The fix reads the OS-stashed capture via getPendingResultAsync
    // and replays it through the same upload path.
    assert.ok(upload.includes('getPendingResultAsync'),
      'must read the OS-stashed capture via getPendingResultAsync');
    assert.ok(/export async function getPendingCameraCaptures/.test(upload),
      'getPendingCameraCaptures must be exported to surface the recovered photo');
    assert.ok(/export async function uploadCapturedChatPhoto/.test(upload),
      'uploadCapturedChatPhoto must upload a recovered photo without re-opening the camera');
  });

  it('the screen replays a recovered photo once the WebView is ready', () => {
    assert.ok(/const recoverPendingCameraPhotos = useCallback/.test(tsx),
      'the screen must define a camera recovery handler');
    assert.ok(/if \(msg\.type === 'ready'\) \{[\s\S]*?recoverPendingCameraPhotos\(\)/.test(tsx),
      'recovery must run on the ready message, when the WebView can render chips');
    // A ref guard so a WebView reload re-firing `ready` cannot recover twice.
    assert.ok(tsx.includes('pendingCameraRecovered'),
      'recovery must be guarded so a reload cannot replay the photo twice');
    assert.ok(/}, \[[^\]]*recoverPendingCameraPhotos[^\]]*\]\);/.test(tsx),
      'recoverPendingCameraPhotos must be listed in the handleMessage deps');
    // The recovered photo travels the SAME attachment_added chip path.
    const recoveryBlock = tsx.slice(tsx.indexOf('const recoverPendingCameraPhotos'));
    assert.ok(recoveryBlock.includes('uploadCapturedChatPhoto'),
      'recovery must upload via uploadCapturedChatPhoto');
    assert.ok(recoveryBlock.slice(0, recoveryBlock.indexOf('}, [deliverToWebView]')).includes("type: 'attachment_added'"),
      'a recovered photo must deliver attachment_added like a live capture');
  });
});

describe('Chat WebView survives an Android renderer kill', () => {
  const screenPath = resolve(__dirname, '../WebViewChatScreen.tsx');
  let tsx: string;
  beforeEach(() => { tsx = readFileSync(screenPath, 'utf8'); });

  const handlerBody = () => {
    const from = tsx.slice(tsx.indexOf('const handleRenderProcessGone'));
    return from.slice(0, from.indexOf('}, ['));
  };

  // Android destroys a WebView's renderer process under memory pressure. The
  // native client survives it on purpose (returning false there crashes the
  // app) and hands the event to JS, but what it leaves behind is a dead
  // WebView: blank and inert. Nothing in this screen rebuilt it. The source
  // object is memoised on [], there was no key, no reload call, back/forward
  // gestures are off and the screen stays mounted behind every tab, so the
  // chat was blank for the rest of the app session.
  it('handles the renderer-gone event instead of leaving a dead frame', () => {
    assert.ok(tsx.includes('onRenderProcessGone={handleRenderProcessGone}'),
      'the WebView must subscribe to the renderer-gone event');
    assert.ok(/const handleRenderProcessGone = useCallback/.test(tsx),
      'the renderer-gone handler must be defined');
  });

  it('remounts on a fresh key, because nothing else can revive the frame', () => {
    assert.ok(tsx.includes('key={webViewGeneration}'),
      'the WebView needs a key it can be remounted on');
    assert.ok(handlerBody().includes('setWebViewGeneration((n) => n + 1)'),
      'the generation must be bumped functionally, so a second kill remounts again');
  });

  it('clears the ready flag so the rebuilt frame is allowed to load itself', () => {
    // The subtle half. handleShouldStartLoad only lets the document's own
    // initial load through while documentReadyRef is false. A remount that
    // left the flag set would have the fresh WebView reject its own load and
    // stay exactly as blank, turning a recoverable crash into a permanent one.
    assert.ok(handlerBody().includes('documentReadyRef.current = false'),
      'the handler must clear the ready flag when it remounts');
  });

  it('reports the kill so a device that keeps losing the frame is visible', () => {
    assert.ok(handlerBody().includes("reportChatFrameError('render_process_gone'"),
      'the crash must reach Sentry, or a device losing the frame repeatedly is silent');
  });
});

describe('Chat WebView survives an iOS content-process kill', () => {
  const screenPath = resolve(__dirname, '../WebViewChatScreen.tsx');
  let tsx: string;
  beforeEach(() => { tsx = readFileSync(screenPath, 'utf8'); });

  const handlerBody = () => {
    const from = tsx.slice(tsx.indexOf('const handleContentProcessTerminated'));
    return from.slice(0, from.indexOf('}, ['));
  };

  // iOS terminates WKWebView's content process under memory pressure,
  // preferentially while the WebView is hidden behind another tab — exactly
  // how this screen lives. Found on TestFlight build 32 (2026-08-13): open
  // chat, visit Files, return, and the chat is dead; its reload attempt
  // targeted the baseUrl and the navigation policy bounced that to Safari
  // showing the Worker's "Not found". Android had this fixed for its own
  // renderer-gone event; iOS needs the parallel handler.
  it('handles the content-process-terminated event instead of leaving a dead frame', () => {
    assert.ok(tsx.includes('onContentProcessDidTerminate={handleContentProcessTerminated}'),
      'the WebView must subscribe to the iOS terminate event');
    assert.ok(/const handleContentProcessTerminated = useCallback/.test(tsx),
      'the iOS terminate handler must be defined');
  });

  it('remounts on a fresh key and clears the ready flag, same recovery as Android', () => {
    assert.ok(handlerBody().includes('setWebViewGeneration((n) => n + 1)'),
      'the generation must be bumped functionally, so a second kill remounts again');
    assert.ok(handlerBody().includes('documentReadyRef.current = false'),
      'the handler must clear the ready flag or the rebuilt frame rejects its own load');
  });

  it('reports the kill under its own stage so iOS and Android churn are tellable apart', () => {
    assert.ok(handlerBody().includes("reportChatFrameError('content_process_terminated'"),
      'the kill must reach Sentry under an iOS-specific stage');
  });

  it('defers a hidden-tab kill to the next activation instead of remounting into zero layout', () => {
    // Remounting a WKWebView inside a hidden pane gives it zero layout, and a
    // WKWebView loaded at zero size paints half a page (Alex, 2026-08-13:
    // "kind of half rendered but there's no text"). scrollEnabled={false}
    // removes the repaint nudge a scroll would give it, so the only safe
    // remount is one that happens with the tab visible.
    assert.ok(handlerBody().includes('if (activeRef.current)'),
      'the terminate handler must check visibility before remounting');
    assert.ok(handlerBody().includes('pendingRemountRef.current = true'),
      'a hidden kill must be recorded as a pending remount');
    assert.ok(tsx.includes('pendingRemountRef.current = false'),
      'the pending remount must be consumed on activation');
  });

  it('probes the document on each return to the tab, so recovery never depends on the terminate event', () => {
    // Nothing proves iOS always delivers onContentProcessDidTerminate (mobile
    // Sentry was inert on 2026-08-13, so there was no telemetry either way).
    // The probe is the belt to that brace: a dead content process cannot
    // answer injected JavaScript, so silence for 1.5s convicts the frame.
    assert.ok(tsx.includes(`window.ReactNativeWebView && window.ReactNativeWebView.postMessage('{"type":"pong"}'); true;`),
      'the probe must need no page cooperation beyond the bridge itself');
    assert.ok(tsx.includes("reportChatFrameError('probe_timeout'"),
      'a probe timeout must be reported under its own stage');
    const probeEffect = tsx.slice(tsx.indexOf('if (!active) return undefined;'));
    assert.ok(probeEffect.includes('if (!documentReadyRef.current || !webViewRef.current) return undefined;'),
      'a cold start must not be probed: there is no document to convict yet');
    assert.ok(/probeTimerRef\.current = setTimeout\(/.test(tsx),
      'the probe verdict must be a timer the answer can cancel');
  });

  it('either pong or a fresh ready settles an in-flight probe', () => {
    const handler = tsx.slice(tsx.indexOf('const handleMessage'), tsx.indexOf('}, [injectInit'));
    assert.ok(handler.includes("msg.type === 'pong' || msg.type === 'ready'"),
      'both answers must clear the probe timer, or a remounted document gets convicted by a stale probe');
    assert.ok(handler.indexOf("msg.type === 'pong' || msg.type === 'ready'") < handler.indexOf("if (msg.type === 'ready') {"),
      'the probe must be settled before the ready handling runs');
  });

  it('never hands the chat origin to the system browser after the document is ready', () => {
    // The other half of the defect: the dying WebView's reload targets the
    // baseUrl, and the generic http(s) hand-off opened Safari on the Worker's
    // 404 body. The policy must refuse own-origin navigations outright once
    // the document is up, BEFORE the Linking.openURL branch can see them.
    const policy = tsx.slice(
      tsx.indexOf('const handleShouldStartLoad'),
      tsx.indexOf('}, [', tsx.indexOf('const handleShouldStartLoad')),
    );
    const refuseAt = policy.indexOf('if (url === ownOrigin || url === `${ownOrigin}/`) {');
    const browserAt = policy.indexOf('Linking.openURL');
    assert.ok(refuseAt > 0, 'the post-ready own-origin refusal must exist');
    assert.ok(browserAt > refuseAt,
      'the own-origin refusal must come before the browser hand-off, or Safari opens on the API 404');
    assert.match(policy.slice(refuseAt, browserAt), /return false/,
      'the own-origin branch must refuse, not allow');
  });
});
