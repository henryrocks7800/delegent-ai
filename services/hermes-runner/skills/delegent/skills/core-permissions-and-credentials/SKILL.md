---
name: core-permissions-and-credentials
title: Permissions, Credentials And API Key Handling
version: 1.0.0
category: core
risk_level: high
description: "Use whenever the assistant needs login details, API keys, OAuth access, payment details, or account setup."
activation_phrases:
  - "api key"
  - "password"
  - "log in"
  - "connect my account"
  - "give you access"
  - "credentials"
requires_human_approval: true
delegent_safe: true
---

# Permissions, Credentials And API Key Handling

This is the **canonical, authoritative** reference for how to store and use ANY
key, token, or credential across every Delegent skill. Any skill that connects a
service, holds an API key, or logs in somewhere points here. If another skill's
instructions ever conflict with this one on where a secret lives, this skill wins.

## When to use (activation phrases)

Activate this whenever a task needs a login, API key, OAuth access, password,
service-account file, or account/payment setup. Trigger phrases include "api
key", "password", "log in", "connect my account", "give you access",
"credentials". Any other skill that stores or uses a secret defers here.

## Step 0: check what you already have, BEFORE you ask for anything

There are two ways a service reaches you, and only one of them is visible in the
chat. **Run both of these before you say a single word about setting something
up.** Skipping this is the most common failure in this whole library: the user
connected the service days ago, you never saw it happen, and you walk them
through a developer console they never needed to open.

```bash
delegent-connect list   # services the user signed into on the Connections screen
delegent-keys list      # credentials the user typed in, held on this machine
```

If the service comes back from either, **it is live right now. Use it.** Do not
ask for an API key, do not open the setup playbook, and never tell the user they
have no connection. If `delegent-connect list` shows it as `needs_reauth`, the
sign-in has lapsed: ask them to reconnect it on the Connections screen in the
app, and nothing else. Do not offer to wire it up by hand instead.

## The two custody models

| | `delegent-connect` | `delegent-keys` |
|---|---|---|
| How it arrives | The user pressed Connect in the app and signed in at the provider's own site | The user typed or pasted a credential to you |
| Where the lasting grant lives | Off this machine, on Delegent's servers | Encrypted on this machine's own volume |
| What this box can hold | An access token that expires in minutes | The credential itself, decrypted just in time |
| You can set it up | No. Only the user can, on the Connections screen | Yes, by guiding them and storing what they hand you |

`delegent-connect` is the safer of the two and it is not something you can
arrange: the sign-in happens in the user's own browser and the lasting grant
never comes near you, so nothing running here can give away durable access to
their account. When a service is offered on the Connections screen, that is the
route, and pointing the user at a developer console instead is a downgrade.

### Using a brokered connection

```bash
# Runs your command with a fresh, short-lived token in $DELEGENT_ACCESS_TOKEN.
# ALWAYS wrap the command in sh -c '...' with single quotes: there is no shell
# otherwise, so a bare $DELEGENT_ACCESS_TOKEN never expands and the provider
# sees an empty bearer, which reads exactly like a broken connection.
delegent-connect run --service <service> -- sh -c '<command using $DELEGENT_ACCESS_TOKEN>'
delegent-connect run --service <service> --var GITHUB_TOKEN -- sh -c '<command using $GITHUB_TOKEN>'
```

Exit code 2 means the service is not connected (or the sign-in lapsed): ask the
user to connect it on the Connections screen. Do not fall back to a manual
setup, and do not treat it as your failure to explain.

## Intake questions (ask before you take any credential)

Only once Step 0 came back empty. The answers decide the credential type and the
scope:

1. **Is it on the Connections screen?** If yes, the answer to every other
   question is "they connect it in the app" and you are done asking.
2. **What are we connecting, and what does the task need it to do?** (This decides
   read-only vs write.)
3. **What credential type is available**, an API key, an OAuth flow, or a scoped
   service account? Prefer these over a personal password.
4. **Have they created it yet**, or do they need you to point them at exactly
   where in the third-party service to generate it, and which scopes to pick?

## The one rule: every typed key goes in the central vault

Delegent has a single, central, encrypted key vault. Every credential a user
hands you (API key, access token, OAuth refresh token, service-account JSON,
app-password, database connection string, anything secret) goes into that vault
and nowhere else. You interact with it through one baked CLI, `delegent-keys`.
A brokered connection is the other model and never lands here at all: you cannot
put one in the vault and you do not need to.

- Secrets are **encrypted at rest** on this runner's own volume (Fernet with a
  durable per-runner key the vault provisions itself). They never sit on disk in
  plaintext and never leave the box.
- You can **`list`** what is connected (service names + non-secret metadata) so
  you can tell the user "you've connected FreeAgent, Gmail and Stripe" — but you
  can **NEVER read a secret value back into the chat**. The vault gives you no way
  to print a stored key, by design, so you physically cannot leak one.
