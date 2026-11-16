// Motion for the first-run journey (sign-in, apps, summary, name, plan), in the
// style of the website redesign of 2026-09-26: things rise into place, the
// brain glows, the apps you pick orbit it, and your coworker greets you by name
// as you type it.
//
// OTA-SAFE ON PURPOSE. Everything here uses only the Reanimated calls that the
// shipped binaries already run in production (useSharedValue, useAnimatedStyle,
// withTiming, withDelay, withRepeat, withSequence, withSpring, Easing: see
// src/design/primitives.tsx and src/brand/SplashScreen.tsx) and react-native-svg
// via BrandMarkGlyph. No layout animations, no new native module, so this ships
// over the air to runtime 2.7.0 without the native-module crash of 2026-08.
//
// Reduced motion (the OS accessibility setting) gets the finished state at once.

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { CONNECTABLE_SERVICES, type ConnectableService } from '@sidekick/shared';
import { BrandMarkGlyph } from '../connections/ConnectionIdentity';
import { Text, useThemeColors } from '../design/primitives';

/**
 * The apps people connect first, used for the sign-in orbit and for the summary
 * orbit when someone has not chosen any. Kept here rather than in App.tsx, whose
 * source is held free of these names by auth-readiness.test.mjs.
 */
export const POPULAR_APP_IDS = [
  'gmail', 'google_calendar', 'google_drive', 'dropbox', 'slack', 'notion', 'google_sheets', 'hubspot',
  'stripe', 'shopify', 'trello', 'asana', 'quickbooks', 'github', 'linkedin', 'youtube',
] as const;
export const POPULAR_APPS: readonly ConnectableService[] = CONNECTABLE_SERVICES.filter((service) =>
  (POPULAR_APP_IDS as readonly string[]).includes(service.id));

/**
 * What the sign-in ribbon suggests. Only jobs done in YOUR apps (inbox,
 * calendar, Money Finder, inbox sorting), never something any chatbot could
 * answer (Alex, 2026-09-27: "stuff that we're specific about"). Each one works
 * for every account: sorting and filing into folders went to everyone the
 * same day (INBOX_SORT_USER_IDS "*").
 */
export const FIRST_RUN_ASKS = [
  'Find money I might be owed',
  'Sort my inbox',
  'Reply to Sarah’s email for me',
  'What’s in my calendar tomorrow?',
  'File my emails into folders',
  'Which subscriptions am I paying for?',
  'Summarise my unread emails',
  'Find the invoice BT sent me',
] as const;

/** The OS "reduce motion" setting, read once and kept up to date. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduced(value); }).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; sub.remove(); };
  }, []);
  return reduced;
}

/** Rises into place (up and into focus) after `delay` ms, once, when it mounts. */
export function Rise({ children, delay = 0, distance = 18, style, testID }: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) { t.value = 1; return; }
    t.value = withDelay(delay, withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [delay, reduced, t]);
  const animated = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: (1 - t.value) * distance }, { scale: 0.985 + t.value * 0.015 }],
  }));
  return <Animated.View testID={testID} style={[style, animated]}>{children}</Animated.View>;
}

