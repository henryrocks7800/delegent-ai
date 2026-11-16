import { test } from 'node:test';
import { POST } from '../app/api/stripe/checkout/route';
import { checkoutRouteEnv, verifyCheckoutRoute } from '../../../tests/fixtures/checkout-route-contract.mjs';

test('Next checkout adapter coordinates, recovers and blocks through the real SDKs', async () => {
  const previous = Object.fromEntries(Object.keys(checkoutRouteEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, checkoutRouteEnv);
  try { await verifyCheckoutRoute(POST); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
