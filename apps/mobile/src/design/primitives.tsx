import React, { useEffect } from 'react';
import {
  Pressable as RNPressable,
  Text as RNText,
  View,
  type PressableProps as RNPressableProps,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, colorThemes, fontFamilies, fonts, motion, radii, shadow, space, textStyle, type ColorToken, type RadiusToken, type SpaceToken, type ThemeColors, type ThemeName, type TypeToken } from './tokens';

const ThemeContext = React.createContext<{ name: ThemeName; colors: ThemeColors }>({ name: 'light', colors });

export function ThemeProvider({ theme, children }: { theme: ThemeName; children: React.ReactNode }) {
  return <ThemeContext.Provider value={{ name: theme, colors: colorThemes[theme] }}>{children}</ThemeContext.Provider>;
}

export function useThemeColors() {
  return React.useContext(ThemeContext).colors;
}

export function useThemeName() {
  return React.useContext(ThemeContext).name;
}

type AppTextProps = RNTextProps & {
  variant?: TypeToken;
  color?: ColorToken;
  align?: TextStyle['textAlign'];
  tabular?: boolean;
};

export function Text({ variant = 'body', color = 'textPrimary', align, tabular, style, ...props }: AppTextProps) {
  const themeColors = useThemeColors();
  return (
    <RNText
      {...props}
      style={[
        textStyle(variant),
        { color: themeColors[color], textAlign: align },
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
    />
  );
}

type StackProps = ViewProps & {
  direction?: 'vertical' | 'horizontal';
  gap?: SpaceToken;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  wrap?: boolean;
};

export function Stack({ direction = 'vertical', gap = 0, align, justify, wrap, style, ...props }: StackProps) {
  return (
    <View
      {...props}
      style={[
        {
          flexDirection: direction === 'horizontal' ? 'row' : 'column',
          gap: space[gap],
          alignItems: align,
          justifyContent: justify,
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    />
  );
}

type SurfaceProps = ViewProps & {
  elevation?: 'bg' | 'surface' | 'surfaceHigh';
  radius?: RadiusToken;
  border?: boolean | 'strong';
  padding?: SpaceToken;
};

// A raised surface is frosted glass over the ambient light: translucent white,
// a white hairline, no shadow. Alex found shadowed white cards too
// contrasty against the background (2026-09-28, "Pearl").
const LIFTED_EDGE = 'rgba(28, 26, 21, 0.06)';
const GLASS_FILL = 'rgba(255, 255, 255, 0.4)';
const GLASS_EDGE = 'rgba(255, 255, 255, 0.6)';

export function Surface({ elevation = 'surface', radius = 'lg', border = false, padding, style, ...props }: SurfaceProps) {
  const themeColors = useThemeColors();
  const lifted = elevation === 'surfaceHigh';
  return (
    <View
      {...props}
      style={[
        {
          backgroundColor: lifted ? GLASS_FILL : themeColors[elevation],
          borderRadius: radii[radius],
          borderWidth: border ? 1 : 0,
          borderColor: border === 'strong' ? themeColors.borderStrong : lifted ? GLASS_EDGE : themeColors.border,
          padding: padding === undefined ? undefined : space[padding],
        },
        style,
      ]}
    />
  );
}

type PressableProps = Omit<RNPressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

export function Pressable({ style, disabled, children, ...props }: PressableProps) {
  const pressed = useSharedValue(0);

  // Pressed things sink a little and spring back, rather than just dimming.
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: disabled ? 0.6 : 1 - Math.min(1, Math.max(0, pressed.value)) * 0.14,
    transform: [{ scale: 1 - pressed.value * 0.03 }],
  }));

  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      style={[style as never, animatedStyle]}
      onPressIn={(event) => {
        pressed.value = withSpring(1, motion.press);
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, motion.press);
        props.onPressOut?.(event);
      }}
    >
      {children}
    </AnimatedPressable>
  );
}

type ButtonProps = Omit<PressableProps, 'children'> & {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
};

export function Button({ children, variant = 'secondary', size = 'md', fullWidth, style, disabled, accessibilityRole = 'button', ...props }: ButtonProps) {
  const themeColors = useThemeColors();
  const height = size === 'sm' ? 36 : size === 'lg' ? 54 : 48;
  const horizontal = size === 'sm' ? space[3] : space[5];
  const isPrimary = variant === 'primary';
  const isGhost = variant === 'ghost';
  const isDanger = variant === 'danger';
  // A disabled button is a quiet grey pill with grey words, whatever its
  // variant: faded sage with pale text was hard to read at all.
  const color: ColorToken = disabled ? 'textTertiary' : isPrimary ? 'accentText' : isGhost ? 'textSecondary' : isDanger ? 'danger' : 'textPrimary';
  const fill = disabled
    ? isGhost ? 'transparent' : 'rgba(28, 26, 21, 0.07)'
    : isPrimary ? themeColors.accent : isGhost ? 'transparent' : isDanger ? `${themeColors.danger}12` : 'rgba(255, 255, 255, 0.6)';

  return (
    <Pressable
      {...props}
      accessibilityRole={accessibilityRole}
      disabled={disabled}
      style={[
        {
          minHeight: height,
          paddingHorizontal: horizontal,
          borderRadius: radii.full,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          backgroundColor: fill,
          borderWidth: isGhost || isPrimary ? 0 : 1,
          borderColor: isDanger ? `${themeColors.danger}55` : LIFTED_EDGE,
        },
        disabled || isGhost || !isPrimary ? null : shadow.glow,
        style,
      ]}
    >
      <Text
        variant="button"
        color={color}
        style={size === 'sm' ? { fontSize: 13, lineHeight: 17 } : undefined}
      >
        {children}
      </Text>
    </Pressable>
  );
}

