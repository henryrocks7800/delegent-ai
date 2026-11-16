import { test } from 'node:test';
import { POST } from '../app/api/stripe/portal/route';
import { downgradeRouteEnv, verifyDowngradeRoute } from '../../../tests/fixtures/downgrade-route-contract.mjs';

test('Next downgrade route checks storage, preserves the paid price and schedules through the real SDK', async () => {
  const previous = Object.fromEntries(Object.keys(downgradeRouteEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, downgradeRouteEnv);
  try { await verifyDowngradeRoute(POST); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
