import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

// Execute the complete component. Only React scheduling and external APIs are
// replaced, so assertions follow the real handlers and their rendered state.
function screen({ entitled = true, response, engine = 'runner' }) {
  const states = [], calls = [], navigations = [];
  let cursor = 0;
  const confirm = () => false;
  const api = async (...args) => { calls.push(args); return response; };
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react: { useEffect() {}, useCallback: fn => fn, useState: initial => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@sidekick/shared': shared,
    '../../components/ui': { Screen: 'Screen', Notice: 'Notice', Spinner: 'Spinner' },
    '../../lib/useRearmOnBack': { useRearmOnBack() {} },
    '../../state/coworkerEngine': { useCoworkerEngine: () => engine },
    '../state/productStateContext': { useProductStateContext: () => ({ status: 'ready', refresh() {}, snapshot: {
      subscription: { status: entitled ? 'active' : 'inactive', tierId: 'studio', billingProvider: 'stripe',
        currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString() },
    } }) },
    './billingApi': { openBillingPortal: api, startCheckout: api },
    './confirmScheduledPlanChange': { confirmScheduledPlanChange: confirm },
  };
  const source = readFileSync(new URL('../src/features/billing/PlanScreen.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'unmocked dependency ' + name); return dependencies[name];
  }, exports);
  const render = () => {
    cursor = 0; const tree = exports.PlanScreen(), nodes = [];
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object') { nodes.push(node); visit(node.props?.children); }
    };
    visit(tree);
    return { nodes,
      agentCard: nodes.find(n => typeof n.type === 'function' && n.type.name === 'AgentPlanCard'),
      card: id => nodes.find(n => n.props?.tier?.id === id),
      manage: nodes.find(n => n.type === 'button' && n.props.className === 'btn-secondary mt-2 w-full') };
  };
  return { render, calls, confirm, navigations };
}

test('the subscribed screen sends the selected tier and confirmation callback; cancel rearms its controls', async () => {
  const plan = screen({ response: { ok: true, kind: 'canceled' } });
  assert.equal(plan.render().card('pro-office').props.entitled, true);
  assert.equal(plan.render().card('pro-office').props.isCurrent, false);
  plan.render().card('pro-office').props.onSwitch();
  assert.equal(plan.render().card('pro-office').props.disabled, true);
  await new Promise(setImmediate);
  assert.deepEqual(plan.calls, [['pro-office', plan.confirm]]);
  assert.equal(plan.render().card('pro-office').props.disabled, false);
  assert.equal(plan.render().manage.props.disabled, false);
});

test('checkout, tier changes and ordinary billing keep buttons disabled until navigation and rearm on failure', async () => {
  const originalWindow = globalThis.window;
  try {
    for (const action of ['checkout', 'switch', 'manage']) {
      for (const success of [true, false]) {
        const url = 'https://billing.stripe.com/p/session/bps_fixture';
        const plan = screen({ entitled: action !== 'checkout', response: success
          ? { ok: true, kind: 'redirect', url } : { ok: false, message: 'fixture failure' } });
        globalThis.window = { location: { assign: value => plan.navigations.push(value) } };
        const view = plan.render();
        if (action === 'manage') view.manage.props.onClick();
        else view.card('pro-office').props[action === 'switch' ? 'onSwitch' : 'onPick']();
        assert.equal(plan.render().card('pro-office').props.disabled, true);
        await new Promise(setImmediate);
        assert.equal(plan.render().card('pro-office').props.disabled, success);
        assert.deepEqual(plan.navigations, success ? [url] : []);
        if (action === 'manage') assert.deepEqual(plan.calls, [[]], 'ordinary billing must not name a target or confirmation');
      }
    }
  } finally { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('an agent-engine account is shown one plan that leads with the free month, and buys that plan', async () => {
  // The web app used to render the three workspace tiers to everybody, priced
  // from the workspace list, while the server charged the agent plan. The page
  // now reports what is actually sold.
  const plan = screen({ entitled: false, engine: 'agent', response: { ok: true, kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/fixture' } });
  const originalWindow = globalThis.window;
  globalThis.window = { location: { assign: value => plan.navigations.push(value) } };
  try {
    const view = plan.render();
    assert.ok(view.agentCard, 'an agent-engine account sees the agent plan card');
    assert.equal(view.card('pro-office'), undefined, 'and is not offered a workspace tier');

    // The mocked jsx does not render nested components, so render this one.
    const text = JSON.stringify(view.agentCard.type(view.agentCard.props));
    assert.ok(text.includes(shared.AGENT_PLAN_HEADLINE_OFFER), 'the offer leads');
    assert.ok(text.includes(shared.agentPlanThenLine()), 'the price follows it, still on screen');
    assert.ok(text.includes(shared.agentFreeTrialTermsLine()), 'the renewal terms stay where the purchase happens');

    view.agentCard.props.onPick();
    await new Promise(setImmediate);
    assert.deepEqual(plan.calls, [[shared.AGENT_PLAN.tierId]], 'it buys the agent plan');
    assert.deepEqual(plan.navigations, ['https://checkout.stripe.com/c/pay/fixture']);
  } finally { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});

test('a workspace account is untouched by the agent plan card', () => {
  const plan = screen({ entitled: false, response: { ok: true } });
  const view = plan.render();
  assert.equal(view.agentCard, undefined);
  assert.ok(view.card('pro-office'), 'the workspace tiers still render');
});
