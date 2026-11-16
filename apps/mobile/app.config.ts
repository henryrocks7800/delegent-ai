// Expo dynamic config. Replaces the static portions of `app.json` so that
// build-time values (notably the Google iOS URL scheme) can be substituted
// from environment variables instead of being hard-coded into a committed
// JSON file.
//
// Why this exists:
//   `app.json` was previously shipping the literal string
//   "com.googleusercontent.apps.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID" as the
//   iOS URL scheme. Expo does NOT substitute env vars in `app.json`, so the
//   placeholder was being baked into Info.plist verbatim — which silently
//   broke iOS Google sign-in. Worse, anyone "fixing" it by pasting a real
//   client ID would have committed a real OAuth client to git.
//
// Behaviour:
//   - On iOS builds, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be set; we fail
//     fast otherwise rather than ship a broken scheme.
//   - On non-iOS builds, the plugin entry is omitted so the absence of the
//     value doesn't block Android/Web work.

import type { ConfigContext, ExpoConfig } from 'expo/config';

const IOS_PLATFORMS: ReadonlyArray<string | undefined> = ['ios'];
type ExpoPlugin = NonNullable<ExpoConfig['plugins']>[number];
type AndroidIntentFilter = NonNullable<NonNullable<ExpoConfig['android']>['intentFilters']>[number];

/**
 * Whether this is a RELEASE build, i.e. one whose output reaches a customer and
 * must therefore fail loudly rather than ship a silently disabled feature.
 *
 * EAS_BUILD_PROFILE carries the LITERAL profile name, so `production-ios` (the
 * iOS store profile, which extends production and adds local credentials) does
 * not equal `production`. Both fail-fast guards below used exact equality and
 * so covered the Android store build only: an iOS store build with no Google
 * client id, or no Meta values, would have been built and shipped rather than
 * stopped. Neither bit build 32, both values were set, but the guards were one
 * missing env var away from a broken TestFlight release.
 */
function isReleaseBuildProfile(): boolean {
  const profile = process.env.EAS_BUILD_PROFILE ?? '';
  return profile === 'production' || profile.startsWith('production-');
}

function supabaseHostFromEnv(): string | null {
  const rawUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

function buildAuthIntentFilters(): AndroidIntentFilter[] {
  const filters: AndroidIntentFilter[] = [
    {
      action: 'VIEW',
      category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'sidekick', host: 'auth', pathPrefix: '/callback' }],
    },
    {
      action: 'VIEW',
      category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'sidekick', host: 'checkout', pathPrefix: '/' }],
    },
    {
      action: 'VIEW',
      category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'sidekick', host: 'billing', pathPrefix: '/return' }],
    },
    // Where a provider's consent screen sends the browser after a brokered
    // OAuth hand-off. Listed for the day this project is prebuilt again; it is
    // NOT what makes the link work today, because the bare AndroidManifest
    // already carries a host-less `sidekick` scheme filter that catches every
    // path. Verified on the installed build: the URL resolves to MainActivity.
    // The app reads nothing out of the link either way. It refreshes from the
    // broker on resume, because the server is the only honest source of what
    // actually got connected.
    {
      action: 'VIEW',
      category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'sidekick', host: 'connections', pathPrefix: '/return' }],
    },
  ];

  const supabaseHost = supabaseHostFromEnv();
  if (supabaseHost) {
    filters.push({
      action: 'VIEW',
      autoVerify: false,
      category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'https', host: supabaseHost, pathPrefix: '/auth/v1/verify' }],
    });
  }

  return filters;
}

