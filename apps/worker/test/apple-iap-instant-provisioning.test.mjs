// The Apple activation path, after the runners went away.
//
// HISTORY, because the shape of this file is the history. App Review rejected
// the app on 2026-08-24 ("we were unable to complete an in-app purchase") for
// a reason that had nothing to do with StoreKit: the reviewer paid at 15:04
// and their Fly runner did not exist until 15:37, so they sat on "Preparing
// workspace" for thirty-three minutes and called the app incomplete. The
// instant GitHub workflow_dispatch that made a runner appear in ~60s was gated
// on a Stripe-only event set, so Apple purchases fell through to the hourly
// cron. The fix put APPLE_IAP_ACTIVATION_EVENT in the activation set.
//
// NOW. There are no runners: destroyed and the Fly account closed on
// 2026-09-18, every account on the agent engine, and the workflow's Fly steps
// removed. So the dispatch starts nothing, and on 2026-09-19 it was worse than
// useless: its token is a PAT belonging to an account that lost repo access in
// the ownership move, so GitHub answered 404 and every activation raised two
// Sentry errors and emailed Alex. Jordan and a new trial customer triggered
// exactly that while both were being served perfectly well by the engine.
//
// These tests now pin the opposite contract to the one above: an activation
// must be SILENT. They fail if someone reinstates the dispatch without also
// reinstating runners.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  APPLE_IAP_ACTIVATION_EVENT,
  maybeDispatchProvisionOnActivation,
} from '../dist/stripe.js';

test('an activation dispatches nothing: there is no runner to build', async () => {
  const jobs = [];
  const alerts = [];
  const messages = [];

  await maybeDispatchProvisionOnActivation({
    responseOk: true,
    eventType: APPLE_IAP_ACTIVATION_EVENT,
    env: { GITHUB_DISPATCH_TOKEN: 'ghp_fake_actions_write_token' },
    dispatch: async (_t, _r, job) => {
      jobs.push(job);
      return { ok: true, status: 204 };
    },
    warn: (m) => messages.push(m),
    alert: (d) => alerts.push(d),
  });

  assert.deepEqual(jobs, [], 'no workflow_dispatch: the Fly steps it called were removed on 2026-09-18');
  assert.deepEqual(alerts, [], 'and no alert, which is the noise that reached Alex on 19 Sep');
  assert.deepEqual(messages, [], 'nor a diagnostic about a path that no longer exists');
});

test('a missing token is no longer an alert, because nothing needs the token', async () => {
  const alerts = [];
  await maybeDispatchProvisionOnActivation({
    responseOk: true,
    eventType: APPLE_IAP_ACTIVATION_EVENT,
    env: {},
    alert: (d) => alerts.push(d),
  });
  assert.deepEqual(alerts, [], 'a missing GITHUB_DISPATCH_TOKEN is now a fact, not a fault');
});

test('a FAILED verification still does nothing, and still cannot throw', async () => {
  await maybeDispatchProvisionOnActivation({
    responseOk: false,
    eventType: APPLE_IAP_ACTIVATION_EVENT,
    env: { GITHUB_DISPATCH_TOKEN: 'ghp_fake_actions_write_token' },
    dispatch: async () => {
      throw new Error('a dispatch must never be attempted, let alone throw into the purchase path');
    },
  });
});

test('the Worker holds no GitHub dispatch client any more', () => {
  const source = readFileSync(new URL('../src/stripe.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /api\.github\.com\/repos\/\$\{repo\}\/actions\/workflows/,
    'the dispatch call is gone; reinstating it means reinstating runners AND a token that can see the repo',
  );
  assert.doesNotMatch(source, /triggerProvisionWorkflowDispatch/, 'and its helper with it');
});
