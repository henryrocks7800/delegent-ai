import { selectedAppIds } from './appJourney';
import { goalRpc } from './onboardingGoal';

export async function saveOnboardingApps(ids: readonly string[], isCurrent = () => true): Promise<void> {
  await goalRpc('set_my_onboarding_apps', { p_service_ids: selectedAppIds(ids) }, isCurrent);
}

export async function loadOnboardingApps(isCurrent = () => true): Promise<string[]> {
  return selectedAppIds(await goalRpc('get_my_onboarding_apps', {}, isCurrent));
}
