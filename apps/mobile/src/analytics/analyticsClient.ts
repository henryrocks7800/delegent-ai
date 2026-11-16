// App-side analytics singleton: fills the ga4.ts DI seam with the real
// transport (global fetch) and a stable pseudonymous client id persisted in
// AsyncStorage. Fully gated on EXPO_PUBLIC_GA4_MEASUREMENT_ID - when the id is
// absent (local dev, tests, an OTA published without the env bake) every
// track() call is an inert no-op. `track` never throws and is never awaited.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';
import { createGa4Tracker, type AnalyticsEventProps, type Ga4Tracker } from './ga4';
import { firebaseTracker } from './firebaseAnalyticsClient';

const measurementId =
  generatedExpoPublicEnv.EXPO_PUBLIC_GA4_MEASUREMENT_ID || process.env.EXPO_PUBLIC_GA4_MEASUREMENT_ID || '';

export const CLIENT_ID_STORAGE_KEY = 'delegent.analytics.clientId.v1';

// One session id per app launch - GA sessionises the funnel around it.
const sessionId = String(Date.now());

let trackerPromise: Promise<Ga4Tracker | null> | null = null;

/**
 * Forget the pseudonymous identifier and the tracker built around it.
 *
 * The privacy policy says the analytics identifier is removed when an account
 * is deleted. It had no removal path at all: the id persisted in AsyncStorage
 * across the deletion and the cached tracker kept using it, so the next launch
 * on the same handset carried on as the same analytics subject.
 *
 * ⚠️ WHAT THIS DOES NOT DO, and the difference matters. It erases the local
 * identifier. It does not reach into Google's or Meta's historical records, and
 * nothing here or in the copy may imply otherwise.
 */
export async function forgetAnalyticsIdentity(): Promise<void> {
  trackerPromise = null;
  try {
    // The reported-purchase ledger goes too: those are the biller's own
    // transaction ids for this account's payments.
    await AsyncStorage.multiRemove([CLIENT_ID_STORAGE_KEY, 'delegent.analytics.reportedPurchases.v1']);
  } catch {
    // A storage that refuses the delete is not a reason to fail a deletion the
    // server has already accepted.
  }
}

async function initTracker(): Promise<Ga4Tracker | null> {
  if (!measurementId) return null;
  // Stable pseudonymous client id (a random token, no account linkage). GA
  // needs it to count users and stitch a funnel across launches.
  let clientId = '';
  try {
    clientId = (await AsyncStorage.getItem(CLIENT_ID_STORAGE_KEY)) || '';
  } catch {
    // Storage unavailable: fall through to a per-launch id below.
  }
  if (!clientId) {
    clientId = `${Date.now()}.${Math.floor(Math.random() * 1_000_000_000)}`;
    try {
      await AsyncStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
      // Best effort - an unpersisted id still tracks this session.
    }
  }
  return createGa4Tracker({
    measurementId,
    clientId,
    sessionId,
    fetchFn: (url, init) => fetch(url, init),
  });
}

// Fire-and-forget product event. Safe to call from any render/callback path:
// synchronous void, never throws, never awaited, inert without configuration.
//
// Transport choice (2026-09-11): the native Firebase module carries the event
// when this binary has it (build 50 onwards), because that is the only path
// Google Ads can import as a conversion or use to count an iOS install. On an
// older binary the Measurement Protocol path below carries on unchanged. One
// transport per event, never both, so the property is not double counted.
export function track(name: string, props?: AnalyticsEventProps): void {
  try {
    void firebaseTracker()
      .then((native) => {
        if (native) {
          native.trackEvent(name, props);
          return;
        }
        if (!measurementId) return;
        if (!trackerPromise) trackerPromise = initTracker().catch(() => null);
        return trackerPromise.then((tracker) => tracker?.trackEvent(name, props));
      })
      .catch(() => {});
  } catch {
    // Analytics must never break the app.
  }
}
