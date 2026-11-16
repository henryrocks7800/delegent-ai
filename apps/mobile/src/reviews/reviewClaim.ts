import type { ReviewClaim } from './firstTaskReview';

export async function fetchReviewClaim(url: string, init: RequestInit): Promise<ReviewClaim> {
  // React Native's AbortSignal polyfill has no static timeout() method.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error('review_unavailable');
    const claim: unknown = await response.json();
    if (claim !== 'claimed' && claim !== 'already_requested' && claim !== 'not_ready') throw new Error('invalid_review_claim');
    return claim;
  } finally {
    clearTimeout(timeout);
  }
}
