import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { AGENT_CONNECTION_CATEGORIES, CONNECTABLE_SERVICES, connectionCategoryGroups } from '@sidekick/shared';
import { CATEGORY_EMOJI, journeyInvitation, onboardingGroups, selectedAppIds, toggleApp } from './appJourney';
import { applePlanOffer } from '../billing/appleOffer';
import { buildConnectionGroups, buildConnectionRows } from '../connections/connections';

test('selection spans categories, removes independently and drops unknown/duplicate values', () => {
  let ids = toggleApp([], 'gmail');
  ids = toggleApp(ids, 'dropbox');
  ids = toggleApp(ids, 'instagram');
  assert.deepEqual(new Set(ids), new Set(['gmail', 'dropbox', 'instagram']));
  assert.deepEqual(new Set(toggleApp(ids, 'gmail')), new Set(['dropbox', 'instagram']));
  assert.deepEqual(selectedAppIds(['gmail', 'gmail', 'unknown', null]), ['gmail']);
  assert.deepEqual(selectedAppIds({ gmail: true }), []);
  assert.deepEqual(toggleApp(ids, 'unknown'), ids);
});

test('the journey uses the same categories, service identities and offered filtering as Connections', () => {
  const groups = buildConnectionGroups(buildConnectionRows([], CONNECTABLE_SERVICES.map((s) => s.id)));
  assert.deepEqual(groups.map((g) => g.category), connectionCategoryGroups().map((g) => g.category));
  assert.equal(groups.flatMap((g) => g.rows).length, CONNECTABLE_SERVICES.length);
  for (const group of groups) {
    assert.ok(CATEGORY_EMOJI[group.category]);
    for (const row of group.rows) assert.equal(row.service, CONNECTABLE_SERVICES.find((s) => s.id === row.service.id));
  }
  assert.deepEqual(buildConnectionGroups(buildConnectionRows([], ['gmail'])).flatMap((g) => g.rows.map((r) => r.service.id)), ['gmail']);
  assert.deepEqual(buildConnectionGroups(buildConnectionRows([], [])), []);
});

test('only eligible trials get a firm free-trial invitation, with no early duration or price', () => {
  const product = { id: 'studio', displayPrice: '£9.99', introductoryPricePaymentModeIOS: 'free-trial', introductoryPriceSubscriptionPeriodIOS: 'day', introductoryPriceNumberOfPeriodsIOS: '3' };
  assert.match(journeyInvitation(true, false).title, /Try.*free/);
  assert.match(journeyInvitation(true, true, applePlanOffer(product, true)).title, /Try.*free/);
  for (const offer of [undefined, applePlanOffer(product, false), applePlanOffer(product, null)]) {
    const copy = journeyInvitation(true, true, offer);
    assert.match(copy.caption, /Apple confirms whether/);
    assert.doesNotMatch(copy.button, /my free trial/);
  }
  const noTrial = journeyInvitation(false, false);
  assert.doesNotMatch(JSON.stringify(noTrial), /free trial/i);
  assert.doesNotMatch(JSON.stringify(journeyInvitation(true, false)), /3.day|9.99/);
});

test('an agent-engine account is invited to its free month, never to an assistant or a 3-day trial', () => {
  const trial = journeyInvitation(true, false, undefined, true);
  assert.equal(trial.title, 'Try your AI coworker free');
  assert.equal(trial.button, 'Continue to my free month');
  const noTrial = journeyInvitation(false, false, undefined, true);
  assert.equal(noTrial.button, 'Meet my coworker');
  for (const copy of [trial, noTrial]) assert.doesNotMatch(JSON.stringify(copy), /assistant|3.day|9\.99/i);
  // Workspace accounts keep their journey exactly.
  assert.deepEqual(journeyInvitation(true, false), journeyInvitation(true, false, undefined, false));
});

test('on iPhone an assistant account gets its free month firmly only once Apple confirms it', () => {
  // The assistant plan's Apple offer (2026-09-16): £3.99, first month free.
  const assistant = { id: 'com.sidekick.v2.assistant.monthly', displayPrice: '£3.99', introductoryPricePaymentModeIOS: 'free-trial', introductoryPriceSubscriptionPeriodIOS: 'month', introductoryPriceNumberOfPeriodsIOS: '1' };
  const confirmed = journeyInvitation(true, true, applePlanOffer(assistant, true), true);
  assert.equal(confirmed.button, 'Continue to my free month');
  for (const offer of [undefined, applePlanOffer(assistant, false), applePlanOffer(assistant, null)]) {
    const copy = journeyInvitation(true, true, offer, true);
    assert.match(copy.caption, /Apple confirms whether the free first month/);
    assert.doesNotMatch(copy.button, /my free month/);
    assert.doesNotMatch(JSON.stringify(copy), /assistant|3.day|trial/i);
  }
  assert.equal(journeyInvitation(false, true, undefined, true).button, 'Meet my coworker');
});

test('an assistant account chooses from the Connections screen groups, in colour, without FreeAgent', () => {
  const all = CONNECTABLE_SERVICES.map((s) => s.id);
  const agent = onboardingGroups(all, true);
  assert.deepEqual(agent.map((g) => g.key), AGENT_CONNECTION_CATEGORIES.filter((c) => c.services.length > 0).map((c) => c.key));
  for (const group of agent) assert.match(group.tint ?? '', /^#[0-9A-F]{6}$/, `${group.key} is coloured`);
  const offered = agent.flatMap((g) => g.rows.map((r) => r.service.id));
  assert.ok(!offered.includes('freeagent'));
  assert.equal(offered.length, CONNECTABLE_SERVICES.length - 1);
  // Workspace accounts: the same groups, emoji and rows as before.
  const runner = onboardingGroups(all, false);
  assert.deepEqual(runner.map((g) => g.key), buildConnectionGroups(buildConnectionRows([], all)).map((g) => g.category));
  assert.ok(runner.every((g) => g.tint === undefined && g.emoji === CATEGORY_EMOJI[g.key as keyof typeof CATEGORY_EMOJI]));
});

test('every selectable catalogue ID is accepted by the shipped SQL allowlist', () => {
  const migration = readFileSync(new URL('../../../../supabase/migrations/0075_onboarding_apps.sql', import.meta.url), 'utf8');
  const list = migration.split('id not in (')[1].split(')) then')[0];
  assert.deepEqual(new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])), new Set(CONNECTABLE_SERVICES.map((s) => s.id)));
});
