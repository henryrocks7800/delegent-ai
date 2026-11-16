# Delegent Signal bridge

A single-tenant Signal-CLI REST API instance that bridges Signal Messenger to the Delegent AI Cloudflare Worker.

Upstream: https://github.com/bbernhard/signal-cli-rest-api

## Why a separate Fly app?

Signal has no official server API — every Signal account needs an active session that the bridge maintains. We run that session in its own tiny Fly app so:

- The Signal protocol library + GraalVM JVM stay isolated from our main runner image
- Session state (registration, keys, peer pre-keys) lives on a 1 GB volume that doesn't share its lifecycle with any user runner
- The bridge can be restarted / upgraded without touching anything customer-facing

## Deploy + register

See `docs/MESSENGERS.md` §2 for the full step-by-step. The TL;DR:

```bash
flyctl apps create delegent-signal-bridge --org personal
flyctl volumes create signal_data --region lhr --size 1 -a delegent-signal-bridge
cd services/signal-bridge && flyctl deploy --remote-only

# Then register the Signal number — SMS / voice call goes to YOUR phone
curl -X POST "https://delegent-signal-bridge.fly.dev/v1/register/%2B447801283442"
curl -X POST "https://delegent-signal-bridge.fly.dev/v1/register/%2B447801283442/verify/<code-from-sms>"
```

## Webhook → Worker

The bridge forwards every incoming message to the Worker at:

```
https://sidekick-worker-production.alex-coworker-ai.workers.dev/v1/signal/webhook
```

with `Authorization: Bearer $SIGNAL_REST_API_BEARER`. The Worker's matching bearer is set as a Cloudflare secret of the same name.

## Cost

shared-cpu-1x / 512 MB Fly machine + 1 GB volume:
- Compute: ~£3/month always-on (we keep `min_machines_running = 0` so it sleeps; ~£0.50/month in practice)
- Volume: ~£0.10/month
- Bandwidth: negligible at our scale

Total: under £1/month for the bridge itself, which serves every Delegent Signal user.
