// What an agent-engine account is offered and told (src/content/agentEngine.ts).
// The agent engine has no workspace, no file store, no routines and no
// Telegram, so nothing shown to these accounts may promise any of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CONNECTION_CATEGORIES,
  AGENT_CONNECTIONS_INTRO,
  AGENT_ENGINE_UNSUPPORTED_CONNECTIONS,
  AGENT_TOP_UP,
  AGENT_USAGE,
  assistantWording,
  formatTopUpPrice,
  AGENT_EVERYDAY_TOOLS,
  AGENT_DATA_COPY_NOTE,
  AGENT_FAQ_ORDERED,
  AGENT_HOWTO_INTRO,
  AGENT_HOWTO_SECTIONS,
  AGENT_HOWTO_TITLE,
  AGENT_PLAN,
  AGENT_PLAN_PRICE_NOTE,
  AGENT_PLAN_SUMMARY,
  AGENT_PLAN_TRIAL_CTA,
  CONNECTABLE_SERVICES,
  agentConnectableServices,
  agentFreeTrialTermsLine,
  agentPlanHighlights,
  agentTopUpConsentBody,
  agentUseCaseCategories,
  formatAgentPlanPrice,
} from '../dist/index.js';

function everyString() {
  return [
    AGENT_HOWTO_TITLE, AGENT_HOWTO_INTRO, AGENT_DATA_COPY_NOTE, agentTopUpConsentBody(),
    AGENT_PLAN_PRICE_NOTE, AGENT_PLAN_SUMMARY, AGENT_PLAN_TRIAL_CTA, agentFreeTrialTermsLine(),
    ...AGENT_HOWTO_SECTIONS.flatMap((section) => [section.title, ...section.body]),
    ...AGENT_FAQ_ORDERED.flatMap((item) => [item.question, item.answer]),
    ...agentPlanHighlights().flatMap((item) => [item.lead, item.text]),
    ...AGENT_EVERYDAY_TOOLS.flatMap((tool) => [tool.title, tool.detail, tool.prompt]),
    AGENT_CONNECTIONS_INTRO,
    ...AGENT_CONNECTION_CATEGORIES.flatMap((category) => [category.title, category.hook]),
    ...agentUseCaseCategories().flatMap((category) => [category.title, category.hook, category.useItTo, category.lead,
      ...category.skills.flatMap((skill) => [skill.name, skill.desc])]),
  ];
}

test('one plan: £3.99 a month, the first month free, 15 minutes of Talk', () => {
  assert.equal(AGENT_PLAN.priceGbpMonthly, 3.99);
  assert.equal(AGENT_PLAN.freeTrialDays, 30);
  assert.equal(AGENT_PLAN.talkMinutesMonthly, 15);
  assert.equal(formatAgentPlanPrice(), '£3.99');
  assert.equal(AGENT_PLAN_TRIAL_CTA, 'Start your free month');
  assert.equal(agentFreeTrialTermsLine(), 'First month free, then £3.99 per month automatically. Cancel before the free month ends to avoid being charged. New subscribers only.');
  assert.match(AGENT_FAQ_ORDERED.find((item) => item.question === 'How much does it cost?').answer, /^One plan: £3\.99 a month, and your first month is free\./);
});

test('connections: everything but FreeAgent, and the highlight counts them honestly', () => {
  assert.deepEqual([...AGENT_ENGINE_UNSUPPORTED_CONNECTIONS], ['freeagent']);
  const offered = agentConnectableServices();
  assert.equal(offered.length, CONNECTABLE_SERVICES.length - 1);
  assert.ok(!offered.some((service) => service.id === 'freeagent'));
  assert.equal(agentPlanHighlights()[0].lead, `${offered.length} apps, one coworker.`);
});

test('nothing promises a workspace, a file store, routines, Telegram or the old trial', () => {
  const claims = [/Files tab/i, /\bRoutines?\b/, /Telegram/, /cloud computer/i, /cloud space/i, /web app at/i, /FreeAgent/, /Monthly capacity/i, /3 days free|3-day/i, /runs on a schedule/i];
  for (const text of everyString()) {
    for (const claim of claims) assert.doesNotMatch(text, claim, `"${text.slice(0, 80)}" claims ${claim}`);
    assert.ok(!text.includes('—'), `em dash in "${text.slice(0, 80)}"`);
  }
});

