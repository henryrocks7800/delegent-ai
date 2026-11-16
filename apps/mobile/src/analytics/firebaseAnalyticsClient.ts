// App-side loader for the native Firebase Analytics module (2026-09-11).
//
// Loaded lazily and defensively, the same guard metaSdkClient and
// nativeTaskReview use. The module is absent in Expo Go, in every Android
// binary before build 50 and every iOS binary before build 50, and an OTA
// carrying this file WILL reach some of those (Android 2.7.0 is shared by
// builds 49 and 50). A missing module must degrade to "the Measurement
// Protocol path carries on", never to a crash. Metro wraps the require in a
// factory that only executes on first call, so the try/catch below really
// does catch the native-module-missing throw.
import { Platform } from 'react-native';
import { createFirebaseTracker, type FirebaseAnalyticsApi, type FirebaseTracker } from './firebaseAnalytics';

type AnalyticsModule = typeof import('@react-native-firebase/analytics');

let trackerPromise: Promise<FirebaseTracker | null> | null = null;

async function loadApi(): Promise<FirebaseAnalyticsApi | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  try {
    const mod = (await import('@react-native-firebase/analytics')) as Partial<AnalyticsModule>;
    if (!mod.getAnalytics || !mod.logEvent || !mod.setConsent || !mod.setAnalyticsCollectionEnabled) return null;
    const instance = mod.getAnalytics();
    const { logEvent, setConsent, setAnalyticsCollectionEnabled } = mod;
    // Promise.resolve() around each call: the modular API returns void for
    // some methods and a promise for others, and the pure tracker treats
    // every one of them as a promise it can attach a catch to.
    return {
      logEvent: (name, params) => Promise.resolve(logEvent(instance, name, params)),
      setConsent: (consent) => Promise.resolve(setConsent(instance, consent)),
      setAnalyticsCollectionEnabled: (enabled) => Promise.resolve(setAnalyticsCollectionEnabled(instance, enabled)),
    };
  } catch {
    return null;
  }
}

/** Resolve the native tracker once, or null forever on a binary without it. */
export function firebaseTracker(): Promise<FirebaseTracker | null> {
  if (!trackerPromise) {
    trackerPromise = loadApi()
      .then((api) => (api ? createFirebaseTracker(api) : null))
      .catch(() => null);
  }
  return trackerPromise;
}

/**
 * Mirror the in-app advertising consent into Firebase's consent signals.
 * Called from the Meta consent client on every start (stored answer) and on
 * every fresh answer, so Google only ever sees the advertising id after the
 * same "yes" Meta gets. Fire-and-forget.
 */
let consentRevision = 0;
export function applyAdvertisingConsentToFirebase(granted: boolean): void {
  const revision = ++consentRevision;
  try {
    void firebaseTracker().then((tracker) => {
      if (revision === consentRevision) tracker?.applyAdvertisingConsent(granted);
    }).catch(() => {});
  } catch {
    // Analytics must never break the app.
  }
}
