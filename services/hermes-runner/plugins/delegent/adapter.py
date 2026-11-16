"""
Delegent platform adapter for the Hermes gateway.

This makes the Delegent AI app a first-class Hermes "messenger" (like Telegram
or Slack), so in-app chat routes through the gateway's `handle_message`
pipeline and inherits, natively and for free:

  * ONE durable session per user (volume-backed state.db, resumed every turn) —
    real memory over weeks/months, not a 20-row reconstruction;
  * the gateway slash-command engine (/new, /stop, /model, ...) and durable
    /goal (judge + continuation);
  * `session_search` over all past conversations + the `memory` tool.

It is essentially "the api_server platform, but it calls `handle_message()`
(through the pipeline) instead of running the agent directly" — which is the
whole reason the app gets no sessions/commands today (see
docs/CHAT_ROUTE_B_DESIGN.md).

Topology (the gateway runs as a subprocess of the runner's FastAPI wrapper):

  Worker --HMAC--> runner wrapper (server.py)  --loopback HTTP-->  THIS adapter
                                                                      |
                                                  build_source(dm, chat_id=user_id)
                                                                      |
                                                            handle_message(event)
                                                                      v
                                                       Hermes gateway pipeline
                                                                      |
        Worker SSE  <--HTTP relay-- adapter.send/edit_message <-- StreamConsumer

Inbound: POST http://127.0.0.1:<DELEGENT_PLATFORM_PORT>/message
         { user_id, text, run_id?, message_id?, agent_name? }
Outbound: POST <DELEGENT_RELAY_URL> (the runner wrapper's loopback ingest, which
         queues per run_id and the Worker drains over SSE)
         { kind: 'send'|'edit'|'typing'|'done', user_id, run_id, text, final }.
         The turn-close signal is `kind:'done'` (relayed from the gateway's
         on_processing_complete hook), NOT the `final` flag on a content edit —
         content `final:true` just marks the cursor-stripped last edit. Bypass
         slash commands (/new, /stop, ...) skip that hook, so the wrapper closes
         their stream on an idle timeout instead.
         When DELEGENT_RELAY_URL is unset (e.g. the local boot proof) outbound
         is logged only, so the pipeline + session store can be validated
         without the Worker.

Stable session key: build_source(chat_type='dm', chat_id=<user_id>) yields
`agent:main:delegent:dm:<user_id>` — one durable session per user, forever.
"""

import asyncio
import datetime as _dt
import hmac
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
import json
import logging
import os
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("gateway.platforms.delegent")

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
)
from gateway.config import Platform

# aiohttp ships with Hermes' gateway (the api_server platform uses it), so it is
# always available in the runtime image.
from aiohttp import web
import aiohttp

_DEFAULT_PORT = 8644


@dataclass
class TurnDelivery:
    chat_id: str
    run_id: str
    message_id: str
    done: bool = False
    control: bool = False


_CURRENT_DELIVERY: ContextVar[Optional[TurnDelivery]] = ContextVar('delegent_delivery', default=None)


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


