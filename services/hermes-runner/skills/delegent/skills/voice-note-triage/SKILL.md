---
name: voice-note-triage
title: Voice Note Triage
version: 1.0.0
category: communications
risk_level: medium
description: "Use to turn voice notes/transcripts into tasks, summaries, draft replies, and action plans."
activation_phrases:
  - "voice note"
  - "transcribe"
  - "audio summary"
  - "dictation"
  - "what did I say"
requires_human_approval: true
delegent_safe: true
---

# Voice Note Triage

## When to use this skill

Use this skill when the user asks for:

- The user has a voice recording or transcript.
- They want tasks extracted.

## Outcome

By the end of the task, the user should have:

- Transcript summary.
- Task list.
- Draft messages.
- Follow-up plan.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- Do you have audio or transcript?
- Who is the audience?
- Should I draft replies?
- Any sensitive content?

## Execution playbook

Follow this sequence:

1. Transcribe if supported.
2. Summarise key points.
3. Extract actions/deadlines.
4. Draft follow-ups.
5. Flag uncertain audio segments.

## Verification checklist

Before telling the user the work is complete, verify:

- Transcript confidence noted.
- No invented details.
- Actions tied to source.

## Deliverables

Return one or more of:

- Summary
- Task list
- Draft replies

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
