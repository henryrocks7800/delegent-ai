---
name: hermes-agent-skill-builder
title: Hermes Agent Skill Builder
version: 1.0.0
category: meta
risk_level: medium
description: "Use when the user wants to create, refine, package, or audit a new skill for the Hermes/Delegent agent."
activation_phrases:
  - "create a skill"
  - "skill library"
  - "SKILL.md"
  - "teach the agent"
  - "new workflow"
requires_human_approval: true
delegent_safe: true
---

# Hermes Agent Skill Builder

## When to use this skill

Use this skill when the user asks for:

- A repeated workflow should become a reusable skill.

## Outcome

By the end of the task, the user should have:

- New SKILL.md package.
- Safety review.
- Install instructions.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What workflow?
- When should it trigger?
- What tools/credentials?
- What can go wrong?
- Human approval points?

## Execution playbook

Follow this sequence:

1. Define trigger/intent.
2. Write safe instructions.
3. Add intake questions.
4. Add verification checklist.
5. Avoid executable code unless reviewed.
6. Package in folder.

## Verification checklist

Before telling the user the work is complete, verify:

- Skill has clear activation.
- No unsafe instructions.
- No secret exfiltration.
- User can review.

## Deliverables

Return one or more of:

- Skill folder
- SKILL.md
- Manifest entry

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
- security-audit
