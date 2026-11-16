import { SIDEKICK_INSPIRATION_STARTERS, type InspirationStarter } from '@sidekick/shared';

export type MobileInspiration = InspirationStarter & {
  icon: 'check-square' | 'search' | 'edit-3';
  badge: string;
};

const iconByStarterId: Record<MobileInspiration['id'], MobileInspiration['icon']> = {
  'tidy-admin-notes': 'check-square',
  'compare-options': 'search',
  'draft-reply': 'edit-3',
};

const badgeByStarterId: Record<MobileInspiration['id'], string> = {
  'tidy-admin-notes': 'Admin',
  'compare-options': 'Research',
  'draft-reply': 'Writing',
};

export const mobileInspirations: readonly MobileInspiration[] = SIDEKICK_INSPIRATION_STARTERS.map((starter) => ({
  ...starter,
  icon: iconByStarterId[starter.id],
  badge: badgeByStarterId[starter.id],
}));
