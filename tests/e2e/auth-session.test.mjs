// Sign-in, sign-out and session persistence, executed rather than read.
//
// Everything below runs the product's real modules. The Supabase auth client is
// the installed SDK, the SecureStore wrapper is the installed Expo one with its
// native I/O supplied locally, and the only substitutions are the network and
// the two device stores. The three defects these cover were all invisible to a
// source-text assertion, and one of them was actively hidden by a comment that
// said the opposite of what the SDK does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as shared from '@sidekick/shared';

const require_ = createRequire(import.meta.url);
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

function compile(source, dependencies = {}, globals = {}, fileName = 'fixture.ts') {
  const code = ts.transpileModule(source, { fileName, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(globals), code)(name => {
    if (name === '@sidekick/shared') return shared;
    assert.ok(Object.hasOwn(dependencies, name), 'unmocked dependency ' + name);
    return dependencies[name];
  }, exports, ...Object.values(globals));
  return exports;
}

const STORAGE_KEY = 'sb-fixtureproject-auth-token';

// --- the device stores -------------------------------------------------------

/** Android caps a SecureStore item at 2KB and the native layer throws above it. */
const nativeSecureStore = ({ limitBytes = 2048 } = {}) => {
  const items = new Map();
  let refuseWrite = null;
  let refuseDelete = false;
  return {
    items,
    refuseWritesWhen(predicate) { refuseWrite = predicate; },
    refuseDeletes(value) { refuseDelete = value; },
    module: {
      async setValueWithKeyAsync(value, key) {
        if (refuseWrite?.(key, value)) throw new Error('keystore unavailable');
        if (Buffer.byteLength(String(value), 'utf8') > limitBytes) throw new Error('Value exceeds the 2048 byte limit');
        items.set(key, String(value));
      },
      async getValueWithKeyAsync(key) { return items.has(key) ? items.get(key) : null; },
      async deleteValueWithKeyAsync(key) {
        if (refuseDelete) throw new Error('keystore unavailable');
        items.delete(key);
      },
    },
  };
};

const asyncStorage = () => {
  const map = new Map();
  const store = {
    map,
    refuseWrites: false,
    async getItem(key) { return map.has(key) ? map.get(key) : null; },
    async setItem(key, value) {
      if (store.refuseWrites) throw new Error('AsyncStorage unavailable');
      map.set(key, String(value));
    },
    async removeItem(key) { map.delete(key); },
  };
  return store;
};

/**
 * The INSTALLED expo-secure-store wrapper, not a stand-in for it. Its key
 * validation is the whole point: it rejects anything outside /^[\w.-]+$/, and
 * the adapter's old chunk keys contained '::'.
 */
function installedSecureStore(native) {
  const source = readFileSync(require_.resolve('expo-secure-store/build/SecureStore.js'), 'utf8');
  // The wrapper is an ES module compiled with interop, so it reaches for
  // `.default`. Both shapes point at the same fake native store.
  const native_ = { ...native.module, default: native.module };
  return compile(source, { './ExpoSecureStore': native_ }, {}, 'SecureStore.js');
}

function loadStorage({ platform = 'android', native = nativeSecureStore(), async: asyncStore = asyncStorage() } = {}) {
  const secureStore = installedSecureStore(native);
  const module = compile(read('apps/mobile/src/auth/secureSessionStorage.ts'), {
    'react-native': { Platform: { OS: platform } },
    // Interop again: the adapter uses a default import.
    '@react-native-async-storage/async-storage': { ...asyncStore, default: asyncStore },
    'expo-secure-store': secureStore,
  });
  return { ...module, native, async: asyncStore, secureStore };
}

// --- PASS6-2: the chunk keys the library actually accepts ---------------------

test('the old chunk key format is rejected by the installed library, which is why chunked sessions went to plaintext', async () => {
  const native = nativeSecureStore();
  const SecureStore = installedSecureStore(native);
  await assert.rejects(() => SecureStore.setItemAsync(STORAGE_KEY + '::0', 'chunk'), /Invalid key/);
  // And the format now in use is accepted.
  await SecureStore.setItemAsync(STORAGE_KEY + '.dgca.0', 'chunk');
  assert.equal(await SecureStore.getItemAsync(STORAGE_KEY + '.dgca.0'), 'chunk');
});

test('a session too large for one item is stored in SecureStore, not silently in plaintext', async () => {
  const { secureSessionStorage: storage, native, async: plain } = loadStorage();
  const session = JSON.stringify({ refresh_token: 'r'.repeat(2000), access_token: 'a'.repeat(2000) });
  assert.ok(session.length > 1500, 'the fixture has to be big enough to chunk');
  await storage.setItem(STORAGE_KEY, session);

  assert.equal(await storage.getItem(STORAGE_KEY), session, 'and it has to read back whole');
  assert.equal(plain.map.has(STORAGE_KEY), false, 'a refresh token must not be sitting in AsyncStorage');
  assert.ok(native.items.size >= 3, 'head plus chunks');
  for (const key of native.items.keys()) {
    assert.match(key, /^[\w.-]+$/, 'every key must be one the library accepts: ' + key);
  }
  assert.equal(plain.map.get(STORAGE_KEY + '.__delegent_store__'), 'secure');
});

test('an oversized single item still chunks rather than failing the write', async () => {
  // Belt and braces on the 2KB native cap: the chunk size has to stay under it.
  const { secureSessionStorage: storage, native } = loadStorage();
  await storage.setItem(STORAGE_KEY, 'x'.repeat(6000));
  assert.equal(await storage.getItem(STORAGE_KEY), 'x'.repeat(6000));
  for (const value of native.items.values()) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 2048, 'no item may exceed what the platform accepts');
  }
});

