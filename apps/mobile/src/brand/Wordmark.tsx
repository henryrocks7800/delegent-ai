import React from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Text } from '../design/primitives';
import { fontFamilies, type ThemeColors } from '../design/tokens';

export const BRAND_NAME = 'Delegent AI';

type WordmarkSize = 'sm' | 'md' | 'lg';

type WordmarkProps = {
  size?: WordmarkSize;
  color?: keyof ThemeColors;
  align?: 'left' | 'center' | 'right';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

const SIZE_SPEC: Record<WordmarkSize, { serifSize: number; serifLine: number; sansSize: number; sansLine: number; gap: number; tracking: number }> = {
  sm: { serifSize: 20, serifLine: 24, sansSize: 13, sansLine: 16, gap: 6, tracking: -0.1 },
  md: { serifSize: 28, serifLine: 32, sansSize: 16, sansLine: 20, gap: 8, tracking: -0.2 },
  lg: { serifSize: 44, serifLine: 50, sansSize: 22, sansLine: 28, gap: 10, tracking: -0.4 },
};

export function Wordmark({ size = 'md', color = 'textPrimary', align = 'left', style, accessibilityLabel }: WordmarkProps) {
  const spec = SIZE_SPEC[size];
  const justify =
    align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';

  const serifStyle: StyleProp<TextStyle> = {
    fontFamily: fontFamilies.instrumentSerifItalic,
    fontSize: spec.serifSize,
    lineHeight: spec.serifLine,
    letterSpacing: spec.tracking,
    includeFontPadding: false,
  };

  const sansStyle: StyleProp<TextStyle> = {
    fontFamily: fontFamilies.geistMedium,
    fontSize: spec.sansSize,
    lineHeight: spec.sansLine,
    letterSpacing: 1.4,
    includeFontPadding: false,
  };

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? BRAND_NAME}
      style={[styles.row, { justifyContent: justify, gap: spec.gap }, style]}
    >
      <Text color={color} style={serifStyle}>
        Delegent
      </Text>
      <Text color={color} style={sansStyle}>
        AI
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
});
