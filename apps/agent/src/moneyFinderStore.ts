/**
 * Durable state for Money Finder runs in the agent's own SQLite, on the inbox
 * sort's pattern (inboxSortStore.ts): one active run, model usage billed on the
 * next chat turn, and a delivery outbox for the report message. What is kept:
 * run state, counts and the findings (company names, amounts, dates, a short
 * fixed-shape detail). Never an email subject, body or address.
 */
import type { SortModelUsage } from './inboxSortModel.ts';
import type { SortDatabase } from './inboxSortStore.ts';
import { moneyTotals, type MoneyFinding, type MoneyProvider } from './moneyFinder.ts';

export type MoneyState = 'running' | 'done' | 'failed';
export const MONEY_REPORT_ITEMS = 15;

export interface MoneyRecord {
  id: string; provider: MoneyProvider; state: MoneyState; workflowId?: string;
  createdAt: number; updatedAt: number; read: number;
  findings: MoneyFinding[]; failure?: string;
  usage: SortModelUsage; actions: number; billed: boolean;
}

/** Wire contract for the app message. Keep in sync with apps/worker/src/inbox-notice.ts. */
export interface MoneyNotice {
  kind: 'money'; id: string; runId: string; provider: MoneyProvider; outcome: 'report' | 'failed';
  read: number; owedPence: number; subscriptionCount: number; subscriptionsYearlyPence: number; priceRisesYearlyPence: number; trialsEnding: number;
  items: { kind: MoneyFinding['kind']; merchant: string; amountPence: number; yearlyPence: number; detail: string }[];
}

const emptyUsage = (): SortModelUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
// Money owed first, then price rises, trials and subscriptions, biggest first.
const ORDER: Record<MoneyFinding['kind'], number> = { flight_compensation: 0, refund_due: 1, upgrade_overcharge: 2, price_rise: 3, trial_ending: 4, subscription: 5 };

