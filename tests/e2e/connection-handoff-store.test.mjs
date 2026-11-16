// The durable record behind a connection hand-off, executed rather than read.
//
// Everything here runs the real module. The only substitution is the key/value
// store underneath it, which stands in for AsyncStorage on the phone and
// sessionStorage in the browser, because those are the two things this file
// exists to survive: the app being evicted while the reader is at the provider,
// and the tab being replaced by a full-page navigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
function compile(source) {
  const code = ts.transpileModule(source, { fileName: 'fixture.ts', compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    assert.equal(name, '@sidekick/shared', 'unmocked dependency ' + name); return shared;
  }, exports);
  return exports;
}

const {
  CONNECTION_HANDOFF_LIFETIME_MS, createConnectionHandoffStore, newConnectionAttemptId,
  parsePendingConnectionHandoff, sessionConnectionHandoffStorage,
} = compile(read('apps/mobile/src/connections/connectionHandoffStore.ts'));

/** Resolves after `ticks` microtasks, so two callers genuinely interleave. */
const memoryStorage = ({ ticks = 0, failing = false } = {}) => {
  const state = new Map();
  const slow = async () => { for (let i = 0; i < ticks; i++) await Promise.resolve(); };
  return { state,
    async getItem(key) { await slow(); if (failing) throw new Error('store unavailable'); return state.has(key) ? state.get(key) : null; },
    async setItem(key, value) { await slow(); if (failing) throw new Error('store unavailable'); state.set(key, String(value)); },
    async removeItem(key) { await slow(); if (failing) throw new Error('store unavailable'); state.delete(key); } };
};

const attempt = (over = {}) => ({ attemptId: 'a1', serviceId: 'gmail', backend: 'composio',
  state: null, connectedAccountId: 'ca_one', ...over });
const only = disk => JSON.parse([...disk.state.values()][0]);

test('an attempt survives a write and comes back exactly as it went in', async () => {
  const disk = memoryStorage();
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  await store.start(attempt());
  const record = await store.read();
  assert.equal(record.attemptId, 'a1');
  assert.equal(record.serviceId, 'gmail');
  assert.equal(record.backend, 'composio');
  assert.equal(record.connectedAccountId, 'ca_one');
  assert.equal(record.state, null);
  assert.equal(record.completionSent, false);
  assert.equal(record.receipt, null);
  assert.equal(typeof record.startedAt, 'number');
});

test('nothing a caller hangs off an attempt reaches the store', async () => {
  const disk = memoryStorage();
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  // A JS caller can pass whatever it likes. The record is rebuilt from a
  // whitelist precisely so a credential cannot arrive by accident.
  await store.start({ ...attempt(), code: 'authorization_code_value', accessToken: 'token_value' });
  const written = [...disk.state.values()].join('');
  assert.doesNotMatch(written, /authorization_code_value|token_value/);
  assert.deepEqual(Object.keys(only(disk)).sort(),
    ['attemptId', 'backend', 'completionSent', 'connectedAccountId', 'receipt', 'serviceId', 'startedAt', 'state'].sort());
});

test('the key is the account, so two accounts on one device cannot see each other', async () => {
  const disk = memoryStorage();
  const a = createConnectionHandoffStore(disk, { userId: 'account_A' });
  const b = createConnectionHandoffStore(disk, { userId: 'account_B' });
  await a.start(attempt());
  assert.equal(await b.read(), null);
  await b.start(attempt({ attemptId: 'b1', serviceId: 'freeagent', backend: 'native', state: 'b_state', connectedAccountId: null }));
  assert.equal((await a.read()).attemptId, 'a1');
  assert.equal((await b.read()).attemptId, 'b1');
  // And clearing one leaves the other alone.
  await b.clear();
  assert.equal((await a.read()).attemptId, 'a1');
  assert.equal(await b.read(), null);
});

test('an amendment only lands on the attempt it names', async () => {
  const disk = memoryStorage();
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  await store.start(attempt());
  await store.markCompletionSent('a_different_attempt');
  await store.recordReceipt('a_different_attempt', { outcome: 'confirmed' });
  let record = await store.read();
  assert.equal(record.completionSent, false);
  assert.equal(record.receipt, null);

  await store.markCompletionSent('a1');
  await store.recordReceipt('a1', { outcome: 'failed', code: 'invalid_state' });
  record = await store.read();
  assert.equal(record.completionSent, true);
  assert.deepEqual(record.receipt, { outcome: 'failed', code: 'invalid_state' });

  // A stale clear cannot retire the attempt that replaced it.
  await store.clear('a_different_attempt');
  assert.equal((await store.read()).attemptId, 'a1');
  await store.clear('a1');
  assert.equal(await store.read(), null);
});

test('writes are serialised, so a receipt cannot resurrect a record a clear retired', async () => {
  // Every operation takes several microtasks, which is what makes an
  // unserialised read-then-write interleave and lose.
  const disk = memoryStorage({ ticks: 3 });
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  await store.start(attempt());
  const receipt = store.recordReceipt('a1', { outcome: 'confirmed' });
  const cleared = store.clear('a1');
  await Promise.all([receipt, cleared]);
  assert.equal(disk.state.size, 0);
  assert.equal(await store.read(), null);
});

