// Install attribution parsing.
//
// The failure mode this guards is specific and expensive: a referrer that fails
// to decrypt, or parses to nothing, looks EXACTLY like an organic install. Get
// that wrong and you conclude your advertising produced nothing when it in fact
// produced everything, or the reverse. So the tests care less about the happy
// path than about making sure failures are visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { parsePlainReferrer, decryptMetaReferrer, parseReferrer, parsePlainMetaIds } from '../dist/installAttribution.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('an organic Play install is parsed, and is not mistaken for a campaign', async () => {
  const parsed = await parseReferrer('utm_source=google-play&utm_medium=organic', {});
  assert.equal(parsed.utmSource, 'google-play');
  assert.equal(parsed.utmMedium, 'organic');
  assert.equal(parsed.metaCampaignId, null);
  // Crucially: not an error. Organic is a real answer, not a failure.
  assert.equal(parsed.decryptError, null);
});

test('a referrer with no utm_content is not treated as a failed decrypt', async () => {
  const { payload, error } = await decryptMetaReferrer('utm_source=some-partner', 'aa'.repeat(32));
  assert.equal(payload, null);
  assert.equal(error, null, 'absence of Meta data is not an error; only a real decrypt failure is');
});

test('garbage in utm_content is ignored rather than crashing the capture', async () => {
  const { payload, error } = await decryptMetaReferrer('utm_content=not-json-at-all', 'aa'.repeat(32));
  assert.equal(payload, null);
  assert.equal(error, null);
});

test('a Meta payload with NO key configured is recorded as such, never as organic', async () => {
  const content = encodeURIComponent(JSON.stringify({ source: { data: 'ab12', nonce: 'cd34' } }));
  const parsed = await parseReferrer(`utm_content=${content}`, {});
  assert.equal(parsed.metaCampaignId, null);
  assert.equal(
    parsed.decryptError,
    'no_decryption_key_configured',
    'a missing key must be visible on the row: silently looking organic is how you conclude ads did nothing',
  );
});

test('a real AES-256-GCM Meta payload decrypts to the campaign ids', async () => {
  // Build a genuine encrypted payload the way Meta does, so this exercises the
  // actual crypto rather than a mock: 32-byte key, 12-byte nonce, and the GCM
  // tag appended to the ciphertext (which is the detail people get wrong).
  const keyBytes = new Uint8Array(32).map((_, i) => i);
  const nonceBytes = new Uint8Array(12).map((_, i) => 200 - i);
  const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const body = JSON.stringify({
    campaign_id: 120210000000000000,
    adgroup_id: '120210000000000001',
    ad_id: '120210000000000002',
    account_id: 'act_999',
    campaign_name: 'Delegent launch',
  });
  const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBytes, tagLength: 128 },
    key,
    new TextEncoder().encode(body),
  ));

  const content = encodeURIComponent(JSON.stringify({ source: { data: toHex(cipher), nonce: toHex(nonceBytes) } }));
  const parsed = await parseReferrer(`utm_source=fb4a&utm_content=${content}`, {
    SIDEKICK_META_INSTALL_REFERRER_KEY: toHex(keyBytes),
  });

  assert.equal(parsed.decryptError, null);
  // Numeric ids must survive as strings: Meta's campaign ids exceed what a JS
  // number holds exactly, so any path that keeps them numeric corrupts them.
  assert.equal(parsed.metaCampaignId, '120210000000000000');
  assert.equal(parsed.metaAdgroupId, '120210000000000001');
  assert.equal(parsed.metaAdId, '120210000000000002');
  assert.equal(parsed.metaAccountId, 'act_999');
  assert.equal(parsed.utmSource, 'fb4a');
});

