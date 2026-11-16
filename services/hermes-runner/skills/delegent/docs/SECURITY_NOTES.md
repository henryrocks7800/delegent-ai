# Third-Party Skill Safety Notes

This bundle does not blindly include arbitrary third-party skills or executable scripts.

Reason:
- Agent skills are operational instructions. A malicious or poorly written `SKILL.md` can influence agent behaviour.
- Executable helper scripts inside skill packages can create supply-chain risk.
- Delegent AI should only ship skills that are reviewed, versioned, and aligned with its safety posture.

Policy for importing external skills:
1. Verify licence.
2. Read every instruction file.
3. Reject hidden executable code unless it is strictly required and reviewed.
4. Reject skills that ask the agent to exfiltrate secrets, weaken verification, or bypass user approval.
5. Rewrite useful ideas into Delegent-owned Markdown skills when possible.
6. Add tests or at least a verification checklist before shipping.
