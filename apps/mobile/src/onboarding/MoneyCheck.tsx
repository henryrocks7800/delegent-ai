// The money check: the hook of the first-run journey (Alex, 2026-09-27: "find my
// money ... that's the biggest hook and we lose people here all the time").
//
// Thirty seconds of taps that show a person what their own inbox could be
// hiding, before we ask anything of them. It opens from a card on the sign-in
// screen (before any account exists) and is the first onboarding screen for
// anyone who has not done it. What they tick is carried through the rest of
// the journey (moneyIntent.ts).
//
// HONESTY RULES (the same as the adverts and the website):
//   - The only pound figures are the UK261 maximums per passenger (£220, £350
//     or £520 by distance), always "up to", with the conditions in the small
//     print. Refunds, double charges and subscriptions get no number, because
//     we cannot know theirs.
//   - The real example is the one inbox of September 2026, labelled as such:
//     the flight claim is lodged, not paid; the £54 really was refunded.
//   - Money Finder only reads and reports; nothing is sent, moved or changed
//     (the FAQ's own words, packages/shared/src/content/agentEngine.ts).
//
// OTA-safe like the rest of the journey (motion.tsx): core React Native views,
// Reanimated calls the shipped binaries already run, no new native module.

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Button, Text, useThemeColors } from '../design/primitives';
import { fontFamilies, radii, space } from '../design/tokens';
import { track } from '../analytics/analyticsClient';
import { Breathe, Pop, Rise, useTweenNumber } from './motion';
import { AmbientBackground } from '../design/Ambient';
import {
  FLIGHT_BANDS, flightUpTo, moneyDetail, otherFinds, pounds,
  type FlightBand, type MoneyIntent, type MoneyKind,
} from './moneyIntent';

const TILES: Array<{ kind: MoneyKind; emoji: string; title: string; detail: string }> = [
  { kind: 'flight', emoji: '✈️', title: 'A delayed or cancelled flight', detail: '3+ hours late, or cancelled at short notice' },
  { kind: 'double', emoji: '💳', title: 'Charged twice', detail: 'or charged in full for an upgrade' },
  { kind: 'refund', emoji: '⏳', title: 'A refund that never came', detail: 'promised, but never paid back' },
  { kind: 'subs', emoji: '🔁', title: 'Subscriptions you forgot', detail: 'still quietly paying for them' },
];

export type MoneyChoice = Omit<MoneyIntent, 'savedAt'>;

