"""Contract test for the Route B streaming bridge in server.py (the runner
wrapper side). Plain-python (no pytest) so it runs in the golden image:

  docker run --rm -e PYTHONPYCACHEPREFIX=/tmp/pyc \
    -e SIDEKICK_HERMES_API_DISABLED=true -e DELEGENT_PLATFORM_SECRET=bridge_test_secret \
    -v <repo>/services/hermes-runner/server.py:/app/server.py:ro \
    -v <repo>/services/hermes-runner/test_delegent_bridge.py:/app/test_delegent_bridge.py:ro \
    -w /app --entrypoint python delegent-hermes-runner:local /app/test_delegent_bridge.py

Proves the in-process bridge that replaces a Durable Object:
  (1) the per-run queue registry is get-or-create + cleans up on close;
  (2) /v1/delegent/ingest is secret-gated and pushes onto the run's queue;
  (3) GET /v1/delegent/runs/{id}/events drains the queue IN ORDER as SSE,
      closes on a terminal kind:'done', and cleans the registry;
  (4) a bypass-style one-shot send (no 'done') is idle-closed (reason=idle) —
      the mechanism that ends a slash-command turn.
"""
import asyncio
import json
import os
import sys
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SIDEKICK_HERMES_API_DISABLED", "true")
os.environ.setdefault("DELEGENT_PLATFORM_SECRET", "bridge_test_secret")

sys.path.insert(0, "/app")
import server  # noqa: E402
import httpx  # noqa: E402

SECRET = os.environ["DELEGENT_PLATFORM_SECRET"]
AUTH = {"x-delegent-platform-secret": SECRET}

# Bypass the inbound HMAC gate (exercised separately by the runner contract
# tests) so this focuses on the bridge, and shrink the timers so idle/keepalive
# fire in well under a second.
server.require_sidekick_runner_authorization = lambda request, env=None: "test-user"
server.DELEGENT_STREAM_KEEPALIVE_SECS = 0.2
server.DELEGENT_STREAM_IDLE_SECS = 0.5
server.DELEGENT_STREAM_MAX_LIFETIME_SECS = 5.0


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url="http://t")


def test_registry_open_close():
    server._DELEGENT_STREAMS.clear()
    q1 = server._delegent_stream_open("run_x")
    q2 = server._delegent_stream_open("run_x")
    assert q1 is q2, "open must be get-or-create (one queue per run_id)"
    server._delegent_stream_close("run_x")
    assert "run_x" not in server._DELEGENT_STREAMS
    print("OK registry: open is idempotent + close removes the queue")


async def _drain_sse(c, run_id):
    events = []
    async with c.stream("GET", f"/v1/delegent/runs/{run_id}/events") as resp:
        assert resp.status_code == 200, resp.status_code
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[len("data:"):].strip()))
                if events[-1].get("kind") == "done":
                    break
    return events


async def _ingest_then_drain():
    server._DELEGENT_STREAMS.clear()
    async with _client() as c:
        run_id = "run_abc123"
        server._delegent_stream_open(run_id)

        # wrong secret -> 401
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "edit", "text": "hi"},
                         headers={"x-delegent-platform-secret": "nope"})
        assert r.status_code == 401, f"expected 401, got {r.status_code}"

        # off-box peer with the CORRECT secret -> 403. The relay target is
        # 127.0.0.1 by construction, so a non-loopback source is never the
        # adapter, even if the platform secret has leaked.
        offbox = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app, client=("203.0.113.9", 4242)),
            base_url="http://t",
        )
        async with offbox:
            r = await offbox.post("/v1/delegent/ingest",
                                  json={"run_id": run_id, "kind": "edit", "text": "spoof"},
                                  headers=AUTH)
            assert r.status_code == 403, f"expected 403 for off-box peer, got {r.status_code}"

        # Connect while work is active to check the ordered live queue. A
        # connection after completion correctly replays the final journal
        # snapshot instead (covered by test_delivery_control.py).
        drain = asyncio.create_task(_drain_sse(c, run_id))
        await asyncio.sleep(0.01)
        # authorized deltas push (204), then a terminal done
        for t in ["He", "Hello", "Hello world"]:
            r = await c.post("/v1/delegent/ingest",
                             json={"run_id": run_id, "kind": "edit", "text": t},
                             headers=AUTH)
            assert r.status_code == 204, f"expected 204, got {r.status_code}"
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "done", "final": True, "outcome": "success"},
                         headers=AUTH)
        assert r.status_code == 204

        events = await drain
        kinds = [e["kind"] for e in events]
        texts = [e.get("text") for e in events if e["kind"] == "edit"]
        assert kinds[-1] == "done", kinds
        assert events[-1].get("outcome") == "success", events[-1]
        assert texts == ["He", "Hello", "Hello world"], texts
        await asyncio.sleep(0.05)
        assert run_id not in server._DELEGENT_STREAMS, "closing the SSE must clean the registry"
        print("OK bridge: secret-gated ingest -> ordered SSE -> close on 'done' -> registry cleaned")


