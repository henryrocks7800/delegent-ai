// The device half of Meta consent: AsyncStorage, the native SDK, and on iOS
// Apple's App Tracking Transparency gate.
//
// Split from metaSdk.ts exactly like installReferrerClient.ts / ga4.ts: the
// decision logic lives in an import-free module so it can be tested under tsx,
// and this file holds the parts that only work on a real device.
//
// PLATFORM ASYMMETRY, worth reading twice. On Android the SDK is wired into
// the committed native project by hand (the bare project never runs prebuild,
// so config plugins do nothing there). On iOS there is NO committed native
// project, EAS runs `expo prebuild`, and the config plugins in app.config.ts
// genuinely execute. So the SDK is present on BOTH platforms via two different
// mechanisms, and this file is the single runtime gate for both.
//
// iOS adds a second lock: the advertising identifier sits behind Apple's ATT
// system dialog. Consent therefore means BOTH yeses there — ours, then
// Apple's. The ordering is deliberate: our prompt explains why before Apple's
// terse system dialog appears, and Apple only ever shows that dialog once per
// install, so it must not be wasted on someone who has not said yes to us.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportAdvertisingConsentToServer } from './advertisingConsentApi';
import { Platform } from 'react-native';
import { applyAdvertisingConsentToFirebase } from './firebaseAnalyticsClient';
import { createAdvertisingConsent } from './advertisingConsent';
import { captureInstallReferrer } from './installReferrerClient';
import { mobileSidekickApiBaseUrl, normalizePublicApiBaseUrl } from '../gateways/telegramConnect';

import {
  type MetaConsentState,
  type MetaSdkSettings,
} from './metaSdk';

/**
 * Load the native SDK, or null if it is not in this build.
 *
 * Imported lazily and defensively, the same guard installReferrerClient uses
 * for expo-application. The SDK is absent in Expo Go, in Android builds before
 * 2.3.0, and in any build made without the Meta app id and client token. A
 * missing module must degrade to "no ad measurement", never to a crash.
 */
async function loadSettings(): Promise<MetaSdkSettings | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  try {
    const mod = (await import('react-native-fbsdk-next')) as {
      Settings?: {
        setAutoLogAppEventsEnabled?: (v: boolean) => void;
        setAdvertiserIDCollectionEnabled?: (v: boolean) => void;
        initializeSDK?: () => void;
      };
    };
    const s = mod.Settings;
    if (!s?.setAutoLogAppEventsEnabled || !s.setAdvertiserIDCollectionEnabled || !s.initializeSDK) return null;
    return {
      setAutoLogAppEventsEnabled: (v) => s.setAutoLogAppEventsEnabled!(v),
      setAdvertiserIDCollectionEnabled: (v) => s.setAdvertiserIDCollectionEnabled!(v),
      initializeSDK: () => s.initializeSDK!(),
    };
  } catch {
    return null;
  }
}

/**
 * Apple's tracking gate. On Android this is trivially true.
 *
 * `request` controls whether the system dialog may appear. Startup paths must
 * pass false: prompting someone the moment the app opens is exactly the
 * pattern Apple's review rejects, and the dialog is a one-shot — once
 * answered, requestTrackingPermissionsAsync returns the stored answer for
 * ever, and the only way to change it is the iOS Settings app.
 */
async function trackingAuthorized(request: boolean): Promise<boolean> {
  if (Platform.OS !== 'ios') return true;
  try {
    const mod = (await import('expo-tracking-transparency')) as {
      getTrackingPermissionsAsync?: () => Promise<{ status: string }>;
      requestTrackingPermissionsAsync?: () => Promise<{ status: string }>;
    };
    const fn = request ? mod.requestTrackingPermissionsAsync : mod.getTrackingPermissionsAsync;
    if (!fn) return false;
    return (await fn()).status === 'granted';
  } catch {
    // Module missing or ATT unavailable: fail CLOSED. Collection without a
    // provable grant is the failure mode with legal consequences.
    return false;
  }
}

/** Should we show our prompt? Only when the user has never answered. */
export async function shouldAskMetaConsent(): Promise<boolean> {
  // No point asking if the build has no SDK to enable; the question would be
  // pure noise and the answer meaningless.
  if (!(await loadSettings())) return false;
  return (await advertisingConsent.state()) === 'unasked';
}

export async function currentMetaConsent(): Promise<MetaConsentState> {
  return advertisingConsent.state();
}

/**
 * Call on every app start. Does nothing unless consent was already granted,
 * and on iOS additionally requires ATT to already be granted — checked
 * read-only, never prompted here.
 */
export async function applyStoredMetaConsent(): Promise<MetaConsentState> {
  const authorized = await trackingAuthorized(false);
  if (!authorized && await advertisingConsent.state() === 'granted') await advertisingConsent.decide(false);
  else await advertisingConsent.sync();
  return advertisingConsent.state();
}

/**
 * Record the user's answer and act on it immediately.
 *
 * On iOS, an accept triggers Apple's ATT dialog, and if Apple's dialog is
 * refused we store DENIED rather than granted. The stored state drives the
 * Privacy screen toggle, and a toggle showing "on" while the OS blocks every
 * byte of collection would be a lie in the reassuring direction — the worst
 * kind. The cost is that the toggle cannot re-grant after an ATT refusal
 * (Apple only shows the dialog once; the change must be made in iOS
 * Settings), which is honest even though it is awkward.
 */
export async function recordMetaConsent(granted: boolean): Promise<void> {
  return advertisingConsent.decide(granted, () => trackingAuthorized(true));
}

let settingsRevision = 0;
function applyNativeConsent(enabled: boolean): void {
  const revision = ++settingsRevision;
  applyAdvertisingConsentToFirebase(enabled);
  void loadSettings().then((settings) => {
    if (!settings || revision !== settingsRevision) return;
    settings.setAutoLogAppEventsEnabled(enabled);
    settings.setAdvertiserIDCollectionEnabled(enabled);
    if (enabled) settings.initializeSDK();
  }).catch(() => undefined);
}

const advertisingConsent = createAdvertisingConsent({
  storage: AsyncStorage,
  // This is an ordering namespace, not a credential or advertising identifier.
  newDeviceId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  apply: applyNativeConsent,
  report: async (userId, granted, deviceId, revision, current) => {
    if (granted && !(await trackingAuthorized(false))) return false;
    return reportAdvertisingConsentToServer(userId, granted, deviceId, revision, current);
  },
  capture: (lease) => captureInstallReferrer(normalizePublicApiBaseUrl(mobileSidekickApiBaseUrl) ?? '', lease),
});

export const advertisingLease = advertisingConsent.lease;
export async function setAdvertisingAccount(userId: string | null): Promise<void> {
  // activate disables the previous account synchronously, before its first await.
  await advertisingConsent.activate(userId);
  await applyStoredMetaConsent();
}
