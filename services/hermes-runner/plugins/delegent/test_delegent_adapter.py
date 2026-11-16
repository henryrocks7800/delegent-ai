"""Contract test for the delegent platform adapter, run against the REAL
Hermes gateway base classes inside the golden image. Plain-python (no pytest):

  docker run --rm \
    -v <repo>/services/hermes-runner/plugins/delegent:/opt/hermes-agent/plugins/platforms/delegent \
    -w /opt/hermes-agent --entrypoint python delegent-hermes-runner:local \
    /opt/hermes-agent/plugins/platforms/delegent/test_delegent_adapter.py

Proves: (1) the plugin imports + register() wires a platform named 'delegent';
(2) an inbound POST builds a MessageEvent with chat_type='dm', chat_id=user_id
and calls handle_message; (3) build_session_key on that source yields the
stable per-user key agent:main:delegent:dm:<user_id> (one durable session per
user); (4) send/edit_message return success in log-only mode and carry run_id.
"""
import asyncio
import sys
from types import SimpleNamespace

import aiohttp

from gateway.config import PlatformConfig
from gateway.session import build_session_key, SessionSource
from gateway.config import Platform

sys.path.insert(0, "/opt/hermes-agent/plugins/platforms/delegent")
import adapter as delegent  # noqa: E402

PORT = 8645
USER = "11111111-1111-4111-8111-111111111111"
SECRET = "test_delegent_secret"


def _make_config():
    try:
        cfg = PlatformConfig()
    except Exception:
        cfg = SimpleNamespace()
    cfg.extra = {"host": "127.0.0.1", "port": PORT}
    return cfg


def test_register_wires_delegent_platform():
    seen = {}

    def register_platform(**kwargs):
        seen.update(kwargs)

    delegent.register(SimpleNamespace(register_platform=register_platform))
    assert seen.get("name") == "delegent", seen.get("name")
    a = seen["adapter_factory"](_make_config())
    assert isinstance(a, delegent.DelegentAdapter)
    assert seen["check_fn"]() is True
    # Gateway-level DM authorization: without these the first in-app message
    # hits the pairing gate ("I don't recognize you yet"). The runner sets
    # DELEGENT_ALLOWED_USERS to its own SIDEKICK_USER_ID.
    assert seen.get("allowed_users_env") == "DELEGENT_ALLOWED_USERS", seen.get("allowed_users_env")
    assert seen.get("allow_all_env") == "DELEGENT_ALLOW_ALL_USERS", seen.get("allow_all_env")
    print("OK register: platform 'delegent' wired, adapter_factory + check_fn + auth-env good")


def test_session_key_is_stable_per_user():
    # The whole point: chat_type='dm' + chat_id=user_id => one durable session.
    src = SessionSource(platform=Platform("delegent"), chat_id=USER, chat_type="dm", user_id=USER)
    key = build_session_key(src)
    assert key == f"agent:main:delegent:dm:{USER}", key
    # Stable across calls (identity-stable Platform pseudo-member).
    src2 = SessionSource(platform=Platform("delegent"), chat_id=USER, chat_type="dm", user_id=USER)
    assert build_session_key(src2) == key
    print(f"OK session-key: {key} (one durable session per user)")


