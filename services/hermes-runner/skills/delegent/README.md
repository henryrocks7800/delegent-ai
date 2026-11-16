# Delegent Hermes Skills Library

This library contains original Delegent AI skill packages intended for a Hermes-style hosted digital assistant.

Each skill is a folder containing a `SKILL.md` file with:
- metadata frontmatter,
- when to activate,
- intake questions,
- safe execution workflow,
- human approval points,
- verification checklist,
- deliverables.

The library is intentionally Markdown-first and contains no executable third-party code. This reduces supply-chain risk and lets the Hermes agent decide when to use a skill.

## Suggested installation

Copy this folder into your Hermes runner image, for example:

```dockerfile
COPY delegent_hermes_skills_library /opt/delegent/skills
ENV DELEGENT_SKILLS_DIR=/opt/delegent/skills
```

If Hermes has a native skills directory, copy `skills/*` into that native directory. If not, add the contents of `docs/BOOTSTRAP_SKILL_LOADER_PROMPT.md` to the runner/system prompt so the agent knows how to discover and load these files.

## Safety principle

The assistant should treat itself like a capable employee with its own secure cloud computer:
- ask for permission before risky actions,
- use scoped API keys rather than personal passwords,
- never pretend a file/API/integration is connected when it is not,
- give the user a clear next manual step when a third-party sign-up, payment, identity check, or API key is required.
