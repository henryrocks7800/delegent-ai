import { SCHEDULED_PLAN_CHANGE_CONFIRMATION as copy } from '@sidekick/shared';

export function confirmScheduledPlanChange(): boolean {
  return window.confirm(`${copy.title}\n\n${copy.body}`);
}
