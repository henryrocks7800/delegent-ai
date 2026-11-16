---
name: proposal-writer
title: Proposal, Tender And Grant Response Writer
version: 1.0.0
category: office
risk_level: medium
description: "Use to draft proposals, tenders, grant responses, scopes of work, and client pitches."
activation_phrases:
  - "proposal"
  - "tender"
  - "grant"
  - "scope of work"
  - "RFP"
  - "bid"
requires_human_approval: true
delegent_safe: true
---

# Proposal, Tender And Grant Response Writer

## When to use this skill

Use this skill when the user asks for:

- The user needs a persuasive formal response.
- Requirements must be matched to capabilities.

## Outcome

By the end of the task, the user should have:

- Response outline.
- Compliance matrix.
- Draft proposal.
- Questions/risks list.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- RFP/tender docs?
- Deadline?
- Evaluation criteria?
- Company details?
- Past examples?

## Execution playbook

Follow this sequence:

1. Read requirements.
2. Create compliance matrix.
3. Draft response sections.
4. Flag gaps.
5. Prepare final checklist.

## Verification checklist

Before telling the user the work is complete, verify:

- Every requirement addressed.
- Claims supported.
- Missing info flagged.
- Submission not made without approval.

## Deliverables

Return one or more of:

- Proposal draft
- Compliance matrix
- Submission checklist

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

- report-writer
