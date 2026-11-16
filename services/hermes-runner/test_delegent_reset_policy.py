"""Phase 3 validation: prove the runner-seeded config.yaml makes the REAL Hermes
gateway loader (load_gateway_config) set the delegent durable session to never
auto-reset. This guards the loader's quirk that config.yaml `session_reset` maps
to default_reset_policy while `reset_by_platform` is NOT read from config.yaml —
so we must use the key that actually takes effect.

  docker run --rm -e PYTHONPYCACHEPREFIX=/tmp/pyc \
    -e SIDEKICK_HERMES_API_DISABLED=true \
    -v <repo>/services/hermes-runner/server.py:/app/server.py:ro \
    -v <repo>/services/hermes-runner/test_delegent_reset_policy.py:/app/t.py:ro \
    -w /app --entrypoint python delegent-hermes-runner:local /app/t.py
"""
import os
import sys
import tempfile

sys.path.insert(0, "/app")
sys.path.insert(0, "/opt/hermes-agent")


def main():
    home = tempfile.mkdtemp(prefix="hermes-home-")
    os.environ["HERMES_HOME"] = home
    os.environ["DELEGENT_PLATFORM_ENABLED"] = "true"
    os.environ["DELEGENT_PLATFORM_PORT"] = "8644"
    os.environ.setdefault("SIDEKICK_RUNNER_SHARED_SECRET", "s" * 40)

    import server
    from pathlib import Path

    ok = server._seed_hermes_gateway_config(Path(home), "127.0.0.1", 8643, "bearer-xyz")
    assert ok, "seed config failed"

    written = Path(home, "config.yaml").read_text(encoding="utf-8")
    assert "session_reset:" in written and "mode: none" in written, written
    assert "delegent:" in written, "delegent platform block missing"
    print("OK seed: config.yaml carries delegent platform + session_reset mode: none")

    # The real loader is the proof: it must surface mode='none' as the default
    # reset policy (config.yaml `reset_by_platform` is ignored by this build, so
    # the `session_reset` default is the lever that actually works). Since
    # reset_by_platform is empty, get_reset_policy() falls back to this default —
    # i.e. this IS the effective policy for the delegent session. (The delegent
    # platform's own enablement is covered by verify-golden-image.sh §4.7.)
    from gateway.config import load_gateway_config

    cfg = load_gateway_config()
    assert cfg.default_reset_policy.mode == "none", (
        f"expected default_reset_policy.mode='none', got {cfg.default_reset_policy.mode!r}"
    )
    eff = cfg.get_reset_policy()  # no platform => the default, which delegent inherits
    assert eff.mode == "none", f"effective reset mode={eff.mode!r}"
    print("OK loader: default_reset_policy.mode='none' — the durable session never auto-resets (weeks/months memory)")

    print("\nDELEGENT RESET-POLICY VALIDATION PASSED")


if __name__ == "__main__":
    main()