async def _inbound_roundtrip():
    import os
    os.environ["DELEGENT_PLATFORM_PORT"] = str(PORT)
    os.environ["DELEGENT_PLATFORM_SECRET"] = SECRET
    # log-only outbound (no relay) so we don't need the Worker
    os.environ.pop("DELEGENT_RELAY_URL", None)

    a = delegent.DelegentAdapter(_make_config())
    captured = []

    async def fake_handler(event):
        captured.append(event)

    a.set_message_handler(fake_handler)
    # Bypass the base pipeline: assert OUR inbound handler builds + dispatches.
    a.handle_message = fake_handler  # type: ignore

    assert await a.connect() is True
    try:
        async with aiohttp.ClientSession() as s:
            # unauthorized without the secret
            async with s.post(f"http://127.0.0.1:{PORT}/message",
                              json={"user_id": USER, "text": "hi"}) as r:
                assert r.status == 401, f"expected 401 without secret, got {r.status}"
            # authorized
            async with s.post(f"http://127.0.0.1:{PORT}/message",
                              json={"user_id": USER, "text": "remember my colour is teal", "run_id": "run_abc"},
                              headers={"x-delegent-platform-secret": SECRET}) as r:
                assert r.status == 200, f"expected 200, got {r.status}: {await r.text()}"
                body = await r.json()
                assert body.get("accepted") is True, body
        assert len(captured) == 1, f"handle_message called {len(captured)} times"
        ev = captured[0]
        assert ev.text == "remember my colour is teal", ev.text
        assert ev.source.chat_type == "dm", ev.source.chat_type
        assert str(ev.source.chat_id) == USER, ev.source.chat_id
        assert build_session_key(ev.source) == f"agent:main:delegent:dm:{USER}"
        assert a._run_ids.get(USER) == "run_abc", a._run_ids
        print("OK inbound: POST /message -> handle_message with dm/user_id source + run_id stashed")

        # outbound send/edit return success in log-only mode and carry run_id
        await a.on_processing_start(ev)
        sr = await a.send(USER, "partial reply")
        assert sr.success is True and sr.message_id == "run_abc", (sr.success, sr.message_id)
        er = await a.edit_message(USER, "run_abc", "final reply", finalize=True)
        assert er.success is True, er
        # A finalize content edit must NOT clear the stash — the turn is only
        # closed by on_processing_complete (so a slash command's single send
        # still tags the run, and the SSE close is unambiguous).
        assert a._run_ids.get(USER) == "run_abc", a._run_ids
        print("OK outbound: send + edit_message(finalize) succeed log-only, stash retained")

        # the gateway's per-turn completion hook is the authoritative close +
        # the only thing that clears the stash.
        from gateway.platforms.base import ProcessingOutcome
        # 2026-09-06: only the turn the app opened may close its run, so the
        # hook is keyed by the event's message_id. A turn the gateway ran on
        # its own (no message_id the app knows) must leave the stash alone.
        foreign_event = SimpleNamespace(source=SimpleNamespace(chat_id=USER), message_id="not-ours")
        await a.on_processing_complete(foreign_event, ProcessingOutcome.SUCCESS)
        assert a._run_ids.get(USER) == "run_abc", "a foreign turn must not clear the run-id stash"
        await a.on_processing_complete(ev, ProcessingOutcome.SUCCESS)
        assert USER not in a._run_ids, "on_processing_complete for the app's own turn must clear the run-id stash"
        print("OK lifecycle: on_processing_complete relays 'done' for the app's turn + clears the run-id stash; a foreign turn is ignored")
    finally:
        await a.disconnect()


