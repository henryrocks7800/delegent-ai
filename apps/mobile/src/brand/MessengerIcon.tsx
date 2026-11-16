import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { MESSENGER_ICON_SVG, type MessengerIconId } from './messengerIcons';

type MessengerIconProps = {
  id: MessengerIconId;
  size?: number;
  /** Rounded-corner inset, as a fraction of size (default 0.22 = iOS-style squircle). */
  cornerRadius?: number;
  style?: StyleProp<ViewStyle>;
};

export function MessengerIcon({ id, size = 32, cornerRadius = 0.22, style }: MessengerIconProps) {
  const xml = MESSENGER_ICON_SVG[id];
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size * cornerRadius,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}
