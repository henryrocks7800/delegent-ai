import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatePurchase, createPurchaseIntentStore } from '../dist/purchaseIntents.js';

const USER = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-09-13T12:00:00Z');
const input = { userId: USER, provider: 'stripe', tierId: 'studio',
  successUrl: 'https://app.example.test/success', cancelUrl: 'https://app.example.test/cancel' };
function fixture() {
  let sequence = 0, pending = null, time = NOW;
  const intents = [], sessions = new Map(), calls = [], keys = new Map();
  const faults = { createBeforeSend: false, createLost: false, saveLost: false, expiryLost: false, completeOnExpire: false };
  const store = {
    async claim(userId, provider, tierId, request) {
      if (pending?.phase === 'awaiting_entitlement') return { kind: 'payment_pending' };
      if (pending?.lease_token) return { kind: 'busy' };
      if (pending?.provider === 'apple' && pending.provider !== provider) return { kind: 'purchase_pending' };
      const action = !pending ? 'create' : pending.provider !== provider || pending.tier_id !== tierId ? 'replace' : 'resume';
      if (!pending) {
        pending = { id: '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'), user_id: userId,
          provider, tier_id: tierId, phase: 'reserved', request: { ...request, hasPriorSubscription: false },
          prepared_params: null, provider_session_id: null, created_at: new Date(time).toISOString(),
          expires_at: new Date(time+3_600_000).toISOString(), lease_token: null };
        intents.push(pending);
      }
      pending.lease_token = 'lease-'+Math.random();
      return { kind: 'claimed', action, intent: structuredClone(pending) };
    },
    async update(intent, action, value) {
      const saved = intents.find(i => i.id === intent.id);
      if (!saved || saved.lease_token !== intent.lease_token) return false;
      if (action === 'prepare') {
        if (saved.prepared_params) assert.deepEqual(value, saved.prepared_params);
        saved.prepared_params = structuredClone(value); saved.phase = 'prepared';
      } else if (action === 'session') {
        saved.provider_session_id = value.id;
        saved.phase = value.status === 'complete' ? 'awaiting_entitlement' : value.status;
        if (value.status === 'expired') pending = null;
        if (faults.saveLost) { faults.saveLost = false; throw new Error('response lost after commit'); }
      } else if (action === 'expire_missing') { saved.phase = 'expired'; pending = null; }
      else if (action === 'authorize_apple') saved.phase = 'open';
      else if (action === 'release') saved.lease_token = null;
      return true;
    },
  };
  const stripe = {
    billing: {
      prices: { async list({ lookup_keys }) { return { data: [{ id: 'price_'+lookup_keys[0], active: true, lookup_key: lookup_keys[0] }] }; } },
      checkout: { sessions: { async create(params, options) {
        calls.push({ kind: 'create', params: structuredClone(params), key: options.idempotencyKey });
        if (faults.createBeforeSend) { faults.createBeforeSend = false; throw new Error('create interrupted before provider receipt'); }
        let id = keys.get(options.idempotencyKey);
        if (id) assert.deepEqual(params, calls.find(c => c.key === options.idempotencyKey).params);
        else {
          id = 'cs_fixture_'+(sessions.size+1); keys.set(options.idempotencyKey,id);
          sessions.set(id,{ id, status: 'open', url: 'https://checkout.stripe.com/c/pay/'+id,
            client_reference_id: params.client_reference_id, metadata: structuredClone(params.metadata), expires_at: params.expires_at });
        }
        if (faults.createLost) { faults.createLost = false; throw new Error('lost create response'); }
        return { id, url: sessions.get(id).url };
      } } },
      billingPortal: { sessions: { create() { throw new Error('unexpected portal'); } } },
    },
    async retrieve(id) { calls.push({ kind: 'retrieve', id }); return structuredClone(sessions.get(id)); },
    async list() { calls.push({ kind: 'list' }); return { data: [...sessions.values()].map(s => structuredClone(s)), has_more: false }; },
    async expire(id) {
      calls.push({ kind: 'expire', id });
      sessions.get(id).status = faults.completeOnExpire ? 'complete' : 'expired';
      if (faults.expiryLost) { faults.expiryLost = false; throw new Error('lost expire response'); }
      return structuredClone(sessions.get(id));
    },
  };
  return { store, stripe, calls, faults, intents, sessions, setTime: v => { time = v; },
    run: (override = {}) => coordinatePurchase({ ...input, ...override },store,stripe,() => time) };
}

test('same-account concurrent requests and next-minute retries reuse one live session', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 16 },() => f.run()));
  assert.equal(results.filter(r => r.kind === 'checkout').length,1);
  assert.equal(results.filter(r => r.kind === 'busy').length,15);
  f.setTime(NOW+120_000);
  const retry = await f.run({ successUrl: 'https://other.example.test/success' });
  assert.equal(retry.sessionId, results.find(r => r.kind === 'checkout').sessionId);
  assert.equal(f.calls.filter(c => c.kind === 'create').length,1);
  assert.equal(f.intents[0].prepared_params.success_url,input.successUrl,'frozen redirect survives a changed caller');
});

test('lost Stripe and database responses recover the existing session without another trial', async () => {
  for (const fault of ['createLost','saveLost']) {
    const f = fixture(); f.faults[fault] = true;
    await assert.rejects(() => f.run());
    f.setTime(NOW+120_000);
    assert.equal((await f.run()).kind,'checkout');
    assert.equal(f.sessions.size,1);
    assert.equal(f.calls.filter(c => c.kind === 'create').length,1);
    assert.equal(f.intents[0].prepared_params.subscription_data.trial_period_days,3);
  }
});

