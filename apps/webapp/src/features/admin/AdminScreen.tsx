import { useEffect, useMemo, useState } from 'react';
import { apiFetch, isFailure } from '../../lib/api';
import { adminLoadErrorMessage } from './adminError';

// Owner-eyes-only business dashboard, replacing the throwaway static
// delegent-econ page. Everything rendered here is computed live by the Worker
// on each load (/api/admin/dashboard); the Worker enforces the admin
// allowlist, so this screen's only job is to render or explain a refusal.
// There is deliberately NO navigation link to /admin anywhere: the two people
// who use it bookmark it, and everyone else never learns it exists.

// Chart palette: reference dataviz palette slots 1-3, validated 2026-08-04
// (validate_palette.js, light surface): revenue blue, cost orange, profit
// aqua. Aqua carries a contrast warning, so profit is also direct-labelled
// and every chart has its table underneath - identity is never color-alone.
const SERIES = { revenue: '#2a78d6', cost: '#eb6834', profit: '#1baf7a' } as const;

type UserRow = {
  /** Their own name where we hold one. Empty falls back to the email alone. */
  name: string;
  email: string;
  tierId: string | null;
  subscriptionStatus: string;
  /** Who bills them, because Apple's cut is four times Stripe's. */
  billingProvider: string;
  consumedTokensThisCycle: number;
  quotaTokens: number;
  talkSecondsThisCycle: number;
  revenueGbp: number;
  billingFeeGbp: number;
  inferenceGbp: number;
  talkGbp: number;
  marginGbp: number;
  marginPct: number | null;
};

type ProjectionPoint = {
  subscribers: number;
  revenueGbp: number;
  billingFeeGbp: number;
  inferenceGbp: number;
  talkGbp: number;
  fixedGbp: number;
  profitGbp: number;
  marginPct: number;
};

type ProjectionScenario = {
  key: string;
  label: string;
  note: string;
  tokens: number;
  talkSeconds: number;
  contributionGbp: number;
  breakEvenSubscribers: number | null;
  targets: { profitGbp: number; subscribers: number | null }[];
  points: ProjectionPoint[];
};

interface Dashboard {
  generatedAt: string;
  overview: {
    totalUsers: number;
    activeSubscribers: number;
    pastCustomers: number;
    prospects: number;
    mrrGbp: number;
    monthlyCostGbp: number;
    monthlyProfitGbp: number;
    openRouter: { totalUsd: number; usedUsd: number; remainingUsd: number; estRunwayDays: number | null } | null;
    tokens7d: number;
  };
  customers: {
    active: UserRow[];
    past: (UserRow & { lapsedAt: string | null })[];
    prospects: { count: number; rows: { name: string; email: string; signedUpAt: string }[] };
  };
  capex: {
    rows: { date: string; category: string; vendor: string; description: string; amountGbp: number }[];
    receiptedTotalGbp: number;
    openRouterPurchasedUsd: number | null;
    financeActuals: {
      asAt: string;
      source: string;
      bankBalanceGbp: number;
      revenueToDateGbp: number;
      capitalIntroducedGbp: number;
      directorLoanGbp: number;
      spendToDateGbp: number;
      spendByCategory: { category: string; totalGbp: number }[];
      rows: { date: string; category: string; description: string; amountGbp: number; paidBy: string }[];
    } | null;
    note: string;
  };
  costs: {
    users: UserRow[];
    fixed: { label: string; gbpMonthly: number; basis: string; note: string }[];
    fixedTotalGbp: number;
    unitEconomics: Record<string, unknown> & { usdPerMTokMetered: number; planPriceGbp: number };
    variable: {
      billingFeesGbp: number;
      inferenceGbp: number;
      talkGbp: number;
      providerSpendThisMonthGbp: number | null;
    };
  };
  projections: {
    assumptions: Record<string, string>;
    personas: { key: string; label: string; tokens: number; talkSeconds: number; note: string }[];
    scenarios: ProjectionScenario[];
  };
  dates: {
    label: string;
    category: string;
    due: string | null;
    status: string;
    note: string;
    daysLeft: number | null;
  }[];
  monitoring: {
    worker: { ok: boolean; note: string };
    surfaces: { url: string; ok: boolean; status: number; ms: number }[];
  };
}

