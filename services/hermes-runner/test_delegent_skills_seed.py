"""Golden-image guard: prove the runner seeds the curated Delegent skills library
into HERMES_HOME/skills/delegent/ so the agent's own `skills` tool discovers it.

Why this matters: the skills are baked at /opt/delegent/skills, but the skills
tool only reads skills under HERMES_HOME/skills (the volume). Before the seed,
the agent never found skills like autonomous-bookkeeper through its tool and
improvised its own approach instead (e.g. self-authoring a Firefly-III setup when
asked to "be my accountant"). `_seed_delegent_skills` mirrors the library into
the tool's read path on every launch; this test proves it.

Runs inside the built image (the baked /opt/delegent/skills is the source):

  docker exec -e SIDEKICK_HERMES_API_DISABLED=true -w /app <container> \
    python3 /app/test_delegent_skills_seed.py
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app")
sys.path.insert(0, "/opt/hermes-agent")


def main():
    home = tempfile.mkdtemp(prefix="hermes-home-")
    os.environ["HERMES_HOME"] = home
    os.environ["SIDEKICK_HERMES_API_DISABLED"] = "true"
    os.environ.setdefault("SIDEKICK_RUNNER_SHARED_SECRET", "s" * 40)

    import server

    server._seed_delegent_skills(Path(home))

    dest = Path(home, "skills", "delegent")
    assert dest.is_dir(), f"delegent skills not seeded at {dest}"

    # The operator skills must be present + discoverable (SKILL.md each), so
    # "be my accountant" / "update my website" / "be my operations manager" can
    # route to a real skill.
    #
    # safe-inbox-manager was DELETED on 2026-09-03, at Alex's request: its whole
    # job was walking the user through Google Cloud Console to mint a Gmail
    # credential, and Gmail is a Connections card now. An inbox ask reaches the
    # brokered path instead, which is why it is no longer seeded or required.
    for slug in (
        "autonomous-bookkeeper",
        "website-builder",
        "operations-manager",
        "connected-services",
    ):
        skill_md = dest / slug / "SKILL.md"
        assert skill_md.is_file(), f"missing seeded skill: {skill_md}"

    # The shared modules must be mirrored so the connect scripts resolve them.
    # A seeded script at <home>/skills/delegent/<slug>/scripts/X.py loads _shared
    # via parents[3] == <home>/skills, so _shared must live there.
    shared = Path(home, "skills", "_shared")
    assert (shared / "credential_store.py").is_file(), f"_shared not seeded at {shared}"
    assert (shared / "oauth2.py").is_file(), f"oauth2 not seeded at {shared}"
    # Prove the exact parents[3] resolution the scripts use lands on the seeded _shared.
    script = dest / "autonomous-bookkeeper" / "scripts" / "freeagent_client.py"
    assert script.is_file(), f"missing seeded script: {script}"
    resolved = script.resolve().parents[3] / "_shared" / "credential_store.py"
    assert resolved.is_file(), f"parents[3]/_shared resolution broken: {resolved}"

    # Idempotent: a second launch refreshes wholesale without error or duplication.
    server._seed_delegent_skills(Path(home))
    count = sum(1 for p in dest.iterdir() if (p / "SKILL.md").is_file())
    assert count >= 30, f"expected at least 30 seeded skills, got {count}"
    print(f"OK: seeded {count} delegent skills + _shared into {dest.parent} (idempotent)")

    # Self-heal (live incident 2026-07-22): a long-running box lost 34 of 35
    # skills mid-session because the gateway re-execs without re-seeding. Simulate
    # that drift (delete a sentinel) and prove the per-message self-heal restores
    # the whole library, while a healthy library is left untouched.
    import shutil as _shutil

    telegram = dest / "connect-telegram"
    assert telegram.is_dir(), "expected connect-telegram to be seeded"
    _shutil.rmtree(telegram)
    assert not telegram.exists(), "sentinel not removed for drift simulation"
    server._ensure_delegent_skills_present(Path(home))
    assert (telegram / "SKILL.md").is_file(), "self-heal did not restore the pruned skill"
    healed = sum(1 for p in dest.iterdir() if (p / "SKILL.md").is_file())
    assert healed >= 30, f"expected the full library after self-heal, got {healed}"

    # A healthy library is a no-op: sentinels present -> no re-seed needed. Prove
    # the guard short-circuits by marking a file and confirming it survives.
    marker = dest / "connect-telegram" / ".heal-marker"
    marker.write_text("x")
    server._ensure_delegent_skills_present(Path(home))
    assert marker.is_file(), "self-heal re-seeded a healthy library (should be a no-op)"
    print(f"OK: self-heal restored the library after drift and no-oped when healthy")


if __name__ == "__main__":
    main()