export class MoneyFinderStore {
  private readonly db: SortDatabase;
  constructor(db: SortDatabase) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS money_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS money_notices (id TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0)');
  }
  private write(record: MoneyRecord) {
    this.db.exec('INSERT INTO money_runs(id,state,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',
      record.id, record.state, JSON.stringify(record));
  }
  get(id: string): MoneyRecord | null {
    const row = [...this.db.exec('SELECT data FROM money_runs WHERE id=?', id)][0];
    return row ? JSON.parse(String(row.data)) as MoneyRecord : null;
  }
  latest(): MoneyRecord | null {
    const row = [...this.db.exec('SELECT data FROM money_runs ORDER BY rowid DESC LIMIT 1')][0];
    return row ? JSON.parse(String(row.data)) as MoneyRecord : null;
  }
  active(): MoneyRecord | null {
    const row = [...this.db.exec("SELECT data FROM money_runs WHERE state='running' ORDER BY rowid DESC LIMIT 1")][0];
    return row ? JSON.parse(String(row.data)) as MoneyRecord : null;
  }
  create(provider: MoneyProvider, now = Date.now()): MoneyRecord {
    return this.db.transaction(() => {
      if (this.active()) throw new Error('MONEY_FINDER_ACTIVE');
      const record: MoneyRecord = { id: crypto.randomUUID(), provider, state: 'running', createdAt: now, updatedAt: now, read: 0,
        findings: [], usage: emptyUsage(), actions: 0, billed: true };
      this.write(record);
      return record;
    });
  }
  /**
   * Runs started since a time, for the daily limit. A run that failed before
   * it read a single email cost next to nothing, so it does not use up one of
   * the day's runs (Alex, 2026-09-27: "it always limits you"). A run that
   * failed after reading still counts: that reading is the cost the limit caps.
   */
  startedSince(since: number): number {
    return [...this.db.exec('SELECT data FROM money_runs')].map((row) => JSON.parse(String(row.data)) as MoneyRecord)
      .filter((record) => record.createdAt >= since && !(record.state === 'failed' && record.read === 0)).length;
  }
  setWorkflow(id: string, workflowId: string) {
    const record = this.get(id);
    if (record) { record.workflowId = workflowId; this.write(record); }
  }
  /** One workflow step's model usage and Composio calls, billed on the next chat turn. */
  addUsage(id: string, usage: SortModelUsage, actions: number, read: number, now = Date.now()) {
    this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== 'running') return;
      record.usage = { calls: record.usage.calls + usage.calls, inputTokens: record.usage.inputTokens + usage.inputTokens,
        outputTokens: record.usage.outputTokens + usage.outputTokens, costUsd: record.usage.costUsd + usage.costUsd };
      record.actions += actions; record.read += read; record.billed = false; record.updatedAt = now;
      this.write(record);
    });
  }
  finish(id: string, outcome: 'done' | 'failed', findings: MoneyFinding[] = [], failure?: string, now = Date.now()) {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== 'running') return record;
      record.state = outcome; record.updatedAt = now; record.findings = findings;
      if (failure) record.failure = failure.slice(0, 80);
      this.write(record);
      this.enqueue(record);
      return record;
    });
  }

  drainUsage(): SortModelUsage & { actions: number } {
    return this.db.transaction(() => {
      const total = { ...emptyUsage(), actions: 0 };
      for (const row of [...this.db.exec('SELECT data FROM money_runs')]) {
        const record = JSON.parse(String(row.data)) as MoneyRecord;
        if (record.billed) continue;
        total.calls += record.usage.calls; total.inputTokens += record.usage.inputTokens;
        total.outputTokens += record.usage.outputTokens; total.costUsd += record.usage.costUsd; total.actions += record.actions;
        record.usage = emptyUsage(); record.actions = 0; record.billed = true; this.write(record);
      }
      return total;
    });
  }

  private enqueue(record: MoneyRecord) {
    const totals = moneyTotals(record.findings);
    const items = [...record.findings]
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (b.yearlyPence ?? b.amountPence) - (a.yearlyPence ?? a.amountPence))
      .slice(0, MONEY_REPORT_ITEMS)
      .map((f) => ({ kind: f.kind, merchant: f.merchant, amountPence: f.amountPence, yearlyPence: f.yearlyPence ?? 0, detail: f.detail.slice(0, 120) }));
    const notice: MoneyNotice = { kind: 'money', id: crypto.randomUUID(), runId: record.id, provider: record.provider,
      outcome: record.state === 'done' ? 'report' : 'failed', read: record.read, ...totals, items: record.state === 'done' ? items : [] };
    this.db.exec("INSERT OR IGNORE INTO money_notices(id,event_key,state,data) VALUES(?,?,'pending',?)", notice.id, `${record.id}:${record.state}`, JSON.stringify(notice));
  }
  hasPendingNotices() { return [...this.db.exec("SELECT 1 FROM money_notices WHERE state='pending' LIMIT 1")].length > 0; }
  claimNotice(now = Date.now()): { notice: MoneyNotice; leaseUntil: number } | null {
    return this.db.transaction(() => {
      const row = [...this.db.exec("SELECT id,data FROM money_notices WHERE state='pending' AND lease_until<=? AND next_attempt_at<=? ORDER BY rowid LIMIT 1", now, now)][0];
      if (!row) return null;
      const leaseUntil = now + 30_000;
      this.db.exec('UPDATE money_notices SET lease_until=?,attempts=attempts+1 WHERE id=?', leaseUntil, String(row.id));
      return { notice: JSON.parse(String(row.data)) as MoneyNotice, leaseUntil };
    });
  }
  settleNotice(id: string, leaseUntil: number, delivered: boolean, now = Date.now()) {
    this.db.exec("UPDATE money_notices SET state=?,lease_until=0,next_attempt_at=? WHERE id=? AND state='pending' AND lease_until=?",
      delivered ? 'delivered' : 'pending', delivered ? 0 : now + 15_000, id, leaseUntil);
  }
}