type DividerProps = { direction?: 'horizontal' | 'vertical'; inset?: number; style?: StyleProp<ViewStyle> };

// `inset` starts a horizontal rule after a row's icon, so a list reads as rows
// of text rather than a stack of boxes (2026-09-27 redesign).
export function Divider({ direction = 'horizontal', inset = 0, style }: DividerProps) {
  const themeColors = useThemeColors();
  return (
    <View
      style={[
        {
          backgroundColor: themeColors.border,
          height: direction === 'horizontal' ? 1 : '100%',
          width: direction === 'vertical' ? 1 : undefined,
          alignSelf: direction === 'vertical' ? undefined : 'stretch',
          marginLeft: direction === 'horizontal' ? inset : 0,
        },
        style,
      ]}
    />
  );
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
function badgeToneMap(themeColors: ThemeColors): Record<BadgeTone, { fg: ColorToken; bg: string; border: string }> {
  return {
    neutral: { fg: 'textSecondary', bg: themeColors.surfaceHigh, border: themeColors.border },
    accent: { fg: 'accent', bg: themeColors.accentMuted, border: themeColors.accentMuted },
    success: { fg: 'success', bg: `${themeColors.success}18`, border: `${themeColors.success}24` },
    warning: { fg: 'warning', bg: `${themeColors.warning}18`, border: `${themeColors.warning}24` },
    danger: { fg: 'danger', bg: `${themeColors.danger}18`, border: `${themeColors.danger}24` },
  };
}

export function Badge({ children, tone = 'neutral', style }: { children: React.ReactNode; tone?: BadgeTone; style?: StyleProp<ViewStyle> }) {
  const themeColors = useThemeColors();
  const toneTokens = badgeToneMap(themeColors)[tone];
  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          paddingHorizontal: space[2] + 2,
          paddingVertical: space[1],
          borderRadius: radii.full,
          backgroundColor: toneTokens.bg,
          borderWidth: 1,
          borderColor: toneTokens.border,
        },
        style,
      ]}
    >
      <Text variant="caption" color={toneTokens.fg}>{children}</Text>
    </View>
  );
}

export function ProgressBar({ value, tone = 'accent', style }: { value: number; tone?: Extract<ColorToken, 'accent' | 'success' | 'warning' | 'danger'>; style?: StyleProp<ViewStyle> }) {
  const themeColors = useThemeColors();
  const progress = useSharedValue(Math.max(0, Math.min(1, value)));

  useEffect(() => {
    progress.value = withTiming(Math.max(0, Math.min(1, value)), { duration: motion.base });
  }, [progress, value]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return (
    <View
      style={[
        {
          height: 6,
          overflow: 'hidden',
          borderRadius: radii.full,
          backgroundColor: 'rgba(28, 26, 21, 0.07)',
        },
        style,
      ]}
    >
      <Animated.View style={[{ height: '100%', borderRadius: radii.full, backgroundColor: themeColors[tone] }, fillStyle]} />
    </View>
  );
}

type StatusDotState = 'live' | 'working' | 'sleeping';

export function StatusDot({ state = 'live' }: { state?: StatusDotState }) {
  const themeColors = useThemeColors();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (state === 'live') {
      // A few pulses as the dot appears, then it holds (2026-09-28). It used to
      // pulse for as long as the chat was open: the header kept redrawing
      // (battery), and the phone tests never saw the chat screen still, so
      // every Maestro step there waited out a ~30s settle timeout.
      pulse.value = withRepeat(withSequence(withTiming(0.6, { duration: 900 }), withTiming(1, { duration: 900 })), 3, false);
    } else {
      pulse.value = 1;
    }
  }, [pulse, state]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const color = state === 'live' ? themeColors.live : state === 'working' ? themeColors.accent : themeColors.textTertiary;

  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, animatedStyle]} />;
}

export { colors, colorThemes, fontFamilies, fonts, motion, radii, shadow, space, textStyle, type ColorToken, type RadiusToken, type SpaceToken, type ThemeColors, type ThemeName, type TypeToken };
