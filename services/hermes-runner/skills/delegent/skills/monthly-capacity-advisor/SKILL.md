---
name: monthly-capacity-advisor
title: Monthly Capacity And Upgrade Advisor
version: 1.0.0
category: delegent
risk_level: medium
description: "Use when a user asks about monthly capacity, token usage, plan limits, near-limit warnings, or upgrading."
activation_phrases:
  - "monthly capacity"
  - "tokens"
  - "usage"
  - "limit"
  - "upgrade plan"
  - "quota"
requires_human_approval: true
delegent_safe: true
---

# Monthly Capacity And Upgrade Advisor

## When to use this skill

Use this skill when the user asks for:

- The user hits/approaches limits.
- They ask how usage works.

## Outcome

By the end of the task, the user should have:

- Plain-language usage explanation.
- Upgrade/wait options.
- Task size guidance.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What task are you trying to run?
- Are you near the monthly limit?
- Do you need more storage/voice/compute?

## Execution playbook

Follow this sequence:

1. Explain capacity without over-focusing on raw tokens.
2. Describe high-usage tasks.
3. Offer wait or upgrade paths.
4. Avoid pressuring user.

## Verification checklist

Before telling the user the work is complete, verify:

- User knows current options.
- No misleading cost claims.
- Plan change requires billing flow.

## Deliverables

Return one or more of:

- Usage explanation
- Upgrade recommendation
- Capacity-saving tips

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

- autonomous-bookkeeper