test('a WRONG key is reported as a decrypt failure, not as organic', async () => {
  const keyBytes = new Uint8Array(32).map((_, i) => i);
  const wrongKey = new Uint8Array(32).fill(7);
  const nonceBytes = new Uint8Array(12).fill(3);
  const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBytes, tagLength: 128 },
    key,
    new TextEncoder().encode('{"campaign_id":"1"}'),
  ));
  const content = encodeURIComponent(JSON.stringify({ source: { data: toHex(cipher), nonce: toHex(nonceBytes) } }));

  const parsed = await parseReferrer(`utm_content=${content}`, {
    SIDEKICK_META_INSTALL_REFERRER_KEY: toHex(wrongKey),
  });
  assert.equal(parsed.metaCampaignId, null);
  assert.match(parsed.decryptError ?? '', /decrypt_failed/);
});

test('Meta data at the top level, not nested under source, is still read', () => {
  // Meta documents the pair under `source`; it has also been seen at the top
  // level. Accepting both means a shape change costs us nothing.
  const nested = parsePlainReferrer('utm_source=a&utm_medium=b&utm_campaign=c');
  assert.equal(nested.utmCampaign, 'c');
});

test('an empty or absurd referrer yields nulls rather than throwing', async () => {
  const parsed = await parseReferrer('', {});
  assert.equal(parsed.utmSource, null);
  assert.equal(parsed.decryptError, null);
});


// ---------------------------------------------------------------------------
// Plain campaign ids, added 2026-09-03.
//
// There are two shapes of referrer and they must land in the same columns.
// An advert pointing straight at the Play Store gets Meta's own referrer, with
// the ids AES-GCM encrypted inside utm_content. An advert pointing at our own
// /install page has no Meta referrer at all, so install.html builds one and
// writes the ids in plainly. If only one shape parsed, the table would answer
// a different question depending on how a campaign happened to be set up.

test('plain campaign ids from our own /install referrer are read', async () => {
  const parsed = await parseReferrer(
    'utm_source=facebook&utm_medium=cpc&utm_campaign=uk-sept&campaign_id=120&adset_id=340&ad_id=560&placement=Instagram_Reels',
    {},
  );
  assert.equal(parsed.utmSource, 'facebook');
  assert.equal(parsed.metaCampaignId, '120');
  assert.equal(parsed.metaAdgroupId, '340');
  assert.equal(parsed.metaAdId, '560');
  assert.equal(parsed.metaPlacement, 'Instagram_Reels');
  // No encrypted payload was present, so this is not a decryption failure.
  assert.equal(parsed.decryptError, null);
});

test('adgroup_id is accepted as a spelling of adset_id', () => {
  // Meta's UI says ad set; its encrypted payload says adgroup. The column is
  // named for the payload, so both spellings must reach it.
  assert.equal(parsePlainMetaIds('adset_id=1').metaAdgroupId, '1');
  assert.equal(parsePlainMetaIds('adgroup_id=2').metaAdgroupId, '2');
});

test('an UNRESOLVED macro in a referrer is dropped, not stored', async () => {
  // install.html already refuses to build one of these, but a referrer can
  // also be typed by hand into an advert. A literal "{{campaign.id}}" would
  // look like a real id to every later query.
  const parsed = await parseReferrer('utm_source=facebook&campaign_id={{campaign.id}}', {});
  assert.equal(parsed.metaCampaignId, null);
  assert.equal(parsed.utmSource, 'facebook');
});

test('the ENCRYPTED payload wins over a plain parameter', async () => {
  // Meta's own payload cannot have been edited by anything in the click path;
  // a plain query parameter can. Where both exist, trust Meta's.
  const keyBytes = new Uint8Array(32).fill(9);
  const nonceBytes = new Uint8Array(12).fill(4);
  const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBytes, tagLength: 128 },
    key,
    new TextEncoder().encode('{"campaign_id":"REAL"}'),
  ));
  const content = encodeURIComponent(JSON.stringify({ source: { data: toHex(cipher), nonce: toHex(nonceBytes) } }));

  const parsed = await parseReferrer(`campaign_id=SPOOFED&utm_content=${content}`, {
    SIDEKICK_META_INSTALL_REFERRER_KEY: toHex(keyBytes),
  });
  assert.equal(parsed.metaCampaignId, 'REAL');
});

test('an organic install still records no placement', async () => {
  const parsed = await parseReferrer('utm_source=google-play&utm_medium=organic', {});
  assert.equal(parsed.metaPlacement, null);
});
