/**
 * Money Finder ("we found money in your inbox"): the rules. Pure functions, no
 * network. The model only reads candidate emails and reports facts
 * (moneyFinderModel.ts); code here decides what is a claim, what it is worth
 * and what counts as a subscription. Report-only: nothing is ever sent.
 *
 * Flight compensation follows UK261 (the retained Regulation (EC) 261/2004):
 * a flight departing the UK or EU, arriving 3+ hours late or cancelled with
 * under 14 days' notice, pays per passenger by distance: up to 1,500 km £220,
 * 1,500 to 3,500 km £350, over 3,500 km £520 (halved to £260 when a long-haul
 * delay is 3 to 4 hours). Claims can be brought for up to 6 years in England
 * and Wales. Airlines can refuse for "extraordinary circumstances", which an
 * email rarely shows, so every flight finding is a "possible" claim.
 */
import * as airportModule from 'airport-data-js';
import { getDistance } from 'geolib';
import type { SearchObject } from 'imapflow';
import type { SortProvider } from './inboxSort.ts';

// CommonJS package: Node's ESM loader exposes it as `default`, the Worker bundler as named exports.
const airportData = ((airportModule as unknown as { default?: typeof airportModule }).default ?? airportModule);

/** Mailboxes Money Finder can read: the two Composio ones, and Yahoo/AOL on our own broker. */
export type MoneyProvider = SortProvider | 'yahoo';

export type MoneyKind = 'flight_compensation' | 'refund_due' | 'upgrade_overcharge' | 'subscription' | 'price_rise' | 'trial_ending';

/** What the model reads out of one email. Facts only; every field may be missing. */
export interface MoneyFacts {
  ref: string;
  kind: 'flight_disruption' | 'refund' | 'subscription_charge' | 'trial' | 'none';
  merchant: string | null;
  /** The plan or service paid for, when the email names it. */
  product?: string | null;
  /** For subscriptions: a normal charge, an upgrade to another plan, or a notice that it is cancelled or ending. */
  event?: 'charge' | 'upgrade' | 'cancelled' | null;
  /** For an upgrade: true when only the difference was charged. */
  prorated?: boolean | null;
  amount: number | null; currency: string | null;
  date: string | null;
  flight: { from: string | null; to: string | null; delayHours: number | null; cancelled: boolean | null; noticeDays: number | null; flightNumber: string | null } | null;
  billingPeriod: 'week' | 'month' | 'year' | null;
  trialEnds: string | null;
  refundStatus: 'promised' | 'completed' | null;
  confidence: number;
}

export interface MoneyFinding {
  kind: MoneyKind; merchant: string; amountPence: number; yearlyPence?: number;
  detail: string; date: string | null; confidence: 'likely' | 'possible';
}

