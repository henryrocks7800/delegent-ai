// Pure view model for referrals (referral.ts does the network and the hook).
// Kept apart so it is testable under tsx. The server side is
// apps/worker/src/referrals.ts: GET /api/referral and POST /api/referral/redeem.

export interface Referral {
  code: string;
  shareText: string;
  friendsJoined: number;
  freeMonthsEarned: number;
}

const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

/** The Worker's answer for a member who can invite, or null for anyone else. */
export function parseReferral(payload: unknown): Referral | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.eligible !== true || typeof body.code !== 'string' || !CODE.test(body.code)) return null;
  if (typeof body.shareText !== 'string' || !body.shareText.includes(body.code)) return null;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  return {
    code: body.code,
    shareText: body.shareText,
    friendsJoined: count(body.friendsJoined),
    freeMonthsEarned: count(body.freeMonthsEarned),
  };
}

/** What someone typed, tidied for the server: capitals, no spaces or dashes. */
export function tidyInviteCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').slice(0, 8);
}

export function looksLikeInviteCode(input: string): boolean {
  return CODE.test(tidyInviteCode(input));
}

export type RedeemOutcome = { ok: true; message: string } | { ok: false; message: string };

export const INVITE_ACCEPTED_MESSAGE = 'Invite code added. Your friend gets a free month once your free month turns into a paid plan.';

/** The line shown under the code box, from the server's answer. */
export function redeemOutcome(status: number | null, errorCode: unknown): RedeemOutcome {
  if (status === 200) return { ok: true, message: INVITE_ACCEPTED_MESSAGE };
  switch (errorCode) {
    case 'invite_code_invalid':
      return { ok: false, message: 'That does not look like an invite code. Codes are 8 letters and numbers.' };
    case 'invite_code_not_found':
      return { ok: false, message: 'We could not find that code. Check it with your friend.' };
    case 'invite_code_own':
      return { ok: false, message: 'That is your own code. Share it with a friend instead.' };
    case 'invite_for_new_members':
      return { ok: false, message: 'Invite codes are for new members, and this account has had a plan before.' };
    case 'invite_code_already_used':
      return { ok: false, message: 'This account has already used an invite code.' };
    default:
      return { ok: false, message: 'We could not check the code just now. Try again in a moment.' };
  }
}
