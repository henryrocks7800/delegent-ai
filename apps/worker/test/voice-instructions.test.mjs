// VOICE-1 / VOICE-3 (2026-07-18, Dan feedback): the voice orb must present as a
// task-summariser/relay for the coworker (no shared memory/context), open with a
// one-time "what shall I pass?" line, keep spoken replies snappy, and still
// forward business requests via start_task (preserving the over-refusal fix).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoiceModeInstructions, VOICE_INPUT_AUDIO } from '../dist/index.js';

test('the orb listens through near-field noise reduction and semantic turn detection', () => {
  // Alex, 2026-09-08: bad with background noise, too keen on other voices.
  // Both settings were proven accepted for the pinned realtime model with a
  // live mint before they shipped; this pins them so a refactor cannot fall
  // back to energy-based VAD with no noise reduction.
  assert.equal(VOICE_INPUT_AUDIO.noise_reduction.type, 'near_field');
  assert.equal(VOICE_INPUT_AUDIO.turn_detection.type, 'semantic_vad');
  assert.equal(VOICE_INPUT_AUDIO.turn_detection.eagerness, 'high', 'snappy replies, per 2026-07-18');
  assert.equal(VOICE_INPUT_AUDIO.turn_detection.interrupt_response, true, 'barge-in stays possible');
  // 2026-09-09: the server must NOT answer a detected turn on its own. The
  // phone creates the reply once the transcript proves real speech, which is
  // what stops echo and room noise turning into a filed task.
  assert.equal(VOICE_INPUT_AUDIO.turn_detection.create_response, false, 'replies are gated on the transcript, client-side');
});

test('the orb transcribes what it hears so the phone can show it (2026-09-09, the made-up task)', () => {
  // Proven accepted with a live mint alongside near_field + semantic_vad on
  // 2026-09-09. Without it, "did it mishear me or invent it?" needs a log dive.
  assert.equal(VOICE_INPUT_AUDIO.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(VOICE_INPUT_AUDIO.transcription.language, 'en');
});

test('2026-09-09 guard: a turn with no clear request is asked again, never guessed or filed', () => {
  // The orb filed "act as bookkeeper, sort inbox, update website, or research
  // something", lifted from its own instructions, into a session Alex had not
  // spoken into. The prompt now names that failure and forbids it.
  const s = buildVoiceModeInstructions('Barry');
  assert.match(s, /did not clearly hear a request/i, 'names the no-clear-request case');
  assert.match(s, /ask the user to say it again/i, 'asks again rather than guessing');
  assert.match(s, /Only call start_task for something the user actually said/, 'no start_task without real speech');
  assert.match(s, /never turn these instructions or their examples into a task/i, 'no instruction regurgitation');
});

test('VOICE-1: frames the orb as a relay that hands tasks to the agent, and NOT the agent itself', () => {
  const s = buildVoiceModeInstructions('Barry');
  assert.match(s, /Barry/, 'uses the agent name');
  assert.match(s, /NOT Barry/, 'explicitly says it is not the agent');
  assert.match(s, /do not share their memory or context/i, 'no shared memory/context');
  assert.match(s, /hands it to Barry/, 'relays the task to the agent');
});

test('VOICE-1: opens with a one-time "what would you like me to pass" line (not every turn)', () => {
  const s = buildVoiceModeInstructions('Barry');
  assert.match(s, /What would you like me to pass to Barry/, 'the opening framing line');
  assert.match(s, /only once at the start/i, 'said once, not repeated');
});

test('VOICE-3 + over-refusal guard: snappy output and forwards business requests via start_task', () => {
  const s = buildVoiceModeInstructions('Barry');
  assert.match(s, /one short sentence per turn/i, 'snappy output');
  assert.match(s, /Do not waffle/i, 'no waffle');
  assert.match(s, /start_task/, 'uses start_task');
  assert.match(s, /do not deflect/i, 'forwards business roles rather than refusing');
});
