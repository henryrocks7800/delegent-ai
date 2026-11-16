---
name: crm-sales-pipeline
title: CRM And Sales Pipeline Assistant
version: 1.0.0
category: sales
risk_level: medium
description: "Use for CRM setup, lead tracking, customer follow-ups, meeting notes, pipeline updates, and sales admin."
activation_phrases:
  - "CRM"
  - "sales pipeline"
  - "be my sales assistant"
  - "HubSpot"
  - "Pipedrive"
  - "Salesforce"
  - "leads"
  - "follow-up"
requires_human_approval: true
delegent_safe: true
---

# CRM And Sales Pipeline Assistant

> ## FIRST: check what is already a connection
>
> Run `delegent-connect list` before anything else in this skill.
>
> **HubSpot and Salesforce are Connections-tab services.** If either appears
> there with `"backend": "composio"`, it is already connected and none of the
> API-key or manual setup below applies to it: use `delegent-connect exec`
> with the actions in the `connected-services` skill, and do not walk the
> user through developer portals or ask for a key. The connection wins over
> everything below. This skill is for CRMs that have NO card.

## When to use this skill

Use this skill when the user asks for:

- The user wants CRM help.
- Emails/meetings need logging.
- Leads need research/follow-up.

## Outcome

By the end of the task, the user should have:

- CRM integration plan.
- Lead records.
- Follow-up drafts.
- Pipeline hygiene report.

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

- Which CRM?
- What should be read/written?
- Who approves outbound messages?
- What pipeline stages?

## Execution playbook

Follow this sequence:

1. Connect via API if possible.
2. Map fields/stages.
3. Create/update test record.
4. Draft follow-ups.
5. Summarise pipeline.

## Verification checklist

Before telling the user the work is complete, verify:

- Records created/updated correctly.
- No duplicate/confusing entries.
- Outbound messages approved.

## Deliverables

Return one or more of:

- CRM setup plan
- Lead research
- Pipeline report

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

- lead-research
- agent-email-inbox
