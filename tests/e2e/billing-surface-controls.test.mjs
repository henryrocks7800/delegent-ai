// Which billing controls a surface offers, executed against the real screen.
//
// An Apple subscriber opening the web app is an ordinary supported state: the
// same account works on both surfaces. The page had no idea. It rendered an
// enabled "Cancel or manage billing", called Stripe, got a 409 for a customer
// id that does not exist, and told somebody who is already paying to "choose a
// plan first". Nothing on the page mentioned Apple.
//
// The phone had already been fixed for the mirror-image case on 2026-09-12, so
// this also checks that both surfaces now read the same rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as shared from '@sidekick/shared';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

function compile(source, dependencies = {}, globals = {}, fileName = 'fixture.tsx') {
  const code = ts.transpileModule(source, { fileName, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(globals), code)(name => {
    if (name === '@sidekick/shared') return shared;
    assert.ok(Object.hasOwn(dependencies, name), 'unmocked dependency ' + name);
    return dependencies[name];
  }, exports, ...Object.values(globals));
  return exports;
}

const jsx = (type, props, key) => ({ type, props, key });

/** The complete PlanScreen, with React scheduling and the API supplied here. */
function planScreen({ billingProvider, status = 'active' } = {}) {
  const slots = [];
  let cursor = 0;
  const portalCalls = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect() {},
    useCallback: fn => fn,
  };
  // An Apple entitlement is bounded by its verified service deadline rather
  // than by the Stripe period, so both have to be set for the row to read as
  // entitled at all.
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = {
    subscription: {
      status,
      tierId: 'studio',
      currentPeriodEnd: future,
      serviceAccessUntil: future,
      ...(billingProvider ? { billingProvider } : {}),
    },
  };
  const component = compile(read('apps/webapp/src/features/billing/PlanScreen.tsx'), {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../../components/ui': { Notice: 'Notice', Screen: 'Screen', Spinner: 'Spinner' },
    '../../lib/useRearmOnBack': { useRearmOnBack() {} },
    // This surface is the workspace plan picker; an agent-engine account is
    // covered by apps/webapp/test/plan-screen-handlers.test.mjs.
    '../../state/coworkerEngine': { useCoworkerEngine: () => 'runner' },
    '../state/productStateContext': { useProductStateContext: () => ({ status: 'ready', snapshot, refresh() {} }) },
    './billingApi': {
      async openBillingPortal(...args) { portalCalls.push(args); return { ok: false, message: 'Choose a plan first, then billing can manage changes.' }; },
      async startCheckout() { return { ok: false, message: 'unused' }; },
    },
    './confirmScheduledPlanChange': { confirmScheduledPlanChange: async () => true },
  }).PlanScreen;

  const render = () => {
    cursor = 0;
    const tree = component({});
    const nodes = [];
    const texts = [];
    const visit = node => {
      if (typeof node === 'string') { texts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object') { nodes.push(node); visit(node.props?.children); }
    };
    visit(tree);
    return {
      nodes, text: texts.join(' '),
      byId: id => nodes.find(node => node.props?.['data-testid'] === id),
      buttons: nodes.filter(node => node.type === 'button'),
    };
  };
  return { render, portalCalls };
}

test('an Apple subscriber on the web is told where their subscription lives, not sent to Stripe', async () => {
  const apple = planScreen({ billingProvider: 'apple' });
  const view = apple.render();

  assert.ok(view.byId('plan.billingElsewhere'), 'the page has to mention Apple at all');
  assert.match(view.byId('plan.billingElsewhere').props.children, /Apple holds this subscription/);
  assert.match(view.byId('plan.billingElsewhere').props.children, /Settings, tap your name, then Subscriptions/);
  assert.equal(view.byId('plan.manageElsewhere').props.href, shared.APPLE_MANAGE_SUBSCRIPTIONS_URL);

  // The control that used to fail is gone, not merely disabled: a disabled
  // button with no explanation is the same dead end with less information.
  const manage = view.buttons.filter(node => /Cancel or manage billing|Opening/.test(String(node.props.children)));
  assert.deepEqual(manage, [], 'no Stripe portal control may be offered for an Apple plan');
  // The tier cards are their own component, so the flag they are handed is
  // where this is observable from here.
  const cards = view.nodes.filter(node => node.props?.tier);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => card.props.canChangeTier === false),
    'no tier change may be offered that this surface cannot make');
  assert.equal(apple.portalCalls.length, 0, 'nothing may reach Stripe for an account it does not bill');
  // And the line under the controls no longer names the wrong company.
  assert.match(view.text, /Payment is handled by Apple/);
  assert.doesNotMatch(view.text, /Payment is handled by Stripe/);
});

