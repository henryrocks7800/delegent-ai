// The money check a person did before or during onboarding (MoneyCheck.tsx):
// what it holds, and every sum and sentence made from it. Pure, so it is unit
// tested; storing it on the device is useMoneyIntent.ts.
//
// Nothing personal is kept: which kinds of money they ticked, a distance band,
// a traveller count, and whether they asked us to look.

export type MoneyKind = 'flight' | 'double' | 'refund' | 'subs';
const KINDS: readonly MoneyKind[] = ['flight', 'double', 'refund', 'subs'];

/** UK261 distance bands and their maximum compensation per passenger, in pounds. */
export type FlightBand = 'short' | 'medium' | 'long';
export const FLIGHT_BANDS: Record<FlightBand, { pounds: number; label: string; examples: string }> = {
  short: { pounds: 220, label: 'Up to 1,500 km', examples: 'Paris, Ibiza, Rome' },
  medium: { pounds: 350, label: '1,500 to 3,500 km', examples: 'Athens, Tenerife, Malaga' },
  long: { pounds: 520, label: 'Over 3,500 km', examples: 'New York, Dubai' },
};

/** What each of the other kinds is, said as something waiting to be found. */
export const MONEY_FOUND: Record<Exclude<MoneyKind, 'flight'>, string> = {
  double: 'double charges to claim back',
  refund: 'a refund to chase',
  subs: 'subscriptions to stop paying',
};

export interface MoneyIntent {
  kinds: MoneyKind[];
  band: FlightBand;
  travellers: number;
  /** True when they pressed "Find my money", false when they chose "Not now". */
  wants: boolean;
  savedAt: string;
}

type MoneyChoice = Pick<MoneyIntent, 'kinds' | 'band' | 'travellers'>;

/** The most the flight could be worth under UK261, for everyone on the booking. */
export function flightUpTo(intent: MoneyChoice): number {
  return intent.kinds.includes('flight') ? FLIGHT_BANDS[intent.band].pounds * intent.travellers : 0;
}

/** 1040 -> "1,040", without leaning on Intl (Hermes builds differ). */
export function pounds(value: number): string {
  return `£${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Everything except the flight that they ticked, in words. */
export function otherFinds(intent: MoneyChoice): string[] {
  return intent.kinds.filter((kind): kind is Exclude<MoneyKind, 'flight'> => kind !== 'flight').map((kind) => MONEY_FOUND[kind]);
}

/** One line for the rest of the journey: what this person asked us to look for. */
export function moneyLine(intent: MoneyChoice): string {
  const upTo = flightUpTo(intent);
  const others = otherFinds(intent);
  if (upTo) return others.length ? `Up to ${pounds(upTo)} for your flight, plus ${joinAnd(others)}.` : `Up to ${pounds(upTo)} for your flight.`;
  if (others.length) {
    const line = joinAnd(others);
    return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
  }
  return 'Delayed flights, double charges, missing refunds and forgotten subscriptions.';
}

/** The line under a "Find up to £X" heading, so the amount is not said twice. */
export function moneyDetail(intent: MoneyChoice): string {
  if (!flightUpTo(intent)) return moneyLine(intent);
  const others = otherFinds(intent);
  const flight = intent.travellers > 1 ? `the flight, for ${intent.travellers} of you` : 'the flight';
  return others.length ? `For ${flight}, plus ${joinAnd(others)}.` : `For ${flight}.`;
}

/** A stored check, validated; anything malformed reads as no check at all. */
export function parseMoneyIntent(raw: string | null): MoneyIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MoneyIntent> | null;
    if (!value || !Array.isArray(value.kinds) || typeof value.band !== 'string' || !(value.band in FLIGHT_BANDS)) return null;
    const kinds = KINDS.filter((kind) => (value.kinds as unknown[]).includes(kind));
    const travellers = Math.min(9, Math.max(1, Math.round(Number(value.travellers)) || 1));
    return { kinds, band: value.band as FlightBand, travellers, wants: value.wants !== false, savedAt: String(value.savedAt ?? '') };
  } catch {
    return null;
  }
}
