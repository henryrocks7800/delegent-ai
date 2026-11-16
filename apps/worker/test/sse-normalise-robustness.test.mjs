// DEFECT HUNT 2026-06-05 — SSE event normaliser robustness (hypothesis #8).
// ---------------------------------------------------------------------------
// normaliseHermesEvent() runs on EVERY upstream run event the runner streams.
// A long/tool-heavy task emits hundreds of these, from several Hermes event
// dialects. If a malformed/oversized/unknown event could make it throw, the
// SSE relay's pull() catch would terminate the whole stream as 'stream_error'
// and finalize the assistant turn as failed (index.ts:5794) — turning one bad
// event into a dropped reply. These lock that it NEVER throws and that every
// input yields a well-formed envelope (falling through to raw.<type> for the
// unknown). GREEN today — a regression here would be a real long-task hazard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHermesEvent } from '../dist/index.js';

const RUN = 'run-1';
const HUGE = 'x'.repeat(2_000_000);

const fuzz = [
  ['null data', 'run.completed', null],
  ['string data', 'message.delta', 'not-an-object'],
  ['array data', 'tool.started', [1, 2, 3]],
  ['number data', 'response.created', 42],
  ['empty type + embedded event', '', { event: 'run.completed', output: 'done' }],
  ['empty type + no embedded event', '', {}],
  ['unknown type', 'totally.unknown.event', { foo: 'bar' }],
  ['type with reasoning substring', 'some.reasoning.delta', { delta: 'thinking...' }],
  ['huge delta', 'message.delta', { delta: HUGE }],
  ['huge tool output', 'tool.completed', { id: 't1', tool: 'terminal', output: HUGE }],
  ['tool with no id', 'tool.started', { tool: 'file' }],
  ['function_call item', 'response.output_item.added', { item: { type: 'function_call', id: 'fc1', name: 'web' } }],
  ['done sentinel', 'done', { done: true }],
  ['null type + null data', null, null],
  ['weird chars in type', 'evt\nwith\tcontrol', { x: 1 }],
];

test('normaliseHermesEvent never throws and always returns a well-formed envelope, across malformed/oversized/unknown events', () => {
  let seq = 0;
  for (const [label, type, data] of fuzz) {
    let out;
    assert.doesNotThrow(() => { out = normaliseHermesEvent(type, data, RUN, ++seq); }, `threw on: ${label}`);
    assert.equal(typeof out.type, 'string', `no type for: ${label}`);
    assert.equal(out.runId, RUN, `runId not propagated for: ${label}`);
    assert.equal(out.sequence, seq, `sequence not propagated for: ${label}`);
    assert.ok(out.type.length > 0, `empty type for: ${label}`);
  }
});

test('normaliseHermesEvent classifies the known dialects and falls through to raw.<type> for the unknown', () => {
  assert.equal(normaliseHermesEvent('', { event: 'run.completed', output: 'hi' }, RUN, 1).type, 'run.completed');
  assert.equal(normaliseHermesEvent('message.delta', { delta: 'hi' }, RUN, 2).type, 'assistant.text.delta');
  assert.equal(normaliseHermesEvent('tool.completed', { id: 't', tool: 'file' }, RUN, 3).type, 'tool.completed');
  assert.equal(normaliseHermesEvent('totally.unknown.event', {}, RUN, 4).type, 'raw.totally.unknown.event');
});
