import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useReducedMotion } from '../onboarding/motion';

// Pearl (Alex's pick of five, 2026-09-28): a near-neutral light, the faintest
// cool grey in one corner and a breath of warmth in the other.
const PALETTE = {
  top: '#F9F9F7',
  bottom: '#F1F1EE',
  glowA: '#E2E6E3',
  glowAOpacity: 0.4,
  glowB: '#EFE6DF',
  glowBOpacity: 0.26,
  glowLow: '#E5E7E5',
  glowLowOpacity: 0.22,
};

/**
 * The size a layer was actually laid out at. The gradients below are drawn at
 * explicit sizes and redrawn (by key) whenever that changes. Given
 * `width="100%"` instead, an Svg kept the size of its first layout: the menu
 * opens in two steps on Android (inside the system bars, then full screen), and
 * its light stopped about 80dp short of the bottom, in visible bands. Inside a
 * padded card it measured the content box and filled only the inner rectangle.
 */
function useLayoutSize(): [{ width: number; height: number }, (event: LayoutChangeEvent) => void] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    const height = Math.round(event.nativeEvent.layout.height);
    setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
  }, []);
  return [size, onLayout];
}

/**
 * The light the whole app sits in (2026-09-27 redesign): a warm paper canvas
 * with a soft sage glow in one top corner and an apricot one in the other.
 *
 * It is painted ONCE, behind the header and the chat together. The chat's
 * WebView is transparent inside the app (html.in-app in the chat document),
 * so the header and the conversation read as one surface rather than a card
 * set into a page. react-native-svg is in every shipped binary, so this is
 * OTA-safe.
 *
 * The light settles into place when a screen opens and then stays still. A
 * version that drifted forever was tried first and dropped the same evening:
 * a transform animated every frame keeps Android posting accessibility
 * "content changed" events, so UiAutomator (and with it Maestro) could never
 * find the screen idle, and a chat that stays open would have spent battery
 * redrawing a full-screen layer for nothing.
 */
export function AmbientBackground({ style, intensity = 1 }: { style?: StyleProp<ViewStyle>; intensity?: number }) {
  const reduced = useReducedMotion();
  const settle = useSharedValue(0);
  const [size, onLayout] = useLayoutSize();

  useEffect(() => {
    if (reduced) {
      settle.value = 1;
      return;
    }
    settle.value = withTiming(1, { duration: 1800, easing: Easing.out(Easing.cubic) });
  }, [settle, reduced]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + settle.value * 0.65,
    transform: [
      { translateY: -18 + settle.value * 18 },
      { scale: 1.08 - settle.value * 0.08 },
    ],
  }));

  const { width, height } = size;
  const palette = PALETTE;
  // The glow layer overhangs every edge, so the settle never shows its rim.
  const glowWidth = width + GLOW_OVERHANG * 2;
  const glowHeight = height + GLOW_OVERHANG * 2;

  return (
    <View pointerEvents="none" onLayout={onLayout} style={[StyleSheet.absoluteFill, styles.base, style]}>
      {width > 0 && height > 0 ? (
        <>
          <Svg key={`paper-${width}x${height}`} width={width} height={height} style={styles.fill}>
            <Defs>
              <LinearGradient id="ambientPaper" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={palette.top} />
                <Stop offset="1" stopColor={palette.bottom} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={width} height={height} fill="url(#ambientPaper)" />
          </Svg>
          <Animated.View style={[styles.glowLayer, { width: glowWidth, height: glowHeight }, glowStyle]}>
            <Svg key={`glow-${glowWidth}x${glowHeight}`} width={glowWidth} height={glowHeight}>
              <Defs>
                <RadialGradient id="ambientSage" cx="12%" cy="4%" rx="78%" ry="42%" fx="12%" fy="4%">
                  <Stop offset="0" stopColor={palette.glowA} stopOpacity={palette.glowAOpacity * intensity} />
                  <Stop offset="0.55" stopColor={palette.glowA} stopOpacity={palette.glowAOpacity * 0.35 * intensity} />
                  <Stop offset="1" stopColor="#FAFAF7" stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id="ambientApricot" cx="96%" cy="10%" rx="70%" ry="36%" fx="96%" fy="10%">
                  <Stop offset="0" stopColor={palette.glowB} stopOpacity={palette.glowBOpacity * intensity} />
                  <Stop offset="0.6" stopColor={palette.glowB} stopOpacity={palette.glowBOpacity * 0.3 * intensity} />
                  <Stop offset="1" stopColor="#FAFAF7" stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id="ambientLow" cx="92%" cy="98%" rx="80%" ry="40%" fx="92%" fy="98%">
                  <Stop offset="0" stopColor={palette.glowLow} stopOpacity={palette.glowLowOpacity * intensity} />
                  <Stop offset="1" stopColor="#FAFAF7" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Rect x="0" y="0" width={glowWidth} height={glowHeight} fill="url(#ambientSage)" />
              <Rect x="0" y="0" width={glowWidth} height={glowHeight} fill="url(#ambientApricot)" />
              <Rect x="0" y="0" width={glowWidth} height={glowHeight} fill="url(#ambientLow)" />
            </Svg>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

/**
 * A soft pastel wash (peach, sky, lavender) for the header card of a guide
 * page, so the page opens with a little colour instead of a block of text
 * (Alex, 2026-09-28: "inject some colour"). Fills its parent; the parent clips
 * it to its corners with `overflow: 'hidden'`.
 */
export function PastelWash({ id = 'pastelWash' }: { id?: string }) {
  const [{ width, height }, onLayout] = useLayoutSize();
  return (
    <View pointerEvents="none" onLayout={onLayout} style={StyleSheet.absoluteFill}>
      {width > 0 && height > 0 ? (
        <Svg key={`${width}x${height}`} width={width} height={height}>
          <Defs>
            <LinearGradient id={`${id}Base`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FDEBD8" stopOpacity={0.95} />
              <Stop offset="0.5" stopColor="#E7F0FB" stopOpacity={0.9} />
              <Stop offset="1" stopColor="#EFE7FA" stopOpacity={0.95} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={height} fill={`url(#${id}Base)`} />
        </Svg>
      ) : null}
    </View>
  );
}

const GLOW_OVERHANG = 40;

const styles = StyleSheet.create({
  base: {
    backgroundColor: PALETTE.top,
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  glowLayer: {
    position: 'absolute',
    top: -GLOW_OVERHANG,
    left: -GLOW_OVERHANG,
  },
});
