import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

// Run the complete client modules with native auth/browser API boundaries
// replaced. No excerpts or source-string substitutions stand in for behavior.
function loadClient(relative, dependencies) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = name => {
    if (name === '@sidekick/shared') return shared;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error('Unmocked client dependency: ' + name);
  };
  new Function('require', 'exports', code)(require, exports);
  return exports;
}

const refusals = [
  ['purchase_pending', 409, 'purchase_pending'], ['purchase_pending', 503, 'purchase_pending'],
  ['subscription_payment_pending', 409, 'purchase_pending'], ['purchase_requires_review', 409, 'purchase_requires_review'],
];

test('mobile checkout keeps pending/reconciliation distinct from an active plan or a failed payment', async () => {
  const client = loadClient('../../apps/mobile/src/billing/mobileCheckout.ts', {
    '../auth/generatedExpoPublicEnv': { generatedExpoPublicEnv: {} },
    '../auth/supabaseClient': { mobileSupabase: null, getRememberedMobileAccessToken: () => null },
  });
  const request = (code, status) => client.requestStripeCheckout({ tierId: 'studio', apiBaseUrl: 'https://fixture.test',
    client: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture_token', expires_at: Date.now()/1000+3600 } } }) } },
    fetchImpl: async () => Response.json({ error: code }, { status }),
  });
  for (const [code, status, reason] of refusals) {
    const result = await request(code, status);
    assert.equal(result.error.reason, reason);
    assert.equal(result.error.message, shared.purchaseCoordinationNotice(code).message);
    assert.equal(result.checkout, undefined);
    assert.doesNotMatch(result.error.message, /already (active|subscribed)|payment (failed|went through)/i);
  }
  assert.equal((await request('unrecognised_conflict', 409)).error.reason, 'unavailable');
  assert.equal((await request('subscription_already_active', 409)).error.reason, 'checkout_refused');
});

test('browser checkout preserves pending/reconciliation copy even for HTTP 503', async () => {
  let code, status;
  const client = loadClient('../../apps/webapp/src/features/billing/billingApi.ts', {
    '../../lib/api': {
      apiFetch: async () => ({ ok: false, serverCode: code, status }),
      isFailure: result => !result.ok,
    },
  });
  for ([code, status] of refusals) {
    const result = await client.startCheckout('studio');
    assert.equal(result.ok, false);
    assert.equal(result.message, shared.purchaseCoordinationNotice(code).message);
    assert.equal(result.staleSubscription, false);
    assert.equal(result.paymentRequired, false);
    assert.equal(result.url, undefined);
  }
});

const acknowledgement = { token: 'a'.repeat(64), expiresAt: 1_900_000_000 };
const challengeBody = { error: 'billing_scheduled_change_confirmation_required', confirmation: acknowledgement };

test('mobile scheduled-change prompt sends one confirmed retry with the original authentication and no retry on cancel', async () => {
  const client = loadClient('../../apps/mobile/src/billing/mobileCheckout.ts', {
    '../auth/generatedExpoPublicEnv': { generatedExpoPublicEnv: {} },
    '../auth/supabaseClient': { mobileSupabase: null, getRememberedMobileAccessToken: () => null },
  });
  for (const decision of ['approve', 'cancel', 'changed', 'malformed', 'no_prompt']) {
    let currentToken = 'account_A', prompts = 0;
    const calls = [];
    const result = await client.requestStripeBillingPortal({ apiBaseUrl: 'https://fixture.test', targetTierId: 'pro-office',
      client: { auth: { getSession: async () => ({ data: { session: { access_token: currentToken, expires_at: Date.now()/1000+3600 } } }) } },
      ...(decision === 'no_prompt' ? {} : { confirmScheduledChange: async () => {
        prompts++; currentToken = 'account_B'; return decision !== 'cancel';
      } }),
      fetchImpl: async (_url, init) => {
        calls.push({ body: JSON.parse(init.body), authorization: init.headers.authorization });
        if (calls.length === 1) return Response.json(decision === 'malformed' ? { ...challengeBody, confirmation: { token: 'bad' } } : challengeBody, { status: 409 });
        assert.equal(calls.length, 2, 'a changed action must never automatically prompt/retry again');
        return decision === 'changed' ? Response.json({ error: 'billing_scheduled_change_changed' }, { status: 409 })
          : Response.json({ url: 'https://billing.stripe.com/p/session/bps_fixture' });
      },
    });
    assert.equal(calls[0].body.scheduledChangeConfirmation, undefined);
    if (decision === 'approve' || decision === 'changed') {
      assert.equal(prompts, 1); assert.equal(calls.length, 2);
      assert.equal(calls[1].authorization, 'Bearer account_A');
      assert.deepEqual(calls[1].body.scheduledChangeConfirmation, acknowledgement);
      if (decision === 'approve') assert.equal(result.portal.url, 'https://billing.stripe.com/p/session/bps_fixture');
      else assert.equal(result.error.message, shared.SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE);
    } else {
      assert.equal(calls.length, 1);
      assert.equal(prompts, decision === 'cancel' ? 1 : 0);
      if (decision === 'cancel') assert.deepEqual(result, { canceled: true });
      else assert.ok(result.error);
    }
  }
});