// --- PASS6-3: one store answers for a key ------------------------------------

test('a failed secure write does not leave the previous session readable', async () => {
  const { secureSessionStorage: storage, native } = loadStorage();
  await storage.setItem(STORAGE_KEY, 'session-one');
  assert.equal(await storage.getItem(STORAGE_KEY), 'session-one');

  native.refuseWritesWhen(() => true);
  await storage.setItem(STORAGE_KEY, 'session-two');
  // This is the defect in one line: it used to answer 'session-one'.
  assert.equal(await storage.getItem(STORAGE_KEY), 'session-two');
});

test('the pointer decides even when the losing copy cannot be deleted', async () => {
  const { secureSessionStorage: storage, native } = loadStorage();
  await storage.setItem(STORAGE_KEY, 'session-one');
  native.refuseWritesWhen(() => true);
  native.refuseDeletes(true);
  await storage.setItem(STORAGE_KEY, 'session-two');
  assert.equal(native.items.get(STORAGE_KEY), 'session-one', 'the stale copy is physically still there');
  assert.equal(await storage.getItem(STORAGE_KEY), 'session-two', 'and it is no longer what answers');
});

test('a session that shrinks below the chunk size leaves no readable chunks behind', async () => {
  const { secureSessionStorage: storage, native } = loadStorage();
  await storage.setItem(STORAGE_KEY, 'y'.repeat(4000));
  await storage.setItem(STORAGE_KEY, 'small-session');
  assert.equal(await storage.getItem(STORAGE_KEY), 'small-session');
  assert.deepEqual([...native.items.keys()], [STORAGE_KEY], 'the old chunks are swept');
});

test('a replacement that fails part way leaves the committed session whole', async () => {
  const { secureSessionStorage: storage, native, async: plain } = loadStorage();
  const committed = 'a'.repeat(4000);
  await storage.setItem(STORAGE_KEY, committed);

  // The second chunk of the OTHER generation fails, and so does the plaintext
  // fallback, so nothing anywhere is committed by this attempt.
  native.refuseWritesWhen(key => key.endsWith('.dgcb.1'));
  plain.refuseWrites = true;
  await assert.rejects(() => storage.setItem(STORAGE_KEY, 'b'.repeat(4000)));

  native.refuseWritesWhen(null);
  plain.refuseWrites = false;
  assert.equal(await storage.getItem(STORAGE_KEY), committed,
    'a half-written replacement must never become the readable value');
});

test('a head left by the old chunk format reads through to the session that actually exists', async () => {
  const { secureSessionStorage: storage, native, async: plain } = loadStorage();
  native.items.set(STORAGE_KEY, '__sidekick_chunked__:3');
  plain.map.set(STORAGE_KEY, 'the-session-that-was-really-stored');
  assert.equal(await storage.getItem(STORAGE_KEY), 'the-session-that-was-really-stored');
});