function buildGoogleSignInPlugin(): ExpoPlugin {
  const platform = process.env.EAS_BUILD_PLATFORM ?? process.env.EXPO_PUBLIC_PLATFORM;
  const isIosBuild = IOS_PLATFORMS.includes(platform);

  // Google's iOS URL scheme is the REVERSED client id, which is the client id
  // with the ".apps.googleusercontent.com" suffix REMOVED. The console hands
  // you the full id, and EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is stored in that
  // full form, so the obvious thing to store here is the full form too.
  // Storing it raw would produce
  //   com.googleusercontent.apps.<id>.apps.googleusercontent.com
  // which is silently wrong: the build succeeds, Info.plist looks populated,
  // and Google sign-in fails on device. Normalise instead of trusting the
  // operator to remember, and accept either form.
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim()
    ?.replace(/\.apps\.googleusercontent\.com$/i, '');

  if (isIosBuild) {
    if (!iosClientId) {
      // The iOS Google OAuth client is an operator-gated Google Cloud console
      // step (fork deviation D-3) and does not exist yet. Production iOS
      // builds still fail fast, an App Store build without Google sign-in
      // would be a silent parity break. Simulator/dev builds are allowed
      // through WITHOUT the plugin so compile-parity work can proceed before
      // the client exists; email-code sign-in still works in those builds.
      const profile = process.env.EAS_BUILD_PROFILE ?? '';
      if (isReleaseBuildProfile()) {
        throw new Error(
          'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is required for production iOS builds. ' +
            'Create the iOS OAuth client in the Google Cloud console and set it ' +
            'via EAS Secrets.',
        );
      }
      console.warn(
        `[app.config] iOS ${profile || 'local'} build WITHOUT Google sign-in: ` +
          'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is not set (operator step pending).',
      );
      return ['@react-native-google-signin/google-signin'];
    }
    return [
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: `com.googleusercontent.apps.${iosClientId}` },
    ];
  }

  // Android-only / web-only / unspecified builds: include the plugin without
  // an iOS scheme so the plugin's Android-side wiring still runs.
  return ['@react-native-google-signin/google-signin'];
}

/**
 * Meta (Facebook) SDK, so Meta can measure app installs and optimise ads
 * toward them.
 *
 * WHY THIS EXISTS. Without it Meta's funnel stops at the click. It cannot see
 * an install, so it optimises for whoever is cheapest to make tap, which is a
 * different population from people who install. Two campaigns have now shown
 * exactly that shape: Dan's produced 43 clicks and nothing measurable, and ours
 * produced 176 clicks and zero sign-ups. The SDK is what closes that loop.
 *
 * This does NOT replace `install_attribution`. That measures the truth from the
 * Play Store referrer independently of Meta, and it stays. This is about giving
 * Meta's optimiser a signal to aim at.
 *
 * ⚠️ NATIVE CHANGE. It cannot ship over the air. It needs a new AAB via
 * `scripts/build-play-aab.sh` and a Play Store release, and the runtimeVersion
 * must move with it (see app.json "version").
 *
 * ⚠️ PRIVACY. `advertiserIDCollectionEnabled` collects the Android advertising
 * ID and sends event data to Meta. The privacy policy and the Play Data Safety
 * form must both say so, in the same release. See packages/shared/src/legal.
 *
 * The client token is NOT a secret in the sense that matters here: it is
 * compiled into every copy of the app, exactly like the Supabase anon key. It
 * still comes from the environment rather than the repo, so it can be rotated
 * without a code change. Meta App Dashboard → Settings → Advanced → Client token.
 */
