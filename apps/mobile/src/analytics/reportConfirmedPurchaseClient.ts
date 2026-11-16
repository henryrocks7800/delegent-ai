// Device half of "a purchase just completed". Mirrors metaPurchaseClient.ts
// exactly: the decision logic lives in reportConfirmedPurchase.ts so it is
// testable under tsx, and the parts that only work on a real device live here.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PlanTierId } from '@sidekick/shared';

import { track } from './analyticsClient';
import { recordMetaPurchase } from './metaPurchaseClient';
import { reportConfirmedPurchaseWith, type ConfirmedPurchaseResult } from './reportConfirmedPurchase';

/**
 * Fire and forget. Call it the moment a purchase is CONFIRMED by the biller,
 * with the amount the biller says was charged and the biller's own transaction
 * id. Never on tap, and never with a catalogue price.
 */
export function reportConfirmedPurchase(
  tierId: PlanTierId,
  source: 'stripe' | 'apple',
  payment?: { amount: number | null; currency: string | null; transactionId?: string | null },
): Promise<ConfirmedPurchaseResult> {
  return reportConfirmedPurchaseWith(
    { storage: AsyncStorage, trackEvent: track, meta: recordMetaPurchase },
    tierId,
    source,
    payment,
  );
}
