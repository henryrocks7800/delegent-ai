// Pure Google Analytics 4 core for the product funnel events (2026-07-22).
// This is the OTA-shippable half of the parked native analytics work (PR
// #167): instead of the native Firebase SDK (which needs a store build), we
// speak the GA4 web collection wire protocol directly - the exact requests
// every gtag.js website sends - so events land in the SAME Google Analytics
// property the Firebase project is linked to, from plain JS, today. When the
// native SDK eventually ships, it simply replaces the transport; event names
// and call sites stay identical.
//
// Design mirrors the parked PR's track.ts: no imports at all (runs directly
// under tsx with a fake fetch), dependency-injected transport, and THE
// CARDINAL RULE: trackEvent is fire-and-forget - it returns void
// synchronously, never throws, and is never awaited by the UI, so no
// analytics failure can ever surface to the user or block a render.

export type AnalyticsPropValue = string | number | boolean | null | undefined;
export type AnalyticsEventProps = Record<string, AnalyticsPropValue>;

export const GA4_COLLECT_ENDPOINT = 'https://www.google-analytics.com/g/collect';

// GA4 event-name contract: letters, digits, underscores, must start with a
// letter, max 40 chars. Our names are fixed constants, but validate anyway so
// a bad call site degrades to a silent no-op instead of polluting the stream.
const GA4_EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export function isValidGa4EventName(name: string): boolean {
  return GA4_EVENT_NAME_RE.test(name);
}

// One collect request per event, matching gtag's wire shape: v=2 protocol,
// tid = measurement id, cid = our stable pseudonymous client id, sid = one id
// per app launch (sessionises the funnel), en = event name. String props ride
// as ep.<key>, finite numbers as epn.<key>. Values are truncated to GA's
// 100-char param limit; keys are sanitised to the allowed charset. No user
// identifiers or free-text ever ride along - call sites only pass enum-like
// values (tab names, tier ids).
export function buildGa4CollectUrl(input: {
  measurementId: string;
  clientId: string;
  sessionId: string;
  eventName: string;
  props?: AnalyticsEventProps;
}): string {
  const params = new URLSearchParams();
  params.set('v', '2');
  params.set('tid', input.measurementId);
  params.set('cid', input.clientId);
  params.set('sid', input.sessionId);
  params.set('en', input.eventName);
  // Engaged time; GA drops sessions with zero engagement, 1ms is the
  // conventional floor gtag itself uses for instant events.
  params.set('_et', '1');
  for (const [key, value] of Object.entries(input.props ?? {})) {
    if (value === null || value === undefined) continue;
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
    if (!safeKey) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      params.set(`epn.${safeKey}`, String(value));
    } else {
      params.set(`ep.${safeKey}`, String(value).slice(0, 100));
    }
  }
  return `${GA4_COLLECT_ENDPOINT}?${params.toString()}`;
}

export type Ga4FetchFn = (url: string, init: { method: 'POST' }) => Promise<unknown>;

export interface Ga4Tracker {
  trackEvent(name: string, props?: AnalyticsEventProps): void;
  flush(): Promise<void>;
  readonly pending: number;
}

// Queue + drain: trackEvent enqueues and schedules an async flush; the flush
// sends events strictly in order and swallows every transport error (a dead
// network just drops funnel events - never queues unboundedly, never retries,
// never throws). One in-flight drain at a time.
const MAX_QUEUED_EVENTS = 40;

export function createGa4Tracker(deps: {
  measurementId: string;
  clientId: string;
  sessionId: string;
  fetchFn: Ga4FetchFn;
}): Ga4Tracker {
  const queue: { name: string; props?: AnalyticsEventProps }[] = [];
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const event = queue.shift()!;
      try {
        const url = buildGa4CollectUrl({
          measurementId: deps.measurementId,
          clientId: deps.clientId,
          sessionId: deps.sessionId,
          eventName: event.name,
          props: event.props,
        });
        await deps.fetchFn(url, { method: 'POST' });
      } catch {
        // Transport failure: drop the event, keep draining the rest.
      }
    }
    draining = null;
  };

  return {
    trackEvent(name: string, props?: AnalyticsEventProps): void {
      try {
        if (!isValidGa4EventName(name)) return;
        if (queue.length >= MAX_QUEUED_EVENTS) return; // offline backstop: shed, never grow
        queue.push({ name, props });
        if (!draining) draining = drain();
      } catch {
        // Analytics must never throw into the UI.
      }
    },
    flush(): Promise<void> {
      return (draining ?? Promise.resolve()).catch(() => undefined);
    },
    get pending() {
      return queue.length;
    },
  };
}
