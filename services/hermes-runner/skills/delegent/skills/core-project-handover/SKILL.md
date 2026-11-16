---
name: core-project-handover
title: Project Handover And Evidence Pack
version: 1.0.0
category: core
risk_level: low
description: "Use at the end of any task to produce a useful handover with evidence, files, blockers, and next steps."
activation_phrases:
  - "summarise what you did"
  - "handover"
  - "what changed"
  - "finish this task"
  - "evidence"
requires_human_approval: false
delegent_safe: true
---

# Project Handover And Evidence Pack

## When to use this skill

Use this skill when the user asks for:

- The assistant has completed a task.
- The user needs a record of actions.
- A task was blocked or partially completed.

## Outcome

By the end of the task, the user should have:

- A concise but complete completion report.
- Evidence and file paths.
- Clear blockers and next steps.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Do you want a brief summary or detailed technical handover?
- Should I include file paths and commands?

## Execution playbook

Follow this sequence:

1. Summarise completed actions.
2. List files/systems touched.
3. List evidence.
4. List unresolved blockers.
5. Recommend the next action.

## Verification checklist

Before telling the user the work is complete, verify:

- No secrets included.
- Claims match evidence.
- Blockers are precise.
- User can resume from the report.

## Deliverables

Return one or more of:

- Markdown handover
- Evidence list
- Resume commands

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

- core-client-intake
