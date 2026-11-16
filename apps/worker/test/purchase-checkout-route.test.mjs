import test from 'node:test';
import worker from '../dist/index.js';
import { checkoutRouteEnv, verifyCheckoutRoute } from '../../../tests/fixtures/checkout-route-contract.mjs';

test('Worker checkout adapter coordinates, recovers and blocks through the real SDKs', async () => {
  await verifyCheckoutRoute(request => worker.fetch(request, checkoutRouteEnv));
});
