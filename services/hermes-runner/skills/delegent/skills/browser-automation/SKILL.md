---
name: browser-automation
title: Browser Automation And Form Filling
version: 1.0.0
category: automation
risk_level: high
description: "Use to automate browser tasks, fill forms, monitor pages, or interact with non-API services while respecting site rules."
activation_phrases:
  - "browser automation"
  - "do a browser task"
  - "fill form"
  - "submit claim"
  - "web portal"
  - "no API"
requires_human_approval: true
delegent_safe: true
---

# Browser Automation And Form Filling

## When to use this skill

Use this skill when the user asks for:

- A site has no API.
- The user needs repetitive web steps automated.
- Forms need filling.

## Outcome

By the end of the task, the user should have:

- Automation plan.
- Human approval points.
- Completed form draft or script.

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

- Which site?
- Do terms allow automation?
- What login/access?
- Can assistant submit or draft only?

## Execution playbook

Follow this sequence:

1. Check for API first.
2. Respect site terms and robots/CAPTCHA limits.
3. Draft form data.
4. Ask approval before submission.
5. Log actions.

## Verification checklist

Before telling the user the work is complete, verify:

- No prohibited bypass.
- Form data checked.
- Submission only with approval.

## Deliverables

Return one or more of:

- Automation script
- Form draft
- Submission checklist

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
