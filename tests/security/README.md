# Security tests

Static + source-level checks that protect the trust boundaries documented
in [`SECURITY.md`](../../SECURITY.md).

## What's here

| File | Asserts |
|------|---------|
| `security-invariants.test.mjs` | RLS policies are enabled on every table holding user data; no client-readable column exposes service-role data; HMAC v1 wire format pinned; no secret-key patterns in bundled mobile code |
| `owasp-top-10-coverage.test.mjs` | Each of the OWASP Top 10 has at least one corresponding source/policy check + at least one regression test |

## What it does NOT cover

- **Live secret leakage** — `tests/forensic/I-security/` runs against production data
- **Penetration testing** — out of scope; commission an external assessment
- **Threat-model review** — captured in `SECURITY.md`; this folder enforces compliance, not design

## Running

```bash
npm run test:security
```

All-pass time budget: < 20 seconds.

## When to add a new security test

Add here if:
- The rule is enforceable from source/migrations + simple invariants
- A regression would silently bypass a trust boundary

If it requires live data, put it in `tests/forensic/I-security/` instead.
