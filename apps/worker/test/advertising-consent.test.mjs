// Does the advertising answer actually govern what reaches Meta.
//
// It did not. The answer lived only in AsyncStorage on the handset, and the
// Worker's Conversions API call, which sends Meta a user-level click identifier
// tied to the account, ran for everybody with a click id in their install
// referrer. Reproduced against the live handlers on 2026-09-13: a request
// carrying advertisingConsent=false still sent the signup event, because
// nothing read it.
//
// The second half is which referrer the event is built from. The insert ignores
// duplicates, so a reinstall through a different advert used to report a
// conversion against a click that never won.
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasAdvertisingConsent, recordInstallAttribution, retainedInstallAttribution } from '../dist/installAttribution.js';

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
};
const USER = '77777777-7777-4777-8777-777777777777';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init: init ?? {} });
    const answered = await handler({ url, init: init ?? {} });
    if (answered) return answered;
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const META_REFERRER = 'utm_source=facebook&utm_campaign=launch&fbclid=CLICK_ID_FROM_META';

test('an unanswered advertising question behaves exactly like a no', async () => {
  for (const value of [null, undefined, false]) {
    const consent = await withFetch(
      () => json([{ advertising_consent: value }]),
      () => hasAdvertisingConsent(ENV, USER),
    );
    assert.equal(consent, false, String(value));
  }
  assert.equal(await withFetch(() => json([{ advertising_consent: true }]), () => hasAdvertisingConsent(ENV, USER)), true);
});

test('a consent lookup we could not do is a no, not a yes', async () => {
  assert.equal(await withFetch(() => new Response('no', { status: 503 }), () => hasAdvertisingConsent(ENV, USER)), false);
  assert.equal(await withFetch(() => { throw new Error('offline'); }, () => hasAdvertisingConsent(ENV, USER)), false);
  assert.equal(await hasAdvertisingConsent({}, USER), false, 'and so is a Worker with no service-role key');
});

test('without consent no referral data is parsed or sent to storage', async () => {
  for (const options of [{}, { advertisingConsent: false }]) {
    await withFetch(() => { throw new Error('no storage calls permitted'); }, async (calls) => {
      assert.equal(await recordInstallAttribution(ENV, USER, META_REFERRER, null, null, options), true);
      assert.equal(calls.length, 0);
    });
  }
});

test('consented write passes only parsed fields to the atomic database function', async () => {
  let inserted;
  const raw = META_REFERRER + '&gclid=HIDDEN&unknown=secret&utm_content=%7B%22data%22%3A%22encrypted%22%7D';
  await withFetch((call) => {
    assert.equal(new URL(call.url).pathname, '/rest/v1/rpc/record_consented_install_attribution');
    inserted = JSON.parse(call.init.body);
    return json(true);
  }, async () => assert.equal(await recordInstallAttribution(ENV, USER, raw, null, null, { advertisingConsent: true }), true));
  assert.equal(inserted.p_user_id, USER);
  assert.equal(inserted.p_attribution.fbclid, 'CLICK_ID_FROM_META');
  assert.equal(inserted.p_attribution.utm_campaign, 'launch');
  assert.equal('raw_referrer' in inserted.p_attribution, false);
  assert.doesNotMatch(JSON.stringify(inserted), /HIDDEN|unknown|encrypted/);
});

test('withdrawal racing the preliminary consent lookup rejects the late capture', async () => {
  assert.equal(await withFetch(() => json(false), () => recordInstallAttribution(
    ENV, USER, META_REFERRER, null, null, { advertisingConsent: true })), false);
  assert.equal(await withFetch(() => new Response('unavailable', { status: 503 }), () => recordInstallAttribution(
    ENV, USER, META_REFERRER, null, null, { advertisingConsent: true })), false);
});

test('the retained attribution is what a conversion is reported against, not the referrer just submitted', async () => {
  // A reinstall through a different advert submits a new referrer, the insert
  // ignores it, and the row that already existed is the truth.
  const retained = await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/rest/v1/install_attribution') {
      assert.match(url.searchParams.get('select') ?? '', /fbclid/);
      assert.equal(url.searchParams.get('user_id'), `eq.${USER}`);
      return json([{ fbclid: 'FIRST_CLICK', referrer_click_at: '2026-09-01T10:00:00Z' }]);
    }
    return null;
  }, () => retainedInstallAttribution(ENV, USER));
  assert.deepEqual(retained, { fbclid: 'FIRST_CLICK', referrerClickAt: '2026-09-01T10:00:00Z' });
});

test('a retained row with no click identifier has nothing to report', async () => {
  const retained = await withFetch(() => json([{ fbclid: null, referrer_click_at: null }]),
    () => retainedInstallAttribution(ENV, USER));
  assert.deepEqual(retained, { fbclid: null, referrerClickAt: null });
  assert.equal(await withFetch(() => json([]), () => retainedInstallAttribution(ENV, USER)), null);
  assert.equal(await withFetch(() => new Response('no', { status: 500 }), () => retainedInstallAttribution(ENV, USER)), null);
});
