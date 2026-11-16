// Pure, dependency-injected core for the "a new version is ready" banner.
//
// Design goal (Alex, 2026-07-19): the app is very stable; this must NEVER make
// it look buggy. So the whole surface is defensive:
//   - it only ever runs when expo-updates is actually enabled (never in dev /
//     Expo Go, where checkForUpdateAsync throws);
//   - it NEVER throws to the UI — any failure (updates off, network, dev build)
//     resolves to `false`, i.e. "show no banner";
//   - it does NOT reload the app itself. It only reports that a downloaded
//     update is ready; applying it (Updates.reloadAsync) is a deliberate user
//     tap, so we never yank the app out from under someone mid-task.
//
// It imports nothing native (only `import type`, erased at runtime) so it can be
// unit-tested under tsx with fake expo-updates deps, exactly like
// cameraCapture.ts / runnerFileUpload.ts.

export type OtaUpdateCheckDeps = {
  // Updates.isEnabled — false in dev / Expo Go / when updates are disabled.
  isEnabled: boolean;
  // Updates.checkForUpdateAsync — asks the server whether a newer update exists.
  checkForUpdate: () => Promise<{ isAvailable: boolean } | null | undefined>;
  // Updates.fetchUpdateAsync — downloads it; isNew===true means a fresh bundle
  // is now staged and reloadAsync would launch it.
  fetchUpdate: () => Promise<{ isNew: boolean } | null | undefined>;
};

// Resolves TRUE only when a NEW OTA update has been downloaded and is staged to
// apply on the next Updates.reloadAsync(). Returns FALSE (never throws) in every
// other case: updates disabled, nothing available, download not new, or any
// error along the way. A false result simply means "no banner".
export async function checkAndFetchOtaUpdate(deps: OtaUpdateCheckDeps): Promise<boolean> {
  if (!deps.isEnabled) return false;
  try {
    const check = await deps.checkForUpdate();
    if (!check || check.isAvailable !== true) return false;
    const fetched = await deps.fetchUpdate();
    return fetched?.isNew === true;
  } catch {
    return false;
  }
}