export function MoneyCheck({ initial, onDone, from, ctaLabel = 'Find my money' }: {
  initial?: MoneyIntent | null;
  /** Called with `wants: true` for "Find my money", `wants: false` for "Not now". */
  onDone: (choice: MoneyChoice) => void;
  /** Where it was opened, so the hook can be measured: 'signin' or 'onboarding'. */
  from: 'signin' | 'onboarding';
  ctaLabel?: string;
}) {
  const colors = useThemeColors();
  const [kinds, setKinds] = useState<MoneyKind[]>(initial?.kinds ?? []);
  const [band, setBand] = useState<FlightBand>(initial?.band ?? 'short');
  const [travellers, setTravellers] = useState(initial?.travellers ?? 1);
  const choice = { kinds, band, travellers };
  const upTo = flightUpTo(choice);
  const others = otherFinds(choice);
  const scroll = useRef<ScrollView>(null);
  const revealFlight = useRef(false);

  useEffect(() => { track('money_check_opened', { from }); }, [from]);

  const toggle = (kind: MoneyKind) => {
    const on = !kinds.includes(kind);
    if (on && kind === 'flight') revealFlight.current = true;
    setKinds(on ? [...kinds, kind] : kinds.filter((k) => k !== kind));
  };

  // A "+£220" floats up out of the total each time it grows.
  const [bump, setBump] = useState<{ id: number; amount: number } | null>(null);
  const lastUpTo = useRef(upTo);
  useEffect(() => {
    if (upTo > lastUpTo.current) setBump({ id: Date.now(), amount: upTo - lastUpTo.current });
    lastUpTo.current = upTo;
  }, [upTo]);

  const finish = (wants: boolean) => {
    track(wants ? 'money_check_completed' : 'money_check_skipped', {
      from, kinds: kinds.join(',') || 'none', flight_band: kinds.includes('flight') ? band : 'none', travellers, up_to: upTo,
    });
    onDone({ kinds, band, travellers, wants });
  };

  const meterFallback = kinds.length ? 'money back' : '£ ?';
  const meterSmall = upTo > 0
    ? `for your flight${travellers > 1 ? `, ${travellers} of you` : ''}${others.length === 1 ? `, plus ${others[0]}` : others.length > 1 ? `, plus ${others.length} more things to check` : ''}`
    : others.length === 1
    ? `${others[0].charAt(0).toUpperCase()}${others[0].slice(1)}`
    : others.length > 1
    ? `${others.length} things to check`
    : 'Tap anything that sounds familiar';

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AmbientBackground />
      <ScrollView ref={scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Rise>
          <View style={styles.topRow}>
            <Text variant="caption" color="accent">MONEY CHECK · 30 SECONDS</Text>
            <Pressable testID="moneyCheck.skip" accessibilityRole="button" accessibilityLabel="Not now" hitSlop={12} onPress={() => finish(false)}>
              <Text variant="bodySm" color="textSecondary">Not now</Text>
            </Pressable>
          </View>
        </Rise>
        <Rise delay={80}>
          <View style={{ gap: space[2] }}>
            <Text variant="displayLg">Could your inbox owe you money?</Text>
            <Text variant="body" color="textSecondary">Tap anything that has happened to you. It is often money people never knew they could claim.</Text>
          </View>
        </Rise>

        <View style={styles.grid}>
          {TILES.map((tile, index) => {
            const on = kinds.includes(tile.kind);
            return (
              <Rise key={tile.kind} delay={180 + index * 80} style={styles.tileWrap}>
                <Pressable
                  testID={`moneyCheck.${tile.kind}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${tile.title}, ${tile.detail}`}
                  onPress={() => toggle(tile.kind)}
                  style={[styles.tile, { backgroundColor: on ? colors.accentMuted : colors.surfaceHigh, borderColor: on ? colors.accent : colors.border }]}
                >
                  <Pop on={on} style={styles.tileEmojiWrap}>
                    <Text style={styles.tileEmoji}>{tile.emoji}</Text>
                  </Pop>
                  <Text variant="title">{tile.title}</Text>
                  <Text variant="bodySm" color="textSecondary">{tile.detail}</Text>
                  <View style={[styles.tick, { borderColor: on ? colors.accent : colors.borderStrong, backgroundColor: on ? colors.accent : colors.surfaceHigh }]}>
                    {on ? <Text style={[styles.tickMark, { color: colors.accentText }]}>✓</Text> : null}
                  </View>
                </Pressable>
              </Rise>
            );
          })}
        </View>

        {kinds.includes('flight') ? (
          // Measured on this plain wrapper, a direct child of the scroll content,
          // so its y is the distance to scroll to bring the card into view.
          <View onLayout={(event) => {
            if (!revealFlight.current) return;
            revealFlight.current = false;
            const y = event.nativeEvent.layout.y;
            setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, y - space[4]), animated: true }), 120);
          }}>
          <Rise distance={24}>
            <View style={[styles.card, { backgroundColor: colors.surfaceHigh, borderColor: colors.accent }]}>
              <Text variant="title">How far was the flight?</Text>
              <View style={{ gap: space[2], marginTop: space[3] }}>
                {(Object.keys(FLIGHT_BANDS) as FlightBand[]).map((key) => {
                  const on = band === key;
                  const b = FLIGHT_BANDS[key];
                  return (
                    <Pressable
                      key={key}
                      testID={`moneyCheck.band.${key}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${b.label}, for example ${b.examples}, up to ${b.pounds} pounds each`}
                      onPress={() => setBand(key)}
                      style={[styles.band, { borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accentMuted : colors.surfaceHigh }]}
                    >
                      <View style={[styles.radio, { borderColor: on ? colors.accent : colors.borderStrong }]}>
                        {on ? <View style={[styles.radioDot, { backgroundColor: colors.accent }]} /> : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="bodySm" color="textPrimary">{b.label}</Text>
                        <Text variant="bodySm" color="textSecondary">{`e.g. ${b.examples}`}</Text>
                      </View>
                      <Text variant="title" color={on ? 'accent' : 'textSecondary'}>{`${pounds(b.pounds)} each`}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.stepperRow}>
                <View style={{ flex: 1 }}>
                  <Text variant="title">How many of you?</Text>
                  <Text variant="bodySm" color="textSecondary">Everyone on the booking can claim.</Text>
                </View>
                <Pressable testID="moneyCheck.travellersLess" accessibilityRole="button" accessibilityLabel="One fewer traveller" hitSlop={6}
                  onPress={() => setTravellers((n) => Math.max(1, n - 1))} style={[styles.stepBtn, { borderColor: colors.borderStrong, backgroundColor: colors.surfaceHigh }]}>
                  <Text variant="title">−</Text>
                </Pressable>
                <Text variant="displayMd" style={styles.stepCount} accessibilityLabel={`${travellers} travellers`}>{travellers}</Text>
                <Pressable testID="moneyCheck.travellersMore" accessibilityRole="button" accessibilityLabel="One more traveller" hitSlop={6}
                  onPress={() => setTravellers((n) => Math.min(9, n + 1))} style={[styles.stepBtn, { borderColor: colors.accent, backgroundColor: colors.accentMuted }]}>
                  <Text variant="title" color="accent">+</Text>
                </Pressable>
              </View>
              <Text variant="bodySm" color="textSecondary" style={{ marginTop: space[3] }}>Claims can go back up to six years.</Text>
            </View>
          </Rise>
          </View>
        ) : null}

        <Rise delay={560}>
          <View style={[styles.proof, { borderColor: colors.border, backgroundColor: colors.surfaceHigh }]}>
            <Text variant="caption" color="textSecondary">OUR FIRST TEST</Text>
            <Text variant="body">One inbox turned up a cancelled flight worth up to £440, and £54 of double charges, refunded the same day.</Text>
            <Text variant="bodySm" color="textTertiary">
              September 2026. The flight claim is lodged, not yet paid. Results vary. Flight amounts are the UK maximum per passenger for a delay of 3+ hours or a short-notice cancellation, and airlines can refuse for things like bad weather.
            </Text>
          </View>
        </Rise>
      </ScrollView>

      {/* The meter and the button stay in view, so every tap shows its effect. */}
      <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: 'rgba(250, 250, 247, 0.94)' }]}>
        <View style={[styles.meter, { backgroundColor: colors.accent }]} accessibilityLiveRegion="polite" testID="moneyCheck.meter">
          <Text variant="caption" style={styles.meterCaption}>YOUR INBOX COULD BE HIDING</Text>
          <View style={styles.meterRow}>
            <MeterFigure upTo={upTo} fallback={meterFallback} color={colors.accentText} />
            {bump ? <FloatUp key={bump.id} text={`+${pounds(bump.amount)}`} color={colors.accentText} /> : null}
          </View>
          <Text variant="bodySm" style={styles.meterSmall} numberOfLines={1}>{meterSmall}</Text>
        </View>
        <Breathe active={kinds.length > 0} min={0.985} max={1.02} period={2200}>
          <Button testID="moneyCheck.find" variant="primary" size="lg" fullWidth onPress={() => finish(true)}>{ctaLabel}</Button>
        </Breathe>
        <Text variant="caption" color="textTertiary" align="center">It only reads and reports. Nothing is sent, moved or changed.</Text>
      </View>
    </View>
  );
}

