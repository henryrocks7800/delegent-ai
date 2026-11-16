// Chat-memory resilience (2026-06-03 critical defect: the agent lost ALL
// conversation memory and told the user "this is our very first conversation"
// after a transient Supabase read blip). loadRecentChatHistory must retry and
// must DISTINGUISH a genuine-empty conversation from a load FAILURE.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRecentChatHistory, buildStreamingChatInput } from '../dist/index.js';

const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
function withFetch(impl, fn) {
  const o = globalThis.fetch; globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = o; });
}

test('success: returns history oldest-first, loadFailed=false', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [
    { role: 'assistant', content: 'hi there', status: 'complete', created_at: '3' },
    { role: 'user', content: 'hello', status: 'complete', created_at: '2' },
  ] }), async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'new question');
    assert.equal(r.loadFailed, false);
    assert.deepEqual(r.history, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }]);
  });
});

test('genuine empty conversation -> loadFailed=false (NOT a failure; new users are fine)', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [] }), async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'first message');
    assert.deepEqual(r, { history: [], loadFailed: false });
  });
});

test('retries a transient blip then succeeds — memory is NOT lost on one hiccup', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw new Error('network blip');
    return { ok: true, json: async () => [{ role: 'user', content: 'remembered', status: 'complete', created_at: '1' }] };
  }, async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'x');
    assert.equal(calls, 2);
    assert.equal(r.loadFailed, false);
    assert.deepEqual(r.history, [{ role: 'user', content: 'remembered' }]);
  });
});

test('all attempts fail -> loadFailed=TRUE (the signal that stops the agent gaslighting)', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; }, async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'x');
    assert.equal(r.loadFailed, true);
    assert.deepEqual(r.history, []);
    assert.ok(calls >= 3, `expected >= 3 attempts, got ${calls}`);
  });
});

test('strips the current instruction echoed as the trailing user turn', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [
    { role: 'user', content: 'CURRENT', status: 'complete', created_at: '2' },
    { role: 'assistant', content: 'earlier reply', status: 'complete', created_at: '1' },
  ] }), async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'CURRENT');
    assert.deepEqual(r.history, [{ role: 'assistant', content: 'earlier reply' }]);
  });
});

test('drop-current is whitespace-robust: a trailing-whitespace stored copy is still stripped (no duplicated current turn)', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [
    { role: 'user', content: 'CURRENT  ', status: 'complete', created_at: '2' }, // stored w/ trailing ws
    { role: 'assistant', content: 'earlier reply', status: 'complete', created_at: '1' },
  ] }), async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'CURRENT'); // trimmed instruction
    assert.deepEqual(r.history, [{ role: 'assistant', content: 'earlier reply' }],
      'current turn must be dropped despite a whitespace mismatch, else it duplicates in history + "Current request"');
  });
});

test('excludes queued/dispatched (incomplete) messages', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [
    { role: 'assistant', content: 'streaming...', status: 'dispatched', created_at: '2' },
    { role: 'user', content: 'done one', status: 'complete', created_at: '1' },
  ] }), async () => {
    const r = await loadRecentChatHistory(ENV, 'u1', 'x');
    assert.deepEqual(r.history, [{ role: 'user', content: 'done one' }]);
  });
});

// ---------------------------------------------------------------------------
// 2026-06-03 amnesia incident #2 (the STREAMING path). The in-app chat uses
// handleChatRunCreate -> runner /v1/runs, which used to send ONLY the new
// message — no conversation history — so the agent forgot every prior turn the
// moment a turn needed recall ("carry on" -> "this looks like the start of our
// conversation"). buildStreamingChatInput injects the history into the run input
// (same source-of-truth as the /tasks path). These lock that in by construction.
// ---------------------------------------------------------------------------

test('streaming input EMBEDS prior-turn history so the agent can recall it (the core amnesia fix)', () => {
  const history = [
    { role: 'user', content: 'Can you create me a spreadsheet to manage my home expenses?' },
    { role: 'assistant', content: 'Let me search for a good template for you.' },
  ];
  const input = buildStreamingChatInput(history, 'carry on', { agentName: 'Thais', historyUnavailable: false });
  assert.ok(input.includes('Recent conversation'), 'history block present');
  assert.ok(
    input.includes('User: Can you create me a spreadsheet to manage my home expenses?'),
    'the prior request MUST be in the input — this is exactly what the agent forgot',
  );
  assert.ok(input.includes('Thais: Let me search for a good template for you.'), 'prior assistant turn labelled with the agent name');
  assert.ok(input.includes('Current request from user: carry on'), 'current message present');
});

test('streaming input with NO history is just the current request (genuine new user is fine)', () => {
  const input = buildStreamingChatInput([], 'hello', { agentName: 'Thais', historyUnavailable: false });
  assert.ok(!input.includes('Recent conversation'));
  assert.equal(input, 'Current request from user: hello');
});

test('streaming input injects the honesty caution on a history-load FAILURE (never claim "first conversation")', () => {
  const input = buildStreamingChatInput([], 'what were we talking about?', { agentName: 'Thais', historyUnavailable: true });
  assert.ok(/could not load our earlier conversation/i.test(input), 'caution present');
  assert.ok(/do NOT tell the user this is a new or first conversation/i.test(input), 'explicit anti-gaslight instruction');
  assert.ok(input.includes('Current request from user: what were we talking about?'));
});

test('streaming input skips empty turns (e.g. the dangling queued placeholder a Stop leaves behind)', () => {
  const history = [
    { role: 'user', content: 'real question' },
    { role: 'assistant', content: '   ' }, // empty/whitespace — like the stopped, un-finalized run
  ];
  const input = buildStreamingChatInput(history, 'next', { agentName: 'Thais', historyUnavailable: false });
  assert.ok(input.includes('User: real question'));
  assert.ok(!/^Thais:\s*$/m.test(input), 'no empty assistant label line from the dangling row');
});
