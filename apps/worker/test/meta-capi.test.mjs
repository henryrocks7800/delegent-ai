// Meta Conversions API.
//
// The two things that must never happen: sending anything that identifies a
// person, and sending anything at all while the flag is off. The happy path
// matters less than those two, so the tests pin the exact payload shape and
// the no-op conditions.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFbclid,
  buildFbc,
  buildMetaEventPayload,
  metaCapiEnabled,
  sendMetaEvent,
  maybeSendMetaSignupEvent,
  maybeSendMetaPurchaseEvent,
  extractCheckoutUserId,
  hashForEventId,
} from '../dist/metaCapi.js';

const ON = { SIDEKICK_META_CAPI_ENABLED: 'true', SIDEKICK_META_PIXEL_ID: '1081310147586858', SIDEKICK_META_CAPI_ACCESS_TOKEN: 'tok' };
const FBCLID = 'IwAR2abcDEF_ghi-JKL0123456789';

function fetchSpy(status = 200, body = {}) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
  return { calls, impl };
}

test('fbclid is read from a Play referrer and from a query string, and rubbish is rejected', () => {
  assert.equal(extractFbclid(`utm_source=facebook&campaign_id=1&fbclid=${FBCLID}`), FBCLID);
  assert.equal(extractFbclid(`fbclid=${FBCLID}&utm_medium=paid_social`), FBCLID);
  assert.equal(extractFbclid('utm_source=google-play&utm_medium=organic'), null);
  assert.equal(extractFbclid('fbclid={{fbclid}}'), null, 'an unresolved macro is not a click id');
  assert.equal(extractFbclid('fbclid=short'), null);
  assert.equal(extractFbclid(`fbclid=${'x'.repeat(600)}`), null);
  assert.equal(extractFbclid('fbclid=has%20space%20in%20it'), null);
});

test('fbc is fb.1.<click ms>.<fbclid>, and a missing click time falls back to now', () => {
  assert.equal(buildFbc(FBCLID, 1757000000000), `fb.1.1757000000000.${FBCLID}`);
  const now = Date.now();
  const v = buildFbc(FBCLID, NaN);
  const ms = Number(v.split('.')[2]);
  assert.ok(ms >= now && ms <= now + 5000);
});

test('the payload carries the click id and nothing that identifies a person', () => {
  const body = buildMetaEventPayload({ eventName: 'Purchase', eventId: 'purchase:cs_1', fbclid: FBCLID, clickAtMs: 1757000000000, value: 2.99, currency: 'gbp', eventTimeSec: 1757000100 });
  const ev = body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'purchase:cs_1');
  assert.equal(ev.event_time, 1757000100);
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_source_url, 'https://delegentai.co.uk/install');
  assert.deepEqual(ev.user_data, { fbc: `fb.1.1757000000000.${FBCLID}` });
  assert.deepEqual(ev.custom_data, { value: 2.99, currency: 'GBP' });
  for (const banned of ['em', 'ph', 'external_id', 'client_ip_address', 'client_user_agent', 'fbp', 'fn', 'ln']) {
    assert.equal(banned in ev.user_data, false, `${banned} must never be sent`);
  }
  assert.equal('test_event_code' in body, false);
  const signup = buildMetaEventPayload({ eventName: 'CompleteRegistration', eventId: 'signup:x', fbclid: FBCLID, clickAtMs: 1 }, 'TEST123');
  assert.equal('custom_data' in signup.data[0], false);
  assert.equal(signup.test_event_code, 'TEST123');
});

test('off by default: no flag, no pixel or no token means nothing is sent', async () => {
  const { calls, impl } = fetchSpy();
  for (const env of [{}, { ...ON, SIDEKICK_META_CAPI_ENABLED: 'false' }, { ...ON, SIDEKICK_META_PIXEL_ID: '' }, { ...ON, SIDEKICK_META_CAPI_ACCESS_TOKEN: undefined }]) {
    assert.equal(metaCapiEnabled(env), false);
    const r = await sendMetaEvent(env, { eventName: 'CompleteRegistration', eventId: 'e', fbclid: FBCLID, clickAtMs: 1 }, impl);
    assert.deepEqual(r, { sent: false, status: null, reason: 'disabled' });
  }
  assert.equal(calls.length, 0);
});