/**
 * The big figure, counting as it changes. Its own component so only this line
 * re-renders on each frame of the count, not the whole screen.
 */
function MeterFigure({ upTo, fallback, color }: { upTo: number; fallback: string; color: string }) {
  const shown = useTweenNumber(upTo);
  return <Text style={[styles.meterBig, { color }]}>{upTo > 0 ? `up to ${pounds(shown)}` : fallback}</Text>;
}

function FloatUp({ text, color }: { text: string; color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withSequence(withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }), withTiming(2, { duration: 350 }));
  }, [t]);
  const style = useAnimatedStyle(() => ({
    opacity: t.value <= 1 ? Math.min(1, t.value * 3) : 2 - t.value,
    transform: [{ translateY: -30 * Math.min(1, t.value) }],
  }));
  return (
    <Animated.View style={[styles.float, style]} pointerEvents="none">
      <Text variant="title" style={{ color }}>{text}</Text>
    </Animated.View>
  );
}

/**
 * The way in, on the sign-in screen. Before the check it asks the question;
 * after it, it shows what they asked us to look for.
 */
export function MoneyHookCard({ intent, onPress }: { intent: MoneyIntent | null; onPress: () => void }) {
  const colors = useThemeColors();
  const done = Boolean(intent?.wants);
  const upTo = intent ? flightUpTo(intent) : 0;
  return (
    <Breathe active={!done} min={0.99} max={1.015} period={2600}>
      <Pressable
        testID="login.moneyCheck"
        accessibilityRole="button"
        accessibilityLabel={done ? 'Your money check. Tap to change it' : 'Could your inbox owe you money? Check in 30 seconds'}
        onPress={onPress}
        style={[styles.hook, { backgroundColor: colors.accentMuted, borderColor: colors.accent }]}
      >
        <View style={[styles.hookCoin, { backgroundColor: colors.accent }]}>
          <Text style={[styles.hookCoinText, { color: colors.accentText }]}>{done ? '✓' : '£'}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title">{done ? (upTo ? `Up to ${pounds(upTo)} to look for` : 'Your money check is ready') : 'Could your inbox owe you money?'}</Text>
          <Text variant="bodySm" color="textSecondary">{done ? 'Sign in below, connect your email, and your report comes in about 15 minutes.' : 'Check in 30 seconds. No sign-in needed.'}</Text>
        </View>
        <Text variant="title" color="accent">{done ? 'Edit' : '›'}</Text>
      </Pressable>
    </Breathe>
  );
}

