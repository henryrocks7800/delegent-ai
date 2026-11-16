-- Meta click id on install attribution.
--
-- Meta appends `fbclid` to the URL of every advert click it delivers.
-- install.html (2026-09-08) now carries it into the Google Play install
-- referrer alongside the campaign ids, so it arrives here in `raw_referrer`
-- like everything else. This column is the parsed copy, for the same reason
-- the meta_* columns exist: the raw string is the record, the column is what
-- a query joins on.
--
-- WHAT IT IS FOR. The Worker's Conversions API path (apps/worker/src/metaCapi.ts)
-- reads it to tell Meta that the click behind this install signed up or paid,
-- so Meta can optimise delivery towards people who install rather than people
-- who tap. That path is behind SIDEKICK_META_CAPI_ENABLED and ships off.
--
-- WHAT IT IS NOT. It is Meta's identifier for a click, not ours for a person.
-- It joins to nothing else in this database, and it is the only thing about
-- the user that the Conversions API path ever sends back to Meta.
--
-- Existing rows stay null: the referrer is served once, on first launch, so
-- nothing before this change can be back-filled and nothing should be.

alter table public.install_attribution
  add column if not exists fbclid text;

comment on column public.install_attribution.fbclid is
  'Meta click id (fbclid) carried through the Play referrer. Null for organic and for installs before 2026-09-08. Read by the Worker Conversions API path only.';

-- Grants are unchanged: 0052 revoked everything from anon/authenticated and the
-- service role reads the table through PostgREST as before.
