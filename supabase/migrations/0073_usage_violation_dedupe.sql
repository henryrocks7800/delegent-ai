begin;

-- 0073 — stop one denial being recorded fifty thousand times
--
-- usage_violations is an audit ledger: one row per blocked send, so support and
-- incident response can see every refusal. docs/QUOTA_JOURNEY.md §7 says a token
-- cap records EVERY blocked send, on the reasoning that "the Worker debouncer is
-- the per-user rate limit; the user can't spam token-cap violations within their
-- rate-limit window".
--
-- That reasoning holds for a person typing and does not hold for a runner
-- retrying. Between 2026-07-13 and 2026-08-26 a request wanting 28,266 tokens
-- against 22,677 remaining was retried every 6.2 seconds for six days. It could
-- never succeed, and every attempt wrote a row. Six such loops ran at once and
-- all stopped in the same second on 26 August.
--
--   511,861 rows, 3 users, 511,860 of them cap_kind = 'token'
--   457,751 on a single account
--   107 distinct denials underneath all of it
--
-- The volume broke a shipped feature: the Article 15 export cannot page half a
-- million rows, so it refused, so an affected account could not get its data at
-- all until the export learned to cap that one source.
--
-- Two changes here, and NEITHER loses a fact an audit needs:
--
--   1. Collapse the history to one row per identical denial per hour. Who was
--      refused, what kind of cap, how much they asked for, how much they had,
--      and which hour it happened in are all preserved. 511,861 becomes 1,065.
--      Only the repetition goes.
--   2. Make the repetition impossible to write again, with a unique index on
--      exactly that shape. The Worker's insert is already best-effort and
--      ignores the response, so a duplicate is refused by the database and
--      discarded without touching the user's request. No Worker change.

-- ---------------------------------------------------------------------------
-- The hour bucket the uniqueness is defined on
-- ---------------------------------------------------------------------------
-- `at time zone 'UTC'` is not decoration. date_trunc on a timestamptz depends
-- on the session TimeZone and is therefore not immutable, and PostgreSQL
-- refuses a generated column or an index on a mutable expression. Converting to
-- UTC first yields a plain timestamp and an immutable expression.

alter table public.usage_violations
  add column if not exists occurred_hour timestamp
  generated always as (date_trunc('hour', occurred_at at time zone 'UTC')) stored;

comment on column public.usage_violations.occurred_hour is
  'UTC hour of occurred_at. Exists only to carry the uniqueness that stops one unsatisfiable denial being logged thousands of times; see 0073.';

-- ---------------------------------------------------------------------------
-- Collapse the history, keeping the earliest of each identical denial per hour
-- ---------------------------------------------------------------------------
-- The earliest rather than an arbitrary one: the first refusal in an hour is
-- the one whose timestamp means something.

delete from public.usage_violations v
 using (
   select id,
          row_number() over (
            partition by user_id, cap_kind, requested, available, occurred_hour
            order by occurred_at asc, id asc
          ) as rank
     from public.usage_violations
 ) ranked
 where ranked.id = v.id
   and ranked.rank > 1;

-- ---------------------------------------------------------------------------
-- And it cannot come back
-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT so a pair of NULL `requested`/`available` values collapses
-- too. Without it, PostgreSQL treats every NULL as unique and the loop that
-- caused this would simply write NULLs instead.

create unique index if not exists usage_violations_one_per_hour_idx
  on public.usage_violations (user_id, cap_kind, requested, available, occurred_hour)
  nulls not distinct;

commit;
