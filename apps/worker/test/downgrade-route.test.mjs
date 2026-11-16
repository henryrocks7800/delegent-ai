import test from 'node:test';
import worker from '../dist/index.js';
import { downgradeRouteEnv, verifyDowngradeRoute } from '../../../tests/fixtures/downgrade-route-contract.mjs';

test('Worker downgrade route checks storage, preserves the paid price and schedules through the real SDK', async () => {
  await verifyDowngradeRoute(request => worker.fetch(request, downgradeRouteEnv));
});