async def _idle_close():
    server._DELEGENT_STREAMS.clear()
    async with _client() as c:
        run_id = "run_idle1"
        server._delegent_stream_open(run_id)
        # one-shot send, NO done (a bypass slash-command reply pattern)
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "send", "text": "one-shot reply"},
                         headers=AUTH)
        assert r.status_code == 204
        events = await _drain_sse(c, run_id)
        assert events[0]["kind"] == "send" and events[0]["text"] == "one-shot reply", events
        assert events[-1]["kind"] == "done" and events[-1].get("reason") == "idle", events
        print("OK bridge: one-shot send with no 'done' is idle-closed (reason=idle)")


def test_delegent_secret_plumbing():
    # The adapter (gateway subprocess) and the ingest/inbound endpoints (this
    # process) MUST agree on the loopback token, OR every reply 401s at the
    # ingest. And the runner shared secret must NEVER leak into the subprocess
    # env (custody invariant). Drive _prepare_delegent_gateway_env directly.
    saved = {k: os.environ.get(k) for k in (
        "DELEGENT_PLATFORM_ENABLED", "DELEGENT_RELAY_URL", "DELEGENT_PLATFORM_SECRET",
        "SIDEKICK_RUNNER_SHARED_SECRET", "PORT", "SIDEKICK_USER_ID", "DELEGENT_ALLOWED_USERS",
        "DELEGENT_HOME_CHANNEL",
    )}
    try:
        for k in ("DELEGENT_RELAY_URL", "DELEGENT_PLATFORM_SECRET", "DELEGENT_ALLOWED_USERS", "DELEGENT_HOME_CHANNEL"):
            os.environ.pop(k, None)
        os.environ["DELEGENT_PLATFORM_ENABLED"] = "true"
        os.environ["PORT"] = "8642"
        os.environ["SIDEKICK_USER_ID"] = "33333333-3333-4333-8333-333333333333"
        # Simulate the runner shared secret being present in THIS process (as it
        # is, restored from the fd) — it must not propagate to the subprocess.
        os.environ["SIDEKICK_RUNNER_SHARED_SECRET"] = "runner-shared-secret-MUST-NOT-LEAK"

        sub_env = {}
        enabled = server._prepare_delegent_gateway_env(sub_env)
        assert enabled is True
        # gateway-level DM auth: the machine's own user is allowlisted, so the
        # first in-app message never hits the pairing gate.
        assert sub_env.get("DELEGENT_ALLOWED_USERS") == os.environ["SIDEKICK_USER_ID"], sub_env.get("DELEGENT_ALLOWED_USERS")
        # home channel = the owner's app DM: kills the first-message "/sethome"
        # nag and routes cron results into the app chat.
        assert sub_env.get("DELEGENT_HOME_CHANNEL") == os.environ["SIDEKICK_USER_ID"], sub_env.get("DELEGENT_HOME_CHANNEL")
        token = os.environ["DELEGENT_PLATFORM_SECRET"]
        assert token, "a loopback token must be minted"
        assert token != os.environ["SIDEKICK_RUNNER_SHARED_SECRET"], "token must NOT be the runner shared secret"
        # both sides agree
        assert sub_env["DELEGENT_PLATFORM_SECRET"] == token, "adapter (subprocess) token must match"
        assert server._delegent_platform_secret() == token, "ingest/inbound must use the same token"
        # relay points at our own loopback ingest on the runner port
        assert os.environ["DELEGENT_RELAY_URL"] == "http://127.0.0.1:8642/v1/delegent/ingest", os.environ["DELEGENT_RELAY_URL"]
        assert sub_env["DELEGENT_RELAY_URL"] == os.environ["DELEGENT_RELAY_URL"]
        # custody: the runner shared secret never reaches the subprocess env
        assert "SIDEKICK_RUNNER_SHARED_SECRET" not in sub_env, "runner shared secret must not leak to the gateway subprocess"
        print("OK secret-plumbing: adapter+ingest share a minted loopback token; runner shared secret never leaks to the subprocess")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_healthz_reflects_gateway_liveness():
    # The gateway child can exit after the sticky 'available' flag was set; the
    # supervisor relaunches it, but until it's back /healthz MUST report the
    # truth so Fly's check + the Worker's preflight don't dispatch into a dead
    # gateway. Drive the honest computation directly.
    from types import SimpleNamespace
    saved = dict(server._HERMES_API_STATE)
    try:
        # available flag set, but NO process -> not available (honest)
        server._HERMES_API_STATE["available"] = True
        server._HERMES_API_STATE["process"] = None
        server._HERMES_API_STATE["startup_error"] = None
        h = server.healthz()
        assert h["hermesApiServerAvailable"] is False, h
        assert h["hermesApiServerReason"] == "gateway_process_not_running", h["hermesApiServerReason"]

        # a live child (poll() -> None) -> available
        server._HERMES_API_STATE["process"] = SimpleNamespace(poll=lambda: None)
        h = server.healthz()
        assert h["hermesApiServerAvailable"] is True, h
        assert h["hermesApiServerReason"] == "ok", h["hermesApiServerReason"]

        # a dead child (poll() -> exit code) -> not available
        server._HERMES_API_STATE["process"] = SimpleNamespace(poll=lambda: 1)
        h = server.healthz()
        assert h["hermesApiServerAvailable"] is False, h
        print("OK health: hermesApiServerAvailable reflects ACTUAL gateway child liveness (no sticky lie)")
    finally:
        server._HERMES_API_STATE.clear()
        server._HERMES_API_STATE.update(saved)