const TABS = ['Overview', 'Customers', 'Costs & profit', 'CapEx', 'Projections', 'Dates', 'Monitoring'] as const;
type Tab = (typeof TABS)[number];

const gbp = (n: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
const compact = (n: number) => new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(n);

export function AdminScreen() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    apiFetch<Dashboard>('/api/admin/dashboard').then((result) => {
      setLoading(false);
      if (isFailure(result)) {
        // 401 and 403 are different answers and must not share copy. See
        // adminError.ts for what conflating them cost.
        setError(adminLoadErrorMessage(result));
        return;
      }
      setError(null);
      setData(result.data);
    });
  };
  useEffect(load, []);

  if (loading && !data) return <p className="p-6 text-body-sm text-textSecondary">Fetching the live numbers…</p>;
  if (error) return <p className="p-6 text-body-sm text-textSecondary">{error}</p>;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Business dashboard</h1>
        <span className="text-body-sm text-textSecondary">
          Live, computed {new Date(data.generatedAt).toLocaleTimeString('en-GB')} ·{' '}
          <button className="underline" onClick={load}>
            refresh
          </button>
        </span>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-body-sm ${tab === t ? 'bg-accent text-accentText' : 'card hover:bg-bg'}`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Overview' && <Overview data={data} />}
      {tab === 'Customers' && <Customers data={data} />}
      {tab === 'Costs & profit' && <Costs data={data} />}
      {tab === 'CapEx' && <Capex data={data} />}
      {tab === 'Projections' && <Projections data={data} />}
      {tab === 'Dates' && <Dates data={data} />}
      {tab === 'Monitoring' && <Monitoring data={data} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-body-sm text-textSecondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className="mt-1 text-body-sm text-textSecondary">{sub}</p> : null}
    </div>
  );
}

function Overview({ data }: { data: Dashboard }) {
  const o = data.overview;
  const runway = o.openRouter?.estRunwayDays;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Stat
        label="The funnel"
        value={`${o.activeSubscribers} active`}
        sub={`${o.pastCustomers} past · ${o.prospects} signed up, didn't buy`}
      />
      <Stat label="Monthly revenue (MRR)" value={gbp(o.mrrGbp)} />
      <Stat label="Monthly cost, all-in" value={gbp(o.monthlyCostGbp)} sub="per-user + fixed" />
      <Stat
        label="Monthly profit"
        value={`${o.monthlyProfitGbp >= 0 ? '▲' : '▼'} ${gbp(o.monthlyProfitGbp)}`}
        sub={o.monthlyProfitGbp >= 0 ? 'in the black' : 'in the red'}
      />
      <Stat label="Tokens, last 7 days" value={compact(o.tokens7d)} />
      <Stat
        label="OpenRouter credit"
        value={o.openRouter ? `$${o.openRouter.remainingUsd}` : 'n/a'}
        sub={runway != null ? `~${runway} days at current burn (auto top-up is on)` : undefined}
      />
    </div>
  );
}

