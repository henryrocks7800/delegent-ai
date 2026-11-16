/**
 * Durable state for bulk inbox sorts in the agent's own SQLite. What is kept:
 * job state and counts; the plan (sender decisions) only until filing ends;
 * the journal of moved message IDs for undo; aggregate notices. Never a subject
 * or a body.
 */
import type { SortProvider } from './inboxSort.ts';
import type { SortPlan } from './inboxSortRun.ts';
import type { SortModelUsage } from './inboxSortModel.ts';

export type SortState = 'planning' | 'awaiting_approval' | 'filing' | 'done' | 'failed' | 'cancelled';
const ACTIVE: SortState[] = ['planning', 'awaiting_approval', 'filing'];
export const SORT_JOURNAL_DAYS = 30;
export const SORT_APPROVAL_HOURS = 24;

export interface SortSummaryRow { name: string; count: number; newFolder: boolean }
export interface SortRecord {
  id: string; provider: SortProvider; state: SortState; workflowId?: string;
  createdAt: number; updatedAt: number;
  /** When the user's yes started filing. Absent on sorts approved before 2026-09-24. */
  filingStartedAt?: number;
  total?: number; toFile?: number; stay?: number; destinations?: SortSummaryRow[];
  moved: number; skipped: number; failedMoves: number;
  failure?: string;
  usage: SortModelUsage; billed: boolean;
  /** Composio calls made by the background work and not yet charged. */
  actions?: number;
}

/** Aggregate-only wire contract for the app message. Destination names and counts, nothing from any email. */
export interface SortNotice {
  kind: 'sort'; id: string; sortId: string; provider: SortProvider; outcome: 'plan' | 'done' | 'failed';
  total: number; toFile: number; stay: number; filed: number; groups: SortSummaryRow[];
}

type Value = string | number | null;
export interface SortDatabase {
  exec(query: string, ...values: Value[]): Iterable<Record<string, unknown>>;
  transaction<T>(callback: () => T): T;
}

