/**
 * What the admin page says when it could not load.
 *
 * A pure function on purpose, so the decision can be EXECUTED in a test rather
 * than grepped for in JSX. The bug it exists for shipped because 401 and 403
 * shared a branch and shared a sentence.
 *
 * On 2026-09-14 Alex opened the admin page and read "This account is not on the
 * list", so he went looking for his account being dropped from the allowlist.
 * It had not been: the admin API was answering 200 for his user id throughout.
 * His browser simply had no usable session, which a sign-out on his phone
 * causes, because the default sign-out scope is global and revokes the refresh
 * token everywhere. A 401 and a 403 are different answers to different
 * questions and must never share copy again.
 */
export function adminLoadErrorMessage(failure: { status: number; message: string }): string {
  if (failure.status === 401) {
    return 'Your session here has expired. Sign out and sign in again, then reopen this page.';
  }
  if (failure.status === 403) {
    return 'This area is for Delegent AI administrators. This account is not on the list.';
  }
  return failure.message;
}
