/**
 * How long "sort my inbox" filing takes, for the plan message and progress
 * answers. Calibrated on a real run (2026-09-24, Outlook): filing reads the
 * whole inbox page by page, 1,000 emails a page, at about a page a minute,
 * whatever share of it moves. Gmail files by sender search in batches of 1,000
 * and is much faster. Deliberately rounded up, so it under-promises.
 *
 * Keep in sync with sortEstimateMinutes in apps/worker/src/inbox-notice.ts,
 * which words the plan message from the same counts.
 */
import type { SortProvider } from './inboxSort.ts';

export function sortEstimateMinutes(provider: SortProvider, total: number, toFile: number): number {
  if (provider === 'outlook') return Math.ceil(Math.max(0, total) / 1000) + 2;
  return Math.ceil(Math.max(0, toFile) / 5000) + 1;
}

/** "a few minutes", "about 25 minutes", "about 1 hour 15 minutes", "about 3 hours". */
export function formatSortDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 5) return 'a few minutes';
  if (minutes < 60) return `about ${Math.ceil(minutes / 5) * 5} minutes`;
  const rounded = Math.ceil(minutes / 15) * 15;
  const hours = Math.floor(rounded / 60); const rest = rounded % 60;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
}

/** A UK clock time, e.g. "20:55", for "should finish around ...". */
export function ukClock(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(new Date(at));
}

/** Time left while filing: the estimate minus time already spent, never below "a few minutes". */
export function sortTimeLeft(input: { provider: SortProvider; total: number; toFile: number; filingStartedAt?: number }, now = Date.now()): string {
  const estimate = sortEstimateMinutes(input.provider, input.total, input.toFile);
  const spent = input.filingStartedAt ? Math.max(0, (now - input.filingStartedAt) / 60_000) : 0;
  return formatSortDuration(estimate - spent);
}
