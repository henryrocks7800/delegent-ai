import React, { type ReactNode } from 'react';
import Svg, { Path } from 'react-native-svg';
import type { BrandMark, ConnectableService } from '@sidekick/shared';
import { Stack, Text } from '../design/primitives';

export function BrandMarkGlyph({ mark, size = 20 }: { mark: BrandMark; size?: number }) {
  return <Svg width={size} height={size} viewBox={mark.viewBox}><Path d={mark.path} fill={mark.color} /></Svg>;
}

/**
 * Shared with Connections: identical names, marks and audited capability copy.
 * `wording` lets an agent-engine account read the same blurb about an assistant.
 */
export function ConnectionIdentity({ service, trailing, wording }: { service: ConnectableService; trailing?: ReactNode; wording?: (text: string) => string }) {
  return <Stack gap={1}>
    <Stack direction="horizontal" gap={2} align="center">
      {service.brandMark ? <BrandMarkGlyph mark={service.brandMark} /> : null}
      <Text variant="title" style={{ flex: 1 }}>{service.name}</Text>
      {trailing}
    </Stack>
    <Text variant="caption" color="textSecondary">{wording ? wording(service.blurb) : service.blurb}</Text>
  </Stack>;
}
