-- 0059: one-off nurture email to people who created an account but did not
-- pick a plan (2026-09-09, Alex: "do number nine"). One row per user, written
-- by the Worker cron the moment the email is handed to Resend, so a user can
-- never be emailed twice and a retry after a failed send is safe.
create table if not exists public.nurture_emails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kind text not null default 'paywall_bounce_24h',
  sent_at timestamptz not null default now(),
  resend_id text
);

alter table public.nurture_emails enable row level security;
-- Service role only. No policies: the anon and authenticated roles get nothing.
revoke all on public.nurture_emails from anon, authenticated;

comment on table public.nurture_emails is
  'Marketing/nurture emails sent by the Worker cron, one row per user per kind. Service-role only.';
