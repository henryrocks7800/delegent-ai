/**
 * Storage adapter for Supabase Auth that prefers expo-secure-store on
 * iOS/Android (Keychain on iOS, Keystore on Android) and falls back to
 * AsyncStorage on web and on the rare environments where SecureStore is
 * unavailable.
 *
 * Why:
 *   The default Supabase recipe persists the session JWT to plain
 *   AsyncStorage. On a rooted Android device, the refresh token there is
 *   recoverable. Moving to SecureStore puts the secret behind hardware-backed
 *   crypto on devices that support it.
 *
 * ⚠️ THE KEY FORMAT IS LOAD-BEARING. `expo-secure-store` validates every key
 * against /^[\w.-]+$/ and throws otherwise. The chunk keys here used to contain
 * `::`, so EVERY session over 1,500 characters threw on write, fell through to
 * the plaintext AsyncStorage fallback, and reported success. That is not a rare
 * keystore outage: it happened deterministically to any session large enough to
 * chunk, which is what a populated `user_metadata` produces. Nothing in the app
 * said so, because the fallback was silent by design.
 *
 * Limits:
 *   SecureStore items are capped at 2KB on Android, and a Supabase session is
 *   typically ~1.5KB but grows with metadata. Values over the chunk size are
 *   split across several items and committed by a manifest written under the
 *   original key. The chunk format is internal to this module.
 *
 * ONE STORE ANSWERS FOR A KEY AT A TIME. There used to be two. A failed secure
 * write stored the new session in AsyncStorage while an older session stayed
 * readable in SecureStore, and the read preferred SecureStore, so a successful
 * write was followed by the previous session coming back. A pointer in
 * AsyncStorage now names which store holds the committed value, and the other
 * copy is retired on every write.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const SECURE_STORE_CHUNK_BYTES = 1_500;
/** The library's own rule, copied here so a bad key never reaches it. */
const SECURE_STORE_KEY = /^[\w.-]+$/;
const MANIFEST_PREFIX = '__delegent_chunked_v2__:';
/**
 * The old manifest. It can only exist where the old code managed to write a
 * head without its chunks, and those chunk keys were never writable, so a head
 * carrying this prefix is an unreadable value rather than a migration. Treated
 * as absent, which sends the read to the plaintext copy that actually holds the
 * session, and the next write replaces it.
 */
const LEGACY_MANIFEST_PREFIX = '__sidekick_chunked__:';
/** Two buffers, so a half-written replacement never overwrites the live one. */
const GENERATIONS = ['a', 'b'] as const;
type Generation = (typeof GENERATIONS)[number];
/** A stop on a corrupt manifest and on the sweep for an interrupted write. */
const MAX_CHUNKS = 64;
/** How long after a sign-out a late refresh is refused. A backstop only: every
 * sign-in entry point releases the fence explicitly, so a forgotten release can
 * never lock somebody out of signing in. */
const SIGN_OUT_FENCE_MS = 10_000;

const chunkKey = (key: string, generation: Generation, index: number) => `${key}.dgc${generation}.${index}`;
/** AsyncStorage only, so its own characters do not have to satisfy SecureStore. */
const backendKey = (key: string) => `${key}.__delegent_store__`;

/**
 * Every key Supabase has asked this adapter about, read or write.
 *
 * Sign-out has to delete the persisted session itself, and the key is Supabase's
 * to choose. Recording what it actually used beats deriving it from the project
 * URL, which is a guess that goes stale the day they change the format.
 */
const touchedKeys = new Set<string>();
let signOutFenceUntil = 0;

function isSecureStoreAvailable(): boolean {
  // SecureStore is unavailable in web and Node test environments. Treat any
  // platform other than ios/android as the fallback path.
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function usesSecureStore(key: string): boolean {
  return isSecureStoreAvailable() && SECURE_STORE_KEY.test(key);
}

function parseManifest(head: string | null): { generation: Generation; count: number } | null {
  if (typeof head !== 'string' || !head.startsWith(MANIFEST_PREFIX)) return null;
  const [generation, rawCount] = head.slice(MANIFEST_PREFIX.length).split(':');
  const count = Number.parseInt(rawCount ?? '', 10);
  if (!GENERATIONS.includes(generation as Generation)) return null;
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_CHUNKS) return null;
  return { generation: generation as Generation, count };
}

async function readHead(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key).catch(() => null);
}

/** Deletes the known chunks, then keeps going while more are found. An
 * interrupted write leaves chunks with no manifest to count them. */
async function sweepChunks(key: string, generation: Generation, known = 0): Promise<void> {
  for (let index = 0; index < Math.min(known, MAX_CHUNKS); index++) {
    await SecureStore.deleteItemAsync(chunkKey(key, generation, index)).catch(() => undefined);
  }
  for (let index = known; index < MAX_CHUNKS; index++) {
    const existing = await SecureStore.getItemAsync(chunkKey(key, generation, index)).catch(() => null);
    if (existing === null) return;
    await SecureStore.deleteItemAsync(chunkKey(key, generation, index)).catch(() => undefined);
  }
}

async function readSecure(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key);
  if (head === null || head.startsWith(LEGACY_MANIFEST_PREFIX)) return null;
  const manifest = parseManifest(head);
  if (!manifest) return head;
  const parts = await Promise.all(
    Array.from({ length: manifest.count }, (_, index) => SecureStore.getItemAsync(chunkKey(key, manifest.generation, index))),
  );
  // A missing chunk is an incomplete value, never a partial session.
  return parts.some((part) => part === null) ? null : parts.join('');
}

