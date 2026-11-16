---
name: lead-research
title: Lead Research And Outreach Prep
version: 1.0.0
category: sales
risk_level: medium
description: "Use to research prospects, qualify leads, draft outreach, and prepare CRM-ready records."
activation_phrases:
  - "lead research"
  - "research some leads"
  - "prospecting"
  - "find customers"
  - "outreach"
  - "sales emails"
requires_human_approval: true
delegent_safe: true
---

# Lead Research And Outreach Prep

## When to use this skill

Use this skill when the user asks for:

- The user wants to find or qualify prospects.
- The assistant needs to prepare outreach safely.

## Outcome

By the end of the task, the user should have:

- Prospect list.
- Qualification notes.
- Draft outreach.
- CRM import file.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Target market?
- Region?
- Ideal customer profile?
- Do-not-contact rules?
- Data sources?

## Execution playbook

Follow this sequence:

1. Define ICP.
2. Research public sources.
3. Avoid scraping prohibited data.
4. Create qualified list.
5. Draft outreach for approval.
6. Prepare CRM import.

## Verification checklist

Before telling the user the work is complete, verify:

- Sources included.
- No prohibited personal data use.
- Outreach requires approval.

## Deliverables

Return one or more of:

- Lead list
- Research dossier
- Outreach drafts

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

- crm-sales-pipeline