test('a key SecureStore would refuse never reaches it', async () => {
  const { secureSessionStorage: storage, native, async: plain } = loadStorage();
  await storage.setItem('sb::odd::key', 'value');
  assert.equal(await storage.getItem('sb::odd::key'), 'value');
  assert.equal(native.items.size, 0, 'nothing may be handed to a store that will throw on it');
  assert.equal(plain.map.get('sb::odd::key'), 'value');
});

test('the web and test platforms keep using AsyncStorage', async () => {
  const { secureSessionStorage: storage, native, async: plain } = loadStorage({ platform: 'web' });
  await storage.setItem(STORAGE_KEY, 'web-session');
  assert.equal(await storage.getItem(STORAGE_KEY), 'web-session');
  assert.equal(native.items.size, 0);
  assert.equal(plain.map.get(STORAGE_KEY), 'web-session');
});

// --- PASS6-1: sign-out has to hold without the server ------------------------

test('clearing persisted auth removes both stores, including a key only ever read', async () => {
  const native = nativeSecureStore();
  const plain = asyncStorage();
  const first = loadStorage({ native, async: plain });
  await first.secureSessionStorage.setItem(STORAGE_KEY, 'z'.repeat(4000));
  assert.ok(native.items.size >= 3);

  // A fresh process: this module instance has never written anything, it has
  // only been asked to read, which is exactly the cold-start-then-sign-out case.
  const relaunched = loadStorage({ native, async: plain });
  assert.equal(await relaunched.secureSessionStorage.getItem(STORAGE_KEY), 'z'.repeat(4000));
  const cleared = await relaunched.clearPersistedAuthStorage();
  assert.deepEqual(cleared, [STORAGE_KEY]);
  assert.equal(native.items.size, 0, 'nothing may survive in the keystore');
  assert.equal(plain.map.size, 0, 'and nothing in plaintext, including the pointer');
  assert.equal(await relaunched.secureSessionStorage.getItem(STORAGE_KEY), null);
});

test('a refresh that resolves after a sign-out cannot write the session back', async () => {
  const { secureSessionStorage: storage, fenceAuthStorageWrites, releaseAuthStorageWrites } = loadStorage();
  fenceAuthStorageWrites();
  await storage.setItem(STORAGE_KEY, 'session-from-a-late-refresh');
  assert.equal(await storage.getItem(STORAGE_KEY), null);

  // An actual sign-in attempt releases it. A missed release cannot lock anyone
  // out, because the fence also has a deadline.
  releaseAuthStorageWrites();
  await storage.setItem(STORAGE_KEY, 'the-new-session');
  assert.equal(await storage.getItem(STORAGE_KEY), 'the-new-session');
});

test('the sign-out fence expires on its own so a missed release cannot block sign-in', async () => {
  const { secureSessionStorage: storage, fenceAuthStorageWrites } = loadStorage();
  fenceAuthStorageWrites(1);
  await new Promise(resolve => setTimeout(resolve, 8));
  await storage.setItem(STORAGE_KEY, 'session-after-the-deadline');
  assert.equal(await storage.getItem(STORAGE_KEY), 'session-after-the-deadline');
});

/**
 * The whole defect, end to end, against the real auth client.
 *
 * The old sequence called signOut() then signOut({scope:'local'}) and assumed
 * the second one only touched storage. It does not: both scopes call the server
 * first and return early on anything that is not a 401, 403 or 404.
 */
