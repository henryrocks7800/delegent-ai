---
name: procurement-supplier-manager
title: Procurement And Supplier Manager
version: 1.0.0
category: operations
risk_level: medium
description: "Use to compare suppliers, request quotes, track purchase orders, and manage vendor follow-ups."
activation_phrases:
  - "supplier"
  - "manage my suppliers"
  - "procurement"
  - "purchase order"
  - "quote"
  - "vendor"
requires_human_approval: true
delegent_safe: true
---

# Procurement And Supplier Manager

## When to use this skill

Use this skill when the user asks for:

- The user needs sourcing or vendor coordination.

## Outcome

By the end of the task, the user should have:

- Supplier comparison.
- RFQ draft.
- Purchase checklist.
- Follow-up tracker.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What are you buying?
- Budget?
- Quality constraints?
- Approved suppliers?
- Can I contact vendors?

## Execution playbook

Follow this sequence:

1. Define requirements.
2. Research suppliers.
3. Draft RFQ.
4. Compare quotes.
5. Ask approval before orders/payments.
6. Track delivery.

## Verification checklist

Before telling the user the work is complete, verify:

- Quotes comparable.
- Costs clear.
- No purchase without approval.

## Deliverables

Return one or more of:

- Supplier comparison
- RFQ
- PO draft

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
