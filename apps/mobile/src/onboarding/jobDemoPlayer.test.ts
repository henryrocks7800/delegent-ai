import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { jobDemoHtml, REPLAY_DEMO_SCRIPT } from './jobDemoPlayer';

test('completion notifies the native finish card without restarting the video', () => {
  const html = jobDemoHtml('VIDEO', 'POSTER');
  const videoTag = html.match(/<video\b[^>]*>/)![0];
  assert.doesNotMatch(videoTag, /\bloop\b/);
  assert.match(videoTag, /\bcontrols\b/, 'manual play remains available if autoplay is blocked');
  assert.match(videoTag, /\bplaysinline\b/);
  const events: string[] = [];
  const ended = videoTag.match(/onended="([^"]+)"/)![1];
  runInNewContext(ended, { window: { ReactNativeWebView: { postMessage: (event: string) => events.push(event) } } });
  assert.deepEqual(events, ['ended']);
});

test('Replay resets to the start and asks the actual player to play once', async () => {
  let plays = 0;
  const video = { currentTime:10, play: () => { plays += 1; return Promise.resolve(); } };
  runInNewContext(REPLAY_DEMO_SCRIPT, { document: { getElementById: () => video } });
  assert.equal(video.currentTime, 0);
  assert.equal(plays, 1);
});

test('a rejected replay surfaces the usable preview fallback', async () => {
  const events: string[] = [];
  runInNewContext(REPLAY_DEMO_SCRIPT, {
    document: { getElementById: () => ({ currentTime:10, play: () => Promise.reject(new Error('unavailable')) }) },
    window: { ReactNativeWebView: { postMessage: (event: string) => events.push(event) } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['failed']);
});
