// Drives the real built web app through every signed-in screen, in two browser
// engines and three viewports, with the network fully mocked. The actual auth,
// product-state, routing and API code runs; no production account is touched.
//
// This exists because the unit tests cannot see the defects that matter. A dead
// microphone, a screen title rendered at body size, a tour describing a button
// that is not there: all of those passed every assertion in the repo and were
// only ever visible in a page. Run it with `npm run audit --workspace @sidekick/webapp`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4174';
const OUT = process.env.OUT_DIR ?? '/tmp/webapp-audit';
mkdirSync(OUT, { recursive: true });

const USER_ID = '00000000-0000-4000-8000-00000000beef';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'test.user@example.com',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Test User', avatar_url: 'https://example.com/a.png' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const SESSION = {
  access_token: JWT,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-token',
  user: USER,
};

function productRow(overrides = {}) {
  return {
    user_id: USER_ID,
    email: USER.email,
    full_name: 'Test User',
    agent_name: 'Ada',
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: '2026-01-01T00:00:00Z',
    profile_updated_at: '2026-06-01T00:00:00Z',
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: '2026-01-01T00:00:00Z',
    acknowledgement_text_version: 'v2',
    subscription_status: 'active',
    tier_id: 'pro-office',
    current_period_start: '2026-07-01T00:00:00Z',
    current_period_end: '2026-08-01T00:00:00Z',
    cancel_at_period_end: false,
    worker_status: 'ready',
    last_health_at: '2026-07-26T00:00:00Z',
    ready_at: '2026-01-02T00:00:00Z',
    error_code: null,
    public_status_message: null,
    volume_retention_until: null,
    suspended_at: null,
    deleted_at: null,
    coworker_update_available: false,
    coworker_update_status: null,
    reimage_requested_at: null,
    reimaged_at: null,
    monthly_token_quota: 100_000_000,
    used_tokens: 42_000_000,
    remaining_tokens: 58_000_000,
    usage_ratio: 0.42,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: 0,
    telegram_connected: false,
    active_gateway_id: null,
    active_gateway_connected_at: null,
    messaging_provider_connections: null,
    gate_kind: 'ready',
    ...overrides,
  };
}

// A routine's next run is read back through the same clock the page renders
// with, so a hard-coded date slides into "Due now" the moment it passes and the
// screenshot stops showing the line a reader would actually see.
function atLocalHour(daysAhead, hour) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

// The columns routinesApi selects, which are the only ones the mapper reads.
// title/cron_expression/paused were invented here and matched nothing, so every
// routine in every screenshot was titled with its own prompt and described as
// "Once" — the cadence line the product is built around had never been drawn.
const ROUTINES = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    prompt: 'Summarise anything important that arrived overnight.',
    // Named by the user, so the title is the label and the prompt shows beneath.
    label: 'Morning inbox summary',
    schedule_kind: 'interval',
    interval_seconds: 86_400,
    next_run_at: atLocalHour(1, 7),
    last_run_at: atLocalHour(0, 7),
    status: 'active',
    consecutive_failures: 0,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    // Unnamed, which is the other title branch: the prompt becomes the heading.
    prompt: 'Write the weekly progress report.',
    label: null,
    schedule_kind: 'interval',
    interval_seconds: 604_800,
    next_run_at: atLocalHour(4, 17),
    last_run_at: null,
    status: 'paused',
    consecutive_failures: 0,
  },
];

// storageStatus is not optional decoration. Leaving it out of this fixture is
// how every /files screenshot in this audit came to be the "still coming online"
// card rather than a folder, for as long as the audit has existed.

// Served to a preview's range request below. The marker is what the check looks
// for, so a panel that opens on its "could not load" state cannot pass. The long
// line is deliberate: a preview that scrolls sideways rather than wrapping hides
// the end of it, and a fixture of short lines would never show that.
const PREVIEW_BODY = `# Weekly notes

PREVIEW-FIXTURE-BODY

${'A deliberately long line that has to fold rather than run off the side of a narrow phone. '.repeat(3)}
`;

const FILES = {
  storageStatus: 'ready',
  truncated: false,
  files: [
    // sizeBytes and modifiedAt, the names the mapper reads. The earlier size and
    // updatedAt were dropped on the floor, so the line under every file name was
    // blank in every screenshot.
    { id: 'f1', name: 'reports/weekly-report.pdf', sizeBytes: 284_193, mimeType: 'application/pdf', modifiedAt: '2026-07-25T10:00:00Z' },
    // downloadUrl is relative because the client refuses any that is not on the
    // API origin, and hard-coding that origin here would tie the audit to one
    // deployment's env file.
    {
      id: 'f2',
      name: 'notes.md',
      sizeBytes: 1_204,
      mimeType: 'text/markdown',
      modifiedAt: '2026-07-20T09:00:00Z',
      downloadable: true,
      downloadUrl: '/api/files/runner/download?path=notes.md&token=preview-fixture',
    },
  ],
};

// The broker's reply, which is the only feed this screen reads. `available` has
// to be here too: without it the mapper reads "older Worker, cannot tell" and
// shows the catalogue whole, which is a different screen from the one a real
// deployment renders.
//
// 2026-09-28: two brokers answer now, each in its own shape, and a reply in the
// wrong shape reads as "could not reach your coworker". Since September every
// card but FreeAgent is Composio's, so the native broker offers FreeAgent alone
// and the Composio reply carries the connected Dropbox. Until this date the
// native mock answered for both, and Connections showed its error card on
// every run.
const CONNECTIONS = {
  connections: [],
  available: ['freeagent'],
};

const COMPOSIO = {
  available: true,
  connections: [{ id: 'dropbox', connectedAccountId: 'ca_audit_dropbox' }],
  offered: ['dropbox', 'slack', 'github', 'google_drive', 'google_calendar'],
};

const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

