import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../../..');
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));

function pngSize(relativePath) {
  const file = path.join(root, relativePath);
  assert.ok(fs.existsSync(file), `${relativePath} should exist`);
  const data = fs.readFileSync(file);
  assert.equal(data.toString('ascii', 1, 4), 'PNG', `${relativePath} should be a PNG`);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

assert.equal(appJson.expo.name, 'Delegent AI');
assert.equal(appJson.expo.splash.backgroundColor, '#FAFAF7');
assert.equal(appJson.expo.android.adaptiveIcon.backgroundColor, '#FAFAF7');
assert.equal(appJson.expo.icon, './assets/icon.png');
assert.equal(appJson.expo.android.adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
// INVERTED 2026-09-01. This asserted that a native splash image WAS configured.
// It is now deliberately absent: a static launch-storyboard image plus the
// animated <BrandSplash> played back to back, so every cold start flashed two
// splashes. Only the background colour is left, which is what BrandSplash draws
// on top of anyway.
//
// The asset itself stays in the repo and is still size-checked below, because
// it is the source for the generated icons and is cheap to keep. What must not
// come back is the CONFIG key.
assert.equal(
  appJson.expo.splash.image,
  undefined,
  'app.json declares a native splash image again, which reintroduces the double-splash flash',
);
// The real authority is app.config.ts, which is spread AFTER app.json and so
// wins. The parked iPad branch cleaned app.json alone and the image survived,
// which is why this second assertion exists.
{
  const cfg = fs.readFileSync(path.join(root, 'app.config.ts'), 'utf8');
  const splashBlock = cfg.slice(cfg.indexOf('splash: {'), cfg.indexOf('assetBundlePatterns'));
  assert.ok(
    !/image:/.test(splashBlock),
    'app.config.ts declares a splash image, which OVERRIDES app.json and brings the double splash back',
  );
}

assert.deepEqual(pngSize('assets/icon.png'), { width: 1024, height: 1024 });
assert.deepEqual(pngSize('assets/adaptive-icon.png'), { width: 1024, height: 1024 });
assert.deepEqual(pngSize('assets/splash-icon.png'), { width: 1024, height: 1024 });
// 512, raised from 256 on 2026-08-27 while auditing for iPad.
//
// SplashScreen renders this mark at 148pt. That needs 444px at @3x on an
// iPhone Pro and 296px at @2x on an iPad, so a 256px source was being upscaled
// on every modern device, not just on iPad. The iPad audit is simply what made
// it obvious.
//
// Asserted as a FLOOR rather than an exact size, unlike the icons above. Those
// are handed to the platform at a fixed size, so exact is right. This one is
// rendered by us at several sizes, where more resolution is never a regression
// and less always is.
const brandMark = pngSize('assets/coworker-ai-mark.png');
assert.equal(brandMark.width, brandMark.height, 'the brand mark must be square');
assert.ok(
  brandMark.width >= 512,
  `brand mark is ${brandMark.width}px; the splash renders it at 148pt, which needs 444px at @3x`,
);


// ---------------------------------------------------------------------------
// The double-splash, 2026-09-03. Reported by Alex THREE times, and fixed twice
// before without the reported behaviour changing, so this block pins the thing
// that actually causes it rather than the thing that looks like it should.
//
// What he sees on Android: the brain appears, vanishes, then comes back with
// the wordmark writing underneath.
//
// Why the earlier fixes did not work. On Android 12+ the system splash screen
// is MANDATORY and always draws an icon. res/values/styles.xml asks for
// @drawable/splashscreen_logo, and deleting that item only falls back to
// android:icon, which is the same brain. Removing 'splash.image' from the Expo
// config (2026-09-01) was correct and DID fix iOS, which has no checked-in
// native project. It could not fix Android, because android/ IS checked in, so
// the committed res/ files are authoritative and the config plugin never
// regenerates them for a bare workflow. The test written alongside that fix
// checked the CONFIG, so it passed while the phone still misbehaved.
//
// The first brain is therefore not removable. What made it look broken was the
// JS splash REPLAYING it: the mark faded in from opacity 0 on mount, so the
// brain the system had just drawn dropped out and came back.
//
// So the invariant is: the JS splash must CONTINUE the system splash, never
// restart it. The mark is opaque on the first frame and is not animated in.
const splashSource = fs.readFileSync(path.join(root, 'src/brand/SplashScreen.tsx'), 'utf8');

// 1. The mark must not be faded or scaled in.
assert.equal(
  /robotEntry/.test(splashSource),
  false,
  'SplashScreen animates the brand mark in again (robotEntry). The system splash has already drawn it, so fading it up from zero is what produces the reported flash.',
);
assert.equal(
  /styles\.robotWrap[^\]]*robotStyle|robotStyle[^\]]*styles\.robotWrap/.test(splashSource),
  false,
  'the brand mark is wrapped in an entry animation again',
);

// 2. The mark must stay dead centre. If the wordmark sits in normal flow it
//    pushes the mark up off centre, so the brain visibly jumps the instant the
//    JS splash mounts. Same defect, different costume.
assert.match(
  splashSource,
  /belowMark:\s*\{[\s\S]*?position: 'absolute'/,
  'the wordmark must be absolutely positioned below the mark, or adding it shifts the brain off centre',
);
assert.equal(
  /container: \{[\s\S]*?gap: space/.test(splashSource),
  false,
  'the splash container stacks its children with a gap again, which moves the mark off centre',
);

// 4. 2026-09-27 (Alex: "it flicks a brain up and then the brain comes again").
//    The JS splash still drew the brain SMALLER than the system splash (148pt
//    of a padded mark against the system's 288dp box), so it visibly snapped
//    down. Now its first frame IS the system splash: the same picture (the
//    splashscreen_logo drawable, transparent, so no box shows round it), the same
//    288dp box, opaque on Android. It may move on from there (the brain lifts
//    into the app orbit while the name is written); it never restarts it.
assert.match(splashSource, /const systemMark = require\('\.\.\/\.\.\/assets\/splash-logo\.png'\);/, 'the splash must start from the system splash picture');
assert.ok(fs.existsSync(path.join(root, 'assets/splash-logo.png')), 'assets/splash-logo.png is missing');
assert.match(splashSource, /const SYSTEM_MARK_DP = 288;/, 'the system splash draws the brain in a 288dp box; the first frame must match it');
assert.match(splashSource, /const continuesSystemSplash = Platform\.OS === 'android';/);
assert.match(splashSource, /const markShow = useSharedValue\(continuesSystemSplash \? 1 : 0\);/, 'on Android the brain is opaque on the first frame');
assert.match(splashSource, /\{ scale: 1 - \(1 - MARK_END_SCALE\) \* markMove\.value \}/, 'the brain starts at scale 1 and only shrinks as it moves on');

// 3. Pin the native side as DOCUMENTATION, not as something to delete. If a
//    future session removes this item believing it kills the first splash, the
//    system falls back to android:icon and nothing changes except that the
//    splash background stops matching. Keep it, and keep it on brand.
const androidStyles = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/styles.xml'), 'utf8');
assert.match(
  androidStyles,
  /windowSplashScreenAnimatedIcon/,
  'Android 12+ always draws an icon splash; declaring ours keeps it on brand rather than falling back to android:icon',
);
assert.match(
  androidStyles,
  /windowSplashScreenBackground/,
  'the system splash background must match the JS splash background, or the handoff flashes a different colour',
);

console.log('branding asset checks passed');