async function writeSecure(key: string, value: string): Promise<void> {
  const previous = parseManifest(await readHead(key));
  if (value.length <= SECURE_STORE_CHUNK_BYTES) {
    await SecureStore.setItemAsync(key, value);
    if (previous) await sweepChunks(key, previous.generation, previous.count);
    return;
  }
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += SECURE_STORE_CHUNK_BYTES) {
    chunks.push(value.slice(i, i + SECURE_STORE_CHUNK_BYTES));
  }
  if (chunks.length > MAX_CHUNKS) throw new Error('session too large for secure storage');
  // Into the buffer that is NOT live. A failure part way through leaves the
  // committed generation whole and still readable.
  const generation: Generation = previous?.generation === 'a' ? 'b' : 'a';
  for (let index = 0; index < chunks.length; index++) {
    await SecureStore.setItemAsync(chunkKey(key, generation, index), chunks[index]);
  }
  // The commit. Until this lands the old value is what a reader gets.
  await SecureStore.setItemAsync(key, `${MANIFEST_PREFIX}${generation}:${chunks.length}`);
  if (previous) await sweepChunks(key, previous.generation, previous.count);
}

async function clearSecure(key: string): Promise<void> {
  const manifest = parseManifest(await readHead(key));
  await SecureStore.deleteItemAsync(key).catch(() => undefined);
  for (const generation of GENERATIONS) {
    await sweepChunks(key, generation, manifest?.generation === generation ? manifest.count : 0);
  }
}

type Backend = 'secure' | 'async';

async function readBackend(key: string): Promise<Backend | null> {
  try {
    const value = await AsyncStorage.getItem(backendKey(key));
    return value === 'secure' || value === 'async' ? value : null;
  } catch {
    return null;
  }
}

async function writeBackend(key: string, backend: Backend): Promise<void> {
  try { await AsyncStorage.setItem(backendKey(key), backend); } catch { /* best effort */ }
}

/**
 * Refuse session writes for a moment after a sign-out.
 *
 * A token refresh already in flight when someone signs out resolves afterwards
 * and writes the session straight back. Called at the start of sign-out and
 * released by every sign-in entry point; the deadline is only there so a
 * missing release cannot stop somebody signing in.
 */
export function fenceAuthStorageWrites(durationMs: number = SIGN_OUT_FENCE_MS): void {
  signOutFenceUntil = Date.now() + durationMs;
}

export function releaseAuthStorageWrites(): void {
  signOutFenceUntil = 0;
}

export function authStorageWritesFenced(): boolean {
  return Date.now() < signOutFenceUntil;
}

/**
 * Delete every persisted auth value this adapter knows about, in both stores.
 *
 * Sign-out cannot rely on the SDK for this. In the installed auth client BOTH
 * scopes call the server first and return early on anything that is not a 401,
 * 403 or 404, so an offline or 503 sign-out never reaches the local removal and
 * the same account is restored on the next launch. This does not touch the
 * network and so has nothing to fail on.
 */
export async function clearPersistedAuthStorage(): Promise<readonly string[]> {
  const keys = [...touchedKeys];
  for (const key of keys) {
    if (usesSecureStore(key)) {
      try { await clearSecure(key); } catch { /* AsyncStorage below still runs */ }
    }
    try { await AsyncStorage.removeItem(key); } catch { /* best effort */ }
    try { await AsyncStorage.removeItem(backendKey(key)); } catch { /* best effort */ }
  }
  return keys;
}

export const secureSessionStorage: AsyncStorageLike = {
  async getItem(key: string): Promise<string | null> {
    touchedKeys.add(key);
    if (!usesSecureStore(key)) return AsyncStorage.getItem(key);
    // The pointer is the authority. Without it, this is a session written by a
    // build that had no pointer, so the old order applies: secure, then the
    // plaintext a failed secure write left behind.
    if ((await readBackend(key)) === 'async') return AsyncStorage.getItem(key);
    try {
      const secureValue = await readSecure(key);
      return secureValue ?? (await AsyncStorage.getItem(key));
    } catch {
      // Fall back rather than locking the user out of their session.
      return AsyncStorage.getItem(key);
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    touchedKeys.add(key);
    // A refresh that resolved after the sign-out it raced. Writing it would put
    // the account straight back.
    if (authStorageWritesFenced()) return;
    if (!usesSecureStore(key)) {
      await AsyncStorage.setItem(key, value);
      await writeBackend(key, 'async');
      return;
    }
    try {
      await writeSecure(key, value);
      await writeBackend(key, 'secure');
      // The losing copy. Left in place it is a plaintext refresh token that no
      // longer corresponds to anything.
      try { await AsyncStorage.removeItem(key); } catch { /* best effort */ }
    } catch {
      // Secure storage could not take it. Exactly one store may answer for this
      // key, so the pointer moves to the plaintext copy and the secure one is
      // retired. Retiring it is what stops the older session coming back.
      await AsyncStorage.setItem(key, value);
      await writeBackend(key, 'async');
      try { await clearSecure(key); } catch { /* the pointer already decided */ }
    }
  },
  async removeItem(key: string): Promise<void> {
    touchedKeys.add(key);
    // Sign-out must clear BOTH stores and the pointer between them. setItem may
    // have fallen back to AsyncStorage, and getItem reads from AsyncStorage when
    // SecureStore is empty, so deleting only one of them lets a stale token
    // resurrect the session on the next launch. That is defect A8, reproduced
    // by the forensic QA pass on v1.3.6 (2026-05-29).
    if (usesSecureStore(key)) {
      try {
        await clearSecure(key);
      } catch {
        // best-effort; AsyncStorage clear below still runs
      }
    }
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // last-resort tolerated; if both stores are unreachable the user
      // can still sign out from the server side and a fresh session
      // request will overwrite whatever was left here.
    }
    try { await AsyncStorage.removeItem(backendKey(key)); } catch { /* best effort */ }
  },
};
