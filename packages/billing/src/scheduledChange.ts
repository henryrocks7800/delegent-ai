export class ScheduledChangeConfirmationRequired extends Error {
  constructor(readonly confirmation: { token: string; expiresAt: number }) {
    super('billing_scheduled_change_confirmation_required');
  }
}

export class ScheduledChangeChanged extends Error {
  constructor() { super('billing_scheduled_change_changed'); }
}

/** A short-lived acknowledgement bound to the authenticated account and action. */
export async function requireScheduledChangeConfirmation(input: {
  secretKey: string; userId: string; subscriptionId: string; scheduleId: string | null;
  currentPriceId: string; targetTierId: string; returnUrl: string; provided?: unknown; now?: number;
}): Promise<void> {
  if (!input.scheduleId) {
    if (input.provided !== undefined && input.provided !== null) throw new ScheduledChangeChanged();
    return;
  }
  if (!input.secretKey || !input.userId) throw new Error('scheduled_change_confirmation_unavailable');
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const supplied = input.provided;
  const hasSupplied = supplied !== undefined && supplied !== null;
  const value = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? supplied as Record<string, unknown> : null;
  const expiresAt = hasSupplied ? value?.expiresAt : now + 300;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300) {
    throw new ScheduledChangeChanged();
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(input.secretKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const scope = new TextEncoder().encode(JSON.stringify(['delegent:scheduled-change:v1', input.userId,
    input.subscriptionId, input.scheduleId, input.currentPriceId, input.targetTierId, input.returnUrl, expiresAt]));
  if (!hasSupplied) {
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, scope));
    const token = Array.from(signature, b => b.toString(16).padStart(2, '0')).join('');
    throw new ScheduledChangeConfirmationRequired({ token, expiresAt });
  }
  if (typeof value?.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new ScheduledChangeChanged();
  const signature = Uint8Array.from(value.token.match(/../g)!, b => Number.parseInt(b, 16));
  if (!await crypto.subtle.verify('HMAC', key, signature, scope)) throw new ScheduledChangeChanged();
}
