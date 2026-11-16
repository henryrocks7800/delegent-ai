import type { TextStyle, ViewStyle } from 'react-native';

export const colorThemes = {
  light: {
    // Quiet direction, warm off-white canvas. Since the 2026-09-27 redesign
    // depth comes from ambient light (design/Ambient.tsx) rather than lines.
    // 2026-09-28: Alex chose "Pearl" of five softer looks ("too much contrast
    // ... a bit too green"), so the accent is a quiet ink, not sage.
    bg: '#FAFAF7',
    surface: '#FAFAF7',
    surfaceHigh: '#FFFFFF',
    border: '#ECE9E2',
    borderStrong: '#D3CFC5',

    textPrimary: '#0E0E0C',
    textSecondary: '#6F6E68',
    textTertiary: '#A8A6A0',
    textDisabled: '#C7C5BD',

    accent: '#222220',
    accentSoft: '#55554F',
    accentMuted: '#ECECE8',
    accentText: '#FAFAF7',

    success: '#4A7A4A',
    warning: '#B8956E',
    danger: '#B64949',

    overlay: 'rgba(18, 24, 21, 0.34)',
    live: '#4A7A4A',

    // Brand tints stay colourful so provider identity does not regress
    googleBlue: '#1976D2',
    telegram: '#2481CC',
    telegramMuted: '#2481CC18',
    whatsapp: '#128C7E',
    whatsappMuted: '#128C7E18',
    signal: '#3A76F0',
    signalMuted: '#3A76F018',
    email: '#B8956E',
    emailMuted: '#B8956E18',
  },
} as const;

export type ThemeName = keyof typeof colorThemes;
export type ThemeColors = Record<keyof typeof colorThemes.light, string>;

export const colors = colorThemes.light;

export const fonts = {
  display: 'Geist',
  body: 'Geist',
  mono: 'GeistMono',
  brand: 'InstrumentSerif',
} as const;

export const fontFamilies = {
  geistRegular: 'Geist_400Regular',
  geistMedium: 'Geist_500Medium',
  geistSemiBold: 'Geist_600SemiBold',
  geistMonoRegular: 'GeistMono_400Regular',
  geistMonoMedium: 'GeistMono_500Medium',
  instrumentSerifItalic: 'InstrumentSerif_400Regular_Italic',
} as const;

export const type = {
  // Headlines are set in the brand serif since the 2026-09-27 redesign; it
  // reads smaller than Geist at the same size, hence 40.
  displayLg: { size: 40, line: 45, weight: '400', tracking: -0.6, family: fontFamilies.instrumentSerifItalic },
  displayMd: { size: 28, line: 32, weight: '500', tracking: -0.3, family: fontFamilies.geistMedium },
  title: { size: 16, line: 22, weight: '500', tracking: -0.2, family: fontFamilies.geistMedium },
  body: { size: 15, line: 22, weight: '400', tracking: 0, family: fontFamilies.geistRegular },
  bodySm: { size: 13, line: 19, weight: '400', tracking: 0, family: fontFamilies.geistRegular },
  caption: { size: 12, line: 16, weight: '500', tracking: 0.2, family: fontFamilies.geistMedium },
  label: { size: 11, line: 14, weight: '600', tracking: 1.3, family: fontFamilies.geistSemiBold },
  button: { size: 15, line: 20, weight: '600', tracking: -0.1, family: fontFamilies.geistSemiBold },
  mono: { size: 12, line: 16, weight: '500', tracking: 0.6, family: fontFamilies.geistMonoMedium },
  brand: { size: 36, line: 42, weight: '400', tracking: -0.4, family: fontFamilies.instrumentSerifItalic },
  brandMd: { size: 30, line: 36, weight: '400', tracking: -0.3, family: fontFamilies.instrumentSerifItalic },
  brandSm: { size: 22, line: 26, weight: '400', tracking: -0.2, family: fontFamilies.instrumentSerifItalic },
} as const;

export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
  9: 96,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  xxl: 30,
  full: 999,
} as const;

// Soft, layered CSS shadows (React Native 0.76+ `boxShadow`, drawn natively on
// both platforms by the New Architecture this app runs on), rather than
// Android's single hard `elevation` shadow.
export const shadow = {
  none: {},
  sheet: {
    boxShadow: '0 12px 32px rgba(20, 28, 24, 0.14), 0 32px 80px rgba(20, 28, 24, 0.16)',
  } satisfies ViewStyle,
  card: {
    boxShadow: '0 1px 2px rgba(28, 26, 21, 0.05), 0 6px 18px rgba(28, 26, 21, 0.06)',
  } satisfies ViewStyle,
  raised: {
    boxShadow: '0 2px 6px rgba(28, 26, 21, 0.06), 0 14px 34px rgba(28, 26, 21, 0.10)',
  } satisfies ViewStyle,
  glow: {
    boxShadow: '0 6px 16px rgba(20, 20, 18, 0.18)',
  } satisfies ViewStyle,
} as const;

export const motion = {
  fast: 120,
  base: 180,
  slow: 240,
  standard: [0.2, 0.0, 0.0, 1.0],
  exit: [0.4, 0.0, 1.0, 1.0],
  spring: { damping: 24, stiffness: 180 },
  // A press: in quickly, back out with a little life in it.
  press: { damping: 18, stiffness: 420, mass: 0.6 },
} as const;

export type ColorToken = keyof typeof colors;
export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radii;
export type TypeToken = keyof typeof type;

export function textStyle(variant: TypeToken): TextStyle {
  const spec = type[variant];
  return {
    fontFamily: spec.family,
    fontSize: spec.size,
    lineHeight: spec.line,
    letterSpacing: spec.tracking,
    includeFontPadding: false,
  };
}