def test_run_record_merge_semantics():
    # (5) The run RECORD mirrors the Worker translator's merge: send commits
    # the prior segment, edit replaces the current one, the U+2589 cursor is
    # stripped, done captures the outcome. (2026-06-12 dropped-reply fix.)
    server._DELEGENT_RUNS.clear()
    rid = "run_rec1"
    server._delegent_run_record_update(rid, {"kind": "send", "text": "Part one."})
    server._delegent_run_record_update(rid, {"kind": "send", "text": "Pa", "final": False})
    server._delegent_run_record_update(rid, {"kind": "edit", "text": "Part two. ▉", "final": True})
    rec = server._DELEGENT_RUNS[rid]
    # 2026-07-22: committed bubbles carry a blank-line separator, byte-identical
    # to the Worker translator, so reconcile can never swap paragraphs for mush.
    assert rec["committed"] + rec["segment"] == "Part one.\n\nPart two.", rec
    assert rec["last_final"] is True, rec
    assert rec["done"] is False
    server._delegent_run_record_update(rid, {"kind": "done", "outcome": "success"})
    assert server._DELEGENT_RUNS[rid]["done"] is True
    assert server._DELEGENT_RUNS[rid]["outcome"] == "success"
    server._DELEGENT_RUNS.clear()
    print("OK record: send/edit merge + cursor strip + done/outcome match the Worker translator")