function Customers({ data }: { data: Dashboard }) {
  const SUBTABS = ['Active', 'Past', "Signed up, didn't buy"] as const;
  const [sub, setSub] = useState<(typeof SUBTABS)[number]>('Active');
  const { active, past, prospects } = data.customers;
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2" role="tablist">
        {SUBTABS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={sub === s}
            onClick={() => setSub(s)}
            className={`rounded-full px-3 py-1 text-body-sm ${sub === s ? 'bg-accentMuted text-accent' : 'card hover:bg-bg'}`}
          >
            {s}
            {s === 'Active' ? ` (${active.length})` : s === 'Past' ? ` (${past.length})` : ` (${prospects.count})`}
          </button>
        ))}
      </nav>

      {sub === 'Active' && (
        <section>
          <p className="mb-3 text-body-sm text-textSecondary">
            Paying right now. The full economics per person, worst margin first.
          </p>
          <UserEconomicsTable users={active} />
        </section>
      )}

      {sub === 'Past' && (
        <section>
          <p className="mb-3 text-body-sm text-textSecondary">
            Paid before, not active now. They cost nothing while they are away, and their chat history and connections
            are still here, so coming back is one payment and nothing else.
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b text-left text-textSecondary">
                  <th className="p-3">Customer</th>
                  <th className="p-3">Last plan</th>
                  <th className="p-3 text-right">Lapsed</th>
                </tr>
              </thead>
              <tbody>
                {past.map((u) => (
                  <tr key={u.email} className="border-b last:border-0">
                    <td className="p-3">
                      <CustomerName name={u.name} email={u.email} />
                    </td>
                    <td className="p-3">{u.tierId ?? '-'}</td>
                    <td className="p-3 text-right">
                      {u.lapsedAt ? new Date(u.lapsedAt).toLocaleDateString('en-GB') : '-'}
                    </td>
                  </tr>
                ))}
                {past.length === 0 && (
                  <tr>
                    <td className="p-3 text-textSecondary" colSpan={3}>
                      Nobody has lapsed.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sub === "Signed up, didn't buy" && (
        <section>
          <div className="card mb-4 p-4">
            <p className="text-body-sm text-textSecondary">Installed, signed in, then stopped at or before the paywall</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{prospects.count}</p>
            <p className="mt-1 text-body-sm text-textSecondary">
              This is the ad-spend signal: refresh after the adverts go out. A climbing count with few conversions says
              price or pitch; a flat count says the ads are not landing installs.
            </p>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b text-left text-textSecondary">
                  <th className="p-3">Person</th>
                  <th className="p-3 text-right">Signed up</th>
                </tr>
              </thead>
              <tbody>
                {prospects.rows.map((p) => (
                  <tr key={p.email} className="border-b last:border-0">
                    <td className="p-3">
                      <CustomerName name={p.name} email={p.email} />
                    </td>
                    <td className="p-3 text-right">{p.signedUpAt ? new Date(p.signedUpAt).toLocaleString('en-GB') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Capex({ data }: { data: Dashboard }) {
  const { rows, receiptedTotalGbp, openRouterPurchasedUsd, financeActuals, note } = data.capex;

  // The daily FreeAgent snapshot supersedes the static transcription whenever
  // it exists: real sums, real FX, refreshed by the box, not hand-copied.
  if (financeActuals) {
    const fa = financeActuals;
    const maxCat = Math.max(...fa.spendByCategory.map((c) => c.totalGbp), 1);
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Spend to date" value={gbp(fa.spendToDateGbp)} sub={`${fa.rows.length} entries, FreeAgent actuals`} />
          <Stat label="Revenue to date" value={gbp(fa.revenueToDateGbp)} sub="Stripe payouts, net of fees" />
          <Stat label="Bank balance" value={gbp(fa.bankBalanceGbp)} sub="Mettle, at last feed" />
          <Stat label="Owed to director" value={gbp(fa.directorLoanGbp)} sub="personally-paid spend on the loan account" />
        </div>
        <section className="card p-4">
          <h2 className="mb-2 font-semibold">Where the money went</h2>
          <div className="space-y-1">
            {fa.spendByCategory.map((c) => (
              <div key={c.category} className="flex items-center gap-2 text-body-sm">
                <span className="w-56 shrink-0 truncate">{c.category}</span>
                <div className="h-3 flex-1 rounded bg-black/5">
                  <div className="h-3 rounded bg-accent" style={{ width: `${(c.totalGbp / maxCat) * 100}%` }} />
                </div>
                <span className="w-20 text-right tabular-nums">{gbp(c.totalGbp)}</span>
              </div>
            ))}
          </div>
        </section>
        <div className="card overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b text-left text-textSecondary">
                <th className="p-3">Date</th>
                <th className="p-3">Category</th>
                <th className="p-3">What</th>
                <th className="p-3">Paid by</th>
                <th className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {fa.rows.map((r, i) => (
                <tr key={`${r.date}-${i}`} className="border-b last:border-0">
                  <td className="p-3">{r.date}</td>
                  <td className="p-3">{r.category}</td>
                  <td className="p-3">{r.description}</td>
                  <td className="p-3">{r.paidBy}</td>
                  <td className="p-3 text-right tabular-nums">{gbp(r.amountGbp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card p-4 text-body-sm text-textSecondary">
          {note} As at {new Date(fa.asAt).toLocaleString('en-GB')} · {fa.source}
          {openRouterPurchasedUsd != null ? ` · OpenRouter credit ever bought: $${openRouterPurchasedUsd}` : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Receipted spend to date" value={gbp(receiptedTotalGbp)} sub={`${rows.length} evidenced entries`} />
        <Stat
          label="OpenRouter credit bought"
          value={openRouterPurchasedUsd != null ? `$${openRouterPurchasedUsd}` : 'n/a'}
          sub="live from the provider, not yet ledgered"
        />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="border-b text-left text-textSecondary">
              <th className="p-3">Date</th>
              <th className="p-3">Category</th>
              <th className="p-3">Vendor</th>
              <th className="p-3">What</th>
              <th className="p-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.date}-${r.vendor}-${i}`} className="border-b last:border-0">
                <td className="p-3">{r.date}</td>
                <td className="p-3">{r.category}</td>
                <td className="p-3">{r.vendor}</td>
                <td className="p-3">{r.description}</td>
                <td className="p-3 text-right tabular-nums">{gbp(r.amountGbp)}</td>
              </tr>
            ))}
            <tr>
              <td className="p-3 font-medium" colSpan={4}>
                Receipted total
              </td>
              <td className="p-3 text-right font-medium tabular-nums">{gbp(receiptedTotalGbp)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="card p-4 text-body-sm text-textSecondary">{note}</p>
    </div>
  );
}

/**
 * One customer cell: their name, with the email underneath as the thing that
 * actually identifies the account. Falls back to the email alone for anyone we
 * hold no name for, which is what every row looked like before 2026-09-19.
 */
function CustomerName({ name, email }: { name?: string; email: string }) {
  if (!name?.trim()) return <span>{email}</span>;
  return (
    <span className="block">
      <span className="font-medium">{name}</span>
      <span className="block text-body-sm text-textSecondary">{email}</span>
    </span>
  );
}

function UserEconomicsTable({ users }: { users: UserRow[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="border-b text-left text-textSecondary">
            <th className="p-3">Customer</th>
            <th className="p-3">Pays</th>
            <th className="p-3">Status</th>
            <th className="p-3 text-right">Allowance used</th>
            <th className="p-3 text-right">Talk</th>
            <th className="p-3 text-right">Fee</th>
            <th className="p-3 text-right">Inference</th>
            <th className="p-3 text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.email} className="border-b last:border-0">
              <td className="p-3">
                <CustomerName name={u.name} email={u.email} />
              </td>
              <td className="p-3">
                <span className="tabular-nums">{u.revenueGbp > 0 ? gbp(u.revenueGbp) : 'free month'}</span>
                <span className="block text-body-sm text-textSecondary">
                  {u.billingProvider === 'apple' ? 'Apple' : 'Stripe'}
                </span>
              </td>
              <td className="p-3">{u.subscriptionStatus}</td>
              <td className="p-3 text-right tabular-nums">
                {compact(u.consumedTokensThisCycle)}
                {u.quotaTokens > 0 ? ` / ${compact(u.quotaTokens)}` : ''}
              </td>
              <td className="p-3 text-right tabular-nums">
                {u.talkSecondsThisCycle > 0 ? `${Math.round(u.talkSecondsThisCycle / 60)}m` : '-'}
              </td>
              <td className="p-3 text-right tabular-nums">{gbp(u.billingFeeGbp)}</td>
              <td className="p-3 text-right tabular-nums">{gbp(u.inferenceGbp + u.talkGbp)}</td>
              <td className={`p-3 text-right font-medium tabular-nums ${u.marginGbp < 0 ? 'text-danger' : ''}`}>
                {u.marginGbp < 0 ? '▼ ' : ''}
                {gbp(u.marginGbp)}
                {u.marginPct != null ? ` (${u.marginPct}%)` : ''}
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td className="p-3 text-textSecondary" colSpan={8}>
                Nobody in this bucket.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Costs({ data }: { data: Dashboard }) {
  const { fixed, fixedTotalGbp, unitEconomics, variable } = data.costs;
  const variableTotal = variable.billingFeesGbp + variable.inferenceGbp + variable.talkGbp;
  return (
    <div className="space-y-6">
      <p className="text-body-sm text-textSecondary">
        Per-person economics live under the Customers tab. This tab is the business-wide cost structure. Everything a
        customer costs is metered at ${unitEconomics.usdPerMTokMetered.toFixed(2)} a million tokens, which is the rate
        the meter itself charges at rather than an estimate, and the plan sells at {gbp(unitEconomics.planPriceGbp)}.
      </p>

      <section>
        <h2 className="mb-2 font-semibold">This month's variable costs · {gbp(variableTotal)}</h2>
        <div className="card p-4 text-body-sm">
          <p className="flex justify-between border-b py-1.5">
            <span>Apple and Stripe fees</span>
            <span className="tabular-nums">{gbp(variable.billingFeesGbp)}</span>
          </p>
          <p className="flex justify-between border-b py-1.5">
            <span>Inference</span>
            <span className="tabular-nums">{gbp(variable.inferenceGbp)}</span>
          </p>
          <p className="flex justify-between py-1.5">
            <span>Talk</span>
            <span className="tabular-nums">{gbp(variable.talkGbp)}</span>
          </p>
          <p className="mt-2 text-textSecondary">
            The shops take more than the model does. That is the whole variable cost picture since the per-user servers
            were retired on 18 September.
          </p>
          {variable.providerSpendThisMonthGbp != null && (
            <p className="mt-3 border-t pt-3 text-textSecondary">
              AI providers actually charged{' '}
              <span className="font-medium text-textPrimary tabular-nums">
                {gbp(variable.providerSpendThisMonthGbp)}
              </span>{' '}
              this month against {gbp(variable.inferenceGbp + variable.talkGbp)} of customer usage. The difference is
              development, testing and advert generation rather than customers, and it is carried in the fixed costs
              below so the break-even is not flattered.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Fixed monthly costs · {gbp(fixedTotalGbp)}</h2>
        <div className="card p-4">
          {fixed.map((c) => {
            const max = Math.max(...fixed.map((x) => x.gbpMonthly), 1);
            return (
              <div key={c.label} className="mb-2 last:mb-0" title={c.note}>
                <div className="flex justify-between text-body-sm">
                  <span>
                    {c.label} <span className="text-textSecondary">({c.basis})</span>
                  </span>
                  <span className="tabular-nums">{gbp(c.gbpMonthly)}</span>
                </div>
                <div className="mt-1 h-2 rounded bg-bg">
                  <div
                    className="h-2 rounded"
                    style={{ width: `${(c.gbpMonthly / max) * 100}%`, backgroundColor: SERIES.cost }}
                  />
                </div>
              </div>
            );
          })}
          <p className="mt-3 text-body-sm text-textSecondary">
            Amounts marked estimate are code-level constants, corrected in review when a real bill differs.
          </p>
        </div>
      </section>
    </div>
  );
}

function Projections({ data }: { data: Dashboard }) {
  const { scenarios, assumptions } = data.projections;
  const [active, setActive] = useState(scenarios[1]?.key ?? scenarios[0]?.key ?? '');
  const scenario = scenarios.find((s) => s.key === active) ?? scenarios[0];
  if (!scenario) return null;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="font-semibold">How many customers do I need</h2>
        <p className="mt-1 text-body-sm text-textSecondary">
          Each row is a kind of customer, measured from the people actually paying rather than assumed. Tap one to see
          the whole model on that basis. "Each is worth" is what one leaves after their shop's cut and what they cost to
          serve, and it is that figure which has to cover the fixed costs.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b text-left text-textSecondary">
                <th className="p-3">Customer</th>
                <th className="p-3 text-right">Tokens/mo</th>
                <th className="p-3 text-right">Talk</th>
                <th className="p-3 text-right">Each is worth</th>
                <th className="p-3 text-right">Break even</th>
                {scenario.targets.map((target) => (
                  <th key={target.profitGbp} className="p-3 text-right">
                    {gbp(target.profitGbp)}/mo
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr
                  key={s.key}
                  onClick={() => setActive(s.key)}
                  className={`cursor-pointer border-b last:border-0 ${s.key === active ? 'bg-bg' : ''}`}
                >
                  <td className="p-3">
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-body-sm text-textSecondary">{s.note}</span>
                  </td>
                  <td className="p-3 text-right tabular-nums">{compact(s.tokens)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {s.talkSeconds > 0 ? `${Math.round(s.talkSeconds / 60)}m` : '-'}
                  </td>
                  <td className={`p-3 text-right tabular-nums ${s.contributionGbp < 0 ? 'text-danger' : ''}`}>
                    {gbp(s.contributionGbp)}
                  </td>
                  <td className="p-3 text-right font-medium tabular-nums">{s.breakEvenSubscribers ?? 'never'}</td>
                  {s.targets.map((target) => (
                    <td key={target.profitGbp} className="p-3 text-right tabular-nums">
                      {target.subscribers ?? 'never'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-body-sm text-textSecondary">
          "Never" means that kind of customer costs more than they pay, so selling more of them widens the loss. If the
          maxed-out row ever says never, the allowance is set above what the price can carry.
        </p>
      </div>

      <ProfitChart points={scenario.points} label={scenario.label} />

      <div className="card overflow-x-auto">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="border-b text-left text-textSecondary">
              <th className="p-3">Subscribers</th>
              <th className="p-3 text-right">Revenue</th>
              <th className="p-3 text-right">Apple + Stripe</th>
              <th className="p-3 text-right">Inference</th>
              <th className="p-3 text-right">Talk</th>
              <th className="p-3 text-right">Fixed</th>
              <th className="p-3 text-right">Profit</th>
              <th className="p-3 text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {scenario.points.map((p) => (
              <tr key={p.subscribers} className="border-b last:border-0">
                <td className="p-3 tabular-nums">{p.subscribers}</td>
                <td className="p-3 text-right tabular-nums">{gbp(p.revenueGbp)}</td>
                <td className="p-3 text-right tabular-nums">{gbp(p.billingFeeGbp)}</td>
                <td className="p-3 text-right tabular-nums">{gbp(p.inferenceGbp)}</td>
                <td className="p-3 text-right tabular-nums">{gbp(p.talkGbp)}</td>
                <td className="p-3 text-right tabular-nums">{gbp(p.fixedGbp)}</td>
                <td className={`p-3 text-right font-medium tabular-nums ${p.profitGbp < 0 ? 'text-danger' : ''}`}>
                  {gbp(p.profitGbp)}
                </td>
                <td className="p-3 text-right tabular-nums">{p.marginPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-4 text-body-sm text-textSecondary">
        <p className="mb-1 font-medium text-textPrimary">Assumptions, stated so the numbers can never detach from them</p>
        {Object.entries(assumptions).map(([k, v]) => (
          <p key={k}>
            {k}: {v}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Three-series line chart, one axis (GBP), log-x over subscriber counts. */
function ProfitChart({ points, label }: { points: ProjectionPoint[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 280;
  const PAD = { l: 56, r: 96, t: 16, b: 32 };

  const model = useMemo(() => {
    const xs = points.map((p) => Math.log10(p.subscribers));
    const series = [
      { key: 'Revenue', color: SERIES.revenue, values: points.map((p) => p.revenueGbp) },
      {
        key: 'Total cost',
        color: SERIES.cost,
        values: points.map((p) => p.billingFeeGbp + p.inferenceGbp + p.talkGbp + p.fixedGbp),
      },
      { key: 'Profit', color: SERIES.profit, values: points.map((p) => p.profitGbp) },
    ];
    const allY = series.flatMap((s) => s.values).concat([0]);
    const yMin = Math.min(...allY);
    const yMax = Math.max(...allY) * 1.05;
    const x = (i: number) => PAD.l + ((xs[i] - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
    return { series, x, y, yMin, yMax };
  }, [points]);

  const { series, x, y } = model;
  const path = (values: number[]) => values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Monthly profit as subscribers grow, {label.toLowerCase()} customers</h2>
        <div className="flex gap-4 text-body-sm">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.key}
            </span>
          ))}
        </div>
      </div>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="min-w-[560px]"
          role="img"
          aria-label="Line chart of monthly revenue, total cost and profit against subscriber count"
          onMouseLeave={() => setHover(null)}
        >
          {/* recessive grid + zero line */}
          {[0.25, 0.5, 0.75].map((f) => {
            const gy = PAD.t + f * (H - PAD.t - PAD.b);
            return <line key={f} x1={PAD.l} x2={W - PAD.r} y1={gy} y2={gy} stroke="#e8e6e1" strokeWidth={1} />;
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#b9b6ae" strokeWidth={1} />
          <text x={PAD.l - 8} y={y(0) + 4} textAnchor="end" className="fill-current text-caption text-textSecondary">
            £0
          </text>

          {series.map((s) => (
            <g key={s.key}>
              <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} />
              {/* direct label at the line end: identity never color-alone */}
              <text
                x={x(points.length - 1) + 6}
                y={y(s.values[s.values.length - 1]) + 4}
                style={{ fill: s.color }}
                className="text-caption font-medium"
              >
                {s.key}
              </text>
            </g>
          ))}

          {/* x labels + hover targets */}
          {points.map((p, i) => (
            <g key={p.subscribers}>
              <text x={x(i)} y={H - 8} textAnchor="middle" className="fill-current text-caption text-textSecondary">
                {p.subscribers}
              </text>
              <rect
                x={x(i) - 20}
                y={PAD.t}
                width={40}
                height={H - PAD.t - PAD.b}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          ))}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="#b9b6ae" strokeDasharray="3 3" />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute top-2 rounded-lg border bg-white p-2 text-body-sm shadow" style={{ left: Math.min((x(hover) / W) * 100, 70) + '%' }}>
            <p className="font-medium">{points[hover].subscribers} subscribers</p>
            <p>Revenue {gbp(points[hover].revenueGbp)}</p>
            <p>Total cost {gbp(points[hover].inferenceGbp + points[hover].fixedGbp)}</p>
            <p className={points[hover].profitGbp < 0 ? 'text-danger' : ''}>Profit {gbp(points[hover].profitGbp)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Dates({ data }: { data: Dashboard }) {
  const sorted = [...data.dates].sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
  const badge = (d: Dashboard['dates'][number]) => {
    if (d.daysLeft != null && d.daysLeft < 0) return { text: 'OVERDUE', cls: 'bg-bg text-danger' };
    if (d.daysLeft != null && d.daysLeft < 60) return { text: `${d.daysLeft} days`, cls: 'bg-bg text-warning' };
    if (d.status === 'pending') return { text: 'awaiting reply', cls: 'bg-bg text-textSecondary' };
    if (d.status === 'verify') return { text: d.due ? `~${d.daysLeft} days · verify` : 'date needs confirming', cls: 'bg-bg text-warning' };
    return { text: `${d.daysLeft} days`, cls: 'bg-bg text-textSecondary' };
  };
  return (
    <div className="space-y-3">
      <p className="text-body-sm text-textSecondary">
        Amber entries are derived dates: confirm each at its named source and it turns quiet. Nothing here is silently assumed
        safe.
      </p>
      {sorted.map((d) => {
        const b = badge(d);
        return (
          <div key={d.label} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{d.label}</p>
              <span className={`rounded-full px-3 py-0.5 text-body-sm ${b.cls}`}>{b.text}</span>
            </div>
            <p className="mt-1 text-body-sm text-textSecondary">
              {d.due ? `Due ${d.due} ·` : ''}
              {d.note}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function Monitoring({ data }: { data: Dashboard }) {
  const m = data.monitoring;
  return (
    <div className="space-y-3">
      <div className="card p-4">
        <p className="font-medium">Live surface checks (probed just now, from the Worker)</p>
        <ul className="mt-2 space-y-1 text-body-sm">
          <li>✅ API worker - this page's data came from it</li>
          {m.surfaces.map((s) => (
            <li key={s.url}>
              {s.ok ? 'âœ…' : 'âŒ'} {s.url.replace('https://', '')} - {s.ok ? `${s.ms}ms` : `failed (${s.status || 'no response'})`}
            </li>
          ))}
        </ul>
      </div>
      <div className="card p-4 text-body-sm text-textSecondary">
        <p className="font-medium text-textPrimary">Also watching, outside this page</p>
        <p>· The always-on box probes all public surfaces every 5 minutes and emails on any outage (uptime-watch).</p>
        <p>· Sentry captures crashes for the app and the Worker (your-org, EU).</p>
        <p className="mt-1">Deeper aggregation (Sentry counts, snapshot ages, Actions minutes) is phase 2 of this dashboard.</p>
      </div>
    </div>
  );
}
