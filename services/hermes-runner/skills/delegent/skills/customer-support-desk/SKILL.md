---
name: customer-support-desk
title: Customer Support Desk Operator
version: 1.0.0
category: operations
risk_level: medium
description: "Use for support inbox triage, refunds recommendations, customer replies, escalation, and helpdesk workflows."
activation_phrases:
  - "customer support"
  - "helpdesk"
  - "support tickets"
  - "respond to customers"
  - "refund"
  - "complaint"
requires_human_approval: true
delegent_safe: true
---

# Customer Support Desk Operator

> ## FIRST: check what is already a connection
>
> Run `delegent-connect list` before anything else in this skill.
>
> **Zendesk and Freshdesk are Connections-tab services.** If either appears
> there with `"backend": "composio"`, the helpdesk is already connected and
> none of the setup below applies to it: read, triage and draft replies with
> `delegent-connect exec` and the actions in the `connected-services`
> skill, and do not ask for an API key or walk the user through a portal. The
> connection wins over everything below. This skill is for helpdesks that
> have NO card, and for the workflow design around any helpdesk.

## When to use this skill

Use this skill when the user asks for:

- The user needs help handling customer messages.
- Support volume is growing.
- They want drafts or automated triage.

## Outcome

By the end of the task, the user should have:

- Support workflow.
- Reply drafts.
- Escalation categories.
- Weekly support summary.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Which channels?
- Can the assistant send or draft only?
- Refund authority?
- Escalation rules?
- Tone guidelines?

## Execution playbook

Follow this sequence:

1. Categorise ticket types.
2. Define safe automatic vs approval-required replies.
3. Draft responses.
4. Flag urgent/legal/refund issues.
5. Create support metrics.

## Verification checklist

Before telling the user the work is complete, verify:

- Sensitive tickets are escalated.
- Replies match tone.
- Refund/payment actions need approval.
- No private data leaks.

## Deliverables

Return one or more of:

- Support triage report
- Draft replies
- Escalation policy

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
