/** A real background/foreground transition is another app open.
 * iOS's inactive state also includes Control Centre and StoreKit sheets. */
export function createAppOpenDetector() {
  let backgrounded = false;
  return (state: string): boolean => {
    if (state === 'background') backgrounded = true;
    if (state !== 'active') return false;
    const reopened = backgrounded;
    backgrounded = false;
    return reopened;
  };
}

export function shouldShowAppOpenPaywall(input: {
  subscriptionKnown: boolean; hasActiveSubscription: boolean;
  dismissed: boolean; checkingResume: boolean; purchaseInFlight: boolean;
}): boolean {
  return input.subscriptionKnown && !input.hasActiveSubscription
    && !input.dismissed && !input.checkingResume && !input.purchaseInFlight;
}
