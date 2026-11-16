// The ad-click counter, and the privacy claim it carries.
//
// The policy text shipped alongside this says, in plain words: "It stores
// nothing on your device and reads nothing from it... We do not record your IP
// address, your browser details, or anything else that identifies you." That is
// a promise made to the public by an ICO-registered company, so it is tested
// rather than asserted in a comment.
//
// The other thing under test is the macro guard. Meta resolves {{campaign.id}}
// and friends at delivery time. An UNRESOLVED macro is a URL built wrong, and
// storing the literal string would quietly pollute every count computed off
// this table forever, which is the same class of failure as the referrer that
// hardcoded a paused campaign's name for a month.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseAdClickQuery,
  platformFromUserAgent,
  isAllowedClickOrigin,
  handleAdClick,
  AD_CLICK_DESTINATIONS,
  AD_CLICK_EVENTS,
} = await import('../dist/adClicks.js');

test('campaign parameters are pulled out of the query string', () => {
  const p = parseAdClickQuery(
    '?utm_source=facebook&utm_medium=cpc&utm_campaign=uk-sept&campaign_id=123&adset_id=456&ad_id=789&placement=Instagram_Reels',
  );
  assert.equal(p.utmSource, 'facebook');
  assert.equal(p.utmMedium, 'cpc');
  assert.equal(p.utmCampaign, 'uk-sept');
  assert.equal(p.metaCampaignId, '123');
  assert.equal(p.metaAdsetId, '456');
  assert.equal(p.metaAdId, '789');
  assert.equal(p.metaPlacement, 'Instagram_Reels');
});

test('an UNRESOLVED Meta macro is dropped, never stored as a literal', () => {
  // This is the whole reason the guard exists. A literal "{{campaign.id}}" in
  // the table would look like a real campaign id to every later query.
  const p = parseAdClickQuery('utm_source=facebook&campaign_id={{campaign.id}}&ad_id={{ad.id}}');
  assert.equal(p.metaCampaignId, null);
  assert.equal(p.metaAdId, null);
  // The genuine parameter beside it still survives.
  assert.equal(p.utmSource, 'facebook');
});

test('a rubbish query string does not throw', () => {
  for (const q of ['', '?', '%%%', '&&&&', 'a'.repeat(9000)]) {
    assert.doesNotThrow(() => parseAdClickQuery(q));
  }
});

test('the raw query is capped so one caller cannot write an essay', () => {
  const p = parseAdClickQuery(`utm_source=${'x'.repeat(10_000)}`);
  assert.ok(p.rawQuery.length <= 2048, `rawQuery was ${p.rawQuery.length} chars`);
  assert.ok((p.utmSource ?? '').length <= 128, 'utm_source was not capped');
});

test('platform is bucketed, and only ever to three values', () => {
  assert.equal(platformFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'ios');
  assert.equal(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'other');
  assert.equal(platformFromUserAgent(null), 'other');
  assert.equal(platformFromUserAgent(undefined), 'other');
});

test('only the marketing site may log a click', () => {
  assert.equal(isAllowedClickOrigin('https://delegentai.co.uk'), true);
  assert.equal(isAllowedClickOrigin('https://www.delegentai.co.uk'), true);
  // Deliberately tighter than the Worker's general CORS allowlist: the web app
  // does not serve adverts and has no business writing here.
  assert.equal(isAllowedClickOrigin('https://delegent-app.web.app'), false);
  assert.equal(isAllowedClickOrigin('https://delegentai.co.uk.evil.example'), false);
  assert.equal(isAllowedClickOrigin('http://delegentai.co.uk'), false, 'plain http must not be accepted');
  assert.equal(isAllowedClickOrigin(null), false);
  assert.equal(isAllowedClickOrigin(''), false);
});

test('destinations are a closed set', () => {
  assert.deepEqual([...AD_CLICK_DESTINATIONS], ['google_play', 'app_store', 'webapp', 'none']);
});

test('events are a closed set', () => {
  assert.deepEqual([...AD_CLICK_EVENTS], ['arrival', 'store_tap']);
});

// ---------------------------------------------------------------------------
// The handler. A fake Supabase captures exactly what would have been written.

function fakeEnv() {
  const writes = [];
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    writes.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 201 });
  };
  return { env, writes, restore: () => { globalThis.fetch = realFetch; } };
}

function clickRequest(query, { origin = 'https://delegentai.co.uk', ua = 'Mozilla/5.0 (Linux; Android 14)' } = {}) {
  return new Request('https://api.delegantai.co.uk/api/ad/click', {
    method: 'POST',
    headers: { origin, 'user-agent': ua, 'cf-ipcountry': 'GB', 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, e: 'arrival', d: 'google_play' }),
  });
}