def test_run_record_replayed_send_is_idempotent():
    # 2026-07-04 incident: a replayed identical `send` frame (stream reconnect
    # re-delivery) double-committed the segment, so the provider-error reply
    # was stored twice in the bubble. An identical consecutive send must be a
    # liveness refresh, not a commit.
    server._DELEGENT_RUNS.clear()
    rid = "run_replay1"
    server._delegent_run_record_update(rid, {"kind": "send", "text": "warning line", "final": True})
    server._delegent_run_record_update(rid, {"kind": "send", "text": "warning line", "final": True})
    rec = server._DELEGENT_RUNS[rid]
    assert rec["committed"] + rec["segment"] == "warning line", rec
    assert rec["last_final"] is True, rec
    # a genuinely new bubble still commits the prior one (with the separator)
    server._delegent_run_record_update(rid, {"kind": "send", "text": "next bubble", "final": False})
    rec = server._DELEGENT_RUNS[rid]
    assert rec["committed"] + rec["segment"] == "warning line\n\nnext bubble", rec
    server._DELEGENT_RUNS.clear()
    print("OK record: replayed identical send frame is idempotent (2026-07-04 double-append)")


async def _record_survives_idle_close():
    # (6) THE 2026-06-12 dropped-reply regression. A turn goes relay-silent
    # (slow tool call) so the bridge idle-closes its SSE and deletes the queue.
    # The frames the adapter relays AFTER that point — the user's REAL answer —
    # used to vanish into a resurrected queue nobody drained. They must now:
    #   (a) NOT resurrect a live queue (no zombie streams), and
    #   (b) land in the run RECORD, exposed via GET /v1/delegent/runs/{id},
    # which is what the Worker reconciles the bubble from.
    server._DELEGENT_STREAMS.clear()
    server._DELEGENT_RUNS.clear()
    async with _client() as c:
        run_id = "run_dropped1"
        server._delegent_stream_open(run_id)
        server._delegent_run_record_open(run_id)

        # the visible partial: preamble + tool marker, then silence
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "send",
                               "text": "I need to search my past conversations."},
                         headers=AUTH)
        assert r.status_code == 204
        events = await _drain_sse(c, run_id)  # idle window (shrunk) fires -> synthetic done
        assert events[-1]["kind"] == "done" and events[-1].get("reason") == "idle", events
        await asyncio.sleep(0.05)
        assert run_id not in server._DELEGENT_STREAMS, "idle close must clean the queue registry"

        # ...the turn continues on-box: the REAL answer relays late
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "send",
                               "text": "I checked: we discussed the launch plan yesterday.",
                               "final": True},
                         headers=AUTH)
        assert r.status_code == 204
        r = await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "done", "final": True, "outcome": "success"},
                         headers=AUTH)
        assert r.status_code == 204

        # (a) no zombie queue was resurrected by the late frames
        assert run_id not in server._DELEGENT_STREAMS, "late frames must NOT resurrect a closed stream"

        # (b) the record holds the FULL transcript and the Worker can read it
        resp = await c.get(f"/v1/delegent/runs/{run_id}")
        assert resp.status_code == 200, resp.status_code
        body = resp.json()
        assert body["done"] is True and body["outcome"] == "success", body
        # 2026-07-22: committed bubbles carry the blank-line separator.
        assert body["text"] == ("I need to search my past conversations."
                                "\n\n"
                                "I checked: we discussed the launch plan yesterday."), body
        assert body["last_final"] is True, body

        # unknown run -> 404 (the Worker treats this conservatively)
        resp = await c.get("/v1/delegent/runs/run_does_not_exist")
        assert resp.status_code == 404, resp.status_code
    server._DELEGENT_RUNS.clear()
    print("OK record: late post-idle-close frames land in the run record; GET exposes the full answer (dropped-reply regression)")