const emptyUsage = (): SortModelUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export class InboxSortStore {
  private readonly db: SortDatabase;
  constructor(db: SortDatabase) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS inbox_sorts (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS inbox_sort_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS inbox_sort_moves (sort_id TEXT NOT NULL, message_id TEXT NOT NULL, folder_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(sort_id,message_id))');
    db.exec('CREATE TABLE IF NOT EXISTS inbox_sort_notices (id TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0)');
  }

  private write(record: SortRecord) {
    this.db.exec('INSERT INTO inbox_sorts(id,state,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',
      record.id, record.state, JSON.stringify(record));
  }
  get(id: string): SortRecord | null {
    const row = [...this.db.exec('SELECT data FROM inbox_sorts WHERE id=?', id)][0];
    return row ? JSON.parse(String(row.data)) as SortRecord : null;
  }
  latest(): SortRecord | null {
    const row = [...this.db.exec('SELECT data FROM inbox_sorts ORDER BY rowid DESC LIMIT 1')][0];
    return row ? JSON.parse(String(row.data)) as SortRecord : null;
  }
  active(): SortRecord | null {
    const row = [...this.db.exec(`SELECT data FROM inbox_sorts WHERE state IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`, ...ACTIVE)][0];
    return row ? JSON.parse(String(row.data)) as SortRecord : null;
  }

  create(provider: SortProvider, now = Date.now()): SortRecord {
    return this.db.transaction(() => {
      if (this.active()) throw new Error('INBOX_SORT_ACTIVE');
      const record: SortRecord = { id: crypto.randomUUID(), provider, state: 'planning', createdAt: now, updatedAt: now,
        moved: 0, skipped: 0, failedMoves: 0, usage: emptyUsage(), billed: true };
      this.write(record);
      return record;
    });
  }
  setWorkflow(id: string, workflowId: string) {
    const record = this.get(id);
    if (record) { record.workflowId = workflowId; this.write(record); }
  }

  /** The plan arrives from the workflow. Its model usage becomes billable on the next chat turn. */
  savePlan(id: string, plan: SortPlan, summary: { total: number; toFile: number; stay: number; destinations: SortSummaryRow[] }, now = Date.now(), actions = 0) {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== 'planning') return null;
      Object.assign(record, summary, { updatedAt: now, billed: false, actions: (record.actions ?? 0) + actions,
        usage: { calls: record.usage.calls + plan.usage.calls, inputTokens: record.usage.inputTokens + plan.usage.inputTokens,
          outputTokens: record.usage.outputTokens + plan.usage.outputTokens, costUsd: record.usage.costUsd + plan.usage.costUsd } });
      record.state = summary.toFile > 0 ? 'awaiting_approval' : 'done';
      this.write(record);
      if (record.state === 'awaiting_approval') this.db.exec('INSERT INTO inbox_sort_plans(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', id, JSON.stringify(plan));
      this.enqueue(`${id}:plan`, record, summary.toFile > 0 ? 'plan' : 'done');
      return record;
    });
  }
  plan(id: string): SortPlan | null {
    const row = [...this.db.exec('SELECT data FROM inbox_sort_plans WHERE id=?', id)][0];
    return row ? JSON.parse(String(row.data)) as SortPlan : null;
  }
  approve(id: string, now = Date.now()) {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== 'awaiting_approval') return null;
      if (now - record.updatedAt > SORT_APPROVAL_HOURS * 3_600_000) throw new Error('INBOX_SORT_PLAN_EXPIRED');
      record.state = 'filing'; record.updatedAt = now; record.filingStartedAt = now; this.write(record);
      return record;
    });
  }
  /** Journal one step's verified moves and update the running totals. */
  recordMoves(id: string, moves: { messageId: string; folderId: string }[], counts: { moved: number; skipped: number; failed: number }, now = Date.now(), actions = 0) {
    this.db.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== 'filing') return;
      for (const move of moves) this.db.exec('INSERT OR IGNORE INTO inbox_sort_moves(sort_id,message_id,folder_id,at) VALUES(?,?,?,?)', id, move.messageId, move.folderId, now);
      record.moved += counts.moved; record.skipped += counts.skipped; record.failedMoves += counts.failed; record.updatedAt = now;
      if (actions) { record.actions = (record.actions ?? 0) + actions; record.billed = false; }
      this.write(record);
    });
  }
  /** End of a sort in any outcome: the plan's sender decisions are deleted. */
  finish(id: string, outcome: 'done' | 'failed' | 'cancelled', failure?: string, now = Date.now()) {
    return this.db.transaction(() => {
      const record = this.get(id);
      if (!record || !ACTIVE.includes(record.state)) return record;
      record.state = outcome; record.updatedAt = now;
      if (failure) record.failure = failure.slice(0, 80);
      this.write(record);
      this.db.exec('DELETE FROM inbox_sort_plans WHERE id=?', id);
      if (outcome !== 'cancelled') this.enqueue(`${id}:${outcome}`, record, outcome);
      return record;
    });
  }
  journal(id: string): { messageId: string; folderId: string }[] {
    return [...this.db.exec('SELECT message_id,folder_id FROM inbox_sort_moves WHERE sort_id=? ORDER BY rowid', id)]
      .map((row) => ({ messageId: String(row.message_id), folderId: String(row.folder_id) }));
  }
  /** Undo journals and old plans go after SORT_JOURNAL_DAYS; a stuck plan never outlives its approval window. */
  prune(now = Date.now()) {
    this.db.exec('DELETE FROM inbox_sort_moves WHERE at < ?', now - SORT_JOURNAL_DAYS * 86_400_000);
    for (const row of [...this.db.exec("SELECT data FROM inbox_sorts WHERE state='awaiting_approval'")]) {
      const record = JSON.parse(String(row.data)) as SortRecord;
      if (now - record.updatedAt > SORT_APPROVAL_HOURS * 3_600_000) this.finish(record.id, 'cancelled', 'PLAN_EXPIRED', now);
    }
  }

  /** Model usage not yet charged to a chat turn. Marked billed in the same transaction. */
  drainUsage(): SortModelUsage & { actions: number } {
    return this.db.transaction(() => {
      const total = { ...emptyUsage(), actions: 0 };
      for (const row of [...this.db.exec('SELECT data FROM inbox_sorts')]) {
        const record = JSON.parse(String(row.data)) as SortRecord;
        if (record.billed) continue;
        total.calls += record.usage.calls; total.inputTokens += record.usage.inputTokens;
        total.outputTokens += record.usage.outputTokens; total.costUsd += record.usage.costUsd;
        total.actions += record.actions ?? 0;
        // Charged once: usage and actions reset as they are drained.
        record.usage = emptyUsage(); record.actions = 0; record.billed = true; this.write(record);
      }
      return total;
    });
  }

  private enqueue(key: string, record: SortRecord, outcome: SortNotice['outcome']) {
    const notice: SortNotice = { kind: 'sort', id: crypto.randomUUID(), sortId: record.id, provider: record.provider, outcome,
      // New mail from a planned sender can be filed too; the message reports the planned scope.
      total: record.total ?? 0, toFile: record.toFile ?? 0, stay: record.stay ?? 0, filed: Math.min(record.moved, record.toFile ?? 0),
      groups: outcome === 'plan' ? (record.destinations ?? []).slice(0, 50) : [] };
    this.db.exec("INSERT OR IGNORE INTO inbox_sort_notices(id,event_key,state,data) VALUES(?,?,'pending',?)", notice.id, key, JSON.stringify(notice));
  }
  hasPendingNotices() { return [...this.db.exec("SELECT 1 FROM inbox_sort_notices WHERE state='pending' LIMIT 1")].length > 0; }
  claimNotice(now = Date.now()): { notice: SortNotice; leaseUntil: number } | null {
    // One transaction, no recursion: Durable Object storage does not nest transactions.
    return this.db.transaction(() => {
      const rows = [...this.db.exec("SELECT id,data FROM inbox_sort_notices WHERE state='pending' AND lease_until<=? AND next_attempt_at<=? ORDER BY rowid LIMIT 20", now, now)];
      for (const row of rows) {
        const notice = JSON.parse(String(row.data)) as SortNotice;
        // A plan that was cancelled or expired must not still ask for approval.
        if (notice.outcome === 'plan' && this.get(notice.sortId)?.state !== 'awaiting_approval') {
          this.db.exec("UPDATE inbox_sort_notices SET state='superseded' WHERE id=?", String(row.id));
          continue;
        }
        const leaseUntil = now + 30_000;
        this.db.exec('UPDATE inbox_sort_notices SET lease_until=?,attempts=attempts+1 WHERE id=?', leaseUntil, String(row.id));
        return { notice, leaseUntil };
      }
      return null;
    });
  }
  settleNotice(id: string, leaseUntil: number, delivered: boolean, now = Date.now()) {
    this.db.exec("UPDATE inbox_sort_notices SET state=?,lease_until=0,next_attempt_at=? WHERE id=? AND state='pending' AND lease_until=?",
      delivered ? 'delivered' : 'pending', delivered ? 0 : now + 15_000, id, leaseUntil);
  }
  /** Whether the plan the user is answering was actually delivered to the app. */
  planDelivered(sortId: string): boolean {
    return [...this.db.exec("SELECT 1 FROM inbox_sort_notices WHERE state='delivered' AND json_extract(data,'$.sortId')=? AND json_extract(data,'$.outcome')='plan' LIMIT 1", sortId)].length > 0;
  }
}
