---
name: social-content-marketing
title: Social Content And Marketing Operator
version: 1.0.0
category: marketing
risk_level: medium
description: "Use to draft posts, newsletters, blogs, campaign plans, and content calendars."
activation_phrases:
  - "social media"
  - "marketing"
  - "blog"
  - "newsletter"
  - "LinkedIn"
  - "content calendar"
requires_human_approval: true
delegent_safe: true
---

# Social Content And Marketing Operator

> ## FIRST: check what is already a connection
>
> Run `delegent-connect list` before planning any publishing.
>
> **LinkedIn, Instagram, Facebook Pages, Reddit and YouTube are
> Connections-tab services.** If one appears there with
> `"backend": "composio"`, publish through `delegent-connect exec` with the
> actions in the `connected-services` skill, after the user approves the
> exact words. Do not ask for tokens, app credentials or passwords for a
> service that has a card, and do not tell the user to reconnect one that is
> listed. Drafting stays here; publishing goes through the connection.

## When to use this skill

Use this skill when the user asks for:

- The user wants marketing content.
- A campaign/content calendar is needed.

## Outcome

By the end of the task, the user should have:

- Content plan.
- Draft posts.
- Publishing checklist.
- Brand/tone guide.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Audience?
- Platform?
- Tone?
- Offer?
- Frequency?
- Do you approve before publishing?

## Execution playbook

Follow this sequence:

1. Clarify audience/objective.
2. Draft calendar.
3. Create sample posts.
4. Check claims.
5. Schedule only with approval.

## Verification checklist

Before telling the user the work is complete, verify:

- Tone matches brand.
- Claims supported.
- No sensitive info.
- User approves external posts.

## Deliverables

Return one or more of:

- Content calendar
- Post drafts
- Campaign brief

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

