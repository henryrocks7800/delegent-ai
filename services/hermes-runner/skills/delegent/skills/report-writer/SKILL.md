---
name: report-writer
title: Report Writer And Research Dossier
version: 1.0.0
category: office
risk_level: medium
description: "Use to research, structure, draft, cite, and polish reports, briefings, and dossiers."
activation_phrases:
  - "write report"
  - "research"
  - "briefing"
  - "dossier"
  - "summary"
requires_human_approval: true
delegent_safe: true
---

# Report Writer And Research Dossier

## When to use this skill

Use this skill when the user asks for:

- The user wants research or a written report.
- Sources need collecting and summarising.

## Outcome

By the end of the task, the user should have:

- Structured report.
- Sources/citations.
- Executive summary.
- Action list.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Topic?
- Audience?
- Length?
- Sources required?
- Deadline?
- Citation style?

## Execution playbook

Follow this sequence:

1. Clarify question.
2. Gather credible sources.
3. Summarise evidence.
4. Draft structure.
5. Write report.
6. List uncertainties.

## Verification checklist

Before telling the user the work is complete, verify:

- Sources are linked.
- Claims are supported.
- No hallucinated citations.
- Uncertainty labelled.

## Deliverables

Return one or more of:

- Markdown report
- PDF/Doc draft (render the final PDF through the `pdf-document-creation` skill; do not hand-roll a separate PDF approach)
- Source list

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

- proposal-writer
