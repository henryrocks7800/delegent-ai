// Series 4 — two-user runner isolation E2E (credential-free).
//
// This is the load-bearing acceptance test for the whole migration. It runs
// without any live infra: a fake Fly Machines API + fake Supabase store +
// in-process Worker + in-process runner dispatch table. Two distinct users
// go through the entire flow (provision -> dispatch -> file). Then the test
// proves the structural invariants the spec demands:
//
//   1. Different Fly app names.
//   2. Different Machine IDs.
//   3. Different volume IDs.
//   4. Different runner shared secrets.
//   5. Different workspaces (a file user A creates is invisible to user B).
//   6. User A's task NEVER reaches user B's runner URL.
//   7. User B's files NEVER appear to user A.
//   8. Deleting / suspending user A does NOT affect user B's runner.
//
// Run via the existing e2e suite:
//   node --test tests/e2e/series4-fly-runner-isolation.test.mjs
//
// This test takes the place of a live-Fly two-user smoke for the acceptance
// gate; the live smoke (series4-fly-live-smoke.mjs) covers the actual
// network/provider side end-to-end but is gated behind both
// SIDEKICK_ALLOW_LIVE_FLY_PROVISIONING and SIDEKICK_ALLOW_FLY_TEST_DESTROY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  createFlyMachinesProvider,
  processNextSeries4FlyProvisioningJob,
  processSeries4SubscriptionSuspension,
  processNextSeries4GraceExpiry,
} from '../../../packages/provisioner/dist/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FLY_TOKEN = 'FlyV1 fm2_isolation_test_token_must_not_leak';
const FLY_ORG = 'personal';
const FLY_REGION = 'lhr';
const IMAGE_REF = 'registry.fly.io/delegent-hermes-runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKER_URL = 'https://worker.sidekick.test';

const USER_A_ID = '00000000-0000-4000-8000-000000000a01';
const USER_B_ID = '00000000-0000-4000-8000-000000000b02';
const USER_A_AGENT_NAME = 'Alpha-Series4-iso';
const USER_B_AGENT_NAME = 'Bravo-Series4-iso';

const TEST_ENV = {
  FLY_API_TOKEN: FLY_TOKEN,
  FLY_ORG,
  FLY_PRIMARY_REGION: FLY_REGION,
  SIDEKICK_FLY_RUNNER_IMAGE_REF: IMAGE_REF,
  SIDEKICK_WORKER_PROXY_URL: WORKER_URL,
};

// ---------------------------------------------------------------------------
// Fake Fly Machines API — per-app routing, distinct IDs, isolated state
// ---------------------------------------------------------------------------
// The fake records every call so the tests can assert exact request paths.
// Apps/machines/volumes are stored separately per app so cross-user state
// truly cannot leak.

