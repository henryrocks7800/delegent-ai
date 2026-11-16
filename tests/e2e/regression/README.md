# Regression tests

Defect pins. Each test names the defect ID + version it was first observed
in. If one of these starts failing, the defect has returned and should be
re-investigated, not silenced.

## What's here

- `v1.2.7-v1.2.8-defect-regression.test.mjs` — DN1, DN2, DN3 from v1.2.7 + v1.2.8 round
- `v1.3.0-dn13-01-product-state-timeout.test.mjs` — product-state hung past timeout
- `v1.3.0-dn13-01-timeout-runtime.test.mjs` — runtime watchdog for the same
- `v1.3.0-dn13-02-03-product-defect-fixes.test.mjs` — DN13-02 + DN13-03 pins

## Naming convention

`v<version>-<defect-id>-<short-name>.test.mjs`

When a defect is closed:
1. Add a regression test here with the defect ID
2. Keep the test forever — even after the underlying code is rewritten

## Running

```bash
npm run test:e2e:regression
```

Budget: < 60 seconds. No live env required (all mocked).
