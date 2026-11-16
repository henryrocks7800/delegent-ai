import test from 'node:test';
import worker from '../dist/index.js';
import { portalRouteEnv, verifyPortalRoute } from '../../../tests/fixtures/portal-route-contract.mjs';
test('Worker uses verified explicit generic and upgrade portal configurations through the real SDK', async () => {
  await verifyPortalRoute(request => worker.fetch(request, portalRouteEnv));
});
