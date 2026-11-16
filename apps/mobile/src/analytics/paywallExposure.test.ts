import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaywallExposure } from './paywallExposure';

test('counts visible paywalls once, including a reopened modal', () => {
  const events: unknown[] = [];
  const observer = createPaywallExposure((...args) => events.push(args));
  observer.update(false, 'menu', 'test');
  assert.equal(events.length, 0);
  observer.update(true, 'menu', 'test');
  observer.update(true, 'menu', 'test');
  assert.equal(events.length, 2);
  observer.update(false, 'menu', 'test');
  observer.update(true, 'menu', 'test');
  assert.equal(events.length, 4);
  observer.dismiss('back');
  observer.dismiss('back');
  assert.deepEqual(events.at(-1), ['paywall_dismissed', { entry_point: 'menu', variant: 'test', reason: 'back' }]);
  assert.equal(events.length, 5);
});

test('closing an unseen/hidden screen is not a dismissal', () => {
  const events: string[] = [];
  const observer = createPaywallExposure((name) => events.push(name));
  observer.dismiss('close');
  observer.update(true, 'onboarding', 'test');
  observer.update(false, 'onboarding', 'test');
  observer.dismiss('close');
  assert.deepEqual(events, ['viewed_plans', 'paywall_seen']);
});