function buildMetaSdkPlugin(): ExpoPlugin | null {
  const appId = process.env.EXPO_PUBLIC_META_APP_ID?.trim();
  const clientToken = process.env.EXPO_PUBLIC_META_CLIENT_TOKEN?.trim();

  if (!appId || !clientToken) {
    // Deliberately NOT a hard failure. An OTA build, a local run and every CI
    // typecheck resolve this file without the Meta values present, and throwing
    // would break all of them to guard one native build. The production build
    // is gated below instead, where getting it wrong actually costs something.
    if (isReleaseBuildProfile()) {
      throw new Error(
        'EXPO_PUBLIC_META_APP_ID and EXPO_PUBLIC_META_CLIENT_TOKEN are required for '
        + 'production builds. Without them the Meta SDK is silently absent and Meta '
        + 'cannot optimise for installs, which is the entire reason it was added.',
      );
    }
    return null;
  }

  return [
    'react-native-fbsdk-next',
    {
      appID: appId,
      clientToken,
      displayName: 'Delegent AI',
      // Meta requires this exact scheme shape, "fb" followed by the app id.
      scheme: `fb${appId}`,
      // OFF in the binary, deliberately, and turned on at runtime only after
      // the user consents. See src/analytics/metaSdk.ts.
      //
      // Shipping these as `true` would start collecting the Android advertising
      // ID and sending app events to Meta the moment the app opens. Under PECR
      // that is storage and access on a user's device for advertising, which
      // needs consent, not legitimate interest. It would also directly
      // contradict the privacy policy we already publish, which currently
      // promises the analytics identifier "is not used for advertising" and
      // that we do not do "cross-site tracking".
      //
      // A default of false costs nothing: the SDK is present in the binary, so
      // enabling it later is a runtime flag rather than another Play release.
      autoLogAppEventsEnabled: false,
      advertiserIDCollectionEnabled: false,
      isAutoInitEnabled: false,
    },
  ];
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Delegent AI',
  slug: 'sidekick-v2',
  scheme: 'sidekick',
  // Android's store version and runtime come from app.json. iOS has a separate
  // store version in the production-ios profile and its own runtime below.
  // Use PROFILE env for the iOS override: EAS_BUILD_PLATFORM is server-only,
  // but appVersionSource=local resolves this file before uploading the build.
  version: process.env.DELEGENT_IOS_STORE_VERSION ?? config.version,
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  // NO `image` here on purpose, removed 2026-09-01 with the iPad release.
  //
  // A static launch-storyboard image plus the animated <BrandSplash> played
  // back to back, so the app flashed two splashes on every cold start. Killing
  // the native image leaves the background colour behind it, which is what
  // BrandSplash draws on top of anyway, so the join is invisible.
  //
  // ⚠️ The parked branch tried to fix this by deleting the same two keys from
  // app.json. That was a NO-OP: this block is spread AFTER `...config`, so
  // app.config.ts wins and the image survived. Fixing it here is what actually
  // works. app.json is cleaned up too, for anyone reading that file first.
  splash: {
    backgroundColor: '#FAFAF7',
  },
  assetBundlePatterns: ['**/*'],
  // EAS Update (OTA) lets us hot-patch JS-only defects (e.g. the #15 error
  // boundary / #16 auth-backoff class) without cutting a new Play release.
  // This is a BARE workflow, so `eas update` requires a concrete runtimeVersion
  // STRING (the managed-only `{ policy: 'appVersion' }` is rejected at publish).
  // We derive it from the same `version` (2.1.1) the policy would have produced,
  // so JS never lands on an incompatible native build: any native change bumps
  // `version`, forking a new runtime that needs a fresh store build. It must
  // equal EXPO_RUNTIME_VERSION in android/app/src/main/AndroidManifest.xml (the
  // native authority), kept in sync by
  // android/app/src/test/js/expo-updates-ota-readiness.test.mjs.
  updates: {
    url: 'https://u.expo.dev/814ee5d5-c8d8-44c2-93b0-932e898eabd8',
    enabled: true,
    // Pin the OTA channel IN-CONFIG. @expo/config-plugins writes the
    // expo-channel-name request header into AndroidManifest ONLY when
    // updates.requestHeaders is set, and REMOVES it otherwise — so every gradle
    // build (notably scripts/build-play-aab.sh, the only Play-signable path)
    // regenerates the manifest and strips the hand-added channel header, leaving
    // the AAB unable to fetch production OTAs. Declaring it here makes the
    // channel survive every build. Env-overridable for a non-production build.
    requestHeaders: { 'expo-channel-name': process.env.EXPO_UPDATES_CHANNEL || 'production' },
  },
  // Android's runtime follows app.json. Build 49 forks it to 2.7.0 because
  // expo-store-review needs a native binary. Older builds remain on 2.5.0;
  // any OTA intended for them must use their matching release configuration.
  runtimeVersion: config.version ?? '2.1.1',
  android: {
    package: 'com.sidekick.v2',
    // Bump on every release; Play Store rejects re-uploads with the same
    // versionCode, and `adb install -r` rejects downgrades.
    // 24 = v2.0.0, the first end-to-end working build (beta candidate).
    // 25 = v2.1.0: collapsible Files folders + in-chat command-approval card.
    // 26 = v2.1.1: Files header count matches filtered total (+ runner-side noise/cap).
    // 27 = v2.1.1: root error boundary (#15) + auth-refresh backoff (#16) + the
    //      em-dash copy fix + EAS Update/OTA enabled (#17). First build that can
    //      receive OTA JS patches; version stays 2.1.1 so the OTA runtimeVersion
    //      (appVersion policy) matches AndroidManifest EXPO_RUNTIME_VERSION.
    // 28 = a prior out-of-band build already live on Play production (the repo
    //      counter had drifted to 27, so the camera build first tried 28 and
    //      collided; Play rejected it). Superseded by 29.
    // 29 = v2.1.1: chat composer camera button (expo-image-picker, native, so it
    //      needs a store build not an OTA) + OS-kill mid-camera photo recovery +
    //      OTA-channel fix. First versionCode to actually carry the camera.
    versionCode: config.android?.versionCode,
    intentFilters: buildAuthIntentFilters(),
    softwareKeyboardLayoutMode: 'resize',
    // v1.2.8 DN6 — RECORD_AUDIO permission for the in-app voice
    // recorder. Without this expo-av's Audio.Recording silently
    // fails the moment we call prepareToRecordAsync.
    // CAMERA: the chat composer's camera button (expo-image-picker) opens the
    // camera directly so a user can take a photo and drop it into chat. The
    // expo-image-picker plugin below also keeps CAMERA in the merged manifest;
    // listing it here makes the declared permission explicit + self-documenting.
    permissions: ['RECORD_AUDIO', 'CAMERA'],
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#FAFAF7',
    },
  },
  // iOS in the SAME codebase (2026-08-04, Alex's call): parity by construction
  // rather than the July `ios/` fork, which froze at 5 Jul and fell 400+
  // commits behind. The fork's PLATFORM_DEVIATIONS.md remains the reference
  // for the 11 places iOS is ALLOWED to differ; anything else identical.
  ios: {
    bundleIdentifier: 'com.sidekick.v2',
    // iOS FORKS ITS OTA RUNTIME HERE, and only iOS. Expo lets a platform
    // override the top-level runtimeVersion, which is the whole reason this is
    // set per-platform rather than by bumping `version`.
    //
    // Why the fork: build 38 is the first binary containing expo-iap, a NATIVE
    // module. Build 37 does not have it. If both sat on runtime 2.5.0, an OTA
    // carrying StoreKit-aware JS would land on build 37 too, where the module
    // does not exist. The loader degrades rather than crashing, so the symptom
    // would be a plan screen whose buy button says "This build cannot take
    // payments" — on the very binary App Review is holding. 2.6.0 makes that
    // impossible: OTAs reach build 38 and nothing else.
    //
    // Why NOT bump `version` to do this: `version` is shared, so it would drag
    // Android's runtime to 2.6.0 while every installed Android user sits on
    // 2.5.0, and the next Android OTA would reach nobody. It would also open a
    // new App Store version entry, when responding to a rejection wants a new
    // BUILD under the existing 2.5.0.
    //
    // 2.7.0 (2026-09-11): build 50 is the first iOS binary carrying the native
    // Firebase Analytics module (Google Ads install and in-app conversion
    // measurement). The JS loads it lazily inside a try/catch, so an OTA that
    // reached build 48 would degrade rather than crash, but the runtime forks
    // anyway so nothing Firebase-aware is ever published to a binary without
    // the module. iOS OTAs from build 50 onwards target 2.7.0; 2.6.0 installs
    // keep receiving 2.6.0 publishes only if someone publishes to 2.6.0 on
    // purpose, exactly like Android 2.5.0.
    runtimeVersion: '2.7.0',
    // Firebase iOS app 1:671851093734:ios:06fc76f805dac79d7ca527, registered
    // 2026-09-11 in project your-firebase-project (same project as Android). The
    // file is Firebase's per-app config, not a secret, and is committed for
    // the same reason android/app/google-services.json is.
    googleServicesFile: './GoogleService-Info.plist',
    // Lockstep with android versionCode (build.gradle). Bump both together,
    // always.
    //
    // 38 = v2.6.0, the first build carrying StoreKit (expo-iap).
    //
    // THE VERSION HAD TO MOVE THIS TIME, and the reasoning is the mirror image
    // of build 37's. 37 kept version at 2.5.0 deliberately, because it was only
    // a re-signature and forking the runtime would have cut build 36 off from
    // OTAs already published to 2.5.0. This build adds a NATIVE MODULE, so the
    // opposite is true: if it stayed on 2.5.0, every future OTA to that runtime
    // would reach both this binary (has expo-iap) and build 37 (does not), and
    // JS that expects StoreKit would land on a binary without it. Bumping to
    // 2.6.0 forks the runtime on purpose. Build 37 stops receiving OTAs, which
    // is the intended outcome: it is the REJECTED build and nothing should be
    // shipped to it.
    // 40 = the resubmission build for the 3.1.1 rejection. Runtime stays 2.6.0,
    // deliberately: the fixes it carries are the SAME JavaScript already
    // published as OTAs to that runtime, so build 39 and build 40 stay on one
    // update lane and neither is cut off. What changes is that build 40 has
    // them BAKED IN, so the reviewer gets a working purchase even if the device
    // never fetches an update before they tap Subscribe. Build 39's baked JS
    // still has the `ios` key expo-iap does not have.
    //
    // 41 IS NOT A REAL iOS BUILD. It exists only because a test enforces
    // iOS buildNumber == Android versionCode, and Android is shipping a real
    // 41 tonight (the new app icon, approved 2026-08-20). Build 40 is still
    // the one sitting in Apple's App Store review queue; nothing was rebuilt
    // or resubmitted for iOS. The NEXT real iOS build (icon + the Restore
    // Purchases button, batched once 3.1.1 clears) will be the one that
    // actually produces buildNumber 41 on TestFlight. Do not assume this
    // number describes anything Apple has seen.
    //
    // 42 = master's brand-mark release. Android genuinely shipped it (the
    //      photoreal brain icon, splash and in-app mark, live on Play as
    //      versionCode 42). iOS ships NOTHING here: this number moved only to
    //      hold the lockstep test, exactly as 41 did.
    //
    //      42 SUPERSEDES 41, which never shipped: its commit sat unmerged on
    //      feat/ios-apple-subscription-management while 42 went to Play. It is
    //      also deliberately ABOVE Apple's build 40, so a future iOS build from
    //      master cannot collide with the binary App Review already holds.
    //      Build 40 remains the only iOS build Apple has ever seen.
    // 45 = the iPad release (2.6.0). 42, 43 and 44 are already uploaded to
    //      App Store Connect, and Apple rejects a duplicate build number, so
    //      this MUST be above 44 for the submission to be accepted at all.
    // 46 = the brain app icon. 45 was already uploaded to App Store Connect
    //      carrying the retired blue robot, so this needed a fresh number
    //      rather than a re-upload. An app icon is a NATIVE asset: it cannot
    //      go over the air, which is the whole reason it was bundled into the
    //      iPad release rather than shipped separately.
    // 47 = 2.6.1, the App Store preview video release (2026-09-08). A preview
    //      is bound to an App Store version, and a version needs a build it has
    //      not seen before, so the draft that already holds the preview gets
    //      this build. JS-wise it is master as of the 70.03% launch coupon.
    // 48 embeds the growth onboarding on the first store-installed launch.
    // 49 is the Android native-review release. This reserves the next iOS
    // build number only; it does not claim an iOS binary has been submitted.
    // 50 (2026-09-11) is the install-measurement release on both platforms:
    //    native Firebase Analytics plus the SKAdNetwork ids, so Google Ads and
    //    Meta can count iOS installs. iOS 49 was never uploaded; the number
    //    moves to 50 so Android and iOS stay in lockstep.
    // 51: embeds the onboarding timeout correction and account-scoped consent.
    // No native module changes; runtime stays 2.7.0 for installed customers.
    // 52 embeds finite onboarding demos, connections first and the corrected
    // conditional Apple trial copy on the first launch after installation.
    // 54 (2026-09-15) is the connected AI coworker: the Android build ships it
    //    first, and the iOS build that follows carries the same number.
    // 55 (2026-09-16) sells the coworker plan through the App Store (£3.99,
    //    first month free) on iPhone; Android stays on 54 in Play for now.
    buildNumber: '55',
    // iPad, enabled 2026-08-27. PARKED ON A BRANCH until 2.5.0 (build 42) is
    // approved: this is a NATIVE change, so it cannot ship over the air, and
    // turning it on also makes the App Store listing require an iPad
    // screenshot set that does not exist yet (the listing has only
    // APP_IPHONE_67). Submitting it before those exist fails validation.
    //
    // Until then an iPad runs the iPhone binary in compatibility mode, which
    // Apple explicitly supports and which is NOT why 2.5.0 was rejected.
    supportsTablet: true,
    // ⚠️ REQUIRED alongside supportsTablet, and neither master nor the parked
    // branch had it.
    //
    // `orientation: 'portrait'` above does NOT bind on iPad. Expo writes all
    // four UISupportedInterfaceOrientations~ipad entries whenever
    // requireFullScreen is unset, because iPad multitasking (Slide Over, Split
    // View) requires an app to support every orientation. So enabling
    // supportsTablet silently shipped a landscape iPad layout that nothing in
    // this app was designed or tested for, and that App Review would see.
    //
    // Setting this true opts out of multitasking, which makes `portrait`
    // authoritative on iPad as well. That matches the product: the layout is
    // portrait, the composer fix was measured in portrait, and the four
    // screenshots on the listing are portrait. Revisit only if landscape is
    // deliberately designed, not to enable a feature nobody asked for.
    requireFullScreen: true,
    // Sign in with Apple. Guideline 4.8 makes an Apple-quality private login
    // MANDATORY once Google Sign-In is offered, so this ships in the first
    // App Store build rather than after a rejection. Adds the
    // com.apple.developer.applesignin entitlement at prebuild.
    usesAppleSignIn: true,
    infoPlist: {
      // SKAdNetwork (2026-09-11). Apple only sends an install postback to an
      // ad network that is listed here, so without these entries neither
      // Google Ads nor Meta can count a single iOS install, however the rest
      // of the pipeline is set up. Google Ads is cstr6suwn9; Meta owns two,
      // Facebook v9wttpbfk9 and Instagram n38lu8286q. No SDK is needed for
      // the postback itself; the ids are enough. Lower case, exact.
      SKAdNetworkItems: [
        { SKAdNetworkIdentifier: 'cstr6suwn9.skadnetwork' },
        { SKAdNetworkIdentifier: 'v9wttpbfk9.skadnetwork' },
        { SKAdNetworkIdentifier: 'n38lu8286q.skadnetwork' },
      ],
      // The app uses only standard HTTPS/TLS (exempt encryption), so declare
      // it once here; without this every TestFlight upload needs a manual
      // export-compliance answer in App Store Connect before anyone can test.
      ITSAppUsesNonExemptEncryption: false,
      // Android twin: RECORD_AUDIO below (the in-app voice recorder).
      NSMicrophoneUsageDescription:
        'Delegent AI uses the microphone to record voice messages you choose to send to your coworker.',
      // The camera rationale (NSCameraUsageDescription) is injected by the
      // expo-image-picker plugin below, same string on both platforms.
    },
  },
  plugins: [
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 26,
        },
        ios: {
          // STATIC, not dynamic, and here is the scar. EAS build d9d24478
          // (2026-09-11) used 'dynamic', React Native Firebase 26's default,
          // and the link failed: react-native-fbsdk-next built as its own
          // dynamic framework cannot see React's core symbols (RCTConvert,
          // RCTEventEmitter, RCTRegisterModule, "Undefined symbols for
          // architecture arm64"). Static frameworks are the combination the
          // Meta SDK has always been proven with. Firebase then has to come
          // through CocoaPods rather than SPM (disableSPM on the RNFB app
          // plugin below), and with Expo 55's prebuilt React core every RNFB
          // pod must be force-linked statically, per the library's own docs.
          useFrameworks: 'static',
          forceStaticLinking: ['RNFBApp', 'RNFBAnalytics'],
        },
      },
    ],
    // Google Analytics for Firebase, native (2026-09-11). This is what lets
    // Google Ads count an iOS install (first_open, via SKAdNetwork postbacks
    // it manages) and import the in-app funnel events as conversions, so its
    // App campaigns can optimise on people who sign up and pay rather than
    // on anyone who taps. On Android the same module autolinks into the
    // committed native project; the config plugins only run for iOS, which
    // has no committed native project and is prebuilt on EAS.
    [
      '@react-native-firebase/app',
      {
        // CocoaPods, not Swift Package Manager: SPM only ships dynamic
        // frameworks, and this project links statically (see
        // expo-build-properties above for the failed build that decided it).
        ios: { disableSPM: true },
      },
    ],
    [
      '@react-native-firebase/analytics',
      {
        ios: {
          // Keep IDFA support: Google uses the advertising id for attribution
          // only when the user has said yes to the ATT prompt below, and the
          // consent module withholds the ad signals until then. On-device
          // conversion measurement (hashed email matching) is deliberately
          // OFF; it is a separate privacy decision nobody has taken.
          withoutAdIdSupport: false,
          googleAppMeasurementOnDeviceConversion: false,
        },
      },
    ],
    [
      // Camera-to-chat: the composer's camera button opens the device camera
      // (expo-image-picker) so the user can take a photo and send it straight
      // into chat (WhatsApp-style). Passing a cameraPermission string sets the
      // iOS NSCameraUsageDescription rationale and keeps the Android CAMERA
      // permission in the merged manifest. microphonePermission is left unset
      // so the plugin does NOT block RECORD_AUDIO (still needed by voice mode).
      'expo-image-picker',
      {
        cameraPermission: 'Delegent AI uses your camera so you can take a photo and send it in chat.',
      },
    ],
    buildGoogleSignInPlugin(),
    buildMetaSdkPlugin(),
    [
      // App Tracking Transparency, iOS only in effect (no-op on Android).
      //
      // Two reasons this is here, both hard requirements rather than choices:
      //   1. Apple auto-rejects binaries that contain the Meta SDK but no ATT
      //      flow, and the Meta SDK IS in iOS builds — unlike Android, iOS has
      //      no committed native project, so EAS runs `expo prebuild` and the
      //      react-native-fbsdk-next plugin above genuinely executes there.
      //   2. On iOS the advertising identifier (IDFA) is gated behind Apple's
      //      own system dialog. Our in-app consent prompt alone cannot grant
      //      access to it; both must say yes. See metaSdkClient.ts for the
      //      ordering (our prompt first, ATT only after an accept).
      'expo-tracking-transparency',
      {
        userTrackingPermission:
          'This lets us tell Meta that an advert led to this install, so our adverts reach people who would actually find Delegent AI useful. Your messages and files are never shared.',
      },
    ],
  ].filter(Boolean) as NonNullable<ExpoConfig['plugins']>,
});
