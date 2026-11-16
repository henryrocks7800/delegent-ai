import { getFreshMobileAccessToken } from '../auth/supabaseClient';
import { mobileSupabaseConfig } from '../auth/publicSupabase';
import { isOnboardingGoal, type OnboardingGoal } from './growthContent';

export async function goalRpc(name: string, body: Record<string, unknown> = {}, isCurrent = () => true) {
  if (!mobileSupabaseConfig.ready) throw new Error('Sign in to continue.');
  const token = await getFreshMobileAccessToken();
  if (!token || !isCurrent()) throw new Error('Sign in to continue.');
  // React Native's AbortSignal polyfill does not implement AbortSignal.timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${mobileSupabaseConfig.config.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: mobileSupabaseConfig.config.anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Couldn’t save your choice. Try again.');
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveOnboardingGoal(goal: OnboardingGoal): Promise<void> {
  await goalRpc('set_my_onboarding_goal', { p_goal: goal });
}

export async function loadOnboardingGoal(): Promise<OnboardingGoal | null> {
  try {
    const value = await goalRpc('get_my_onboarding_goal');
    return isOnboardingGoal(value) ? value : null;
  } catch {
    // A preference fetch must never prevent returning users opening their app.
    return null;
  }
}
