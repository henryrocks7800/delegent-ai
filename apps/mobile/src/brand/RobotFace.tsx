import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useThemeColors } from '../design/primitives';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

type RobotFaceProps = {
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** Run a one-time fade-in + scale entry animation on mount. Default true. */
  entryAnimation?: boolean;
};

export function RobotFace({ size = 132, style, entryAnimation = true }: RobotFaceProps) {
  const themeColors = useThemeColors();

  const bob = useSharedValue(0);
  const blink = useSharedValue(1);
  const pulse = useSharedValue(0.55);
  const entry = useSharedValue(entryAnimation ? 0 : 1);

  useEffect(() => {
    if (entryAnimation) {
      entry.value = withTiming(1, { duration: 540, easing: Easing.out(Easing.cubic) });
    }
  }, [entry, entryAnimation]);

  useEffect(() => {
    bob.value = withRepeat(
      withSequence(
        withTiming(-3, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      true,
    );

    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }),
        withTiming(0.55, { duration: 900, easing: Easing.in(Easing.quad) }),
      ),
      -1,
      true,
    );

    const startBlink = () => {
      blink.value = withSequence(
        withTiming(0.08, { duration: 90, easing: Easing.in(Easing.quad) }),
        withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) }),
        withDelay(
          2400,
          withSequence(
            withTiming(0.08, { duration: 90, easing: Easing.in(Easing.quad) }),
            withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) }),
          ),
        ),
      );
    };
    startBlink();
    const id = setInterval(startBlink, 5200);

    return () => {
      clearInterval(id);
      cancelAnimation(bob);
      cancelAnimation(pulse);
      cancelAnimation(blink);
    };
  }, [bob, blink, pulse]);

  const headProps = useAnimatedProps(() => ({
    transform: [{ translateY: bob.value }],
  }));

  const eyeProps = useAnimatedProps(() => ({
    // squash on Y to fake a blink without changing geometry
    transform: [{ scaleY: blink.value }],
  }));

  const antennaPulseProps = useAnimatedProps(() => ({
    opacity: pulse.value,
    r: 3 + (pulse.value - 0.55) * 4,
  }));

  const entryStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [
      { translateY: (1 - entry.value) * 8 },
      { scale: 0.88 + entry.value * 0.12 },
    ],
  }));

  // Coordinates centered around 100,110 within a 200x200 viewBox.
  return (
    <Animated.View style={[{ width: size, height: size }, entryStyle, style]} pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 200 200" fill="none">
        {/* Antenna stem + tip */}
        <Line
          x1={100}
          y1={42}
          x2={100}
          y2={62}
          stroke={themeColors.borderStrong}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <AnimatedCircle
          animatedProps={antennaPulseProps}
          cx={100}
          cy={40}
          fill={themeColors.accent}
        />

        {/* Head + face */}
        <AnimatedG animatedProps={headProps}>
          {/* Head plate */}
          <Rect
            x={42}
            y={62}
            width={116}
            height={92}
            rx={22}
            ry={22}
            fill={themeColors.surfaceHigh}
            stroke={themeColors.borderStrong}
            strokeWidth={1.5}
          />

          {/* Inner visor (subtle inset) */}
          <Rect
            x={54}
            y={82}
            width={92}
            height={48}
            rx={14}
            ry={14}
            fill={themeColors.bg}
            stroke={themeColors.border}
            strokeWidth={1}
          />

          {/* Eyes, animated blink via scaleY */}
          <AnimatedG animatedProps={eyeProps} originX={100} originY={106}>
            <Circle cx={80} cy={106} r={6.5} fill={themeColors.accent} />
            <Circle cx={120} cy={106} r={6.5} fill={themeColors.accent} />
          </AnimatedG>

          {/* Mouth, single calm line */}
          <Path
            d="M 86 138 Q 100 144 114 138"
            stroke={themeColors.textTertiary}
            strokeWidth={1.5}
            strokeLinecap="round"
            fill="none"
          />

          {/* Side ears */}
          <Rect
            x={36}
            y={96}
            width={6}
            height={26}
            rx={3}
            ry={3}
            fill={themeColors.borderStrong}
          />
          <Rect
            x={158}
            y={96}
            width={6}
            height={26}
            rx={3}
            ry={3}
            fill={themeColors.borderStrong}
          />
        </AnimatedG>
      </Svg>
    </Animated.View>
  );
}
