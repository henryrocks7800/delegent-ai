---
name: invoice-chasing
title: Invoice Chasing And Credit Control
version: 1.0.0
category: finance
risk_level: medium
description: "Use for polite overdue invoice follow-up, escalation cadence, and cash collection admin."
activation_phrases:
  - "chase invoices"
  - "late payment"
  - "credit control"
  - "unpaid invoice"
  - "payment reminder"
requires_human_approval: true
delegent_safe: true
---

# Invoice Chasing And Credit Control

## When to use this skill

Use this skill when the user asks for:

- The user has unpaid invoices.
- They want reminder emails or a cadence.

## Outcome

By the end of the task, the user should have:

- Overdue invoice list.
- Reminder drafts.
- Escalation plan.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Where are invoices stored?
- What tone?
- Escalation policy?
- Can messages be sent automatically?

## Execution playbook

Follow this sequence:

1. Gather invoice data.
2. Sort by age/amount/customer.
3. Draft polite reminders.
4. Escalate carefully.
5. Track responses.

## Verification checklist

Before telling the user the work is complete, verify:

- Amounts/dates correct.
- Tone approved.
- Legal threats not sent without approval.

## Deliverables

Return one or more of:

- Overdue report
- Reminder drafts
- Escalation plan/timeline

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

- agent-email-inbox
- cashflow-dashboard
