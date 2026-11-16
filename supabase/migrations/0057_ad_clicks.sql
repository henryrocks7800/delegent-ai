-- Ad clicks: did a paid click ever actually reach our site?
--
-- Why this exists. On 2026-09-03 a diagnosis of the live campaigns found that
-- Meta had charged us for 732 link clicks across three campaigns while Google
-- Play recorded 3 installs in the whole of August, and NOTHING in our system
-- could say whether a single one of those clicks had loaded a page of ours.
-- The marketing site carried no analytics tag at all, and the Meta Pixel had
-- fired five times in its life, all of them on one afternoon and all of them
-- ours. The funnel had a hole in the middle exactly where the money goes.
--
-- `install_attribution` already measures the far end (which advert produced an
-- installed, signed-in user) and it stays the source of truth for that. It
-- cannot measure the near end, because a person who clicks an advert and does
-- not install never appears in it. That is the difference between "the advert
-- is not working" and "the store page is not working", and it is the single
-- most expensive thing to be unable to tell apart.
--
-- WHAT THIS DELIBERATELY DOES NOT STORE. No IP address, no user agent string,
-- no cookie, no device or advertising identifier, no user id, nothing that
-- joins to a person. A row is campaign parameters, a coarse platform bucket, a
-- destination and a timestamp. That is a deliberate design constraint and not
-- an oversight: it is what lets this run for every visitor rather than only the
-- small minority who accept an advertising cookie.
--
-- Under PECR the reason we may count every click is that nothing here is stored
-- on or read from the visitor's device. The page passes on parameters that were
-- already in the URL we sent them. See `apps/website/public/install.html` and
-- `apps/worker/src/adClicks.ts`.

create table if not exists public.ad_clicks (
  id uuid primary key default gen_random_uuid(),

  -- The campaign parameters exactly as they arrived in the URL. Kept verbatim
  -- and forever, for the same reason `install_attribution.raw_referrer` is:
  -- every derived column is a derivation, and derivations have bugs.
  raw_query text not null,

  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,

  -- Meta's URL macros, which resolve at delivery time to the real ids. These
  -- are what make a click joinable to a campaign without decrypting anything,
  -- and they are the near-end mirror of install_attribution's meta_* columns.
  meta_campaign_id text,
  meta_adset_id    text,
  meta_ad_id       text,
  -- Which surface the advert was shown on, from Meta's {{placement}} macro.
  -- This is the column that would have caught the Audience Network problem in
  -- a day rather than a month.
  meta_placement   text,

  -- What happened: 'arrival' or 'store_tap'.
  --
  -- These must be distinguishable or the click count is simply wrong. On a
  -- phone the page redirects straight to a store, so an arrival IS the store
  -- visit and there is one row. On desktop it shows a chooser, so an arrival
  -- and a later store tap are two DIFFERENT events from one visitor, and
  -- counting both as clicks would overstate desktop traffic twofold.
  --
  -- Count arrivals to answer "how many clicks reached us". Count store taps to
  -- answer "how many of those people actually wanted the app".
  event text not null default 'arrival',

  -- Where we sent them, or offered to: 'google_play', 'app_store', 'webapp' or
  -- 'none'. A coarse bucket, not a URL.
  destination text not null,
  -- 'android', 'ios' or 'other'. Derived from the user agent and then the user
  -- agent is DISCARDED. We keep the bucket, never the string.
  platform    text not null,
  -- Country only, from Cloudflare's edge. Country is coarse enough not to
  -- locate anyone and is what tells us whether geo targeting is behaving.
  country     text,

  created_at timestamptz not null default now()
);

-- The questions this table exists to answer: how many clicks did each campaign
-- land, and on which placement.
create index if not exists ad_clicks_campaign_idx
  on public.ad_clicks (meta_campaign_id, created_at desc)
  where meta_campaign_id is not null;

create index if not exists ad_clicks_created_idx
  on public.ad_clicks (event, created_at desc);

create index if not exists ad_clicks_placement_idx
  on public.ad_clicks (meta_placement)
  where meta_placement is not null;

-- Service-role only, the `install_attribution` model. The website posts to the
-- Worker and the Worker writes here; no client ever touches this table. RLS
-- with no policies denies every row to any role that does not bypass it.
alter table public.ad_clicks enable row level security;

-- Supabase grants anon AND authenticated on every new public-schema table, and
-- enabling RLS does not remove them. 0051 learned this the hard way by leaving
-- install_attribution holding all four grants for both roles. Revoke on
-- creation this time, and verify with has_table_privilege against the live
-- database rather than trusting this file.
revoke all on public.ad_clicks from anon;
revoke all on public.ad_clicks from authenticated;

-- ---------------------------------------------------------------------------
-- And the same question at the FAR end of the funnel.
--
-- install_attribution already records which campaign produced an installed
-- user. It could not record which PLACEMENT, because Meta's encrypted referrer
-- payload does not carry one. Now that install.html builds the referrer itself
-- for adverts pointing at our own landing page, the placement travels with it.
--
-- This is the column that closes the loop opened by ad_clicks above: clicks by
-- placement at one end, installs by placement at the other, and the ratio
-- between them is the number that would have shown within a day that Audience
-- Network rewarded video was producing taps and nothing else.
alter table public.install_attribution
  add column if not exists meta_placement text;

create index if not exists install_attribution_placement_idx
  on public.install_attribution (meta_placement)
  where meta_placement is not null;
