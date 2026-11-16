import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import ts from 'typescript';

// React Native installs this polyfill, which lacks Node's AbortSignal.timeout.
const nativeAbort = createRequire(import.meta.url)('abort-controller/dist/abort-controller');
const code = ts.transpileModule(readFileSync(new URL('./onboardingGoal.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Call = { url: string; init: RequestInit };
function client(options: { ready?: boolean; token?: string | null; fetch?: (call: Call) => Promise<Response> } = {}) {
  const calls: Call[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports,
    AbortSignal: nativeAbort.AbortSignal, AbortController: nativeAbort.AbortController,
    setTimeout(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 10_000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
    async fetch(url: string, init: RequestInit) {
      const call = { url, init }; calls.push(call);
      return options.fetch ? options.fetch(call) : new Response(null, { status: 204 });
    },
    require(name: string) {
      if (name === '../auth/supabaseClient') return { getFreshMobileAccessToken: async () => options.token === undefined ? 'fixture-token' : options.token };
      if (name === '../auth/publicSupabase') return { mobileSupabaseConfig: {
        ready: options.ready !== false, config: { url: 'https://example.test', anonKey: 'fixture-public-key' },
      } };
      if (name === './growthContent') return { isOnboardingGoal: (value: unknown) => ['receipts', 'inbox', 'admin', 'something_else'].includes(String(value)) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  vm.runInContext(code, context, { filename: 'onboardingGoal.ts' });
  return { api: module.exports as { goalRpc(name: string, body: Record<string, unknown>, current: () => boolean): Promise<unknown>; saveOnboardingGoal(goal: string): Promise<void>; loadOnboardingGoal(): Promise<string | null> }, calls, timers,
    expire() { for (const callback of [...timers.values()]) callback(); } };
}

test('a native onboarding choice reaches the authenticated RPC and releases its timer', async () => {
  assert.equal(typeof nativeAbort.AbortSignal.timeout, 'undefined');
  const c = client();
  await c.api.saveOnboardingGoal('receipts');
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].url, 'https://example.test/rest/v1/rpc/set_my_onboarding_goal');
  assert.equal(c.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(c.calls[0].init.body)), { p_goal: 'receipts' });
  assert.equal((c.calls[0].init.headers as Record<string, string>).authorization, 'Bearer fixture-token');
  assert.equal(c.calls[0].init.signal?.aborted, false);
  assert.equal(c.timers.size, 0);
  c.expire();
  assert.equal(c.calls[0].init.signal?.aborted, false);
});

test('a returning user can load the saved goal with the native polyfill', async () => {
  const c = client({ fetch: async () => new Response('"inbox"') });
  assert.equal(await c.api.loadOnboardingGoal(), 'inbox');
  assert.equal(c.calls[0].url, 'https://example.test/rest/v1/rpc/get_my_onboarding_goal');
  assert.equal(c.timers.size, 0);
});

test('a stalled native goal request aborts after ten seconds and releases its timer', async () => {
  const c = client({ fetch: ({ init }) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
  }) });
  const result = assert.rejects(c.api.saveOnboardingGoal('receipts'), /request aborted/);
  await setImmediate();
  assert.equal(c.calls.length, 1);
  assert.equal(c.timers.size, 1);
  c.expire();
  await result;
  assert.equal(c.calls[0].init.signal?.aborted, true);
  assert.equal(c.timers.size, 0);
});

test('server failure stays retryable and clears the native timer', async () => {
  const c = client({ fetch: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(c.api.saveOnboardingGoal('receipts'), /save your choice/);
  assert.equal(c.timers.size, 0);
  assert.equal(await c.api.loadOnboardingGoal(), null);
  assert.equal(c.timers.size, 0);
});

test('an unsigned-in goal choice makes no request and creates no timer', async () => {
  for (const options of [{ token: null }, { ready: false }]) {
    const c = client(options);
    await assert.rejects(c.api.saveOnboardingGoal('receipts'), /Sign in to continue/);
    assert.equal(c.calls.length, 0);
    assert.equal(c.timers.size, 0);
  }
});

test('an abandoned account cannot send app preferences after token refresh', async () => {
  const c = client();
  await assert.rejects(c.api.goalRpc('set_my_onboarding_apps', { p_service_ids: ['gmail'] }, () => false), /Sign in/);
  assert.equal(c.calls.length, 0);
  assert.equal(c.timers.size, 0);
});

test('multiple app choices use the native-safe RPC and preserve their array', async () => {
  const c = client();
  await c.api.goalRpc('set_my_onboarding_apps', { p_service_ids: ['gmail', 'dropbox'] }, () => true);
  assert.deepEqual(JSON.parse(String(c.calls[0].init.body)), { p_service_ids: ['gmail', 'dropbox'] });
  assert.equal(c.timers.size, 0);
});
