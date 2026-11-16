# Delegent AI

An AI coworker in your pocket: a consumer mobile app where a £3.99-a-month
subscription gave each person a coworker they could chat with, dictate to or
talk to. It read and answered email, sorted the inbox, found money people might
be owed (delayed-flight compensation, forgotten refunds, unwanted
subscriptions), planned trips, wrote letters and PDFs, and worked inside 35
connected apps such as Gmail, Outlook and Google Calendar. Anything that would
send, post or spend waited for the person's yes.

It was built and run by one person, with AI agents doing most of the
engineering and operations, and shipped as a real product: published on Google
Play and the App Store, with live card and Apple in-app billing, from May to
November 2026. The service has now closed. The code is published as it stood,
for anyone to learn from or reuse.

> **Not maintained.** Every account, key and server this code once talked to
> has been shut down. To run it you need your own Supabase project, Cloudflare
> account, model provider and so on; see "Running it yourself" below.

## The system at a glance

```mermaid
graph LR
  APPS["Android, iPhone, web"] --> API["Production Worker<br/>(Cloudflare)"]
  APPS --> VOICE["Voice Worker<br/>live Talk"]
  VOICE --> API
  API --> ENGINE["Agent engine<br/>one Durable Object per person"]
  ENGINE --> MODEL["LLM via OpenRouter"]
  ENGINE --> COMPOSIO["Composio<br/>the person's connected apps"]
  API --> SUPA[("Supabase<br/>accounts, billing, chat record")]
  API --> PAY["Stripe, Apple in-app purchase"]
```

Three Cloudflare Workers do all server-side work:

- the **production Worker** (`apps/worker`): every API route, the only holder of
  server secrets, and the check on every subscription and usage allowance;
- the **agent engine** (`apps/agent`): the coworker itself, one Durable Object
  per person holding their conversation and memory, the model loop, tools and
  connected apps, plus Cloudflare Workflows for long jobs such as bulk inbox
  sorting;
- the **voice Worker** (`apps/agent/voice`): live speech in and out, turning
  spoken sentences into ordinary chat turns.

Supabase holds accounts, billing state and the chat record the app displays.
The apps hold nothing but the public Supabase key and the person's own session.
The full picture, with a diagram of every flow, is
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the visual design language is
[`docs/DESIGN.md`](docs/DESIGN.md).

## What is in this repo

| Path | What |
|---|---|
| `apps/mobile` | Expo / React Native app for Android and iOS from one codebase. The chat screen is a WebView authored in `assets/chat-webview/index.html` and compiled by `npm run chat:regen` |
| `apps/webapp` | The web app (Vite, React), including an admin dashboard of real unit economics |
| `apps/website` | The marketing site, help articles and legal pages |
| `apps/worker` | The production Cloudflare Worker: chat runs over SSE, allowance and top-ups, Stripe and Apple billing, OAuth connections, push, account export and deletion |
| `apps/agent` | The agent engine Worker and its model evaluation harness (`eval/`); `voice/` is the voice Worker |
| `packages/shared` | Product copy, legal text, the plan, the connections catalogue, shared types |
| `packages/billing` | Stripe events to subscription state |
| `supabase/migrations` | The database schema, with row-level security on every table (validated by `npm run test:supabase`) |
| `tests/` | End-to-end contracts, release gates and security checks |
| `services/hermes-runner`, `packages/provisioner`, `apps/web` | The first architecture, retired in September 2026: a private Fly.io machine per subscriber running the open-source Hermes agent, provisioned on payment. Kept for the record |

The repo still uses the prototype's names (`sidekick-v2`, `@sidekick/*`,
`com.sidekick.v2`); the product was always called Delegent AI.

## Build and test

Node 22 and npm 10.

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run test
```

Worker tests run against built output, so build before testing a single
workspace (`npm run build --workspace @sidekick/worker`, then
`npm test --workspace @sidekick/worker`).

## Running it yourself

You will need your own accounts and must set every value yourself; nothing in
this repo points at a working service any more.

1. **Supabase:** create a project, apply `supabase/migrations/*.sql` in order.
2. **Cloudflare:** deploy `apps/agent` (the engine) first, then `apps/worker`,
   then `apps/agent/voice`. Replace the account, route and domain values in
   `apps/worker/wrangler.toml` and `apps/agent/wrangler*.jsonc` with your own,
   and set the secrets listed in `.env.example` with `wrangler secret put`.
3. **Mobile:** copy `.env.public.example`, fill in your public values, add your
   own Firebase `google-services.json` and `GoogleService-Info.plist` in
   `apps/mobile`, set your own Expo project in `apps/mobile/app.json` and
   `app.config.ts`, then build with EAS.
4. **Billing** is optional: without Stripe keys the paid routes simply refuse.

Identifiers left in the code (domains, project ids, store ids) belonged to the
original deployment and are dead; replace them with yours.

## Licence

MIT, see [`LICENSE`](LICENSE). Third-party services named here are trademarks
of their owners.
