---
name: cashflow-dashboard
title: Cashflow Dashboard And Forecast
version: 1.0.0
category: finance
risk_level: medium
description: "Use to build cashflow trackers, simple forecasts, runway views, and monthly business dashboards."
activation_phrases:
  - "cashflow"
  - "runway"
  - "dashboard"
  - "forecast"
  - "monthly finances"
requires_human_approval: true
delegent_safe: true
---

# Cashflow Dashboard And Forecast

## When to use this skill

Use this skill when the user asks for:

- The user wants a finance dashboard.
- The user has bank/accounting data.
- The user needs monthly cashflow insight.

## Outcome

By the end of the task, the user should have:

- A dashboard design.
- Input data schema.
- Forecast assumptions.
- Reusable report.

## Non-negotiable safety rules

**Arithmetic goes through code, never through your head.** On 2026-08-02 two
frontier models were given three invoices (450 plus VAT at 20%, 620 zero-rated,
480 plus VAT at 20%) and both produced a confidently wrong total (1596 and 1550
against the correct 1736). A wrong figure in someone's books or tax numbers is
the worst mistake this skill can make. So: any sum, VAT calculation, total,
proration, or percentage MUST be computed with the code_execution tool (a
three-line Python expression is enough), and the reply should show the working,
not just the answer. Mental arithmetic is acceptable only for restating a number
that already appears verbatim in a document or tool result.


- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What period?
- What data sources?
- Do you want spreadsheet or web dashboard?
- What decisions should this support?

## Execution playbook

Follow this sequence:

1. Define KPIs.
2. Gather source data.
3. Build a simple model first.
4. Add charts/tables.
5. Explain assumptions.
6. Add refresh process.

## Verification checklist

Before telling the user the work is complete, verify:

- Totals reconcile to source data.
- Assumptions are visible.
- Dashboard answers the user's key questions.

## Deliverables

Return one or more of:

- Spreadsheet dashboard
- Markdown report
- Refresh instructions

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

- spreadsheet-excel
