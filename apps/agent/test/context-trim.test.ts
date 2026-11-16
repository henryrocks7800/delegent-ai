import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { dropOldMedia } from '../src/contextTrim.ts';

const photo = { type: 'image' as const, image: 'data:image/jpeg;base64,AAAA', mediaType: 'image/jpeg' };
const pdf = { type: 'file' as const, data: 'data:application/pdf;base64,AAAA', mediaType: 'application/pdf', filename: 'invoice.pdf' };
const user = (...content: ModelMessage['content'][number][]) => ({ role: 'user', content }) as ModelMessage;
const reply = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] }) as ModelMessage;

test('photos and files older than the last two user messages become a short note; recent ones stay whole', () => {
  const messages = [
    user(photo, { type: 'text', text: 'what is this?' }), reply('A receipt.'),
    user(pdf, { type: 'text', text: 'and this?' }), reply('An invoice.'),
    user(photo, { type: 'text', text: 'one more' }), reply('A photo.'),
    user({ type: 'text', text: 'thanks' }),
  ];
  const out = dropOldMedia(messages)!;
  assert.ok(out);
  const parts = (index: number) => out[index]!.content as { type: string; text?: string }[];
  assert.equal(parts(0)[0]!.type, 'text');
  assert.match(parts(0)[0]!.text!, /A photo the user sent earlier is not shown again/);
  assert.equal(parts(2)[0]!.type, 'text');
  assert.match(parts(2)[0]!.text!, /The file invoice\.pdf/);
  assert.match(parts(2)[0]!.text!, /attach_file/);
  assert.equal(parts(4)[0]!.type, 'image', 'the second-last user message keeps its photo');
  assert.deepEqual(out.slice(5), messages.slice(5));
  assert.equal(messages[0]!.content[0], photo, 'the stored history is not mutated');
});

test('nothing to drop returns null, so the step is left untouched', () => {
  assert.equal(dropOldMedia([user({ type: 'text', text: 'hi' }), reply('hello'), user({ type: 'text', text: 'again' })]), null);
  assert.equal(dropOldMedia([user(photo)]), null);
});

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');

test('the system prompt carries the date only, and each user message its own send time, so the prompt cache survives', () => {
  assert.doesNotMatch(agent, /Current date and time \(UK\)/);
  assert.match(agent, /toLocaleDateString\('en-GB', \{ timeZone: 'Europe\/London', dateStyle: 'full' \}\)/);
  assert.match(agent, /Today's date \(UK\): \$\{today\}/);
  assert.match(agent, /text: `\[Sent \$\{sentAt\} UK time\] \$\{text\}`/);
  assert.match(agent, /const messages = dropOldMedia\(capped \?\? ctx\.messages\) \?\? capped;/);
});

test('deleting an account stops a running inbox sort and forgets the sort store', () => {
  const wipe = agent.slice(agent.indexOf('async wipe()'), agent.indexOf('// ── Tools of our own'));
  assert.match(wipe, /this\.inboxSortStore\(\)\.active\(\)/);
  assert.match(wipe, /await this\.terminateWorkflow\(active\.workflowId\)/);
  assert.ok(wipe.indexOf('terminateWorkflow') < wipe.indexOf('deleteAll()'), 'the sort is stopped before storage goes');
  assert.match(wipe, /this\.inboxSortStoreValue = null;/);
});

test('a wipe restarts the instance, so an account that is reset rather than deleted can chat again (2026-09-23)', () => {
  // After deleteAll the SDK's own tables are gone but this instance still uses
  // them: the test account's first chat after a reset failed until a redeploy.
  const wipe = agent.slice(agent.indexOf('async wipe()'), agent.indexOf('// ── Tools of our own'));
  assert.match(wipe, /setTimeout\(\(\) => this\.ctx\.abort\('account data wiped'\), 100\);/);
  assert.ok(wipe.indexOf('deleteAll()') < wipe.indexOf('this.ctx.abort'), 'the restart comes after the storage is gone');
  assert.ok(wipe.indexOf('this.ctx.abort') < wipe.indexOf('return { ok: true }'), 'and is scheduled before the answer returns');
});
