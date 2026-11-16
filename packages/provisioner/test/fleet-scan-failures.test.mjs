import test from 'node:test';
import assert from 'node:assert/strict';
import { runHermesProvisionerCli } from '../dist/cli.js';
import { createSeries4SupabaseLifecycleStore, createSupabaseServiceRoleRestClient } from '../dist/index.js';

const env = {
  SUPABASE_URL: 'https://local-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
  FLY_API_TOKEN: 'fixture', FLY_ORG: 'fixture', FLY_PRIMARY_REGION: 'lhr',
  SIDEKICK_RUNNER_PROVIDER: 'fly_machines',
};
test('stale provisioning transitions reject before publishing a greeting', async () => {
  const calls = [];
  const client = createSupabaseServiceRoleRestClient({
    supabaseUrl: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('false', { status: 200 });
    },
  });
  const store = createSeries4SupabaseLifecycleStore(client);
  const job = { userId: 'fixture-user', idempotencyKey: 'same-intent', claimedAt: '2026-09-13T12:00:00Z' };
  const failure = { errorCode: 'fixture', publicStatusMessage: 'Fixture' };
  await assert.rejects(store.markSeries4FlyRunnerReady(job, 'https://fixture.invalid'), /stale_hermes_provisioning_readiness/);
  await assert.rejects(store.markSeries4FlyProvisioningFailed(job, failure), /stale_hermes_provisioning_failure/);
  await assert.rejects(store.markSeries4FlyProvisioningReconciliationRequired(job, failure), /stale_hermes_provisioning_reconciliation/);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.url, /rpc\/transition_hermes_provisioning$/);
    assert.equal(call.body.p_claimed_at, job.claimedAt);
    assert.equal(call.body.p_idempotency_key, job.idempotencyKey);
    assert.equal(call.body.p_user_id, job.userId);
  }
});
for (const command of ['series4:storage-usage-once', 'series4:suspend-stop-once', 'series4:resize-once', 'series4:stuck-readiness-once']) {
  test(`${command}: failed database scan exits nonzero with no idle report`, async () => {
    const lines = [];
    const code = await runHermesProvisionerCli([command], env, {
      fetchImpl: async () => new Response(JSON.stringify({ message: 'fixture unavailable' }), { status: 503 }),
      stdout: (line) => lines.push(JSON.parse(line)), stderr: (line) => lines.push(JSON.parse(line)),
    });
    assert.equal(code, 1);
    assert.equal(lines.at(-1).status, 'failed');
    assert.ok(!lines.some((line) => line.status === 'idle'));
  });
}
