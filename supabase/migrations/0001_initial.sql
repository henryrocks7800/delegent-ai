create extension if not exists pgcrypto;

create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, email text not null, full_name text, created_at timestamptz not null default now());
create table public.acknowledgements (user_id uuid primary key references public.profiles(id) on delete cascade, accepted_at timestamptz not null default now(), text_version text not null default 'v1');
create table public.subscriptions (user_id uuid primary key references public.profiles(id) on delete cascade, status text not null default 'inactive', stripe_customer_id text, stripe_subscription_id text, price_id text, current_period_end timestamptz, updated_at timestamptz not null default now());
create table public.hermes_instances (user_id uuid primary key references public.profiles(id) on delete cascade, status text not null default 'not_requested', railway_project_id text, railway_service_id text, railway_volume_id text, base_url text, last_health_at timestamptz, error text, updated_at timestamptz not null default now());
create table public.messages (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, role text not null, content text not null, task_id text, created_at timestamptz not null default now());
create table public.token_usage_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, prompt_tokens int not null default 0, completion_tokens int not null default 0, total_tokens int not null default 0, model text, source text not null default 'worker', created_at timestamptz not null default now());
create table public.usage_quotas (user_id uuid primary key references public.profiles(id) on delete cascade, monthly_token_quota int not null default 1000000, updated_at timestamptz not null default now());
create table public.provisioning_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, event text not null, details jsonb not null default '{}', created_at timestamptz not null default now());

alter table public.profiles enable row level security; alter table public.acknowledgements enable row level security; alter table public.subscriptions enable row level security; alter table public.hermes_instances enable row level security; alter table public.messages enable row level security; alter table public.token_usage_events enable row level security; alter table public.usage_quotas enable row level security; alter table public.provisioning_events enable row level security;

create policy "own profiles" on public.profiles for select using (auth.uid() = id);
create policy "own acknowledgements" on public.acknowledgements for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own subscriptions read" on public.subscriptions for select using (auth.uid() = user_id);
create policy "own hermes read" on public.hermes_instances for select using (auth.uid() = user_id);
create policy "own messages" on public.messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own usage read" on public.token_usage_events for select using (auth.uid() = user_id);
create policy "own quotas read" on public.usage_quotas for select using (auth.uid() = user_id);
create policy "own provisioning read" on public.provisioning_events for select using (auth.uid() = user_id);
