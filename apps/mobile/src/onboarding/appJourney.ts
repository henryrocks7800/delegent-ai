import { CONNECTABLE_SERVICES, type ConnectionCategory } from '@sidekick/shared';
import type { ApplePlanOffer } from '../billing/appleOffer';
import { buildAgentConnectionSections, buildConnectionGroups, buildConnectionRows, type ConnectionRow } from '../connections/connections';

export const CATEGORY_EMOJI: Record<ConnectionCategory, string> = {
  email: '📬', calendar: '🗓️', files: '📁', messaging: '💬', code: '💻',
  tasks: '✅', money: '🧾', social: '📣', search: '🔎', web: '🌐',
};

/** Only catalogue IDs are preferences. No account names, grants or free text. */
export function selectedAppIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(value);
  return CONNECTABLE_SERVICES.filter((service) => ids.has(service.id)).map((service) => service.id);
}

export function toggleApp(ids: readonly string[], id: string): string[] {
  return selectedAppIds(ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
}

export function journeyInvitation(trialCandidate: boolean, apple: boolean, offer?: ApplePlanOffer, agentEngine = false) {
  // An assistant account's plan starts with a free month, and nothing about it
  // is a coworker (Alex, 2026-09-15). On iPhone the free month is Apple's
  // introductory offer (2026-09-16), so it is only promised firmly once
  // StoreKit has confirmed this Apple Account is eligible, as with the trial.
  if (agentEngine) {
    if (!trialCandidate) return { title: 'Make room for your life', button: 'Meet my coworker', caption: 'Choose your plan after setup. Nothing starts until you confirm.' };
    if (!apple || offer?.hasFreeMonth) {
      return { title: 'Try your AI coworker free', button: 'Continue to my free month', caption: 'Finish setup, then review your free month and plan before you confirm.' };
    }
    return { title: 'Try your AI coworker', button: 'See my offer', caption: 'Apple confirms whether the free first month is available to your Apple Account. Review your offer before subscribing.' };
  }
  if (!trialCandidate) return { title: 'Make room for your work', button: 'Meet my coworker', caption: 'Choose your plan after setup. Nothing starts until you confirm.' };
  if (!apple || offer?.hasThreeDayTrial) return { title: 'Try your AI coworker free', button: 'Continue to my free trial', caption: 'Finish setup, then review your trial and plan before you confirm.' };
  return { title: 'Explore your free trial options', button: 'See my options', caption: 'Apple confirms whether a free trial is available to your Apple Account. Review your offer before subscribing.' };
}

export type OnboardingGroup = { key: string; label: string; emoji: string; tint?: string; rows: readonly ConnectionRow[] };

/**
 * The apps to choose from, grouped. An assistant account sees the groups its
 * Connections screen uses, in their colours, and only the apps its engine can
 * use; every other account sees the workspace grouping as before.
 */
export function onboardingGroups(available: readonly string[] | null, agentEngine: boolean): readonly OnboardingGroup[] {
  const rows = buildConnectionRows([], available);
  if (agentEngine) {
    return buildAgentConnectionSections(rows)
      .filter((section) => section.rows.length > 0)
      .map((section) => ({ key: section.category.key, label: section.category.title, emoji: section.category.emoji, tint: section.category.tint, rows: section.rows }));
  }
  return buildConnectionGroups(rows).map((group) => ({ key: group.category, label: group.label, emoji: CATEGORY_EMOJI[group.category], rows: group.rows }));
}
