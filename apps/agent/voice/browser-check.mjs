#!/usr/bin/env node
// Check: the chat page's live Talk path in real Chrome, with a WAV
// file as the microphone. Test account only. Proves the phone-side code (the
// bundled VoiceClient, the socket wait, the overlay) before a preview publish.
//
//   node apps/agent/voice-test/browser-check.mjs <fake-mic.wav>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const WAV = process.argv[2];
const HTML = readFileSync(new URL('../../mobile/assets/chat-webview/index.html', import.meta.url), 'utf8');
// VOICE_HOST points the page at another voice Worker (the test one) for a check.
const VOICE_HOST = process.env.VOICE_HOST || 'voice.delegantai.co.uk';
const env = Object.fromEntries(readFileSync(process.env.USERPROFILE + '/.coworker-ai/live-provider.env', 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
const SUPA = env.SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const link = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
  method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: 'tester@example.com' }),
}).then((r) => r.json());
const v = await fetch(link?.properties?.action_link || link.action_link, { redirect: 'manual' });
const token = new URLSearchParams((v.headers.get('location') || '').split('#')[1] || '').get('access_token');
const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, permissions: ['microphone'] });
const p = await ctx.newPage();
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
p.on('console', (m) => { if (/error|live|voice/i.test(m.text())) console.log(ms(), 'console', m.type(), m.text().slice(0, 200)); });
p.on('pageerror', (e) => console.log(ms(), 'PAGE ERROR', e.message));
await p.addInitScript(() => { window.ReactNativeWebView = { postMessage() {} }; });
await p.route('https://chat.test/', (route) => route.fulfill({ body: HTML, contentType: 'text/html; charset=utf-8' }));
await p.goto('https://chat.test/', { waitUntil: 'load' });
await p.evaluate(({ token, userId, VOICE_HOST }) => {
  bridge.config = { ...bridge.config, apiBaseUrl: 'https://api.delegantai.co.uk', accessToken: token, userId, initComplete: true, agentName: 'Barry', pilotVoiceMode: true, platform: 'android', modelName: 'GPT-6 Luna from OpenAI', liveTalkHost: VOICE_HOST };
  document.getElementById('voiceModeBtn').classList.remove('hidden');
}, { token, userId, VOICE_HOST });
await p.evaluate(() => {
  const Real = window.DelegentVoiceClient;
  window.DelegentVoiceClient = function (opts) {
    const c = new Real(opts);
    c.addEventListener('statuschange', (s) => console.log('live status', s));
    c.addEventListener('transcriptchange', (m) => { const x = m[m.length - 1]; if (x) console.log('live transcript', x.role, x.text); });
    c.addEventListener('error', (e) => e && console.log('live error', e));
    return c;
  };
});
await p.click('#voiceModeBtn');
// The one-time beta note: read it, then Got it.
await p.waitForTimeout(800);
const note = await p.evaluate(() => { const n = document.getElementById('voiceNote'); return n && !n.classList.contains('hidden') ? document.getElementById('voiceNoteBody').textContent : null; });
console.log(ms(), 'beta note:', note);
if (note) await p.click('#voiceNoteOk');
let last = '';
for (let i = 0; i < 50; i++) {
  const state = await p.evaluate(() => ({
    status: document.getElementById('voiceStatus')?.textContent,
    heard: document.getElementById('voiceHeard')?.textContent,
    timer: document.getElementById('voiceTimer')?.textContent,
    open: !document.getElementById('voiceOverlay')?.classList.contains('hidden'),
    errors: [...document.querySelectorAll('.error, .msg-error, [data-kind="error"]')].map((e) => e.textContent).slice(-1),
  }));
  const line = `${state.status} | ${state.heard} | ${state.timer} | open=${state.open} ${state.errors.join('')}`;
  if (!state.open) break;
  await p.waitForTimeout(500);
}
await p.click('#voiceEndBtn').catch(() => {});
await p.waitForTimeout(1500);
await browser.close();