async function installMocks(context, scenario) {
  // The header and the slide-over read the signed-in user, not the product-state
  // row, so a scenario that only overrides the row leaves them on the tidy
  // sample name and stresses nothing.
  const user = scenario.user ? { ...USER, ...scenario.user, user_metadata: { ...USER.user_metadata, ...scenario.user.user_metadata } } : USER;
  const session = { ...SESSION, user };

  // Signed out means signed out: no stored session at all, which is what the
  // client reads to decide, so the sign-in screen is reached the real way.
  if (!scenario.signedOut) {
    await context.addInitScript(
      ([key, stored]) => {
        window.localStorage.setItem(key, JSON.stringify(stored));
      },
      ['delegent.web.auth', session],
    );
  }

  // The sample user's avatar lives at example.com, which has no such image: a
  // browser that fetched it logged a 404 per page (45 a run in WebKit) that
  // read as app errors. Answer it with a 1x1 image instead (2026-09-28).
  await context.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    }),
  );
  await context.route('**/auth/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/otp')) {
      if (scenario.otpFails) return json(route, { error: 'over_email_send_rate_limit', message: 'Too many requests' }, 429);
      return json(route, {});
    }
    if (url.includes('/verify')) {
      if (scenario.verifyFails) return json(route, { error: 'invalid_grant', message: 'Token has expired or is invalid' }, 403);
      return json(route, session);
    }
    if (url.includes('/user')) return json(route, user);
    if (url.includes('/logout')) return route.fulfill({ status: 204, body: '' });
    return json(route, session);
  });

  await context.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('my_product_state')) {
      if (scenario.productStateFails) return json(route, { message: 'boom' }, 500);
      return json(route, [productRow(scenario.row ?? {})]);
    }
    if (url.includes('scheduled_tasks')) {
      if (scenario.backendUnreachable) return route.abort('failed');
      if (method === 'GET') return json(route, scenario.routines ?? ROUTINES);
      if (scenario.mutationFails) return json(route, { message: 'boom' }, 500);
      return json(route, {});
    }
    // The profile save is an RPC, so it does not look like a write to anything
    // that switches on the path, and it answered 200 through the catch-all below.
    if (url.includes('/rpc/update_mobile_profile')) {
      if (scenario.mutationFails) return json(route, { message: 'boom' }, 500);
      return json(route, {});
    }
    return json(route, []);
  });

  await context.route('**/api/**', (route) => {
    const url = route.request().url();
    // A blocked CORS preflight reaches the page as a plain network failure, which
    // is the same thing an abort produces. That makes this the honest rehearsal
    // for the Worker deploy being missed or the API being down.
    if (scenario.backendUnreachable) return route.abort('failed');
    // Everything above this line is a read. A write that fails is a different
    // screen and, until this switch existed, one the audit had never drawn: the
    // whole mutation half of the app answered 200 to everything.
    const writing = route.request().method() !== 'GET';
    // Checked before the listing route, whose pattern would otherwise swallow it
    // and answer a preview with the file list as its contents. A range that was
    // not asked for is refused rather than served whole: if the client ever
    // stops sending one it would quietly download entire files to show 40 lines,
    // and this is the only place that would notice.
    if (url.includes('/api/files/runner/download')) {
      if (!/^bytes=0-\d+$/.test(route.request().headers().range ?? '')) {
        return route.fulfill({ status: 416, body: '', headers: { 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({
        status: 206,
        contentType: 'text/markdown',
        headers: {
          'access-control-allow-origin': '*',
          'content-range': `bytes 0-${PREVIEW_BODY.length - 1}/${PREVIEW_BODY.length}`,
        },
        body: PREVIEW_BODY,
      });
    }
    if (url.includes('/api/files/runner')) {
      // No body message, so the client falls back to its own wording and the
      // check below is asserting the app's copy rather than the mock's.
      if (scenario.mutationFails && writing) return json(route, {}, 500);
      return json(route, scenario.files ?? FILES);
    }
    if (url.includes('/api/connections/composio')) {
      if (scenario.mutationFails && writing) return json(route, {}, 500);
      return json(route, scenario.composio ?? COMPOSIO);
    }
    if (url.includes('/api/connections')) {
      // No body message, so the client falls back to its own wording and the
      // check below is asserting the app's copy rather than the mock's.
      if (scenario.mutationFails && writing) return json(route, {}, 500);
      return json(route, scenario.connections ?? CONNECTIONS);
    }
    if (url.includes('/api/scheduled-tasks')) {
      // No body message, so the client falls back to its own wording and the
      // check below is asserting the app's copy rather than the mock's.
      if (scenario.mutationFails && writing) return json(route, {}, 500);
      return json(route, { ok: true });
    }
    if (url.includes('/api/stripe/')) return json(route, { url: 'https://checkout.stripe.com/c/pay/test' });
    return json(route, {});
  });
}

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-small', width: 320, height: 568 },
  { name: 'desktop', width: 1280, height: 800 },
];

const PATHS = [
  '/chat',
  '/files',
  '/routines',
  '/connections',
  '/skills',
  '/commands',
  '/help',
  '/faq',
  '/plan',
  '/capacity',
  '/support',
  '/profile',
  '/legal',
  '/nope',
];

// Runs inside the page. "Is the message on the screen" is not the same question
// as "is the message in the document", and a failed write is exactly where the
// two come apart: the notice renders at the top of a screen whose reader is at
// the bottom, or behind the scrim of the dialog they are still looking at.
// elementFromPoint settles both, because it answers with whatever is actually
// painted at that spot.
function locateMessage(pattern) {
  const wanted = new RegExp(pattern, 'i');
  const holders = [...document.querySelectorAll('body *')].filter(
    (el) =>
      wanted.test(el.textContent ?? '') &&
      ![...el.children].some((child) => wanted.test(child.textContent ?? '')),
  );
  if (!holders.length) return { found: false, onScreen: false, covered: false, sample: '' };

  for (const el of holders) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const onScreen = rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
    const hit = document.elementFromPoint(
      Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
      Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)),
    );
    const covered = !hit || !(el === hit || el.contains(hit) || hit.contains(el));
    if (onScreen && !covered) {
      return { found: true, onScreen: true, covered: false, sample: (el.textContent ?? '').trim().slice(0, 80) };
    }
  }

  // Nothing was both on screen and unobscured. Which of the two it failed is
  // the difference between "scrolled away" and "painted over", so report the
  // first candidate's own geometry rather than guessing.
  const first = holders[0];
  const rect = first.getBoundingClientRect();
  const onScreen = rect.top >= 0 && rect.bottom <= innerHeight;
  return { found: true, onScreen, covered: onScreen, sample: (first.textContent ?? '').trim().slice(0, 80) };
}

const findings = [];
const note = (level, where, message) => findings.push({ level, where, message });

const IGNORABLE = [/favicon\.ico/, /sentry/i];
const ignorable = (url) => IGNORABLE.some((re) => re.test(url));

