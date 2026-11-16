import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MODEL_FILE_MAX_BYTES, imageForModel } from '../src/images.ts';

/** A fake Cloudflare Images binding: each transform returns the next size given. */
function fakeImages(...outputs: (number | Error)[]) {
  const calls: { transform?: unknown; output?: unknown }[] = [];
  const queue = [...outputs];
  const binding = {
    input(_stream: ReadableStream<Uint8Array>) {
      const call: { transform?: unknown; output?: unknown } = {};
      calls.push(call);
      const transformer = {
        transform(options: unknown) { call.transform = options; return transformer; },
        async output(options: unknown) {
          call.output = options;
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return { response: () => new Response(new Uint8Array(next ?? 0)) };
        },
      };
      return transformer;
    },
  };
  return { binding: binding as unknown as ImagesBinding, calls };
}

const big = new Uint8Array(6_782_454).fill(7);

test('a big photo reaches the model as a 2048 px JPEG copy', async () => {
  // Alex's 6.8 MB EV charger photo was read as "an Adidas item" and "an extension
  // lead"; at 2048 px it was read correctly (2026-09-15).
  const { binding, calls } = fakeImages(303_315);
  const result = await imageForModel(binding, 'image/jpeg', big);
  assert.equal(result.bytes.byteLength, 303_315);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.tooLarge, undefined);
  assert.deepEqual(calls[0].transform, { width: 2048, height: 2048, fit: 'scale-down' });
  assert.deepEqual(calls[0].output, { format: 'image/jpeg', quality: 85 });
});

test('a photo still too big at 2048 px is tried smaller, and dropped if that fails too', async () => {
  const second = fakeImages(1_400_000, 640_000);
  const smaller = await imageForModel(second.binding, 'image/jpeg', big);
  assert.equal(smaller.bytes.byteLength, 640_000);
  assert.deepEqual(second.calls[1].transform, { width: 1280, height: 1280, fit: 'scale-down' });
  const stubborn = fakeImages(2_000_000, 1_900_000);
  const dropped = await imageForModel(stubborn.binding, 'image/jpeg', big);
  assert.equal(dropped.tooLarge, true);
  assert.equal(dropped.bytes, big, 'the original is untouched, it just never enters the conversation');
});

test('nothing over the ceiling enters a conversation, whatever it is', async () => {
  // A 6.8 MB photo in the context failed the framework's own write with
  // SQLITE_TOOBIG on every turn, and every reply died with it (2026-09-16).
  assert.equal(MODEL_FILE_MAX_BYTES, 1_000_000);
  const pdf = await imageForModel(fakeImages(1).binding, 'application/pdf', big);
  assert.equal(pdf.tooLarge, true);
  const noBinding = await imageForModel(undefined, 'image/jpeg', big);
  assert.equal(noBinding.tooLarge, true);
  const failed = await imageForModel(fakeImages(new Error('images unavailable')).binding, 'image/png', big);
  assert.equal(failed.tooLarge, true);
});

test('small files are left exactly as they are, with no transform at all', async () => {
  const { binding, calls } = fakeImages(10);
  const small = new Uint8Array(400_000);
  const asIs = await imageForModel(binding, 'image/jpeg', small);
  assert.equal(asIs.bytes, small);
  assert.equal(asIs.tooLarge, undefined);
  assert.equal((await imageForModel(binding, 'application/pdf', small)).bytes, small);
  assert.equal(calls.length, 0);
});

test('the engine drops an oversized file from the message and says so, keeping the original stored', () => {
  const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
  assert.match(agent, /const forModel = await imageForModel\(this\.env\.IMAGES, file\.mime, file\.bytes\);/);
  assert.match(agent, /if \(forModel\.tooLarge\) \{[\s\S]{0,80}tooLarge\.push/);
  assert.match(agent, /parts: \[\.\.\.fileParts, \.\.\.attachedNote, \.\.\.tooLargeNote,/);
  assert.match(agent, /Too large to read here: \$\{tooLarge\.join\(', '\)\}/);
  assert.match(agent, /Say plainly that you cannot read a file this big in the chat/);
  // attach_file still reads the stored original, so it can still be emailed.
  assert.match(agent, /const found = id \? this\.readFile\(id\) : null;[\s\S]*?stageForTool\(this\.env\.COMPOSIO_API_KEY, target\.tool, found\.name, found\.mime, found\.bytes\)/);
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"images": \{ "binding": "IMAGES" \}/);
});
