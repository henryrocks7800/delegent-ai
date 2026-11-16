# Contributing

This project is no longer maintained, so pull requests are unlikely to be reviewed. These were the working rules while it was live, kept because they explain how the code is meant to hold together. They are a good starting point if you fork it.

## Development principles

- Build real integrations, not UI stubs.
- Keep product-facing language simple and consumer-friendly.
- Keep provider, model, runner, token, queue, and infrastructure details out of mobile/user-facing payloads.
- Treat Supabase, Stripe, Fly Machines (and legacy Railway during cutover), Cloudflare, Telegram, and Hermes runner boundaries as security-sensitive.
- Never commit secrets or local provider state.

## Branch and commit style

Use small, descriptive branches when possible:

```text
feat/telegram-connect-code
fix/mobile-auth-session-restore
docs/repo-onboarding
```

Use conventional commit messages:

```text
feat: add Telegram connect-code flow
fix: preserve mobile Supabase session token
docs: add repository onboarding
```

## Local setup

Install dependencies from the repo root:

```bash
npm install
```

## Required checks

For code changes, run from the repo root:

```bash
npm run typecheck
npm run lint
npm run test
git diff --check
```

For documentation-only changes, at minimum run:

```bash
git diff --check
```

For mobile UI or integration changes, also verify a native Android build/install path. Do not report “works on mobile” from source checks alone.

## Integration checklist

Before opening or merging a PR that touches auth, billing, provisioning, Telegram, Worker, or runner code, confirm:

- Auth/session state is backed by Supabase, not local-only flags.
- Subscription entitlement is written only by verified Stripe webhook logic.
- Provisioning is idempotent and does not expose Fly app names / Machine IDs / volume IDs (or any private runner output) to public state.
- Worker routes authenticate before touching service-role-backed data.
- Telegram connect codes are short-lived and stored as hashes only.
- Runner calls use the documented HMAC/header contract.
- Mobile/public state does not expose provider IDs, service-role data, raw chat IDs, connect-code hashes, runner URLs, or internal error payloads.
- Tests cover success, blocked, duplicate/retry, and fail-closed states.

## Secrets and local files

Do not commit:

- `.env` files with real values.
- Supabase `.temp` provider artifacts.
- Provider dashboard exports, browser/CDP dumps, screenshots with tokens/codes, or app-password files.
- APK decompilation output or logs containing embedded runtime config.

Use `.env.public.example` only for values that are safe to ship inside the mobile app bundle.

## Pull request expectations

A good PR should include:

- A short product-level summary.
- A list of changed areas.
- Tests/checks run.
- Screenshots or contact sheets for mobile UI changes.
- Explicit notes for any live provider changes or required manual dashboard steps.
- A security note if the change touches auth, webhooks, runner auth, secrets, or public/mobile payloads.

## Useful docs

- `README.md`: product overview, repo map, how to run it yourself.
- `docs/ARCHITECTURE.md`: system architecture and data flow.
- `docs/DESIGN.md`: the visual design language.
