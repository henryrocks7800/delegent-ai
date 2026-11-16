# Smoke tests

Quick "is anything massively broken?" checks. Fail-fast, low-noise.

## What's here

- `sidekick-happy-path.test.mjs` — auth → chat → file → quota happy path
- `connections-and-routines-journey.test.mjs` — one in-memory store, real handlers: a connect is read identically by both surfaces, the agent and the runner; a routine created through the API is the row the waker claims
- `live-deployment-smoke.test.mjs` — worker + Supabase are reachable, response shapes are right (run with `LIVE_SMOKE=1`)

The new-user → first-reply flow is verified end-to-end by the forensic pack
(`npm run forensic`: B-provisioning, C-chat, E-agent) against live infra + the
emulator, not by a stubbed harness. The previous `new-user-first-reply.test.mjs`
scaffold (unbuilt stub harness, retired Telegram surface) was removed under the
zero-skip policy.

## Running

```bash
npm run test:e2e:smoke
```

Budget: < 30 seconds.
