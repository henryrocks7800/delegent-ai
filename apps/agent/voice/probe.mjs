#!/usr/bin/env node
// EXPERIMENT probe for voice/worker.ts: one live Talk turn from this box,
// with a synthesised voice instead of a microphone. Test account only.
//
//   node apps/agent/voice-test/probe.mjs <speech.wav: 16 kHz mono 16-bit> [host]
//
// Prints each server message and the timings that matter: how long until the
// coworker's first spoken audio came back after the speech ended.
import { readFileSync, writeFileSync } from 'node:fs';

const WAV = process.argv[2];
const HOST = process.argv[3] || 'voice.delegantai.co.uk';
const EMAIL = 'tester@example.com';
if (!WAV) throw new Error('usage: probe.mjs <speech.wav> [host]');

const env = Object.fromEntries(
  readFileSync(process.env.USERPROFILE + '/.coworker-ai/live-provider.env', 'utf8')
    .split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
const SUPA = env.SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function mintToken(email) {
  const link = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  }).then((r) => r.json());
  const action = link?.properties?.action_link || link?.action_link;
  const verified = await fetch(action, { redirect: 'manual' });
  const location = verified.headers.get('location') || '';
  const fragment = location.includes('#') ? location.split('#')[1] : (location.split('?')[1] || '');
  return new URLSearchParams(fragment).get('access_token');
}

// PCM samples after the 44-byte WAV header.
const pcm = readFileSync(WAV).subarray(44);
const token = await mintToken(EMAIL);
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;

const session = await fetch(`https://${HOST}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
const s = await session.json();
console.log(ms(), 'session', session.status, s.ticket ? 'ticket ok' : JSON.stringify(s));
if (!s.ticket) process.exit(1);

const ws = new WebSocket(`wss://${HOST}/agents/voice-call/${s.name}?ticket=${s.ticket}`);
ws.binaryType = 'arraybuffer';
let speechEndedAt = 0;
let firstAudioAfterSpeech = 0;
let audioBytes = 0;
const audio = [];
let greeted = false;

async function sendSpeech() {
  // Real time: 20 ms frames (640 bytes), then 1.5 s of silence for end of turn.
  const frame = 640;
  for (let i = 0; i < pcm.length; i += frame) {
    ws.send(pcm.subarray(i, i + frame));
    await new Promise((r) => setTimeout(r, 20));
  }
  speechEndedAt = Date.now();
  console.log(ms(), 'speech sent');
  const silence = new Uint8Array(frame);
  for (let i = 0; i < 1500; i++) { ws.send(silence); await new Promise((r) => setTimeout(r, 20)); }
}

ws.onopen = () => {
  console.log(ms(), 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol_version: 1 }));
  ws.send(JSON.stringify({ type: 'start_call' }));
};
ws.onmessage = (m) => {
  if (typeof m.data !== 'string') {
    audioBytes += m.data.byteLength;
    audio.push(Buffer.from(m.data));
    if (speechEndedAt && !firstAudioAfterSpeech) {
      firstAudioAfterSpeech = Date.now();
      console.log(ms(), `FIRST REPLY AUDIO ${firstAudioAfterSpeech - speechEndedAt} ms after the speech ended`);
    }
    return;
  }
  const msg = JSON.parse(m.data);
  if (msg.type === 'transcript_delta' || msg.type === 'transcript_interim' || msg.type === 'metrics' || msg.type === 'diagnostic') return;
  console.log(ms(), JSON.stringify(msg).slice(0, 220));
  // Speak once the greeting has played and it is listening again.
  if (msg.type === 'status' && msg.status === 'listening' && !greeted) {
    greeted = true;
    setTimeout(() => void sendSpeech(), 3500);
  }
};
ws.onclose = (e) => console.log(ms(), 'closed', e.code, e.reason);
ws.onerror = (e) => console.log(ms(), 'error', e.message ?? '');

setTimeout(() => {
  writeFileSync(WAV.replace(/\.wav$/, '') + '-reply.mp3', Buffer.concat(audio));
  console.log(ms(), `audio received: ${audioBytes} bytes (saved beside the input as -reply.mp3)`);
  try { ws.send(JSON.stringify({ type: 'end_call' })); } catch {}
  setTimeout(() => { ws.close(); process.exit(0); }, 1500);
}, Number(process.env.PROBE_SECONDS || 45) * 1000);
