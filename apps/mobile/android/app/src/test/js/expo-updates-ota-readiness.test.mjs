import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-contract test for EAS Update / OTA (GO_LIVE_TRACKER #17).
//
// OTA lets us hot-patch JS-only defects (the #15 error-boundary / #16
// auth-backoff class) without a Play release. Three surfaces must agree or the
// capability is silently broken:
//   1. android/app/src/main/AndroidManifest.xml — the NATIVE authority compiled
//      into the APK (what the running app actually obeys).
//   2. app.config.ts — what `eas update` reads to know where to publish + the
//      runtime policy a future `expo prebuild` would regenerate the manifest from.
//   3. app.json — the EAS projectId + the app `version` that, under the
//      `appVersion` policy, IS the runtime version the manifest must hardcode.
// The sharpest guard here is (manifest runtime === app.json version): this is a
// bare workflow (committed android/), so a `version` bump that forgets the
// manifest would ship JS to clients on a different native build. Fail loudly.

const appJson = JSON.parse(
  readFileSync(new URL('../../../../../app.json', import.meta.url), 'utf8'),
);
const appConfig = readFileSync(new URL('../../../../../app.config.ts', import.meta.url), 'utf8');
const easJson = JSON.parse(readFileSync(new URL('../../../../../eas.json', import.meta.url), 'utf8'));
const manifest = readFileSync(new URL('../../main/AndroidManifest.xml', import.meta.url), 'utf8');
const buildGradle = readFileSync(new URL('../../../build.gradle', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');

const projectId = appJson.expo?.extra?.eas?.projectId;
const appVersion = appJson.expo?.version;
const updateUrl = `https://u.expo.dev/${projectId}`;
const gradleVersionName = buildGradle.match(/versionName\s+"([^"]+)"/)?.[1] ?? null;

function manifestMeta(name) {
  const re = new RegExp(
    `<meta-data android:name="${name.replace(/\./g, '\\.')}" android:value="([^"]*)"\\s*/>`,
  );
  const m = manifest.match(re);
  return m ? m[1] : null;
}

test('a restart that will not start leaves the reader something to do', () => {
  // reloadAsync returns a promise, so the synchronous try/catch that used to
  // wrap it could never fire. A rejection went out as an unhandled rejection,
  // the banner sat there unchanged, and the reader pressed Restart to no
  // visible effect and with nothing to try next.
  assert.doesNotMatch(
    appSource,
    /try \{ void Updates\.reloadAsync\(\); \} catch/,
    'the synchronous catch cannot see an async rejection',
  );
  assert.match(appSource, /void Updates\.reloadAsync\(\)\.catch\(\(\) => setUpdateApplyFailed\(true\)\)/);

  // Pressing it again has to clear the last outcome, or a retry that works
  // still reads as broken for the instant before the app goes down.
  assert.match(appSource, /setUpdateApplyFailed\(false\);[\s\S]{0,700}?Updates\.reloadAsync\(\)\.catch/);

  // And the banner has to say it, with the one step that still applies the
  // update: it is already downloaded and staged, so a cold start picks it up.
  const start = appSource.indexOf('function UpdateAvailableBanner({');
  const banner = appSource.slice(start, appSource.indexOf('\nfunction ', start + 30));
  assert.match(banner, /applyFailed: boolean/);
  assert.match(banner, /applyFailed\s*\n?\s*\? 'We couldn’t restart the app\./);
  assert.match(banner, /Close it and open it again/);
  assert.match(banner, /: 'Restart the app to get the latest improvements\.'/);
});

test('the update banner is reachable from the login screen, not just the signed-in shell', () => {
  // 2026-08-13: iOS Google sign-in broke, the fix was staged as an OTA, and the
  // "a new version is ready" banner lived only inside Shell — signed-in users
  // only. The stranded user was on the login screen, the one place the banner
  // could never appear, force-quitting on superstition. The check + banner are
  // now one self-contained component mounted by BOTH auth branches.
  assert.match(appSource, /function StagedUpdateBanner\(\)/);

  const mounts = [...appSource.matchAll(/<StagedUpdateBanner \/>/g)];
  assert.equal(mounts.length, 3, 'The banner must be reachable from Shell, login, and onboarding');
  const onboardingAt = appSource.indexOf('<OnboardingScreen');
  assert.ok(mounts.some((m) => m.index < onboardingAt && onboardingAt - m.index < 100),
    'A user stuck saving an onboarding goal must be able to apply a staged fix');

  // One mount must sit in the signed-out branch, adjacent to LoginScreen.
  const loginAt = appSource.indexOf('<LoginScreen');
  assert.ok(loginAt > 0, 'LoginScreen render site should exist');
  assert.ok(
    mounts.some((m) => m.index < loginAt && loginAt - m.index < 800),
    'a StagedUpdateBanner mount must immediately precede the LoginScreen render',
  );

  // The banner still never auto-reloads: applying is a user tap on Restart.
  const component = appSource.slice(
    appSource.indexOf('function StagedUpdateBanner()'),
    appSource.indexOf('\nfunction ', appSource.indexOf('function StagedUpdateBanner()') + 30),
  );
  assert.match(component, /checkAndFetchOtaUpdate/);
  assert.match(component, /if \(!updateReady \|\| updateDismissed\) return null/);
  assert.doesNotMatch(
    component.replace(/onApply=\{[\s\S]*?\}\}/, ''),
    /reloadAsync/,
    'reloadAsync may only be called from the user-tapped onApply handler',
  );
});

test('app.json carries a concrete EAS projectId and app version', () => {
  assert.match(projectId ?? '', /^[0-9a-f-]{36}$/, 'extra.eas.projectId must be a UUID');
  assert.match(appVersion ?? '', /^\d+\.\d+\.\d+$/, 'version must be semver');
});

test('native updates are ENABLED and point at this project', () => {
  assert.equal(manifestMeta('expo.modules.updates.ENABLED'), 'true');
  assert.equal(manifestMeta('expo.modules.updates.EXPO_UPDATE_URL'), updateUrl);
});

test('native runtime version equals app.json version (appVersion policy, drift guard)', () => {
  // The bite: bump app.json `version` and this fails until the manifest is
  // bumped too — preventing OTA JS from reaching a mismatched native build.
  assert.equal(manifestMeta('expo.modules.updates.EXPO_RUNTIME_VERSION'), appVersion);
});

test('android build.gradle versionName equals app.json version (no version drift)', () => {
  // 2026-07-19 incident: an out-of-band build shipped with gradle versionName
  // 2.1.2 while app.json (and therefore the OTA runtime) stayed 2.1.1, so Play +
  // Sentry reported a version that did not match the update runtime. The
  // store-facing versionName MUST stay pinned to the same string the runtime is
  // derived from. With the build-from-HEAD guard (scripts/build-play-aab.sh),
  // this makes such a drifted out-of-band build impossible through the
  // sanctioned path and fails CI loudly if anyone bumps one field but not both.
  assert.equal(
    gradleVersionName,
    appVersion,
    'android/app/build.gradle versionName must equal apps/mobile/app.json version',
  );
});

test('native build is pinned to the production update channel', () => {
  const header = manifestMeta('expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY');
  assert.ok(header, 'request-headers meta-data present');
  assert.match(header, /expo-channel-name/);
  assert.match(header, /production/);
});

test('app.config.ts agrees: same update URL + concrete derived runtimeVersion (bare-workflow OTA)', () => {
  assert.ok(appConfig.includes(updateUrl), 'app.config.ts updates.url matches the projectId URL');
  // Bare workflow: `eas update` requires a concrete runtimeVersion STRING, not
  // the managed `{ policy: 'appVersion' }` (it rejects the policy at publish). We
  // derive it from `version`, so it stays equal to the native EXPO_RUNTIME_VERSION
  // (the appVersion drift guard above still holds).
  assert.match(appConfig, /runtimeVersion:\s*config\.version/);
  assert.doesNotMatch(appConfig, /runtimeVersion:\s*\{/, 'runtimeVersion must be a concrete string, not the managed object policy; eas update rejects the policy in a bare workflow');
  assert.match(appConfig, /enabled:\s*true/);
});

test('eas.json maps the production build profile to the production channel', () => {
  assert.equal(easJson.build?.production?.channel, 'production');
  assert.equal(easJson.cli?.appVersionSource, 'local');
});