test('a start that lands during an amendment is not partly overwritten by it', async () => {
  const disk = memoryStorage({ ticks: 3 });
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  await store.start(attempt());
  const stale = store.markCompletionSent('a1');
  const fresh = store.start(attempt({ attemptId: 'a2', connectedAccountId: 'ca_two' }));
  await Promise.all([stale, fresh]);
  const record = await store.read();
  assert.equal(record.attemptId, 'a2');
  assert.equal(record.connectedAccountId, 'ca_two');
  assert.equal(record.completionSent, false);
});

test('an attempt past its lifetime is dropped rather than answered for', async () => {
  const disk = memoryStorage();
  let clock = 1_000_000;
  const store = createConnectionHandoffStore(disk, { userId: 'account_A', now: () => clock });
  await store.start(attempt());
  clock += CONNECTION_HANDOFF_LIFETIME_MS;
  assert.ok(await store.read(), 'still inside its lifetime');
  clock += 1;
  assert.equal(await store.read(), null);
  assert.equal(disk.state.size, 0, 'and it is not left behind on disk');
});

test('a record the store cannot vouch for is discarded, not half believed', async () => {
  const key = 'delegent.connections.handoff.v1.account_A';
  const base = { attemptId: 'a1', serviceId: 'gmail', backend: 'composio', state: null,
    connectedAccountId: 'ca_one', startedAt: Date.now(), completionSent: false, receipt: null };
  const rejected = {
    'not JSON at all': 'definitely not json',
    'a bare string': '"a1"',
    'an array': '[]',
    'a service this build does not offer': JSON.stringify({ ...base, serviceId: 'not_a_service' }),
    'the wrong broker for the service': JSON.stringify({ ...base, backend: 'native' }),
    'no attempt id': JSON.stringify({ ...base, attemptId: '' }),
    'a startedAt that is not a number': JSON.stringify({ ...base, startedAt: 'yesterday' }),
    'an infinite startedAt': JSON.stringify({ ...base, startedAt: Infinity }),
    'completionSent as a string': JSON.stringify({ ...base, completionSent: 'true' }),
    'a receipt outcome we do not issue': JSON.stringify({ ...base, receipt: { outcome: 'probably' } }),
    'a state that is not a string': JSON.stringify({ ...base, state: 7 }),
  };
  for (const [why, raw] of Object.entries(rejected)) {
    assert.equal(parsePendingConnectionHandoff(raw), null, why);
    const disk = memoryStorage();
    disk.state.set(key, raw);
    const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
    assert.equal(await store.read(), null, why);
    assert.equal(disk.state.size, 0, 'a record we refuse is also removed: ' + why);
  }
  // Oversized is refused without being parsed at all.
  assert.equal(parsePendingConnectionHandoff('{"a":"' + 'x'.repeat(5000) + '"}'), null);
  assert.equal(parsePendingConnectionHandoff(null), null);
  assert.equal(parsePendingConnectionHandoff(''), null);
  // And what a good record loses: anything outside the whitelist.
  const parsed = parsePendingConnectionHandoff(JSON.stringify({ ...base, code: 'authorization_code_value' }));
  assert.ok(parsed);
  assert.equal(parsed.code, undefined);
});

test('a start naming a service the wrong broker owns is refused, and clears what was there', async () => {
  const disk = memoryStorage();
  const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
  await store.start(attempt());
  await store.start(attempt({ attemptId: 'a2', serviceId: 'gmail', backend: 'native' }));
  assert.equal(await store.read(), null);
  assert.equal(disk.state.size, 0);
});

test('a store that cannot be read or written degrades to remembering nothing', async () => {
  for (const disk of [memoryStorage({ failing: true }), null, undefined, {}]) {
    const store = createConnectionHandoffStore(disk, { userId: 'account_A' });
    await store.start(attempt());
    await store.markCompletionSent('a1');
    await store.recordReceipt('a1', { outcome: 'confirmed' });
    assert.equal(await store.read(), null);
    await store.clear();
  }
});

test('a store with no account id remembers nothing and touches no key', async () => {
  const disk = memoryStorage();
  const store = createConnectionHandoffStore(disk, { userId: '' });
  await store.start(attempt());
  assert.equal(await store.read(), null);
  assert.equal(disk.state.size, 0);
});

test('attempt ids do not repeat', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newConnectionAttemptId()));
  assert.equal(ids.size, 500);
});

test('the browser store is absent rather than broken when the surface has no sessionStorage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  try {
    delete globalThis.sessionStorage;
    assert.equal(sessionConnectionHandoffStorage(), null);
    globalThis.sessionStorage = { getItem() {} };
    assert.equal(sessionConnectionHandoffStorage(), null, 'a partial implementation is not usable');
    const complete = { getItem() {}, setItem() {}, removeItem() {} };
    globalThis.sessionStorage = complete;
    assert.equal(sessionConnectionHandoffStorage(), complete);
  } finally {
    delete globalThis.sessionStorage;
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
  }
});
