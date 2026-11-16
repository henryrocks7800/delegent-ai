# Infra end-to-end tests

Series 4 Fly Machines runner-isolation + cron-deployed-ness checks. These
hit live Fly + Supabase.

## What's here

- `series4-fly-runner-isolation.test.mjs` — two distinct users get fully isolated Fly app + machine + volume + secret + workspace; grace expiry tears one down without touching the other.
- `series4-cron-deployed.test.mjs` — since 2026-09-18 (runners retired, Fly closed) this guards the OPPOSITE of what it used to: no scheduled `series4:provision-once` may be committed, while the `series4:account-deletion-once` step must still be scheduled.

## Required env

- `SIDEKICK_RUNNER_PROVIDER=fly_machines`
- `FLY_API_TOKEN` (org-scoped)
- `FLY_ORG`, `FLY_PRIMARY_REGION` (defaults to `lhr`)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `SIDEKICK_ALLOW_FLY_TEST_DESTROY=true` (gates the destructive isolation test)

If any are missing, tests skip cleanly.

## Running

```bash
npm run test:e2e:infra
```

Budget: 1–3 minutes (Fly API roundtrips dominate).

## Known flake

`series4-fly-runner-isolation` has a 3-second grace-expiry sleep. Under
concurrent load (full suite) the timer can drift past the assertion
window. Re-run alone to verify; if it passes alone, it's the flake.
