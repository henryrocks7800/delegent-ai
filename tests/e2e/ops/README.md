# Operator end-to-end helpers

Tests that validate operator-facing scripts. These exist so a tooling
regression (script renamed, flag dropped, env variable removed) breaks
loudly instead of silently making the operator's life harder.

## What's here

This folder is reserved for operator-helper validations. The scripts
themselves live in `scripts/`. As of 2026-05-28 the existing operator
tests (`mission-evidence`, `inspect-live-flow`, `reset-live-test-user`,
`run-live-test-user-teardown`) are still in `scripts/*.test.mjs` and
invoked by `npm run test:ops`. If you want to move them here, also
update `package.json:test:ops`.

## Running

```bash
npm run test:ops
```

Budget: < 60s.