async def _keepalive_pings_only_while_busy():
    # (7) Busy-aware autostop (2026-06-14 mid-run-stop fix). The keepalive must
    # ping the machine's OWN public Fly hostname ONLY while a delegent run is in
    # flight — that request returns through the Fly proxy and resets its idle
    # timer, so Fly never stops a busy machine mid-run. When no run is active it
    # must ping nothing, so a genuinely idle machine still scales to zero.
    server._DELEGENT_RUNS.clear()
    # Earlier tests hit the app through the test client, which the sleep-grace
    # middleware counts as user activity; clear it so this test measures the
    # run-driven behaviour alone (the grace window has its own test below).
    server._DELEGENT_LAST_ACTIVITY_TS = 0.0

    # off Fly (no FLY_APP_NAME) -> no URL -> the loop is a pure no-op.
    saved_app = os.environ.pop("FLY_APP_NAME", None)
    assert server._fly_self_keepalive_url() is None, "no FLY_APP_NAME must mean no keepalive target"
    os.environ["FLY_APP_NAME"] = "delegent-runner-test"
    expected_url = "https://delegent-runner-test.fly.dev/healthz"
    assert server._fly_self_keepalive_url() == expected_url, server._fly_self_keepalive_url()

    pings: list[str] = []

    class _FakeClient:
        async def get(self, url, timeout=None):
            pings.append(url)
            return None

    saved_client = server._HERMES_API_CLIENT
    saved_interval = server.DELEGENT_KEEPALIVE_INTERVAL_SECS
    server._HERMES_API_CLIENT = _FakeClient()
    server.DELEGENT_KEEPALIVE_INTERVAL_SECS = 0.05
    try:
        # an active run (done == False) -> pings flow through the proxy
        server._delegent_run_record_open("run_busy")
        assert server._delegent_has_active_run() is True
        task = asyncio.create_task(server._delegent_autostop_keepalive())
        await asyncio.sleep(0.2)
        assert len(pings) >= 1, "an active run must keep the proxy idle-timer alive"
        assert all(u == expected_url for u in pings), pings

        # the run completes -> pings stop (idle machine free to scale to zero)
        server._delegent_run_record_update("run_busy", {"kind": "done", "outcome": "success"})
        assert server._delegent_has_active_run() is False
        await asyncio.sleep(0.1)
        before = len(pings)
        await asyncio.sleep(0.2)
        assert len(pings) == before, "no active run -> no keepalive ping (scale-to-zero preserved)"

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    finally:
        server._HERMES_API_CLIENT = saved_client
        server.DELEGENT_KEEPALIVE_INTERVAL_SECS = saved_interval
        server._DELEGENT_RUNS.clear()
        if saved_app is None:
            os.environ.pop("FLY_APP_NAME", None)
        else:
            os.environ["FLY_APP_NAME"] = saved_app
    print("OK keepalive: pings the public Fly host only while a run is active, silent when idle (busy-aware autostop)")


def test_sleep_grace_keeps_an_idle_machine_awake_for_a_while():
    # (8) Sleep grace (2026-09-07, Alex). Fly's own idle window is minutes, so
    # a user who reads a reply and sends the next message ten minutes later
    # paid a ~15 s cold boot. The keepalive now also pings for
    # DELEGENT_SLEEP_GRACE_SECS after the LAST real request; health checks
    # and the keepalive's own pings never count (or it would never sleep).
    server._DELEGENT_RUNS.clear()
    saved_grace = os.environ.pop("DELEGENT_SLEEP_GRACE_SECS", None)
    try:
        # default: two hours
        assert server._sleep_grace_secs() == 7200.0, server._sleep_grace_secs()
        # nothing ever happened -> no keepalive, machine may sleep
        server._DELEGENT_LAST_ACTIVITY_TS = 0.0
        assert server._delegent_should_keepalive(now=1_000_000.0) is False
        # a real request at t=0 keeps it awake for the grace window, then not
        server._delegent_note_activity(now=1_000_000.0)
        assert server._delegent_should_keepalive(now=1_000_000.0 + 60) is True
        assert server._delegent_should_keepalive(now=1_000_000.0 + 7199) is True
        assert server._delegent_should_keepalive(now=1_000_000.0 + 7201) is False
        # an in-flight run always keeps it awake, grace or not
        os.environ["DELEGENT_SLEEP_GRACE_SECS"] = "0"
        assert server._delegent_should_keepalive(now=1_000_000.0 + 10) is False, "grace 0 -> only runs keep it awake"
        server._delegent_run_record_open("run_grace")
        assert server._delegent_should_keepalive(now=1_000_000.0 + 10) is True
        server._delegent_run_record_update("run_grace", {"kind": "done", "outcome": "success"})
        assert server._delegent_should_keepalive(now=1_000_000.0 + 10) is False
        # env override
        os.environ["DELEGENT_SLEEP_GRACE_SECS"] = "3600"
        assert server._sleep_grace_secs() == 3600.0
        assert server._delegent_should_keepalive(now=1_000_000.0 + 3599) is True
        assert server._delegent_should_keepalive(now=1_000_000.0 + 3601) is False
    finally:
        server._DELEGENT_RUNS.clear()
        server._DELEGENT_LAST_ACTIVITY_TS = 0.0
        if saved_grace is None:
            os.environ.pop("DELEGENT_SLEEP_GRACE_SECS", None)
        else:
            os.environ["DELEGENT_SLEEP_GRACE_SECS"] = saved_grace
    print("OK sleep-grace: awake for the grace window after the last real request, always while a run is active, asleep otherwise")


