-- 0033 — add service_paused to delegent_billing_guard singleton.
-- The R-OPS-07 forensic test expects this column to exist so the global
-- spend guard can signal an org-wide pause when monthly_spend exceeds budget.
alter table public.delegent_billing_guard
  add column if not exists service_paused boolean not null default false;