class DelegentAdapter(BasePlatformAdapter):
    """Inbound HTTP listener + outbound HTTP relay, routed through the gateway
    pipeline so in-app chat gets durable sessions, commands, and /goal."""

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("delegent"))
        extra = getattr(config, "extra", {}) or {}

        self.host = os.getenv("DELEGENT_PLATFORM_HOST") or extra.get("host", "127.0.0.1")
        self.port = int(os.getenv("DELEGENT_PLATFORM_PORT") or extra.get("port", _DEFAULT_PORT))
        # Where replies go. The runner wrapper exposes this; it forwards to the
        # Worker, which relays to the app over SSE. Unset => log-only (boot proof).
        self.relay_url = (os.getenv("DELEGENT_RELAY_URL") or extra.get("relay_url", "")).strip()
        # Shared secret for BOTH the inbound listener (the wrapper signs) and the
        # outbound relay (we sign). Reuses the runner shared secret by default.
        self.shared_secret = (
            os.getenv("DELEGENT_PLATFORM_SECRET")
            or os.getenv("SIDEKICK_RUNNER_SHARED_SECRET")
            or ""
        ).strip()

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._client: Optional[aiohttp.ClientSession] = None
        # Per-user (chat_id) run-id stash so outbound send/edit can tag which
        # app run/SSE stream a reply belongs to. The gateway serialises turns
        # per session, so there is at most one in-flight run per user.
        self._run_ids: Dict[str, str] = {}
        self._turns: Dict[str, TurnDelivery] = {}
        self._active_turns: Dict[str, TurnDelivery] = {}
        self._control_locks: Dict[str, asyncio.Lock] = {}
        # message_id -> run_id for every turn the APP opened. on_processing_complete
        # relays `done` only for a turn found here, and pops the chat stash only
        # when it still points at that run. The gateway also runs turns of its
        # own on the same session (a synthetic startup-resume turn after a
        # restart, a replayed obligation), and those used to fire this hook with
        # OUR stash: the first message after a Fly sleep got its SSE closed empty
        # about a second in, then its real reply relayed with no run id and was
        # dropped (2026-09-06 21:37 and 21:41 UTC, reproduced twice).
        self._run_by_message: "OrderedDict[str, str]" = OrderedDict()
        self._run_by_message_max = 256
        # Dangerous-command approval correlation: approval_id -> session_key.
        # Mirrors Telegram's self._approval_state. The gateway resolves on the
        # session_key; the approval_id is our local lookup so an inbound button
        # press can recover the right paused gate. Single-use (popped on resolve).
        self._approval_state: Dict[str, str] = {}
        self._approval_seq = 0

    @property
    def name(self) -> str:
        return "Delegent"

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def connect(self, *, is_reconnect: bool = False, **_kwargs: Any) -> bool:
        """Start the loopback inbound listener. No external connection.

        Signature must stay compatible with BasePlatformAdapter.connect(), which
        as of Hermes v2026.7.1 is `connect(self, *, is_reconnect: bool = False)`
        and is invoked by the gateway's reconnection watcher as
        `adapter.connect(is_reconnect=...)`. A narrower signature here raised
        `TypeError: connect() got an unexpected keyword argument 'is_reconnect'`
        on every (re)connect, so the delegent platform never came up and the
        approval-card path (send_exec_approval) went dark — an approval-gated
        turn then hung on execute_code's 300s timeout with no prompt shown.
        `**_kwargs` tolerates any further keyword the gateway may add later.
        """
        # On a reconnect our previous TCP listener is still bound to the loopback
        # port; tear it down first so the re-bind below can't hit EADDRINUSE.
        if is_reconnect and self._running:
            await self.disconnect()
        # The relay POSTs to the wrapper's OWN loopback ingest (sub-millisecond
        # in the happy path), but a long turn's final relay can land while the
        # wrapper event loop is briefly busy draining a slow tool's output; a
        # tight total timeout then surfaced as "delegent relay failed:
        # TimeoutError" and dropped the reply on a ~34s session_search turn
        # (found live 2026-06-11). Per-request short connect, generous total.
        self._client = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=120, connect=5, sock_read=120),
        )
        self._app = web.Application()
        self._app.router.add_post("/message", self._handle_inbound)
        self._app.router.add_post("/control", self._handle_control)
        self._app.router.add_post("/approval", self._handle_approval_decision)
        self._app.router.add_get("/healthz", self._handle_health)
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host=self.host, port=self.port)
        await self._site.start()
        self._running = True
        logger.info("delegent platform listening on http://%s:%s/message (relay=%s)",
                    self.host, self.port, "set" if self.relay_url else "log-only")
        return True

    async def disconnect(self) -> None:
        self._running = False
        try:
            if self._site is not None:
                await self._site.stop()
            if self._runner is not None:
                await self._runner.cleanup()
        finally:
            if self._client is not None and not self._client.closed:
                await self._client.close()

    # ── Inbound (user message -> gateway pipeline) ────────────────────────

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "platform": "delegent", "running": self._running})

    async def _handle_inbound(self, request: web.Request) -> web.Response:
        if self.shared_secret:
            supplied = request.headers.get("x-delegent-platform-secret", "")
            if not hmac.compare_digest(supplied, self.shared_secret):
                return web.json_response({"error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "invalid_json"}, status=400)

        user_id = str(body.get("user_id") or "").strip()
        text = body.get("text")
        if not user_id or not isinstance(text, str) or not text.strip():
            return web.json_response({"error": "user_id_and_text_required"}, status=400)
        if self._message_handler is None:
            return web.json_response({"error": "gateway_not_ready"}, status=503)

        run_id = str(body.get("run_id") or "").strip()
        message_id = str(body.get("message_id") or int(time.time() * 1000))
        # chat_type='dm' + chat_id=user_id => stable per-user durable session.
        source = self.build_source(
            chat_id=user_id,
            chat_name=user_id,
            chat_type="dm",
            user_id=user_id,
            user_name=str(body.get("user_name") or "User"),
            message_id=message_id,
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=message_id,
            timestamp=_dt.datetime.now(),
        )
        if self._control_locks.get(user_id, asyncio.Lock()).locked():
            return web.json_response({'error': 'session_control_in_progress'}, status=409)
        from gateway.session import build_session_key
        from hermes_cli.commands import should_bypass_active_session
        active = self._active_turns.get(user_id)
        continuation = False
        if active and not active.done and not event.get_command():
            from tools import clarify_gateway
            continuation = clarify_gateway.get_pending_for_session(
                build_session_key(source), include_choice_prompts=True,
            ) is not None
        bypass = should_bypass_active_session(event.get_command())
        inline = bool(active and not active.done and bypass)
        if active and not active.done and not continuation and not bypass:
            return web.json_response({'error': 'run_in_progress'}, status=409)
        if continuation:
            # Only the native clarify gate can transfer delivery to an answer.
            # All callbacks inherited the same mutable turn object.
            delivery = active
            await self._relay({'kind': 'done', 'user_id': user_id,
                               'run_id': delivery.run_id, 'outcome': 'success', 'final': True})
            delivery.run_id = run_id
        else:
            delivery = TurnDelivery(user_id, run_id, message_id)
            if not inline:
                self._active_turns[user_id] = delivery
        if run_id:
            self._turns[message_id] = delivery
            self._run_by_message[message_id] = run_id
            if not inline or continuation:
                self._run_ids[user_id] = run_id
        # handle_message spawns the per-session background task and returns; the
        # reply streams back out via send/edit_message. We ack acceptance now.
        token = _CURRENT_DELIVERY.set(delivery)
        try:
            await self.handle_message(event)
        except Exception:
            await self._finish_delivery(delivery, 'failure')
            raise
        finally:
            _CURRENT_DELIVERY.reset(token)
        if inline and not continuation:
            await self._finish_delivery(delivery, 'success')
        return web.json_response({"accepted": True, "run_id": run_id or None})

    def _delivery_run_id(self, chat_id: str) -> str:
        delivery = _CURRENT_DELIVERY.get()
        if delivery and delivery.chat_id == chat_id and not delivery.done and not delivery.control:
            return delivery.run_id
        return ''

    async def on_processing_start(self, event: MessageEvent) -> None:
        # Native synthetic/startup work must not borrow a user's current run.
        _CURRENT_DELIVERY.set(self._turns.get(str(event.message_id or '')))

    async def _finish_delivery(self, delivery: TurnDelivery, outcome: str) -> None:
        if delivery.done:
            return
        delivery.done = True
        if delivery.run_id and not delivery.control:
            await self._relay({'kind': 'done', 'user_id': delivery.chat_id,
                               'run_id': delivery.run_id, 'outcome': outcome, 'final': True})
        if self._active_turns.get(delivery.chat_id) is delivery:
            self._active_turns.pop(delivery.chat_id, None)
            self._run_ids.pop(delivery.chat_id, None)
        for message_id, existing in list(self._turns.items()):
            if existing is delivery:
                self._turns.pop(message_id, None)
                self._run_by_message.pop(message_id, None)

    async def _handle_control(self, request: web.Request) -> web.Response:
        if not self.shared_secret or not hmac.compare_digest(
                request.headers.get('x-delegent-platform-secret', ''), self.shared_secret):
            return web.json_response({'error': 'unauthorized'}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({'error': 'invalid_json'}, status=400)
        if not isinstance(body, dict) or body.get('action') not in ('stop', 'reset') or not body.get('user_id'):
            return web.json_response({'error': 'invalid_control'}, status=400)
        user_id, action = str(body['user_id']), body['action']
        if action == 'reset' and body.get('confirmed') is not True:
            return web.json_response({'error': 'confirmation_required'}, status=409)
        runner = getattr(self._message_handler, '__self__', None)
        if runner is None or not hasattr(runner, 'session_store'):
            return web.json_response({'error': 'control_unavailable'}, status=503)
        lock = self._control_locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            active = self._active_turns.get(user_id)
            if action == 'stop' and (not active or active.run_id != body.get('run_id')):
                return web.json_response({'error': 'run_not_active'}, status=409)
            source = self.build_source(chat_id=user_id, chat_type='dm', user_id=user_id,
                                       message_id='control-' + str(time.time_ns()))
            event = MessageEvent(text='/stop' if action == 'stop' else '/new',
                                 message_type=MessageType.TEXT, source=source, message_id=source.message_id)
            key = runner._session_key_for_source(source)
            before = await asyncio.to_thread(runner.session_store.peek_session_id, key)
            token = _CURRENT_DELIVERY.set(TurnDelivery(user_id, '', str(event.message_id), control=True))
            try:
                # Use the native lifecycle operation and native confirmation
                # registry. Approval applies to this explicit reset only.
                await self._message_handler(event)
                if action == 'reset':
                    from tools import slash_confirm
                    pending = slash_confirm.get_pending(key)
                    if pending and pending.get('command') in ('new', 'reset'):
                        await slash_confirm.resolve(key, pending.get('confirm_id'), 'once')
                await self.cancel_session_processing(key)
                after = await asyncio.to_thread(runner.session_store.peek_session_id, key)
                if action == 'reset' and (not after or after == before):
                    return web.json_response({'error': 'reset_not_completed'}, status=503)
                if active:
                    await self._finish_delivery(active, 'cancelled')
                return web.json_response({'ok': True, 'action': action, 'session_id': after})
            except Exception:
                logger.exception('delegent native session control failed')
                return web.json_response({'error': 'control_failed'}, status=503)
            finally:
                _CURRENT_DELIVERY.reset(token)

    async def _handle_approval_decision(self, request: web.Request) -> web.Response:
        """Inbound decision for a dangerous-command approval card. The app's
        Approve/Deny button press arrives here (Worker --HMAC--> wrapper
        --loopback--> this route) and resolves the SAME paused gate that
        send_exec_approval presented, via resolve_gateway_approval(session_key,
        choice) — the exact resolve the Telegram callback uses. Single-use and
        idempotent: a second press (or one after the gate timed out / was typed)
        finds no mapping and is a no-op."""
        if self.shared_secret:
            supplied = request.headers.get("x-delegent-platform-secret", "")
            if not hmac.compare_digest(supplied, self.shared_secret):
                return web.json_response({"error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "invalid_json"}, status=400)

        approval_id = str(body.get("approval_id") or "").strip()
        choice = str(body.get("choice") or "").strip().lower()
        if choice not in ("once", "session", "always", "deny"):
            return web.json_response({"error": "bad_choice"}, status=400)

        session_key = self._approval_state.pop(approval_id, None)
        if not session_key:
            # Unknown/already-resolved (second tap, timeout, or typed /approve).
            return web.json_response({"resolved": 0, "stale": True})

        try:
            # Imported here (like Telegram's callback) so the adapter stays
            # importable even if the symbol moves between Hermes versions.
            from tools.approval import resolve_gateway_approval
            count = int(resolve_gateway_approval(session_key, choice))
        except Exception as exc:  # noqa: BLE001 — never 500 the gate into a hang
            logger.warning("delegent approval resolve failed: %s", type(exc).__name__)
            return web.json_response({"error": "resolve_failed"}, status=500)

        # The gate paused typing while waiting; resume it (Telegram does the same
        # on its ea: callback) so the post-approval reply streams cleanly.
        user_id = approval_id.split(":", 1)[0]
        try:
            self.resume_typing_for_chat(user_id)
        except Exception:  # noqa: BLE001
            pass
        return web.json_response({"resolved": count})

    # ── Outbound (agent reply -> Worker relay -> app SSE) ─────────────────

    async def _relay(self, payload: Dict[str, Any]) -> bool:
        if not self.relay_url:
            logger.info("[delegent log-only] %s", json.dumps(payload)[:500])
            return True
        if self._client is None or self._client.closed:
            return False
        headers = {"content-type": "application/json"}
        if self.shared_secret:
            headers["x-delegent-platform-secret"] = self.shared_secret
        try:
            async with self._client.post(self.relay_url, json=payload, headers=headers) as resp:
                return resp.status < 400
        except Exception as exc:  # noqa: BLE001 — relay must never crash a turn
            logger.warning("delegent relay failed: %s", type(exc).__name__)
            return False

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        run_id = self._delivery_run_id(chat_id)
        if not run_id:
            return SendResult(success=True, message_id=chat_id)
        ok = await self._relay({
            "kind": "send",
            "user_id": chat_id,
            "run_id": run_id,
            "text": content,
        })
        # message_id is echoed back to us on subsequent edit_message calls; use
        # the run_id (stable for the turn) so the Worker can correlate edits.
        return SendResult(success=ok, message_id=run_id or chat_id)

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        # NB: a content edit — even finalize=True — is NOT the stream-close
        # signal and must NOT clear the run-id stash. `finalize` here only
        # means "this is the cursor-stripped last content edit"; the turn is
        # closed authoritatively by on_processing_complete -> kind:'done'. The
        # stash stays live so a slash command's single send still tags run_id.
        ok = await self._relay({
            "kind": "edit",
            "user_id": chat_id,
            "run_id": self._delivery_run_id(chat_id),
            "text": content,
            "final": bool(finalize),
        })
        return SendResult(success=ok, message_id=message_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        await self._relay({"kind": "typing", "user_id": chat_id, "run_id": self._delivery_run_id(chat_id)})

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm", "chat_id": chat_id}

    # ── Dangerous-command approval (the Telegram-parity button flow) ──────

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str,
        session_key: str,
        description: str = "dangerous command",
        metadata: Optional[Dict[str, Any]] = None,
        allow_permanent: bool = True,
        smart_denied: bool = False,
        **_future_kwargs: Any,
    ) -> "SendResult":
        """Hermes' dangerous-command gate calls this (duck-typed: the gateway
        does `getattr(type(adapter), "send_exec_approval", None)`) when an
        adapter can present an interactive approval, INSTEAD of streaming the
        plain "Reply /approve or /deny" text. We relay a structured
        `kind:'approval'` so the app paints Approve / Session / Always / Decline
        buttons; the press returns to POST /approval and resolves the SAME paused
        gate via resolve_gateway_approval(session_key, choice). Mirrors
        gateway/platforms/telegram.py::send_exec_approval (which renders an
        inline keyboard with `ea:<choice>:<id>` callbacks).

        The gateway awaits this send with a short timeout and falls back to the
        text prompt if it returns success=False or raises — so a relay failure
        degrades gracefully to today's behaviour and never hangs the gate.

        SIGNATURE CONTRACT (2026-07-22, the v0.19 button-card outage): the
        gateway's call shape GROWS across Hermes versions — v0.19 added
        allow_permanent= and smart_denied= keywords, and passing them into the
        old signature raised TypeError, which the gateway caught and silently
        fell back to the text "/approve" prompt. In the app that meant NO
        button card, an unanswerable 60s execute_code gate, and a dead turn
        (live: Alex's research task, 2026-07-22 16:21). **_future_kwargs keeps
        this send duck-type-compatible with future gateway additions; honour
        the ones we understand, ignore the rest."""
        self._approval_seq += 1
        # chat_id-prefixed so the inbound route can recover the user without a
        # second lookup, and globally unique across users on this runner.
        approval_id = f"{chat_id}:{self._approval_seq}"
        self._approval_state[approval_id] = session_key
        # allow_permanent=False means the gate forbids a standing "always"
        # grant for this command — drop that button so the app can only offer
        # what the gateway will actually honour.
        choices = ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
        ok = await self._relay({
            "kind": "approval",
            "user_id": chat_id,
            "run_id": self._delivery_run_id(chat_id),
            "approval_id": approval_id,
            "command": command,
            "description": description or "dangerous command",
            "choices": choices,
        })
        if not ok:
            # Relay down: drop the dangling map and signal the gateway to fall
            # back to the text /approve prompt (never leave a stale mapping).
            self._approval_state.pop(approval_id, None)
        return SendResult(success=ok, message_id=approval_id)

    # ── Clarify question (the clarify tool's ask-the-user pause) ──────────

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices,
        clarify_id: str,
        session_key: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "SendResult":
        """Hermes' clarify tool calls this to ask the user a question and then
        BLOCKS the turn (up to agent.clarify_timeout, default 600s) waiting for
        the answer. The base-class text fallback streams a numbered list as
        normal content — but our app locks the composer while a run streams, so
        the user could never type the answer the agent was waiting for
        (deadlock; live incident 2026-07-09, three hung turns for one user).

        Instead we relay a structured `kind:'clarify'` frame. The Worker
        FINALIZES the app run with the question (composer unlocks), the user
        types the answer as a normal next message, and the gateway's
        text-intercept (`_maybe_intercept_clarify_text`) resolves this SAME
        paused clarify — the resumed turn then streams on the answer message's
        own run (the inbound handler re-stashes `_run_ids[chat_id]`).

        `text` carries the prebuilt display copy (same shape as the base
        fallback) so the Worker persists an honest transcript without needing
        to know how to format questions. Choice-mode marks awaiting-text
        exactly like the base fallback, so a typed "2" / option text / free
        answer all resolve; open-ended clarifies register with awaiting_text
        already set, so no mark is needed (mirrors the base class).

        A relay failure returns success=False and the gateway resumes the
        agent with its could-not-deliver sentinel — degraded but never hung."""
        if choices:
            lines = [f"❓ {question}", ""]
            for i, choice in enumerate(choices, start=1):
                lines.append(f"  {i}. {choice}")
            lines.append("")
            lines.append("Reply with the number, the option text, or your own answer.")
            text = "\n".join(lines)
        else:
            text = f"❓ {question}"
        ok = await self._relay({
            "kind": "clarify",
            "user_id": chat_id,
            "run_id": self._delivery_run_id(chat_id),
            "clarify_id": clarify_id,
            "question": question,
            "choices": list(choices) if choices else None,
            "text": text,
        })
        if not ok:
            return SendResult(success=False, error="relay_failed")
        if choices:
            # Imported lazily (like tools.approval above) so the adapter stays
            # importable even if the symbol moves between Hermes versions.
            try:
                from tools.clarify_gateway import mark_awaiting_text
                mark_awaiting_text(clarify_id)
            except Exception:  # noqa: BLE001 — capture-mode is best-effort
                pass
        return SendResult(success=True, message_id=clarify_id)

    # ── Turn lifecycle (the authoritative stream-close signal) ────────────

    async def on_processing_complete(self, event: MessageEvent, outcome: "ProcessingOutcome") -> None:
        """Close the executing event's delivery, never the latest user's slot."""
        message_id = str(getattr(event, "message_id", "") or "")
        delivery = self._turns.get(message_id)
        if delivery:
            await self._finish_delivery(delivery, getattr(outcome, 'value', str(outcome)))


# ── Plugin registration ───────────────────────────────────────────────────

def check_requirements() -> bool:
    """aiohttp ships with the gateway image; nothing else required."""
    return True


def validate_config(config) -> bool:
    return True


def is_connected(config) -> bool:
    # Enabled purely by config/env; there is no external service to ping.
    return True


def _env_enablement() -> Optional[dict]:
    """Auto-enable when DELEGENT_PLATFORM_ENABLED is truthy (the provisioner
    sets it on every runner). Seeds host/port/relay into PlatformConfig.extra."""
    if not _truthy(os.getenv("DELEGENT_PLATFORM_ENABLED")):
        return None
    seed: dict = {
        "host": os.getenv("DELEGENT_PLATFORM_HOST", "127.0.0.1"),
        "port": int(os.getenv("DELEGENT_PLATFORM_PORT") or _DEFAULT_PORT),
    }
    relay = os.getenv("DELEGENT_RELAY_URL", "").strip()
    if relay:
        seed["relay_url"] = relay
    # Home channel = the owner's app DM (the runner wrapper derives
    # DELEGENT_HOME_CHANNEL from SIDEKICK_USER_ID). Two effects: cron job
    # results / cross-platform messages deliver INTO the app chat, and the
    # gateway's first-message "📬 No home channel is set ... /sethome" nag
    # (which polluted the user's first reply — found live 2026-06-11) never
    # fires, because it checks the <PLATFORM>_HOME_CHANNEL env var.
    home = os.getenv("DELEGENT_HOME_CHANNEL", "").strip()
    if home:
        seed["home_channel"] = {
            "platform": "delegent",
            "chat_id": home,
            "name": "Delegent app chat",
        }
    return seed


def register(ctx):
    """Plugin entry point — called by the Hermes plugin loader."""
    ctx.register_platform(
        name="delegent",
        label="Delegent",
        adapter_factory=lambda cfg: DelegentAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[],
        install_hint="No extra packages needed (uses the gateway's bundled aiohttp).",
        env_enablement_fn=_env_enablement,
        # Gateway-level DM authorization. Without this the FIRST in-app message
        # hits the gateway's pairing gate ("I don't recognize you yet! Here's
        # your pairing code...") — Telegram owners approve themselves via the
        # CLI, but our runner is single-tenant and headless. The runner wrapper
        # sets DELEGENT_ALLOWED_USERS to the machine's own SIDEKICK_USER_ID, so
        # exactly the authenticated owner is authorized (no allow-all). Found
        # live on the Route B throwaway runner, 2026-06-11.
        allowed_users_env="DELEGENT_ALLOWED_USERS",
        allow_all_env="DELEGENT_ALLOW_ALL_USERS",
        emoji="💬",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "You are chatting with the user inside the Delegent AI app. This is a "
            "normal, durable one-to-one conversation: you remember previous turns "
            "and past conversations. Markdown is supported. Keep replies warm, "
            "human, and concise."
        ),
    )