test('sending posts to the dataset endpoint with the token in the body and survives failure', async () => {
  const ok = fetchSpy(200, { events_received: 1 });
  const r = await sendMetaEvent(ON, { eventName: 'CompleteRegistration', eventId: 'e', fbclid: FBCLID, clickAtMs: 1 }, ok.impl);
  assert.deepEqual(r, { sent: true, status: 200, reason: null });
  assert.equal(ok.calls[0].url, 'https://graph.facebook.com/v21.0/1081310147586858/events');
  const sent = JSON.parse(ok.calls[0].init.body);
  assert.equal(sent.access_token, 'tok');
  assert.equal(sent.data[0].user_data.fbc, `fb.1.1.${FBCLID}`);

  const bad = fetchSpy(400, { error: { message: 'Invalid parameter' } });
  const r2 = await sendMetaEvent(ON, { eventName: 'CompleteRegistration', eventId: 'e', fbclid: FBCLID, clickAtMs: 1 }, bad.impl);
  assert.equal(r2.sent, false);
  assert.equal(r2.status, 400);

  const r3 = await sendMetaEvent(ON, { eventName: 'CompleteRegistration', eventId: 'e', fbclid: FBCLID, clickAtMs: 1 }, async () => { throw new Error('network down'); });
  assert.deepEqual(r3, { sent: false, status: null, reason: 'network down' });
});

