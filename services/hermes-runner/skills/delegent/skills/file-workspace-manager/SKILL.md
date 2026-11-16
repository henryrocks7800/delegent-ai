---
name: file-workspace-manager
title: Cloud Workspace And File Manager
version: 1.0.0
category: files
risk_level: medium
description: "Use to organise the assistant's cloud workspace, folders, generated files, downloads, and user-provided documents."
activation_phrases:
  - "files"
  - "folder"
  - "workspace"
  - "save this"
  - "home directory"
  - "organise documents"
requires_human_approval: true
delegent_safe: true
---

# Cloud Workspace And File Manager

## When to use this skill

Use this skill when the user asks for:

- The user asks about files/folders.
- A task creates or consumes files.
- Workspace is messy.

## Outcome

By the end of the task, the user should have:

- Folder structure.
- File inventory.
- Clear save locations.
- No raw path leakage.

## Non-negotiable safety rules

- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.

## Intake questions

Ask only what is needed. Start with:

- What files?
- What folders make sense?
- Should anything be archived/deleted?
- Who can access?

## Where the user's files MUST live (so they can actually see them)

The app's **Files** tab only shows the user's workspace: `~/Documents`,
`~/Downloads`, and the other home folders (these are symlinked onto the durable
workspace, so a write there is visible and survives restarts). Anything you save
**outside** that, e.g. under `/data/hermes/skills/`, `/data/hermes/workspace/`
sub-paths that are not linked, or the `/data/hermes/` root, is **invisible to the
user and easy to lose track of**. Two real failures came from this: the user
could not find files the agent claimed to have created, and the agent itself lost
a file it had moved to a non-workspace path and asked the user to re-upload it.

Hard rules:

- **Save every user-facing deliverable** (documents, PDFs, spreadsheets, exports)
  into `~/Documents` (or a clearly named subfolder of it). Never leave a user's
  file in `/data/hermes/skills/`, a scratch/temp path, or the home root.
- **After you create or move a file, record its absolute path** in your reply and
  in memory for the session, and confirm it by listing the folder. Do not rely on
  remembering where you put it, verify by reading it back.
- **Never ask the user to re-upload a file you created yourself.** If you cannot
  find it, search the workspace (`find ~/Documents -name '<name>'`) before asking.
- Skill files, scripts, and other agent internals stay under the skills/workspace
  dirs and are not user deliverables, do not surface those as "your files".

## Execution playbook

Follow this sequence:

1. List existing workspace safely.
2. Create friendly folders **under `~/Documents`** so they show in the Files tab.
3. Move/rename files, then read the destination back to confirm.
4. Avoid exposing internal paths when not needed, but always know the real path.
5. Summarise final locations with their absolute paths.

## Verification checklist

Before telling the user the work is complete, verify:

- Files exist where claimed.
- Names are user-friendly.
- No secrets exposed.
- Deletion only with approval.

## Deliverables

Return one or more of:

- File inventory
- Folder structure
- Cleanup report

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

- website-builder
