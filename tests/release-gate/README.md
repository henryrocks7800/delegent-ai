# Release-gate tests

Tests that MUST pass before any release. Cheap, fast, deterministic — no
network, no live env, no flakes.

## What's here

| File | Asserts |
|------|---------|
| `brand-strings-scan.test.mjs` | Mobile + website strings use "Delegent AI", not legacy "Coworker AI" / "Sidekick" leakage |
| `public-copy-hygiene.test.mjs` | Visible user copy avoids placeholder text, TODOs, dev-only error codes |
| `no-em-dashes-in-user-facing-copy.test.mjs` | U+2014 em-dashes are NOT in mobile/website strings — use hyphen, comma, colon, or parens instead |
| `architecture-banned-vocabulary.test.mjs` | No `OpenRouter`, `Cloudflare`, `Supabase`, `Hermes`, `Fly Machines`, `runner`, `container`, `machine` in user-visible code paths |
| `production-readiness-docs.test.mjs` | README/ARCHITECTURE/SECURITY/SETUP exist + reference the canonical sections |
| `env-example-shape.test.mjs` | `.env.example` + `.env.public.example` match the public/private split |
| `no-server-secrets-in-public-surfaces.test.mjs` | No service-role / Stripe-secret patterns in any file served to the user |

## What it does NOT cover

- Live data quality (see `forensic/`)
- Runtime correctness (see `e2e/`)
- Mobile UI presence (see `mobile-readiness/`)
- Security threat-model (see `security/` for invariants, `forensic/I-security/` for live drift)

## Running

```bash
npm run test:release-gate
```

All-pass time budget: < 5 seconds. If any test fails, the release MUST be
held until it's resolved.

## When to add a new release-gate test

Add here if the rule is:
- Static (string scan, file presence, source-code shape)
- Deterministic (no flake from network or timing)
- Universally true (applies to every release, not version-specific)

If it's version-specific or environment-dependent, put it in `e2e/regression/`
or `forensic/` instead.
