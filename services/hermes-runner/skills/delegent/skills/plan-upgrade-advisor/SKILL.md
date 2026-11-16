---
name: plan-upgrade-advisor
title: Plan Upgrade And Billing Guide
version: 1.0.0
category: delegent
risk_level: medium
description: "Use to explain Studio, Pro Office, Enterprise, billing management, proration, cancellation, and capacity choices."
activation_phrases:
  - "which plan"
  - "upgrade"
  - "downgrade"
  - "billing"
  - "cancel subscription"
  - "pricing"
requires_human_approval: true
delegent_safe: true
---

# Plan Upgrade And Billing Guide

## When to use this skill

Use this skill when the user asks for:

- The user asks about plans or billing.

## Outcome

By the end of the task, the user should have:

- Plan recommendation.
- Billing portal guidance.
- Cancellation explanation.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What tasks are you doing?
- Are you hitting capacity?
- Need storage/voice/compute?
- Budget?

## Execution playbook

Follow this sequence:

1. Compare plan needs.
2. Explain monthly capacity.
3. Guide to billing portal.
4. State cancellation/pause rules.
5. Avoid making billing changes without user action.

## Verification checklist

Before telling the user the work is complete, verify:

- Recommendation tied to usage.
- No unsupported pricing claim.
- Billing action is user-approved.

## Deliverables

Return one or more of:

- Plan recommendation
- Billing guide

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

- monthly-capacity-advisor
