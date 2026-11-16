-- Install attribution: which advert produced which user.
--
-- Why this exists. On 2026-08-06 an advertising campaign produced 43 clicks and
-- zero installs, and nothing in the system could say whether people were lost at
-- the advert, the store listing, or first launch. Meta's own documentation
-- explains half of it: "When you first complete app setup, you can only optimize
-- delivery of your ads for LINK_CLICK." Until Meta can see installs it optimises
-- for the cheapest tap, which is a different population from people who install.
--
-- This table is the FIRST-PARTY half of the fix, and it is deliberately
-- independent of Meta. Google Play hands every install a referrer string, and
-- expo-application (already compiled into the shipped 2.2.0 binary, it arrived
-- with expo-notifications) can read it from JavaScript. So we can compute our own
-- true cost per campaign whatever Meta chooses to credit, and we can do it by
-- over-the-air update with no Play Store release.
--
-- One row per user. The referrer is only readable once, on first launch, and
-- only for 90 days after install, so a row that is missed is missed for good:
-- writes are therefore insert-or-ignore rather than upsert, and the FIRST
-- capture wins. A later launch must never overwrite the original attribution.

create table if not exists public.install_attribution (
  user_id       uuid primary key references auth.users(id) on delete cascade,

  -- Exactly what Google Play returned, kept verbatim and forever. Every parsed
  -- column below is a derivation, and derivations have bugs; the raw string is
  -- what lets a future fix be applied retrospectively.
  raw_referrer  text not null,

  -- Plain UTM parts, present for organic and for most non-Meta sources.
  -- An organic Play install typically looks like
  -- "utm_source=google-play&utm_medium=organic".
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,

  -- Meta encrypts its campaign metadata into utm_content rather than exposing
  -- it, so these stay null until the Worker decrypts it with the Install
  -- Referrer Decryption Key. Nullable on purpose: attribution is still useful
  -- without them, and we must never drop a referrer just because decryption
  -- failed or the key is not configured yet.
  meta_campaign_id text,
  meta_adgroup_id  text,
  meta_ad_id       text,
  meta_account_id  text,
  -- Why decryption did not happen or did not work. Null when it succeeded or
  -- when the referrer was never a Meta one. Recorded rather than swallowed,
  -- because a silent decrypt failure would look exactly like organic traffic.
  decrypt_error    text,

  -- Play's own timestamps, which let us measure the gap between the advert
  -- being clicked and the install starting.
  referrer_click_at timestamptz,
  install_begin_at  timestamptz,

  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- The question this table exists to answer: how many users did each campaign
-- produce, and what did they go on to do.
create index if not exists install_attribution_campaign_idx
  on public.install_attribution (meta_campaign_id)
  where meta_campaign_id is not null;

create index if not exists install_attribution_source_idx
  on public.install_attribution (utm_source);

-- Service-role only, like push_tokens. The mobile client posts its referrer to
-- the Worker and the Worker writes here; the client never touches this table.
-- Attribution data identifies which advert a person responded to, which is not
-- something one user should ever be able to read about another.
alter table public.install_attribution enable row level security;
