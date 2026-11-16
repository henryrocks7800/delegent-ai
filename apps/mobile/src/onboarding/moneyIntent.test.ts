import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { FLIGHT_BANDS, flightUpTo, moneyDetail, moneyLine, parseMoneyIntent, pounds } from './moneyIntent';

const check = readFileSync(new URL('./MoneyCheck.tsx', import.meta.url), 'utf8');

test('the only pound figures are the UK261 maximums per passenger', () => {
  // UK261: 1,500 km or less £220, 1,500 to 3,500 km £350, over 3,500 km £520.
  assert.deepEqual(Object.values(FLIGHT_BANDS).map((band) => band.pounds), [220, 350, 520]);
  assert.equal(flightUpTo({ kinds: ['flight'], band: 'short', travellers: 2 }), 440, 'the £440 of the first test is two short-haul passengers');
  assert.equal(flightUpTo({ kinds: ['flight'], band: 'long', travellers: 3 }), 1560);
  assert.equal(flightUpTo({ kinds: ['refund', 'double'], band: 'long', travellers: 4 }), 0, 'no flight, no figure');
  // Refunds, double charges and subscriptions never get a number.
  assert.equal(moneyLine({ kinds: ['refund', 'double', 'subs'], band: 'short', travellers: 1 }),
    'A refund to chase, double charges to claim back and subscriptions to stop paying.');
  assert.doesNotMatch(moneyLine({ kinds: ['refund'], band: 'short', travellers: 1 }), /£/);
});

test('figures read as "up to", with the conditions and the real example labelled', () => {
  assert.equal(moneyLine({ kinds: ['flight', 'refund'], band: 'medium', travellers: 2 }), 'Up to £700 for your flight, plus a refund to chase.');
  assert.equal(moneyDetail({ kinds: ['flight', 'double'], band: 'short', travellers: 2 }), 'For the flight, for 2 of you, plus double charges to claim back.');
  assert.equal(moneyDetail({ kinds: ['subs'], band: 'short', travellers: 2 }), 'Subscriptions to stop paying.');
  assert.equal(pounds(1040), '£1,040');
  assert.equal(pounds(4680), '£4,680');
  assert.match(check, /up to \$\{pounds\(shown\)\}/);
  assert.match(check, /The flight claim is lodged, not yet paid\. Results vary\./);
  assert.match(check, /airlines can refuse for things like bad weather/);
  // The FAQ's own promise about what Money Finder does to a mailbox.
  assert.match(check, /It only reads and reports\. Nothing is sent, moved or changed\./);
});

test('a stored check is validated, and anything malformed is no check at all', () => {
  assert.equal(parseMoneyIntent(null), null);
  assert.equal(parseMoneyIntent('not json'), null);
  assert.equal(parseMoneyIntent('null'), null);
  assert.equal(parseMoneyIntent(JSON.stringify({ kinds: ['flight'], band: 'orbit' })), null);
  const read = parseMoneyIntent(JSON.stringify({ kinds: ['flight', 'crypto', 'subs'], band: 'long', travellers: 40, wants: true, savedAt: 'x' }));
  assert.deepEqual(read, { kinds: ['flight', 'subs'], band: 'long', travellers: 9, wants: true, savedAt: 'x' });
  assert.equal(parseMoneyIntent(JSON.stringify({ kinds: [], band: 'short', travellers: 0, wants: false }))?.wants, false);
  assert.equal(parseMoneyIntent(JSON.stringify({ kinds: [], band: 'short', travellers: 0, wants: false }))?.travellers, 1);
});