// Run inside the page. Returns everything one screen can be wrong about.
function inspect() {
  const doc = document.documentElement;
  const text = document.body?.innerText ?? '';

  const clipped = [...document.querySelectorAll('*')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 1;
    })
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);

  const parse = (colour) => {
    const m = /rgba?\(([^)]+)\)/.exec(colour);
    if (!m) return null;
    const parts = m[1].split(',').map((p) => Number.parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backdrop = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // Only leaf elements that actually paint their own words, so a wrapper is not
  // judged on text its children own.
  const lowContrast = [];
  const smallTargets = [];
  const cutSentences = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;

    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);

    // A one-line ellipsis clip is fine on a name: half a file name is still
    // enough to recognise it. It is not fine on a sentence, because half an
    // instruction instructs nobody. This is the check innerText cannot make:
    // the words are in the DOM and pass a text assertion while the reader sees
    // "Something went wr…".
    if (own && style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
      const words = el.textContent.trim();
      if (/[.!?]$/.test(words) && words.split(/\s+/).length > 3) {
        cutSentences.push(`${el.tagName.toLowerCase()} "${words.slice(0, 60)}"`);
      }
    }

    if (own) {
      const fg = parse(style.color);
      if (fg && fg.a > 0.5) {
        const bg = backdrop(el);
        const lf = luminance(fg);
        const lb = luminance(bg);
        const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const floor = large ? 3 : 4.5;
        if (ratio < floor) {
          lowContrast.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}" at ${ratio.toFixed(2)}:1`);
        }
      }
    }

    // A control you cannot reliably hit with a thumb. Text links inside a
    // paragraph are exempt: they are read, not tapped as a primary action.
    const tappable = el.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button]');
    if (tappable && !el.closest('p')) {
      // A checkbox is 20px by design and drawing it at 44 looks broken. What the
      // thumb actually hits is the label, since a click anywhere in it reaches
      // the input, so that is the rectangle worth measuring.
      const target = el.closest('label') ?? el;
      const hit = target === el ? rect : target.getBoundingClientRect();
      if (hit.height < 40 || hit.width < 24) {
        smallTargets.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(hit.width)}x${Math.round(hit.height)}`);
      }
    }
  }

  return {
    overflow: doc.scrollWidth - doc.clientWidth,
    text: text.trim(),
    spinner: /Loading your workspace|Signing you in/.test(text),
    clipped: [...new Set(clipped)].slice(0, 5),
    lowContrast: [...new Set(lowContrast)].slice(0, 5),
    smallTargets: [...new Set(smallTargets)].slice(0, 5),
    cutSentences: [...new Set(cutSentences)].slice(0, 5),
  };
}

// The signed-in surfaces put the chat in an iframe, so its text is not in the
// top document's innerText. Read both or a correct screen looks empty.
async function visibleText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await frame
      .evaluate(() => {
        if (!document.body) return '';
        // A frame its host has hidden gets no layout, and innerText quietly
        // falls back to textContent when there is no layout to measure. That
        // hands back every <script> body as well, so the page appears to be
        // printing its own source. Nothing in an unrendered frame is on screen,
        // so read nothing from it.
        const box = document.documentElement.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return '';
        return document.body.innerText ?? '';
      })
      .catch(() => '');
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

async function run(engine, engineName) {
  const browser = await engine.launch();

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    await installMocks(context, {});
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (ignorable(msg.location()?.url ?? '')) return;
      note('error', `${engineName}/${viewport.name}`, `console: ${msg.text().slice(0, 250)}`);
    });
    page.on('pageerror', (err) => note('error', `${engineName}/${viewport.name}`, `uncaught: ${String(err).slice(0, 250)}`));

    for (const path of PATHS) {
      const where = `${engineName}/${viewport.name}${path}`;
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch((err) => {
        note('error', where, `navigation failed: ${String(err).slice(0, 200)}`);
      });
      await page.waitForTimeout(700);

      const audit = await page.evaluate(inspect);

      if (audit.overflow > 1) note('error', where, `horizontal overflow of ${audit.overflow}px`);
      if (audit.clipped.length) note('error', where, `clipped past the right edge: ${audit.clipped.join(', ')}`);
      if (audit.text.length < 20) note('error', where, `rendered almost nothing ("${audit.text.slice(0, 60)}")`);
      if (audit.spinner) note('error', where, 'stuck on a loading spinner');
      if (audit.lowContrast.length) note('error', where, `below the WCAG AA contrast floor: ${audit.lowContrast.join('; ')}`);
      if (audit.smallTargets.length) note('error', where, `touch target under 40px: ${audit.smallTargets.join('; ')}`);
      if (audit.cutSentences.length) note('error', where, `a sentence was cut off mid-word: ${audit.cutSentences.join('; ')}`);
      if (/undefined|NaN|\[object Object\]/.test(audit.text)) {
        note('error', where, `placeholder leaked into the UI: ${audit.text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
      }

      if (path === '/chat') {
        const frame = page.frames().find((f) => f.url().includes('/chat-frame'));
        if (!frame) note('error', where, 'the chat frame never loaded');
        else {
          // The guide is a dialog that stays shut after the first visit, so open
          // it before counting. Counting the closed state is how "only two rows"
          // shipped past a green audit: every row measured zero height, the
          // per-row check had nothing to iterate, and the run came back clean.
          await frame.evaluate(() => document.getElementById('helpBtn')?.click());
          await page.waitForTimeout(200);

          const chat = await frame.evaluate(() => {
            const visible = (el) => !!el && el.getBoundingClientRect().height > 0;
            const label = (id) => (document.getElementById(id)?.innerText ?? '').trim();
            return {
              toolbar: ['attachBtn', 'cameraBtn', 'micBtn', 'voiceModeBtn', 'helpBtn'].filter((id) =>
                visible(document.getElementById(id)),
              ),
              tourOpen: visible(document.getElementById('toolbarTour')),
              tourRows: [...document.querySelectorAll('.tt-row')]
                .filter(visible)
                .map((el) => el.querySelector('.tt-t')?.textContent?.trim()),
              tourFoot: visible(document.getElementById('tourFootVoice')),
              composer: label('input') || document.getElementById('input')?.placeholder || '',
            };
          });

          // Alex reported both halves of this from a real browser: no voice orb,
          // and a guide showing two rows instead of four. Assert the presence,
          // not just the consistency, or the surface can go quiet again and still
          // agree with itself.
          //
          // The microphone is owed only where the browser can record: the app
          // hides Voice honestly when it cannot (voiceRecorder.ts canRecord), and
          // Playwright's WebKit build on Windows has no MediaRecorder, which read
          // as three false errors per viewport until 2026-09-28.
          const canRecord = await page.evaluate(
            () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined',
          );
          if (canRecord && !chat.toolbar.includes('micBtn')) note('error', where, 'the microphone is missing from the composer');
          if (!canRecord && chat.toolbar.includes('micBtn')) note('error', where, 'the microphone shows in a browser that cannot record');
          if (!chat.toolbar.includes('voiceModeBtn')) note('error', where, 'the voice orb is missing from the composer');
          if (!chat.tourOpen) note('error', where, 'the toolbar guide did not open when Help was pressed');
          else {
            const WANTED = canRecord ? ['Attach', 'Camera', 'Voice', 'Talk'] : ['Attach', 'Camera', 'Talk'];
            const missing = WANTED.filter((row) => !chat.tourRows.includes(row));
            if (missing.length) {
              note('error', where, `the toolbar guide shows ${chat.tourRows.length} rows, missing: ${missing.join(', ')}`);
            }
            if (canRecord && !chat.tourFoot) note('error', where, 'the guide footer explaining Voice against Talk is hidden');
          }

          // A row describing a control that is not on the toolbar is a promise
          // the surface cannot keep, which is what a reader reports as a bug.
          const onToolbar = { Attach: 'attachBtn', Camera: 'cameraBtn', Voice: 'micBtn', Talk: 'voiceModeBtn' };
          for (const row of chat.tourRows) {
            const id = onToolbar[row];
            if (id && !chat.toolbar.includes(id)) note('error', where, `the tour describes "${row}" but its control is not on the toolbar`);
          }
        }
      }

      // The header chip is the only thing that says what the workspace is doing
      // on a good day, when the banner below it is correctly silent. It sits
      // outside main, so the accordion walk never touches it.
      // Matched against the whole label set rather than "is not empty", so a
      // gate whose wording changes without its rewrite rule being updated shows
      // up here instead of rendering a blank line under the wordmark.
      const LABELS =
        /Online|Preparing workspace|Setup needed|Setting up|Limited|Needs attention|Choose a plan|Capacity full|Workspace retained/;
      const chip = await page.locator('header').first().innerText().catch(() => '');
      if (!LABELS.test(chip)) {
        note('error', where, `the header does not say what the workspace is doing (found "${chip.replace(/\n/g, ' ').slice(0, 60)}")`);
      }

      if (path === '/files') {
        // The accordion walk below opens this panel and checks it does not
        // overflow, which a panel stuck on "could not load" would also pass.
        // Reading the file's actual contents is the only proof the range fetch
        // works in a browser, and it is the half that depends on a Worker CORS
        // header no unit test can see.
        const toggle = page.locator('main [aria-controls="preview-f2"]').first();
        if (!(await toggle.count())) note('error', where, 'the text file has no preview control');
        else {
          await toggle.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(500);
          const panel = await page.locator('main #preview-f2').first().innerText().catch(() => '');
          if (!panel.includes('PREVIEW-FIXTURE-BODY')) {
            note('error', where, `the preview did not show the file's contents (found "${panel.replace(/\n/g, ' ').slice(0, 80)}")`);
          }
          // Closed again so the walk below starts from the state a reader lands
          // on, rather than skipping the one panel it was meant to open.
          await toggle.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(200);
        }
      }

      if (path === '/plan') {
        // This screen's whole job for a subscriber is moving between plans. Until
        // recently every card offered "Manage billing", which our Stripe portal
        // only lets you cancel with, so the tier a reader pressed was ignored.
        const text = await visibleText(page);
        if (!/Switch to /.test(text)) note('error', where, 'a subscriber is offered no way to change plan');
        if (!/Your current plan/.test(text)) note('error', where, 'the plan in force is not marked');
        const currentIsButton = await page
          .locator('main button', { hasText: 'Your current plan' })
          .count()
          .catch(() => 0);
        if (currentIsButton) note('error', where, 'the current plan is a button that cannot do anything');
      }

      await page.screenshot({ path: `${OUT}/${engineName}-${viewport.name}-${path.slice(1) || 'root'}.png`, fullPage: true });

      // Everything above only ever saw the closed state of an accordion, which
      // is most of the FAQ and all of the skills catalogue. Open every panel and
      // look again, or the majority of the copy on those screens is unaudited.
      // Scoped to main: the header's burger button is also aria-expanded, and
      // opening the slide-over covers the screen so every later click times out.
      // Checked after every click, not once at the end: Commands and Skills only
      // keep one panel open at a time, so inspecting the final state would audit
      // one panel and leave the rest as unseen as they were when closed.
      // Walked by index rather than by "the first still-closed one": these
      // accordions keep a single panel open, so opening the second closes the
      // first and a first-match loop just alternates between the two forever.
      const toggles = page.locator('main [aria-expanded]');
      const panels = await toggles.count();
      for (let i = 0; i < panels; i += 1) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute('aria-expanded')) === 'false') {
          await toggle.click({ timeout: 5_000 }).catch(() => {});
        }
        await page.waitForTimeout(180);
        const open = await page.evaluate(inspect);
        const openWhere = `${where} (panel ${i + 1})`;
        if (open.overflow > 1) note('error', openWhere, `horizontal overflow of ${open.overflow}px`);
        if (open.clipped.length) note('error', openWhere, `clipped past the right edge: ${open.clipped.join(', ')}`);
        if (open.lowContrast.length) note('error', openWhere, `below the WCAG AA contrast floor: ${open.lowContrast.join('; ')}`);
        if (open.smallTargets.length) note('error', openWhere, `touch target under 40px: ${open.smallTargets.join('; ')}`);
        if (open.cutSentences.length) note('error', openWhere, `a sentence was cut off mid-word: ${open.cutSentences.join('; ')}`);
        if (/undefined|NaN|\[object Object\]/.test(open.text)) {
          note('error', openWhere, `placeholder leaked into the UI: ${open.text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
        }
        await page.screenshot({
          path: `${OUT}/${engineName}-${viewport.name}-${path.slice(1) || 'root'}-panel${i + 1}.png`,
          fullPage: true,
        });
      }
    }

    // Leaving chat and coming back. The phone keeps its chat tab mounted, so a
    // half-typed message and a reply still arriving both survive a look at
    // Files. Checked here rather than in source because the thing that breaks
    // it is a routing change somewhere else entirely.
    {
      const where = `${engineName}/${viewport.name} chat across navigation`;
      await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(700);
      const frame = page.frames().find((f) => f.url().includes('/chat-frame'));
      if (!frame) note('error', where, 'the chat frame never loaded');
      else {
        const DRAFT = 'a message half typed';
        await frame.evaluate((text) => {
          const input = document.getElementById('input');
          if (input) input.value = text;
        }, DRAFT);

        await page.click('a[href="/files"], a[href$="/files"]', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(600);
        await page.click('a[href="/chat"], a[href$="/chat"]', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(600);

        const back = page.frames().find((f) => f.url().includes('/chat-frame'));
        const kept = back ? await back.evaluate(() => document.getElementById('input')?.value ?? '') : '';
        if (kept !== DRAFT) {
          note('error', where, `the composer was emptied by a trip to Files (found "${kept}")`);
        }
        const visible = await page
          .locator('iframe.chat-frame')
          .isVisible()
          .catch(() => false);
        if (!visible) note('error', where, 'chat did not come back into view');
      }
    }

    await context.close();
  }

  // Gate scenarios only need one viewport; they are about which screen wins.
  for (const scenario of [
    { key: 'needs-ack', row: { gate_kind: 'needs_acknowledgement', acknowledgement_accepted: false }, expect: /agree|accept|continue|start/i },
    {
      key: 'needs-sub',
      row: { gate_kind: 'needs_subscription', subscription_status: null, tier_id: null },
      expect: /plan|subscribe|choose/i,
      // Where someone with no plan goes next, and the two screens that have to
      // hold up when they get there.
      also: { '/plan': /choose/i, '/capacity': /no allowance to show yet/i },
    },
    // Not /.+/ any more. A ready-looking chat during provisioning passed that,
    // and it is the single most likely first impression a new subscriber gets:
    // a composer inviting a message no runner exists yet to answer.
    {
      key: 'provisioning',
      row: { gate_kind: 'provisioning_worker', worker_status: 'provisioning' },
      expect: /coming online/i,
    },
    {
      key: 'pending-worker',
      // 'queued', not 'pending': the gate is resolved from worker_status, and
      // gate_kind on the row is along for the ride.
      row: { gate_kind: 'subscribed_pending_worker', worker_status: 'queued' },
      expect: /coming online/i,
    },
    { key: 'state-error', productStateFails: true, expect: /went wrong|try again/i },
    // Both of these used to render a fully live chat, composer and all, while
    // the account behind it was stuck or limited. The reader had no way to know.
    {
      key: 'worker-error',
      row: { worker_status: 'provisioning', error_code: 'capacity_exhausted', public_status_message: null },
      expect: /needs attention/i,
    },
    { key: 'degraded', row: { worker_status: 'degraded' }, expect: /running with limits/i },
    // These two asked for /.+/, which the length check above had already
    // guaranteed, so they were two of the most consequential states in the
    // product asserting nothing at all. Both were hiding something.
    {
      key: 'hard-limited',
      row: { usage_hard_limited: true, used_tokens: 100_000_000, remaining_tokens: 0, usage_ratio: 1 },
      expect: /used this month|upgrade to keep chatting/i,
      // The context meter measures this chat, the quota measures the month, and
      // the words did not distinguish them: the header read "Lots of room" while
      // the banner underneath said the month was gone.
      forbid: /(lots|loads|plenty) of room/i,
      // The two screens a capped reader is sent to for the answer. Capacity is
      // the page the FAQ names by name, so it has to say the month is gone
      // rather than describing a comfortable one.
      also: {
        // "Plenty left for quick questions" was the plan's size sitting under a
        // meter reading 100%, which is the same contradiction as the chat header
        // in a different font.
        '/capacity': { expect: /used this month/i, forbid: /plenty left|plenty of room/i },
        '/plan': /used this month/i,
      },
    },
    {
      key: 'retained',
      row: {
        subscription_status: 'canceled',
        worker_status: 'sleeping',
        volume_retention_until: '2026-08-20T00:00:00Z',
      },
      // A cancelled reader has one question and it is not about chat. The phone
      // answered it with a chip; the browser said "No active plan" and stopped.
      expect: /files (are )?still here|files stay saved/i,
      // And the screen they go to in order to check for themselves. The files
      // are still listed while the volume is retained, so a cancelled reader who
      // opens Files must find them there, not an empty shelf.
      also: { '/files': /notes\.md/i, '/plan': /files (are )?still here|files stay saved/i },
    },
    // The other half of the provisioning check: a workspace that is up must not
    // keep apologising for a wait that finished. A banner nobody can dismiss is
    // only tolerable while it is true.
    { key: 'ready', row: {}, expect: /Message/i, forbid: /coming online|needs attention|running with limits/i },
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installMocks(context, scenario);
    const page = await context.newPage();
    page.on('pageerror', (err) => note('error', `${engineName}/${scenario.key}`, `uncaught: ${String(err).slice(0, 250)}`));

    await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const text = await visibleText(page);
    const where = `${engineName}/gate:${scenario.key}`;
    if (text.length < 20) note('error', where, `rendered almost nothing ("${text.slice(0, 60)}")`);
    else if (!scenario.expect.test(text)) note('error', where, `expected ${scenario.expect} but saw "${text.slice(0, 120).replace(/\s+/g, ' ')}"`);
    if (scenario.forbid?.test(text)) note('error', where, `said "${text.match(scenario.forbid)?.[0]}" when it was no longer true`);
    await page.screenshot({ path: `${OUT}/${engineName}-gate-${scenario.key}.png`, fullPage: true });

    // A gate is an account state, not a chat state, and every one of these was
    // being checked on the single screen its reader has already given up on. The
    // capped and cancelled states in particular send people to billing and
    // files, which this loop had never once drawn under a gate.
    for (const [extra, entry] of Object.entries(scenario.also ?? {})) {
      const rule = entry instanceof RegExp ? { expect: entry } : entry;
      await page.goto(`${BASE}${extra}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(700);
      const extraText = await visibleText(page);
      const extraWhere = `${engineName}/gate:${scenario.key}${extra}`;
      if (extraText.length < 20) note('error', extraWhere, `rendered almost nothing ("${extraText.slice(0, 60)}")`);
      else if (!rule.expect.test(extraText)) {
        note('error', extraWhere, `expected ${rule.expect} but saw "${extraText.slice(0, 160).replace(/\s+/g, ' ')}"`);
      }
      if (rule.forbid?.test(extraText)) {
        note('error', extraWhere, `said "${extraText.match(rule.forbid)?.[0]}" when it was no longer true`);
      }
      const extraAudit = await page.evaluate(inspect);
      if (extraAudit.cutSentences.length) {
        note('error', extraWhere, `a sentence was cut off mid-word: ${extraAudit.cutSentences.join('; ')}`);
      }
      if (/undefined|NaN|\[object Object\]/.test(extraText)) {
        note('error', extraWhere, `placeholder leaked into the UI: ${extraText.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
      }
      await page.screenshot({
        path: `${OUT}/${engineName}-gate-${scenario.key}-${extra.slice(1)}.png`,
        fullPage: true,
      });
    }

    await context.close();
  }

  // Every sweep above ran on tidy sample data: two short file names, two short
  // routine titles, "Test User". Real accounts are not tidy. The first thing a
  // new subscriber sees is a screen with nothing on it, and the thing that
  // breaks a narrow layout is one long unbroken word. Both are states the
  // reader reaches without doing anything unusual, and neither had been drawn.
  for (const content of [
    {
      key: 'empty',
      files: { storageStatus: 'ready', truncated: false, files: [] },
      connections: { connections: [] },
      composio: { available: true, connections: [], offered: COMPOSIO.offered },
      routines: [],
      // Nothing to list is not nothing to say. A screen that renders bare is
      // indistinguishable from one that failed to load. And a ready workspace
      // with nothing in it must not be described as one that is still booting.
      needs: { '/files': /no files yet/i, '/routines': /no routines|nothing|first|create|add/i },
      forbids: { '/files': /coming online/i },
    },
    {
      // The other side of the same coin: a workspace that really has not
      // finished still has to say so, and offer the way to look again.
      key: 'storage-not-ready',
      files: { storageStatus: 'not_ready', files: [] },
      needs: { '/files': /coming online/i },
    },
    {
      // A grant that lapsed at the provider. Nothing the reader did caused it
      // and nothing they can see explains it, so the one thing this screen owes
      // them is the sentence saying to sign in again.
      // Only the native broker reports a lapsed grant, and FreeAgent is its one
      // service since the Composio move (2026-09-28: was Dropbox).
      key: 'connection-needs-reauth',
      connections: {
        connections: [{ provider: 'freeagent', status: 'needs_reauth', accountLabel: null, connectedAt: null }],
        available: ['freeagent'],
      },
      needs: { '/connections': /sign in to freeagent again/i },
    },
    {
      key: 'long',
      user: {
        email: 'bartholomew.fitzgerald-montgomery@an-extremely-long-company-domain.co.uk',
        user_metadata: { full_name: 'Bartholomew Fitzgerald-Montgomery Wellington' },
      },
      row: {
        full_name: 'Bartholomew Fitzgerald-Montgomery Wellington',
        email: 'bartholomew.fitzgerald-montgomery@an-extremely-long-company-domain.co.uk',
        agent_name: 'Alexandrina',
      },
      files: {
        storageStatus: 'ready',
        truncated: false,
        files: [
          {
            id: 'f1',
            name: 'board-packs-and-management-accounts/Q3-2026-consolidated-management-accounts-board-pack-FINAL-v7-approved.pdf',
            sizeBytes: 18_284_193,
            mimeType: 'application/pdf',
            modifiedAt: '2026-07-25T10:00:00Z',
          },
        ],
      },
      routines: [
        {
          ...ROUTINES[0],
          label: 'Send the consolidated weekly management report to the board and the investor group',
          prompt:
            'Pull together everything that moved this week across the accounts, the pipeline and the support queue, then write it up as one page.',
        },
      ],
    },
  ]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    await installMocks(context, content);
    const page = await context.newPage();
    const base = `${engineName}/content:${content.key}`;
    page.on('pageerror', (err) => note('error', base, `uncaught: ${String(err).slice(0, 250)}`));

    for (const path of ['/files', '/routines', '/connections', '/profile', '/plan']) {
      const where = `${base}${path}`;
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(700);
      const audit = await page.evaluate(inspect);
      if (audit.overflow > 1) note('error', where, `horizontal overflow of ${audit.overflow}px`);
      if (audit.clipped.length) note('error', where, `clipped past the right edge: ${audit.clipped.join(', ')}`);
      if (audit.text.length < 20) note('error', where, `rendered almost nothing ("${audit.text.slice(0, 60)}")`);
      // The needs regex below reads innerText, which holds the whole sentence
      // even when a one-line clip means the reader can only see the start of it.
      // This is the check that catches the difference.
      if (audit.cutSentences.length) note('error', where, `a sentence was cut off mid-word: ${audit.cutSentences.join('; ')}`);
      const needs = content.needs?.[path];
      if (needs && !needs.test(audit.text)) {
        note('error', where, `expected ${needs} but saw "${audit.text.slice(0, 140).replace(/\s+/g, ' ')}"`);
      }
      const forbids = content.forbids?.[path];
      if (forbids?.test(audit.text)) note('error', where, `said "${audit.text.match(forbids)?.[0]}" when it was not true`);
      await page.screenshot({ path: `${OUT}/${engineName}-content-${content.key}-${path.slice(1)}.png`, fullPage: true });
    }

    // The name and address only appear once the menu is open, which is the one
    // place a long email has a 320px-wide panel to fit into.
    await page.getByRole('button', { name: /open menu/i }).click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
    const menu = await page.evaluate(inspect);
    if (menu.overflow > 1) note('error', `${base} (menu)`, `horizontal overflow of ${menu.overflow}px`);
    if (menu.clipped.length) note('error', `${base} (menu)`, `clipped past the right edge: ${menu.clipped.join(', ')}`);
    await page.screenshot({ path: `${OUT}/${engineName}-content-${content.key}-menu.png`, fullPage: true });
    await context.close();
  }

  // Tapping a command or a skill phrase has to end as a real send. The phone can
  // hand one straight to its always-mounted chat; here the chat is a route that
  // has to mount, sign in and load its history first, so the only honest proof
  // is the request the chat document makes at the end of that chain.
  for (const dispatch of [
    { key: 'command', from: '/commands', open: 'Tidy up this chat', run: 'Tidy up this chat', expect: '/compress' },
    // (2026-09-28: the 'skill' drive, which pressed a skill's example chip and
    // expected it sent to the chat, is gone with the chips: since PR 497 on
    // 2026-09-03 the Skills page describes what each skill does and sends
    // nothing.)
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installMocks(context, {});
    const page = await context.newPage();
    const where = `${engineName}/dispatch:${dispatch.key}`;
    page.on('pageerror', (err) => note('error', where, `uncaught: ${String(err).slice(0, 250)}`));

    const sent = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/api/chat/runs')) return;
      try {
        sent.push(JSON.parse(request.postData() ?? '{}').message ?? '');
      } catch {
        sent.push('');
      }
    });

    await page.goto(`${BASE}${dispatch.from}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(600);

    let expected = dispatch.expect;
    try {
      if (dispatch.key === 'command') {
        await page.getByRole('button', { name: new RegExp(dispatch.open, 'i') }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(250);
        // The action button repeats the card title, so take the last match: the
        // one inside the panel that just opened, not the card header above it.
        await page.getByRole('button', { name: new RegExp(dispatch.run, 'i') }).last().click({ timeout: 5_000 });
      } else {
        // Whichever phrase the shared catalogue happens to lead with.
        await page.locator('main [aria-expanded]').first().click({ timeout: 5_000 });
        await page.waitForTimeout(250);
        const chip = page.locator('main button.chip-off').first();
        expected = (await chip.innerText()).replace(/[“”]/g, '').trim();
        await chip.click({ timeout: 5_000 });
      }
    } catch (err) {
      note('error', where, `could not run it: ${String(err).slice(0, 160)}`);
    }

    await page.waitForURL('**/chat', { timeout: 10_000 }).catch(() => {
      note('error', where, 'running it did not open the chat');
    });
    await page.waitForFunction(() => true).catch(() => {});
    for (let waited = 0; waited < 12_000 && !sent.length; waited += 300) {
      await page.waitForTimeout(300);
    }

    if (!sent.length) note('error', where, `nothing was ever sent to the chat (expected "${expected}")`);
    else if (expected && !sent.some((message) => message.includes(expected))) {
      note('error', where, `the chat was sent "${sent[0]?.slice(0, 80)}" instead of "${expected}"`);
    }
    await page.screenshot({ path: `${OUT}/${engineName}-dispatch-${dispatch.key}.png`, fullPage: true });
    await context.close();
  }

  // Everything above this point is a read. Rename, delete, upload, create a
  // routine, pause one: nine write paths, and the audit had driven none of them,
  // because the mock answered 200 to every method. So the half of the app a
  // reader reaches by pressing a button had never been exercised, and the moment
  // a write fails had never been on screen at all.
  //
  // The bar is not "an error exists in the DOM". It is that the reader can see
  // it from where they are standing, which after pressing a button at the bottom
  // of a long form, or inside a dialog, is not where a page-top notice lives.
  for (const flow of [
    {
      key: 'rename',
      path: '/files',
      async act(page) {
        // Rename lives inside the open file panel, where the phone puts it, so
        // the row has to be opened first. Three text buttons on the row itself
        // is 220px of fixed width and left nothing for the name on a 320px
        // screen.
        await page.locator('main [aria-controls^="preview-"]').first().click({ timeout: 5_000 });
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: /^rename$/i }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(300);
        await page.fill('#rename-input', 'renamed-notes.md');
        await page.getByRole('button', { name: /^save$/i }).click({ timeout: 5_000 });
      },
      // Whatever the app decides to say, it has to be one of these.
      failure: 'went wrong|try again|could not',
      // A write that worked closes the dialog rather than leaving the reader
      // guessing whether the button registered.
      settled: async (page) => (await page.locator('#rename-input').count()) === 0,
      settledIs: 'the rename dialog closed',
    },
    {
      key: 'routine-create',
      path: '/routines',
      async act(page) {
        await page.getByRole('button', { name: /new routine/i }).click({ timeout: 5_000 });
        await page.waitForTimeout(300);
        await page.fill('#routine-prompt', 'Check the overnight orders and flag anything odd.');
        // Weekly, because it adds the weekday row: the tallest the form gets,
        // and the version where the button is furthest from the top of the page.
        await page.getByRole('button', { name: /every week/i }).click({ timeout: 5_000 });
        await page.waitForTimeout(200);
        const create = page.getByRole('button', { name: /create routine/i });
        await create.scrollIntoViewIfNeeded();
        await create.click({ timeout: 5_000 });
      },
      failure: 'could not set up|try again',
      settled: async (page) => (await page.locator('#routine-prompt').count()) === 0,
      settledIs: 'the new-routine form closed',
    },
    {
      key: 'routine-pause',
      path: '/routines',
      async act(page) {
        await page.getByRole('button', { name: /^pause$/i }).first().click({ timeout: 5_000 });
      },
      failure: 'could not update|try again',
      settled: async () => true,
      settledIs: 'the list stayed usable',
    },
    {
      // Only the failing half. The working half leaves this page for the
      // provider's own sign-in, which is the whole point of the hand-off and
      // is not ours to render. What is ours is what the reader sees when the
      // hand-off will not open: a message next to the button they just
      // pressed, not at the top of a page the sheet is covering.
      key: 'connection-handoff',
      path: '/connections',
      outcomes: ['fails'],
      async act(page) {
        await page.getByRole('button', { name: /^(connect|reconnect)$/i }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(300);
        await page.getByTestId('connections.continue').click({ timeout: 5_000 });
      },
      failure: 'could not reach|try again',
    },
    {
      key: 'profile-save',
      path: '/profile',
      async act(page) {
        await page.fill('#profile-agent', 'Hassan');
        const save = page.getByRole('button', { name: /save changes/i });
        await save.scrollIntoViewIfNeeded();
        await save.click({ timeout: 5_000 });
      },
      failure: 'could not save|try again',
      // Nothing closes here, so the only sign the save landed is the word
      // itself, and it has to be somewhere the reader can see it.
      settled: async (page) => {
        const seen = await page.evaluate(locateMessage, 'saved');
        return seen.found && seen.onScreen && !seen.covered;
      },
      settledIs: 'the confirmation appeared where the reader could see it',
    },
  ]) {
    for (const outcome of flow.outcomes ?? ['fails', 'works']) {
      // The smallest phone, because the distance between the button and a
      // page-top notice is the whole point of these checks.
      const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
      await installMocks(context, { mutationFails: outcome === 'fails' });
      const page = await context.newPage();
      const where = `${engineName}/write:${flow.key}-${outcome}`;
      page.on('pageerror', (err) => note('error', where, `uncaught: ${String(err).slice(0, 250)}`));

      await page.goto(`${BASE}${flow.path}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(800);
      try {
        await flow.act(page);
      } catch (err) {
        note('error', where, `could not drive it: ${String(err).slice(0, 160)}`);
      }
      await page.waitForTimeout(1_500);

      if (outcome === 'fails') {
        const seen = await page.evaluate(locateMessage, flow.failure);
        if (!seen.found) note('error', where, 'the write failed and the screen said nothing');
        else if (seen.covered) note('error', where, `the failure was behind something else: "${seen.sample}"`);
        else if (!seen.onScreen) note('error', where, `the failure was off screen: "${seen.sample}"`);
      } else {
        const settled = await flow.settled(page);
        if (!settled) note('error', where, `the write worked but ${flow.settledIs} did not happen`);
        const stuck = await visibleText(page);
        if (/went wrong|could not|try again/i.test(stuck)) {
          note('error', where, `the write worked and the screen still claimed a failure: "${stuck.match(/.{0,60}(went wrong|could not|try again).{0,40}/i)?.[0]}"`);
        }
      }

      const after = await page.evaluate(inspect);
      if (after.overflow > 1) note('error', where, `horizontal overflow of ${after.overflow}px`);
      if (after.cutSentences.length) note('error', where, `a sentence was cut off mid-word: ${after.cutSentences.join('; ')}`);
      if (/undefined|NaN|\[object Object\]/.test(after.text)) {
        note('error', where, `placeholder leaked into the UI: ${after.text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
      }

      await page.screenshot({ path: `${OUT}/${engineName}-write-${flow.key}-${outcome}.png`, fullPage: true });
      await context.close();
    }
  }

  // Sign-in is the one screen every reader meets, and every other check here
  // starts with a session already in storage, so until now it had never been
  // rendered at all. Walked at the smallest viewport too: it is a centred card
  // that has to survive a 320px phone with the keyboard up.
  for (const viewport of VIEWPORTS) {
    for (const step of ['email', 'code', 'code-rejected', 'send-failed']) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await installMocks(context, {
        signedOut: true,
        otpFails: step === 'send-failed',
        verifyFails: step === 'code-rejected',
      });
      const page = await context.newPage();
      const where = `${engineName}/signin:${step}@${viewport.name}`;
      page.on('pageerror', (err) => note('error', where, `uncaught: ${String(err).slice(0, 250)}`));

      await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(700);

      // Landing signed out must offer sign-in, not the app shell or a blank page.
      const first = await visibleText(page);
      if (!/sign in/i.test(first)) {
        note('error', where, `signed out but no sign-in offered: "${first.slice(0, 120).replace(/\s+/g, ' ')}"`);
      }
      if (/Chat|Files|Routines|Connections/.test(first) && step === 'email') {
        note('error', where, 'the app shell rendered for a signed-out reader');
      }

      if (step !== 'email') {
        await page.fill('#signin-email', 'test@example.com').catch(() => {});
        await page.getByRole('button', { name: /send sign-in code/i }).click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
      if (step === 'code' || step === 'code-rejected') {
        await page.fill('#signin-code', '12345678').catch(() => {});
        if (step === 'code-rejected') {
          await page.getByRole('button', { name: /^sign in$/i }).click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(900);
        }
      }

      const text = await visibleText(page);
      if (text.length < 20) note('error', where, `rendered almost nothing ("${text.slice(0, 60)}")`);

      // A rejected code and a failed send both have to say something, and
      // neither may hand the reader the provider's own wording.
      if (step === 'code-rejected' || step === 'send-failed') {
        if (!/code|again|try|expired|wrong|could not/i.test(text)) {
          note('error', where, `the failure was silent: "${text.slice(0, 140).replace(/\s+/g, ' ')}"`);
        }
        const leak = text.match(/invalid_grant|over_email_send_rate_limit|Token has expired|supabase|gotrue|\bhttps?:\/\//i);
        if (leak) note('error', where, `provider wording reached the reader: "${leak[0]}"`);
      }

      const seen = await page.evaluate(inspect);
      if (seen.overflow > 1) note('error', where, `horizontal overflow of ${seen.overflow}px`);
      if (seen.clipped.length) note('error', where, `clipped past the right edge: ${seen.clipped.join(', ')}`);
      if (seen.lowContrast.length) note('error', where, `below the WCAG AA contrast floor: ${seen.lowContrast.join('; ')}`);
      if (seen.smallTargets.length) note('error', where, `touch target under 40px: ${seen.smallTargets.join('; ')}`);
      if (seen.cutSentences.length) note('error', where, `a sentence was cut off mid-word: ${seen.cutSentences.join('; ')}`);
      if (/undefined|NaN|\[object Object\]/.test(seen.text)) {
        note('error', where, `placeholder leaked into the UI: ${seen.text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
      }

      await page.screenshot({ path: `${OUT}/${engineName}-${viewport.name}-signin-${step}.png`, fullPage: true });
      await context.close();
    }
  }

  // The day the API is unreachable is the day this app is judged. A blocked CORS
  // preflight, an expired deploy and a dead connection all look identical to the
  // page, so every screen that fetches has to say so in words a reader can act
  // on, and none of them may spill what broke underneath.
  for (const { path, mustRecover, mustNotClaim } of [
    { path: '/files', mustRecover: true, mustNotClaim: /no files yet/i },
    { path: '/connections', mustRecover: true },
    { path: '/routines', mustRecover: true, mustNotClaim: /no routines yet/i },
    // Chat carries its own offline pill, and Plan reads product state rather
    // than the API, so neither owes the reader a retry line when the API dies.
    { path: '/chat', mustRecover: false },
    { path: '/plan', mustRecover: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installMocks(context, { backendUnreachable: true });
    const page = await context.newPage();
    const where = `${engineName}/unreachable:${path}`;
    page.on('pageerror', (err) => note('error', where, `uncaught: ${String(err).slice(0, 250)}`));

    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    // Long enough to outlast the client's own retries. Measured, not guessed: a
    // failing read is retried four times over about seven seconds before the
    // screen is told, where a healthy one is fetched exactly once.
    await page.waitForTimeout(12_000);

    const text = await visibleText(page);
    if (text.length < 20) note('error', where, `rendered almost nothing ("${text.slice(0, 60)}")`);

    // Raw failure detail reaching the screen is the defect, not the failure.
    // Matched narrowly: plain words like "volume" appear in honest plan copy.
    const leak = text.match(
      /TypeError|Failed to fetch|NetworkError|\bat \w+\.\w+|https?:\/\/[^\s]+|supabase|openrouter|hermes|service.role|machine[ -]?id|volume[ -]?id|\bvol_[a-z0-9]|delegent-runner/i,
    );
    if (leak) note('error', where, `internal detail on screen: "${leak[0]}"`);

    // A dead end is worse than an error: the reader needs a way back in.
    if (mustRecover && !/try again|check your connection|could not reach|reload|refresh/i.test(text)) {
      note('error', where, `no recovery wording offered: "${text.slice(0, 140).replace(/\s+/g, ' ')}"`);
    }

    // A read that failed says nothing about how much is there. Telling someone
    // they have none of something they do have is a worse lie than an error.
    if (mustNotClaim && mustNotClaim.test(text)) {
      note('error', where, `claimed an empty list after a failed read: "${text.match(mustNotClaim)?.[0]}"`);
    }

    const broken = await page.evaluate(inspect);
    if (broken.overflow > 1) note('error', where, `horizontal overflow of ${broken.overflow}px`);
    if (broken.lowContrast.length) note('error', where, `below the WCAG AA contrast floor: ${broken.lowContrast.join('; ')}`);
    if (broken.cutSentences.length) note('error', where, `a sentence was cut off mid-word: ${broken.cutSentences.join('; ')}`);

    await page.screenshot({ path: `${OUT}/${engineName}-unreachable-${path.slice(1)}.png`, fullPage: true });
    await context.close();
  }

  await browser.close();
}

await run(chromium, 'chromium');
await run(firefox, 'firefox');

writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');
console.log(`\n===== ${errors.length} error(s), ${warns.length} warning(s) =====`);
// The key drops the engine, so a finding both engines produce prints once under
// whichever ran first. That makes the printed list look chromium-only and it is
// not: findings.json has every engine. Do not read the absence of a firefox
// line as firefox passing.
const seen = new Set();
for (const f of [...errors, ...warns]) {
  const key = `${f.level}|${f.where.split('/').slice(1).join('/')}|${f.message}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`[${f.level}] ${f.where}: ${f.message}`);
}
console.log(`\nscreenshots + findings.json in ${OUT}`);
process.exit(errors.length > 0 ? 1 : 0);
