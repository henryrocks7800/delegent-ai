-- Referrals (growth plan, 2026-09-23; Alex: "happy for you to do everything").
--
-- A paying member has one invite code. A new account that enters it is linked to
-- the member who invited them, and when that friend's first paid period starts
-- the member gets a free month: a credit on their Stripe balance, applied to
-- their next invoice (apps/worker/src/referrals.ts). Up to 12 a year.
--
-- Server-side only: the Worker reads and writes both tables with the service
-- role; no app ever touches them directly. Rows go with the account (cascade),
-- so account erasure needs no extra step.

create table public.referral_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at timestamptz not null default now()
);

create table public.referrals (
  id bigint generated always as identity primary key,
  referrer_user_id uuid not null references auth.users (id) on delete cascade,
  referred_user_id uuid not null unique references auth.users (id) on delete cascade,
  code text not null,
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'void')),
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  reward_reference text,
  void_reason text,
  check (referrer_user_id <> referred_user_id)
);

create index referrals_referrer_idx on public.referrals (referrer_user_id, status);

alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;

-- No policies: RLS with none denies every row to the app roles, and the grants
-- are removed as well, so the protection does not rest on a single switch.
revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referrals from anon, authenticated;
revoke all on sequence public.referrals_id_seq from anon, authenticated;

-- Explicit grants: Supabase stops granting new public tables to anyone,
-- service_role included, from 2026-10-30 (scripts/lib/migration-grants.mjs).
grant select, insert, update, delete on public.referral_codes to service_role;
grant select, insert, update, delete on public.referrals to service_role;
grant usage, select on sequence public.referrals_id_seq to service_role;