def test_run_record_timing_marks():
    # Perf-plan step 3 (2026-07): the record stamps created_mono at open and
    # first_content_mono on the FIRST send/edit frame with text; typing frames
    # never count as content; the first-content mark never moves; done logs a
    # single [delegent-timing] line and must not raise.
    server._DELEGENT_RUNS.clear()
    rid = "run_timing1"
    rec = server._delegent_run_record_open(rid)
    assert isinstance(rec["created_mono"], float), rec
    assert rec["first_content_mono"] is None, rec
    server._delegent_run_record_update(rid, {"kind": "typing"})
    assert server._DELEGENT_RUNS[rid]["first_content_mono"] is None
    server._delegent_run_record_update(rid, {"kind": "edit", "text": "Hel ▉"})
    first = server._DELEGENT_RUNS[rid]["first_content_mono"]
    assert isinstance(first, float) and first >= rec["created_mono"]
    server._delegent_run_record_update(rid, {"kind": "edit", "text": "Hello there"})
    assert server._DELEGENT_RUNS[rid]["first_content_mono"] == first, "first-content mark must never move"
    server._delegent_run_record_update(rid, {"kind": "done", "outcome": "success"})
    assert server._DELEGENT_RUNS[rid]["done"] is True
    server._DELEGENT_RUNS.clear()
    print("OK timing: record stamps created/first-content marks + logs one line at done")


def test_browser_prewarm_gating_and_happy_path():
    # Perf-plan step 2 (2026-07): pre-warm is env-gated, tolerates a missing
    # binary, and its full happy path runs the CLI open+close without raising.
    old_env = os.environ.get("SIDEKICK_BROWSER_PREWARM")
    old_bin = server.AGENT_BROWSER_BIN
    old_delay = server.BROWSER_PREWARM_DELAY_SECS
    try:
        # (a) disabled via env -> gate closed even with a real binary
        os.environ["SIDEKICK_BROWSER_PREWARM"] = "0"
        server.AGENT_BROWSER_BIN = sys.executable
        assert server._browser_prewarm_enabled() is False
        # (b) enabled but binary missing -> gate closed (no crash on boot)
        os.environ["SIDEKICK_BROWSER_PREWARM"] = "1"
        server.AGENT_BROWSER_BIN = "/nonexistent/agent-browser"
        assert server._browser_prewarm_enabled() is False
        # (c) coroutine is a clean no-op when gated off
        asyncio.run(server._prewarm_agent_browser())
        # (d) Test both real command paths at the subprocess boundary. This
        # works on Windows too, and asserts execution instead of merely
        # accepting the prewarmer's deliberately swallowed errors.
        server.AGENT_BROWSER_BIN = sys.executable
        server.BROWSER_PREWARM_DELAY_SECS = 0.0
        assert server._browser_prewarm_enabled() is True
        process = AsyncMock()
        process.returncode = 0
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as launch:
            asyncio.run(server._prewarm_agent_browser())
        assert [call.args for call in launch.await_args_list] == [
            (sys.executable, 'open', 'about:blank'),
            (sys.executable, 'close', '--all'),
        ]
        assert process.wait.await_count == 2
    finally:
        if old_env is None:
            os.environ.pop("SIDEKICK_BROWSER_PREWARM", None)
        else:
            os.environ["SIDEKICK_BROWSER_PREWARM"] = old_env
        server.AGENT_BROWSER_BIN = old_bin
        server.BROWSER_PREWARM_DELAY_SECS = old_delay
    print("OK prewarm: env gate + missing-binary tolerance + happy path (fake CLI) all clean")


