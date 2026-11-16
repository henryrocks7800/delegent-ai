import assert from 'node:assert/strict';
import test from 'node:test';
import { INVITE_ACCEPTED_MESSAGE, looksLikeInviteCode, parseReferral, redeemOutcome, tidyInviteCode } from './referralModel';

const member = {
  eligible: true,
  code: 'ABCD2345',
  shareText: 'I have been using Delegent AI ... ABCD2345 ... https://delegentai.co.uk/install',
  friendsJoined: 2,
  freeMonthsEarned: 1,
};

test('a member who can invite gets their code, share text and counts', () => {
  assert.deepEqual(parseReferral(member), { code: 'ABCD2345', shareText: member.shareText, friendsJoined: 2, freeMonthsEarned: 1 });
});

test('anyone who cannot invite, or a malformed answer, shows nothing', () => {
  assert.equal(parseReferral({ eligible: false }), null);
  assert.equal(parseReferral(null), null);
  assert.equal(parseReferral({ ...member, code: 'abcd1234' }), null);
  assert.equal(parseReferral({ ...member, shareText: 'no code in here' }), null, 'the message must carry the code');
  assert.deepEqual(parseReferral({ ...member, friendsJoined: -3, freeMonthsEarned: 'x' })?.friendsJoined, 0);
});

test('typing is forgiven: case, spaces and dashes', () => {
  assert.equal(tidyInviteCode('abcd 2345'), 'ABCD2345');
  assert.equal(tidyInviteCode('ab-cd-23-45'), 'ABCD2345');
  assert.equal(looksLikeInviteCode('abcd-2345'), true);
  assert.equal(looksLikeInviteCode('ABCD1234'), false, 'no 1, 0, I or O in a code');
  assert.equal(looksLikeInviteCode('ABC'), false);
});

test('every answer from the server reads as plain English, with no dashes', () => {
  assert.deepEqual(redeemOutcome(200, undefined), { ok: true, message: INVITE_ACCEPTED_MESSAGE });
  for (const code of ['invite_code_invalid', 'invite_code_not_found', 'invite_code_own', 'invite_for_new_members', 'invite_code_already_used', 'anything', undefined]) {
    const outcome = redeemOutcome(code ? 409 : null, code);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.message.length > 20);
    assert.doesNotMatch(outcome.message, /[\u2014\u2013]/);
  }
  assert.doesNotMatch(INVITE_ACCEPTED_MESSAGE, /[\u2014\u2013]/);
});