/** The searches each mailbox runs. Built here only, never from model or user text. */
export function moneySearches(provider: SortProvider, now = Date.now()) {
  const since = (years: number) => new Date(now - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
  if (provider === 'gmail') {
    return [
      { key: 'travel', query: '-in:spam -in:trash newer_than:6y subject:(delayed OR delay OR cancelled OR canceled OR cancellation OR disruption OR diverted OR rebooked OR "schedule change") (flight OR flights OR airline OR airways OR booking)' },
      { key: 'refunds', query: '-in:spam -in:trash newer_than:2y subject:(refund OR refunded OR "refund has been approved" OR "return received" OR "return request" OR "money back")' },
      { key: 'subscriptions', query: '-in:spam -in:trash newer_than:18m ("auto-renew" OR "renews on" OR "your subscription" OR "updated your subscription" OR "subscription will be cancelled" OR "order receipt" OR "free trial" OR "trial ends" OR "price increase" OR "billed monthly" OR "billed annually" OR "membership fee")' },
    ];
  }
  // Graph $search (KQL). $filter cannot be combined with $search, so dates live in the KQL.
  return [
    { key: 'travel', query: `(subject:delayed OR subject:delay OR subject:cancelled OR subject:canceled OR subject:cancellation OR subject:disruption OR subject:diverted) AND (flight OR airline OR airways OR booking) AND received>=${since(6)}` },
    { key: 'refunds', query: `(subject:refund OR subject:refunded OR "return received" OR "money back") AND received>=${since(2)}` },
    { key: 'subscriptions', query: `("auto-renew" OR "renews on" OR "your subscription" OR "updated your subscription" OR "order receipt" OR "free trial" OR "trial ends" OR "price increase" OR "billed monthly" OR "billed annually") AND received>=${since(1.5)}` },
  ];
}
/**
 * The same three searches for Yahoo and AOL, as IMAP criteria (imapflow). IMAP
 * has no "(a OR b) AND (c OR d)" in one key, so travel searches subjects only;
 * the model still decides what each email is.
 */
export function yahooMoneySearches(now = Date.now()): { key: string; criteria: SearchObject }[] {
  const since = (years: number) => new Date(now - years * 365.25 * 86_400_000);
  const subjects = (words: string[]) => words.map((subject) => ({ subject }));
  return [
    { key: 'travel', criteria: { since: since(6), or: subjects(['delayed', 'delay', 'cancelled', 'canceled', 'cancellation', 'disruption', 'diverted', 'rebooked', 'schedule change']) } },
    { key: 'refunds', criteria: { since: since(2), or: subjects(['refund', 'refunded', 'return received', 'money back']) } },
    { key: 'subscriptions', criteria: { since: since(1.5), or: [...subjects(['subscription', 'receipt', 'free trial', 'renewal', 'price increase', 'membership']),
      { body: 'auto-renew' }, { body: 'renews on' }, { body: 'trial ends' }] } },
  ];
}

/** Candidates read per search, newest first. Bounds cost on any mailbox. */
export const MONEY_CANDIDATES_PER_SEARCH = 120;

// UK and EU/EEA departures are covered by UK261 / EC261.
const COVERED_DEPARTURES = new Set(['GB', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT',
  'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'NO', 'LI', 'CH']);

type Airport = { latitude: number; longitude: number; country_code: string };
async function airport(code: string | null): Promise<Airport | null> {
  if (!code || !/^[A-Z]{3}$/.test(code.trim().toUpperCase())) return null;
  try {
    const found = await airportData.getAirportByIata(code.trim().toUpperCase());
    const first = found?.[0];
    return first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude) ? first : null;
  } catch { return null; }
}

/** UK261 amount in pence for one passenger, or 0 when the facts do not qualify. */
export function flightCompensationPence(distanceKm: number, delayHours: number | null, cancelledShortNotice: boolean): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  const qualifies = cancelledShortNotice || (delayHours !== null && delayHours >= 3);
  if (!qualifies) return 0;
  if (distanceKm <= 1500) return 22_000;
  if (distanceKm <= 3500) return 35_000;
  return !cancelledShortNotice && delayHours !== null && delayHours < 4 ? 26_000 : 52_000;
}

const within = (date: string | null, years: number, now: number) => {
  const at = date ? Date.parse(date) : NaN;
  return Number.isFinite(at) && at <= now && now - at <= years * 365.25 * 86_400_000;
};
const pence = (amount: number | null) => amount !== null && Number.isFinite(amount) && amount > 0 && amount < 100_000 ? Math.round(amount * 100) : 0;
const merchantKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (value: string | null, max = 60) => {
  const text = (value ?? '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return (cut.lastIndexOf(' ') > 0 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,.;:(-]+$/, '');
};
const YEARLY = { week: 52, month: 12, year: 1 } as const;
const STORES = new Set(['google play', 'google', 'google commerce limited', 'apple', 'app store', 'apple app store', 'itunes', 'paypal', 'stripe']);
const STALE_AFTER_DAYS = { week: 21, month: 62, year: 400 } as const;

/** Turn the model's facts into findings. Code decides eligibility and value. */
export async function moneyFindings(facts: MoneyFacts[], now = Date.now()): Promise<MoneyFinding[]> {
  const findings: MoneyFinding[] = [];
  // An app store or payment company is never the merchant: "Google Play" billed for Claude is Claude.
  const confident = facts.filter((fact) => fact.kind !== 'none' && fact.confidence >= 0.6 && clean(fact.merchant))
    .map((fact) => STORES.has(merchantKey(fact.merchant!)) && clean(fact.product ?? null) ? { ...fact, merchant: fact.product! } : fact);
  // Whole-word prefix match: a PayPal notice names "eBay Commerce UK Ltd" where eBay's own email says "eBay".
  const sameCompany = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
  // The model may name the company in one email and the brand in another (Anthropic, Claude),
  // so charges and refunds also match when their plans share a first word (Claude Pro, Claude Max).
  const family = (f: MoneyFacts) => merchantKey(f.product ?? '').split(' ')[0] ?? '';
  const sameService = (a: MoneyFacts, b: MoneyFacts) => sameCompany(merchantKey(a.merchant!), merchantKey(b.merchant!))
    || (family(a).length > 2 && family(a) === family(b));

  // Flights: one finding per flight (a disruption often sends several emails).
  const flights = new Map<string, MoneyFinding>();
  for (const fact of confident.filter((f) => f.kind === 'flight_disruption' && f.flight)) {
    const flight = fact.flight!;
    if (!within(fact.date, 6, now)) continue;
    const [from, to] = await Promise.all([airport(flight.from), airport(flight.to)]);
    if (!from || !to || !COVERED_DEPARTURES.has(from.country_code)) continue;
    const km = getDistance({ latitude: from.latitude, longitude: from.longitude }, { latitude: to.latitude, longitude: to.longitude }) / 1000;
    const shortNotice = flight.cancelled === true && flight.noticeDays !== null && flight.noticeDays < 14;
    const amountPence = flightCompensationPence(km, flight.delayHours, shortNotice);
    if (!amountPence) continue;
    const key = `${clean(flight.flightNumber, 12) || merchantKey(fact.merchant!)}|${fact.date?.slice(0, 10)}|${flight.from}-${flight.to}`;
    const what = shortNotice ? `cancelled with ${flight.noticeDays} days' notice` : `arrived about ${flight.delayHours} hours late`;
    if (!flights.has(key)) flights.set(key, { kind: 'flight_compensation', merchant: clean(fact.merchant), amountPence,
      detail: `${flight.from!.toUpperCase()} to ${flight.to!.toUpperCase()}, ${what}`, date: fact.date, confidence: 'possible' });
  }
  findings.push(...flights.values());

  // Refunds promised but never confirmed, at least 14 days old.
  const refunds = confident.filter((f) => f.kind === 'refund' && within(f.date, 2, now));
  const completed = refunds.filter((f) => f.refundStatus === 'completed').map((f) => merchantKey(f.merchant!));
  const isCompleted = (key: string) => completed.some((done) => sameCompany(done, key));
  const seenRefund = new Set<string>();
  for (const fact of refunds) {
    const key = merchantKey(fact.merchant!);
    if (fact.refundStatus !== 'promised' || isCompleted(key) || seenRefund.has(key)) continue;
    if (now - Date.parse(fact.date!) < 14 * 86_400_000 || !pence(fact.amount)) continue;
    seenRefund.add(key);
    findings.push({ kind: 'refund_due', merchant: clean(fact.merchant), amountPence: pence(fact.amount),
      detail: 'promised but never confirmed as paid', date: fact.date, confidence: 'possible' });
  }

  const day = (value: string | null) => Date.parse(value ?? '');
  // A cancellation is usually dated when it takes effect, which can be in the future.
  const subs = confident.filter((f) => f.kind === 'subscription_charge'
    && (within(f.date, 1.5, now) || (f.event === 'cancelled' && Number.isFinite(day(f.date)) && day(f.date) - now <= 400 * 86_400_000)));

  // Upgraded at full price with no credit for a plan bought in the month before: the earlier
  // charge is claimable (Google Play refunded three of these in full on 2026-09-25).
  const completedRefunds = confident.filter((f) => f.kind === 'refund' && f.refundStatus === 'completed');
  const upgrades = subs.filter((f) => f.event === 'upgrade' && f.prorated !== true && pence(f.amount) && within(f.date, 1, now));
  const claimed = new Set<MoneyFacts>();
  const pairs: { earlier: MoneyFacts; upgrade: MoneyFacts }[] = [];
  for (const upgrade of upgrades) {
    const company = merchantKey(upgrade.merchant!);
    const earlier = subs.filter((f) => f !== upgrade && f.event !== 'cancelled' && f.prorated !== true && !claimed.has(f)
      && sameService(f, upgrade) && pence(f.amount) && pence(f.amount) < pence(upgrade.amount)
      && merchantKey(f.product ?? '') !== merchantKey(upgrade.product ?? '')
      && day(upgrade.date) - day(f.date) >= 0 && day(upgrade.date) - day(f.date) <= 31 * 86_400_000)
      .sort((x, y) => day(y.date) - day(x.date))[0];
    if (earlier) { claimed.add(earlier); pairs.push({ earlier, upgrade }); }
  }
  // Each completed refund pays back one charge: the latest matching one before it.
  for (const refund of [...completedRefunds].sort((x, y) => day(x.date) - day(y.date))) {
    const match = pairs.filter((p) => pence(p.earlier.amount) === pence(refund.amount) && day(p.earlier.date) <= day(refund.date)
      && sameService(p.earlier, refund))
      .sort((x, y) => day(y.earlier.date) - day(x.earlier.date))[0];
    if (match) pairs.splice(pairs.indexOf(match), 1);
  }
  for (const { earlier, upgrade } of pairs) {
    const from = clean(earlier.product ?? null, 22) || 'the old plan'; const to = clean(upgrade.product ?? null, 22) || 'the new plan';
    findings.push({ kind: 'upgrade_overcharge', merchant: clean(upgrade.merchant, 40), amountPence: pence(earlier.amount),
      detail: `paid for ${from} on ${earlier.date!.slice(0, 10)}, then ${to} at full price on ${upgrade.date!.slice(0, 10)} with no credit`,
      date: upgrade.date, confidence: 'possible' });
  }

  // Subscriptions: latest charge per company and product, yearly cost, and any price rise.
  const charges = subs.filter((f) => f.event !== 'cancelled' && f.billingPeriod && pence(f.amount))
    .sort((a, b) => day(a.date) - day(b.date));
  const cancellations = subs.filter((f) => f.event === 'cancelled');
  const byMerchant = new Map<string, MoneyFacts[]>();
  // One subscription per company and product: two Google products are two subscriptions.
  const subscriptionKey = (f: MoneyFacts) => `${merchantKey(f.merchant!)}|${merchantKey(f.product ?? '')}`;
  for (const fact of charges) byMerchant.set(subscriptionKey(fact), [...(byMerchant.get(subscriptionKey(fact)) ?? []), fact]);
  for (const list of byMerchant.values()) {
    const latest = list[list.length - 1]!;
    const period = latest.billingPeriod!;
    const company = merchantKey(latest.merchant!); const product = merchantKey(latest.product ?? '');
    // No charge for well over a period means it has most likely been cancelled already.
    if (now - day(latest.date) > STALE_AFTER_DAYS[period] * 86_400_000) continue;
    // Cancelled since the last charge: a notice naming this plan, or the company with no plan named.
    if (cancellations.some((c) => sameCompany(merchantKey(c.merchant!), company) && day(c.date) >= day(latest.date)
      && (!c.product || merchantKey(c.product) === product || sameCompany(merchantKey(c.product), company)))) continue;
    // Replaced by a later upgrade to another plan from the same company.
    if (charges.some((c) => c.event === 'upgrade' && sameCompany(merchantKey(c.merchant!), company) && day(c.date) > day(latest.date)
      && merchantKey(c.product ?? '') !== product)) continue;
    const yearlyPence = pence(latest.amount) * YEARLY[period];
    // A product name that repeats the company adds nothing ("Incogni (Incogni Product)").
    const showProduct = latest.product && !merchantKey(latest.product).includes(company) ? clean(latest.product, 26) : '';
    const name = showProduct ? `${clean(latest.merchant, 30)} (${showProduct})` : clean(latest.merchant);
    findings.push({ kind: 'subscription', merchant: name, amountPence: pence(latest.amount), yearlyPence,
      detail: `${period === 'year' ? 'yearly' : `${period}ly`} charge, last on ${latest.date!.slice(0, 10)}`, date: latest.date, confidence: 'likely' });
    // A price rise is the same plan costing more. A jump of over half is a plan change the person chose, not a rise.
    const earlier = [...list].reverse().find((f) => f.billingPeriod === period && pence(f.amount) < pence(latest.amount)
      && pence(latest.amount) <= pence(f.amount) * 1.5);
    if (earlier) {
      const rise = (pence(latest.amount) - pence(earlier.amount)) * YEARLY[period];
      findings.push({ kind: 'price_rise', merchant: name, amountPence: pence(latest.amount), yearlyPence: rise,
        detail: `went up from £${(pence(earlier.amount) / 100).toFixed(2)} to £${(pence(latest.amount) / 100).toFixed(2)}`, date: latest.date, confidence: 'likely' });
    }
  }

  // Free trials ending in the next 30 days.
  const trials = new Set<string>();
  for (const fact of confident.filter((f) => f.kind === 'trial' && f.trialEnds)) {
    const ends = Date.parse(fact.trialEnds!);
    const key = merchantKey(fact.merchant!);
    if (!Number.isFinite(ends) || ends < now || ends - now > 30 * 86_400_000 || trials.has(key)) continue;
    trials.add(key);
    findings.push({ kind: 'trial_ending', merchant: clean(fact.merchant), amountPence: pence(fact.amount),
      detail: `free trial ends ${fact.trialEnds!.slice(0, 10)}`, date: fact.date, confidence: 'likely' });
  }
  return findings;
}

/** Headline totals for the report. */
export function moneyTotals(findings: MoneyFinding[]) {
  const owed = findings.filter((f) => f.kind === 'flight_compensation' || f.kind === 'refund_due' || f.kind === 'upgrade_overcharge').reduce((sum, f) => sum + f.amountPence, 0);
  const subscriptions = findings.filter((f) => f.kind === 'subscription');
  const yearly = subscriptions.reduce((sum, f) => sum + (f.yearlyPence ?? 0), 0);
  const rises = findings.filter((f) => f.kind === 'price_rise').reduce((sum, f) => sum + (f.yearlyPence ?? 0), 0);
  return { owedPence: owed, subscriptionCount: subscriptions.length, subscriptionsYearlyPence: yearly, priceRisesYearlyPence: rises,
    trialsEnding: findings.filter((f) => f.kind === 'trial_ending').length };
}