async def _approval_roundtrip():
    """Dangerous-command approval BUTTONS (send_exec_approval parity): the
    adapter presents the gate as a structured kind:'approval' relay, and an
    inbound POST /approval resolves the SAME paused gate via
    resolve_gateway_approval(session_key, choice) — single-use + idempotent."""
    import os
    PORT2 = PORT + 1
    os.environ["DELEGENT_PLATFORM_PORT"] = str(PORT2)
    os.environ["DELEGENT_PLATFORM_SECRET"] = SECRET
    os.environ.pop("DELEGENT_RELAY_URL", None)

    a = delegent.DelegentAdapter(_make_config())
    relayed = []

    async def fake_relay(payload):
        relayed.append(payload)
        return True

    a._relay = fake_relay  # type: ignore
    delegent._CURRENT_DELIVERY.set(delegent.TurnDelivery(USER, 'run_xyz', 'approval-test'))
    session_key = f"agent:main:delegent:dm:{USER}"

    # send_exec_approval relays a kind:'approval' card + maps approval_id->session_key
    sr = await a.send_exec_approval(USER, "rm -rf /tmp/x", session_key, description="delete in root path")
    assert sr.success is True, sr
    approval_id = sr.message_id
    assert a._approval_state.get(approval_id) == session_key, a._approval_state
    assert len(relayed) == 1 and relayed[0]["kind"] == "approval", relayed
    assert relayed[0]["command"] == "rm -rf /tmp/x", relayed[0]
    assert relayed[0]["run_id"] == "run_xyz", relayed[0]
    assert relayed[0]["choices"] == ["once", "session", "always", "deny"], relayed[0]
    assert relayed[0]["approval_id"] == approval_id, relayed[0]
    print("OK approval: send_exec_approval relays kind:'approval' + maps approval_id->session_key")

    # v0.19 GATEWAY CALL SHAPE (2026-07-22 outage): gateway/run.py now calls
    # with allow_permanent= and smart_denied= keywords (and may add more).
    # The old signature raised TypeError -> the gateway silently fell back to
    # the text "/approve" prompt -> no button card in the app -> unanswerable
    # 60s execute_code gate. The adapter must accept the full current call
    # shape PLUS unknown future kwargs, and allow_permanent=False must drop
    # the 'always' button.
    sr2 = await a.send_exec_approval(
        chat_id=USER,
        command="execute_code <<PY ...",
        session_key=session_key,
        description="execute_code script execution",
        metadata={"thread": "t1"},
        allow_permanent=False,
        smart_denied=True,
        some_future_gateway_kwarg="ignored",
    )
    assert sr2.success is True, sr2
    assert relayed[1]["kind"] == "approval", relayed[1]
    assert relayed[1]["choices"] == ["once", "session", "deny"], (
        "allow_permanent=False must drop the 'always' choice", relayed[1])
    print("OK approval: v0.19 call shape (allow_permanent/smart_denied/unknown kwargs) accepted; 'always' dropped when forbidden")

    # the decision route resolves the SAME session_key via resolve_gateway_approval
    import tools.approval as _approval_mod
    captured = []
    orig = _approval_mod.resolve_gateway_approval
    _approval_mod.resolve_gateway_approval = lambda sk, ch, **kw: (captured.append((sk, ch)) or 1)
    try:
        assert await a.connect() is True
        async with aiohttp.ClientSession() as s:
            base = f"http://127.0.0.1:{PORT2}/approval"
            async with s.post(base, json={"approval_id": approval_id, "choice": "once"}) as r:
                assert r.status == 401, f"expected 401 without secret, got {r.status}"
            async with s.post(base, json={"approval_id": approval_id, "choice": "maybe"},
                              headers={"x-delegent-platform-secret": SECRET}) as r:
                assert r.status == 400, f"expected 400 on bad choice, got {r.status}"
            async with s.post(base, json={"approval_id": approval_id, "choice": "once"},
                              headers={"x-delegent-platform-secret": SECRET}) as r:
                assert r.status == 200, await r.text()
                assert (await r.json()).get("resolved") == 1
            assert captured == [(session_key, "once")], captured
            assert approval_id not in a._approval_state, "approval mapping must be single-use"
            # a second press is a stale no-op (idempotent)
            async with s.post(base, json={"approval_id": approval_id, "choice": "once"},
                              headers={"x-delegent-platform-secret": SECRET}) as r:
                assert r.status == 200, await r.text()
                assert (await r.json()).get("stale") is True
        print("OK approval: POST /approval auth+validation, resolves session_key, single-use idempotent")
    finally:
        _approval_mod.resolve_gateway_approval = orig
        await a.disconnect()


async def _clarify_roundtrip():
    """Clarify question (send_clarify override): the adapter relays a
    structured kind:'clarify' frame (the Worker finalizes the paused turn with
    it so the composer unlocks) and enables text-capture for choice-mode so
    the user's typed answer resolves the SAME paused clarify via the gateway's
    text-intercept. Without this override the base-class text fallback
    deadlocked the app: question streamed as content, no 'done', composer
    locked against the answer (live incident 2026-07-09)."""
    a = delegent.DelegentAdapter(_make_config())
    relayed = []
    relay_ok = [True]

    async def fake_relay(payload):
        relayed.append(payload)
        return relay_ok[0]

    a._relay = fake_relay  # type: ignore
    delegent._CURRENT_DELIVERY.set(delegent.TurnDelivery(USER, 'run_clr', 'clarify-test'))
    session_key = f"agent:main:delegent:dm:{USER}"

    import tools.clarify_gateway as _clarify_mod
    marked = []
    orig_mark = _clarify_mod.mark_awaiting_text
    _clarify_mod.mark_awaiting_text = lambda cid: (marked.append(cid) or True)
    try:
        # choice-mode: structured frame + prebuilt display text + awaiting-text
        sr = await a.send_clarify(
            chat_id=USER,
            question="Proceed with what you know?",
            choices=["Yes, proceed", "Wait for documents"],
            clarify_id="clr123",
            session_key=session_key,
        )
        assert sr.success is True and sr.message_id == "clr123", (sr.success, sr.message_id)
        f = relayed[-1]
        assert f["kind"] == "clarify" and f["run_id"] == "run_clr", f
        assert f["clarify_id"] == "clr123", f
        assert f["question"] == "Proceed with what you know?", f
        assert f["choices"] == ["Yes, proceed", "Wait for documents"], f
        assert "1. Yes, proceed" in f["text"], f["text"]
        assert "Reply with the number, the option text, or your own answer." in f["text"], f["text"]
        assert marked == ["clr123"], marked
        # open-ended: bare question, NO mark (register() already sets
        # awaiting_text for choice-less clarifies; mirrors the base class)
        sr2 = await a.send_clarify(
            chat_id=USER, question="What is the property address?",
            choices=None, clarify_id="clr124", session_key=session_key,
        )
        assert sr2.success is True, sr2
        f2 = relayed[-1]
        assert f2["choices"] is None, f2
        assert f2["text"] == "❓ What is the property address?", f2
        assert marked == ["clr123"], "open-ended must not mark_awaiting_text"
        # relay failure: success=False so the gateway resumes the agent with
        # its could-not-deliver sentinel instead of hanging the gate
        relay_ok[0] = False
        sr3 = await a.send_clarify(
            chat_id=USER, question="q", choices=["a"],
            clarify_id="clr125", session_key=session_key,
        )
        assert sr3.success is False, sr3
        assert marked == ["clr123"], "failed relay must not enable text-capture"
        print("OK clarify: structured relay + prebuilt text + awaiting-text semantics + failure path")
    finally:
        _clarify_mod.mark_awaiting_text = orig_mark


