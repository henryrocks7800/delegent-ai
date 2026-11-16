import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubAgentSelfReference } from '../dist/index.js';

// R-CHAT-09 brand guard: the persisted assistant text must never carry a
// "Hermes agent" self-reference (the model occasionally leaks it despite the
// runner prompt; 1/43 messages on 2026-06-09). scrubAgentSelfReference is the
// deterministic safety net applied in finalizeChatRun before the messages row
// is written.

test('R-CHAT-09: scrubs the "Hermes agent" self-reference', () => {
  assert.equal(
    scrubAgentSelfReference('a good practise setup of Hermes agent which you are'),
    'a good practise setup of your coworker which you are',
  );
  assert.equal(scrubAgentSelfReference('I am the Hermes agent, here to help'), 'I am your coworker, here to help');
  assert.equal(scrubAgentSelfReference('HERMES AGENT'), 'your coworker'); // case-insensitive
  assert.equal(scrubAgentSelfReference('the hermes agent'), 'your coworker');
});

test('R-CHAT-09: leaves innocent words and standalone "Hermes" untouched', () => {
  // standalone "Hermes" (the deity, or a brand the user asked about) is NOT a leak
  assert.equal(scrubAgentSelfReference('Hermes was the Greek messenger god'), 'Hermes was the Greek messenger god');
  // generic words a user might legitimately use
  assert.equal(scrubAgentSelfReference('my washing machine is broken'), 'my washing machine is broken');
  assert.equal(scrubAgentSelfReference('training for a marathon as a runner'), 'training for a marathon as a runner');
  assert.equal(scrubAgentSelfReference('how do I query Supabase from my app?'), 'how do I query Supabase from my app?');
});

test('R-CHAT-09: safe on empty / non-string input', () => {
  assert.equal(scrubAgentSelfReference(''), '');
  assert.equal(scrubAgentSelfReference(null), null);
  assert.equal(scrubAgentSelfReference(undefined), undefined);
});
