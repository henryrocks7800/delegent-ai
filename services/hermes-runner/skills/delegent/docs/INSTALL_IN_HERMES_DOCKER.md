# Installing This Skills Library In The Hermes Runner Docker Image

## Option A — Native Hermes skills directory

If Hermes supports a native skills directory, copy the `skills/` folder into that directory.

Example:

```dockerfile
COPY delegent_hermes_skills_library/skills /opt/hermes/skills/delegent
ENV HERMES_SKILLS_DIR=/opt/hermes/skills
```

## Option B — Delegent loader prompt

If Hermes does not natively discover skills, copy the whole library and add `docs/BOOTSTRAP_SKILL_LOADER_PROMPT.md` to the runner system/developer prompt.

```dockerfile
COPY delegent_hermes_skills_library /opt/delegent/skills
ENV DELEGENT_SKILLS_DIR=/opt/delegent/skills
```

Then make sure the runner can read `/opt/delegent/skills/MANIFEST.json`.

## Validation checklist

After image build:

```bash
test -f /opt/delegent/skills/MANIFEST.json
find /opt/delegent/skills/skills -name SKILL.md | wc -l
```

Run a smoke prompt:

> "I run a small business and want you to help set up bookkeeping with receipts and bank feeds. Which skill should you use?"

Expected:
- The agent should select `autonomous-bookkeeper`.
- It should ask intake questions.
- It should not claim it has bank/accounting API access until configured.
- It should explain that accounting outputs are drafts/checklists for review unless a separate verified integration exists, and name the manual approval step.