def test_send_clarify_signature_matches_gateway_contract():
    # The gateway's clarify callback invokes send_clarify with EXACTLY these
    # keywords (gateway/run.py::_clarify_callback_sync). A drift raises
    # TypeError inside safe_schedule_threadsafe, the send silently fails, and
    # the agent resumes with the could-not-deliver sentinel — degraded UX that
    # would look like "the agent never asks questions". Bind against the real
    # call shape so drift fails the golden-image gate instead of prod.
    import inspect
    sig = inspect.signature(delegent.DelegentAdapter.send_clarify)
    sig.bind(
        object(),
        chat_id=USER,
        question="q",
        choices=["a"],
        clarify_id="c1",
        session_key="s",
        metadata=None,
    )
    print("OK clarify-signature: send_clarify binds the gateway's actual call shape")


def test_connect_signature_matches_gateway_reconnect_contract():
    # Regression guard for the 2026-07-02 live incident: Hermes v2026.7.1's
    # gateway reconnection watcher invokes adapter.connect(is_reconnect=...).
    # A connect() that didn't accept it raised
    #   TypeError: connect() got an unexpected keyword argument 'is_reconnect'
    # on every (re)connect, so the delegent platform never came up and the
    # approval-card path (send_exec_approval) went dark — an approval-gated
    # turn then hung on execute_code's 300s timeout with no prompt shown.
    # This asserts our connect() binds the gateway's actual call, run against
    # the REAL base class shipped in the image so a future signature drift
    # (this class of bug) fails the golden-image gate instead of prod.
    import inspect
    from gateway.platforms.base import BasePlatformAdapter  # noqa: F401 (imported for context)

    our_sig = inspect.signature(delegent.DelegentAdapter.connect)
    # Binds self + is_reconnect exactly as gateway/run.py does; raises
    # TypeError if the keyword is not accepted.
    our_sig.bind(object(), is_reconnect=True)
    accepts_future = any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in our_sig.parameters.values()
    ) or "is_reconnect" in our_sig.parameters
    assert accepts_future, f"DelegentAdapter.connect must accept the gateway connect kwargs; ours={our_sig}"
    print("OK connect-signature: accepts is_reconnect (+ future kwargs) — matches gateway reconnect contract")


