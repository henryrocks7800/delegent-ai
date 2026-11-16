---
name: phone-concierge-twilio
title: Phone Concierge And Call Handling Setup
version: 1.0.0
category: communications
risk_level: high
description: "Use when the user wants a business phone number, receptionist, call routing, transcription, or Twilio-style voice workflow."
activation_phrases:
  - "phone concierge"
  - "set up a phone line"
  - "answer calls"
  - "Twilio"
  - "phone number"
  - "receptionist"
  - "call handling"
requires_human_approval: true
delegent_safe: true
---

# Phone Concierge And Call Handling Setup

## When to use this skill

Use this skill when the user asks for:

- The user wants a phone system.
- The user wants call transcription/routing.
- The assistant needs a voice provider.

## Outcome

By the end of the task, the user should have:

- Provider setup plan.
- Phone number workflow.
- Call routing/transcription policy.
- Escalation rules.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

> **Already connected?** Run `delegent-connect list` before you plan any setup. It shows the services the user signed into on the Connections screen, which never appear in chat and never touch your workspace. If the provider is listed, it is live: use it. `delegent-keys list` shows the other kind, credentials the user typed in. Check both.

> **Storing keys:** put any key, token, or credential into the central encrypted vault with `delegent-keys put <service>` (encrypted at rest on this runner's own volume; never written into chat, never left as a plaintext file). Use it with `delegent-keys run --service <service> [--file] -- <command>`. See the `core-permissions-and-credentials` skill for the full how-to.

## Intake questions

Ask only what is needed. Start with:

- Which country/number type?
- Do you need inbound, outbound, SMS, voicemail?
- Who should calls escalate to?
- What must never be said automatically?

## Execution playbook

Follow this sequence:

1. Explain third-party signup/API key requirement.
2. Guide user through provider account creation.
3. Create minimal call flow.
4. Set human escalation.
5. Test with a small call.
6. Document costs and privacy notes.

## Verification checklist

Before telling the user the work is complete, verify:

- Number works.
- Calls route correctly.
- Transcripts are handled safely.
- Escalation rules are honoured.

## Deliverables

Return one or more of:

- Phone setup checklist
- Call flow spec
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
- core-permissions-and-credentials