- When a command needs the secret, the vault **materialises it just-in-time** —
  as an environment variable, or (with `--file`) as a `0600` temp file that is
  deleted the moment the command exits — so the plaintext never touches the
  conversation and never lingers on disk.

## The `delegent-keys` commands

```bash
# Store a secret for a service (overwrites any existing one).
# Provide the value one of these ways — never as a chat-visible argument:
delegent-keys put <service> --stdin                 # pipe the secret in on stdin
delegent-keys put <service> --file <path>           # read it from a file (e.g. a downloaded service-account JSON)
delegent-keys put <service> --value <secret>        # only for non-interactive scripts; prefer --stdin
delegent-keys put <service> --scope read --scope write   # record the granted scopes (capability check)
delegent-keys put <service> --meta account=acme --meta region=eu   # non-secret metadata for the listing

# See what is connected (service + scopes + metadata — NEVER the secret).
delegent-keys list

# Forget a credential (only ever on explicit user request).
delegent-keys remove <service>

# Use a stored secret to run a command, WITHOUT ever revealing it:
delegent-keys run --service <service> --var API_KEY -- <command>     # secret injected as $API_KEY
delegent-keys run --service <service> --file -- <command>           # secret written to a 0600 temp file, deleted after
```

`delegent-keys run` is how you actually *use* a key: it decrypts the secret,
hands it to the command (as an env var, or as a temp file with `--file`), and
tears the plaintext down afterwards. You never `put` a key and then read it back
yourself — you always go through `run`.

## Non-negotiable safety rules

- **Never store a key in plaintext.** No secret in a chat message, a code
  comment, a committed file, a log line, or a plain file on disk. The vault is the
  only place a secret lives.
- **Never echo a key or token back.** Not to confirm it, not to "show what you
  saved", not in an error message. You may confirm the *service is connected*
  (via `delegent-keys list`), never the secret itself.
- **Humans mint keys; the agent only guides.** You tell the user exactly where to
  create the API key / OAuth client / service account and which scopes to pick;
  they create it and hand it over; you `put` it in the vault. You never create an
  account or generate a credential on their behalf.
- **Never ask for a credential you already have.** `delegent-connect list` and
  `delegent-keys list` come before the first question, every time. Telling
  somebody to go and make an OAuth app for a service they connected last week is
  the most visible way to look like you were not paying attention.
- **Never talk a user out of the Connections screen.** If a service is offered
  there, that is the route. Never suggest a hand-rolled OAuth app as an
  alternative to it, and never as a workaround when a sign-in has lapsed.
- **Prefer scoped over broad.** Ask for an API key, OAuth flow, service account,
  or scoped token instead of a personal password, and request read-only unless
  the task genuinely needs write.
- **Verify before you claim.** Do not say an integration is live until a minimal
  real call through `delegent-keys run` has succeeded.
- **Escalate human-only steps.** If you are blocked by a sign-up, payment,
  identity check, CAPTCHA, or approval, stop and give the user exact instructions.
- **No high-stakes actions without confirmation.** Do not make payments, sign
  contracts, submit legal/official filings, or send sensitive external messages
  without explicit user confirmation. Do not give regulated (legal, tax,
  accounting, medical, financial, employment, property) advice as final
  professional advice — prepare drafts for human review.

## Execution playbook

0. **Run `delegent-connect list` and `delegent-keys list` first.** If the service
   is in either, it is already connected: go and do the work. Everything below is
   only for a service that is in neither.
1. Decide the safest credential type (API key / OAuth / scoped service account
   over a password) and the minimal scopes.
2. Tell the user exactly how to create it in the third-party service.
3. Store it: `delegent-keys put <service> --stdin` (or `--file` for a downloaded
   JSON), recording scopes with `--scope` and non-secret context with `--meta`.
4. Verify with a minimal safe call via `delegent-keys run --service <service> -- ...`.
5. Confirm what is connected with `delegent-keys list`. Record NO secret values
   in chat or files.

## Verification checklist

- You checked `delegent-connect list` before asking the user for anything.
- No secret was ever printed to chat or written to a plaintext file.
- The credential is in the vault (`delegent-keys list` shows the service), or the
  connection is brokered and `delegent-connect list` shows it.
- Scopes are minimal and access was verified through `delegent-keys run`.
- The user knows how to revoke access, and you can `delegent-keys remove` it.

## Handover template

```text
What I did:
- Connected <service> into the vault (scopes: ...), verified with a live call.

Evidence:
- `delegent-keys list` shows <service>; test call returned ...

Files / systems touched:
- ...

What still needs your approval:
- ...

Next recommended step:
- ...
```

## Related skills

- api-integration-builder
- security-audit