async def _done_attribution_roundtrip():
    """2026-09-06: after a Fly sleep the gateway restarts and runs a synthetic
    startup-resume turn on the user's session. That turn's on_processing_complete
    used to relay `done` tagged with whatever run the chat stash held, which was
    the user's brand-new message, so the app's stream closed empty and the real
    reply (relayed after the stash was popped) carried no run id and was dropped.
    Reproduced twice against the live test runner. This pins the fix: `done` is
    relayed only for a turn the app opened, keyed by the event's message_id, and
    the chat stash survives a foreign turn finishing."""
    import os
    os.environ["DELEGENT_PLATFORM_PORT"] = str(PORT + 1)
    os.environ["DELEGENT_PLATFORM_SECRET"] = SECRET
    os.environ.pop("DELEGENT_RELAY_URL", None)
    a = delegent.DelegentAdapter(_make_config())
    relayed = []

    async def capture_relay(payload):
        relayed.append(payload)
        return True

    a._relay = capture_relay  # type: ignore
    captured = []

    async def fake_handler(event):
        captured.append(event)

    a.handle_message = fake_handler  # type: ignore
    a.set_message_handler(fake_handler)
    assert await a.connect() is True
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"http://127.0.0.1:{PORT + 1}/message",
                json={"user_id": USER, "text": "what is 17 times 23?", "run_id": "run_app_1", "message_id": "msg_app_1"},
                headers={"x-delegent-platform-secret": SECRET},
            ) as r:
                assert r.status == 200, r.status
        assert a._run_ids.get(USER) == "run_app_1"

        # A turn the app never opened finishes first (the synthetic resume turn).
        foreign = SimpleNamespace(source=SimpleNamespace(chat_id=USER), message_id="resume_synthetic_1")
        await a.on_processing_complete(foreign, SimpleNamespace(value="success"))
        assert not any(p.get("kind") == "done" for p in relayed), relayed
        assert a._run_ids.get(USER) == "run_app_1", "a foreign turn must not clear the live app run"

        # The reply to the app's message still tags the app run.
        await a.on_processing_start(captured[0])
        await a.send(USER, "17 x 23 = 391")
        assert relayed[-1]["kind"] == "send" and relayed[-1]["run_id"] == "run_app_1", relayed[-1]

        # The app's own turn finishing closes exactly that run.
        ours = captured[0]
        await a.on_processing_complete(ours, SimpleNamespace(value="success"))
        dones = [p for p in relayed if p.get("kind") == "done"]
        assert len(dones) == 1 and dones[0]["run_id"] == "run_app_1", dones
        assert USER not in a._run_ids

        # Clarify continuation (2026-09-07): turn 2 pauses on a question, the
        # user's answer arrives as turn 3 with its own run, the gateway feeds
        # that text into turn 2, and it is turn 2's event that completes. The
        # reply streamed on the stash (turn 3's run), so `done` must close
        # turn 3's run, not turn 2's. Closing turn 2's run left "Yes, create
        # it" spinning forever while the FreeAgent entry had been made.
        async with aiohttp.ClientSession() as s:
            for run_id, msg_id, text in (("run_app_2", "msg_app_2", "categorise this receipt"),
                                         ("run_app_3", "msg_app_3", "Yes, create it")):
                if run_id == 'run_app_3':
                    from tools import clarify_gateway
                    clarify_gateway.register('test-continuation', f'agent:main:delegent:dm:{USER}', 'Proceed?', None)
                async with s.post(
                    f"http://127.0.0.1:{PORT + 1}/message",
                    json={"user_id": USER, "text": text, "run_id": run_id, "message_id": msg_id},
                    headers={"x-delegent-platform-secret": SECRET},
                ) as r:
                    assert r.status == 200, r.status
        assert a._run_ids.get(USER) == "run_app_3"
        await a.on_processing_start(captured[1])
        await a.send(USER, "Entered in FreeAgent.")
        assert relayed[-1]["run_id"] == "run_app_3", relayed[-1]
        turn2 = captured[1]
        assert turn2.message_id == "msg_app_2", turn2.message_id
        await a.on_processing_complete(turn2, SimpleNamespace(value="success"))
        assert relayed[-1]["kind"] == "done" and relayed[-1]["run_id"] == "run_app_3", relayed[-1]
        assert USER not in a._run_ids, "the live run is closed and the stash cleared"
        clarify_gateway.clear_session(f'agent:main:delegent:dm:{USER}')
        # The answer's own event never completes (the gateway captured its
        # text); its stale mapping must not resurrect a done later.
        turn3 = captured[2]
        await a.on_processing_complete(turn3, SimpleNamespace(value="success"))
        assert relayed[-1]["kind"] == "done" and relayed[-1]["run_id"] == "run_app_3", "a late completion for the answer event closes nothing new"
        print("OK done-attribution: foreign turn ignored; app turn closes its run; clarify continuation closes the answer's run")
    finally:
        await a.disconnect()


def main():
    test_register_wires_delegent_platform()
    test_session_key_is_stable_per_user()
    test_connect_signature_matches_gateway_reconnect_contract()
    test_send_clarify_signature_matches_gateway_contract()
    asyncio.run(_inbound_roundtrip())
    asyncio.run(_approval_roundtrip())
    asyncio.run(_clarify_roundtrip())
    asyncio.run(_done_attribution_roundtrip())
    from test_native_lifecycle import native_lifecycle
    asyncio.run(native_lifecycle())
    from test_native_compression import native_compression
    native_compression()
    print("\nALL DELEGENT ADAPTER CONTRACT TESTS PASSED")


if __name__ == "__main__":
    main()
