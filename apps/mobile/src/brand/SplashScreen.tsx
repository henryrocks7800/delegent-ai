import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import * as SystemSplash from 'expo-splash-screen';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useThemeColors } from '../design/primitives';
import { AppOrbit, POPULAR_APPS, useReducedMotion } from '../onboarding/motion';
import { SPLASH_SANS_LETTERS, SPLASH_SCRIPT_LETTERS, SPLASH_SCRIPT_VIEWBOX } from './splashScript';

// 2026-09-27 (Alex: "it flicks a brain up and then the brain comes again with
// Delegent AI written underneath ... one splash screen that looks really nice").
//
// ONE splash, not two. Android 12+ always draws its own splash first (the brain,
// res/drawable/splashscreen_logo, 288dp, dead centre) and only a native build can
// change that. So this one starts as an exact copy of it: the same picture
// (assets/splash-logo.png is that drawable, 256 colours with its transparency), the
// same 288dp, the same centre. The handover is invisible, and from there the
// brain comes alive: it lifts and settles, the apps it works in fly in and
// circle it, and "Delegent" is written out by hand under it, letter by letter,
// in the wordmark's own font (paths in splashScript.ts), before "AI" appears.
//
// iPhone has no system brain (no native splash image), so there the brain fades
// up instead of continuing one. OTA-safe: core views, react-native-svg and the
// Reanimated calls the shipped binaries already run.
const systemMark = require('../../assets/splash-logo.png');
const SYSTEM_MARK_DP = 288;
const continuesSystemSplash = Platform.OS === 'android';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// Android hides its launch screen the moment the app draws its first frame,
// but the brain image then takes a beat to decode, so for a moment the launch
// screen faded out over an empty spot and the brain came back (the flash Alex
// kept seeing). So App.tsx holds the launch screen (holdSystemSplash, at module
// load) and the brain's own onLoad releases it: the launch screen then fades
// over an identical brain and the handover cannot be seen. A safety timer
// releases it regardless, so it can never stick. expo-splash-screen loads its
// native half as optional, so this is safe over the air.
let systemSplashReleased = false;
export function releaseSystemSplash(): void {
  if (systemSplashReleased) return;
  systemSplashReleased = true;
  try { SystemSplash.hide(); } catch { /* nothing to release */ }
}
export function holdSystemSplash(): void {
  try { void SystemSplash.preventAutoHideAsync().catch(() => undefined); } catch { /* never block start-up */ }
  // Hand over in one frame rather than a 400 ms fade: our first frame is the
  // same picture, so an instant swap cannot be seen, while a fade let the two
  // brains drift apart once ours began to move.
  try { SystemSplash.setOptions({ duration: 0, fade: false }); } catch { /* the default fade is fine too */ }
  setTimeout(releaseSystemSplash, 2500);
}

const HOLD_SYSTEM_FRAME_MS = 140; // a beat as the exact system splash
const MARK_MOVE_MS = 720; // the brain lifts and settles into the orbit
const MARK_END_SCALE = 0.56; // 288dp box to about 161dp; the brain itself about 104dp
const ORBIT_IN_AT_MS = 200; // the apps fly in (AppOrbit arrives over 1.1 s)
const ORBIT_SPIN_MS = 16000; // fast enough to see the apps travel
const WRITE_AT_MS = 460;
const WRITE_MS = 1000;
const LETTER_STEP = 0.55; // each letter starts when the one before is 55% written
const EXIT_AT_MS = 1900;
const FADE_OUT_MS = 340;
// Past its minimum, the splash holds its finished frame until the app knows
// where this launch is going (App passes `ready`), but never longer than this.
const MAX_WAIT_MS = 6000;
const WORDMARK_SCALE = 1.25;
const WORDMARK_GAP = 10;

type SplashScreenProps = {
  /** Called once the splash has finished its exit fade. */
  onFinish: () => void;
  /** Minimum total time the splash should remain visible before fading. */
  minDurationMs?: number;
  /**
   * False while the app does not yet know which screen comes next (fonts
   * loading, a saved sign-in being restored). The splash will not leave until
   * it is true, or MAX_WAIT_MS has passed.
   */
  ready?: boolean;
};

