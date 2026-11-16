import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGa4CollectUrl,
  createGa4Tracker,
  isValidGa4EventName,
  GA4_COLLECT_ENDPOINT,
} from './ga4';

test('buildGa4CollectUrl speaks the gtag wire shape: v=2, tid, cid, sid, en', () => {
  const url = new URL(buildGa4CollectUrl({
    measurementId: 'G-TEST123',
    clientId: 'cid-1',
    sessionId: 'sid-1',
    eventName: 'payment_completed',
    props: { tier: 'studio', attempt: 2, retried: false },
  }));
  assert.equal(`${url.origin}${url.pathname}`, GA4_COLLECT_ENDPOINT);
  assert.equal(url.searchParams.get('v'), '2');
  assert.equal(url.searchParams.get('tid'), 'G-TEST123');
  assert.equal(url.searchParams.get('cid'), 'cid-1');
  assert.equal(url.searchParams.get('sid'), 'sid-1');
  assert.equal(url.searchParams.get('en'), 'payment_completed');
  // Strings ride as ep.*, finite numbers as epn.*, booleans stringify.
  assert.equal(url.searchParams.get('ep.tier'), 'studio');
  assert.equal(url.searchParams.get('epn.attempt'), '2');
  assert.equal(url.searchParams.get('ep.retried'), 'false');
});

test('buildGa4CollectUrl drops null/undefined props, sanitises keys, truncates values', () => {
  const url = new URL(buildGa4CollectUrl({
    measurementId: 'G-T',
    clientId: 'c',
    sessionId: 's',
    eventName: 'screen_view',
    props: {
      gone: null,
      missing: undefined,
      'weird key!': 'kept',
      long: 'x'.repeat(300),
    },
  }));
  assert.equal(url.searchParams.get('ep.gone'), null);
  assert.equal(url.searchParams.get('ep.missing'), null);
  assert.equal(url.searchParams.get('ep.weird_key_'), 'kept', 'key charset is sanitised');
  assert.equal(url.searchParams.get('ep.long')?.length, 100, 'values truncate at the GA 100-char cap');
});

test('event-name contract: letters/digits/underscores, starts with a letter, max 40', () => {
  assert.equal(isValidGa4EventName('sign_in_completed'), true);
  assert.equal(isValidGa4EventName('viewed_plans'), true);
  assert.equal(isValidGa4EventName('9starts_with_digit'), false);
  assert.equal(isValidGa4EventName('has-dash'), false);
  assert.equal(isValidGa4EventName('x'.repeat(41)), false);
  assert.equal(isValidGa4EventName(''), false);
});

test('tracker sends events in order and settles the queue', async () => {
  const sent: string[] = [];
  const tracker = createGa4Tracker({
    measurementId: 'G-T',
    clientId: 'c',
    sessionId: 's',
    fetchFn: async (url) => { sent.push(new URL(url).searchParams.get('en') ?? ''); },
  });
  tracker.trackEvent('viewed_plans');
  tracker.trackEvent('tapped_upgrade', { tier: 'studio' });
  tracker.trackEvent('reached_stripe');
  await tracker.flush();
  assert.deepEqual(sent, ['viewed_plans', 'tapped_upgrade', 'reached_stripe']);
  assert.equal(tracker.pending, 0);
});

test('tracker swallows transport failures and keeps draining (never throws to the caller)', async () => {
  const sent: string[] = [];
  const tracker = createGa4Tracker({
    measurementId: 'G-T',
    clientId: 'c',
    sessionId: 's',
    fetchFn: async (url) => {
      const en = new URL(url).searchParams.get('en') ?? '';
      if (en === 'boom') throw new Error('network fell over');
      sent.push(en);
    },
  });
  tracker.trackEvent('boom');
  tracker.trackEvent('after_failure');
  await tracker.flush();
  assert.deepEqual(sent, ['after_failure'], 'the failed event is dropped, the next still sends');
});

test('tracker skips invalid event names silently', async () => {
  let calls = 0;
  const tracker = createGa4Tracker({
    measurementId: 'G-T', clientId: 'c', sessionId: 's',
    fetchFn: async () => { calls += 1; },
  });
  tracker.trackEvent('bad-name!');
  await tracker.flush();
  assert.equal(calls, 0);
});

test('tracker sheds events past the offline backstop instead of growing unboundedly', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const tracker = createGa4Tracker({
    measurementId: 'G-T', clientId: 'c', sessionId: 's',
    fetchFn: async () => { calls += 1; await gate; },
  });
  // First event starts draining and blocks on the gate; the queue then fills.
  for (let i = 0; i < 60; i += 1) tracker.trackEvent('screen_view', { n: i });
  assert.ok(tracker.pending <= 40, `queue must cap at the backstop, saw ${tracker.pending}`);
  release();
  await tracker.flush();
  assert.ok(calls <= 41, 'shed events are never sent');
});