test('a real advert click is recorded, and records NOTHING identifying', async () => {
  const { env, writes, restore } = fakeEnv();
  try {
    const res = await handleAdClick(
      clickRequest('utm_source=facebook&utm_campaign=uk-sept&campaign_id=123&placement=Facebook_Reels'),
      env,
    );
    assert.equal(res.status, 204);
    assert.equal(writes.length, 1, 'the click was not written');

    const row = writes[0].body;
    assert.equal(row.utm_source, 'facebook');
    assert.equal(row.meta_campaign_id, '123');
    assert.equal(row.meta_placement, 'Facebook_Reels');
    assert.equal(row.event, 'arrival');
    assert.equal(row.destination, 'google_play');
    assert.equal(row.platform, 'android');
    assert.equal(row.country, 'GB');

    // THE PRIVACY CLAIM. Nothing in the row may identify a person. Written as
    // a whole-row check rather than field-by-field so that a column added
    // later is caught by this test rather than by a regulator.
    const serialised = JSON.stringify(row).toLowerCase();
    for (const forbidden of ['ip', 'user_agent', 'useragent', 'mozilla', 'cookie', 'email', 'user_id', 'advertis']) {
      assert.ok(
        !Object.keys(row).some((k) => k.toLowerCase().includes(forbidden)),
        `the row has a column that looks like "${forbidden}": ${Object.keys(row).join(', ')}`,
      );
    }
    assert.ok(!serialised.includes('mozilla'), 'the user agent string leaked into the row');
  } finally {
    restore();
  }
});

test('a visit with no campaign parameters is NOT counted', async () => {
  // Somebody opening /install directly is real, but it is not advertising, and
  // counting it would understate every cost per click computed off this table.
  const { env, writes, restore } = fakeEnv();
  try {
    const res = await handleAdClick(clickRequest(''), env);
    assert.equal(res.status, 204);
    assert.equal(writes.length, 0, 'a non-advert visit was counted as an advert click');
  } finally {
    restore();
  }
});

test('a request from an unapproved origin writes nothing', async () => {
  const { env, writes, restore } = fakeEnv();
  try {
    const res = await handleAdClick(clickRequest('utm_source=facebook', { origin: 'https://evil.example' }), env);
    assert.equal(res.status, 204, 'must still answer 204, never leak that it refused');
    assert.equal(writes.length, 0);
  } finally {
    restore();
  }
});

test('a broken body answers 204 and writes nothing', async () => {
  const { env, writes, restore } = fakeEnv();
  try {
    const req = new Request('https://api.delegantai.co.uk/api/ad/click', {
      method: 'POST',
      headers: { origin: 'https://delegentai.co.uk' },
      body: 'not json at all',
    });
    const res = await handleAdClick(req, env);
    assert.equal(res.status, 204);
    assert.equal(writes.length, 0);
  } finally {
    restore();
  }
});

test('a Supabase outage still answers 204', async () => {
  // The caller is a sendBeacon fired microseconds before the page navigates to
  // a store. Nothing about measurement is worth failing that redirect for.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('supabase is down'); };
  try {
    const res = await handleAdClick(
      clickRequest('utm_source=facebook&campaign_id=1'),
      { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
    );
    assert.equal(res.status, 204);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unknown destination is normalised rather than stored', async () => {
  const { env, writes, restore } = fakeEnv();
  try {
    const req = new Request('https://api.delegantai.co.uk/api/ad/click', {
      method: 'POST',
      headers: { origin: 'https://delegentai.co.uk', 'user-agent': 'x' },
      body: JSON.stringify({ q: 'utm_source=facebook', d: 'https://evil.example/redirect' }),
    });
    await handleAdClick(req, env);
    assert.equal(writes[0].body.destination, 'none');
  } finally {
    restore();
  }
});


test('a desktop store tap is recorded as store_tap, not as another arrival', async () => {
  // One desktop visitor who lands and then taps a badge is ONE click and one
  // expression of intent, not two clicks. Conflating them would double every
  // desktop number in the funnel report.
  const { env, writes, restore } = fakeEnv();
  try {
    const req = new Request('https://api.delegantai.co.uk/api/ad/click', {
      method: 'POST',
      headers: { origin: 'https://delegentai.co.uk', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' },
      body: JSON.stringify({ q: 'utm_source=facebook&campaign_id=1', e: 'store_tap', d: 'google_play' }),
    });
    await handleAdClick(req, env);
    assert.equal(writes[0].body.event, 'store_tap');
    assert.equal(writes[0].body.platform, 'other');
  } finally {
    restore();
  }
});

test('an unknown event falls back to arrival rather than being stored', async () => {
  const { env, writes, restore } = fakeEnv();
  try {
    const req = new Request('https://api.delegantai.co.uk/api/ad/click', {
      method: 'POST',
      headers: { origin: 'https://delegentai.co.uk', 'user-agent': 'x' },
      body: JSON.stringify({ q: 'utm_source=facebook', e: 'DROP TABLE ad_clicks', d: 'none' }),
    });
    await handleAdClick(req, env);
    assert.equal(writes[0].body.event, 'arrival');
  } finally {
    restore();
  }
});
