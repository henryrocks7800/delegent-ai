-- Finance actuals, snapshotted daily from FreeAgent.
--
-- The admin dashboard's CapEx tab was a hand-transcribed copy of the
-- operations-repo ledger and drifted the moment it was written (5 rows,
-- £166.08, against a real ledger of 30+ rows and £850+). Rather than keep
-- transcribing, the box pulls the actual sums out of FreeAgent once a day
-- (infra/scripts/freeagent-finance-snapshot.py, scheduled alongside the
-- token keeper) and writes ONE row here; the Worker's admin endpoint reads
-- it and falls back to the code-level table only when this is empty.
--
-- Single-row table by design: id is fixed at 1 and the writer upserts. The
-- payload is jsonb rather than columns because the shape is owned by the
-- writer script and the dashboard renders whatever arrives; a schema change
-- must not need a migration.
create table if not exists public.finance_snapshot (
  id integer primary key,
  taken_at timestamptz not null default now(),
  payload jsonb not null
);

-- Same posture as install_attribution (0052): RLS on with no policies, and
-- the default anon/authenticated grants taken off. Only the service role
-- (Worker read, box-task write) touches this table; it holds the company's
-- real spend and bank balance, which no client should ever see.
alter table public.finance_snapshot enable row level security;
revoke all on public.finance_snapshot from anon, authenticated;
