import type { AnalyticsEventProps } from './ga4';
import { SIDEKICK_FREE_TRIAL } from '@sidekick/shared';

export type PaywallEntryPoint = 'onboarding' | 'app_open' | 'upgrade_chip' | 'menu' | 'checkout_return';
export const PAYWALL_VARIANT = SIDEKICK_FREE_TRIAL.enabled ? 'studio_focus_trial_3d_v1' : 'studio_focus_v1';

// Visibility, not a shell flag: the same screen can live in a modal or at root.
export function createPaywallExposure(track: (name: string, props?: AnalyticsEventProps) => void) {
  let current: AnalyticsEventProps | null = null;
  return {
    update(visible: boolean, entryPoint: PaywallEntryPoint, variant: string) {
      if (!visible) { current = null; return; }
      if (current) return;
      current = { entry_point: entryPoint, variant };
      track('viewed_plans', current);
      track('paywall_seen', current);
    },
    dismiss(reason: 'close' | 'back' | 'not_now') {
      if (!current) return;
      track('paywall_dismissed', { ...current, reason });
      current = null;
    },
  };
}