test('changing tier or provider confirms expiration before authorizing replacement', async () => {
  for (const replacement of [{ tierId: 'pro-office' }, { provider: 'apple' }]) {
    const f = fixture(); const first = await f.run();
    f.faults.expiryLost = true;
    const next = await f.run(replacement);
    assert.equal(f.sessions.get(first.sessionId).status,'expired');
    assert.equal(next.kind, replacement.provider === 'apple' ? 'apple' : 'checkout');
    assert.equal(f.intents.length,2);
    const expiredAt = f.calls.findIndex(c => c.kind === 'expire');
    const creates = f.calls.flatMap((c,i) => c.kind === 'create' ? [i] : []);
    if (creates.length === 2) assert.ok(creates[1]>expiredAt);
  }
});

test('a completed payment racing expiration prevents another checkout or Apple sheet', async () => {
  const f = fixture(); await f.run(); f.faults.completeOnExpire = true;
  assert.equal((await f.run({ provider: 'apple' })).kind,'payment_pending');
  assert.equal(f.intents.length,1);
  assert.equal(f.sessions.size,1);
  assert.equal((await f.run({ tierId: 'pro-office' })).kind,'payment_pending');
});

test('unknown creation is not retried beyond Stripe expiry or granted another hour', async () => {
  const f = fixture(); f.faults.createLost = true; await assert.rejects(() => f.run());
  f.sessions.clear(); // An authoritative empty provider listing in the fixture.
  f.setTime(NOW+40*60_000);
  assert.equal((await f.run()).kind,'purchase_pending');
  assert.equal(f.intents.length,1);
  f.setTime(NOW+25*3_600_000);
  assert.equal((await f.run()).kind,'checkout');
  assert.equal(f.intents.length,2);
  assert.notEqual(f.calls.filter(c => c.kind === 'create')[0].key,f.calls.filter(c => c.kind === 'create').at(-1).key);
});

test('ambiguous recovery and mismatched known session identity never authorize another charge', async () => {
  const f = fixture(); const first = await f.run();
  f.sessions.get(first.sessionId).metadata.sidekickUserId = 'another-user';
  await assert.rejects(() => f.run(), /identity_mismatch/);
  assert.equal(f.calls.filter(c => c.kind === 'create').length,1);
  const g = fixture(); g.faults.createLost = true; await assert.rejects(() => g.run());
  g.sessions.set('cs_duplicate',{ ...structuredClone([...g.sessions.values()][0]), id: 'cs_duplicate' });
  await assert.rejects(() => g.run(), /ambiguous/);
  assert.equal(g.calls.filter(c => c.kind === 'create').length,1);
});

test('the RPC adapter rejects empty, foreign-owner and malformed claims or writes', async () => {
  const f = fixture();
  const valid = await f.store.claim(USER,'stripe','studio',{});
  valid.intent.lease_token='00000000-0000-4000-8000-000000000999';
  for (const data of [null, {}, { ...valid, intent: { ...valid.intent, user_id: 'foreign' } },
    { ...valid, intent: { ...valid.intent, expires_at: 'bad' } }]) {
    const store = createPurchaseIntentStore(async () => ({ data }));
    await assert.rejects(() => store.claim(USER,'stripe','studio',{}), /claim_invalid/);
  }
  for (const data of [null, [], 'true']) {
    const store = createPurchaseIntentStore(async () => ({ data }));
    await assert.rejects(() => store.update(valid.intent,'release'), /update_failed/);
  }
});

test('an interrupted create retries frozen parameters and the same key despite a price change', async () => {
  const f = fixture(); f.faults.createBeforeSend = true;
  await assert.rejects(() => f.run());
  f.stripe.billing.prices.list = () => { throw new Error('must not resolve another price for a prepared intent'); };
  f.setTime(NOW+120_000);
  assert.equal((await f.run()).kind,'checkout');
  const creates = f.calls.filter(c => c.kind === 'create');
  assert.equal(creates.length,2);
  assert.equal(creates[0].key,creates[1].key);
  assert.deepEqual(creates[0].params,creates[1].params);
});

test('a lost prepare lease prevents the Stripe create call', async () => {
  const f = fixture();
  const update = f.store.update;
  f.store.update = (intent,action,value) => action === 'prepare' ? Promise.resolve(false) : update(intent,action,value);
  await assert.rejects(() => f.run(), /lease_changed/);
  assert.equal(f.calls.filter(c => c.kind === 'create').length,0);
});

test('recovery completes pagination and refuses to act after a later-page failure', async () => {
  for (const broken of [false,true]) {
    const f = fixture(); f.faults.createLost=true; await assert.rejects(() => f.run());
    const existing = [...f.sessions.values()][0];
    let pages = 0;
    f.stripe.list = async ({ starting_after }) => {
      pages++;
      if (!starting_after) return { data: [existing], has_more: true };
      if (broken) throw new Error('provider second-page failure');
      return { data: [{ ...existing, id: 'cs_unrelated', metadata: {} }], has_more: false };
    };
    if (broken) await assert.rejects(() => f.run(), /second-page failure/);
    else assert.equal((await f.run()).sessionId,existing.id);
    assert.equal(pages,2);
    assert.equal(f.calls.filter(c => c.kind === 'create').length,1);
  }
});
