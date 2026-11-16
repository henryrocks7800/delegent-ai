// Pilot rollout gating, resolved natively per-account. Features in test ship
// dark in the shared OTA bundle and light up only for these accounts; the
// single source of truth lives here so the chat surface and the menu can
// never disagree about who is in the pilot.
export const PILOT_FEATURE_EMAILS = ['tester@example.com', 'qa@example.com'];

export function isPilotUser(email?: string | null): boolean {
  if (!email) return false;
  return PILOT_FEATURE_EMAILS.includes(email.trim().toLowerCase());
}
