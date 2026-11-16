---
name: spreadsheet-excel
title: Spreadsheet And Excel Builder
version: 1.0.0
category: office
risk_level: medium
description: "Use to build spreadsheets, formulas, dashboards, pivot summaries, budgets, trackers, or CSV transformations."
activation_phrases:
  - "Excel"
  - "spreadsheet"
  - "CSV"
  - "formula"
  - "dashboard"
  - "pivot table"
requires_human_approval: true
delegent_safe: true
---

# Spreadsheet And Excel Builder

## When to use this skill

Use this skill when the user asks for:

- The user needs spreadsheet work.
- Data needs cleaning, modelling, or reporting.

## Outcome

By the end of the task, the user should have:

- Working spreadsheet.
- Formulas explained.
- Charts/tables.
- Refresh instructions.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Be consistent, do not invent conventions mid-task

Predictability matters more than cleverness on recurring files (expense trackers,
budgets, logs the user reuses every session):

- **Do not create backup copies of a file unless the user asked for backups.**
  Silently spawning `..._backup.xlsx` files clutters the workspace, breaks the
  user's own version control, and erodes trust because the behaviour changed
  without warning. Edit the file in place. If the user *does* want backups, agree
  one rule (a single `backups/` folder, timestamped name like
  `<name>.backup_YYYYMMDD_HHMMSS.xlsx`) and keep to it every time.
- **Keep the same file names, sheet layout, and folder for a recurring tracker**
  across sessions. Do not rename or restructure a file the user relies on without
  telling them first and getting a yes.
- If you think a new convention would genuinely help, **propose it and wait**,
  rather than applying it mid-workflow.

## Intake questions

Ask only what is needed. Start with:

- What data?
- Excel/Google Sheets/CSV? If Google Sheets, run `delegent-connect list` first: when `google_sheets` is there with `"backend": "composio"`, work on the live sheet with `delegent-connect exec --tool GOOGLESHEETS_...` (see the connected-services skill) rather than downloading a copy.
- What outputs?
- Need formulas or static report?

## Execution playbook

Follow this sequence:

1. Inspect data.
2. Clean columns.
3. Build model/formulas.
4. Add validation.
5. Add charts if useful.
6. Test sample rows.

## Verification checklist

Before telling the user the work is complete, verify:

- Formulas correct.
- Totals reconcile.
- Inputs/outputs labelled.
- Edge cases checked.

## Deliverables

Return one or more of:

- Spreadsheet file
- CSV
- Formula notes

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

- cashflow-dashboard
