import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-26 (Alex, phase 1): two small surface defects that both came from the
// same shape of mistake, data or a gesture that exists but never reaches the
// screen.
//   * The account photo was already extracted from the sign-in session and
//     already landed on the profile object; every avatar circle ignored it and
//     printed the name initial.
//   * Swipe-to-close existed but was arbitrated by a capture-phase responder on
//     the sheet, which a ScrollView with something to scroll wins. So the swipe
//     worked on short drawer views and did nothing on long ones.

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../../../../../src/auth/supabaseClient.ts', import.meta.url), 'utf8');

test('the account photo survives the whole trip from session to avatar circle', () => {
  assert.match(authSource, /metadataString\(metadata, \['avatar_url', 'picture'\]\)/, 'the session mapper no longer reads the photo');
  assert.match(authSource, /if \(avatarUrl\) publicSession\.user\.avatarUrl = avatarUrl;/, 'the photo is dropped before it reaches the app');
  assert.match(appSource, /const avatarUrl = user\?\.avatarUrl \?\? snapshot\.profile\?\.avatarUrl;/, 'buildProfile no longer picks up the photo');
  assert.match(appSource, /if \(avatarUrl\) profile\.avatarUrl = avatarUrl;/, 'buildProfile no longer sets the photo');
});

test('every avatar circle renders the photo and falls back to the initial', () => {
  assert.match(appSource, /function ProfileAvatar\(/, 'the shared avatar component is gone');
  assert.match(appSource, /source=\{\{ uri: url \}\}/, 'the avatar never renders an image');
  assert.match(appSource, /onError=\{\(\) => setFailedUrl\(url\)\}/, 'a broken photo would leave an empty circle');
  assert.match(appSource, /\{profile\.initial\}/, 'the initial fallback is gone');

  // All three sites go through the shared component, so a future avatar change
  // cannot land on the header and miss the drawer.
  const uses = appSource.match(/<ProfileAvatar /g) ?? [];
  assert.equal(uses.length, 3, `expected 3 ProfileAvatar render sites, found ${uses.length}`);

  // The circle style must only be applied by the component itself; a render
  // site that still draws its own circle is a site that still ignores the photo.
  const shellUses = appSource.match(/styles\.profileHeroAvatar/g) ?? [];
  assert.equal(shellUses.length, 1, 'profileHeroAvatar is referenced outside ProfileAvatar, so some site still draws its own circle');
});

test('the drawer swipe is tracked from touches, not from a responder race', () => {
  // Touch events reach the sheet whichever view owns the responder. If this
  // regresses to a bare panHandlers spread the swipe silently dies on any
  // drawer view long enough to scroll.
  for (const handler of ['onTouchStart:', 'onTouchMove:', 'onTouchEnd:', 'onTouchCancel:']) {
    assert.ok(appSource.includes(handler), `the drawer sheet lost ${handler}`);
  }
  assert.match(
    appSource,
    /\{\.\.\.\(view === 'setup' \? \{\} : \{ \.\.\.dragHandlers, \.\.\.panResponder\.panHandlers \}\)\}/,
    'the sheet no longer receives both the touch handlers and the responder',
  );
  assert.match(
    appSource,
    /onMoveShouldSetPanResponderCapture: \(\) => drag\.current\?\.claimed === true/,
    'the responder claim is back to racing the ScrollView on a raw dx threshold',
  );
});

test('a drag has to be deliberate before it cancels the row under the finger', () => {
  // Claiming too early turns a tap with a little sideways drift into a dead
  // press; claiming too late loses the gesture to the native scroller.
  assert.match(appSource, /const DRAWER_DRAG_CLAIM_DP = 20;/, 'the claim threshold moved without review');
  assert.match(appSource, /const DRAWER_DRAG_CLOSE_DP = 80;/, 'the close threshold moved without review');
  assert.match(appSource, /if \(!active\.claimed && \(dx >= 0 \|\| Math\.abs\(dx\) < Math\.abs\(touch\.pageY - active\.y\)\)\) return;/, 'vertical and rightward movement is no longer ignored');
});

test('the scroller is frozen before it can steal the swipe', () => {
  // 2026-07-26 (Alex): the swipe still died part-way on Routines and How-to
  // guides. Tracking the drag from touch events is not enough on Android: a
  // native ScrollView intercepts at its own 8dp slop and React Native then
  // CANCELS the JS touch stream, so the sheet moved a few dp and sprang back.
  // The sheet no longer races the scroller, it disables it below that slop.
  const lock = Number(/const DRAWER_DRAG_LOCK_DP = (\d+);/.exec(appSource)?.[1]);
  assert.ok(
    Number.isFinite(lock) && lock > 0 && lock < 8,
    `the lock threshold must stay under Android's 8dp scroll slop, found ${lock}`,
  );
  assert.match(appSource, /if \(!active\.locked && -dx >= DRAWER_DRAG_LOCK_DP\) \{/, 'the drag no longer freezes the scroller');
  assert.match(appSource, /setScrollLocked\(true\);/, 'the freeze is never applied');

  // 2026-09-03 (Alex, defect 108): "it hesitates and wobbles and it's quite
  // hard to just swipe it smoothly across." The freeze was a React state
  // update fired from onTouchMove, so every swipe re-rendered the whole drawer
  // on the JS thread at the exact moment the sheet's translateX was being
  // written from it. The lock now lives in a shared value and reaches the
  // scroller through animatedProps, which applies on the UI thread with no
  // render at all. If this ever goes back to useState the wobble comes back.
  assert.match(appSource, /const scrollLocked = useSharedValue\(false\);/, 'the scroll lock is React state again, which re-renders mid-gesture');
  assert.equal(/const \[scrollLocked, setScrollLocked\] = useState/.test(appSource), false, 'the scroll lock is React state again');
  assert.match(appSource, /const drawerScrollProps = useAnimatedProps\(\(\) => \(\{ scrollEnabled: !scrollLocked\.value \}\)\);/, 'the lock no longer reaches the scroller on the UI thread');

  // Both drawer bodies must honour it. Only wiring the submenu ScrollView is
  // exactly the half-fix that made this behave differently per view.
  const guarded = appSource.match(/animatedProps=\{drawerScrollProps\}/g) ?? [];
  assert.equal(guarded.length, 2, `both drawer ScrollViews must honour the drag lock, found ${guarded.length}`);
  const animatedScrollers = appSource.match(/<Animated\.ScrollView contentContainerStyle=\{styles\.drawerScroll\}/g) ?? [];
  assert.equal(animatedScrollers.length, 2, 'a drawer scroller went back to a plain ScrollView, which cannot take animatedProps');

  // And it must be released, or the drawer would be left unscrollable.
  const released = appSource.match(/setScrollLocked\(false\);/g) ?? [];
  assert.ok(released.length >= 2, 'the scroller is not released on touch end and cancel');
});

test('the setup sheet stays undismissable by gesture', () => {
  // Setup is a full-screen checkout hand-off with its own close button; an
  // accidental swipe mid-payment must not take it away.
  assert.match(appSource, /view === 'setup' \? \{\} :/, 'the setup view now accepts the swipe gesture');
});
