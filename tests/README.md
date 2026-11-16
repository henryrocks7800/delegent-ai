# Tests

Top-level test categories. Each folder has its own README with what the
suite covers, what it explicitly does NOT cover, and how to run it.

## Categories

| Folder | What it tests | Runtime | Live env? |
|--------|---------------|---------|-----------|
| [`release-gate/`](release-gate/) | User-facing copy hygiene, brand strings, em-dashes, banned-vocab, env shape, docs presence | ~5s | No |
| [`security/`](security/) | RLS, OWASP, secret-leakage invariants | ~15s | No (some forensic equivalents live under `forensic/I-security/`) |
| [`performance/`](performance/) | Throughput, multi-tenant load | ~5min | No |
| [`mobile-readiness/`](mobile-readiness/) | Maestro spec coverage + mobile-source scan | ~10s | No |
| [`e2e/`](e2e/) | Full-system paths (worker + Supabase). Split into `smoke/`, `regression/`, `mobile/`, `infra/`, `ops/` | 5–10 min | **Yes** for live subsets |
| [`forensic/`](forensic/) | Production-data drift audits (17 suites A–Q) | 10–30 min | **Yes — live Supabase required** |
| [`backlog/`](backlog/) | Known coverage gaps (catalog of tests we still owe) | ~30s | No |

## Tests that live elsewhere

Some test files stay co-located with the workspace they exercise because
they import workspace-internal modules. These are run by the workspace's
own `npm test`, not by the categorised runners above:

- **Unit tests** — `apps/mobile/src/**/*.test.{ts,tsx}`, `apps/worker/test/`, `packages/*/test/`. Run with `npm test --workspaces`.
- **Mobile JS readiness scans** — `apps/mobile/android/app/src/test/js/*.test.mjs`. Run as part of `npm test --workspace @sidekick/mobile`.
- **WebView behaviour** — `apps/mobile/src/chat/__tests__/webViewBehavior.test.ts`. Exercises the WebView state machine under `vm.Context` with a DOM shim. Authoritative test for stop/retry/init/slash.
- **Worker contract** — `apps/worker/test/chat-api.test.mjs`, `apps/worker/test/security-regressions.test.mjs`, etc. Test the worker against a fake Supabase.
- **Hermes runner** — `services/hermes-runner/test_*.py` (Python) and `services/hermes-runner/skills/*.test.mjs` (JS).

## How to run

```bash
# Everything (workspaces + all categorised suites + supabase + ops + e2e)
npm test

# Just the gates that need to pass before a release
npm run test:release-gate

# Live-data audits (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
npm run forensic

# A single category
npm run test:security
npm run test:performance
npm run test:mobile-readiness
npm run test:e2e:smoke
npm run test:e2e:regression
npm run test:e2e:mobile
npm run test:e2e:infra
```

## Aggregated HTML report

`npm run report:tests` produces `docs/test-report.html` — a single dashboard
showing pass/fail/skip per category, with drill-down to individual test
names. Open it in a browser.

## Adding a new test

- **Pure function?** Co-locate with the code in its workspace.
- **API/wire-format pin?** Same.
- **Multiple workspaces or live env?** Put it under the matching `tests/<category>/` folder.
- **Live-data drift detection?** Put it under `tests/forensic/<letter>-<topic>/`.

Each category has guardrails in its README — read them before adding.
