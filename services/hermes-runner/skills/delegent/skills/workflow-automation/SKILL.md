---
name: workflow-automation
title: Workflow Automation Designer
version: 1.0.0
category: automation
risk_level: medium
description: "Use to map business processes, identify automation points, and build API/browser/file-based workflows."
activation_phrases:
  - "automate this"
  - "set up a workflow"
  - "workflow"
  - "SOP"
  - "process"
  - "make this automatic"
requires_human_approval: true
delegent_safe: true
---

# Workflow Automation Designer

## When to use this skill

Use this skill when the user asks for:

- The user has a repeated process.
- They want handoff to an agent.

## Outcome

By the end of the task, the user should have:

- Workflow map.
- Automation design.
- Manual approval points.
- Implementation plan.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What triggers the workflow?
- What systems?
- What decisions need human approval?
- What can go wrong?

## Execution playbook

Follow this sequence:

1. Map current process.
2. Separate read/write/payment/approval steps.
3. Choose API vs browser vs file workflow.
4. Prototype simplest path.
5. Add monitoring.

## Verification checklist

Before telling the user the work is complete, verify:

- Workflow handles failure states.
- Sensitive actions approved.
- Outputs checked.

## Deliverables

Return one or more of:

- Workflow diagram
- Automation plan
- SOP

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
- browser-automation
