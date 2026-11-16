// Capture the Google Play install referrer, once, and hand it to the Worker.
//
// This is how we learn which advert produced a user. It matters because on
// 2026-08-06 an advertising campaign produced 43 clicks and zero installs and
// nothing in the system could say where people were lost.
//
// The whole reason this can ship over the air, with no Play Store release, is a
// happy accident: expo-application is already compiled into the shipped 2.2.0
// binary because it arrived as a dependency of expo-notifications, and it
// carries Google's Play Install Referrer library.
//
// Three constraints drive the design, and all three are Google's, not ours:
//
//   1. The referrer is available for **90 days after install**, then gone.
//   2. It is worth reading once; asking again gains nothing.
//   3. A reinstall hands back a NEW referrer, which must never overwrite the
//      original attribution. The server enforces first-write-wins; the local
//      flag here is only an optimisation, because storage can be cleared.
//
// **No imports, deliberately**, exactly like ga4.ts next door: this file runs
// directly under tsx in tests with injected fakes. Anything that reaches for
// react-native or AsyncStorage lives in installReferrerClient.ts instead,
// because importing react-native breaks the test transform.

export const INSTALL_REFERRER_DONE_KEY = 'delegent.installReferrer.captured.v1';

export type ReferrerStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type CaptureDeps = {
  getInstallReferrer: () => Promise<string>;
  post: (body: unknown) => Promise<boolean>;
  storage: ReferrerStorage;
  allowed?: () => boolean;
};

export type CaptureResult =
  | { status: 'captured' }
  | { status: 'already-done' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export async function captureInstallReferrerWith(deps: CaptureDeps): Promise<CaptureResult> {
  const { storage } = deps;
  const allowed = deps.allowed ?? (() => true);
  try {
    if (!allowed()) return { status: 'skipped', reason: 'no_consent' };
    if (await storage.getItem(INSTALL_REFERRER_DONE_KEY)) return { status: 'already-done' };
    if (!allowed()) return { status: 'skipped', reason: 'no_consent' };

    const referrer = (await deps.getInstallReferrer()) ?? '';
    if (!allowed()) return { status: 'skipped', reason: 'no_consent' };
    if (!referrer.trim()) {
      // No referrer is a normal outcome: sideloads, some OEM stores and the
      // emulator all return nothing. Mark it done so we stop asking, because
      // it will never become non-empty.
      await storage.setItem(INSTALL_REFERRER_DONE_KEY, new Date().toISOString());
      return { status: 'skipped', reason: 'empty' };
    }

    const ok = await deps.post({ referrer });
    if (!ok) return { status: 'failed', reason: 'post_failed' };
    if (!allowed()) return { status: 'skipped', reason: 'no_consent' };

    // Only mark done once the SERVER has it. Marking on read would throw away
    // the only copy if the request failed, and there is no retry after 90 days.
    await storage.setItem(INSTALL_REFERRER_DONE_KEY, new Date().toISOString());
    return { status: 'captured' };
  } catch (error) {
    // Never rethrown, never shown. Attribution is our concern, not the user's,
    // and it must not interrupt anything they are doing.
    return { status: 'failed', reason: error instanceof Error ? error.name : 'unknown' };
  }
}
