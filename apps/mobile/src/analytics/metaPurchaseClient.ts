// Device half of the Meta purchase event. Mirrors metaSdkClient.ts exactly:
// decision logic lives in metaPurchase.ts so it is testable under tsx, and the
// parts that only work on a real device live here.
import { advertisingLease } from './metaSdkClient';
import { Platform } from 'react-native';

import {
  reportPurchaseToMeta,
  type MetaPurchaseLogger,
  type PurchaseFacts,
  type ReportPurchaseOutcome,
} from './metaPurchase';

/**
 * Load AppEventsLogger, or null if this build has no SDK.
 *
 * Same defensive lazy import as loadSettings() in metaSdkClient: the module is
 * absent in Expo Go, in Android builds before 2.3.0, and in anything built
 * without the Meta app id and client token. A missing module must degrade to
 * "no measurement", never to a crash on a paying customer's happiest moment.
 */
async function loadLogger(): Promise<MetaPurchaseLogger | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  try {
    const mod = (await import('react-native-fbsdk-next')) as {
      AppEventsLogger?: {
        logPurchase?: (amount: number, currency: string, params?: Record<string, string>) => void;
      };
    };
    const fn = mod.AppEventsLogger?.logPurchase;
    if (typeof fn !== 'function') return null;
    return { logPurchase: (a, c, p) => mod.AppEventsLogger!.logPurchase!(a, c, p) };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget. Call it the moment a purchase is CONFIRMED, never when one
 * is merely started: Meta optimises toward what we report, and reporting an
 * abandoned checkout would train it to find people who abandon checkouts.
 */
export async function recordMetaPurchase(facts: PurchaseFacts): Promise<ReportPurchaseOutcome> {
  const lease = advertisingLease();
  if (!lease) return 'no_consent';
  return reportPurchaseToMeta(
    {
      storage: { getItem: async () => lease.valid() ? 'granted' : 'denied', setItem: async () => undefined },
      canSend: lease.valid,
      loadLogger,
      warn: (m) => console.warn(`[meta] ${m}`),
    },
    facts,
  );
}
