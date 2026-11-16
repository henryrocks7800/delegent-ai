# End-to-end tests

Full-system paths. Worker is built (`npm run build --workspaces`) before
this runs; Supabase + Stripe + Worker + Fly are all touched in the live
subsets.

## Subfolders

| Folder | What's in it | Live env? |
|--------|--------------|-----------|
| [`smoke/`](smoke/) | Happy-path smokes — quick "is anything broken" gates | Some live, some mock |
| [`regression/`](regression/) | Version-specific defect pins (v1.2.7-v1.2.8, v1.3.0-dn13) | No |
| [`mobile/`](mobile/) | Mobile auth + onboarding + checkout end-to-end | No (source-shape, no emulator) |
| [`infra/`](infra/) | Series 4 Fly Machines isolation + cron-deployed-ness | **Yes** |
| [`ops/`](ops/) | Operator helpers (mission-evidence collection, live-flow inspector) | **Yes** |
| (root) | `production-mobile-observables.test.mjs` — structural sanity | No |

## What it does NOT cover

- **Live data drift** — go to `tests/forensic/`
- **Static copy / brand** — go to `tests/release-gate/`
- **Pure functions** — co-located with their workspace
- **Mobile UI** — driven by Maestro, see `apps/mobile/android/integration/maestro/`

## Running

```bash
npm run test:e2e              # everything in tests/e2e/ (post-build)
npm run test:e2e:smoke        # tests/e2e/smoke/
npm run test:e2e:regression   # tests/e2e/regression/
npm run test:e2e:mobile       # tests/e2e/mobile/
npm run test:e2e:infra        # tests/e2e/infra/ — needs Fly + Supabase env
```

The infra suite needs:
- `SIDEKICK_RUNNER_PROVIDER=fly_machines` (set in env)
- `FLY_API_TOKEN` (org-scoped)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `SIDEKICK_ALLOW_FLY_TEST_DESTROY=true` for grace-expiry test

If any of these are missing, the live tests skip cleanly.

## Time budgets

| Subfolder | Budget |
|-----------|--------|
| smoke | < 30s |
| regression | < 60s |
| mobile | < 30s |
| infra | 1–3 min |
| ops | < 60s |

The root structural check is < 5s.

## Why is `series4-fly-runner-isolation` flaky in the aggregate run?

It uses a 3-second sleep to wait for grace-expiry timer. Under heavy
concurrent load (e.g. running the full suite), timer drift can push it
past the assertion window. Re-run in isolation to verify; if it passes
alone, treat as a flake.