export function SplashScreen({ onFinish, minDurationMs = 1700, ready = true }: SplashScreenProps) {
  const themeColors = useThemeColors();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const orbitSize = Math.round(Math.min(width * 0.8, 320));
  const wordmarkWidth = SPLASH_SCRIPT_VIEWBOX.width * WORDMARK_SCALE;
  const wordmarkHeight = SPLASH_SCRIPT_VIEWBOX.height * WORDMARK_SCALE;
  // Orbit and wordmark together sit centred, so the brain ends this far above centre.
  const lift = -Math.round((WORDMARK_GAP + wordmarkHeight) / 2);
  const letterCount = SPLASH_SCRIPT_LETTERS.length;
  const writeEnd = (letterCount - 1) * LETTER_STEP + 1;

  const markMove = useSharedValue(0);
  const markShow = useSharedValue(continuesSystemSplash ? 1 : 0);
  const orbitShow = useSharedValue(0);
  const write = useSharedValue(0);
  const sansShow = useSharedValue(0);
  const containerOpacity = useSharedValue(1);
  const [orbitMounted, setOrbitMounted] = useState(false);
  const [minimumDone, setMinimumDone] = useState(false);
  const [waitedLongEnough, setWaitedLongEnough] = useState(false);
  const [started, setStarted] = useState(false);
  const leaving = useRef(false);

  // Nothing moves until Android has let go of its launch screen, which happens
  // when our brain has decoded (the Image's onLoad). Before that our frame is
  // hidden behind Android's, so a timeline started at mount had already moved
  // the brain when the handover came, and the two brains showed side by side.
  const begin = useCallback(() => {
    releaseSystemSplash();
    setStarted(true);
  }, []);
  useEffect(() => {
    const safety = setTimeout(begin, 2500);
    const cap = setTimeout(() => setWaitedLongEnough(true), MAX_WAIT_MS);
    return () => { clearTimeout(safety); clearTimeout(cap); };
  }, [begin]);

  useEffect(() => {
    if (!started) return undefined;
    const exitAt = Math.max(minDurationMs, EXIT_AT_MS);
    if (reduced) {
      markShow.value = 1;
      markMove.value = 1;
      orbitShow.value = 1;
      write.value = writeEnd;
      sansShow.value = 1;
      setOrbitMounted(true);
    } else {
      const ease = Easing.out(Easing.cubic);
      if (!continuesSystemSplash) markShow.value = withTiming(1, { duration: 180 });
      markMove.value = withDelay(HOLD_SYSTEM_FRAME_MS, withTiming(1, { duration: MARK_MOVE_MS, easing: Easing.inOut(Easing.cubic) }));
      orbitShow.value = withDelay(ORBIT_IN_AT_MS, withTiming(1, { duration: 420, easing: ease }));
      write.value = withDelay(WRITE_AT_MS, withTiming(writeEnd, { duration: WRITE_MS, easing: Easing.inOut(Easing.quad) }));
      sansShow.value = withDelay(WRITE_AT_MS + WRITE_MS - 150, withTiming(1, { duration: 260, easing: ease }));
    }
    const orbitTimer = reduced ? null : setTimeout(() => setOrbitMounted(true), ORBIT_IN_AT_MS);
    const minimumTimer = setTimeout(() => setMinimumDone(true), exitAt);
    return () => {
      if (orbitTimer) clearTimeout(orbitTimer);
      clearTimeout(minimumTimer);
      cancelAnimation(markMove);
      cancelAnimation(markShow);
      cancelAnimation(orbitShow);
      cancelAnimation(write);
      cancelAnimation(sansShow);
      cancelAnimation(containerOpacity);
    };
    // One run, once started; the timeline never restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Leave once the minimum has played and the app is ready (or the cap passed).
  useEffect(() => {
    if (leaving.current || !minimumDone || !(ready || waitedLongEnough)) return;
    leaving.current = true;
    containerOpacity.value = withTiming(0, { duration: FADE_OUT_MS, easing: Easing.in(Easing.quad) }, (finished) => {
      if (finished) runOnJS(onFinish)();
    });
  }, [minimumDone, ready, waitedLongEnough, containerOpacity, onFinish]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: containerOpacity.value }));
  // First frame: scale 1, no offset, opaque on Android. Exactly the system splash.
  const markStyle = useAnimatedStyle(() => ({
    opacity: markShow.value,
    transform: [
      { translateY: lift * markMove.value },
      { scale: 1 - (1 - MARK_END_SCALE) * markMove.value },
    ],
  }));
  const orbitStyle = useAnimatedStyle(() => ({ opacity: orbitShow.value }));
  const sansProps = useAnimatedProps(() => ({ fillOpacity: sansShow.value }));

  return (
    <Animated.View
      style={[styles.container, { backgroundColor: themeColors.bg }, containerStyle]}
      pointerEvents="none"
      accessibilityRole="image"
      accessibilityLabel="Delegent AI loading"
    >
      {/* The apps, circling where the brain comes to rest. Behind the brain. */}
      <Animated.View
        style={[styles.orbit, { width: orbitSize, height: orbitSize, marginLeft: -orbitSize / 2, marginTop: lift - orbitSize / 2 }, orbitStyle]}
      >
        {orbitMounted ? <AppOrbit services={POPULAR_APPS} size={orbitSize} center={<View />} spinMs={ORBIT_SPIN_MS} /> : null}
      </Animated.View>

      {/* Dead centre and in flow, so the first frame lands exactly where the
          system splash drew the brain. It moves on from there; it never
          restarts (no fade or scale IN on Android). */}
      <Animated.View style={[styles.markWrap, markStyle]}>
        <Image source={systemMark} style={styles.systemMark} resizeMode="contain" fadeDuration={0} onLoad={begin}
          accessibilityIgnoresInvertColors />
      </Animated.View>

      {/* Absolutely positioned below the orbit, so writing the name never
          shifts the brain. */}
      <View style={[styles.belowMark, { marginTop: lift + orbitSize / 2 + WORDMARK_GAP }]} pointerEvents="none">
        <Svg
          width={wordmarkWidth}
          height={wordmarkHeight}
          viewBox={`0 0 ${SPLASH_SCRIPT_VIEWBOX.width} ${SPLASH_SCRIPT_VIEWBOX.height}`}
        >
          {SPLASH_SCRIPT_LETTERS.map((letter, index) => (
            <ScriptLetter key={`${letter.char}-${index}`} d={letter.d} length={letter.length} start={index * LETTER_STEP}
              write={write} ink={themeColors.textPrimary} />
          ))}
          {SPLASH_SANS_LETTERS.map((letter, index) => (
            <AnimatedPath key={`${letter.char}-${index}`} d={letter.d} fill={themeColors.textPrimary} animatedProps={sansProps} />
          ))}
        </Svg>
      </View>
    </Animated.View>
  );
}

/** One letter of "Delegent": its outline traced like a pen, then inked in. */
function ScriptLetter({ d, length, start, write, ink }: { d: string; length: number; start: number; write: SharedValue<number>; ink: string }) {
  const animatedProps = useAnimatedProps(() => {
    const local = Math.min(1, Math.max(0, write.value - start));
    return {
      strokeDashoffset: length * (1 - local),
      fillOpacity: Math.min(1, Math.max(0, (local - 0.6) / 0.4)),
      strokeOpacity: local > 0 ? 1 : 0,
    };
  });
  return (
    <AnimatedPath
      d={d}
      fill={ink}
      stroke={ink}
      strokeWidth={0.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={`${length} ${length}`}
      animatedProps={animatedProps}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    // The brain alone is in flow and centred. Everything else hangs off the
    // centre absolutely, so the brain sits exactly where the system splash left it.
    justifyContent: 'center',
    zIndex: 999,
    elevation: 12,
  },
  orbit: {
    position: 'absolute',
    top: '50%',
    left: '50%',
  },
  markWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  systemMark: {
    width: SYSTEM_MARK_DP,
    height: SYSTEM_MARK_DP,
  },
  belowMark: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});