/** A spring "pop" whenever `on` flips to true (checkboxes, selected apps). */
export function Pop({ on, children, style }: { on: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useSharedValue(1);
  useEffect(() => {
    if (on) s.value = withSequence(withTiming(0.82, { duration: 90 }), withSpring(1, { damping: 7, stiffness: 260 }));
  }, [on, s]);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/** A slow breathing glow, for the brain and for a button that is ready to press. */
export function Breathe({ children, style, min = 0.94, max = 1.06, period = 3200, active = true }: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  min?: number;
  max?: number;
  period?: number;
  active?: boolean;
}) {
  const reduced = useReducedMotion();
  const s = useSharedValue(1);
  useEffect(() => {
    if (!active || reduced) { cancelAnimation(s); s.value = withTiming(1, { duration: 200 }); return; }
    s.value = withRepeat(withSequence(
      withTiming(max, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
      withTiming(min, { duration: period / 2, easing: Easing.inOut(Easing.sin) }),
    ), -1, true);
    return () => cancelAnimation(s);
  }, [active, reduced, s, min, max, period]);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/** Three segments that fill as you move through the steps. */
export function StepProgress({ step, total = 3 }: { step: number; total?: number }) {
  const colors = useThemeColors();
  return (
    <View style={styles.progressRow} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: total, now: step }}>
      {Array.from({ length: total }, (_, i) => <ProgressSegment key={i} filled={i < step} delay={i * 120} track={colors.border} fill={colors.accent} />)}
    </View>
  );
}

function ProgressSegment({ filled, delay, track, fill }: { filled: boolean; delay: number; track: string; fill: string }) {
  const w = useSharedValue(0);
  useEffect(() => {
    w.value = withDelay(delay, withTiming(filled ? 1 : 0, { duration: 650, easing: Easing.out(Easing.cubic) }));
  }, [filled, delay, w]);
  const animated = useAnimatedStyle(() => ({ width: `${w.value * 100}%` }));
  return (
    <View style={[styles.segment, { backgroundColor: track }]}>
      <Animated.View style={[styles.segmentFill, { backgroundColor: fill }, animated]} />
    </View>
  );
}

const coworkerMark = require('../../assets/coworker-ai-mark.png');

/**
 * The brain, with the apps orbiting it. Used on the sign-in screen (a sample
 * of every app) and on the summary step (the apps this person picked), so the
 * picture they see is the one they built.
 */
export function AppOrbit({ services, size = 240, showBrainGlow = true, center, highlight, spinMs = 60000 }: {
  services: readonly ConnectableService[];
  size?: number;
  showBrainGlow?: boolean;
  /** One full turn of the rings, in ms. Slow by default; the splash spins faster. */
  spinMs?: number;
  /** Replaces the built-in brain disc, e.g. the sign-in screen's own pinned logo Image. */
  center?: ReactNode;
  /** When given, these apps are drawn solid and every other app faded (the summary: "yours, and more"). */
  highlight?: ReadonlySet<string>;
}) {
  const colors = useThemeColors();
  const reduced = useReducedMotion();
  // Apps with no brand mark (Outlook, Teams) still take a place, as a lettered tile.
  const list = useMemo(() => services.slice(0, 16), [services]);
  const inner = list.slice(0, 6);
  const outer = list.slice(6, 16);
  const spin = useSharedValue(0);
  const arrive = useSharedValue(0);
  useEffect(() => {
    if (reduced) { arrive.value = 1; return; }
    arrive.value = withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) });
    spin.value = withRepeat(withTiming(1, { duration: spinMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(spin);
  }, [reduced, spin, arrive, spinMs]);
  const ringA = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }, { scale: 0.6 + arrive.value * 0.4 }], opacity: arrive.value }));
  const ringB = useAnimatedStyle(() => ({ transform: [{ rotate: `${-spin.value * 360 * 0.7}deg` }, { scale: 0.5 + arrive.value * 0.5 }], opacity: arrive.value }));
  const uprightA = useAnimatedStyle(() => ({ transform: [{ rotate: `${-spin.value * 360}deg` }] }));
  const uprightB = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360 * 0.7}deg` }] }));
  const brain = size * 0.36;
  const tile = Math.max(28, Math.round(size * 0.13));

  const ring = (items: readonly ConnectableService[], radius: number, upright: typeof uprightA) => items.map((service, i) => {
    const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
    const picked = highlight?.has(service.id) ?? false;
    const faded = Boolean(highlight) && !picked;
    return (
      <View key={service.id} style={{ position: 'absolute', left: size / 2 + radius * Math.cos(angle) - tile / 2, top: size / 2 + radius * Math.sin(angle) - tile / 2, opacity: faded ? 0.38 : 1 }}>
        <Animated.View style={[styles.tile, {
          width: tile, height: tile, borderRadius: tile * 0.3, backgroundColor: colors.surfaceHigh,
          borderColor: picked ? colors.accent : colors.border, borderWidth: picked ? 1.5 : 1,
        }, upright]}>
          {service.brandMark
            ? <BrandMarkGlyph mark={service.brandMark} size={Math.round(tile * 0.52)} />
            : <Text variant="title" color="textPrimary">{service.name.slice(0, 1)}</Text>}
        </Animated.View>
      </View>
    );
  });

  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <View style={[styles.ringLine, { width: size * 0.9, height: size * 0.9, borderRadius: size, borderColor: colors.border }]} />
      </View>
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <View style={[styles.ringLine, { width: size * 0.56, height: size * 0.56, borderRadius: size, borderColor: colors.border }]} />
      </View>
      {showBrainGlow ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Breathe min={0.9} max={1.12} period={3600}>
            <View style={{ width: brain * 1.9, height: brain * 1.9, borderRadius: brain, backgroundColor: colors.accentMuted, opacity: 0.9 }} />
          </Breathe>
        </View>
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        {center ?? (
          <View style={[styles.brainDisc, { width: brain * 1.18, height: brain * 1.18, borderRadius: brain, backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}>
            <Image source={coworkerMark} style={{ width: brain * 0.86, height: brain * 0.86 }} resizeMode="contain" />
          </View>
        )}
      </View>
      <Animated.View style={[StyleSheet.absoluteFill, ringA]}>{ring(inner, size * 0.28, uprightA)}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, ringB]}>{ring(outer, size * 0.45, uprightB)}</Animated.View>
    </View>
  );
}

/**
 * Example requests drifting across the screen, the app's version of the
 * website's "just ask" ribbon. Every one is a job the app does today.
 */
export function AskTicker({ items }: { items: readonly string[] }) {
  const colors = useThemeColors();
  const reduced = useReducedMotion();
  const [rowWidth, setRowWidth] = useState(0);
  const x = useSharedValue(0);
  useEffect(() => {
    if (reduced || rowWidth <= 0) return;
    x.value = 0;
    x.value = withRepeat(withTiming(-rowWidth, { duration: rowWidth * 28, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(x);
  }, [reduced, rowWidth, x]);
  const animated = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const row = (copy: string) => (
    <View style={styles.tickerRow} onLayout={copy === 'a' ? (e) => setRowWidth(e.nativeEvent.layout.width) : undefined}>
      {items.map((item) => (
        <View key={`${copy}-${item}`} style={[styles.tickerChip, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}>
          <Text variant="bodySm" color="textSecondary">{`“${item}”`}</Text>
        </View>
      ))}
    </View>
  );
  return (
    <View style={styles.tickerClip} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.tickerTrack, animated]}>
        {row('a')}
        {row('b')}
      </Animated.View>
    </View>
  );
}

/**
 * A number that counts its way to `target` (the money meter) instead of
 * jumping. Plain JS frames, no native animation, so it is OTA-safe.
 */
export function useTweenNumber(target: number, durationMs = 700): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const start = current.current;
    if (reduced || start === target) { current.current = target; setValue(target); return; }
    const began = Date.now();
    let frame = 0;
    const step = () => {
      const k = Math.min(1, (Date.now() - began) / durationMs);
      const next = start + (target - start) * (1 - Math.pow(1 - k, 3));
      current.current = next;
      setValue(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduced]);
  return value;
}

/** Types `text` out once, then follows it live as it changes (the name preview). */
export function useTypeOn(text: string, perCharMs = 32, startDelayMs = 300): string {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? text : '');
  const [intro, setIntro] = useState(!reduced);
  // Types whatever the text is by then, so a line that settles a moment after
  // mounting (the money check, read off the device) is typed, not swapped in.
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!intro) { setShown(text); return; }
    let i = 0;
    let timer: ReturnType<typeof setTimeout> = setTimeout(function tick() {
      i += 1;
      setShown(latest.current.slice(0, i));
      if (i < latest.current.length) timer = setTimeout(tick, perCharMs);
      else setIntro(false);
    }, startDelayMs);
    return () => clearTimeout(timer);
    // Only the first render types; after that the text simply follows edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro ? 'intro' : text]);
  return shown;
}

const styles = StyleSheet.create({
  progressRow: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 4, borderRadius: 4, overflow: 'hidden' },
  segmentFill: { height: '100%', borderRadius: 4 },
  center: { alignItems: 'center', justifyContent: 'center' },
  ringLine: { borderWidth: 1, position: 'absolute' },
  brainDisc: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tickerClip: { overflow: 'hidden', width: '100%' },
  tickerTrack: { flexDirection: 'row' },
  tickerRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  tickerChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
});
