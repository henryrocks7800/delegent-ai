import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIDEKICK_FREE_TRIAL } from '@sidekick/shared';
import { advertFromReferrer, advertHeadline, advertSeenKey, readFirstPaywallAdvert } from './advertContinuity';

test('only the three verified adverts can select a headline', () => {
  assert.equal(advertFromReferrer('utm_source=facebook&ad_id=120248171699360408'), 'night');
  assert.equal(advertFromReferrer('ad_id=120248173267850408'), 'interview');
  assert.equal(advertFromReferrer('ad_id=120248157165390408&fbclid=ignored'), 'short_b');
  for (const raw of ['', 'ad_id=constructor', 'ad_id=unknown&headline=Free+forever', 'x'.repeat(8193)]) assert.equal(advertFromReferrer(raw), null);
});
test('headlines keep the advert promise and do not promise a returning subscriber a new intro', () => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  try {
    assert.equal(advertHeadline('night', 'inactive', null), 'Receipts, filed while you sleep');
    assert.equal(advertHeadline('short_b', 'inactive', null), 'Your inbox, read and sorted');
    SIDEKICK_FREE_TRIAL.enabled = false;
    assert.equal(advertHeadline('interview', 'inactive', null), 'Your first AI coworker, from £2.99');
    assert.equal(advertHeadline('interview', 'canceled', '2026-09-01T00:00:00Z'), 'Your first AI coworker, from £9.99');
    SIDEKICK_FREE_TRIAL.enabled = true;
    assert.equal(advertHeadline('interview', 'inactive', null), 'Meet your first AI coworker. Try 3 days free.');
    assert.equal(advertHeadline('interview', 'canceled', '2026-09-01T00:00:00Z'), 'Your first AI coworker, from £9.99');
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});
test('iOS and an already-seen account never ask Play for a referrer', async () => {
  let reads = 0;
  const deps = { userId: 'test-user', platform: 'ios', getItem: async () => null,
    getReferrer: async () => { reads++; return 'ad_id=120248171699360408'; } };
  assert.equal(await readFirstPaywallAdvert(deps), null);
  assert.equal(await readFirstPaywallAdvert({ ...deps, platform: 'android', getItem: async (key) => key === advertSeenKey('test-user') ? '1' : null }), null);
  assert.equal(reads, 0);
  assert.equal(await readFirstPaywallAdvert({ ...deps, platform: 'android' }), 'night');
  assert.equal(reads, 1);
});