test('a Stripe subscriber keeps every control, and so does an account whose provider is unknown', async () => {
  for (const billingProvider of ['stripe', undefined]) {
    const view = planScreen({ billingProvider }).render();
    assert.equal(view.byId('plan.billingElsewhere'), undefined, String(billingProvider));
    const manage = view.buttons.filter(node => /Cancel or manage billing/.test(String(node.props.children)));
    assert.equal(manage.length, 1, 'the cancel route must stay reachable: ' + billingProvider);
    const cards = view.nodes.filter(node => node.props?.tier);
    assert.ok(cards.every(card => card.props.canChangeTier === true), String(billingProvider));
    assert.match(view.text, /Payment is handled by Stripe/);
  }
});

test('the rule is the same rule on both surfaces, refusing only on a positive mismatch', () => {
  const { billingControlsFor } = shared;
  // Unknown is not a mismatch. Treating it as one is what hid the phone's own
  // cancel button on 2026-09-12 and printed a note that was false.
  for (const surface of ['stripe', 'apple']) {
    assert.equal(billingControlsFor(surface, undefined).canManage, true, surface);
    assert.equal(billingControlsFor(surface, undefined).notice, null, surface);
  }
  assert.equal(billingControlsFor('stripe', 'stripe').canManage, true);
  assert.equal(billingControlsFor('apple', 'apple').canManage, true);
  assert.equal(billingControlsFor('stripe', 'apple').canManage, false);
  assert.equal(billingControlsFor('apple', 'stripe').canManage, false);
  // Somebody with no subscription at all is being offered buy buttons, not
  // management, so there is nothing to explain.
  assert.equal(billingControlsFor('stripe', 'apple', { entitled: false }).notice, null);
  // Each refusal names where the subscription actually is.
  assert.match(billingControlsFor('stripe', 'apple').notice, /Apple/);
  assert.match(billingControlsFor('apple', 'stripe').notice, /on the web/);
  assert.equal(billingControlsFor('apple', 'stripe').manageUrl, null, 'no link we cannot honestly offer');
});

test('the phone reads the shared rule rather than its own copy of it', () => {
  const source = read('apps/mobile/App.tsx');
  const body = source.match(/function canReachOwnBiller[\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'canReachOwnBiller should still exist');
  assert.match(body, /billingControlsFor\(/, 'the rule has one home now');
  // The shape that caused the defect, spelled out so it cannot come back.
  assert.doesNotMatch(body, /usesStoreKit\(\) === \(/,
    'equality against a provider treats unknown as a mismatch, which is the bug');
});

test('the pricing page no longer promises an archive that does not exist', () => {
  const source = read('apps/website/src/sections/Pricing.tsx');
  assert.doesNotMatch(source, /archived for 30/, 'there is no thirty-day downgrade archive');
  // 2026-09-15: the site sells one plan, so there is no downgrade to describe.
  // What it must say is what cancelling does: access runs to the end of the
  // month already paid for.
  assert.doesNotMatch(source, /downgrade/i);
  assert.match(source, /keep your access\s*\n?\s*until the end of the month you have paid for/);
});