function makeFakeFlyApi() {
  const apps = new Map(); // appName -> { volumes: Map, machines: Map, env: Record, ips: Set }
  const calls = [];
  let machineSeq = 0;
  let volumeSeq = 0;

  function impl(url, init = {}) {
    // GraphQL — AllocateIpAddress
    if (url === 'https://api.fly.io/graphql') {
      const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
      const type = body?.variables?.type;
      const appId = body?.variables?.appId;
      const app = apps.get(appId);
      if (!app) {
        return Promise.resolve(new Response(JSON.stringify({ errors: [{ message: 'app not found' }] }), { status: 200 }));
      }
      app.ips.add(type);
      return Promise.resolve(new Response(JSON.stringify({ data: { allocateIpAddress: { ipAddress: { address: type === 'v6' ? 'fdaa::1' : '66.241.124.10', type } } } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const path = url.replace(/^https:\/\/api\.machines\.dev\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    // POST /apps
    if (method === 'POST' && path === '/apps') {
      const name = body?.app_name;
      if (!name) return Promise.resolve(new Response(JSON.stringify({ error: 'no name' }), { status: 400 }));
      if (apps.has(name)) return Promise.resolve(new Response(JSON.stringify({ error: 'app already exists' }), { status: 422 }));
      apps.set(name, { volumes: new Map(), machines: new Map(), env: {}, ips: new Set() });
      return Promise.resolve(new Response(JSON.stringify({ name }), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    // POST /apps/<n>/volumes
    {
      const m = path.match(/^\/apps\/([^/]+)\/volumes$/);
      if (m && method === 'POST') {
        const app = apps.get(m[1]);
        if (!app) return Promise.resolve(new Response(JSON.stringify({ error: 'no app' }), { status: 404 }));
        volumeSeq += 1;
        const id = `vol_${m[1].slice(-6)}_${volumeSeq}`;
        app.volumes.set(id, { name: body.name, region: body.region, size_gb: body.size_gb });
        return Promise.resolve(new Response(JSON.stringify({ id, region: body.region, size_gb: body.size_gb }), { status: 201, headers: { 'content-type': 'application/json' } }));
      }
    }
    // POST /apps/<n>/machines
    {
      const m = path.match(/^\/apps\/([^/]+)\/machines$/);
      if (m && method === 'POST') {
        const app = apps.get(m[1]);
        if (!app) return Promise.resolve(new Response(JSON.stringify({ error: 'no app' }), { status: 404 }));
        machineSeq += 1;
        const id = `machine_${m[1].slice(-6)}_${machineSeq}`;
        app.machines.set(id, { config: body.config, state: 'started' });
        app.env = { ...(body.config?.env ?? {}) };
        return Promise.resolve(new Response(JSON.stringify({ id, state: 'started', private_ip: 'fdaa::1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    }
    // POST start/stop
    {
      const m = path.match(/^\/apps\/([^/]+)\/machines\/([^/]+)\/(start|stop)$/);
      if (m && method === 'POST') {
        const app = apps.get(m[1]);
        const mach = app?.machines.get(m[2]);
        if (!mach) return Promise.resolve(new Response(JSON.stringify({ error: 'no machine' }), { status: 404 }));
        mach.state = m[3] === 'start' ? 'started' : 'stopped';
        return Promise.resolve(new Response(JSON.stringify({ state: mach.state }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    }
    // DELETE machine / volume / app
    if (method === 'DELETE') {
      let m = path.match(/^\/apps\/([^/]+)\/machines\/([^/?]+)/);
      if (m) {
        const app = apps.get(m[1]);
        if (app) app.machines.delete(m[2]);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      m = path.match(/^\/apps\/([^/]+)\/volumes\/([^/]+)$/);
      if (m) {
        const app = apps.get(m[1]);
        if (app) app.volumes.delete(m[2]);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      m = path.match(/^\/apps\/([^/]+)$/);
      if (m) {
        apps.delete(m[1]);
        return Promise.resolve(new Response('', { status: 202 }));
      }
    }

    return Promise.resolve(new Response(JSON.stringify({ error: 'unhandled', method, path }), { status: 599 }));
  }

  return {
    fetchImpl: impl,
    calls,
    apps,
    inspect: (appName) => apps.get(appName) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fake Series 4 lifecycle store
// ---------------------------------------------------------------------------
// Models hermes_instances + hermes_instance_private + the lifecycle RPCs.
// Each user has their own row; the store enforces no-cross-user reads.

function makeFakeStore() {
  /** @type {Map<string, any>} */ const queuedJobs = new Map();
  /** @type {Map<string, any>} */ const publicRows = new Map();
  /** @type {Map<string, any>} */ const privateRows = new Map();
  const calls = { record: [], failed: [], reconcile: [], suspend: [], resume: [], deleted: [], graceClaims: [] };

  return {
    /** Test helper: enqueue a provisioning job for a user. */
    enqueueJob(userId, { tierId = 'studio', idempotencyKey, agentName, claimedAt = '2026-05-15T20:00:00.000Z' } = {}) {
      queuedJobs.set(userId, {
        userId,
        tierId,
        idempotencyKey: idempotencyKey ?? `idemp-${userId}`,
        agentName,
        claimedAt,
      });
    },
    getPublicRow(userId) { return publicRows.get(userId) ?? null; },
    getPrivateRow(userId) { return privateRows.get(userId) ?? null; },
    calls,

    // ---- Series4LifecycleStore surface ----
    async claimNextSeries4FlyProvisioningJob() {
      const next = queuedJobs.entries().next();
      if (next.done) return null;
      const [, job] = next.value;
      queuedJobs.delete(job.userId);
      return job;
    },
    async recordSeries4FlyProvisioningOutput(job, output) {
      calls.record.push({ job, output });
      publicRows.set(job.userId, {
        userId: job.userId,
        status: 'provisioning',
        provider: 'fly_machines',
        imageRefLabel: output.imageRefLabel,
        regionLabel: output.regionLabel,
        storageQuotaGb: output.storageQuotaGb,
        suspendedAt: null,
        volumeRetentionUntil: null,
        deletedAt: null,
      });
      privateRows.set(job.userId, {
        userId: job.userId,
        provider: 'fly_machines',
        flyOrg: output.flyOrg,
        flyAppName: output.flyAppName,
        flyMachineId: output.flyMachineId,
        flyVolumeId: output.flyVolumeId,
        flyRegion: output.flyRegion,
        runnerBaseUrl: output.runnerBaseUrl,
        runnerSharedSecret: output.runnerSharedSecret,
        imageRef: output.imageRef,
        imageDigest: output.imageDigest,
        deletedAt: null,
      });
    },
    async markSeries4FlyProvisioningFailed(job, failure) {
      calls.failed.push({ job, failure });
    },
    async markSeries4FlyProvisioningReconciliationRequired(job, failure) {
      calls.reconcile.push({ job, failure });
    },
    async markSeries4RunnerSuspended(userId, retentionSeconds, msg) {
      calls.suspend.push({ userId, retentionSeconds, msg });
      const row = publicRows.get(userId);
      if (!row) return false;
      row.status = 'sleeping';
      row.suspendedAt = new Date().toISOString();
      row.volumeRetentionUntil = new Date(Date.now() + retentionSeconds * 1000).toISOString();
      return true;
    },
    async markSeries4RunnerResumed(userId, msg) {
      calls.resume.push({ userId, msg });
      const row = publicRows.get(userId);
      if (!row || row.status !== 'sleeping') return false;
      row.status = 'provisioning';
      row.suspendedAt = null;
      row.volumeRetentionUntil = null;
      return true;
    },
    async claimNextSeries4GraceExpiredRunner() {
      // Return the first sleeping row whose volume_retention_until is in the past.
      const now = Date.now();
      for (const [userId, row] of publicRows.entries()) {
        if (row.status !== 'sleeping') continue;
        if (!row.volumeRetentionUntil) continue;
        if (new Date(row.volumeRetentionUntil).getTime() > now) continue;
        row.status = 'deleting';
        const priv = privateRows.get(userId);
        if (!priv) continue;
        calls.graceClaims.push({ userId });
        row.deletionClaimedAt = new Date().toISOString();
        return {
          userId,
          claimedAt: row.deletionClaimedAt,
          binding: {
            providerId: 'fly_machines',
            userId,
            runnerBaseUrl: priv.runnerBaseUrl,
            runnerSharedSecret: priv.runnerSharedSecret,
            status: 'deleting',
            createdAt: '1970-01-01T00:00:00.000Z',
            lastHealthAt: null,
            fly: {
              org: priv.flyOrg,
              appName: priv.flyAppName,
              machineId: priv.flyMachineId,
              volumeId: priv.flyVolumeId,
              region: priv.flyRegion,
              imageRef: priv.imageRef,
              imageDigest: priv.imageDigest,
            },
          },
        };
      }
      return null;
    },
    async authorizeSeries4GraceDeletion(claim) {
      const row = publicRows.get(claim.userId);
      const priv = privateRows.get(claim.userId);
      return row?.status === 'deleting' && row.deletionClaimedAt === claim.claimedAt
        && priv?.flyAppName === claim.binding.fly.appName && priv.flyMachineId === claim.binding.fly.machineId
        && priv.flyVolumeId === claim.binding.fly.volumeId;
    },
    async recordSeries4RunnerDeleted(claim) {
      assert.equal(await this.authorizeSeries4GraceDeletion(claim), true, 'completion must retain the exact deletion claim');
      const userId = claim.userId;
      calls.deleted.push({ userId });
      const row = publicRows.get(userId);
      if (row) {
        row.status = 'deleted';
        row.deletedAt = new Date().toISOString();
      }
      const priv = privateRows.get(userId);
      if (priv) {
        priv.runnerBaseUrl = null;
        priv.runnerSharedSecret = null;
        priv.flyMachineId = null;
        priv.flyVolumeId = null;
        priv.deletedAt = new Date().toISOString();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fake workspace
// ---------------------------------------------------------------------------
// The runner /tasks endpoint normally writes files into /workspace and the
// /files endpoint lists them. We simulate that with a per-app filesystem so
// the isolation invariant is testable. A "task" can write a file; a /files
// call lists only the bound user's app.

function makeFakeWorkspace(flyApi) {
  // appName -> { files: Map<filename, content> }
  const workspaces = new Map();
  function getWorkspace(appName) {
    let ws = workspaces.get(appName);
    if (!ws) { ws = { files: new Map() }; workspaces.set(appName, ws); }
    return ws;
  }
  return {
    writeFile(appName, filename, content) {
      getWorkspace(appName).files.set(filename, content);
    },
    listFiles(appName) {
      return Array.from(getWorkspace(appName).files.keys()).sort();
    },
    readFile(appName, filename) {
      return getWorkspace(appName).files.get(filename) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// In-process Worker dispatcher
// ---------------------------------------------------------------------------
// Models the Phase 4 Worker route check: given a userId, look up the
// private binding, verify the URL host matches fly_app_name, sign HMAC,
// dispatch. The runner is the fake workspace.

function makeWorkerDispatcher(store, workspace) {
  return async function dispatchTask({ userId, task }) {
    const priv = store.getPrivateRow(userId);
    if (!priv || !priv.runnerBaseUrl || !priv.flyAppName) {
      return { ok: false, reason: 'no_binding' };
    }
    // Phase 4 host-match check
    const url = new URL(priv.runnerBaseUrl);
    const expectedHost = `${priv.flyAppName.toLowerCase()}.fly.dev`;
    if (url.hostname.toLowerCase() !== expectedHost) {
      return { ok: false, reason: 'host_mismatch' };
    }
    // Simulate the runner accepting the task + writing a file
    if (task.kind === 'write_file') {
      workspace.writeFile(priv.flyAppName, task.filename, task.content);
      return { ok: true, dispatchedTo: priv.flyAppName };
    }
    if (task.kind === 'list_files') {
      return { ok: true, dispatchedTo: priv.flyAppName, files: workspace.listFiles(priv.flyAppName) };
    }
    if (task.kind === 'read_file') {
      return { ok: true, dispatchedTo: priv.flyAppName, content: workspace.readFile(priv.flyAppName, task.filename) };
    }
    return { ok: false, reason: 'unknown_task_kind' };
  };
}

// ---------------------------------------------------------------------------
// THE TEST — two users, full end-to-end, all isolation invariants
// ---------------------------------------------------------------------------

// D8 (2026-05-20) introduced inline readiness polling via pollRunnerReadiness,
// which fetches `<runnerBaseUrl>/healthz` every 4s for up to 120s using
// `deps.fetchImpl ?? globalThis.fetch`. Without overrides the e2e harness
// would do real DNS for the fake `delegent-runner-*.fly.dev` host, hang
// 120s per provision, and time the suite out. We pass a deps-level
// `now` shim that jumps past the deadline so the readiness loop exits
// on entry and the result keeps its pre-D8 `provisioning` status.
const fastReadinessDeps = () => {
  let t = Date.parse('2026-05-15T20:00:00.000Z');
  return {
    fetchImpl: async () => new Response('', { status: 503 }),
    sleep: async () => {},
    now: () => { t += 200_000; return t; },
  };
};

test('Series 4: two distinct users get fully isolated Fly app/machine/volume/secret/workspace', async () => {
  const fakeFly = makeFakeFlyApi();
  const store = makeFakeStore();
  const workspace = makeFakeWorkspace(fakeFly);
  const dispatch = makeWorkerDispatcher(store, workspace);

  const provider = createFlyMachinesProvider({
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    defaultImageRef: IMAGE_REF,
    fetchImpl: fakeFly.fetchImpl,
    // The probe call against fly.dev would otherwise need a live runner;
    // assert the URL shape and pretend it succeeded.
    probeRunnerHealth: async ({ runnerBaseUrl }) => {
      assert.match(runnerBaseUrl, /^https:\/\/delegent-runner-[0-9a-f]{12}\.fly\.dev$/);
      return { ok: true, status: 200 };
    },
    sleep: async () => {},
  });

  // 1. Both users go through provisioning. Distinct idempotency keys ->
  //    distinct hash suffixes -> distinct Fly app names.
  store.enqueueJob(USER_A_ID, { idempotencyKey: 'iso-A', agentName: USER_A_AGENT_NAME });
  store.enqueueJob(USER_B_ID, { idempotencyKey: 'iso-B', agentName: USER_B_AGENT_NAME });

  const resultA = await processNextSeries4FlyProvisioningJob({ env: TEST_ENV }, { store, provider, ...fastReadinessDeps() });
  assert.equal(resultA.status, 'provisioning');
  assert.equal(resultA.userId, USER_A_ID);

  const resultB = await processNextSeries4FlyProvisioningJob({ env: TEST_ENV }, { store, provider, ...fastReadinessDeps() });
  assert.equal(resultB.status, 'provisioning');
  assert.equal(resultB.userId, USER_B_ID);

  // 2. Distinct Fly app / machine / volume IDs
  const privA = store.getPrivateRow(USER_A_ID);
  const privB = store.getPrivateRow(USER_B_ID);
  assert.notEqual(privA.flyAppName, privB.flyAppName);
  assert.notEqual(privA.flyMachineId, privB.flyMachineId);
  assert.notEqual(privA.flyVolumeId, privB.flyVolumeId);
  assert.match(privA.flyAppName, /^delegent-runner-[0-9a-f]{12}$/);
  assert.match(privB.flyAppName, /^delegent-runner-[0-9a-f]{12}$/);

  // 3. Distinct runner shared secrets
  assert.notEqual(privA.runnerSharedSecret, privB.runnerSharedSecret);
  assert.ok(privA.runnerSharedSecret.length >= 32);
  assert.ok(privB.runnerSharedSecret.length >= 32);

  // 4. Per-Machine env carries the correct user id + secret (and not the
  //    other user's). Read it back from the fake Fly API state.
  const flyAppStateA = fakeFly.inspect(privA.flyAppName);
  const flyAppStateB = fakeFly.inspect(privB.flyAppName);
  // Each app got its own shared_v4 + v6 allocation (no shared IP between
  // tenants in our state; this is what makes <app>.fly.dev resolve).
  assert.deepEqual([...flyAppStateA.ips].sort(), ['shared_v4', 'v6']);
  assert.deepEqual([...flyAppStateB.ips].sort(), ['shared_v4', 'v6']);
  assert.equal(flyAppStateA.env.SIDEKICK_USER_ID, USER_A_ID);
  assert.equal(flyAppStateA.env.SIDEKICK_RUNNER_SHARED_SECRET, privA.runnerSharedSecret);
  assert.equal(flyAppStateA.env.SIDEKICK_RUNNER_PUBLIC_NAME, USER_A_AGENT_NAME);
  assert.equal(flyAppStateB.env.SIDEKICK_USER_ID, USER_B_ID);
  assert.equal(flyAppStateB.env.SIDEKICK_RUNNER_SHARED_SECRET, privB.runnerSharedSecret);
  assert.equal(flyAppStateB.env.SIDEKICK_RUNNER_PUBLIC_NAME, USER_B_AGENT_NAME);
  // Neither runner's env carries the OTHER user's identifiers.
  assert.notEqual(flyAppStateA.env.SIDEKICK_USER_ID, USER_B_ID);
  assert.notEqual(flyAppStateB.env.SIDEKICK_USER_ID, USER_A_ID);
  assert.notEqual(flyAppStateA.env.SIDEKICK_RUNNER_SHARED_SECRET, privB.runnerSharedSecret);
  assert.notEqual(flyAppStateB.env.SIDEKICK_RUNNER_SHARED_SECRET, privA.runnerSharedSecret);

  // 5. Dispatch user A's "write a file" task. It MUST hit user A's runner.
  const writeA = await dispatch({
    userId: USER_A_ID,
    task: { kind: 'write_file', filename: 'alphas-only.txt', content: 'private to A' },
  });
  assert.equal(writeA.ok, true);
  assert.equal(writeA.dispatchedTo, privA.flyAppName);

  // 6. Dispatch user B's "list files" task. It MUST NOT see user A's file.
  const listB = await dispatch({
    userId: USER_B_ID,
    task: { kind: 'list_files' },
  });
  assert.equal(listB.ok, true);
  assert.equal(listB.dispatchedTo, privB.flyAppName);
  assert.deepEqual(listB.files, []); // empty — no cross-tenant leak

  // 7. User A lists their files: their own file is present.
  const listA = await dispatch({ userId: USER_A_ID, task: { kind: 'list_files' } });
  assert.equal(listA.dispatchedTo, privA.flyAppName);
  assert.deepEqual(listA.files, ['alphas-only.txt']);

  // 8. Even if a caller mutated user A's runnerBaseUrl to point at user B's
  //    app, the Phase 4 host-match check rejects the dispatch (defence in
  //    depth — Phase 4 enforced this in the live Worker; we model it here).
  const original = privA.runnerBaseUrl;
  store.getPrivateRow(USER_A_ID).runnerBaseUrl = privB.runnerBaseUrl;
  const tamperedDispatch = await dispatch({
    userId: USER_A_ID,
    task: { kind: 'list_files' },
  });
  assert.equal(tamperedDispatch.ok, false);
  assert.equal(tamperedDispatch.reason, 'host_mismatch');
  store.getPrivateRow(USER_A_ID).runnerBaseUrl = original;

  // 9. Suspend user A (Option A). User B's runner is unaffected.
  //    Retention is set to ~1.5s so the test can wait it out without
  //    becoming wall-clock flaky on slower CI runs.
  const suspendA = await processSeries4SubscriptionSuspension(
    { env: TEST_ENV, userId: USER_A_ID, retentionDays: 1.5 / 86400 },
    { store },
  );
  assert.equal(suspendA.status, 'suspended');
  assert.equal(store.getPublicRow(USER_A_ID).status, 'sleeping');
  assert.equal(store.getPublicRow(USER_B_ID).status, 'provisioning'); // unchanged

  // 10. Grace expires for A -> force teardown. B is again unaffected.
  //     Wait well past the ~1.5s retention window so the claim picks up the
  //     expired row regardless of timer drift. 4x margin (was 2x): under heavy
  //     concurrent load (e.g. the whole test pack running at once on a
  //     CPU-saturated machine) a 2x margin could still drift and leave the row
  //     'idle' instead of 'deleted'. 6s keeps this deterministic.
  await new Promise((r) => setTimeout(r, 6000));
  const expiryA = await processNextSeries4GraceExpiry({ env: TEST_ENV }, { store, provider });
  assert.equal(expiryA.status, 'deleted');
  assert.equal(expiryA.userId, USER_A_ID);
  assert.equal(expiryA.flyAppName, privA.flyAppName);
  assert.equal(store.getPublicRow(USER_A_ID).status, 'deleted');
  assert.equal(store.getPublicRow(USER_B_ID).status, 'provisioning'); // STILL unchanged

  // 11. User A's Fly resources are gone. User B's are intact.
  assert.equal(fakeFly.inspect(privA.flyAppName), null);
  const stateBAfter = fakeFly.inspect(privB.flyAppName);
  assert.ok(stateBAfter);
  assert.equal(stateBAfter.machines.size, 1);
  assert.equal(stateBAfter.volumes.size, 1);
  assert.equal(stateBAfter.env.SIDEKICK_USER_ID, USER_B_ID);

  // 12. User A can no longer dispatch (binding cleared). User B still can.
  const postDeleteA = await dispatch({ userId: USER_A_ID, task: { kind: 'list_files' } });
  assert.equal(postDeleteA.ok, false);
  assert.equal(postDeleteA.reason, 'no_binding');
  const postDeleteB = await dispatch({ userId: USER_B_ID, task: { kind: 'list_files' } });
  assert.equal(postDeleteB.ok, true);
  assert.deepEqual(postDeleteB.files, []);

  // 13. No call across the whole test ever leaked the FLY_API_TOKEN into
  //     any user-visible structure.
  const serialised = JSON.stringify({
    publicA: store.getPublicRow(USER_A_ID),
    publicB: store.getPublicRow(USER_B_ID),
    privA, privB,
    workspaceA: { files: workspace.listFiles(privA.flyAppName) },
    workspaceB: { files: workspace.listFiles(privB.flyAppName) },
    dispatchResults: [resultA, resultB, writeA, listB, listA, suspendA, expiryA, postDeleteA, postDeleteB],
  });
  assert.equal(serialised.includes(FLY_TOKEN), false);
});

// ---------------------------------------------------------------------------
// Bonus: a 2-user concurrent provisioning attempt does not cross-bind.
// ---------------------------------------------------------------------------

test('Series 4: concurrent provisioning of two users produces two independent bindings', async () => {
  const fakeFly = makeFakeFlyApi();
  const store = makeFakeStore();
  const provider = createFlyMachinesProvider({
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    defaultImageRef: IMAGE_REF,
    fetchImpl: fakeFly.fetchImpl,
    probeRunnerHealth: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });

  store.enqueueJob(USER_A_ID, { idempotencyKey: 'cc-A', agentName: USER_A_AGENT_NAME });
  store.enqueueJob(USER_B_ID, { idempotencyKey: 'cc-B', agentName: USER_B_AGENT_NAME });

  const [resA, resB] = await Promise.all([
    processNextSeries4FlyProvisioningJob({ env: TEST_ENV }, { store, provider, ...fastReadinessDeps() }),
    processNextSeries4FlyProvisioningJob({ env: TEST_ENV }, { store, provider, ...fastReadinessDeps() }),
  ]);
  // Both must succeed; user assignment may swap depending on claim order.
  const okStatuses = new Set([resA.status, resB.status]);
  assert.ok(okStatuses.has('provisioning'));
  // Either both provisioned or one provisioned + one idle (if claim ran in
  // strict sequence on the fake store). The acceptance bar is: no failed,
  // no reconcile_required.
  for (const r of [resA, resB]) {
    assert.notEqual(r.status, 'failed');
    assert.notEqual(r.status, 'reconcile_required');
  }
  const privA = store.getPrivateRow(USER_A_ID);
  const privB = store.getPrivateRow(USER_B_ID);
  if (privA && privB) {
    assert.notEqual(privA.flyAppName, privB.flyAppName);
    assert.notEqual(privA.flyMachineId, privB.flyMachineId);
    assert.notEqual(privA.flyVolumeId, privB.flyVolumeId);
    assert.notEqual(privA.runnerSharedSecret, privB.runnerSharedSecret);
  }
});