test('browser scheduled-change acknowledgement requires a prompt and never retries a changed action twice', async () => {
  for (const decision of ['approve', 'cancel', 'changed', 'malformed', 'no_prompt']) {
    const calls = []; let prompts = 0;
    const client = loadClient('../../apps/webapp/src/features/billing/billingApi.ts', {
      '../../lib/api': { isFailure: result => !result.ok, apiFetch: async (_path, init) => {
        calls.push(init.body);
        if (calls.length === 1) return { ok: false, status: 409, serverCode: challengeBody.error,
          body: decision === 'malformed' ? { confirmation: {} } : challengeBody };
        assert.equal(calls.length, 2);
        return decision === 'changed' ? { ok: false, status: 409, serverCode: 'billing_scheduled_change_changed' }
          : { ok: true, data: { url: 'https://billing.stripe.com/p/session/bps_fixture' } };
      } },
    });
    const result = await client.openBillingPortal('pro-office', decision === 'no_prompt' ? undefined : () => {
      prompts++; return decision !== 'cancel';
    });
    assert.equal(calls[0].scheduledChangeConfirmation, undefined);
    if (decision === 'approve' || decision === 'changed') {
      assert.equal(calls.length, 2); assert.equal(prompts, 1);
      assert.deepEqual(calls[1].scheduledChangeConfirmation, acknowledgement);
      if (decision === 'approve') assert.equal(result.kind, 'redirect');
      else assert.equal(result.message, shared.SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE);
    } else {
      assert.equal(calls.length, 1); assert.equal(prompts, decision === 'cancel' ? 1 : 0);
      if (decision === 'cancel') assert.equal(result.kind, 'canceled'); else assert.equal(result.ok, false);
    }
  }
});

test('native schedule confirmation waits for a button and defaults dismissal to keeping the schedule', async () => {
  for (const action of ['cancel', 'confirm', 'dismiss']) {
    let captured;
    const client = loadClient('../../apps/mobile/src/billing/confirmScheduledPlanChange.ts', {
      'react-native': { Alert: { alert: (...args) => captured = args } },
    });
    let settled = false;
    const result = client.confirmScheduledPlanChange().then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false);
    const [title, body, buttons, options] = captured;
    assert.equal(title, shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.title);
    assert.equal(body, shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.body);
    assert.match(body, /even if you leave Stripe without completing the upgrade/);
    assert.equal(buttons[0].text, shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.cancelLabel);
    assert.equal(buttons[1].text, shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.confirmLabel);
    if (action === 'dismiss') options.onDismiss(); else buttons[action === 'cancel' ? 0 : 1].onPress();
    assert.equal(await result, action === 'confirm');
  }
});

test('browser schedule confirmation presents the same consequences and preserves cancel', () => {
  const previous = globalThis.window;
  try {
    for (const decision of [false, true]) {
      globalThis.window = { confirm: message => {
        assert.equal(message, shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.title + '\n\n' + shared.SCHEDULED_PLAN_CHANGE_CONFIRMATION.body);
        return decision;
      } };
      const client = loadClient('../../apps/webapp/src/features/billing/confirmScheduledPlanChange.ts', {});
      assert.equal(client.confirmScheduledPlanChange(), decision);
    }
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