test('travel is a use case, the phone line is not, and PDFs are the ones the coworker makes', () => {
  const categories = agentUseCaseCategories();
  assert.ok(!categories.some((category) => category.key === 'phone'));
  const travel = categories.find((category) => category.key === 'travel');
  assert.ok(travel, 'travel category');
  assert.ok(travel.skills.length >= 3 && travel.skills.length <= 5, 'three to five spotlighted skills');
  const docs = categories.find((category) => category.key === 'docs');
  assert.ok(docs.skills.some((skill) => skill.name === 'PDFs & photos'));
  for (const category of categories) assert.ok(category.skills.length >= 1);
});

test('the built-in tools are the ones the engine has without a sign-in', () => {
  assert.deepEqual(AGENT_EVERYDAY_TOOLS.map((tool) => tool.id), ['flights', 'hotels', 'things_to_do', 'places', 'shopping', 'web', 'news', 'weather']);
  for (const tool of AGENT_EVERYDAY_TOOLS) assert.ok(tool.prompt.length > 20 && !/\[/.test(tool.prompt), `${tool.id} sends a complete prompt`);
  assert.match(AGENT_FAQ_ORDERED.find((item) => item.question === 'Can it book flights and hotels?').answer, /never pays or books anything itself/);
});

test('Connections: every app and every built-in tool sits in exactly one category', () => {
  const offered = agentConnectableServices().map((service) => service.id).sort();
  const placed = AGENT_CONNECTION_CATEGORIES.flatMap((category) => category.services);
  assert.deepEqual([...placed].sort(), offered, 'each connectable service once, and nothing the engine cannot use');
  assert.equal(new Set(placed).size, placed.length);
  const builtIn = AGENT_CONNECTION_CATEGORIES.flatMap((category) => category.builtIn);
  assert.deepEqual([...builtIn].sort(), AGENT_EVERYDAY_TOOLS.map((tool) => tool.id).sort());
  for (const category of AGENT_CONNECTION_CATEGORIES) {
    assert.ok(category.services.length + category.builtIn.length > 0, `${category.key} is not empty`);
    assert.match(category.tint, /^#[0-9A-F]{6}$/);
  }
  for (const tool of AGENT_EVERYDAY_TOOLS) assert.match(tool.tint, /^#[0-9A-F]{6}$/, `${tool.id} has a coloured tile`);
  for (const category of agentUseCaseCategories()) assert.match(category.tint, /^#[0-9A-F]{6}$/, `Skills: ${category.key} has a coloured tile`);
});

test('the shared connection copy reads as a coworker for every account (Alex, 2026-09-16)', () => {
  // The wording map is the identity now: "coworker" is the word everywhere.
  assert.equal(assistantWording('Let your coworker read your Gmail.'), 'Let your coworker read your Gmail.');
  assert.equal(assistantWording("Your coworker's memory, a coworker of its own"), "Your coworker's memory, a coworker of its own");
  const agentCopy = CONNECTABLE_SERVICES.flatMap((service) => [service.blurb, ...service.capabilities, ...service.permissions,
    ...service.safety.flatMap((line) => [line.heading, line.body]), service.connectedSummary ?? '']).map(assistantWording);
  for (const text of agentCopy) assert.doesNotMatch(text, /assistant/i, text);
});

test('a coworker, not an employee or an assistant: no workforce wording anywhere an agent account reads', () => {
  for (const text of everyString()) {
    assert.doesNotMatch(text, /assistant|employee|new hire|team member|staff/i, `"${text.slice(0, 80)}"`);
  }
});

test('the allowance is the break-even ceiling, and a top-up pays for itself', () => {
  const gbpPerUsd = 0.79;
  const openRouterFee = 1.055;
  const cardFee = (pence) => pence * 0.0325 + 20;
  const talkWorstPence = AGENT_PLAN.talkMinutesMonthly * 0.069 * gbpPerUsd * 100;
  const heavyExtrasPence = 13;
  const monthlyModelPence = (AGENT_PLAN.priceGbpMonthly * 100 - cardFee(AGENT_PLAN.priceGbpMonthly * 100) - talkWorstPence - heavyExtrasPence) / openRouterFee;
  const allowanceCostPence = AGENT_PLAN.monthlyAllowanceTokens * AGENT_USAGE.usdPerBillableToken * gbpPerUsd * 100;
  assert.ok(allowanceCostPence <= monthlyModelPence, `allowance costs ${allowanceCostPence.toFixed(1)}p, budget ${monthlyModelPence.toFixed(1)}p`);
  assert.ok(AGENT_PLAN.trialAllowanceTokens < AGENT_PLAN.monthlyAllowanceTokens);
  const topUpBudgetPence = (AGENT_TOP_UP.pricePence - cardFee(AGENT_TOP_UP.pricePence)) / openRouterFee;
  const topUpCostPence = AGENT_TOP_UP.tokens * AGENT_USAGE.usdPerBillableToken * gbpPerUsd * 100;
  assert.ok(topUpCostPence <= topUpBudgetPence, `a top-up costs ${topUpCostPence.toFixed(1)}p to serve, budget ${topUpBudgetPence.toFixed(1)}p`);
  assert.equal(AGENT_TOP_UP.validMonths, 12);
  assert.equal(formatTopUpPrice(), '£1.00');
  assert.equal(formatTopUpPrice(5), '£5.00');
  assert.match(AGENT_FAQ_ORDERED.find((item) => item.question === 'How much can I use it?').answer, /last for 12 months/);
  assert.doesNotMatch(everyString().join(' '), /unlimited/i, 'no unlimited claim next to an allowance and paid top-ups');
  // Nobody is on the plan yet, so there is no usage to say what most people do.
  assert.doesNotMatch(everyString().join(' '), /most people/i);
});

test('the top-up question says what a top-up buys, and the numbers still say it', () => {
  const body = agentTopUpConsentBody();
  assert.match(body, /a quarter of the monthly allowance/);
  assert.equal(AGENT_TOP_UP.tokens * 4, AGENT_PLAN.monthlyAllowanceTokens, 'change the words if a top-up is no longer a quarter');
  assert.match(body, /lasts 12 months/);
  assert.match(body, /give up the 14-day right to cancel/);
});

test('the guides and the export note speak about the assistant it actually is', () => {
  assert.equal(AGENT_HOWTO_TITLE, 'Getting the most from your coworker');
  assert.doesNotMatch(AGENT_DATA_COPY_NOTE, /workspace/i);
  // Short, because they are read on a phone (Alex, 2026-09-15), and what the
  // assistant cannot do is in the guide itself, not behind a website link.
  for (const section of AGENT_HOWTO_SECTIONS) {
    assert.ok(section.body.length <= 2, `${section.title}: at most two lines`);
    for (const line of section.body) assert.ok(line.length <= 180, `${section.title}: "${line.slice(0, 40)}..." is ${line.length} characters`);
  }
  assert.match(AGENT_HOWTO_SECTIONS.map((section) => section.body.join(' ')).join(' '), /cannot run code/);
  assert.match(AGENT_FAQ_ORDERED.find((item) => item.question === 'Can I cancel? Is there a free month?').answer, /top right corner, then Cancel subscription/);
});

test('a subscription on the assistant price is entitled like any plan, and is ready without a workspace', async () => {
  const { planTierIdForStripeLookupKey, resolveSidekickGate, createDemoSidekickState, ACKNOWLEDGEMENT_VERSION } = await import('../dist/index.js');
  assert.equal(AGENT_PLAN.name, 'Delegent AI');
  assert.equal(planTierIdForStripeLookupKey(AGENT_PLAN.stripePriceLookupKey), AGENT_PLAN.tierId);
  assert.equal(planTierIdForStripeLookupKey('sidekick_studio_monthly'), 'studio', 'workspace prices unchanged');
  assert.equal(planTierIdForStripeLookupKey('something_unknown'), null);
  // A new assistant subscriber has no workspace row at all.
  const demo = createDemoSidekickState();
  const snapshot = { ...demo, hermesInstance: null, subscription: { ...demo.subscription, status: 'trialing', currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000).toISOString() } };
  assert.equal(resolveSidekickGate(snapshot).kind, 'subscribed_pending_worker', 'a workspace account still waits for its workspace');
  assert.equal(resolveSidekickGate(snapshot, { agentEngine: true }).kind, 'ready');
  // Still no way round a plan or the allowance.
  assert.equal(resolveSidekickGate({ ...snapshot, subscription: { ...demo.subscription, status: 'inactive', currentPeriodEnd: undefined } }, { agentEngine: true }).kind, 'needs_subscription');
  assert.equal(resolveSidekickGate({ ...snapshot, usage: { ...snapshot.usage, hardLimited: true } }, { agentEngine: true }).kind, 'hard_limited');
  assert.ok(ACKNOWLEDGEMENT_VERSION);
});
