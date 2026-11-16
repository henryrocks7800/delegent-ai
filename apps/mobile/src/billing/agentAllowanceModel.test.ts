import assert from 'node:assert/strict';
import test from 'node:test';
import { allowanceRefreshLine, parseAgentAllowance, talkMinutesLeftLine, topUpCreditLine } from './agentAllowanceModel';

const answer = {
  engine: 'agent',
  trialing: false,
  allowanceTokens: 16_000_000,
  usedTokens: 4_000_000,
  allowanceUsedRatio: 0.25,
  topUpBalanceTokens: 6_400_000,
  hardLimited: false,
  periodStart: '2026-09-01T00:00:00.000Z',
  nextResetAt: '2026-09-30T09:15:00.000Z',
  talk: { quotaSeconds: 900, usedSeconds: 300 },
  topUp: { pricePence: 100, tokens: 4_000_000, validMonths: 12, maxPacks: 10 },
};

test('the allowance reads as plain money and minutes', () => {
  const allowance = parseAgentAllowance(answer);
  assert.ok(allowance);
  assert.equal(allowance.allowanceUsedRatio, 0.25);
  assert.equal(topUpCreditLine(allowance), '£1.60');
  assert.equal(allowanceRefreshLine(allowance), 'Refreshes on Wednesday 30 September');
  assert.equal(talkMinutesLeftLine(allowance), '10 of 15 minutes left');
});

test('anything but an agent account\'s allowance is refused', () => {
  assert.equal(parseAgentAllowance({ engine: 'runner' }), null);
  assert.equal(parseAgentAllowance(null), null);
  assert.equal(parseAgentAllowance({ ...answer, topUp: {} }), null);
  const clamped = parseAgentAllowance({ ...answer, allowanceUsedRatio: 7, topUpBalanceTokens: -3, nextResetAt: 'not a date' });
  assert.equal(clamped?.allowanceUsedRatio, 1);
  assert.equal(clamped?.topUpBalanceTokens, 0);
  assert.equal(clamped && allowanceRefreshLine(clamped), null);
});
