import { hmacHex } from './internal.ts';
import type { SortNotice } from './inboxSortStore.ts';
import type { MoneyNotice } from './moneyFinderStore.ts';

/**
 * Delivery of the inbox sort's plan and finish messages to the production
 * Worker, which renders fixed wording from counts and folder names
 * (apps/worker/src/inbox-notice.ts). Aggregate-only: never a subject, a preview
 * or an account ID.
 */
export const INBOX_NOTICE_PATH = '/internal/inbox-notice';

/** Bind the protocol, user, timestamp AND exact body, separately from run auth. */
export async function inboxNoticeHeaders(secret: string, userId: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  return {
    'content-type': 'application/json', 'x-sidekick-user-id': userId,
    'x-sidekick-notice-timestamp': String(nowSeconds),
    'x-sidekick-notice-token': `v1.${await hmacHex(secret, `inbox-notice:v1:${userId}:${nowSeconds}:${body}`)}`,
  };
}

/** No retry here: the durable outbox owns retries, including ambiguous delivery. */
export async function deliverInboxNotice(input: {
  apiBase: string; secret: string; userId: string; notice: SortNotice | MoneyNotice; fetch?: typeof fetch;
}): Promise<boolean> {
  try {
    const base = new URL(input.apiBase);
    if (base.protocol !== 'https:' || base.username || base.password || !input.secret) return false;
    const body = JSON.stringify(input.notice);
    const response = await (input.fetch ?? globalThis.fetch.bind(globalThis))(new URL(INBOX_NOTICE_PATH, base), {
      method: 'POST', headers: await inboxNoticeHeaders(input.secret, input.userId, body), body,
      signal: AbortSignal.timeout(10_000), redirect: 'manual',
    });
    // A fixed, empty acknowledgement is enough; never load provider/chat content.
    await response.body?.cancel();
    return response.status === 204;
  } catch { return false; }
}
