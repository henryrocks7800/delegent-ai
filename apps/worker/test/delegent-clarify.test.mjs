// Route B — clarify-question composer-lock fix (2026-07-09 live incident).
//
// Hermes' clarify tool pauses the turn (up to agent.clarify_timeout, default
// 600s) waiting for the USER's answer. The base-class text fallback streamed
// the question as plain content with no 'done', so the app composer stayed
// locked against the very answer the agent was waiting for — a hard deadlock
// only an app restart escaped (three hung turns for one user, 2026-07-09).
//
// Contract now: the adapter relays a structured kind:'clarify' frame and the
// Worker FINALIZES the app run with the question (composer unlocks). The
// user's typed answer is the next normal message; the gateway's text-intercept
// resolves the paused clarify and the resumed turn streams on the answer
// message's own run. These tests lock the translator + probe-parse invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDelegentTranslator,
  parseDelegentPendingClarify,
} from '../dist/index.js';

const RUN = 'app-run-clarify';
const CLARIFY = {
  kind: 'clarify',
  clarify_id: 'clr1',
  question: 'Proceed with what you know?',
  choices: ['Yes, proceed', 'Wait until documents are uploaded'],
  text: '❓ Proceed with what you know?\n\n  1. Yes, proceed\n  2. Wait until documents are uploaded\n\nReply with the number, the option text, or your own answer.',
};

test('clarify frame is terminal: question streams as text, run completes (composer unlocks)', () => {
  const t = createDelegentTranslator(RUN);
  const events = t.push(CLARIFY);
  assert.deepEqual(
    events.map((e) => e.type),
    ['assistant.text.delta', 'assistant.clarify.requested', 'run.completed'],
  );
  assert.equal(events[0].payload.delta, CLARIFY.text);
  // Structured payload for a future tappable-chip UI (the current app ignores
  // unknown event types — its dispatcher is a fall-through if-chain).
  assert.deepEqual(events[1].payload, {
    clarifyId: 'clr1',
    question: CLARIFY.question,
    choices: CLARIFY.choices,
  });
  // run.completed is what unlocks the composer AND what finalizeOnce persists.
  assert.equal(events[2].payload.finalText, CLARIFY.text);
  assert.equal(t.terminal, true);
  assert.equal(t.synthetic, false);
  assert.equal(t.finalizeReason, 'completed');
  assert.equal(t.finalText, CLARIFY.text);
});

test('clarify appends AFTER already-streamed turn text, separated', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'Let me check the lease context. ▉' });
  const events = t.push(CLARIFY);
  assert.equal(t.finalText, `Let me check the lease context.\n\n${CLARIFY.text}`);
  const delta = events.find((e) => e.type === 'assistant.text.delta');
  assert.equal(delta.payload.delta, `\n\n${CLARIFY.text}`);
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(events.at(-1).payload.finalText, t.finalText);
});

test('replayed clarify (record replay / reconcile re-emit) renders once', () => {
  const t = createDelegentTranslator(RUN);
  assert.equal(t.push(CLARIFY).length, 3);
  // The runner replays an unanswered question on stream (re)open, and the
  // reconcile path re-emits it from the run record — dedupe by clarify_id.
  assert.deepEqual(t.push(CLARIFY), []);
  assert.equal(t.terminal, true);
});

test('clarify with no prebuilt text falls back to the bare question', () => {
  const t = createDelegentTranslator(RUN);
  const events = t.push({ kind: 'clarify', clarify_id: 'clr2', question: 'Which jurisdiction?' });
  const delta = events.find((e) => e.type === 'assistant.text.delta');
  assert.equal(delta.payload.delta, '❓ Which jurisdiction?');
  assert.equal(events.at(-1).type, 'run.completed');
});

test('clarify strips a streaming cursor from the prebuilt text', () => {
  const t = createDelegentTranslator(RUN);
  const events = t.push({ kind: 'clarify', clarify_id: 'clr3', question: 'Q?', text: '❓ Q? ▉' });
  const delta = events.find((e) => e.type === 'assistant.text.delta');
  assert.equal(delta.payload.delta, '❓ Q?');
});

test('parseDelegentPendingClarify: happy path, junk tolerance, absent', () => {
  assert.deepEqual(
    parseDelegentPendingClarify({ clarify_id: 'clr4', question: 'Q?', choices: ['a', 'b'], text: '❓ Q?' }),
    { clarifyId: 'clr4', question: 'Q?', choices: ['a', 'b'], text: '❓ Q?' },
  );
  // non-string junk in choices is dropped, not fatal
  assert.deepEqual(
    parseDelegentPendingClarify({ clarify_id: 'x', question: '', choices: ['a', 5, null], text: '' }).choices,
    ['a'],
  );
  // a record without choices (open-ended clarify) still parses
  assert.deepEqual(
    parseDelegentPendingClarify({ clarify_id: 'y', question: 'open?', choices: null, text: '❓ open?' }),
    { clarifyId: 'y', question: 'open?', choices: [], text: '❓ open?' },
  );
  assert.equal(parseDelegentPendingClarify(null), null);
  assert.equal(parseDelegentPendingClarify('nope'), null);
  assert.equal(parseDelegentPendingClarify({}), null);
});
