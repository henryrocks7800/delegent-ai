// Which account's workspace the phone is showing, executed against the hook.
//
// `useMobileProductState.refresh` wrote its result unconditionally after its
// await. Manual refresh and the transient provisioning poll both go through it,
// so two loads for two different accounts could be in flight at once and the
// slower one won. Account B finished, then account A finished, and the
// signed-in account stayed B while the rendered profile became A. Everything
// downstream reads that snapshot, including the mounted chat host.
//
// The mount effect had a `cancelled` flag. Nothing else did. That is how the
// two paths drifted, so there is one path now and the fence is on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

function compile(source, dependencies = {}) {
  const code = ts.transpileModule(source, { fileName: 'fixture.ts', compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === '@sidekick/shared') return shared;
    assert.ok(Object.hasOwn(dependencies, name), 'unmocked dependency ' + name);
    return dependencies[name];
  }, exports);
  return exports;
}

/** The real hook, with React scheduling and the Supabase client supplied here. */
function hook({ rows }) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const pendingEffects = [];
  const reads = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0]; },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!effects[index] || !same(effects[index].deps, deps)) {
        const previous = effects[index];
        effects[index] = { deps, fn };
        pendingEffects.push(() => { previous?.cleanup?.(); effects[index].cleanup = fn(); });
      }
    },
  };

  const client = {
    from(table) {
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        async maybeSingle() {
          reads.push(table);
          const userId = client.currentUserId;
          return rows[userId] ? rows[userId]() : { data: null, error: new Error('no row') };
        },
      };
      return query;
    },
    currentUserId: null,
  };

  const module = compile(read('apps/mobile/src/state/productState.ts'), {
    react,
    '../auth/supabaseClient': {
      mobileSupabase: client,
      async getFreshMobileSupabaseSession() { return null; },
    },
  });

  let authState = { status: 'signed_out' };
  let result = null;
  const render = () => {
    cursor = 0;
    result = module.useMobileProductState(authState);
    pendingEffects.splice(0).forEach(run => run());
    return result;
  };
  return {
    render, reads, client,
    signIn(id) { authState = { status: 'authenticated', user: { id, email: `${id}@example.test` } }; },
    get state() { return result; },
    async settle() { await flush(); await flush(); return render(); },
  };
}

const stateRow = (userId, extra = {}) => ({
  data: {
    user_id: userId,
    email: `${userId}@example.test`,
    full_name: userId,
    subscription_status: 'active',
    subscription_tier_id: 'studio',
    ...extra,
  },
  error: null,
});

test('a slower load for a retired account cannot publish over the account that is signed in', async () => {
  const slow = deferred();
  const rows = {
    account_a: () => slow.promise,
    account_b: () => stateRow('account_b'),
  };
  const h = hook({ rows });

  h.signIn('account_a');
  h.client.currentUserId = 'account_a';
  h.render();
  await flush();

  // The reader switches account while A is still in the air.
  h.signIn('account_b');
  h.client.currentUserId = 'account_b';
  h.render();
  await h.settle();
  assert.equal(h.state.snapshot.profile?.id, 'account_b');

  // Now A answers. It is a valid reply, for an account that is no longer here.
  slow.resolve(stateRow('account_a'));
  const after = await h.settle();
  assert.equal(after.snapshot.profile?.id, 'account_b',
    'the signed-in account must not be shown another account workspace');
});

test('a superseded refresh hands its caller the winner answer, not the retired account', async () => {
  const slow = deferred();
  const rows = {
    account_a: () => slow.promise,
    account_b: () => stateRow('account_b'),
  };
  const h = hook({ rows });
  h.signIn('account_a');
  h.client.currentUserId = 'account_a';
  h.render();
  await flush();

  // Callers use the RETURNED snapshot to drive things like checkout polling, so
  // handing back a retired account's data is the same defect one step removed.
  const stale = h.state.refresh();
  h.signIn('account_b');
  h.client.currentUserId = 'account_b';
  h.render();
  await h.settle();

  slow.resolve(stateRow('account_a'));
  const returned = await stale;
  assert.notEqual(returned.profile?.id, 'account_a');
});

test('an ordinary refresh for the same account still publishes', async () => {
  let label = 'first';
  const h = hook({ rows: { account_a: () => stateRow('account_a', { full_name: label }) } });
  h.signIn('account_a');
  h.client.currentUserId = 'account_a';
  h.render();
  let view = await h.settle();
  assert.equal(view.status, 'live');
  assert.equal(view.snapshot.profile?.fullName, 'first');

  label = 'second';
  await view.refresh();
  view = await h.settle();
  assert.equal(view.snapshot.profile?.fullName, 'second', 'the fence must not block the ordinary case');
});

test('a failure for the current account keeps that account own snapshot rather than a blank one', async () => {
  let fail = false;
  const h = hook({ rows: { account_a: () => (fail ? { data: null, error: new Error('503') } : stateRow('account_a')) } });
  h.signIn('account_a');
  h.client.currentUserId = 'account_a';
  h.render();
  let view = await h.settle();
  assert.equal(view.status, 'live');

  fail = true;
  await view.refresh();
  view = await h.settle();
  assert.equal(view.status, 'error');
  assert.equal(view.snapshot.profile?.id, 'account_a',
    'a transient failure must not replace a good snapshot with an unsubscribed one');
});

test('the snapshot read touches the entitlement view and nothing else', async () => {
  const h = hook({ rows: { account_a: () => stateRow('account_a') } });
  h.signIn('account_a');
  h.client.currentUserId = 'account_a';
  h.render();
  await h.settle();
  // It used to read artifacts, task_runs and messages too, on every refresh
  // including the five-second provisioning poll, and a 503 on any of them
  // rejected the whole snapshot.
  assert.deepEqual([...new Set(h.reads)], ['my_product_state']);
});