async def _approval_card_survives_reconnect():
    # 2026-07-03 live incident: an approval card relayed while the app's SSE
    # was dropped vanished (queue-only), so the exec gate timed out silently
    # after 300s and the turn looked hung. Contract now: the card is persisted
    # on the record, exposed via GET, REPLAYED to a (re)connecting stream, and
    # cleared once the gate concludes (content flows or the turn ends).
    server._DELEGENT_STREAMS.clear()
    server._DELEGENT_RUNS.clear()
    async with _client() as c:
        run_id = "run_apprv1"
        card = {"run_id": run_id, "kind": "approval", "approval_id": "u1:7",
                "command": "pip install flask", "description": "install packages",
                "choices": ["once", "session", "always", "deny"]}
        # (1) card ingested while NO stream is open (the dropped-SSE case)
        r = await c.post("/v1/delegent/ingest", json=card, headers=AUTH)
        assert r.status_code == 204
        rec = server._DELEGENT_RUNS[run_id]
        assert rec["pending_approval"] and rec["pending_approval"]["approval_id"] == "u1:7", rec
        # (2) GET record exposes it for the Worker's reconcile path
        r = await c.get(f"/v1/delegent/runs/{run_id}")
        assert r.status_code == 200
        body = r.json()
        assert body["pending_approval"]["command"] == "pip install flask", body
        # (3) a NEW stream (the app reconnecting) gets the card REPLAYED first,
        #     then the live 'done' closes it.
        async def _late_done():
            await asyncio.sleep(0.15)
            await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "done", "final": True, "outcome": "success"},
                         headers=AUTH)
        done_task = asyncio.create_task(_late_done())
        events = await _drain_sse(c, run_id)
        await done_task
        kinds = [e["kind"] for e in events]
        assert kinds[0] == "approval", f"replayed card must lead the reconnect stream: {kinds}"
        assert events[0]["approval_id"] == "u1:7", events[0]
        assert kinds[-1] == "done", kinds
        # (4) done cleared the pending card (no stale replay for later streams)
        assert server._DELEGENT_RUNS[run_id]["pending_approval"] is None
        # (5) content flow also clears a pending card (gate concluded)
        run2 = "run_apprv2"
        await c.post("/v1/delegent/ingest", json={**card, "run_id": run2}, headers=AUTH)
        assert server._DELEGENT_RUNS[run2]["pending_approval"] is not None
        await c.post("/v1/delegent/ingest",
                     json={"run_id": run2, "kind": "edit", "text": "Installing now..."}, headers=AUTH)
        assert server._DELEGENT_RUNS[run2]["pending_approval"] is None
        server._DELEGENT_RUNS.clear()
        print("OK approval-durability: card persisted + replayed on reconnect + cleared on conclusion")


