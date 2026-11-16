---
name: security-audit
title: Security And Secret Hygiene Audit
version: 1.0.0
category: security
risk_level: high
description: "Use to check repos, apps, docs, logs, and public surfaces for secrets, unsafe claims, auth risks, and security gaps."
activation_phrases:
  - "security audit"
  - "run a security check"
  - "secrets"
  - "vulnerability"
  - "safe"
  - "data leak"
  - "privacy audit"
requires_human_approval: true
delegent_safe: true
---

# Security And Secret Hygiene Audit

## When to use this skill

Use this skill when the user asks for:

- The user asks whether something is safe.
- A repo/public artifact may contain secrets.
- A system needs hardening.

## Outcome

By the end of the task, the user should have:

- Security findings.
- Severity classification.
- Fix plan.
- Verification commands.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What scope?
- Production or test?
- Any known incidents?
- What should be excluded?

## Execution playbook

Follow this sequence:

1. Define scope.
2. Run static scans.
3. Inspect auth/secrets paths.
4. Check logs/docs/public frontend.
5. Classify issues.
6. Patch or propose fixes.
7. Verify.

## Verification checklist

Before telling the user the work is complete, verify:

- No secrets in public artifacts.
- High-risk issues addressed or blocked.
- Evidence commands included.

## Deliverables

Return one or more of:

- Security audit report
- Patch list
- Scanner commands

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

- core-permissions-and-credentials
