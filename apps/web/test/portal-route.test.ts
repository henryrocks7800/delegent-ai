import { test } from 'node:test';
import { POST } from '../app/api/stripe/portal/route';
import { portalRouteEnv, verifyPortalRoute } from '../../../tests/fixtures/portal-route-contract.mjs';
test('Next uses verified explicit generic and upgrade portal configurations through the real SDK', async () => {
  const previous = Object.fromEntries(Object.keys(portalRouteEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, portalRouteEnv);
  try { await verifyPortalRoute(POST); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