async def _clarify_question_survives_reconnect():
    # 2026-07-09 live incident: the clarify tool's question streamed as plain
    # text with no 'done', so the app composer stayed locked against the very
    # answer the agent was waiting for (three hung turns for one user; the
    # stale records were later mislabelled runner_restarted by the sweeper).
    # Contract now: the adapter relays a structured kind:'clarify' frame; it is
    # persisted on the record, exposed via GET (for the Worker's reconcile),
    # REPLAYED to a (re)connecting stream, and cleared once the turn
    # concludes or resumes. The Worker finalizes the turn with the question,
    # unlocking the composer — the user's typed answer resolves the clarify.
    server._DELEGENT_STREAMS.clear()
    server._DELEGENT_RUNS.clear()
    async with _client() as c:
        run_id = "run_clarify1"
        card = {
            "run_id": run_id, "kind": "clarify", "clarify_id": "clr9",
            "question": "Proceed with what you know?",
            "choices": ["Yes, proceed", "Wait for documents"],
            "text": ("❓ Proceed with what you know?\n\n  1. Yes, proceed\n"
                     "  2. Wait for documents\n\nReply with the number, the "
                     "option text, or your own answer."),
        }
        # (1) question ingested while NO stream is open (the dropped-SSE case)
        r = await c.post("/v1/delegent/ingest", json=card, headers=AUTH)
        assert r.status_code == 204
        rec = server._DELEGENT_RUNS[run_id]
        assert rec["pending_clarify"] and rec["pending_clarify"]["clarify_id"] == "clr9", rec
        assert rec["pending_clarify"]["choices"] == ["Yes, proceed", "Wait for documents"], rec
        # the question is NOT merged into the record text — the Worker's
        # translator appends it exactly once when finalizing, so a reconcile
        # (record text + question) never doubles it.
        assert rec["committed"] == "" and rec["segment"] == "", rec
        # (2) GET record exposes it for the Worker's reconcile path
        r = await c.get(f"/v1/delegent/runs/{run_id}")
        assert r.status_code == 200
        body = r.json()
        assert body["pending_clarify"]["question"] == "Proceed with what you know?", body
        # (3) a NEW stream (the app reconnecting) gets the question REPLAYED
        #     first, then the live 'done' closes it.
        async def _late_done():
            await asyncio.sleep(0.15)
            await c.post("/v1/delegent/ingest",
                         json={"run_id": run_id, "kind": "done", "final": True, "outcome": "success"},
                         headers=AUTH)
        done_task = asyncio.create_task(_late_done())
        events = await _drain_sse(c, run_id)
        await done_task
        kinds = [e["kind"] for e in events]
        assert kinds[0] == "clarify", f"replayed question must lead the reconnect stream: {kinds}"
        assert events[0]["clarify_id"] == "clr9", events[0]
        assert kinds[-1] == "done", kinds
        # (4) done cleared the pending question (no stale replay later)
        assert server._DELEGENT_RUNS[run_id]["pending_clarify"] is None
        # (5) content flowing again (the turn resumed: answered via the
        #     text-intercept, or the clarify timed out) also clears it
        run2 = "run_clarify2"
        await c.post("/v1/delegent/ingest", json={**card, "run_id": run2}, headers=AUTH)
        assert server._DELEGENT_RUNS[run2]["pending_clarify"] is not None
        await c.post("/v1/delegent/ingest",
                     json={"run_id": run2, "kind": "edit", "text": "Great, proceeding..."}, headers=AUTH)
        assert server._DELEGENT_RUNS[run2]["pending_clarify"] is None
        server._DELEGENT_RUNS.clear()
        print("OK clarify-durability: question persisted + replayed on reconnect + cleared on conclusion")


def main():
    test_registry_open_close()
    asyncio.run(_ingest_then_drain())
    asyncio.run(_idle_close())
    test_delegent_secret_plumbing()
    test_healthz_reflects_gateway_liveness()
    test_run_record_merge_semantics()
    asyncio.run(_record_survives_idle_close())
    asyncio.run(_keepalive_pings_only_while_busy())
    test_sleep_grace_keeps_an_idle_machine_awake_for_a_while()
    test_run_record_timing_marks()
    test_browser_prewarm_gating_and_happy_path()
    asyncio.run(_approval_card_survives_reconnect())
    asyncio.run(_clarify_question_survives_reconnect())
    print("\nALL DELEGENT BRIDGE CONTRACT TESTS PASSED")


if __name__ == "__main__":
    main()
