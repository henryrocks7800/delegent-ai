// Meta SDK, switched on only with consent.
//
// WHY THE SDK IS HERE AT ALL. Without it Meta's funnel stops at the click: it
// cannot observe an install, so it optimises for whoever is cheapest to make
// tap, which is a different population from people who install. Two campaigns
// have shown that exact shape, 43 clicks and 176 clicks, both with nothing
// measurable at the other end.
//
// WHY IT IS OFF BY DEFAULT. Turning it on collects the Android advertising ID
// and sends app events to Meta. Under PECR that is access to information on a
// user's device for advertising purposes, which requires consent rather than
// legitimate interest, and Delegent AI is UK-governed and ICO registered. Our
// own published privacy policy also states the analytics identifier "is not
// used for advertising". So the binary ships inert and this module is the only
// thing that can wake it.
//
// Device referrer reads and server attribution also require advertising consent.
// Runtime account coordination lives in advertisingConsent.ts.
//
// **No react-native imports here, deliberately**, matching ga4.ts and
// installReferrer.ts next door, so the logic runs under tsx in tests.

export const META_CONSENT_KEY = 'delegent.metaAdsConsent.v1';

export type ConsentStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type MetaSdkSettings = {
  setAutoLogAppEventsEnabled(enabled: boolean): void;
  setAdvertiserIDCollectionEnabled(enabled: boolean): void;
  initializeSDK(): void;
};

export type MetaConsentDeps = {
  storage: ConsentStorage;
  settings: MetaSdkSettings | null;
};

export type MetaConsentState = 'granted' | 'denied' | 'unasked';

export async function readMetaConsent(storage: ConsentStorage): Promise<MetaConsentState> {
  try {
    const v = await storage.getItem(META_CONSENT_KEY);
    if (v === 'granted' || v === 'denied') return v;
    return 'unasked';
  } catch {
    // Unreadable storage must fail CLOSED. Treating an error as consent would
    // start advertising collection on someone who never agreed to it.
    return 'unasked';
  }
}

/**
 * Apply whatever consent the user has already given. Safe to call on every app
 * start; it does nothing at all unless consent was explicitly granted.
 */
export async function applyMetaConsent(deps: MetaConsentDeps): Promise<MetaConsentState> {
  const state = await readMetaConsent(deps.storage);
  if (state !== 'granted' || !deps.settings) return state;
  try {
    // Order matters. The flags must be set BEFORE initializeSDK, or the SDK
    // initialises with collection still disabled and silently reports nothing,
    // which is indistinguishable from the SDK not being installed.
    deps.settings.setAutoLogAppEventsEnabled(true);
    deps.settings.setAdvertiserIDCollectionEnabled(true);
    deps.settings.initializeSDK();
  } catch {
    // Never surface an ads failure to a user. Attribution is our problem.
  }
  return state;
}

/** Record the user's answer and act on it immediately. */
export async function setMetaConsent(deps: MetaConsentDeps, granted: boolean): Promise<void> {
  try {
    await deps.storage.setItem(META_CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    return;
  }
  if (!deps.settings) return;
  try {
    if (granted) {
      deps.settings.setAutoLogAppEventsEnabled(true);
      deps.settings.setAdvertiserIDCollectionEnabled(true);
      deps.settings.initializeSDK();
    } else {
      // Withdrawal has to be as easy as granting, and has to actually stop the
      // collection rather than merely stop asking.
      deps.settings.setAutoLogAppEventsEnabled(false);
      deps.settings.setAdvertiserIDCollectionEnabled(false);
    }
  } catch {
    // Same as above: never user-visible.
  }
}
