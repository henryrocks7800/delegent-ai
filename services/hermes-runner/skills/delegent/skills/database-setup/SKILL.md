---
name: database-setup
title: Database Setup And Admin
version: 1.0.0
category: development
risk_level: high
description: "Use to design, install, configure, migrate, backup, and query databases safely."
activation_phrases:
  - "database"
  - "Postgres"
  - "Supabase"
  - "SQL"
  - "migration"
  - "schema"
requires_human_approval: true
delegent_safe: true
---

# Database Setup And Admin

## When to use this skill

Use this skill when the user asks for:

- The user needs a database or schema work.
- Data must be stored/queryable.

## Outcome

By the end of the task, the user should have:

- Schema plan.
- Migration scripts.
- Safe queries.
- Backup/rollback plan.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

> **Already connected?** Run `delegent-connect list` before you plan any setup. It shows the services the user signed into on the Connections screen, which never appear in chat and never touch your workspace. If the provider is listed, it is live: use it. `delegent-keys list` shows the other kind, credentials the user typed in. Check both.

> **Storing keys:** put any key, token, or credential into the central encrypted vault with `delegent-keys put <service>` (encrypted at rest on this runner's own volume; never written into chat, never left as a plaintext file). Use it with `delegent-keys run --service <service> [--file] -- <command>`. See the `core-permissions-and-credentials` skill for the full how-to.

## Intake questions

Ask only what is needed. Start with:

- Which database?
- What data?
- Access level?
- Need migrations?
- Backup requirements?

## Execution playbook

Follow this sequence:

1. Design schema.
2. Create migration.
3. Run on dev/test first.
4. Add constraints/RLS where needed.
5. Backup before risky changes.
6. Verify with queries.

## Verification checklist

Before telling the user the work is complete, verify:

- Migration applies cleanly.
- Rollback or backup exists.
- No secrets exposed.
- Permissions are safe.

## Deliverables

Return one or more of:

- Schema/migration
- Query examples
- Backup plan

## Handover template

```text
What I did:
- ...

Evidence:
- ...

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