test('queued signup reads current consent and retained click, never its cached referrer', async () => {
  const env = { ...ON, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' };
  const input = { userId: 'u-1', rawReferrer: 'fbclid=STALE_CLICK', clickAtMs: 1 };
  for (const status of [200, 503]) {
    const { calls, impl } = fetchSpy(status, []);
    assert.equal((await maybeSendMetaSignupEvent(env, input, impl)).sent, false);
    assert.equal(calls.length, 1, 'lookup only, no external send after withdrawal or failed lookup');
  }
  const calls = [];
  const result = await maybeSendMetaSignupEvent(env, input, async (url, init) => {
    calls.push({ url, init });
    return String(url).includes('/rpc/')
      ? Response.json([{ fbclid: FBCLID, captured_at: '2026-09-08T10:00:00Z' }])
      : Response.json({ events_received: 1 });
  });
  assert.equal(result.sent, true);
  const ev = JSON.parse(calls[1].init.body).data[0];
  assert.equal(ev.event_name, 'CompleteRegistration');
  assert.equal(ev.event_id, `signup:${hashForEventId('u-1')}`);
  assert.ok(ev.user_data.fbc.endsWith(FBCLID));
  assert.doesNotMatch(JSON.stringify(ev), /STALE_CLICK|u-1/);
});

test('purchase: only on checkout.session.completed, only with a stored click id, amount from amount_total', async () => {
  const session = { id: 'cs_test_1', amount_total: 299, payment_status: 'paid', currency: 'gbp', metadata: { sidekickUserId: 'u-2' } };
  assert.equal(extractCheckoutUserId(session), 'u-2');
  assert.equal(extractCheckoutUserId({ client_reference_id: 'u-3' }), 'u-3');
  assert.equal(extractCheckoutUserId(null), null);

  const env = { ...ON, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' };
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/rest/v1/rpc/get_consented_install_attribution')) {
      return new Response(JSON.stringify([{ fbclid: FBCLID, referrer_click_at: '2026-09-08T10:00:00.000Z', captured_at: '2026-09-08T10:05:00.000Z' }]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const wrongEvent = await maybeSendMetaPurchaseEvent(env, { responseOk: true, eventType: 'invoice.paid', session }, impl);
  assert.equal(wrongEvent.reason, 'not_trial_invoice');
  const failedHook = await maybeSendMetaPurchaseEvent(env, { responseOk: false, eventType: 'checkout.session.completed', session }, impl);
  assert.equal(failedHook.reason, 'webhook_not_ok');
  assert.equal(calls.length, 0);

  const r = await maybeSendMetaPurchaseEvent(env, { responseOk: true, eventType: 'checkout.session.completed', session }, impl);
  assert.equal(r.sent, true);
  const lookup = calls[0];
  assert.ok(String(lookup.url).endsWith('/rpc/get_consented_install_attribution'));
  assert.deepEqual(JSON.parse(lookup.init.body), { p_user_id: 'u-2' });
  const ev = JSON.parse(calls[1].init.body).data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'purchase:cs_test_1');
  assert.deepEqual(ev.custom_data, { value: 2.99, currency: 'GBP' });
  assert.equal(ev.user_data.fbc, `fb.1.${Date.parse('2026-09-08T10:00:00.000Z')}.${FBCLID}`);
  assert.ok(!JSON.stringify(ev).includes('u-2'));

  // An organic customer: the lookup finds no click id and nothing is sent.
  const organicImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify([{ fbclid: null }]), { status: 200 }); };
  const before = calls.length;
  const org = await maybeSendMetaPurchaseEvent(env, { responseOk: true, eventType: 'checkout.session.completed', session }, organicImpl);
  assert.equal(org.reason, 'no_fbclid');
  assert.equal(calls.length, before + 1, 'one lookup, no send');
});

test('free trials are not purchases; positive paid trial invoices report actual revenue with a stable invoice ID', async () => {
  const env = { ...ON, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' };
  const events = [];
  let lookups = 0;
  const impl = async (url, init) => {
    if (String(url).includes('/rest/v1/rpc/get_consented_install_attribution')) {
      lookups += 1;
      return Response.json([{ fbclid: FBCLID, captured_at: '2026-09-10T10:00:00Z' }]);
    }
    events.push(JSON.parse(init.body).data[0]);
    return Response.json({ events_received: 1 });
  };
  const metadata = { sidekickUserId: 'trial-user', introductoryOfferId: 'three_day_trial_2026_09' };
  for (const record of [
    { amount_total: 0, payment_status: 'no_payment_required' },
    { amount_total: 999, payment_status: 'unpaid' },
    { amount_total: NaN, payment_status: 'paid' },
  ]) {
    const outcome = await maybeSendMetaPurchaseEvent(env, {
      responseOk: true, eventType: 'checkout.session.completed', session: { id: 'cs_trial', metadata, ...record },
    }, impl);
    assert.equal(outcome.sent, false);
  }
  // Current Stripe invoices have status: 'paid' and no legacy paid boolean.
  const invoice = { id: 'in_trial_first_paid', amount_paid: 999, status: 'paid', currency: 'gbp', parent: { subscription_details: { metadata } } };
  assert.equal((await maybeSendMetaPurchaseEvent(env, {
    responseOk: true, eventType: 'invoice.paid', session: { ...invoice, amount_paid: 0 },
  }, impl)).sent, false);
  assert.equal((await maybeSendMetaPurchaseEvent(env, {
    responseOk: true, eventType: 'invoice.paid', session: { ...invoice, status: 'open', paid: true },
  }, impl)).sent, false);
  assert.equal(lookups, 0, 'no attribution lookup for an unpaid event');
  for (const eventType of ['invoice.paid', 'invoice.payment_succeeded']) {
    assert.equal((await maybeSendMetaPurchaseEvent(env, { responseOk: true, eventType, session: invoice }, impl)).sent, true);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].event_id, 'purchase:in_trial_first_paid');
  assert.equal(events[1].event_id, events[0].event_id, 'Meta can deduplicate the two Stripe event types');
  assert.deepEqual(events[0].custom_data, { value: 9.99, currency: 'GBP' });
});
