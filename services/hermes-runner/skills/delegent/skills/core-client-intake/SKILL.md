---
name: core-client-intake
title: Client Intake And Task Scoping
version: 1.0.0
category: core
risk_level: low
description: "Use to turn vague user requests into a clear plan, scope, permissions, and deliverables."
activation_phrases:
  - "start a project"
  - "help me plan"
  - "what do you need from me"
  - "scope this task"
requires_human_approval: false
delegent_safe: true
---

# Client Intake And Task Scoping

## When to use this skill

Use this skill when the user asks for:

- The user gives a vague or complex request.
- The user wants a business process automated.
- The assistant needs to decide what access, files, or approvals are required.

## Outcome

By the end of the task, the user should have:

- A clear goal statement.
- A list of needed inputs/access.
- A safe execution plan.
- A definition of done.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What outcome do you want?
- Is this for personal, business, or client use?
- What systems/files are involved?
- What should I not do without approval?

## Execution playbook

Follow this sequence:

1. Restate the goal in plain English.
2. Identify systems, data, risk, and external parties.
3. Ask for only the missing information.
4. Propose a short staged plan.
5. Get approval before touching external systems.

## Verification checklist

Before telling the user the work is complete, verify:

- The goal is clear.
- Assumptions are listed.
- Approval points are explicit.
- The user knows what to provide next.

## Deliverables

Return one or more of:

- Task plan
- Access checklist
- Risk/approval checklist

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

- core-permissions-and-credentials
- core-project-handover