/** A one-line reminder of the money check, where the next step serves it. */
export function MoneyNudge({ text, testID }: { text: string; testID?: string }) {
  const colors = useThemeColors();
  return (
    <View testID={testID} style={[styles.nudge, { backgroundColor: colors.accentMuted, borderColor: colors.accent }]}>
      <View style={[styles.nudgeCoin, { backgroundColor: colors.accent }]}>
        <Text style={[styles.nudgeCoinText, { color: colors.accentText }]}>£</Text>
      </View>
      <Text variant="bodySm" color="textPrimary" style={{ flex: 1 }}>{text}</Text>
    </View>
  );
}

/** The thread, later in the journey: what they asked us to look for. */
export function MoneyPlanCard({ intent, title, footnote, testID }: { intent: MoneyIntent; title: string; footnote?: string; testID?: string }) {
  const colors = useThemeColors();
  const upTo = flightUpTo(intent);
  return (
    <View testID={testID} style={[styles.planCard, { backgroundColor: colors.accentMuted, borderColor: colors.accent }]}>
      <View style={styles.planRow}>
        <View style={[styles.hookCoin, { backgroundColor: colors.accent }]}>
          <Text style={[styles.hookCoinText, { color: colors.accentText }]}>£</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" color="accent">{title}</Text>
          <Text variant="title">{upTo ? `Find up to ${pounds(upTo)}` : 'Find money you might be owed'}</Text>
        </View>
      </View>
      <Text variant="bodySm" color="textSecondary">{moneyDetail(intent)}</Text>
      {footnote ? <Text variant="caption" color="textTertiary">{footnote}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: space[5], gap: space[5], paddingBottom: space[6] },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space[3] },
  tileWrap: { width: '48.5%' },
  tile: { borderWidth: 1.5, borderRadius: radii.xl, padding: space[4], gap: 4, minHeight: 168 },
  tileEmojiWrap: { alignSelf: 'flex-start', marginBottom: space[1] },
  tileEmoji: { fontSize: 28, lineHeight: 36 },
  tick: { position: 'absolute', top: space[3], right: space[3], width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tickMark: { fontSize: 14, lineHeight: 16, fontFamily: fontFamilies.geistSemiBold },
  card: { borderWidth: 1.5, borderRadius: radii.xl, padding: space[4] },
  band: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.lg, paddingVertical: space[3], paddingHorizontal: space[3] },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginTop: space[4] },
  stepBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepCount: { minWidth: 28, textAlign: 'center' },
  proof: { borderWidth: 1, borderRadius: radii.xl, padding: space[4], gap: space[2] },
  footer: { paddingHorizontal: space[5], paddingTop: space[3], paddingBottom: space[3], gap: space[2], borderTopWidth: 1 },
  meter: { borderRadius: radii.xl, paddingHorizontal: space[4], paddingVertical: space[3] },
  meterCaption: { color: 'rgba(250,250,247,0.72)' },
  meterRow: { flexDirection: 'row', alignItems: 'flex-end' },
  meterBig: { fontFamily: fontFamilies.instrumentSerifItalic, fontSize: 42, lineHeight: 48 },
  meterSmall: { color: 'rgba(250,250,247,0.88)' },
  float: { position: 'absolute', right: 0, bottom: 6 },
  hook: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1.5, borderRadius: radii.xl, paddingVertical: space[3], paddingHorizontal: space[4] },
  hookCoin: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  hookCoinText: { fontFamily: fontFamilies.instrumentSerifItalic, fontSize: 24, lineHeight: 28 },
  planCard: { borderWidth: 1.5, borderRadius: radii.xl, padding: space[4], gap: space[2] },
  nudge: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.lg, paddingVertical: space[3], paddingHorizontal: space[3] },
  nudgeCoin: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  nudgeCoinText: { fontFamily: fontFamilies.instrumentSerifItalic, fontSize: 18, lineHeight: 22 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
});
