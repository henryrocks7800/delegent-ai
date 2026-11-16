import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Changing plan is the one billing action where doing the obvious thing is
// wrong. Stripe will not open a second Checkout for a customer who already has
// a subscription, and our portal configuration can only cancel, so a reader on
// Studio who presses Max gets nothing at all unless the call names the tier
// being moved to. That is exactly what shipped in the browser, and these tests
// exist so it cannot ship again.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, relative), 'utf8');

/**
 * Strip `//` line comments and block comments, so a source-text guard checks
 * CODE and not the English around it.
 *
 * Deliberately conservative: it leaves string literals alone, because those are
 * exactly what the guards below are hunting for. A `//` inside a string (a URL,
 * say) would be blanked by a naive stripper, which could hide a hard-coded
 * label sitting next to it, so quoted regions are stepped over intact.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const WEB_API = read('../src/features/billing/billingApi.ts');
const WEB_PLAN = read('../src/features/billing/PlanScreen.tsx');
const WEB_CAPACITY = read('../src/features/billing/CapacityScreen.tsx');
const WEB_PROFILE = read('../src/features/profile/ProfileScreen.tsx');
const WORKER = read('../../../packages/billing/src/serverFlow.ts');
const MOBILE = read('../../mobile/App.tsx');


test('the plain Manage billing call still names no tier', () => {
  // Passing one here would turn a look at the invoices into a plan change.
  assert.match(WEB_PLAN, /openBillingPortal\(\)/);
});

test('the capacity page sends a reader who is running short to the plan picker', () => {
  // It used to open the plain portal, which our Stripe configuration allows to
  // cancel and nothing else, directly under a row promising that more thinking
  // is one plan change away. The phone made this same correction.
  assert.equal(/openBillingPortal/.test(WEB_CAPACITY), false, 'the capacity page still opens the cancel-only portal');
  assert.match(WEB_CAPACITY, /<Link className="btn-secondary mt-5 flex w-full justify-center" to="\/plan">/);
});

test('a reader who has cancelled is not promised a reset on their last day', () => {
  // Stripe sends one timestamp for both meanings. Read it without the cancel
  // flag and the capacity page tells someone whose plan is ending that their
  // allowance comes back that day, which is the opposite of what happens.
  assert.match(WEB_CAPACITY, /formatCycleEndLine\(/);
  assert.match(WEB_CAPACITY, /subscription\?\.cancelAtPeriodEnd \?\? false/);
});

test('both profiles carry the rollover date and a named way back onto a plan', () => {
  // 2026-07-30: the date was only ever in a sentence inside the capacity card,
  // so a paying reader reached the end of his month without knowing it was the
  // end of his month, and when it lapsed there was no obvious way back. Both
  // surfaces read the same shared helper, so neither can start labelling or
  // dating this its own way.
  for (const [name, source] of [['browser', WEB_PROFILE], ['phone', MOBILE]]) {
    assert.match(source, /summariseBillingPeriod\(\{/, name);
    assert.match(source, /billingPeriod\.label/, name);
    assert.match(source, /billingPeriod\.value/, name);
    assert.match(source, /billingPeriod\.actionLabel/, name);
    assert.match(source, /billingPeriod\.note/, name);
    // The labels and the dates come from shared, never retyped per surface.
    //
    // Checked against CODE ONLY. This used to scan the raw file, which meant a
    // COMMENT that merely mentioned the word tripped it: on 2026-08-26 the line
    // `// "Resubscribe" and cancel control in the app routes through here` in
    // App.tsx failed the whole gate. A guard that fires on prose is a guard
    // somebody eventually weakens to get their branch green, so it strips
    // comments and keeps its teeth on the thing it actually cares about.
    const code = stripComments(source);
    assert.doesNotMatch(code, /'Resubscribe'|"Resubscribe"/, name);
    assert.doesNotMatch(code, /'Resume plan'|"Resume plan"/, name);
  }
  // And the button has to go somewhere a lapsed reader can actually buy: the
  // plan picker, not the cancel-only Stripe portal.
  assert.match(WEB_PROFILE, /to="\/plan"/);
});

test('the no-allowance copy is shared with the phone rather than written twice', () => {
  // The phone drew a full capacity card in this state, badged Studio. Closing
  // that meant the phone needed this wording, and a second copy of it in the
  // browser is the drift the parity sink exists to prevent.
  assert.match(WEB_CAPACITY, /CAPACITY_NO_ALLOWANCE_TITLE/);
  assert.match(WEB_CAPACITY, /CAPACITY_NO_ALLOWANCE_BODY/);
  assert.match(WEB_CAPACITY, /CAPACITY_NO_ALLOWANCE_CTA/);
  assert.doesNotMatch(WEB_CAPACITY, /There is no allowance to show yet\./);
});

test('a downgrade refused over storage is not rendered as a failure', () => {
  // The server refuses it on purpose. Rendered in the red error slot it reads
  // as something that went wrong, and on the phone it carried the title
  // "Couldn't open the billing page", which invites a retry that will refuse
  // the reader again for the same reason. The thing to do is in Files.
  assert.match(WEB_API, /storageBlocked: true/);
  assert.match(WEB_PLAN, /STORAGE_DOWNGRADE_BLOCK_TITLE/);
  assert.match(WEB_PLAN, /\{storageBlock \? \(/);
  // Both portal calls can be refused this way: the plain Manage billing one and
  // the one that names a tier. Routing only one of them leaves the other in the
  // red slot.
  assert.equal((WEB_PLAN.match(/if \(result\.storageBlocked\) setStorageBlock\(result\.message\)/g) ?? []).length, 2);
  // Every path that arms a new billing action clears the old block.
  assert.equal((WEB_PLAN.match(/setStorageBlock\(null\)/g) ?? []).length, 3);
});

test('the words a refused or booked plan change gets are read from shared, not retyped here', () => {
  // Both surfaces had their own copy of these and three of the four had already
  // drifted. The wording is asserted in packages/shared/test/billing-outcome-copy.test.mjs;
  // what this holds is that the browser cannot start keeping its own again.
  assert.match(WEB_API, /storageDowngradeBlockBody\(\{/);
  assert.match(WEB_API, /downgradeScheduledMessage\(\{/);
  assert.doesNotMatch(WEB_API, /free up space in Files/i);
  assert.doesNotMatch(WEB_API, /You keep everything/i);
  // Hermes ships without full Intl, so a date built through toLocaleDateString
  // is a phone-only answer and cannot be the shared one.
  assert.doesNotMatch(WEB_API, /toLocaleDateString/);
});

test('a subscription that has not finished syncing is not told to go and pick a plan', () => {
  // The two 409s mean different things. Folded together, someone who already
  // pays us was sent to the plan picker, where the only offer is the plan they
  // are on. The Worker returns billing_subscription_required only AFTER it has
  // found a Stripe customer, so "there is no billing account" was never true.
  assert.match(WORKER, /billing_customer_required/);
  assert.match(WORKER, /billing_subscription_required/);
  assert.doesNotMatch(WEB_API, /There is no billing account yet/);
  // Each code tied to its own message in the same assertion, because matching
  // the two names anywhere in the file is satisfied by the import line alone:
  // swapping the message inside the branch left that check green.
  assert.match(
    WEB_API,
    /serverCode === 'billing_customer_required'\)\s*\{\s*return \{ ok: false, message: BILLING_CUSTOMER_REQUIRED_MESSAGE \};/,
  );
  assert.match(
    WEB_API,
    /serverCode === 'billing_subscription_required'\)\s*\{\s*return \{ ok: false, message: BILLING_SUBSCRIPTION_SYNCING_MESSAGE \};/,
  );
});

test('checkout is only offered to someone without a subscription', () => {
  // `entitled` gates the two branches. If the card ever offers Checkout to a
  // subscriber it earns a 409 and shows a message instead of doing the thing.
  assert.match(WEB_PLAN, /\{\s*busy \? 'Opening payment…'/);
  assert.match(WEB_PLAN, /\) : entitled \? \(/);
});

test('a plan change says which of the two things it is going to do', () => {
  // A move up goes through the portal, which prices the rest of the month and
  // shows the figure before the reader confirms. A move down never reaches that
  // flow: scheduleSubscriptionDowngradeAtPeriodEnd books it for the end of the
  // period already paid for and sets proration_behavior 'none' on purpose, so
  // nothing is credited. One caption for both has to lie about one of them,
  // which is what the phone was doing.
  assert.match(WEB_PLAN, /planChangeNote\(isDowngrade\)/);
  assert.match(WEB_PLAN, /isDowngrade=\{Boolean\(entitled && currentTierId && isPlanDowngrade\(currentTierId, tier\.id\)\)\}/);
});

test('the downgrade caption promises no money back', () => {
  const shared = read('../../../packages/shared/src/content/checkoutNotices.ts');
  const downgrade = shared.slice(shared.indexOf('export const PLAN_DOWNGRADE_TIMING_NOTE'), shared.indexOf('export function planChangeNote'));
  assert.equal(/pro-rate|prorate|proration|refund|credit/i.test(downgrade), false, downgrade);
  assert.match(shared, /PLAN_DOWNGRADE_TIMING_NOTE = 'Starts at your next renewal/);
});

test('a scheduled downgrade is reported and does not redirect', () => {
  // The Worker returns 200 with `scheduled: true` and no URL. Treating that as
  // a redirect would navigate to undefined and lose the page.
  assert.match(WEB_API, /result\.data\.scheduled === true/);
  assert.match(WEB_API, /kind: 'scheduled'/);
  assert.match(WEB_PLAN, /result\.kind === 'redirect'/);
  assert.match(WEB_PLAN, /setScheduled\(result\.message\)/);
});

test('the two shapes the Worker can answer a targeted portal call with are both handled', () => {
  // Pinned to the Worker so a change there shows up as a failure here rather
  // than as a button that does nothing.
  assert.match(WORKER, /scheduled: true/);
  assert.match(WORKER, /error: 'downgrade_storage_over_limit'/);
  assert.match(WEB_API, /'downgrade_storage_over_limit'/);
});

test('a downgrade blocked on storage says how much is used and how much fits', () => {
  // "You cannot do that" without the two numbers leaves the reader guessing how
  // much to clear. Both figures have to be handed to the shared builder; that
  // the builder then renders them, and the reassurance that follows, is held in
  // packages/shared/test/billing-outcome-copy.test.mjs.
  assert.match(WEB_API, /currentStorageBytes: detail\.currentStorageBytes/);
  assert.match(WEB_API, /targetStorageBytes: detail\.targetStorageBytes/);
  // And the plan being moved to, by name. Dropping it degrades the message to
  // "the smaller plan" without breaking anything, which is the quiet kind.
  assert.match(WEB_API, /targetTierShortName: tierShortName\(detail\.targetTierId\)/);
});

test('the storage numbers are read from the error body, not invented', () => {
  // apiFetch has to carry the parsed body on a failure for that to be possible.
  const api = read('../src/lib/api.ts');
  assert.match(api, /body: unknown/);
  assert.match(WEB_API, /overLimitMessage\(result\.body\)/);
});

test('the scheduled date is rendered in UTC', () => {
  // A renewal boundary rendered in local time can name the day before the one
  // on the invoice for anyone west of London. It is now the shared builder that
  // owns that, so the browser must not be formatting a date of its own; the
  // 23:30Z case is exercised in packages/shared/test/billing-outcome-copy.test.mjs.
  assert.match(WEB_API, /effectiveAt: typeof result\.data\.effectiveAt === 'string'/);
  assert.doesNotMatch(WEB_API, /toLocaleDateString|new Date\(/);
});

test('the promo price is only quoted to a reader who is certain to be charged it', () => {
  // Server and client must ask the SAME question or the page and Stripe
  // disagree on the price. The client (shouldQuotePromoPrice) quotes the promo
  // only to a reader Stripe has never seen; the server must therefore refuse
  // the coupon to any customer with ANY real subscription history, not merely
  // one who redeemed the promo before. The narrower "has redeemed" gate let a
  // customer whose subscription predated the promo through: the page quoted
  // £30 and Stripe charged £15 (2026-07-30, reported on a real resubscribe).
  // And a tier change belongs to a current subscriber, so it must never set
  // `discounts` at all.
  const billing = read('../../../packages/billing/src/index.ts');
  assert.match(billing, /customerHasStripeSubscriptionHistory\(existingStripeCustomerId, client, trialEnabled\)/);
  assert.doesNotMatch(billing, /customerHasRedeemedLaunchPromo/);
  assert.doesNotMatch(billing, /confirm\.discounts/, 'the portal tier-change flow must never apply the coupon afresh');
  assert.match(WEB_PLAN, /shouldQuotePromoPrice\(subscription\)/);
  assert.doesNotMatch(WEB_PLAN, /shouldQuotePromoPrice\(subscription\?\.status\)/);
  assert.match(WEB_PLAN, /\{quotePromo \? \(/, 'the promo banner is rendered on promoLive alone');
  assert.match(WEB_PLAN, /promoLive=\{quotePromo\}/, 'the plan cards are still told the promo applies to everyone');
});

test('a subscriber is told what does carry across a plan change, not left with nothing', () => {
  // A discount lives on the subscription rather than the price, so months still
  // owed survive a tier change. Saying so is true for both kinds of subscriber;
  // quoting the half price is only true for one of them.
  assert.match(WEB_PLAN, /promoLive && entitled && !agentEngine \? \(/);
  assert.match(WEB_PLAN, /LAUNCH_PROMO_CARRY_OVER_LINE/);
});

test('an agent-engine subscriber is not promised a carry-over to a plan that does not exist', () => {
  // The engine sells one plan, so "your new plan" pointed at nothing (QA, 2026-09-23).
  assert.doesNotMatch(WEB_PLAN, /promoLive && entitled \? \(/);
});


test('a checkout that never confirms leaves the reader something to press', () => {
  // The poll gives up after a fixed number of attempts. Rendering nothing at
  // that point left someone who had just been charged with one warning
  // paragraph, no plan, no Manage billing, and nothing that would ever ask the
  // server again, for the rest of the session.
  assert.equal(/confirmationStalled \? null/.test(WEB_PLAN), false, 'the plan body is still hidden once the poll gives up');
  assert.match(WEB_PLAN, /onClick=\{\(\) => setConfirmAttempt\(0\)\}/);
});

test('a reader who already has a plan is not sent to a button that is not on screen', () => {
  // Manage billing is rendered only to someone we already believe is
  // subscribed, and the only way to reach these three answers is to press a buy
  // button, which is rendered only to someone we believe is not. So whenever
  // "Use Manage billing to change it" could be read, the control it named was
  // guaranteed to be absent, and the buy buttons underneath it were the wrong
  // answer as well. All three mean the same thing: our copy of the account is
  // stale. One of them is returned only after the server has already repaired
  // the record, so a second read is certain to find the plan.
  const start = WEB_API.indexOf('const STALE_SUBSCRIPTION_CODES');
  const codes = WEB_API.slice(start, WEB_API.indexOf(']);', start));
  for (const code of ['subscription_already_active', 'subscription_recovered', 'subscription_change_required']) {
    assert.match(WORKER, new RegExp(`error: '${code}'`), `the Worker no longer answers with ${code}`);
    assert.match(codes, new RegExp(`'${code}'`), `${code} is not treated as a stale subscription`);
  }
  assert.match(
    WEB_API,
    /staleSubscription: result\.serverCode !== null && STALE_SUBSCRIPTION_CODES\.has\(result\.serverCode\)/,
    'the checkout failure no longer reports a stale subscription',
  );
  // Into the same poll a payment uses, which hides the tier list while it runs
  // and ends in a warning with a Check again if the plan never appears.
  assert.match(
    WEB_PLAN,
    /if \(result\.staleSubscription\) \{\s*\n\s*setConfirmReason\('already_active'\);\s*\n\s*setConfirmAttempt\(0\);/,
    'the browser argues with the reader instead of re-reading the account',
  );
});

test('the wait for a plan we already hold does not claim a payment was taken', () => {
  // Same poll, two ways in, and for a while the same words. Reaching it from a
  // refused buy button means nothing was charged in that press: the account
  // already held a plan our copy of the state had not caught up with. Telling
  // that reader "Payment received" is a claim about their money that is not
  // true. The phone answers the same server codes with "Your plan is already
  // active", so the browser has to say something the phone would recognise.
  assert.match(WEB_PLAN, /const \[confirmReason, setConfirmReason\] = useState<'payment' \| 'already_active'>/);
  // The paid route still says the paid thing.
  assert.match(
    WEB_PLAN,
    /if \(checkout === 'success'\) \{\s*\n\s*setConfirmReason\('payment'\);/,
    'a real Stripe return must still be reported as a payment',
  );
  // Both the spinner and the gave-up warning have to switch, or one of them
  // still says it.
  assert.match(
    WEB_PLAN,
    /confirmReason === 'already_active' \? SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING : CHECKOUT_CONFIRMING_MESSAGE/,
  );
  assert.match(
    WEB_PLAN,
    /confirmReason === 'already_active' \? SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE : CHECKOUT_CONFIRMATION_SLOW_MESSAGE/,
  );
  // Written once, in shared, like every other line on this screen.
  const shared = read('../../../packages/shared/src/content/checkoutNotices.ts');
  assert.match(shared, /export const SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING = /);
  assert.match(shared, /export const SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE =/);
  for (const name of ['SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING', 'SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE']) {
    const line = shared.slice(shared.indexOf(`export const ${name}`), shared.indexOf(';', shared.indexOf(`export const ${name}`)));
    assert.equal(/Payment received/.test(line), false, `${name} still claims a payment was taken`);
  }
});

test('Manage billing is not live while a plan change is on its way to Stripe', () => {
  // The tier buttons above carry both halves of this guard, and the phone
  // carries one combined flag across both billing actions. With portalBusy
  // alone this button stayed pressable for the whole page-unload window after
  // Switch to was pressed, and a press there opened a second portal session
  // naming no tier, which could win the redirect race and land the reader in
  // the plain portal instead of the plan change they asked for.
  assert.match(
    WEB_PLAN,
    /onClick=\{\(\) => void manage\(\)\}\s*\n\s*disabled=\{portalBusy \|\| busyTier !== null\}/,
    'Manage billing is still armed while a checkout or tier change is leaving',
  );
  assert.match(WEB_PLAN, /disabled=\{busyTier !== null \|\| portalBusy\}/, 'the tier buttons lost half their guard');
  assert.match(
    MOBILE,
    /const actionInFlight = checkoutInFlight \|\| billingPortalInFlight;/,
    'the phone no longer guards its two billing actions together',
  );
});

test('the promo price and its terms always travel together', () => {
  // A struck-through price with no "then £29 from month 3" line is the kind of
  // half-told discount that reads as a bait and switch.
  assert.match(WEB_PLAN, /launchPromoTermsLine\(tier\)/);
  assert.match(WEB_PLAN, /line-through/);
});

test('the current plan is not a button', () => {
  // It used to open the portal, which is a different action wearing the wrong
  // label. Manage billing below it is the real control.
  const block = WEB_PLAN.slice(WEB_PLAN.indexOf('{isCurrent ? ('), WEB_PLAN.indexOf(') : entitled ? ('));
  assert.match(block, /Your current plan/);
  assert.equal(/<button/.test(block), false, 'the current plan card still renders a button');
});
