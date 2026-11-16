import { getFreshMobileAccessToken } from '../auth/supabaseClient';
import { mobileSupabaseConfig } from '../auth/publicSupabase';
import type { ReviewClaim } from './firstTaskReview';
import { fetchReviewClaim } from './reviewClaim';

type StoreReviewApi = typeof import('expo-store-review');
let storeReview: StoreReviewApi | null | undefined;
function nativeReview(): StoreReviewApi | null {
  if (storeReview !== undefined) return storeReview;
  try { storeReview = require('expo-store-review') as StoreReviewApi; }
  catch { storeReview = null; } // Older binaries do not include this native module.
  return storeReview;
}

export async function isNativeReviewAvailable(): Promise<boolean> {
  return await nativeReview()?.isAvailableAsync() ?? false;
}
export async function requestNativeTaskReview(): Promise<void> {
  const api = nativeReview();
  if (!api) return;
  await api.requestReview();
}
export async function claimFirstTaskReview(userId: string): Promise<ReviewClaim> {
  if (!mobileSupabaseConfig.ready) throw new Error('review_unavailable');
  const token = await getFreshMobileAccessToken();
  if (!token) throw new Error('review_unauthenticated');
  return fetchReviewClaim(`${mobileSupabaseConfig.config.url}/rest/v1/rpc/claim_my_first_task_review`, {
    method: 'POST',
    headers: { apikey: mobileSupabaseConfig.config.anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_expected_user_id: userId }),
  });
}