function supabaseFixture(storage, { signOutStatus = 200 } = {}) {
  const requests = [];
  const client = createClient('https://fixtureproject.supabase.co', 'anon-key-fixture', {
    auth: {
      storage, storageKey: STORAGE_KEY, autoRefreshToken: false,
      persistSession: true, detectSessionInUrl: false,
    },
    global: {
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, method: init?.method ?? 'GET' });
        if (path.endsWith('/logout')) {
          return signOutStatus === 200
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ message: 'service unavailable' }), {
              status: signOutStatus, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  return { client, requests };
}

/** The real supabaseClient module, with only the platform boundaries supplied. */
function loadSignOut(loaded) {
  return compile(read('apps/mobile/src/auth/supabaseClient.ts'), {
    'react-native-url-polyfill/auto': {},
    '@supabase/supabase-js': { createClient },
    './publicSupabase': { mobileSupabaseConfig: { ready: false, config: { url: '', anonKey: '' } } },
    './secureSessionStorage': loaded,
  }).signOutMobileSessionDurably;
}

const fixtureSession = () => ({
  access_token: 'fixture.access.token',
  refresh_token: 'fixture-refresh-token',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: { id: 'user-fixture', aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() },
});

test('the SDK really does leave the session behind when the server refuses a sign-out', async () => {
  // Not our code. This is the behaviour the old comment denied, proven against
  // the installed client so the fix below is anchored to something real.
  const { secureSessionStorage: storage } = loadStorage({ platform: 'web' });
  const { client } = supabaseFixture(storage, { signOutStatus: 503 });
  await storage.setItem(STORAGE_KEY, JSON.stringify({ ...fixtureSession(), expires_at: Math.floor(Date.now() / 1000) + 3600 }));

  const global = await client.auth.signOut();
  assert.ok(global.error, 'a 503 comes back as an error rather than throwing');
  const local = await client.auth.signOut({ scope: 'local' });
  assert.ok(local.error, 'and scope:local calls the server too');
  assert.notEqual(await storage.getItem(STORAGE_KEY), null, 'the session is still persisted');
});

test('a durable sign-out ends the session on this device even when the server is down', async () => {
  const native = nativeSecureStore();
  const plain = asyncStorage();
  const loaded = loadStorage({ native, async: plain });
  const { client, requests } = supabaseFixture(loaded.secureSessionStorage, { signOutStatus: 503 });
  await loaded.secureSessionStorage.setItem(STORAGE_KEY, JSON.stringify(fixtureSession()));

  const signOut = loadSignOut(loaded);

  const result = await signOut(client);
  assert.equal(result.remoteRevoked, false, 'and it says so rather than assuming');
  assert.ok(requests.some(r => r.path.endsWith('/logout')), 'the revoke was still attempted');

  // The actual question: does a fresh client find the account again?
  const { client: relaunched } = supabaseFixture(loaded.secureSessionStorage);
  const { data } = await relaunched.auth.getSession();
  assert.equal(data.session, null, 'a relaunch must not restore the account that just signed out');
  assert.equal(native.items.size, 0);
  assert.equal(plain.map.size, 0);
});

test('a durable sign-out reports a successful revocation as one', async () => {
  const loaded = loadStorage();
  const { client } = supabaseFixture(loaded.secureSessionStorage);
  await loaded.secureSessionStorage.setItem(STORAGE_KEY, JSON.stringify(fixtureSession()));
  const signOut = loadSignOut(loaded);
  const result = await signOut(client);
  assert.equal(result.remoteRevoked, true);
  assert.equal(await loaded.secureSessionStorage.getItem(STORAGE_KEY), null);
});

test('the browser sign-out also survives a server that refuses it', async () => {
  const localStore = new Map();
  // The browser's own store, handed BOTH to the SDK and to globalThis, because
  // that is the arrangement in production: the SDK persists to localStorage and
  // the sign-out below removes from localStorage. Node has no window, so
  // supabase-js would otherwise quietly persist to memory and the test would
  // prove nothing.
  const localStorageLike = {
    getItem: key => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => { localStore.set(key, String(value)); },
    removeItem: key => { localStore.delete(key); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = localStorageLike;
  try {
    const WEB_KEY = 'delegent.web.auth';
    const requests = [];
    const client = createClient('https://fixtureproject.supabase.co', 'anon-key-fixture', {
      auth: { storage: localStorageLike, storageKey: WEB_KEY, autoRefreshToken: false,
        persistSession: true, detectSessionInUrl: false, flowType: 'pkce' },
      global: {
        fetch: async (url) => {
          requests.push(new URL(String(url)).pathname);
          return new URL(String(url)).pathname.endsWith('/logout')
            ? new Response(JSON.stringify({ message: 'down' }), { status: 503, headers: { 'content-type': 'application/json' } })
            : new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    localStore.set(WEB_KEY, JSON.stringify(fixtureSession()));
    localStore.set(`${WEB_KEY}-code-verifier`, 'a-half-finished-sign-in');

    const { signOut } = compile(read('apps/webapp/src/features/auth/useAuth.ts'), {
      react: { useEffect() {}, useState: initial => [initial, () => {}] },
      '../../lib/supabase': { supabase: client, WEB_AUTH_STORAGE_KEY: WEB_KEY },
    }, {}, 'fixture.tsx');

    await signOut();
    assert.ok(requests.some(path => path.endsWith('/logout')), 'the revoke is still attempted');
    assert.equal(localStore.get(WEB_KEY), undefined, 'nobody may walk away from a shared machine still signed in');
    assert.equal(localStore.get(`${WEB_KEY}-code-verifier`), undefined, 'the PKCE half goes too');
    const { data } = await client.auth.getSession();
    assert.equal(data.session, null);
  } finally {
    delete globalThis.localStorage;
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
  }
});

// --- PASS6-4: backing out of the Google sheet must not sign you in -----------

function googleFixture({ signInResult, cachedTokens = { idToken: 'cached.id.token' } } = {}) {
  const calls = { signIn: 0, getTokens: 0, exchange: 0 };
  const module = compile(read('apps/mobile/src/auth/googleSignIn.ts'), {
    '@react-native-google-signin/google-signin': {
      statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
      GoogleSignin: {
        configure() {},
        async hasPlayServices() { return true; },
        async signIn() {
          calls.signIn++;
          if (signInResult instanceof Error) throw signInResult;
          return signInResult;
        },
        async getTokens() { calls.getTokens++; return cachedTokens; },
        async signOut() {},
      },
    },
    './publicSupabase': { mobileAuthConfig: { ready: true, googleWebClientId: 'web-client', googleIosClientId: '' } },
    './supabaseClient': {
      mobileSupabase: {
        auth: {
          async signInWithIdToken() {
            calls.exchange++;
            return { data: { session: { access_token: 'a', refresh_token: 'r', expires_at: 1,
              user: { id: 'user-fixture', app_metadata: { provider: 'google' }, user_metadata: {} } } }, error: null };
          },
        },
      },
      mapSupabaseSessionToPublicSession: session => (session ? { provider: 'google', user: { id: session.user.id } } : null),
      rememberMobileSupabaseSession() {},
    },
    '../observability/sentry': { reportAuthFailure() {} },
  });
  return { ...module, calls };
}

test('backing out of the Google sheet does not sign the person in with a cached token', async () => {
  // v16 resolves a cancelled sheet instead of throwing. The old code saw no id
  // token on that value and reached for getTokens(), which returns whatever the
  // SDK still holds from a previous Google session, and that exchanges fine.
  const google = googleFixture({ signInResult: { type: 'cancelled', data: null } });
  const result = await google.startGoogleSignIn();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'oauth_cancelled');
  assert.equal(google.calls.getTokens, 0, 'a cached credential must not be touched after a cancellation');
  assert.equal(google.calls.exchange, 0, 'and nothing may be exchanged with Supabase');
});

test('a successful Google sheet still signs in, including through the token fallback', async () => {
  const direct = googleFixture({ signInResult: { type: 'success', data: { idToken: 'fresh.id.token' } } });
  const first = await direct.startGoogleSignIn();
  assert.equal(first.ok, true);
  assert.equal(direct.calls.getTokens, 0, 'no fallback is needed when the response carries the token');

  // Some versions return the token only from getTokens(). That path survives.
  const viaTokens = googleFixture({ signInResult: { type: 'success', data: {} } });
  const second = await viaTokens.startGoogleSignIn();
  assert.equal(second.ok, true);
  assert.equal(viaTokens.calls.getTokens, 1);
  assert.equal(viaTokens.calls.exchange, 1);
});

test('an older SDK shape with no discriminator keeps working', async () => {
  const legacy = googleFixture({ signInResult: { idToken: 'legacy.id.token' } });
  const result = await legacy.startGoogleSignIn();
  assert.equal(result.ok, true);
  assert.equal(legacy.calls.exchange, 1);
});

test('an outcome that is neither success nor cancellation is a failure, not a cached sign-in', async () => {
  const odd = googleFixture({ signInResult: { type: 'noSavedCredentialFound', data: null } });
  const result = await odd.startGoogleSignIn();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'oauth_failed');
  assert.equal(odd.calls.getTokens, 0);
  assert.equal(odd.calls.exchange, 0);
});

test('a thrown cancellation is still reported as a cancellation', async () => {
  const thrown = Object.assign(new Error('cancelled'), { code: 'SIGN_IN_CANCELLED' });
  const google = googleFixture({ signInResult: thrown });
  const result = await google.startGoogleSignIn();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'oauth_cancelled');
  assert.equal(google.calls.exchange, 0);
});
