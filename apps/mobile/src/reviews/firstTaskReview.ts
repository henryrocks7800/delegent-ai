export type ReviewClaim = 'claimed' | 'already_requested' | 'not_ready';

export interface FirstTaskReviewDependencies {
  isAvailable(): Promise<boolean>;
  claim(): Promise<ReviewClaim>;
  requestReview(): Promise<void>;
  canPresent(): boolean;
}

// A request is not a submitted review, nor proof that the OS showed a dialog.
// Persist the claim before requesting so duplicate completions and app restarts
// cannot spam the customer. Store quotas can suppress the native sheet.
export function createFirstTaskReview(deps: FirstTaskReviewDependencies) {
  let busy = false;
  let finished = false;
  return async (): Promise<'finished' | 'deferred'> => {
    if (finished) return 'finished';
    if (busy || !deps.canPresent()) return 'deferred';
    busy = true;
    try {
      if (!await deps.isAvailable()) { finished = true; return 'finished'; }
      if (!deps.canPresent()) return 'deferred';
      const claim = await deps.claim();
      if (claim === 'not_ready') return 'deferred';
      finished = true;
      if (claim === 'claimed' && deps.canPresent()) await deps.requestReview();
      return 'finished';
    } catch {
      // Optional feedback must never interrupt successful customer work.
      return finished ? 'finished' : 'deferred';
    } finally { busy = false; }
  };
}
