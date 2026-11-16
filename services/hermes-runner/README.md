# hermes-runner (retired)

> **HISTORICAL (2026-09-30):** the per-user runner service, retired on
> 2026-09-18 when every Fly runner was destroyed. Its CI job was removed on
> 2026-09-23. Kept for history and for the tests that still import its contracts.
> Today's coworker is the agent engine, `apps/agent` (`docs/ARCHITECTURE.md`).

Until September 2026 each paying customer had their own Fly Machine running this
Python FastAPI wrapper around the Hermes agent, with a volume at `/data/hermes`
for the conversation, memories and files. The Worker reached it with per-user
HMAC-signed requests, and its model calls went back through the Worker. The last
image is pinned by digest in `RUNNER_IMAGE.lock.json` and archived at
`ghcr.io/delegent-ai-ltd/delegent-runner-images`.

The skills under `skills/delegent/` were the runner's instructions for each job;
their ideas live on in the agent engine's instructions and tools.
