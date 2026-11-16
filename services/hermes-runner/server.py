import base64
import binascii
import hashlib
import hmac
import importlib.util
import json
import logging
import mimetypes
import os
import re
import sqlite3
import subprocess
import tempfile
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import asyncio
import secrets as _secrets_mod
import shutil
import threading
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from run_journal import RunJournal

_logger = logging.getLogger('delegent.runner')


def _restore_runner_secret_from_fd(env: dict[str, str] | None = None) -> bool:
    """Secret custody: entrypoint.sh moves SIDEKICK_RUNNER_SHARED_SECRET out
    of the exec-time environment (same-uid processes -- including the agent --
    can read /proc/<pid>/environ) and hands it over on an inherited file
    descriptor instead. Read it exactly once at import, close the fd, and keep
    the secret only in this process's memory: a runtime os.environ write is
    NOT reflected back into the /proc environ block."""
    source = env if env is not None else os.environ
    fd_raw = source.pop('SIDEKICK_RUNNER_SHARED_SECRET_FD', None)
    if not fd_raw or (source.get('SIDEKICK_RUNNER_SHARED_SECRET') or '').strip():
        return False
    try:
        with os.fdopen(int(fd_raw), 'r') as handle:
            secret = handle.read().strip()
    except (OSError, ValueError):
        return False
    if secret:
        source['SIDEKICK_RUNNER_SHARED_SECRET'] = secret
        return True
    return False


_restore_runner_secret_from_fd()

TASKS: dict[str, dict[str, Any]] = {}
# TASKS is a short-horizon in-memory cache (results are persisted upstream in
# Supabase); cap it so a long-lived box can't grow without bound. Insertion
# order == age, so evicting from the front drops the oldest records first.
TASKS_MAX_RECORDS = 200
DEFAULT_RUNNER_PORT = '8642'
DEFAULT_AGENT_NAME = 'Ruben'


def _evict_old_tasks() -> None:
    while len(TASKS) > TASKS_MAX_RECORDS:
        TASKS.pop(next(iter(TASKS)))


# Bound concurrent `hermes chat` subprocess executions: each can hold a CPU
# for up to 10 minutes and the box has 1-2 CPUs, so unbounded spawns would
# starve the Machine. Over-cap requests get a 429 (runner_busy). NOTE: the
# Worker currently treats any non-OK runner response as terminal for that
# turn (no retry), so the cap trades a slow box for an explicit failure on
# the 3rd concurrent subprocess-path task; tune via SIDEKICK_MAX_CONCURRENT_TASKS.
MAX_CONCURRENT_SUBPROCESS_TASKS = max(1, int(os.getenv('SIDEKICK_MAX_CONCURRENT_TASKS', '2') or '2'))
_HERMES_TASK_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_SUBPROCESS_TASKS)

# ---------------------------------------------------------------------------
# [hermes-streaming] Hermes API Server lifespan
#
# In addition to our HMAC-gated FastAPI wrapper on :8642, we launch the
# official Hermes API Server on 127.0.0.1:8643 with a per-container
# bearer key. Mobile traffic always enters at :8642 (HMAC); the proxy
# endpoints below forward to :8643 with the bearer key after auth.
#
# The Hermes API Server is what exposes /v1/runs + /v1/runs/{id}/events
# SSE streams. Without it, the runner can only do final-payload runs
# via `hermes chat` subprocess (the existing /tasks path).
# ---------------------------------------------------------------------------
HERMES_API_DEFAULT_HOST = '127.0.0.1'
HERMES_API_DEFAULT_PORT = 8643
# Verified against hermes-agent 0.13.0 (v2026.5.7): the API Server is
# a gateway "platform" — you enable it in `~/.hermes/config.yaml` under
# `platforms.api_server` then run `hermes gateway run` to bind the
# adapter. There is no standalone `hermes serve` subcommand.
HERMES_GATEWAY_RUN_COMMAND: list[str] = ['hermes', 'gateway', 'run', '--accept-hooks']
_HERMES_API_STATE: dict[str, Any] = {
    'available': False,
    'process': None,
    'host': HERMES_API_DEFAULT_HOST,
    'port': HERMES_API_DEFAULT_PORT,
    'bearer_key': None,
    'startup_command': None,
    'startup_error': None,
}
_HERMES_API_CLIENT: httpx.AsyncClient | None = None


def _seed_hermes_gateway_config(home: Path, host: str, port: int, bearer: str) -> bool:
    """Write the minimal gateway YAML that enables the API Server
    platform with the per-container bearer AND the inference provider
    pointing at the loopback adapter (the same setup the legacy /tasks
    subprocess uses). Returns True if the file was written (or is
    already correct), False on filesystem failure.
    """
    config_path = home / 'config.yaml'
    try:
        home.mkdir(parents=True, exist_ok=True)
        # Inference provider: the gateway must know which model/provider
        # to dispatch /v1/runs requests against. We use the same 'custom'
        # provider the legacy /tasks path uses (subprocess.run with
        # `hermes chat --provider custom --model openrouter/auto`),
        # pointing at our loopback adapter on 127.0.0.1:8642.
        #
        # Verified against hermes_cli/runtime_provider.py and
        # hermes_cli/config.py in hermes-agent v2026.5.7: the `model`
        # key can be a dict with provider/name/base_url/api_key, which is
        # what `hermes model` writes when the user picks a custom
        # OpenAI-compatible endpoint. We do the same here so the gateway
        # picks up our loopback adapter without an env-var dance.
        env = os.environ
        shared_secret = env.get('SIDEKICK_RUNNER_SHARED_SECRET', '')
        try:
            adapter_key = derive_local_adapter_api_key(shared_secret) if shared_secret else ''
        except Exception:  # noqa: BLE001
            adapter_key = ''
        adapter_base_url = local_openai_base_url(env)
        model_name = env.get('HERMES_MODEL', 'openrouter/auto')

        # Verified against tests/hermes_cli/test_setup_model_provider.py
        # `_write_model_config`: the model slug lives at `model.default`,
        # not `model.name`. provider/base_url/api_key sit at the same
        # top-level of the dict.
        #
        # The api_server platform's enabled tools come from
        # `platform_toolsets.api_server` (gateway/platforms/api_server.py
        # _create_agent → _get_platform_tools). Without it, the agent
        # can chat but can't write files, run terminal commands, or
        # browse the web — which is why "create notes/foo.md" produced
        # text but no file. Match the legacy /tasks subprocess set.
        toolsets = env.get('HERMES_TOOLSETS', 'file,web,terminal').split(',')
        toolset_yaml = '\n'.join(f'    - {t.strip()}' for t in toolsets if t.strip())

        # Route B (docs/CHAT_ROUTE_B_DESIGN.md): when DELEGENT_PLATFORM_ENABLED
        # is set, ALSO boot our custom `delegent` messaging platform alongside
        # the api_server, so in-app chat routes through the gateway pipeline
        # (durable per-user sessions + slash commands + /goal). It shares the
        # same toolset and reuses the loopback inference adapter. The api_server
        # stays enabled during cutover as a fallback.
        delegent_enabled = _delegent_platform_is_enabled(env)
        delegent_toolset_block = ''
        delegent_platform_block = ''
        session_reset_block = ''
        if delegent_enabled:
            delegent_host = env.get('DELEGENT_PLATFORM_HOST', '127.0.0.1')
            delegent_port = env.get('DELEGENT_PLATFORM_PORT', '8644')
            delegent_relay = env.get('DELEGENT_RELAY_URL', '')
            delegent_toolset_block = (
                '  delegent:\n'
                f'{toolset_yaml}\n'
            )
            delegent_platform_block = (
                '  delegent:\n'
                '    enabled: true\n'
                '    extra:\n'
                f'      host: {delegent_host}\n'
                f'      port: {delegent_port}\n'
                f'      relay_url: "{delegent_relay}"\n'
            )
            # Phase 3 (docs/CHAT_ROUTE_B_DESIGN.md): never auto-reset the durable
            # session. Hermes' default is mode='both' (reset after 24h idle AND
            # daily at 04:00), which would wipe the weeks/months memory Route B
            # exists to provide. mode='none' keeps the full transcript and lets
            # the running summarizer compress it when it outgrows the context
            # window — the Telegram-grade "remember 3 weeks ago" behavior. This
            # writes the DEFAULT policy (load_gateway_config maps `session_reset`
            # -> default_reset_policy; it does NOT read reset_by_platform from
            # config.yaml). Safe: a runner is single-user and api_server is the
            # only other platform, and its /v1/runs path holds no gateway session
            # to reset. (Retention is still bounded by session_store_max_age_days,
            # 90d, which is not config.yaml-settable in this Hermes build.)
            session_reset_block = (
                'session_reset:\n'
                '  mode: none\n'
            )

        # Narration display (2026-07-22). Hermes v0.19's GLOBAL defaults already
        # resolve interim_assistant_messages=true + tool_progress=all for our
        # platform (it has no per-platform tier in gateway/display_config.py),
        # which is what puts the agent's plain-English "I'll do X" lines and the
        # "✍️ Writing <file>" progress lines into the app chat. Pin those values
        # explicitly so an upstream default change can't silently mute (or
        # flood) the app, and make them per-machine tunable so retuning is a
        # `fly machine update --env`, no image rebuild:
        #   DELEGENT_TOOL_PROGRESS: off | new | all | verbose  (new = dedupe
        #     repeated same-tool lines, i.e. QUIETER than all)
        #   DELEGENT_INTERIM_NARRATION: on/off
        tool_progress = (env.get('DELEGENT_TOOL_PROGRESS') or 'all').strip().lower()
        if tool_progress not in ('off', 'new', 'all', 'verbose'):
            tool_progress = 'all'
        interim_narration = (env.get('DELEGENT_INTERIM_NARRATION') or 'on').strip().lower() not in ('0', 'false', 'no', 'off')

        # Context-compaction trigger as a FRACTION of the model context window.
        # Hermes' default is 0.5, so a long durable session grows very large
        # before ANY compaction, and every turn re-sends that full running
        # context. On a chat that is rebuilt per turn this dominates token cost.
        #
        # THIS NUMBER IS USELESS ON ITS OWN. It only means anything alongside the
        # model name in this same config, and getting that wrong wasted an
        # afternoon on 2026-08-02.
        #
        # Hermes computes the trigger as
        #   max(effective_input_budget * threshold, MINIMUM_CONTEXT_LENGTH)
        # with MINIMUM_CONTEXT_LENGTH = 64_000 (agent/model_metadata.py:194,
        # applied at context_compressor.py:1297). Measured on the live box:
        #
        #   window       0.25 ->            0.06 ->
        #   262,144      65,536             64,000     (kimi-k2.6)
        #   1,048,576    262,144            64,000     (deepseek-v4-flash)
        #
        # So on the SMALL window the two settings are the same number, and on the
        # LARGE window 0.06 is a genuine 4x reduction. Lowering the threshold on
        # 2026-08-02 therefore did nothing at first, because HERMES_MODEL on the
        # live machines still said kimi-k2.6 even though the Worker had moved to
        # deepseek the day before. Both had to be right together.
        #
        # Once the model name was corrected, this fired immediately: prompt
        # tokens per turn went 173,771 -> 46,465, a 73% cut, and the session's
        # 652-message active window collapsed in one pass.
        #
        # THE RULE: if you change the model, re-derive this against the NEW
        # window, and check that HERMES_MODEL on the machines actually says the
        # model you think it does. A stale model name makes this setting silently
        # inert, and nothing warns you.
        #
        # Env-tunable per machine (DELEGENT_COMPRESSION_THRESHOLD), so retuning is
        # a `fly machine update --env` with no image rebuild; it hot-reloads on
        # the next turn.
        #
        # Env-tunable per machine (DELEGENT_COMPRESSION_THRESHOLD), so retuning is
        # a `fly machine update --env` with no image rebuild; it hot-reloads on
        # the next turn.
        # Verified 2026-09-12 against the installed native compressor:
        # 0.12 * 1,050,000 = 126,000 tokens for openai/gpt-5.6-luna.
        # Do not confuse the skills snapshot's 66 KB file size with tokens
        # in the fixed prompt. The measured first fresh turn used 18,363
        # prompt tokens. Keep native head/tail protection and summarization.
        compression_threshold = (os.environ.get('DELEGENT_COMPRESSION_THRESHOLD') or '0.12').strip()

        body = (
            'model:\n'
            '  provider: custom\n'
            f'  default: {model_name}\n'
            f'  base_url: "{adapter_base_url}"\n'
            f'  api_key: "{adapter_key}"\n'
            'providers:\n'
            '  custom:\n'
            f'    base_url: "{adapter_base_url}"\n'
            f'    api_key: "{adapter_key}"\n'
            f'    default: {model_name}\n'
            'platform_toolsets:\n'
            '  api_server:\n'
            f'{toolset_yaml}\n'
            f'{delegent_toolset_block}'
            'platforms:\n'
            '  api_server:\n'
            '    enabled: true\n'
            '    extra:\n'
            f'      host: {host}\n'
            f'      port: {port}\n'
            f'      key: "{bearer}"\n'
            '      cors_origins: ""\n'
            f'{delegent_platform_block}'
            f'{session_reset_block}'
            # 2026-07-21 Hermes v0.19.0 (Quicksilver) makes approvals.mode='smart'
            # (an auxiliary LLM auto-approves low-risk flagged commands) the product
            # default. On our runner that would BYPASS the in-app Approve / Decline
            # card: a flagged command could execute without ever reaching the user.
            # Force 'manual' so every flagged command routes to the human via the
            # adapter's send_exec_approval (the approval-buttons UX), matching the
            # pre-v0.19 behaviour. Hardline-blocked commands stay blocked regardless.
            'approvals:\n'
            '  mode: manual\n'
            # 2026-09-12: Hermes' onboarding module (agent/onboarding.py,
            # v2026.7.20) treats the session store's first message as "the
            # user's very first message ever" and injects a system note telling
            # the model to "mention /help shows commands" and to offer to build a
            # short profile. That is the "`/help` shows the available commands"
            # greeting every new user got on their first real reply (five users
            # since 27 Aug, then Alex's iPhone trial on 12 Sep). It goes round the
            # never-mention-slash-commands rule in both identity prompts because
            # it is a per-turn injection from the gateway, not part of the
            # identity. The app has no command menu, and the provisioner's wake
            # message already does the welcome, so there is nothing for this to
            # add. 'off' is the documented switch (profile_build_mode): the first
            # reply becomes a plain introduction and nothing else.
            'onboarding:\n'
            '  profile_build: off\n'
            # 2026-07-04 provider-error incident: Hermes' default of 3 API
            # attempts back off ~3s/~6s — a sub-30-second Worker/provider blip
            # kills the whole turn. 5 attempts stretch the retry window to
            # roughly a minute without meaningfully delaying real failures.
            'agent:\n'
            '  api_max_retries: 5\n'
            # Compact the durable session earlier than Hermes' ~128K default so
            # each turn re-sends less history (see compression_threshold above).
            # threshold is a fraction of the model context window; protect_last_n /
            # target_ratio stay at Hermes defaults so recent turns stay verbatim.
            'compression:\n'
            '  enabled: true\n'
            f'  threshold: {compression_threshold}\n'
            '  abort_on_summary_failure: true\n'
            # Narration display — see the env resolution above. Written under
            # display.platforms.delegent so ONLY the in-app platform is pinned;
            # api_server (and any future platform) keeps Hermes' own defaults.
            'display:\n'
            '  platforms:\n'
            '    delegent:\n'
            f'      tool_progress: {tool_progress}\n'
            f'      interim_assistant_messages: {str(interim_narration).lower()}\n'
        )
        config_path.write_text(body, encoding='utf-8')
        return True
    except OSError:
        return False


def _delegent_platform_is_enabled(source: dict[str, str] | None = None) -> bool:
    """Route B is fully cut over, so an unset flag means ON, not off.

    Explicitly setting the var to a false-y value still disables it. The default
    is inverted because the adapter is baked into the image and self-registers
    with the gateway either way: unconfigured it binds relay=log-only with no
    user allowlist, so every reply lands in an on-box log nobody reads and the
    chat bubble never fills in. A machine whose env simply never got the flag
    must not be able to produce that silently dead chat.
    """
    src = source if source is not None else os.environ
    raw = (src.get('DELEGENT_PLATFORM_ENABLED', '') or '').strip().lower()
    if not raw:
        return True
    return raw in ('1', 'true', 'yes', 'on')


def _prepare_delegent_gateway_env(subprocess_env: dict[str, str]) -> bool:
    """Route B: when the delegent platform is enabled, derive its loopback relay
    URL and mint a dedicated per-boot loopback token, set them on os.environ (so
    THIS process's ingest + inbound endpoints use them), and copy the DELEGENT_*
    vars into the gateway subprocess env so the adapter agrees on the same token
    + relay. Returns whether the platform is enabled (no-op + False otherwise).

    The gateway enables the plugin via the registry/env path (the adapter's
    env_enablement_fn reads these), NOT the config.yaml platform block — that
    block is skipped during config load because Platform("delegent") isn't a
    valid enum member until plugin discovery runs.

    Why a dedicated token, not the runner shared secret: the shared secret is
    deliberately withheld from the gateway subprocess (build_hermes_subprocess_env
    + the /proc-environ custody fix), so the adapter has nothing to sign the
    relay with — and the ingest endpoint is on the externally-bound runner port,
    so its secret gate is real auth, not just belt-and-braces. This token is
    loopback-only and low-value (it only lets a same-uid caller post deltas into
    its OWN reply stream), so sharing it with the gateway subprocess is fine. The
    runner shared secret is never used here, so its custody invariant holds."""
    if not _delegent_platform_is_enabled():
        return False
    # Normalize, so the copy loop below propagates the flag to the gateway even
    # when the machine env never carried it.
    os.environ['DELEGENT_PLATFORM_ENABLED'] = 'true'
    if not (os.getenv('DELEGENT_RELAY_URL') or '').strip():
        runner_port = (os.getenv('PORT') or DEFAULT_RUNNER_PORT).strip()
        if not runner_port.isdigit():
            runner_port = DEFAULT_RUNNER_PORT
        os.environ['DELEGENT_RELAY_URL'] = f'http://127.0.0.1:{runner_port}/v1/delegent/ingest'
    if not (os.getenv('DELEGENT_PLATFORM_SECRET') or '').strip():
        os.environ['DELEGENT_PLATFORM_SECRET'] = _secrets_mod.token_urlsafe(32)
    # Authorize exactly the machine's own user at the GATEWAY level (the plugin
    # registers allowed_users_env=DELEGENT_ALLOWED_USERS). Without this the
    # first in-app message hits the gateway's DM pairing gate ("I don't
    # recognize you yet") — Telegram owners self-approve via the CLI; our
    # single-tenant runner authorizes its one owner automatically. The inbound
    # HMAC already binds user_id, so this is the matching gateway-side gate,
    # not a bypass. (Found live on the Route B throwaway, 2026-06-11.)
    owner_user_id = (os.getenv('SIDEKICK_USER_ID') or '').strip()
    if owner_user_id and not (os.getenv('DELEGENT_ALLOWED_USERS') or '').strip():
        os.environ['DELEGENT_ALLOWED_USERS'] = owner_user_id
    # Home channel = the owner's app DM. Kills the gateway's first-message
    # "/sethome" nag (it checks <PLATFORM>_HOME_CHANNEL in the env) and gives
    # cron-job results a delivery target inside the app chat.
    if owner_user_id and not (os.getenv('DELEGENT_HOME_CHANNEL') or '').strip():
        os.environ['DELEGENT_HOME_CHANNEL'] = owner_user_id
    for _k in (
        'DELEGENT_PLATFORM_ENABLED', 'DELEGENT_PLATFORM_HOST',
        'DELEGENT_PLATFORM_PORT', 'DELEGENT_PLATFORM_SECRET', 'DELEGENT_RELAY_URL',
        'DELEGENT_ALLOWED_USERS', 'DELEGENT_HOME_CHANNEL',
    ):
        _v = os.getenv(_k)
        if _v:
            subprocess_env[_k] = _v
    return True


def _seed_delegent_soul(home: Path, agent_name: str, source: dict[str, str] | None = None) -> None:
    """Overwrite Hermes' default SOUL.md persona with the Delegent coworker
    identity AND the behavioural contract. Hermes writes a default SOUL.md
    ("You are Hermes Agent, an intelligent AI assistant created by Nous
    Research...") onto the volume on first run; that file owns the agent's CORE
    identity and overrides HERMES_SYSTEM_PROMPT for "who are you / who made you"
    questions, leaking the underlying framework, vendor, and model to the user.
    We rewrite it on EVERY gateway launch (idempotent) so volume-backed runners
    are corrected on re-image too. Best-effort: a failure here must never block
    the boot.

    2026-07-25: SOUL.md now also carries HERMES_SYSTEM_PROMPT. The in-app chat
    runs through the `delegent` gateway platform (Route B), and the gateway is a
    SUBPROCESS whose env is filtered down to SAFE_SUBPROCESS_PASSTHROUGH_ENV,
    which never included HERMES_SYSTEM_PROMPT. So the entire behavioural
    contract the provisioner bakes per user (uploads-first, the workspace folder
    map, the approval fence, capability honesty, the key-vault check, the
    no-em-dash rule) reached the legacy /v1/runs path only and was silently
    absent from every live in-app conversation. Found by asking a live agent
    "can you see my email?": it answered a flat no while the user's credential
    was sitting in its vault, and used an em-dash doing it.

    SOUL.md is on the volume, so the gateway reads it regardless of env
    filtering. That makes the provisioner template the single source of truth
    with no duplicated prompt text here and no allowlist widening. The identity
    paragraph stays FIRST so it keeps winning "who made you".
    """
    src = source if source is not None else os.environ
    name = (agent_name or 'your coworker').strip() or 'your coworker'
    soul = (
        f"You are {name}, the user's friendly AI coworker from Delegent AI. "
        "You are helpful, knowledgeable, warm, and direct, and you prioritise "
        "being genuinely useful. You assist with a wide range of tasks: answering "
        "questions, writing and editing documents and code, analysing information, "
        "creative work, and getting things done with your tools. You communicate "
        "clearly in plain English and admit uncertainty when appropriate. You never "
        "reveal or discuss any underlying model, provider, or framework. If asked "
        "who or what you are, or who made or created you, you are "
        f"{name}, the user's AI coworker built by the Delegent AI team."
    )
    contract = (src.get('HERMES_SYSTEM_PROMPT', '') or '').strip()
    if contract:
        soul = f'{soul}\n\n{contract}'
    try:
        home.mkdir(parents=True, exist_ok=True)
        (home / 'SOUL.md').write_text(soul, encoding='utf-8')
    except OSError:
        pass


def _seed_delegent_skills(home: Path) -> None:
    """Make the curated Delegent skills library first-class to the agent's own
    `skills` tool. That tool discovers skills under HERMES_HOME/skills (the
    volume); our library is baked SEPARATELY at DELEGENT_SKILLS_DIR
    (/opt/delegent/skills) and used to be only *mentioned* in the system prompt,
    so the agent never found it through the skills tool and improvised its own
    approaches instead (e.g. self-authoring a 'bookkeeping-automation' skill that
    set up unrelated software rather than using ours). We mirror the library into
    HERMES_HOME/skills/delegent/<slug>/ on EVERY gateway launch so the skills
    tool surfaces it (on first provision AND on re-image). The curated copy is
    authoritative and holds no per-user state (credentials live separately under
    HERMES_HOME/credentials), so we refresh it wholesale each launch. Best-effort:
    a failure here must never block the boot.
    """
    lib_root = Path(os.environ.get('DELEGENT_SKILLS_DIR', '/opt/delegent/skills'))
    src_skills = lib_root / 'skills'
    if not src_skills.is_dir():
        return
    skills_root = home / 'skills'
    dest_skills = skills_root / 'delegent'
    try:
        skills_root.mkdir(parents=True, exist_ok=True)
        if dest_skills.exists():
            shutil.rmtree(dest_skills, ignore_errors=True)
        shutil.copytree(src_skills, dest_skills)
        # The skill scripts load their shared modules (credential store, OAuth
        # helper) via Path(__file__).resolve().parents[3] / "_shared". From a
        # seeded skill at <skills_root>/delegent/<slug>/scripts/X.py that resolves
        # to <skills_root>/_shared, so mirror _shared there too or the connect
        # scripts fail to import when run from the seeded copy.
        src_shared = lib_root / '_shared'
        if src_shared.is_dir():
            dest_shared = skills_root / '_shared'
            if dest_shared.exists():
                shutil.rmtree(dest_shared, ignore_errors=True)
            shutil.copytree(src_shared, dest_shared)
    except OSError:
        pass
    _retire_stock_skills(home)


# Stock Hermes skills that compete with a brokered Connection and lose. Each of
# these walks the user through creating their own developer credentials for a
# service the Connections screen already connects with one tap, so its very
# presence is a trap: the agent routes to it, finds nothing configured, and
# tells a connected customer they are not connected.
#
# Live incident 2026-07-25: "connect Google Calendar" was answered by the stock
# google-workspace skill, which marched a phone user through the Google Cloud
# Console. Claiming the phrasings in our manifest helps the router prefer us,
# but a stock skill that is still on disk is still a skill the agent can open.
# Removing it is the only thing that ends the argument.
#
# Paths are relative to HERMES_HOME/skills. Add a stock skill here the day the
# last service it covers gets a Connections card; google-workspace covered
# Gmail, Calendar, Drive, Docs and Sheets, all of which now have one.
_DELEGENT_RETIRED_STOCK_SKILLS = (
    'productivity/google-workspace',
    # Walks the user through creating a Notion integration token and pasting it
    # into an env var. The Notion card connects with one tap (2026-09-02).
    'productivity/notion',
)


def _retire_stock_skills(home: Path) -> None:
    """Remove stock skills that a brokered Connection has replaced.

    Hermes re-seeds its bundled skills on its own launches, so this cannot be a
    one-off at image build: it runs on every gateway launch and before every
    turn, alongside the curated-library self-heal. Best-effort, never blocks.
    """
    for rel in _DELEGENT_RETIRED_STOCK_SKILLS:
        try:
            target = home / 'skills' / rel
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
        except OSError:
            pass


# A few load-bearing skills whose presence proves the whole curated library is
# seeded. If any is missing we treat the library as drifted and re-seed.
_DELEGENT_SKILL_SENTINELS = ('connect-telegram', 'report-writer', 'autonomous-bookkeeper')


def _ensure_delegent_skills_present(home: Path) -> None:
    """Self-heal the curated Delegent skills on the volume before a turn runs.

    `_seed_delegent_skills` only runs when the gateway is launched by our
    supervisor (`_launch_hermes_gateway`). But the gateway can self-re-exec via
    `--accept-hooks` (bypassing that path), and a Hermes launch-time skill
    curation has been observed pruning the delegent library down to a subset.
    Live incident 2026-07-22: a long-running box silently lost 34 of 35 skills
    mid-session, so the agent answered "skill not found" for connect-telegram,
    report-writer, etc. This re-seeds cheaply on message dispatch when a sentinel
    skill is missing, so the agent always has its full library regardless of how
    the gateway relaunched. Cheap in the common case (a few stat() calls); the
    full wholesale copy only runs on drift. Best-effort: never block a turn.
    """
    # Cheap and every turn: a stock skill Hermes re-seeded since launch must not
    # get a single turn in which to shadow a Connection.
    _retire_stock_skills(home)
    try:
        dest = home / 'skills' / 'delegent'
        if all((dest / slug / 'SKILL.md').is_file() for slug in _DELEGENT_SKILL_SENTINELS):
            return
    except OSError:
        pass
    _seed_delegent_skills(home)


GATEWAY_LOG_MAX_BYTES = 8 * 1024 * 1024


def _gateway_log_path(home: Path) -> Path:
    return home / 'logs' / 'gateway.log'


def _open_gateway_log(home: Path):
    """Append-mode handle for the gateway's combined stdout+stderr.

    Rotated by size with a single .1 generation kept, because the volume is the
    user's storage quota and an unbounded log would eat it.
    """
    try:
        path = _gateway_log_path(home)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > GATEWAY_LOG_MAX_BYTES:
            path.replace(path.with_suffix('.log.1'))
        return path.open('ab', buffering=0)
    except OSError:
        return None


def _redact_gateway_log(text: str) -> str:
    """Strip anything key-shaped before a log tail leaves the box."""
    for value in (
        _HERMES_API_STATE.get('bearer_key'),
        os.environ.get('SIDEKICK_RUNNER_SHARED_SECRET'),
        os.environ.get('OPENAI_API_KEY'),
        os.environ.get('HERMES_API_KEY'),
        os.environ.get('DELEGENT_PLATFORM_SECRET'),
    ):
        if isinstance(value, str) and len(value.strip()) >= 8:
            text = text.replace(value.strip(), '[redacted]')
    # Per-user vault credentials can surface in gateway log lines the same way
    # (a connect script logging a failed API call with the token attached).
    for value in _vault_secret_values():
        text = text.replace(value, '[redacted]')
    text = re.sub(r'\b(sk|rk|key)-[A-Za-z0-9_\-]{12,}', '[redacted]', text)
    text = re.sub(
        r'(?i)\b(authorization|api[_-]?key|token|secret|password)\b(\s*[:=]\s*)\S+',
        r'\1\2[redacted]',
        text,
    )
    return text


def _launch_hermes_gateway() -> bool:
    """Best-effort launch of the Hermes API Server via `hermes gateway run`.

    Returns True once the gateway answers its readiness probe, False on any
    failure (binary missing, seed failure, spawn failure, early exit, readiness
    timeout) — in which case the proxy endpoints report 'unavailable' and the
    legacy /tasks subprocess path keeps working. Called by _spawn_hermes_api_server
    (the supervisor), both for the initial boot and for self-healing respawns.
    """
    if not shutil.which(HERMES_GATEWAY_RUN_COMMAND[0]):
        _HERMES_API_STATE['startup_error'] = 'hermes_binary_not_found'
        return False

    bearer = _secrets_mod.token_urlsafe(48)
    host = _HERMES_API_STATE['host']
    port = _HERMES_API_STATE['port']
    # The gateway needs the same inference-provider env the legacy
    # /tasks subprocess uses (provider=custom, base_url=loopback adapter,
    # api_key=derived from shared secret). Without these the gateway
    # boots fine but every /v1/runs request fails with "No inference
    # provider configured".
    try:
        env = build_hermes_subprocess_env()
    except Exception as exc:  # noqa: BLE001 — best-effort fallback
        _HERMES_API_STATE['startup_error'] = f'build_env_failed:{type(exc).__name__}'
        env = os.environ.copy()
    hermes_home = Path(env.get('HERMES_HOME', '/data/hermes'))

    # Route B: derive the delegent relay URL + mint the loopback token and copy
    # the DELEGENT_* vars into the gateway subprocess env (see the helper).
    delegent_on = _prepare_delegent_gateway_env(env)

    if not _seed_hermes_gateway_config(hermes_home, host, port, bearer):
        _HERMES_API_STATE['startup_error'] = 'seed_config_failed'
        return False

    # Delegent identity guard: replace Hermes' default SOUL.md persona (which
    # hardcodes "Hermes Agent, created by Nous Research") with the Delegent
    # coworker identity, so the agent never leaks the underlying framework /
    # vendor / model when asked "who are you / who made you". SOUL.md owns the
    # core identity and overrides HERMES_SYSTEM_PROMPT, so the prompt guard
    # alone is not enough (proven live 2026-06-16). Best-effort, every launch.
    _seed_delegent_soul(hermes_home, env.get('HERMES_AGENT_NAME') or env.get('SIDEKICK_AGENT_NAME') or 'your coworker')

    # Make the curated Delegent skills library discoverable by the agent's own
    # `skills` tool (it reads HERMES_HOME/skills), so requests like "be my
    # accountant" route to the real autonomous-bookkeeper skill instead of the
    # agent improvising. Mirrors /opt/delegent/skills into the volume on every
    # launch; idempotent + best-effort, never blocks boot.
    _seed_delegent_skills(hermes_home)

    # Belt-and-braces .env so Hermes Agent's dotenv loader picks up the
    # provider keys even when subprocess inheritance is stripped (e.g.
    # when the gateway re-execs itself).
    try:
        env_lines = [
            f'OPENAI_API_KEY={env.get("OPENAI_API_KEY", "")}',
            f'OPENAI_BASE_URL={env.get("OPENAI_BASE_URL", "")}',
            f'HERMES_API_KEY={env.get("HERMES_API_KEY", "")}',
            f'HERMES_MODEL_BASE_URL={env.get("HERMES_MODEL_BASE_URL", "")}',
            f'HERMES_MODEL_PROVIDER={env.get("HERMES_MODEL_PROVIDER", "custom")}',
            f'HERMES_MODEL={env.get("HERMES_MODEL", "openrouter/auto")}',
            f'HERMES_INFERENCE_PROVIDER={env.get("HERMES_INFERENCE_PROVIDER", "custom")}',
            f'HERMES_INFERENCE_MODEL={env.get("HERMES_INFERENCE_MODEL", "openrouter/auto")}',
            f'CUSTOM_BASE_URL={env.get("CUSTOM_BASE_URL", "")}',
        ]
        # Web-search provider keys: only emit the ones actually set so we don't
        # write empty FIRECRAWL_API_KEY= lines that could shadow a real value.
        # Hermes' `web` toolset (check_web_api_key) reads these from the env /
        # dotenv; the gateway re-execs itself in some modes and strips the
        # inherited env, so the dotenv is the durable carrier. Keep in sync with
        # SAFE_SUBPROCESS_PASSTHROUGH_ENV and the provisioner passthrough list.
        for web_key in (
            'FIRECRAWL_API_KEY',
            'FIRECRAWL_API_URL',
            'SEARXNG_URL',
            'TAVILY_API_KEY',
            'EXA_API_KEY',
            'PARALLEL_API_KEY',
        ):
            web_val = env.get(web_key, '')
            if isinstance(web_val, str) and web_val.strip() != '':
                env_lines.append(f'{web_key}={web_val}')
        # Route B: persist the delegent platform env so the adapter's
        # env_enablement_fn still sees it after a gateway re-exec (the relay URL
        # + the loopback token, NOT the runner shared secret). The token here is
        # the dedicated low-value loopback token minted above, so writing it to
        # the volume-backed .env is acceptable (the runner shared secret is never
        # written here — that custody invariant is preserved).
        if delegent_on:
            for _dk in (
                'DELEGENT_PLATFORM_ENABLED', 'DELEGENT_PLATFORM_HOST',
                'DELEGENT_PLATFORM_PORT', 'DELEGENT_RELAY_URL', 'DELEGENT_PLATFORM_SECRET',
                'DELEGENT_ALLOWED_USERS', 'DELEGENT_HOME_CHANNEL',
            ):
                _dv = env.get(_dk, '') or os.getenv(_dk, '')
                if isinstance(_dv, str) and _dv.strip() != '':
                    env_lines.append(f'{_dk}={_dv}')
        env_lines.append('')
        env_path = hermes_home / '.env'
        env_path.write_text('\n'.join(env_lines), encoding='utf-8')
    except OSError:
        # Non-fatal — the in-process env should still let the gateway boot.
        pass

    # The api_server adapter reads these env vars as a fallback when
    # the YAML key isn't present. We set both belt-and-braces so the
    # adapter still binds correctly if someone strips the YAML.
    workspace_root = str(ensure_runner_workspace())
    env.update({
        'API_SERVER_HOST': host,
        'API_SERVER_PORT': str(port),
        'API_SERVER_KEY': bearer,
        'API_SERVER_CORS_ORIGINS': '',
        'HERMES_HOME': str(hermes_home),
        # tools/file_tools.py resolves relative paths against
        # `os.environ.get("TERMINAL_CWD", os.getcwd())`. The gateway
        # process inherits cwd=workspace but the file tool runs from
        # an internal worker that has different cwd state — so we set
        # TERMINAL_CWD explicitly to pin every "create notes/x.md"
        # request at /data/hermes/workspace/notes/x.md, matching where
        # the runner's /files endpoint reads from.
        'TERMINAL_CWD': workspace_root,
    })

    _HERMES_API_STATE['startup_command'] = ' '.join(HERMES_GATEWAY_RUN_COMMAND)
    _HERMES_API_STATE['bearer_key'] = bearer

    # The gateway used to run with stdout+stderr on DEVNULL, which meant a turn
    # that died inside the agent left no trace anywhere on the box. Capture it.
    log_sink = _open_gateway_log(hermes_home)
    try:
        process = subprocess.Popen(  # noqa: S603
            HERMES_GATEWAY_RUN_COMMAND,
            stdout=log_sink or subprocess.DEVNULL,
            stderr=subprocess.STDOUT if log_sink else subprocess.DEVNULL,
            env=env,
            cwd=str(ensure_runner_workspace()),
        )
    except (OSError, ValueError) as exc:
        _HERMES_API_STATE['startup_error'] = f'spawn_failed:{type(exc).__name__}'
        return False
    finally:
        # Popen dup()s the fd into the child; this process does not need it.
        if log_sink is not None:
            try:
                log_sink.close()
            except OSError:
                pass

    _HERMES_API_STATE['process'] = process

    # Poll for readiness on the loopback. The gateway takes ~3-6s to
    # bind the api_server adapter on a cold start. We give it 30s in
    # case the runner just provisioned and hasn't warmed its caches.
    deadline = time.time() + 30.0
    while time.time() < deadline:
        if process.poll() is not None:
            _HERMES_API_STATE['startup_error'] = f'process_exited:{process.returncode}'
            return False
        try:
            with urllib.request.urlopen(
                urllib.request.Request(f'http://{host}:{port}/health'),
                timeout=1.0,
            ) as response:
                if response.status < 500:
                    _HERMES_API_STATE['available'] = True
                    _HERMES_API_STATE['startup_error'] = None
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError, OSError):
            time.sleep(0.5)
    _HERMES_API_STATE['startup_error'] = 'readiness_timeout'
    return False


# Gateway supervisor tuning. The Hermes gateway is a child subprocess; if it
# exits (a crash, or an OOM-kill of the CHILD on a memory spike), the wrapper
# (uvicorn) keeps running but every /v1/runs + delegent dispatch fails until the
# child is back. Before the supervisor, that required a manual machine restart
# and /healthz LIED (the 'available' flag was sticky). Now we relaunch the child
# in-place with bounded backoff, and /healthz reflects child liveness. (The
# WRAPPER's own liveness — the rarer "machine started but uvicorn wedged after a
# flaky Fly suspend/resume" case — is handled at the infra layer by switching
# autostop suspend->stop so every wake is a clean boot, plus restart=on-failure.)
_GATEWAY_MONITOR_INTERVAL_SECONDS = 15.0
_GATEWAY_MAX_CONSECUTIVE_RESPAWNS = 5
_GATEWAY_RESPAWN_COOLDOWN_SECONDS = 300.0


def _gateway_process_alive() -> bool:
    proc = _HERMES_API_STATE.get('process')
    try:
        return proc is not None and proc.poll() is None
    except Exception:  # noqa: BLE001 — never let a health probe raise
        return False


def _spawn_hermes_api_server() -> None:
    """Launch + SUPERVISE the Hermes gateway subprocess (daemon thread target).

    Boots the gateway, then watches it: if the child exits, relaunch it so the
    runner self-heals without a machine restart. Bounded — after
    _GATEWAY_MAX_CONSECUTIVE_RESPAWNS rapid failures (a genuine misconfig, not a
    transient crash) it backs off for a cooldown before trying again, so a
    crash-looping gateway can't spin the box. A clean run resets the counter.
    """
    _launch_hermes_gateway()
    consecutive = 0
    while True:
        time.sleep(_GATEWAY_MONITOR_INTERVAL_SECONDS)
        if _gateway_process_alive():
            consecutive = 0
            continue
        # The gateway child is gone. Reflect it immediately (so /healthz and the
        # Worker's preflight see a degraded runner) and relaunch.
        _HERMES_API_STATE['available'] = False
        if consecutive >= _GATEWAY_MAX_CONSECUTIVE_RESPAWNS:
            _HERMES_API_STATE['startup_error'] = 'gateway_respawn_cooldown'
            _logger.error('hermes gateway crash-looped %d times; cooling down %.0fs',
                          consecutive, _GATEWAY_RESPAWN_COOLDOWN_SECONDS)
            time.sleep(_GATEWAY_RESPAWN_COOLDOWN_SECONDS)
            consecutive = 0
            continue
        consecutive += 1
        _logger.warning('hermes gateway exited (respawn %d/%d)', consecutive, _GATEWAY_MAX_CONSECUTIVE_RESPAWNS)
        _launch_hermes_gateway()


def _hermes_api_base_url() -> str:
    host = _HERMES_API_STATE['host']
    port = _HERMES_API_STATE['port']
    return f'http://{host}:{port}/v1'


def _hermes_api_headers() -> dict[str, str]:
    bearer = _HERMES_API_STATE.get('bearer_key')
    if not bearer:
        raise HTTPException(status_code=503, detail='hermes_api_server_not_ready')
    return {'authorization': f'Bearer {bearer}'}


# --- Browser pre-warm (perf plan step 2, 2026-07) ----------------------------
# The FIRST agent-browser Chromium launch on a box costs ~37s (measured
# 2026-06-04: cold 37s, warm ~1s) because Playwright's browser extraction and
# profile init are paid lazily. Any user turn that is the first browser use on
# the box eats that. Pre-warm pays it once at boot: open about:blank, then
# close, fire-and-forget. Strictly additive: env-gated, failure-tolerant,
# never blocks startup, and a failed pre-warm leaves behaviour exactly as
# before (the first user turn just pays the old cost).
AGENT_BROWSER_BIN = os.getenv(
    'SIDEKICK_AGENT_BROWSER_BIN',
    '/opt/hermes-agent/node_modules/.bin/agent-browser',
)
BROWSER_PREWARM_DELAY_SECS = float(os.getenv('SIDEKICK_BROWSER_PREWARM_DELAY_SECS', '10'))
BROWSER_PREWARM_OPEN_TIMEOUT_SECS = 180.0
BROWSER_PREWARM_CLOSE_TIMEOUT_SECS = 30.0
_BROWSER_PREWARM_TASK: 'asyncio.Task[None] | None' = None


def _browser_prewarm_enabled() -> bool:
    return (os.getenv('SIDEKICK_BROWSER_PREWARM', '1') or '').strip().lower() not in (
        '0', 'false', 'no', 'off', '',
    ) and os.path.exists(AGENT_BROWSER_BIN)


async def _run_agent_browser(args: list[str], timeout: float) -> int:
    proc = await asyncio.create_subprocess_exec(
        AGENT_BROWSER_BIN, *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return -1
    return proc.returncode if proc.returncode is not None else -1


async def _prewarm_agent_browser() -> None:
    """Best-effort: launch + close the agent browser once so Chromium's
    first-launch cost is paid before any user turn. Every failure path is
    swallowed — pre-warm must never affect the serving path."""
    try:
        if not _browser_prewarm_enabled():
            return
        await asyncio.sleep(BROWSER_PREWARM_DELAY_SECS)
        started = time.monotonic()
        rc_open = await _run_agent_browser(['open', 'about:blank'], BROWSER_PREWARM_OPEN_TIMEOUT_SECS)
        rc_close = await _run_agent_browser(['close', '--all'], BROWSER_PREWARM_CLOSE_TIMEOUT_SECS)
        _logger.info(
            '[browser-prewarm] done open_rc=%s close_rc=%s elapsed_ms=%d',
            rc_open, rc_close, int((time.monotonic() - started) * 1000),
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — pre-warm is strictly best-effort
        _logger.info('[browser-prewarm] skipped after error: %s', type(exc).__name__)


@asynccontextmanager
async def _lifespan(_: FastAPI):
    """FastAPI lifespan that boots Hermes API server in a daemon thread,
    then tears it down on shutdown. The HTTP client used by the proxy
    routes is reused across requests so keep-alive can stream long SSE."""
    global _HERMES_API_CLIENT, _DELEGENT_KEEPALIVE_TASK, _BROWSER_PREWARM_TASK
    if os.environ.get('SIDEKICK_HERMES_API_DISABLED') != 'true':
        threading.Thread(
            target=_spawn_hermes_api_server,
            name='hermes-api-launcher',
            daemon=True,
        ).start()
    _HERMES_API_CLIENT = httpx.AsyncClient(timeout=None)
    # Busy-aware autostop: keep the Fly proxy idle-timer alive while (and only
    # while) a delegent run is in flight, so Fly never stops the machine mid-run
    # but still scales it to zero when idle. No-ops off Fly.
    _DELEGENT_KEEPALIVE_TASK = asyncio.create_task(_delegent_autostop_keepalive())
    _BROWSER_PREWARM_TASK = asyncio.create_task(_prewarm_agent_browser())
    try:
        yield
    finally:
        if _BROWSER_PREWARM_TASK is not None:
            _BROWSER_PREWARM_TASK.cancel()
            try:
                await _BROWSER_PREWARM_TASK
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            _BROWSER_PREWARM_TASK = None
        if _DELEGENT_KEEPALIVE_TASK is not None:
            _DELEGENT_KEEPALIVE_TASK.cancel()
            try:
                await _DELEGENT_KEEPALIVE_TASK
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            _DELEGENT_KEEPALIVE_TASK = None
        if _HERMES_API_CLIENT is not None:
            await _HERMES_API_CLIENT.aclose()
            _HERMES_API_CLIENT = None
        process = _HERMES_API_STATE.get('process')
        if process is not None and process.poll() is None:
            process.terminate()


app = FastAPI(title='Delegent AI Hermes Runner', lifespan=_lifespan)


@app.middleware('http')
async def _delegent_activity_middleware(request: Request, call_next):
    """Stamp the sleep-grace clock on every real request (see
    _delegent_should_keepalive). Loopback callers are our own gateway
    subprocess and the keepalive ping's return leg; /healthz is Fly's health
    check and our keepalive target. Neither is the user, so neither counts."""
    try:
        host = request.client.host if request.client else ''
        if host not in ('127.0.0.1', '::1', 'testclient-loopback') and request.url.path != '/healthz':
            _delegent_note_activity()
    except Exception:  # noqa: BLE001 — never let bookkeeping break a request
        pass
    return await call_next(request)


LOCAL_ADAPTER_KEY_MESSAGE = b'sidekick-local-adapter:v1'
# Identifying User-Agent for outbound Worker calls. Cloudflare's default bot
# protection on workers.dev hostnames returns HTTP 403 / "error code: 1010"
# for Python's default `Python-urllib/<ver>` UA, which silently breaks the
# real `hermes chat` -> adapter -> Worker -> OpenRouter path even when every
# other contract (HMAC, payload, response shape) is correct.
RUNNER_OUTBOUND_USER_AGENT = 'coworker-ai-runner/0.1'
ALLOWED_WORKER_HOST_SUFFIXES = (
    '.sidekick.dev',
    '.sidekick.app',
    '.workers.dev',
)
LOCAL_WORKER_PROXY_HOSTS = ('127.0.0.1', 'localhost', '::1')
RUNNER_AUTH_MAX_SKEW_SECONDS = 300
RUNNER_WORKSPACE_DIRNAME = 'workspace'
MAX_LISTED_WORKSPACE_FILES = 500
SAFE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
# Inbound file-receive cap. Mirrors the download ceiling so the round-trip
# (user uploads -> coworker reads -> mobile downloads again) is symmetric.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
# Reject oversized uploads BEFORE the body is buffered/decoded: base64
# inflates 3 bytes -> 4 chars, and the JSON envelope adds a little on top.
MAX_UPLOAD_ENCODED_CHARS = (MAX_UPLOAD_BYTES * 4) // 3 + 8
MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_ENCODED_CHARS + 64 * 1024
MIN_WORKER_COMPLETION_TOKENS = 3000
SENSITIVE_FILE_NAME_FRAGMENTS = (
    '.env',
    'secret',
    'token',
    'password',
    'passwd',
    'credential',
    'apikey',
    'api_key',
    'private_key',
)
SAFE_SUBPROCESS_PASSTHROUGH_ENV = {
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'VIRTUAL_ENV',
    # 2026-06-04: browser toolset. Playwright (and the Node `agent-browser` CLI
    # Hermes' browser toolset drives) resolve the bundled Chromium via this var;
    # the Dockerfile sets it (/opt/playwright) but without passing it through to
    # the agent runtime, Playwright falls back to ~/.cache/ms-playwright, misses
    # the browser, and check_browser_requirements / launches fail. Same
    # allowlist-strip class as the web-search keys below (PRODUCTION_READINESS §24).
    'PLAYWRIGHT_BROWSERS_PATH',
    # 2026-06-04: web-search provider keys. Hermes' `web` toolset
    # (web_search/web_extract) is gated on one of these via check_web_api_key.
    # build_hermes_subprocess_env() filters os.environ down to this allowlist for
    # BOTH the gateway (api_server, the streaming /v1/runs path the app uses) and
    # the legacy /tasks subprocess — so without passing these through, the agent's
    # actual runtime never sees the key and silently drops web_search, even though
    # the machine env has it (PRODUCTION_READINESS §24). Keep in sync with the
    # provisioner's DELEGENT_WEB_SEARCH_ENV_PASSTHROUGH.
    'FIRECRAWL_API_KEY',
    'FIRECRAWL_API_URL',
    'SEARXNG_URL',
    'TAVILY_API_KEY',
    'EXA_API_KEY',
    'PARALLEL_API_KEY',
}


class ChatHistoryTurn(BaseModel):
    role: str
    content: str


class TaskIn(BaseModel):
    user_id: str
    instruction: str
    # Optional conversation history (oldest first) so the runner can
    # answer follow-ups with context. Chat dispatch (v1.2.7+) sends this;
    # Telegram and legacy clients can omit it.
    history: list[ChatHistoryTurn] | None = None
    # Display name the user has chosen for this coworker — passed in by
    # the chat dispatcher so the agent introduces itself by the right name
    # without the runner having to read Supabase itself.
    agent_name: str | None = None
    # 2026-06-03 critical-defect fix: set true by the chat dispatcher when it
    # could NOT load the conversation history (a transient Supabase blip). The
    # agent must then NOT claim "this is our first conversation / nothing has
    # happened" — it should acknowledge it may be missing recent context.
    history_unavailable: bool = False


# Series 4 — the golden Fly Machines image writes /etc/delegent/hermes-image.json
# at build time (see services/hermes-runner/scripts/install-hermes.sh). Public
# health responses surface only safe fields from it (version + short commit);
# never the full provenance, install timestamps, or local paths.
HERMES_IMAGE_MANIFEST_PATH = '/etc/delegent/hermes-image.json'


def _safe_hermes_image_summary() -> dict[str, str | None]:
    try:
        with open(HERMES_IMAGE_MANIFEST_PATH, 'r', encoding='utf-8') as manifest_file:
            data = json.load(manifest_file)
    except (OSError, ValueError):
        return {'version': None, 'commitShort': None}
    version = str(data.get('hermesVersion') or '').strip() or None
    commit = str(data.get('hermesCommit') or '').strip()
    commit_short = commit[:12] if commit else None
    return {'version': version, 'commitShort': commit_short}


def _hermes_available() -> bool:
    # Cheap check: the install-hermes.sh build step would have failed the
    # image build if `hermes --version` didn't exit zero, so the presence of
    # the entrypoint on PATH is enough to prove the install reached us.
    # Doing a subprocess call here on every /healthz hit would block boot
    # behind Hermes import time and is not worth it.
    hermes_path = '/usr/local/bin/hermes'
    try:
        return os.path.isfile(hermes_path) and os.access(hermes_path, os.X_OK)
    except OSError:
        return False


def _workspace_ready() -> bool:
    workspace_dir = os.getenv('SIDEKICK_WORKSPACE_DIR', '/workspace').strip() or '/workspace'
    try:
        path = Path(workspace_dir)
        return path.is_dir() and os.access(path, os.W_OK)
    except OSError:
        return False


# High-water mark of memory used, in MB, since this process started.
#
# Sampled by /healthz itself: Fly's health check already polls that endpoint on a
# schedule, so the peak updates for free. No timer, no cron, no extra process —
# which is the point. The storage ladder was built on measurements; sizing
# compute deserves the same evidence instead of an opinion, and the cheapest
# honest way to get it is to piggy-back on a poll that already happens.
#
# Reset to zero on machine restart. That is fine for its purpose: we want to know
# whether real workloads ever approach the 2 GB allocation, and a fresh window
# after a re-image is a clean measurement rather than a lost one.
_PEAK_MEMORY_USED_MB = 0


def _memory_snapshot() -> dict[str, int] | None:
    """Total / used / peak memory in MB, read from /proc/meminfo.

    cgroup counters are not usable here: a Fly Machine is a Firecracker microVM,
    not a container, so /sys/fs/cgroup/memory.peak is empty and the v1 counter
    reads 0. /proc/meminfo is the real boundary.

    "Used" is total minus MemAvailable, which is the figure that matters for
    sizing: it excludes reclaimable page cache, so it reflects memory a workload
    genuinely needs rather than memory Linux is merely holding on to.
    """
    global _PEAK_MEMORY_USED_MB
    try:
        fields: dict[str, int] = {}
        with open('/proc/meminfo', 'r', encoding='utf-8') as handle:
            for line in handle:
                key, _, rest = line.partition(':')
                value = rest.strip().split(' ', 1)[0]
                if value.isdigit():
                    fields[key] = int(value)  # kB
        total_kb = fields.get('MemTotal', 0)
        available_kb = fields.get('MemAvailable', 0)
        if total_kb <= 0:
            return None
        used_mb = max(0, (total_kb - available_kb) // 1024)
        if used_mb > _PEAK_MEMORY_USED_MB:
            _PEAK_MEMORY_USED_MB = used_mb
        return {
            'totalMb': total_kb // 1024,
            'usedMb': used_mb,
            'peakUsedMb': _PEAK_MEMORY_USED_MB,
        }
    except Exception:
        return None


def _active_window_tokens() -> int | None:
    """Rough size of the LARGEST single session's active window, in tokens.

    The 2026-08-02 token-cost incident sat unnoticed for nine days because the
    only way to see the active window was an ad-hoc sqlite query over SSH. This
    surfaces it on /healthz, so `flyctl checks list` shows it on every glance and
    the compaction watch item (docs/CHAT_MEMORY_ARCHITECTURE.md, 2026-08-02
    review) is checkable without touching the box.

    MAX-per-session, not SUM. Compaction is a per-session mechanism: it fires on
    the session whose own window crosses the threshold, and it neither knows nor
    cares what the other sessions hold. Summing was the first cut of this
    function and it was wrong — a box with many sessions (Hermes' on-box cronjob
    toolset gives every scheduled run its own) reads in the millions while every
    individual session sits comfortably under the trigger, which is a false
    alarm on precisely the busiest, most expensive boxes. Caught within an hour
    of shipping, on a real fleet box carrying 2,035 sessions.

    chars/4 is the same heuristic used everywhere else in this repo. Read-only,
    single grouped query over an indexed column; any failure returns None rather
    than failing readiness, since a missing state.db is normal before first chat.
    """
    db_path = Path(os.getenv('HERMES_HOME', '/data/hermes')) / 'state.db'
    try:
        if not db_path.is_file():
            return None
        conn = sqlite3.connect(f'file:{db_path}?mode=ro&immutable=0&nolock=0', uri=True, timeout=1.0)
        try:
            row = conn.execute(
                'SELECT COALESCE(MAX(n), 0) FROM ('
                '  SELECT SUM(LENGTH(content)) AS n FROM messages'
                '  WHERE active = 1 GROUP BY session_id'
                ')'
            ).fetchone()
        finally:
            conn.close()
        return int((row[0] or 0) // 4)
    except Exception:
        return None


def _session_count() -> int | None:
    """How many durable sessions this runner holds.

    Context for the number above, and a cost signal in its own right: sessions
    are created by the on-box cronjob toolset as well as by chat, so a runner
    quietly accumulating thousands of them is doing scheduled work nobody is
    watching. One fleet box was found with 2,035 on 2026-08-02.
    """
    db_path = Path(os.getenv('HERMES_HOME', '/data/hermes')) / 'state.db'
    try:
        if not db_path.is_file():
            return None
        conn = sqlite3.connect(f'file:{db_path}?mode=ro&immutable=0&nolock=0', uri=True, timeout=1.0)
        try:
            return int(conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] or 0)
        finally:
            conn.close()
    except Exception:
        return None


@app.get('/healthz')
def healthz() -> dict[str, Any]:
    # Unauthenticated readiness probe consumed by:
    #  - Fly Machines health checks (no HMAC headers possible)
    #  - the Cloudflare Worker's on-demand probe before dispatching tasks
    #  - the operator's verify-golden-image.sh contract check
    # Surfaces exactly enough to prove the image is the right golden one
    # and that the per-user workspace volume is mounted and writable. Never
    # exposes provider IDs, secrets, the full install manifest, or task
    # contents. See docs/releases/SERIES_4_FLY_MACHINES.md for the contract.
    image = _safe_hermes_image_summary()
    return {
        'ok': True,
        'runner': 'delegent-hermes-runner',
        'hermesAvailable': _hermes_available(),
        'workspaceReady': _workspace_ready(),
        'hermesVersion': image['version'],
        'hermesCommitShort': image['commitShort'],
        # [hermes-streaming] Public-safe view of the API-server boot state.
        # We do NOT expose the bearer key or the upstream startup command;
        # only `available` and a coarse reason string. The Worker uses this
        # to decide between the streaming and polling chat paths.
        # Honest: 'available' was set once at readiness, but the gateway child
        # can later exit (crash/OOM). Reflect actual child liveness so the Fly
        # health check + the Worker's preflight see a degraded runner (and the
        # supervisor relaunches it) instead of dispatching into a dead gateway.
        'hermesApiServerAvailable': bool(_HERMES_API_STATE.get('available')) and _gateway_process_alive(),
        'hermesApiServerReason': (
            _HERMES_API_STATE.get('startup_error')
            or ('ok' if _gateway_process_alive() else 'gateway_process_not_running')
        ),
        # Approximate tokens in the LARGEST single session's active window (null
        # before first chat). Not secret: a count, no content.
        #
        # CALIBRATION (measured 2026-08-02 on the live box): this chars/4 figure
        # over-reads real tokenizer usage by ~1.5x — it counted 70,238 while the
        # same state produced a 46,697-token prompt. Read it as a TREND, not a
        # tokenizer truth. On this metric a healthy post-compaction floor shows
        # ~70K, and sustained readings above ~110K mean auto-compaction is not
        # firing (see docs/CHAT_MEMORY_ARCHITECTURE.md, 2026-08-02 review).
        'activeWindowTokens': _active_window_tokens(),
        # Durable session count. Context for the figure above (a big number there
        # is only alarming for ONE session) and a cost signal on its own: the
        # on-box cronjob toolset mints a session per scheduled run.
        'sessionCount': _session_count(),
        # Memory telemetry for the compute-sizing decision
        # (docs/DYNAMIC_RESOURCE_SIZING.md). peakUsedMb is the number that
        # matters: every runner is allocated 2048 MB, and we do not currently
        # know whether any real workload goes near it. Not secret — a byte count,
        # no content. Null if /proc/meminfo cannot be read.
        'memory': _memory_snapshot(),
    }


@app.get('/health')
def health(request: Request):
    image = _safe_hermes_image_summary()
    payload = {
        'ok': True,
        'engine': 'hermes-agent',
        'hermesAvailable': _hermes_available(),
        'workspaceReady': _workspace_ready(),
        'hermesVersion': image['version'],
        'hermesCommitShort': image['commitShort'],
    }
    if os.getenv('SIDEKICK_ALLOW_UNSIGNED_HEALTH') == 'true' and not request.headers.get('x-sidekick-runner-token'):
        return payload
    require_sidekick_runner_authorization(request)
    return payload


def require_non_empty(value: str | None, name: str) -> str:
    if value is None or value.strip() == '':
        raise HTTPException(status_code=503, detail=f'{name}_missing')
    return value.strip()


def normalize_agent_name(value: str | None) -> str:
    normalized = ' '.join((value or '').split()).strip()[:40]
    return normalized or DEFAULT_AGENT_NAME


def local_openai_base_url(env: dict[str, str] | None = None) -> str:
    source = env if env is not None else os.environ
    port = source.get('PORT', DEFAULT_RUNNER_PORT).strip() if source.get('PORT') else DEFAULT_RUNNER_PORT
    if not port.isdigit():
        raise HTTPException(status_code=503, detail='runner_port_invalid')
    return f'http://127.0.0.1:{port}/v1'


def derive_local_adapter_api_key(shared_secret: str) -> str:
    secret = require_non_empty(shared_secret, 'sidekick_runner_shared_secret')
    digest = hmac.new(secret.encode('utf-8'), LOCAL_ADAPTER_KEY_MESSAGE, hashlib.sha256).hexdigest()
    return f'sidekick-local.{digest}'


def build_sidekick_runner_headers(user_id: str, shared_secret: str, now: int | None = None) -> dict[str, str]:
    bound_user_id = require_non_empty(user_id, 'sidekick_user_id')
    secret = require_non_empty(shared_secret, 'sidekick_runner_shared_secret')
    timestamp = str(int(now if now is not None else time.time()))
    message = f'v1:{bound_user_id}:{timestamp}'.encode('utf-8')
    digest = hmac.new(secret.encode('utf-8'), message, hashlib.sha256).hexdigest()
    return {
        'x-sidekick-user-id': bound_user_id,
        'x-sidekick-runner-timestamp': timestamp,
        'x-sidekick-runner-token': f'v1.{digest}',
    }


def _local_worker_proxy_allowed(parsed: urllib.parse.ParseResult, env: dict[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    if source.get('SIDEKICK_ALLOW_LOCAL_WORKER_PROXY') != 'true':
        return False
    if parsed.scheme != 'http':
        return False
    return (parsed.hostname or '').lower() in LOCAL_WORKER_PROXY_HOSTS


def worker_chat_completion_url(worker_proxy_url: str, env: dict[str, str] | None = None) -> str:
    raw = require_non_empty(worker_proxy_url, 'sidekick_worker_proxy_url').rstrip('/')
    parsed = urllib.parse.urlparse(raw)
    local_proxy_allowed = _local_worker_proxy_allowed(parsed, env)
    if parsed.scheme != 'https' and not local_proxy_allowed:
        raise HTTPException(status_code=503, detail='sidekick_worker_proxy_url_invalid')
    if parsed.username or parsed.password:
        raise HTTPException(status_code=503, detail='sidekick_worker_proxy_url_invalid')
    hostname = (parsed.hostname or '').lower()
    if not local_proxy_allowed and not any(hostname.endswith(suffix) for suffix in ALLOWED_WORKER_HOST_SUFFIXES):
        raise HTTPException(status_code=503, detail='sidekick_worker_proxy_url_invalid')

    if raw.endswith('/v1/chat/completions'):
        return raw
    if raw.endswith('/v1'):
        return f'{raw}/chat/completions'
    return f'{raw}/v1/chat/completions'


# The local OpenAI-compatible adapter exists ONLY for the on-box Hermes
# subprocess/gateway, but it shares the public uvicorn listener (0.0.0.0).
# Enforce the transport-level peer address in addition to the bearer
# (tracker #28). 'testclient' is Starlette's TestClient placeholder host;
# a real TCP peer can never present that literal string.
_LOOPBACK_CLIENT_HOSTS = {'127.0.0.1', '::1', 'localhost', 'testclient'}


def require_loopback_client(request: Request) -> None:
    client = request.client
    host = (client.host if client else '') or ''
    if host not in _LOOPBACK_CLIENT_HOSTS:
        raise HTTPException(status_code=403, detail='local_adapter_loopback_only')


def require_local_adapter_authorization(authorization: str | None, env: dict[str, str] | None = None) -> None:
    source = env if env is not None else os.environ
    expected = derive_local_adapter_api_key(require_non_empty(source.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'sidekick_runner_shared_secret'))
    if authorization is None or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='local_adapter_auth_required')
    token = authorization.removeprefix('Bearer ').strip()
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail='local_adapter_auth_required')


def require_sidekick_runner_authorization(request: Request, env: dict[str, str] | None = None) -> str:
    source = env if env is not None else os.environ
    shared_secret = require_non_empty(source.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'sidekick_runner_shared_secret')
    user_id = request.headers.get('x-sidekick-user-id')
    timestamp_raw = request.headers.get('x-sidekick-runner-timestamp')
    token = request.headers.get('x-sidekick-runner-token')
    if not user_id or not timestamp_raw or not token:
        raise HTTPException(status_code=401, detail='sidekick_runner_auth_required')
    user_id = user_id.strip()
    token = token.strip()
    try:
        timestamp = int(timestamp_raw.strip())
    except ValueError as exc:
        raise HTTPException(status_code=401, detail='sidekick_runner_auth_required') from exc
    if abs(int(time.time()) - timestamp) > RUNNER_AUTH_MAX_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail='sidekick_runner_auth_required')
    expected = build_sidekick_runner_headers(user_id=user_id, shared_secret=shared_secret, now=timestamp)['x-sidekick-runner-token']
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail='sidekick_runner_auth_required')
    owner_user_id = (source.get('SIDEKICK_USER_ID') or '').strip()
    if not owner_user_id:
        # Fail closed: a runner with no owner identity must not serve tasks.
        # Skipping the binding here would let any HMAC-valid user id through
        # if the provisioner ever failed to inject SIDEKICK_USER_ID.
        raise HTTPException(status_code=503, detail='runner_owner_unbound')
    if not hmac.compare_digest(user_id, owner_user_id):
        raise HTTPException(status_code=403, detail='task_user_mismatch')
    return user_id


def build_hermes_subprocess_env(env: dict[str, str] | None = None) -> dict[str, str]:
    source = dict(env if env is not None else os.environ)
    shared_secret = require_non_empty(source.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'sidekick_runner_shared_secret')
    base_url = local_openai_base_url(source)
    agent_name = normalize_agent_name(source.get('SIDEKICK_AGENT_NAME') or source.get('HERMES_AGENT_NAME'))
    sanitized: dict[str, str] = {
        key: value
        for key, value in source.items()
        if key in SAFE_SUBPROCESS_PASSTHROUGH_ENV and isinstance(value, str) and value.strip() != ''
    }
    model = source.get('HERMES_MODEL', 'openrouter/auto')
    sanitized.update({
        'HERMES_HOME': source.get('HERMES_HOME', '/data/hermes'),
        'HERMES_TOOLSETS': source.get('HERMES_TOOLSETS', 'file,web'),
        'SIDEKICK_AGENT_NAME': agent_name,
        'HERMES_AGENT_NAME': agent_name,
        # Never write .pyc bytecode caches. The gateway and every script it
        # spawns (agent-authored cron jobs included) inherit this. Stale
        # __pycache__/*.pyc silently ran OLD code after an agent edited a cron
        # script in place — the source said one thing, behaviour came from the
        # cached bytecode (real report from a tester's inbox-monitor script,
        # 2026-07-22). Disabling the cache costs a negligible re-parse and kills
        # the whole class of "I fixed it but it still does the old thing" bugs.
        'PYTHONDONTWRITEBYTECODE': '1',
        # Hermes resolves config.yaml's provider before environment fallbacks, so
        # create_task also passes --provider/--model explicitly.  Keep these env
        # vars aligned for auxiliary clients and any child Hermes subprocesses.
        'HERMES_INFERENCE_PROVIDER': 'custom',
        'HERMES_INFERENCE_MODEL': model,
        'HERMES_MODEL_PROVIDER': 'custom',
        'HERMES_MODEL': model,
        'HERMES_MODEL_BASE_URL': base_url,
        'CUSTOM_BASE_URL': base_url,
        'OPENAI_BASE_URL': base_url,
        'OPENAI_API_KEY': derive_local_adapter_api_key(shared_secret),
        'HERMES_API_KEY': derive_local_adapter_api_key(shared_secret),
    })
    # Timezone: the container is UTC by default, so agent-written scripts that
    # display times (cron notifications etc.) showed raw UTC to the user
    # ("21:10 UTC" for a 22:10 BST event) — a recurring tester complaint. Pass
    # a per-machine TZ through when ops sets one (a plain IANA name like
    # Europe/London via `fly machine update --env TZ=...`), so a single-user
    # runner shows local time everywhere with no per-script effort. Left unset
    # the container stays UTC (safe default); the system prompt also tells the
    # agent to set the user's timezone when it writes a time-displaying script.
    _tz = (source.get('TZ') or '').strip()
    if _tz:
        sanitized['TZ'] = _tz
    return sanitized


def build_worker_chat_request(payload: dict[str, Any], env: dict[str, str] | None = None, now: int | None = None) -> tuple[str, dict[str, str], bytes]:
    source = env if env is not None else os.environ
    user_id = require_non_empty(source.get('SIDEKICK_USER_ID'), 'sidekick_user_id')
    worker_proxy_url = require_non_empty(source.get('SIDEKICK_WORKER_PROXY_URL'), 'sidekick_worker_proxy_url')
    shared_secret = require_non_empty(source.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'sidekick_runner_shared_secret')
    body = json.dumps(build_worker_chat_payload(payload), separators=(',', ':')).encode('utf-8')
    headers = {
        'content-type': 'application/json',
        'user-agent': RUNNER_OUTBOUND_USER_AGENT,
        **build_sidekick_runner_headers(user_id=user_id, shared_secret=shared_secret, now=now),
    }
    return worker_chat_completion_url(worker_proxy_url, source), headers, body


def build_worker_chat_payload(payload: dict[str, Any]) -> dict[str, Any]:
    outbound = dict(payload)
    max_tokens = outbound.get('max_tokens')
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, (int, float)) or max_tokens <= 0:
        outbound['max_tokens'] = MIN_WORKER_COMPLETION_TOKENS
    # Preserve the gateway's streaming request so token-by-token deltas flow
    # all the way through (worker proxy then relays OpenRouter's SSE). The
    # non-streaming callers (legacy /tasks) never set stream, so this stays
    # False for them.
    outbound['stream'] = bool(payload.get('stream'))
    outbound['reasoning'] = {'effort': 'none', 'exclude': True}
    return outbound


def completion_json_to_sse(content: bytes) -> bytes:
    try:
        parsed = json.loads(content.decode('utf-8'))
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    choice = (parsed.get('choices') or [{}])[0] if isinstance(parsed.get('choices'), list) else {}
    message = choice.get('message') if isinstance(choice, dict) else {}
    text = ''
    tool_calls: list[dict[str, Any]] = []
    if isinstance(message, dict):
        content_value = message.get('content')
        if isinstance(content_value, str):
            text = content_value
        raw_tool_calls = message.get('tool_calls')
        if isinstance(raw_tool_calls, list):
            for index, raw_call in enumerate(raw_tool_calls):
                if not isinstance(raw_call, dict):
                    continue
                raw_function = raw_call.get('function')
                function = raw_function if isinstance(raw_function, dict) else {}
                name = function.get('name') if isinstance(function.get('name'), str) else ''
                raw_arguments = function.get('arguments')
                if isinstance(raw_arguments, str):
                    arguments = raw_arguments
                elif raw_arguments is None:
                    arguments = ''
                else:
                    arguments = json.dumps(raw_arguments, separators=(',', ':'))
                tool_call: dict[str, Any] = {
                    'index': index,
                    'id': raw_call.get('id') if isinstance(raw_call.get('id'), str) else f'call_{uuid.uuid4().hex}',
                    'type': raw_call.get('type') if isinstance(raw_call.get('type'), str) else 'function',
                    'function': {
                        'name': name,
                        'arguments': arguments,
                    },
                }
                tool_calls.append(tool_call)
    chunk_id = parsed.get('id') if isinstance(parsed.get('id'), str) else f'chatcmpl-sidekick-{uuid.uuid4().hex}'
    created = parsed.get('created') if isinstance(parsed.get('created'), int) else int(time.time())
    model = parsed.get('model') if isinstance(parsed.get('model'), str) else 'coworker-ai'

    def event(delta: dict[str, Any], finish_reason: str | None = None) -> str:
        return 'data: ' + json.dumps({
            'id': chunk_id,
            'object': 'chat.completion.chunk',
            'created': created,
            'model': model,
            'choices': [{
                'index': 0,
                'delta': delta,
                'finish_reason': finish_reason,
            }],
        }, separators=(',', ':')) + '\n\n'

    chunks = [event({'role': 'assistant'})]
    if text:
        chunks.append(event({'content': text}))
    for tool_call in tool_calls:
        chunks.append(event({'tool_calls': [tool_call]}))
    finish_reason = choice.get('finish_reason') if isinstance(choice, dict) and isinstance(choice.get('finish_reason'), str) else None
    chunks.append(event({}, finish_reason or ('tool_calls' if tool_calls else 'stop')))
    chunks.append('data: [DONE]\n\n')
    return ''.join(chunks).encode('utf-8')


def _secret_values(env: dict[str, str] | None = None) -> list[str]:
    source = env if env is not None else os.environ
    values = []
    # The web-search keys are deliberately passed through to the agent, but
    # they are SHARED across every user's box — if agent output echoes the
    # env (stack trace, printenv) they must never reach task records/mobile.
    for key in (
        'SIDEKICK_RUNNER_SHARED_SECRET',
        'OPENAI_API_KEY',
        'HERMES_API_KEY',
        'FIRECRAWL_API_KEY',
        'TAVILY_API_KEY',
        'EXA_API_KEY',
        'PARALLEL_API_KEY',
    ):
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    shared_secret = source.get('SIDEKICK_RUNNER_SHARED_SECRET')
    if isinstance(shared_secret, str) and shared_secret.strip():
        values.append(derive_local_adapter_api_key(shared_secret))
    return values


_VAULT_REDACTION_CACHE: dict[str, Any] = {'sig': None, 'values': []}


def _vault_secret_values() -> list[str]:
    """Every string secret currently in the per-user credential vault, so
    egress redaction can scrub a stored credential a tool echoes back (a
    connect script printing a token inside an error message, a log line).
    The vault already runs on this box with its own key, so decrypting here
    adds no new custody. Best-effort by design: any failure (no vault yet,
    library not seeded, unreadable entry) just redacts nothing extra. Cached
    against the vault files' stat signature so the common no-change case
    costs stat() calls, not a decrypt."""
    try:
        cred_dir = Path(os.environ.get('HERMES_HOME', '/data/hermes')) / 'credentials'
        if not cred_dir.is_dir():
            return []
        files = sorted(cred_dir.glob('*.cred'))
        if not files:
            return []
        sig = tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in files)
        if _VAULT_REDACTION_CACHE['sig'] == sig:
            return list(_VAULT_REDACTION_CACHE['values'])
        store = _credential_store_module()
        values: list[str] = []

        def collect(node: Any) -> None:
            if isinstance(node, str):
                candidate = node.strip()
                if len(candidate) >= 8:
                    values.append(candidate)
            elif isinstance(node, dict):
                for item in node.values():
                    collect(item)
            elif isinstance(node, (list, tuple)):
                for item in node:
                    collect(item)

        for p in files:
            try:
                collect(store.get(p.stem).get('_secret'))
            except Exception:  # noqa: BLE001 - an unreadable entry redacts nothing
                continue
        _VAULT_REDACTION_CACHE['sig'] = sig
        _VAULT_REDACTION_CACHE['values'] = values
        return list(values)
    except Exception:  # noqa: BLE001 - redaction must never break egress
        return []


def redact_runner_secrets(text: str, env: dict[str, str] | None = None) -> str:
    redacted = text
    for secret in _secret_values(env):
        redacted = redacted.replace(secret, '[REDACTED]')
    for secret in _vault_secret_values():
        redacted = redacted.replace(secret, '[REDACTED]')
    return redacted


def _header_pairs_from_raw(raw_headers: list[tuple[bytes, bytes]] | tuple[tuple[bytes, bytes], ...]) -> list[tuple[str, str]]:
    return [
        (name.decode('latin-1', 'replace'), value.decode('latin-1', 'replace'))
        for name, value in raw_headers
    ]


_SENSITIVE_CAPTURE_HEADER_NAMES = {
    'authorization',
    'proxy-authorization',
    'x-sidekick-runner-token',
    'x-api-key',
}


def _redact_capture_value(value: Any) -> Any:
    """Recursively redact credential-bearing header values in capture payloads.

    Headers appear either as dicts or as (name, value) pair lists; bodies are
    left verbatim (that's what the capture is for), but bearer tokens and
    runner HMACs never need to be readable to debug a payload issue.
    """
    if isinstance(value, dict):
        return {
            key: (
                '[REDACTED]'
                if isinstance(key, str) and key.lower() in _SENSITIVE_CAPTURE_HEADER_NAMES and isinstance(item, str)
                else _redact_capture_value(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            if (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and isinstance(item[0], str)
                and item[0].lower() in _SENSITIVE_CAPTURE_HEADER_NAMES
            ):
                out.append([item[0], '[REDACTED]'])
            else:
                out.append(_redact_capture_value(item))
        return out
    return value


def write_debug_capture(stage: str, payload: dict[str, Any]) -> None:
    """Write debug captures to a local 0600 JSON file when enabled.

    Request/response bodies are kept verbatim (that is the point of a capture),
    but credential-bearing headers (adapter bearer, runner HMAC token) are
    redacted. Only written when SIDEKICK_DEBUG_CAPTURE_DIR is set for a local
    investigation; never enable it on a production Machine.
    """
    capture_dir = os.getenv('SIDEKICK_DEBUG_CAPTURE_DIR')
    if not capture_dir:
        return
    root = Path(capture_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{int(time.time() * 1000)}_{uuid.uuid4().hex}_{stage}.json"
    data = {
        'stage': stage,
        'capturedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        **_redact_capture_value(payload),
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


def runner_hermes_home(env: dict[str, str] | None = None) -> Path:
    source = env if env is not None else os.environ
    home = require_non_empty(source.get('HERMES_HOME', '/data/hermes'), 'hermes_home')
    return Path(home).expanduser()


def runner_workspace_root(env: dict[str, str] | None = None) -> Path:
    return runner_hermes_home(env) / RUNNER_WORKSPACE_DIRNAME


_WORKSPACE_SEEDED_MARKER = '.delegent-workspace-seeded'


def _seed_runner_workspace(root: Path) -> None:
    """Seed the user's workspace with the standard top-level directories
    Alex asked for in v1.2.8 (DN8). The Hermes runner workspace IS the
    user's writable surface — without these the Files tab is empty by
    default, which made users wonder whether their box even existed.

    Tests that want a deterministic empty workspace can set
    DELEGENT_SKIP_WORKSPACE_SEED=1 in os.environ to bypass.

    The marker file is created at the end so this work runs exactly
    once per workspace; subsequent runner restarts skip seeding.
    """
    if os.getenv('DELEGENT_SKIP_WORKSPACE_SEED') == '1':
        return
    marker = root / _WORKSPACE_SEEDED_MARKER
    if marker.exists():
        return

    # Lowercase top-level names so the existing _unsafe_workspace_name
    # check doesn't accidentally filter a future "TOKEN" folder, and so
    # the visible filesystem looks like a quiet personal Linux home.
    # [R4] The mobile Files tab renders these default top-level folders:
    # Home, Documents, Pictures, Downloads, Notes, Uploads. Seed all of
    # them so the filesystem the runner sees matches the drawer the user
    # sees, and so an agent told to "save it in Pictures" finds an existing
    # directory instead of having to mkdir. The legacy `code/` seed is
    # kept for backwards-compat with skills that touch it, but it's
    # NOT in the default user-facing folder set.
    seeds: list[tuple[str, str]] = [
        ('home/README.md',
         "# Home\n\nThis is your coworker's home directory. Files saved by default land here.\n"),
        ('documents/getting-started.md',
         "# Documents\n\nAsk your coworker to draft, summarise, or store any document here.\n"
         "Try: \"Write a one-page brief about my product and save it in Documents.\"\n"),
        ('pictures/README.md',
         "# Pictures\n\nImages your coworker generates or downloads land here. Drag screenshots in via chat to ask about them.\n"),
        ('downloads/README.md',
         "# Downloads\n\nDownloads from the web or files shared by your coworker land here.\n"),
        ('code/example.py',
         "# Code\n# Your coworker can edit and run code in this folder.\n"
         "print('Hello from your Delegent AI coworker!')\n"),
        ('notes/welcome.md',
         "# Notes\n\nA scratchpad your coworker can append to. Ask them to log anything you mention\n"
         "in chat so you never lose context across sessions.\n"),
        ('uploads/README.md',
         "# Uploads\n\nFiles you upload to your coworker land here. Ask them to read, summarise, or\n"
         "work with anything you've just shared.\n"),
    ]
    for relative, body in seeds:
        target = root / relative
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_text(body, encoding='utf-8')
        except OSError:
            # Best-effort — a single failure shouldn't block the workspace
            # being usable.
            continue
    try:
        marker.write_text('seeded', encoding='utf-8')
    except OSError:
        # If we can't write the marker, seeding will re-run on the next
        # call. That's harmless; files use exist-check before write.
        pass


# The agent's shell resolves `~` to /home/delegent, which is EPHEMERAL
# container disk (a fresh rootfs on every machine stop/update), while the
# user's durable, app-visible surface is the workspace VOLUME. Live defect
# (2026-06-11): the agent saved a user's hello-world app under ~/Documents;
# the machine auto-stopped minutes later and the files were DESTROYED, and the
# app's Files tab (which reads the workspace) never showed them at all. Fix:
# map the home-dir folder names an agent naturally reaches for onto the
# workspace via symlinks at boot, and RESCUE any real directory already
# squatting the name (move its contents into the workspace target first), so
# a stray write that happened before the links existed is recovered, not lost.
# (Capitalized variants cover the XDG names a Linux-trained model writes.)
_HOME_WORKSPACE_LINKS: tuple[tuple[str, str], ...] = (
    ('Documents', 'documents'),
    ('Downloads', 'downloads'),
    ('Pictures', 'pictures'),
    ('Desktop', 'home'),
    ('Notes', 'notes'),
    ('documents', 'documents'),
    ('downloads', 'downloads'),
    ('pictures', 'pictures'),
    ('notes', 'notes'),
    ('uploads', 'uploads'),
    ('code', 'code'),
)
# Only auto-link when running AS the runner (the image's baked-in home). This
# function must never touch a developer's real $HOME during local runs/tests;
# unit tests call link_home_dirs_into_workspace directly with tmp paths.
_RUNNER_HOME_DIR = Path('/home/delegent')


def link_home_dirs_into_workspace(workspace_root: Path, home_dir: Path) -> None:
    """Idempotently symlink home-dir folder names onto workspace folders,
    rescuing the contents of any pre-existing real directory into the
    workspace target first. Best-effort per entry; never raises."""
    for name, target_rel in _HOME_WORKSPACE_LINKS:
        link = home_dir / name
        target = workspace_root / target_rel
        try:
            target.mkdir(parents=True, exist_ok=True)
            if link.is_symlink():
                # Repoint a stale link (e.g. the workspace path moved).
                if link.resolve() != target.resolve():
                    link.unlink()
                    link.symlink_to(target)
                continue
            if link.is_dir():
                # Rescue: move every child into the workspace target (skip
                # name collisions rather than overwrite), then replace the
                # now-empty dir with the symlink. If anything remains (a
                # collision), keep the real dir; the next boot retries.
                for child in list(link.iterdir()):
                    destination = target / child.name
                    if not destination.exists():
                        shutil.move(str(child), str(destination))
                link.rmdir()
            elif link.exists():
                # A stray FILE squatting the folder name; move it aside into
                # the target so the symlink can exist.
                destination = target / name
                if destination.exists():
                    continue
                shutil.move(str(link), str(destination))
            link.symlink_to(target)
        except OSError:
            continue


# Stray user folders at the HERMES_HOME root (the volume root): the pre-Route-B
# layout mounted the volume at .../workspace, so its ROOT held the user dirs;
# after the remount they sit at $HERMES_HOME/<name>, invisible to the app's
# Files tab (which lists workspace/). Merge their contents into the workspace
# counterparts at boot (no-overwrite), so legacy files become visible again.
# 'home' is deliberately EXCLUDED: $HERMES_HOME/home is Hermes' tool-HOME
# activation dir (see link target note below) and must keep existing.
_VOLUME_ROOT_RESCUE_DIRS: tuple[str, ...] = (
    'documents', 'downloads', 'pictures', 'notes', 'uploads',
    'office', 'bookkeeping', 'code',
)


def rescue_stray_volume_root_dirs(workspace_root: Path, hermes_home: Path) -> None:
    """Merge legacy user folders found at the HERMES_HOME root into the
    workspace (no-overwrite; an emptied stray dir is removed). Best-effort."""
    for name in _VOLUME_ROOT_RESCUE_DIRS:
        stray = hermes_home / name
        target = workspace_root / name
        try:
            if stray.is_symlink() or not stray.is_dir():
                continue
            if stray.resolve() == target.resolve():
                continue
            target.mkdir(parents=True, exist_ok=True)
            for child in list(stray.iterdir()):
                destination = target / child.name
                if not destination.exists():
                    shutil.move(str(child), str(destination))
            stray.rmdir()  # only succeeds when fully merged
        except OSError:
            continue


def _maybe_link_home_dirs(workspace_root: Path) -> None:
    if os.getenv('DELEGENT_SKIP_HOME_LINKS') == '1':
        return
    try:
        if Path.home() != _RUNNER_HOME_DIR or not _RUNNER_HOME_DIR.is_dir():
            return  # not a runner box; never touch a developer's home
        # 1. The wrapper/user home (processes without Hermes' override).
        link_home_dirs_into_workspace(workspace_root, _RUNNER_HOME_DIR)
        # 2. The AGENT'S actual home: Hermes injects HOME=$HERMES_HOME/home
        #    into every tool subprocess whenever that directory exists
        #    (hermes_constants: "Docker persistence", directory-activated).
        #    This is where `~/Documents` REALLY resolves for the agent — the
        #    second half of the 2026-06-11 lost-files defect: the recreated
        #    hello-world landed at /data/hermes/home/Documents, durable but
        #    invisible to the app. Create the dir (making the override
        #    deterministic rather than layout-dependent) and install the same
        #    links + rescue there, so the agent's home-dir writes land on the
        #    app-visible workspace. Dotfiles (.cache/.config) keep landing in
        #    $HERMES_HOME/home itself, off the user's Files tab.
        hermes_home = Path(os.getenv('HERMES_HOME', '/data/hermes'))
        tool_home = hermes_home / 'home'
        tool_home.mkdir(parents=True, exist_ok=True)
        link_home_dirs_into_workspace(workspace_root, tool_home)
        # 3. Legacy strays at the volume root (pre-remount layout leftovers).
        rescue_stray_volume_root_dirs(workspace_root, hermes_home)
    except (OSError, RuntimeError):
        pass


def ensure_runner_workspace(env: dict[str, str] | None = None) -> Path:
    root = runner_workspace_root(env)
    root.mkdir(parents=True, exist_ok=True)
    _seed_runner_workspace(root)
    _maybe_link_home_dirs(root)
    return root


def workspace_file_id(relative_name: str) -> str:
    digest = hashlib.sha256(relative_name.encode('utf-8')).hexdigest()[:32]
    return f'file_{digest}'


def _path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _unsafe_workspace_name(path: Path) -> bool:
    for part in path.parts:
        if part.startswith('.'):
            return True
        lowered = part.lower()
        if lowered.endswith(('.pem', '.key', '.p12', '.pfx')):
            return True
        if any(fragment in lowered for fragment in SENSITIVE_FILE_NAME_FRAGMENTS):
            return True
    return False


def _safe_workspace_file(root: Path, path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    root_resolved = root.resolve()
    try:
        resolved = path.resolve(strict=True)
        relative = resolved.relative_to(root_resolved)
        stat = resolved.stat()
    except (OSError, ValueError):
        return False
    if _unsafe_workspace_name(relative):
        return False
    if stat.st_size > SAFE_DOWNLOAD_MAX_BYTES:
        return False
    return _path_is_relative_to(resolved, root_resolved)


def _workspace_file_record(root: Path, path: Path) -> dict[str, Any]:
    root_resolved = root.resolve()
    resolved = path.resolve(strict=True)
    relative_name = resolved.relative_to(root_resolved).as_posix()
    stat = resolved.stat()
    mime_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return {
        'id': workspace_file_id(relative_name),
        'name': path.name,
        'relativeName': relative_name,
        'sizeBytes': stat.st_size,
        'modifiedAt': int(stat.st_mtime),
        'mimeType': mime_type,
        'downloadable': True,
    }


# Build-artifact / VCS noise that clutters the Files listing and is never
# user-relevant (a cloned repo or `pip install` drags in hundreds of these).
# Excluded BEFORE the cap so the cap shows real files, mirroring the mobile
# client's folderGroups.isNoiseFile so both ends agree on what counts as a file.
_NOISE_DIR_SEGMENTS = {'__pycache__', 'node_modules', '.git', '.venv', 'venv', '.next', '.cache', '.pytest_cache', '.mypy_cache'}
_NOISE_DIR_SUFFIXES = ('.egg-info',)
_NOISE_NAME_SUFFIXES = ('.pyc', '.pyo', '.class', '.ds_store', '.map.js', '.map')


def _is_noise_workspace_path(relative_name: str) -> bool:
    rel = relative_name.replace('\\', '/').lower()
    for seg in rel.split('/'):
        if seg in _NOISE_DIR_SEGMENTS:
            return True
        if any(seg.endswith(suffix) for suffix in _NOISE_DIR_SUFFIXES):
            return True
    return any(rel.endswith(suffix) for suffix in _NOISE_NAME_SUFFIXES)


# Perf backstop for the pruned walk below: stop scanning after this many
# FILE candidates. With noise pruning a real user workspace is a few hundred
# files, so hitting this means something pathological; the listing stays fast
# and reports truncated=True instead of grinding.
MAX_SCANNED_WORKSPACE_FILES = 20_000


def _is_prunable_dir_name(name: str) -> bool:
    lowered = name.lower()
    if name.startswith('.'):
        return True  # dot-dirs are unsafe (_unsafe_workspace_name) — never descend
    if lowered in _NOISE_DIR_SEGMENTS:
        return True
    return any(lowered.endswith(suffix) for suffix in _NOISE_DIR_SUFFIXES)


def _iter_workspace_candidates(root: Path, stats: dict[str, Any] | None = None):
    """Yield (path, relative_name) for every non-noise file in the workspace.

    ONE walk shared by the listing and the per-file resolver, so the two can
    never disagree about which files exist (they did between 2026-07-22 and
    2026-07-27, which is what broke delete). Noise and dot directories are
    pruned IN PLACE, so the walk never descends into node_modules or .git.
    """
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = [d for d in dirnames if not _is_prunable_dir_name(d)]
        for name in filenames:
            scanned += 1
            if scanned > MAX_SCANNED_WORKSPACE_FILES:
                if stats is not None:
                    stats['capped'] = True
                return
            candidate = Path(dirpath) / name
            try:
                rel = candidate.relative_to(root).as_posix()
            except ValueError:
                rel = candidate.name
            if _is_noise_workspace_path(rel):
                continue
            yield candidate, rel


def list_safe_workspace_files(env: dict[str, str] | None = None, limit: int = MAX_LISTED_WORKSPACE_FILES) -> tuple[list[dict[str, Any]], bool]:
    # PERF (2026-07-22, live "Files didn't refresh" incident): this used to
    # `sorted(root.rglob('*'))` — walking AND sorting every path under the
    # workspace before any filtering. A workspace with a few cloned/scaffolded
    # projects holds tens of thousands of node_modules/.git paths (live:
    # 29,706 paths, 64 node_modules dirs), which took 3-5s at idle and blew
    # past the proxy's 12s ceiling whenever the agent had the CPU busy — the
    # app then showed "Files didn't refresh". os.walk with IN-PLACE pruning
    # never descends into noise/dot directories, so the walk touches only the
    # few hundred real files.
    root = ensure_runner_workspace(env)
    records: list[dict[str, Any]] = []
    stats: dict[str, Any] = {}
    try:
        for candidate, _rel in _iter_workspace_candidates(root, stats):
            if not _safe_workspace_file(root, candidate):
                continue
            records.append(_workspace_file_record(root, candidate))
    except OSError:
        return records, False
    records.sort(key=lambda item: (-int(item.get('modifiedAt') or 0), item.get('relativeName') or item.get('name') or ''))
    truncated = bool(stats.get('capped')) or len(records) > limit
    return records[:limit], truncated


def resolve_safe_workspace_file(file_id: str, env: dict[str, str] | None = None) -> tuple[Path, str]:
    if not file_id.startswith('file_') or len(file_id) != 37:
        raise HTTPException(status_code=404, detail='file_not_found')
    # PERF (2026-07-27, live "cannot delete them right now" report): this used
    # to `sorted(root.rglob('*'))` and then stat + hash EVERY path until it hit
    # a match — the same unpruned walk the listing was fixed for on 2026-07-22,
    # but worse. On a real workspace (~30k node_modules paths) one delete took
    # ~4s at idle on fast local disk, so on a shared-CPU machine with a network
    # volume it blew the Worker's 12s ceiling and delete, rename and preview all
    # failed on both the app and the web app. The id is a hash of the RELATIVE
    # PATH, so a non-match now costs one sha256 of a short string instead of a
    # stat and a record build, and the walk skips noise directories entirely.
    root = ensure_runner_workspace(env)
    try:
        for candidate, relative_name in _iter_workspace_candidates(root):
            if not hmac.compare_digest(workspace_file_id(relative_name), file_id):
                continue
            # Only the matched path pays for the safety checks, and it still
            # pays for ALL of them: the guarantees here are unchanged.
            if not _safe_workspace_file(root, candidate):
                break
            record = _workspace_file_record(root, candidate)
            if hmac.compare_digest(record['id'], file_id):
                return candidate.resolve(strict=True), record['name']
            break
    except OSError as exc:
        raise HTTPException(status_code=404, detail='file_not_found') from exc
    raise HTTPException(status_code=404, detail='file_not_found')


@app.get('/files')
def list_runner_files(request: Request):
    require_sidekick_runner_authorization(request)
    files, truncated = list_safe_workspace_files()
    return {
        'ok': True,
        'files': files,
        'truncated': truncated,
    }


@app.get('/files/{file_id}')
def download_runner_file(file_id: str, request: Request):
    require_sidekick_runner_authorization(request)
    path, filename = resolve_safe_workspace_file(file_id)
    media_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    return FileResponse(
        path=str(path),
        filename=filename,
        media_type=media_type,
        headers={
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
        },
    )


@app.delete('/files/{file_id}')
def delete_runner_file(file_id: str, request: Request):
    # Delete a user file (Files edit feature). Only ever a file the
    # listing/download path already deems safe: resolve_safe_workspace_file 404s
    # unless the id maps to a real file INSIDE the workspace that is not a
    # symlink, dotfile, or sensitive-named file — so there is no path-traversal
    # or secret-deletion vector. NEVER leak the absolute path or the user id.
    require_sidekick_runner_authorization(request)
    path, filename = resolve_safe_workspace_file(file_id)
    try:
        path.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail='delete_failed') from exc
    return {'ok': True, 'deleted': filename}


@app.post('/files/{file_id}/rename')
async def rename_runner_file(file_id: str, request: Request):
    # Rename a user file in place (same folder). The new name must be a PLAIN
    # filename: no path separators or traversal, no leading dot, no sensitive
    # name, and the resolved target must still sit inside the workspace. The file
    # id is a hash of the relative path, so the returned record carries a NEW id
    # — the client must refresh its listing after a rename.
    require_sidekick_runner_authorization(request)
    path, _filename = resolve_safe_workspace_file(file_id)
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    new_name = body.get('newName') if isinstance(body, dict) else None
    if not isinstance(new_name, str) or not new_name.strip():
        raise HTTPException(status_code=400, detail='invalid_file_name')
    new_name = new_name.strip()
    if ('/' in new_name or '\\' in new_name or new_name.startswith('.')
            or new_name in ('.', '..') or _unsafe_workspace_name(Path(new_name))):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    root = ensure_runner_workspace()
    target = path.parent / new_name
    try:
        resolved_target = target.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail='invalid_file_name') from exc
    if not _path_is_relative_to(resolved_target, root.resolve()):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    if target.exists():
        raise HTTPException(status_code=409, detail='file_exists')
    try:
        path.rename(target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail='rename_failed') from exc
    return {'ok': True, 'file': _workspace_file_record(root, target)}


@app.post('/files')
async def upload_runner_file(request: Request):
    # Inbound file-receive (layer 1 of the file-upload feature). The user
    # uploads a file TO their coworker; it lands in workspace/uploads/ so the
    # agent can read it ("summarise the file I just uploaded"). Shares the
    # /files path with the GET listing/download handlers above — distinct
    # method, same auth. NEVER leak the runner secret, the absolute path, or
    # the user id in the response or any error detail.
    require_sidekick_runner_authorization(request)

    # Size gate BEFORE the body is read into memory: a declared
    # Content-Length over the ceiling is rejected without buffering.
    content_length = request.headers.get('content-length')
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail='file_too_large')

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail='invalid_json')

    name = body.get('name')
    content_base64 = body.get('contentBase64')
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail='invalid_file_name')
    if not isinstance(content_base64, str):
        raise HTTPException(status_code=400, detail='invalid_file_content')
    # Encoded-length gate BEFORE decoding, so an oversized payload is never
    # base64-decoded into a second in-memory copy.
    if len(content_base64) > MAX_UPLOAD_ENCODED_CHARS:
        raise HTTPException(status_code=413, detail='file_too_large')

    # Decode strictly; reject malformed base64 rather than silently writing
    # a truncated/garbage file.
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail='invalid_file_content') from exc
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail='file_too_large')

    # The name must be a bare filename — no directory components at all. We
    # check separators ourselves first (defense in depth) then run it through
    # the same sensitive-name filter the GET listing uses so an uploaded
    # `.env` / secret / key never lands in the workspace.
    candidate = name.strip()
    if '/' in candidate or '\\' in candidate or candidate in ('.', '..'):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    name_path = Path(candidate)
    if name_path.name != candidate or name_path.parent != Path('.'):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    if _unsafe_workspace_name(name_path):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    safe_name = name_path.name

    root = ensure_runner_workspace()
    root_resolved = root.resolve()
    target_dir = root / 'uploads'
    # Create uploads/ inside the handler — contract tests run with
    # DELEGENT_SKIP_WORKSPACE_SEED=1, so we can't rely on the seed step.
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail='workspace_unavailable') from exc

    # Containment: the resolved upload dir must stay inside the workspace.
    if not _path_is_relative_to(target_dir.resolve(), root_resolved):
        raise HTTPException(status_code=400, detail='invalid_file_name')

    # Pick a final filename, auto-suffixing rather than overwriting so an
    # upload never clobbers an existing file. Stop after a sane bound.
    stem = name_path.stem
    suffix = name_path.suffix
    target = target_dir / safe_name
    counter = 1
    while target.exists() or target.is_symlink():
        target = target_dir / f'{stem}-{counter}{suffix}'
        counter += 1
        if counter > 10000:
            raise HTTPException(status_code=409, detail='file_exists')

    # Re-validate the chosen name and its containment (the auto-suffixed name
    # could in theory re-trip the sensitive filter; resolve stays in-tree).
    if _unsafe_workspace_name(Path(target.name)):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    target_parent_resolved = target.parent.resolve()
    if not _path_is_relative_to(target_parent_resolved, root_resolved):
        raise HTTPException(status_code=400, detail='invalid_file_name')
    if not _path_is_relative_to((target_parent_resolved / target.name), root_resolved):
        raise HTTPException(status_code=400, detail='invalid_file_name')

    # Write atomically: temp file in the same dir, then os.replace onto the
    # final name. A crash mid-write leaves the temp file, never a partial
    # target. delete=False so we own the rename.
    tmp_fd, tmp_path = tempfile.mkstemp(dir=str(target_dir), prefix='.upload-', suffix='.tmp')
    try:
        with os.fdopen(tmp_fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target)
    except OSError as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail='file_write_failed') from exc

    return {'ok': True, 'file': _workspace_file_record(root, target)}


@app.post('/v1/chat/completions')
async def proxy_chat_completions(request: Request):
    require_loopback_client(request)
    require_local_adapter_authorization(request.headers.get('authorization'))
    raw_body = await request.body()
    try:
        payload = json.loads(raw_body.decode('utf-8'))
    except Exception as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    wants_stream = payload.get('stream') is True

    write_debug_capture('adapter_inbound_request', {
        'request': {
            'method': request.method,
            'url': str(request.url),
            'headers': _header_pairs_from_raw(request.headers.raw),
            'body': raw_body.decode('utf-8', 'replace'),
            'parsedBody': payload,
        },
    })

    url, headers, body = build_worker_chat_request(payload)
    write_debug_capture('adapter_outbound_worker_request', {
        'request': {
            'method': 'POST',
            'url': url,
            'headers': list(headers.items()),
            'body': body.decode('utf-8', 'replace'),
            'parsedBody': payload,
        },
    })
    if wants_stream:
        # Token-by-token: stream the worker proxy's SSE straight back to the
        # Hermes gateway instead of buffering it, so the gateway emits text
        # deltas as they generate (the live "typing" in the chat). The worker
        # has already scrubbed provider internals and records usage from the
        # final chunk, so we just relay the bytes.
        #
        # 2026-07-04 provider-error incident: the Worker's HTTP status MUST be
        # propagated. The old relay wrapped this call in a StreamingResponse
        # without checking the status, so every Worker error (401 auth blip,
        # 402 quota, 5xx upstream) reached Hermes as an HTTP-200 empty SSE
        # stream — unclassifiable ("empty stream with no finish_reason"),
        # burning the whole retry budget in seconds and killing the turn. Open
        # the upstream response first; a non-200 is returned as-is (the
        # Worker's error bodies are already user-safe JSON) so the OpenAI
        # client raises a classifiable APIStatusError instead.
        client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, read=300.0))
        try:
            upstream = await client.send(
                client.build_request('POST', url, content=body, headers=headers),
                stream=True,
            )
        except Exception as exc:  # noqa: BLE001 — httpx raises many transport classes
            await client.aclose()
            write_debug_capture('adapter_inbound_worker_response', {'error': repr(exc)})
            return JSONResponse({'error': 'worker_proxy_unavailable'}, status_code=502)
        if upstream.status_code != 200:
            error_body = await upstream.aread()
            await upstream.aclose()
            await client.aclose()
            write_debug_capture('adapter_inbound_worker_response', {
                'response': {
                    'status': upstream.status_code,
                    'headers': list(upstream.headers.items()),
                    'body': error_body.decode('utf-8', 'replace'),
                },
            })
            # retry-after must survive this hop: the Worker deliberately maps
            # upstream 429s through with it so the agent backs off honestly.
            retry_after = upstream.headers.get('retry-after')
            return Response(
                content=error_body[:8192],
                status_code=upstream.status_code,
                media_type=upstream.headers.get('content-type', 'application/json'),
                headers={'retry-after': retry_after} if retry_after else {},
            )

        async def _relay_worker_sse():
            try:
                async for chunk in upstream.aiter_bytes():
                    if chunk:
                        yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            _relay_worker_sse(),
            media_type='text/event-stream',
            headers={'cache-control': 'no-store'},
        )

    outbound = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(outbound, timeout=120) as upstream:
            content = upstream.read()
            content_type = upstream.headers.get('content-type', 'application/json')
            write_debug_capture('adapter_inbound_worker_response', {
                'response': {
                    'status': upstream.status,
                    'headers': list(upstream.headers.items()),
                    'body': content.decode('utf-8', 'replace'),
                },
            })
            if wants_stream:
                return Response(content=completion_json_to_sse(content), status_code=upstream.status, media_type='text/event-stream')
            return Response(content=content, status_code=upstream.status, media_type=content_type)
    except urllib.error.HTTPError as exc:
        content = exc.read()
        content_type = exc.headers.get('content-type', 'application/json') if exc.headers else 'application/json'
        write_debug_capture('adapter_inbound_worker_response', {
            'response': {
                'status': exc.code,
                'headers': list(exc.headers.items()) if exc.headers else [],
                'body': content.decode('utf-8', 'replace'),
            },
        })
        retry_after = exc.headers.get('retry-after') if exc.headers else None
        return Response(
            content=content,
            status_code=exc.code,
            media_type=content_type,
            headers={'retry-after': retry_after} if retry_after else {},
        )
    except Exception as exc:
        write_debug_capture('adapter_inbound_worker_response', {
            'error': repr(exc),
        })
        raise HTTPException(status_code=502, detail='worker_proxy_unavailable') from exc


def _validate_task_user(task_user_id: str) -> None:
    owner_user_id = os.getenv('SIDEKICK_USER_ID')
    if owner_user_id and task_user_id != owner_user_id:
        raise HTTPException(status_code=403, detail='task_user_mismatch')


def extract_hermes_result(stdout: str) -> str:
    lines = stdout.splitlines()
    answer_blocks: list[str] = []
    for index, line in enumerate(lines):
        # The CLI starts with a boxed "Hermes Agent" banner that lists tools and
        # skills. Only the later assistant answer box is headed by the medic
        # symbol + "Hermes". If we match any line containing "Hermes", Telegram
        # users receive the startup tool banner instead of the agent's answer.
        if '⚕ Hermes' not in line:
            continue
        collected: list[str] = []
        for candidate in lines[index + 1:]:
            stripped = candidate.strip()
            if stripped.startswith('╰'):
                break
            if stripped.startswith('│') and stripped.endswith('│'):
                stripped = stripped.strip('│').strip()
            if stripped:
                collected.append(stripped)
        if collected:
            answer_blocks.append('\n'.join(collected).strip())
    return answer_blocks[-1] if answer_blocks else ''


# v1.2.7 — chat dispatch wants to render tool-call activity inline in the
# mobile chat surface. Hermes CLI emits each tool invocation in a boxed
# panel headed by the tool name (e.g. "🔧 file" / "🔧 terminal" /
# "🔧 web"). This parser extracts an ordered list of {tool, summary}
# pairs that mobile can render as inline cards.
TOOL_PANEL_HEADERS = ('🔧', '⚙', '⚒')


def extract_hermes_tool_calls(stdout: str) -> list[dict[str, str]]:
    lines = stdout.splitlines()
    calls: list[dict[str, str]] = []
    for index, line in enumerate(lines):
        if not any(header in line for header in TOOL_PANEL_HEADERS):
            continue
        # Pull the tool name out of the panel header. Hermes formats it
        # as e.g. "╭─ 🔧 file ─" or "🔧 Running tool: terminal".
        stripped = line.replace('╭', '').replace('─', ' ').strip()
        for header in TOOL_PANEL_HEADERS:
            stripped = stripped.replace(header, '').strip()
        tool = stripped.split()[0].strip(':').strip() if stripped else 'tool'
        # Capture the next 1-3 non-empty payload lines as a short summary.
        summary_parts: list[str] = []
        for candidate in lines[index + 1: index + 8]:
            payload = candidate.strip().strip('│').strip()
            if not payload:
                continue
            if payload.startswith('╰'):
                break
            summary_parts.append(payload)
            if len(summary_parts) >= 3:
                break
        calls.append({
            'tool': tool[:40],
            'summary': ' '.join(summary_parts)[:240],
        })
    return calls


# Compose the single-string instruction the Hermes CLI receives. The CLI is
# single-shot — it has no conversation memory of its own — so chat
# continuity is achieved by prepending recent turns as plain text before
# the current instruction.
def build_hermes_query(task: TaskIn) -> str:
    # 2026-07-16: prefer the per-request name, then the runner's own env
    # identity, and only then the library default. The old direct fall to
    # DEFAULT_AGENT_NAME meant any dispatch that omitted agent_name renamed
    # the coworker "Ruben" mid-conversation (Alex's Telegram report).
    env_agent_name = (os.environ.get('SIDEKICK_AGENT_NAME') or os.environ.get('HERMES_AGENT_NAME') or '').strip()
    agent_name = (task.agent_name or env_agent_name or DEFAULT_AGENT_NAME).strip() or DEFAULT_AGENT_NAME
    # [R2] The underlying Hermes model is trained to introduce itself as
    # "Hermes agent" by default, which leaks through whenever the user
    # opens the chat ("Hi, I'm Hermes agent, your AI assistant…").
    # Force-override the identity with an explicit name + a never-call-
    # yourself-anything-else rule so the greeting matches what the user
    # picked during onboarding.
    preamble_lines = [
        f"You are {agent_name}, the user's AI coworker inside the Delegent AI app.",
        f"When you introduce yourself, always say \"I'm {agent_name}\" — never \"Hermes\",",
        "\"Hermes agent\", \"AI assistant\", \"language model\", or any other framework name.",
        "You have a private Linux workspace (the current working directory) with file, terminal,",
        "and web tools. Use them whenever the user asks you to read, write, or fetch anything —",
        "don't refuse, don't say you can't write files, and don't ask the user to do it themselves.",
        "",
        # [R4] Tell the agent where the user expects things to land.
        # The Files tab shows these top-level folders and the
        # runner pre-seeds them on first boot. When the user says",
        # 'home directory', they mean the `home/` subfolder of your
        # workspace, NOT the workspace root itself. Without this rule
        # the model writes to the bare cwd and the Files tab silently
        # buckets the result into 'Root', which the drawer hides.",
        "Your workspace already contains these top-level folders that match what the user sees in the Files tab:",
        "  home/        — the default landing zone for ad-hoc files",
        "  documents/   — drafts, briefs, summaries, formal documents",
        "  pictures/    — images, screenshots, generated artwork",
        "  downloads/   — files fetched from the web",
        "  notes/       — short notes, scratchpads, append-only logs",
        "  uploads/     — files the USER uploads to you; read from here when they say 'the file I just uploaded'",
        "When the user says 'home directory', that means the `home/` subfolder of your workspace.",
        "When the user refers to a file they uploaded or shared with you, look in `uploads/` (newest file first).",
        "Always write files into one of these subfolders (never the workspace root). If the user",
        "doesn't pick a folder, use `home/` for ad-hoc files, `documents/` for anything narrative,",
        "`notes/` for anything they want appended over time.",
        "",
        # [R9] 2026-08-15. A brand-new user's SECOND message from the coworker
        # was "...and set up reminders or workflows. `/help` shows the available
        # commands." Typing it returned the raw gateway dump, headed "Hermes
        # Commands", listing Telegram DM topic sessions and internals like
        # /compress and /branch. That is a framework leak on a new customer's
        # second interaction, and it defeats the never-say-Hermes rule above by
        # going round the model entirely.
        #
        # The app deliberately has no slash commands: SLASH_COMMANDS is empty in
        # the chat WebView and every /message is forwarded as ordinary text.
        # So there is nothing for the agent to advertise.
        "Never mention, advertise or suggest slash commands such as /help, /new or /compress.",
        "They are gateway internals, they are not part of this app, and the app's own chat",
        "offers no command menu. If the user asks what you can do, answer in plain sentences and",
        "point them at the real things: the connections they can link (their mailbox, files,",
        "calendar, books), the skills you already have, or simply describing the job they want done.",
        "",
        "Be warm and human, not terse. For any task that takes more than a moment, narrate as you go",
        "in short first-person lines (e.g. \"Give me a sec, pulling that together...\", \"Right, almost",
        "there...\") so the user always knows you are working and never thinks you have frozen. Keep each",
        "line short. Never mention OpenRouter, Cloudflare, Fly, Supabase, runners, or any infrastructure",
        "- you are simply the coworker.",
        "",
        "Before you state a specific time, a deadline, or when something next runs, run the `date`",
        "command and read the real clock rather than a remembered time. Show times in the user's own",
        "local timezone with a clear label, and do not show raw UTC in chat unless they ask. Never quote",
        "a next or future time that has already passed: if it has, move to the next real occurrence.",
    ]
    parts: list[str] = ['\n'.join(preamble_lines), '']
    history = task.history or []
    if history:
        parts.append('Recent conversation (oldest first):')
        for turn in history[-20:]:
            role = (turn.role or '').strip().lower()
            if role not in ('user', 'assistant'):
                continue
            content = (turn.content or '').strip()
            if not content:
                continue
            label = 'User' if role == 'user' else agent_name
            parts.append(f'{label}: {content}')
        parts.append('')
    if getattr(task, 'history_unavailable', False):
        # The dispatcher could not load our prior messages this turn. Tell the
        # agent NOT to gaslight the user into thinking it's a brand-new chat.
        parts.append(
            'IMPORTANT: I could not load our earlier conversation this turn (a temporary glitch on my side, '
            'not a real reset). Do NOT tell the user this is a new or first conversation, or that nothing has '
            'happened yet — that would be false. Briefly acknowledge you may be missing the last few messages '
            'and, if it matters for the task, ask them to recap. Never claim our history does not exist.'
        )
        parts.append('')
    parts.append(f'Current request from user: {task.instruction.strip()}')
    return '\n'.join(parts)


@app.post('/tasks')
async def create_task(task: TaskIn, request: Request):
    authenticated_user_id = require_sidekick_runner_authorization(request)
    if not hmac.compare_digest(authenticated_user_id, task.user_id):
        raise HTTPException(status_code=403, detail='task_user_mismatch')
    _validate_task_user(task.user_id)
    instruction = task.instruction.strip()
    if instruction == '':
        raise HTTPException(status_code=400, detail='instruction_required')

    task_id = str(uuid.uuid4())
    hermes_query = build_hermes_query(task)

    # Session-continuity mode resumes the box's durable Hermes session via the
    # subprocess `--continue` path, so bypass the (stateless) API-server path.
    if _HERMES_API_STATE.get('available') and not _hermes_session_continuity_enabled():
        try:
            return await _create_task_via_api_server(task_id, authenticated_user_id, hermes_query)
        except HermesApiRunAlreadySubmitted:
            # The run reached the Hermes API server before the failure, so it
            # may still be executing upstream. Falling back to the subprocess
            # here would execute the same user turn TWICE (double work, double
            # token spend) — surface an error record instead.
            TASKS[task_id] = {
                'user_id': authenticated_user_id,
                'status': 'error',
                'error': 'hermes_api_run_lost',
            }
            return _safe_task_response(task_id, TASKS[task_id])
        except Exception:
            # Pre-submit failure only (submit never reached the API server):
            # the subprocess fallback cannot double-execute.
            pass

    # The subprocess path is bounded: hermes chat holds a CPU for up to 10
    # minutes, so unbounded concurrent spawns would exhaust the 1-2 CPU box.
    if not _HERMES_TASK_SEMAPHORE.acquire(blocking=False):
        raise HTTPException(status_code=429, detail='runner_busy')
    try:
        return await asyncio.to_thread(_create_task_via_subprocess, task_id, authenticated_user_id, hermes_query, task)
    finally:
        _HERMES_TASK_SEMAPHORE.release()


class HermesApiRunAlreadySubmitted(RuntimeError):
    """Raised when a run was ACCEPTED by the Hermes API server but its result
    could not be retrieved (poll failure/timeout). The run may still be
    executing upstream, so callers must NOT re-execute the same user turn
    through another path."""


async def _create_task_via_api_server(task_id: str, user_id: str, query: str) -> dict[str, Any]:
    """Dispatch through the Hermes API Server and poll for the result."""
    import asyncio
    client = _hermes_client()
    base = _hermes_api_base_url()
    headers = _hermes_api_headers()
    submit = await client.post(f'{base}/runs', json={
        'assistant_id': 'default',
        'input': query,
        'stream': False,
    }, headers=headers, timeout=30.0)
    if submit.status_code not in (200, 201, 202):
        raise RuntimeError(f'api_server_submit_{submit.status_code}')
    run = submit.json()
    run_id = run.get('run_id') or run.get('id')
    if not run_id:
        raise RuntimeError('api_server_no_run_id')

    # From here on the run exists upstream: any failure must surface as
    # HermesApiRunAlreadySubmitted so the caller never double-executes.
    try:
        deadline = time.time() + 300
        while time.time() < deadline:
            status_resp = await client.get(f'{base}/runs/{run_id}', headers=headers, timeout=10.0)
            if status_resp.status_code != 200:
                await asyncio.sleep(1)
                continue
            data = status_resp.json()
            st = data.get('status', '')
            if st in ('completed', 'succeeded', 'done'):
                output = data.get('output') or data.get('result') or ''
                stdout = redact_runner_secrets(output if isinstance(output, str) else json.dumps(output))
                TASKS[task_id] = {
                    'user_id': user_id,
                    'status': 'completed',
                    'stdout': stdout,
                    'stderr': '',
                    'tool_calls': extract_hermes_tool_calls(stdout),
                }
                public_result = extract_hermes_result(stdout)
                if public_result:
                    TASKS[task_id]['result'] = public_result
                return _safe_task_response(task_id, TASKS[task_id])
            if st in ('failed', 'error', 'cancelled'):
                raw_output = data.get('output', '')
                TASKS[task_id] = {
                    'user_id': user_id,
                    'status': 'error',
                    'error': f'hermes_run_{st}',
                    'stdout': redact_runner_secrets(raw_output if isinstance(raw_output, str) else json.dumps(raw_output)),
                }
                return _safe_task_response(task_id, TASKS[task_id])
            await asyncio.sleep(1.5)
    except Exception as exc:
        raise HermesApiRunAlreadySubmitted(f'api_server_poll_failed_{type(exc).__name__}') from exc

    raise HermesApiRunAlreadySubmitted('api_server_poll_timeout')


def _hermes_session_continuity_enabled() -> bool:
    """Per-Machine flag: use Hermes' native durable session (`hermes chat
    --continue`) as the conversation memory instead of rebuilding history from
    Supabase every turn. 2026-06-03 chat-memory architecture — see
    docs/CHAT_MEMORY_ARCHITECTURE.md. OFF by default; enabled per test user
    during rollout (injected by the provisioner as SIDEKICK_HERMES_SESSION_CONTINUITY)."""
    return os.getenv('SIDEKICK_HERMES_SESSION_CONTINUITY', '').strip().lower() in ('1', 'true', 'yes')


def build_hermes_chat_command(env: dict[str, str], toolsets: str, *, resume: bool, query: str) -> list[str]:
    """Construct the `hermes chat` argv. resume=True adds `--continue` (resume the
    box's most-recent durable session and append only the new message); resume=False
    seeds/runs with the full prompt (which carries the Supabase-reconstructed
    history on a cold box, or is the legacy single-shot path when continuity is off)."""
    cmd = [
        'hermes',
        'chat',
        '--provider',
        'custom',
        '--model',
        env.get('HERMES_INFERENCE_MODEL', 'openrouter/auto'),
        '--toolsets',
        toolsets,
    ]
    if resume:
        cmd.append('--continue')
    cmd += ['--query', query]
    return cmd


def _hermes_no_session_to_continue(result: 'subprocess.CompletedProcess') -> bool:
    """True iff a `--continue` invocation failed specifically because no prior
    session exists (Hermes prints 'No previous CLI session found to continue.'
    and exits 1). Any OTHER non-zero exit is a real failure, not a cold start."""
    if result.returncode == 0:
        return False
    combined = f'{result.stdout or ""}\n{result.stderr or ""}'.lower()
    return 'no previous' in combined and 'session' in combined


def _create_task_via_subprocess(task_id: str, user_id: str, query: str, task: 'TaskIn') -> dict[str, Any]:
    """Subprocess path. With session continuity ON: resume the user's durable
    on-box Hermes session (`--continue`) and send only the new message; on a cold
    box with no session yet, seed one with the full prompt (which carries the
    Supabase-reconstructed history). With continuity OFF: the legacy single-shot
    full-prompt behaviour (also the fallback when the API server is unavailable)."""
    toolsets = os.getenv('HERMES_TOOLSETS', 'terminal,file,web')
    env = build_hermes_subprocess_env()
    workspace = ensure_runner_workspace()
    session_mode = _hermes_session_continuity_enabled()

    def _run(cmd: list[str]) -> 'subprocess.CompletedProcess':
        return subprocess.run(
            cmd, text=True, capture_output=True, stdin=subprocess.DEVNULL,
            timeout=600, env=env, cwd=str(workspace),
        )

    try:
        if session_mode:
            # Resume the durable session with ONLY the new user message.
            result = _run(build_hermes_chat_command(env, toolsets, resume=True, query=task.instruction.strip()))
            if _hermes_no_session_to_continue(result):
                # Cold box / first ever turn — seed a session with the full prompt
                # (carries any Supabase history) so it starts with context.
                result = _run(build_hermes_chat_command(env, toolsets, resume=False, query=query))
        else:
            result = _run(build_hermes_chat_command(env, toolsets, resume=False, query=query))

        stdout = redact_runner_secrets(result.stdout)
        TASKS[task_id] = {
            'user_id': user_id,
            'status': 'completed' if result.returncode == 0 else 'error',
            'stdout': stdout,
            'stderr': redact_runner_secrets(result.stderr),
            'tool_calls': extract_hermes_tool_calls(stdout),
        }
        public_result = extract_hermes_result(stdout)
        if public_result:
            TASKS[task_id]['result'] = public_result
    except Exception:
        TASKS[task_id] = {
            'user_id': user_id,
            'status': 'error',
            'error': 'hermes_task_failed',
        }
    return _safe_task_response(task_id, TASKS[task_id])


def _safe_task_response(task_id: str, record: dict[str, Any]) -> dict[str, Any]:
    # Every task-record write funnels through here on its way out, so this is
    # the single choke point that keeps the in-memory store bounded.
    _evict_old_tasks()
    # The internal record stores `user_id` to bind tasks to their owner, but
    # the wire response stays consistent with the historical shape so callers
    # never need to know that.
    public = {key: value for key, value in record.items() if key != 'user_id'}
    return {'task_id': task_id, **public}


@app.get('/tasks/{task_id}')
def get_task(task_id: str, request: Request):
    authenticated_user_id = require_sidekick_runner_authorization(request)
    record = TASKS.get(task_id)
    # Treat any non-owner read as `not found` so the endpoint cannot be used
    # to probe whether a task exists for another user. The request is already
    # authenticated, but the runner is single-tenant per user — anyone other
    # than the owner has no business seeing task metadata or output.
    if record is None or not hmac.compare_digest(record.get('user_id', ''), authenticated_user_id):
        raise HTTPException(404, 'task not found')
    return _safe_task_response(task_id, record)


# ---------------------------------------------------------------------------
# [hermes-streaming] Proxy endpoints in front of the Hermes API Server.
#
# Every endpoint:
#   1. Re-uses require_sidekick_runner_authorization() so the public HMAC
#      v1 boundary stays unbroken.
#   2. Forwards to the loopback Hermes API Server with the per-container
#      bearer key. Mobile / Worker NEVER see the bearer key.
#   3. Returns 503 hermes_api_server_not_ready if the launcher thread
#      hasn't reported the server as available yet.
#
# These are *additive*. Mobile build flag EXPO_PUBLIC_FEATURE_RUN_STREAM
# chooses between the new run/events path and the legacy /tasks polling
# path. If anything in this stack breaks, the legacy path still works.
# ---------------------------------------------------------------------------

def _require_hermes_api_ready() -> None:
    if not _HERMES_API_STATE.get('available'):
        reason = _HERMES_API_STATE.get('startup_error') or 'not_ready'
        raise HTTPException(status_code=503, detail=f'hermes_api_server_unavailable:{reason}')


def _hermes_client() -> httpx.AsyncClient:
    client = _HERMES_API_CLIENT
    if client is None:
        raise HTTPException(status_code=503, detail='hermes_api_server_not_ready')
    return client


@app.get('/v1/capabilities')
async def hermes_capabilities(request: Request) -> dict[str, Any]:
    require_sidekick_runner_authorization(request)
    if not _HERMES_API_STATE.get('available'):
        # Still callable before the upstream server is up — Worker uses
        # this to decide between the streaming and polling paths.
        return {
            'object': 'hermes.api_server.capabilities',
            'available': False,
            'reason': _HERMES_API_STATE.get('startup_error') or 'starting',
            'features': {
                'run_submission': False,
                'run_status': False,
                'run_events_sse': False,
                'run_stop': False,
            },
        }
    upstream = await _hermes_client().get(
        f'{_hermes_api_base_url()}/capabilities',
        headers=_hermes_api_headers(),
    )
    if upstream.status_code != 200:
        return {
            'object': 'hermes.api_server.capabilities',
            'available': True,
            'reason': f'upstream_{upstream.status_code}',
        }
    try:
        body = upstream.json()
    except ValueError:
        body = {}
    body.setdefault('object', 'hermes.api_server.capabilities')
    body['available'] = True
    return body


def inject_agent_identity_into_runs_payload(
    payload: dict[str, Any],
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """D36 — guarantee the upstream Hermes API Server receives an
    `instructions` field that frames the agent as the user-chosen
    coworker. Without it the upstream agent introduces itself as
    "Hermes agent" / "Nous Research" using its built-in default
    identity. The Worker always populates `instructions` in production;
    this is defense-in-depth for any caller that forgets, plus the
    Telegram / contract-test paths.

    Precedence:
      1. caller-supplied `instructions` if non-empty (we leave it
         alone, the caller already framed the run)
      2. HERMES_SYSTEM_PROMPT env (set by the provisioner with the
         per-user agent name baked in)
      3. minimal fallback prompt with DEFAULT_AGENT_NAME — never let
         the upstream default win.
    """
    source = env if env is not None else os.environ
    existing = payload.get('instructions')
    if isinstance(existing, str) and existing.strip():
        return payload
    env_prompt = source.get('HERMES_SYSTEM_PROMPT', '').strip()
    if env_prompt:
        payload['instructions'] = env_prompt
        return payload
    agent_name = normalize_agent_name(
        source.get('SIDEKICK_AGENT_NAME') or source.get('HERMES_AGENT_NAME')
    )
    payload['instructions'] = (
        f"You are {agent_name}, the user's AI coworker inside the Delegent AI app. "
        f"Always introduce yourself as {agent_name}, never as \"Hermes\", \"Hermes agent\", "
        '"AI assistant", or any other framework name. Use the file, terminal, and web tools '
        'in your private Linux workspace whenever the user asks you to read, write, or fetch '
        'anything. Never mention OpenRouter, Cloudflare, Fly, Supabase, runners, or any '
        'infrastructure; you are simply the coworker. '
        # Same rule as the [R9] block in the task preamble. Both paths build an
        # identity prompt and a new user can land on either, so a rule applied
        # to only one of them leaks through the other.
        'Never mention, advertise or suggest slash commands such as /help, /new or /compress: '
        'they are gateway internals and this app has no command menu. If asked what you can do, '
        'answer in plain sentences and point at the connections they can link, the skills you '
        'have, or the job they want done.'
    )
    return payload


@app.post('/v1/runs')
async def hermes_create_run(request: Request) -> Response:
    user_id = require_sidekick_runner_authorization(request)
    _validate_task_user(user_id)
    _require_hermes_api_ready()
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001 — pydantic is overkill for a pass-through
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    payload = inject_agent_identity_into_runs_payload(payload)
    upstream = await _hermes_client().post(
        f'{_hermes_api_base_url()}/runs',
        json=payload,
        headers=_hermes_api_headers(),
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get('content-type', 'application/json'),
    )


@app.get('/v1/runs/{run_id}')
async def hermes_get_run(run_id: str, request: Request) -> Response:
    require_sidekick_runner_authorization(request)
    _require_hermes_api_ready()
    if not run_id or not run_id.replace('-', '').replace('_', '').isalnum():
        raise HTTPException(status_code=400, detail='invalid_run_id')
    upstream = await _hermes_client().get(
        f'{_hermes_api_base_url()}/runs/{run_id}',
        headers=_hermes_api_headers(),
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get('content-type', 'application/json'),
    )


@app.post('/v1/runs/{run_id}/stop')
async def hermes_stop_run(run_id: str, request: Request) -> Response:
    require_sidekick_runner_authorization(request)
    _require_hermes_api_ready()
    if not run_id or not run_id.replace('-', '').replace('_', '').isalnum():
        raise HTTPException(status_code=400, detail='invalid_run_id')
    upstream = await _hermes_client().post(
        f'{_hermes_api_base_url()}/runs/{run_id}/stop',
        headers=_hermes_api_headers(),
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get('content-type', 'application/json'),
    )


@app.get('/v1/runs/{run_id}/events')
async def hermes_run_events(run_id: str, request: Request) -> StreamingResponse:
    """SSE proxy from the Hermes API Server.

    Streams raw upstream `data: ...` lines to the caller (the Worker)
    *unchanged*. Normalisation into the stable app event schema is the
    Worker's job — keeping it there means a Hermes version bump that
    changes raw event names only needs a Worker code change, not a
    runner image rebuild.
    """
    require_sidekick_runner_authorization(request)
    _require_hermes_api_ready()
    if not run_id or not run_id.replace('-', '').replace('_', '').isalnum():
        raise HTTPException(status_code=400, detail='invalid_run_id')

    upstream_url = f'{_hermes_api_base_url()}/runs/{run_id}/events'

    async def _pump():
        client = _hermes_client()
        async with client.stream('GET', upstream_url, headers=_hermes_api_headers(), timeout=None) as upstream:
            if upstream.status_code >= 400:
                yield f'event: error\ndata: {{"status": {upstream.status_code}, "detail": "upstream_error"}}\n\n'.encode()
                return
            try:
                async for chunk in upstream.aiter_raw():
                    if not chunk:
                        continue
                    yield chunk
            except (httpx.RemoteProtocolError, httpx.ReadError) as exc:
                yield f'event: error\ndata: {{"detail": "stream_disconnected:{type(exc).__name__}"}}\n\n'.encode()

    return StreamingResponse(
        _pump(),
        media_type='text/event-stream',
        headers={
            'cache-control': 'no-store',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
        },
    )


# ---------------------------------------------------------------------------
# Route B: in-app chat via the `delegent` gateway platform
# ---------------------------------------------------------------------------
# The Worker delivers a user's chat message here (HMAC-gated). We forward it to
# the delegent platform adapter's loopback listener inside the gateway
# subprocess, which routes it through handle_message -> the full gateway
# pipeline (durable per-user session + slash commands + /goal). The reply
# streams back IN-BAND through THIS process: the adapter POSTs deltas to our
# own loopback ingest (/v1/delegent/ingest, DELEGENT_RELAY_URL); we queue them
# per run_id; the Worker drains them over SSE (/v1/delegent/runs/{id}/events).
# Keeping the coordination in this single wrapper process avoids a Cloudflare
# Durable Object. See docs/CHAT_ROUTE_B_DESIGN.md.
DELEGENT_PLATFORM_DEFAULT_PORT = 8644

# Streaming bridge tuning. Real turns relay a typing heartbeat every ~2s (the
# gateway's _keep_typing) WHILE THE MODEL IS GENERATING — but a turn goes
# relay-silent while a TOOL executes (session_search, browser, shell, ...),
# routinely for tens of seconds on a 1-CPU runner. The idle close exists to end
# bypass slash-command streams (/new, /stop, ...), which never fire the
# on_processing_complete 'done' signal; it must therefore be comfortably longer
# than a tool-execution gap, or it fabricates an early close mid-turn (the
# 2026-06-12 dropped-reply defect: idle fired at 6s during a session_search,
# the Worker finalized the bubble with the partial text, and the real answer
# relayed into a dead queue). The synthetic close carries reason='idle' and the
# Worker treats it as INCONCLUSIVE (it reconciles via the run record below),
# so this window is UX tuning, not correctness.
DELEGENT_STREAM_KEEPALIVE_SECS = 3.0
DELEGENT_STREAM_IDLE_SECS = 45.0
DELEGENT_STREAM_MAX_LIFETIME_SECS = 900.0
DELEGENT_STREAM_REGISTRY_CAP = 256

# Per-run in-memory delta queues, keyed by the Worker's run_id. Access happens
# only inside coroutines on the single uvicorn event loop, so plain dict ops are
# atomic (no await between read+write in the helpers) — no lock needed.
_DELEGENT_STREAMS: dict[str, "asyncio.Queue[dict[str, Any]]"] = {}


def _delegent_stream_open(run_id: str) -> "asyncio.Queue[dict[str, Any]]":
    """Get-or-create the delta queue for a run. Bounded by a registry cap as a
    backstop against leaked streams (a Worker that POSTs /message then never
    opens the SSE); evict the oldest if we ever hit the cap."""
    queue = _DELEGENT_STREAMS.get(run_id)
    if queue is None:
        if len(_DELEGENT_STREAMS) >= DELEGENT_STREAM_REGISTRY_CAP:
            oldest = next(iter(_DELEGENT_STREAMS), None)
            if oldest is not None:
                _DELEGENT_STREAMS.pop(oldest, None)
        queue = asyncio.Queue()
        _DELEGENT_STREAMS[run_id] = queue
    return queue


def _delegent_stream_push(run_id: str, item: dict[str, Any]) -> None:
    # Push ONLY to a live queue — never resurrect a closed stream. Before the
    # 2026-06-12 fix this auto-created a queue, so frames relayed AFTER the
    # bridge closed (e.g. the real answer arriving after an idle close) piled
    # into a queue nobody would ever drain. Late frames now land in the run
    # RECORD below instead, where the Worker's reconcile can recover them.
    queue = _DELEGENT_STREAMS.get(run_id)
    if queue is not None:
        queue.put_nowait(item)


def _delegent_stream_close(run_id: str) -> None:
    _DELEGENT_STREAMS.pop(run_id, None)


# ---------------------------------------------------------------------------
# Per-run transcript RECORDS (2026-06-12 dropped-reply defect).
# ---------------------------------------------------------------------------
# The SSE delta queues above are consumable: once the bridge closes a stream
# (organic 'done', idle, or max-lifetime) the queue is deleted, and any frames
# the adapter relayed after that point used to vanish — the Worker then had NO
# way to recover the reply text (it cannot read the on-box session). These
# records accumulate the same frames INDEPENDENTLY of the queues, mirroring the
# Worker translator's merge semantics (send commits the prior segment; edit
# replaces the current one; cursor stripped), so the Worker can reconcile a
# turn's authoritative text at any time via GET /v1/delegent/runs/{run_id}.
# The dictionary is a cache. The delivery journal on the volume retains results
# until off-box persistence is acknowledged, independently of Hermes' state.db.
DELEGENT_RUN_RECORD_TTL_SECS = 30 * 60.0
DELEGENT_RUN_RECORD_CAP = 64
_DELEGENT_RUNS: dict[str, dict[str, Any]] = {}
_DELEGENT_PROCESS_ID = uuid.uuid4().hex
_DELEGENT_JOURNALS: dict[str, RunJournal] = {}


def _delegent_journal() -> RunJournal | None:
    # Unbound local contract harnesses never serve authenticated production work.
    if not os.getenv('SIDEKICK_USER_ID'):
        return None
    path = str(Path(os.getenv('HERMES_HOME', '/data/hermes')) / 'delegent-runs.db')
    if path not in _DELEGENT_JOURNALS:
        _DELEGENT_JOURNALS[path] = RunJournal(Path(path))
    return _DELEGENT_JOURNALS[path]


def _delegent_run_record_save(run_id: str, rec: dict[str, Any]) -> None:
    journal = _delegent_journal()
    if journal is not None:
        journal.save(run_id, rec)


def _delegent_run_record_get(run_id: str) -> dict[str, Any] | None:
    rec = _DELEGENT_RUNS.get(run_id)
    if rec is None:
        journal = _delegent_journal()
        rec = journal.load(run_id) if journal is not None else None
        if rec is not None:
            if not rec.get('done') and rec.get('process_id') != _DELEGENT_PROCESS_ID:
                # An interrupted execution is never automatically replayed.
                rec.update(done=True, outcome='failure', pending_approval=None, pending_clarify=None)
                _delegent_run_record_save(run_id, rec)
            _DELEGENT_RUNS[run_id] = rec
    return rec
# Hermes' StreamConsumer streaming cursor: U+2589 plus its leading space.
_DELEGENT_CURSOR_RE = re.compile(r'\s?▉')


def _delegent_run_record_sweep() -> None:
    now = time.monotonic()
    expired = [rid for rid, rec in _DELEGENT_RUNS.items()
               if now - rec['updated_at'] > DELEGENT_RUN_RECORD_TTL_SECS]
    for rid in expired:
        _DELEGENT_RUNS.pop(rid, None)


def _delegent_run_record_open(run_id: str) -> dict[str, Any]:
    _delegent_run_record_sweep()
    rec = _delegent_run_record_get(run_id)
    if rec is None:
        if len(_DELEGENT_RUNS) >= DELEGENT_RUN_RECORD_CAP:
            oldest = next(iter(_DELEGENT_RUNS), None)
            if oldest is not None:
                _DELEGENT_RUNS.pop(oldest, None)
        rec = {
            'process_id': _DELEGENT_PROCESS_ID,
            'committed': '',     # text from completed prior message segments
            'segment': '',       # current segment's latest clean text
            'last_final': False, # the last content frame carried final:true
            'done': False,
            'outcome': '',
            'updated_at': time.monotonic(),
            # Perf-plan step 3 (2026-07): per-turn timing marks. created_mono is
            # stamped when the FIRST frame for the run arrives from the adapter
            # (≈ turn start); first_content_mono on the first send/edit frame
            # with text (≈ user-perceived first token). Read-only observability:
            # one log line at done, no wire/schema change.
            'created_mono': time.monotonic(),
            'first_content_mono': None,
            # 2026-07-03 approval-card durability: the adapter's send_exec_approval
            # card used to live ONLY in the ephemeral stream queue — a dropped app
            # SSE (screen off, backgrounded app) lost the card forever and the
            # exec gate then timed out silently after 300s ("hang"). The pending
            # card is persisted here, replayed on every stream (re)open, exposed
            # via GET /v1/delegent/runs/{id}, and cleared once the gate concludes.
            'pending_approval': None,
            # 2026-07-10 clarify durability: same treatment for the clarify
            # tool's question (adapter send_clarify). The Worker finalizes the
            # paused turn with the question so the app composer unlocks — a
            # dropped SSE must not lose the question (live incident 2026-07-09:
            # three turns deadlocked the composer against the answer the agent
            # was waiting for).
            'pending_clarify': None,
        }
        _DELEGENT_RUNS[run_id] = rec
        _delegent_run_record_save(run_id, rec)
    return rec


def _delegent_run_record_update(run_id: str, item: dict[str, Any]) -> None:
    rec = _delegent_run_record_open(run_id)
    if rec.get('done'):
        return
    kind = str(item.get('kind') or 'edit')
    if kind == 'approval':
        # Persist the dangerous-command card so a reconnecting stream can
        # replay it while the gate is still waiting. A newer gate replaces an
        # older unanswered one (the gateway serialises gates per session).
        rec['pending_approval'] = {
            'approval_id': str(item.get('approval_id') or ''),
            'command': str(item.get('command') or ''),
            'description': str(item.get('description') or 'dangerous command'),
            'choices': item.get('choices') if isinstance(item.get('choices'), list)
                       else ['once', 'session', 'always', 'deny'],
        }
    if kind == 'clarify':
        # Persist the clarify question so a reconnecting stream / the Worker's
        # reconcile can still deliver it while the turn blocks on the user's
        # answer (up to the clarify timeout). A newer question replaces an
        # older unanswered one (the gateway serialises turns per session).
        rec['pending_clarify'] = {
            'clarify_id': str(item.get('clarify_id') or ''),
            'question': str(item.get('question') or ''),
            'choices': item.get('choices') if isinstance(item.get('choices'), list) else None,
            'text': str(item.get('text') or ''),
        }
    if kind == 'done':
        rec['done'] = True
        rec['pending_approval'] = None
        rec['pending_clarify'] = None
        outcome = item.get('outcome')
        if isinstance(outcome, str) and outcome:
            rec['outcome'] = outcome
        created = rec.get('created_mono')
        if isinstance(created, float):
            first = rec.get('first_content_mono')
            _logger.info(
                '[delegent-timing] run_id=%s first_content_ms=%s total_ms=%d outcome=%s',
                run_id,
                int((first - created) * 1000) if isinstance(first, float) else 'none',
                int((time.monotonic() - created) * 1000),
                rec.get('outcome') or 'unknown',
            )
    elif kind in ('send', 'edit'):
        raw = item.get('text')
        clean = _DELEGENT_CURSOR_RE.sub('', raw) if isinstance(raw, str) else ''
        if clean and rec.get('pending_approval') is not None:
            # Content flowing again means the gate concluded (approved output,
            # or the 300s consent timeout returned BLOCKED and the agent moved
            # on) — the card is stale either way; stop replaying it.
            rec['pending_approval'] = None
        if clean and rec.get('pending_clarify') is not None:
            # Content flowing again means the clarify concluded (answered via
            # the text-intercept, or the timeout resumed the turn) — the
            # question is stale; stop replaying it.
            rec['pending_clarify'] = None
        if clean and rec.get('first_content_mono') is None:
            rec['first_content_mono'] = time.monotonic()
        if kind == 'send' and clean and clean == rec['segment']:
            # Replayed frame (stream reconnect re-delivery of the same bubble):
            # committing the identical segment again would double the text in
            # the record — observed 2026-07-04, the provider-error reply was
            # stored twice. Refresh liveness only.
            rec['last_final'] = bool(item.get('final'))
            rec['updated_at'] = time.monotonic()
            _delegent_run_record_save(run_id, rec)
            return
        if kind == 'send' and rec['segment']:
            # a brand-new message bubble started upstream — commit the prior one.
            # Blank-line separator mirrors the Worker translator (2026-07-22):
            # bubbles are distinct upstream messages (interim narration, tool
            # progress, the final reply) and must reconcile as paragraphs, not
            # word-mush, so live text and record text stay byte-identical.
            rec['committed'] += rec['segment'] + '\n\n'
            rec['segment'] = ''
        rec['segment'] = clean
        rec['last_final'] = bool(item.get('final'))
    # 'typing' refreshes updated_at only (liveness signal for reconcile).
    rec['updated_at'] = time.monotonic()
    _delegent_run_record_save(run_id, rec)


def _delegent_run_record_drop(run_id: str) -> None:
    _DELEGENT_RUNS.pop(run_id, None)


# --- Busy-aware autostop keepalive ------------------------------------------
# Fly's autostop=stop scales a machine to zero when its PROXY sees no inbound
# connections for the idle window. But the agent's real work is loopback (model
# calls hop 127.0.0.1 -> Worker -> OpenRouter), invisible to the proxy. So a
# long, quiet, tool-heavy turn looks idle and Fly STOPS the machine mid-run.
# That is exactly the 2026-06-14 hang: the proxy-initiated stop killed the agent
# process AND wiped the in-memory _DELEGENT_RUNS records; the Worker's reconcile
# then 404'd and the turn orphaned in `dispatched` forever.
#
# This keepalive closes the gap WITHOUT giving up scale-to-zero. While any
# delegent run is active (a record with done==False) it pings the machine's own
# PUBLIC hostname every DELEGENT_KEEPALIVE_INTERVAL_SECS. That request egresses
# to the Fly edge and returns THROUGH the proxy, resetting the idle timer so Fly
# never stops a busy machine. When no run is active it pings nothing, so a
# genuinely idle machine still scales to zero normally. Best-effort: every
# failure is swallowed and the Worker's orphan-reaper remains the fail-clean
# backstop (a missed ping at worst reaps the run as failed, never hangs).
DELEGENT_KEEPALIVE_INTERVAL_SECS = 15.0
_DELEGENT_KEEPALIVE_TASK: 'asyncio.Task[None] | None' = None

# Sleep grace (2026-09-07, Alex's call). Fly's own idle window is a few
# minutes, so a user who sends a message, reads the reply and sends another
# ten minutes later pays a cold boot (about fifteen seconds) for the second
# one. That is the one thing the sleep rollout costs a customer, and it is
# not worth the pennies of compute it saves. So keep the machine awake for
# DELEGENT_SLEEP_GRACE_SECS after the LAST real request (anything from the
# Worker: chat, tasks, files, warm pings), then let Fly sleep it. Two hours
# by default: a runner used morning and evening is awake ~5 hours a day
# instead of 24, and never mid-conversation. Health checks and our own
# keepalive pings do not count as activity, or the machine would never sleep.
def _sleep_grace_secs() -> float:
    raw = (os.environ.get('DELEGENT_SLEEP_GRACE_SECS') or '').strip()
    try:
        return max(0.0, float(raw)) if raw else 7200.0
    except ValueError:
        return 7200.0


_DELEGENT_LAST_ACTIVITY_TS: float = 0.0


def _delegent_note_activity(now: float | None = None) -> None:
    global _DELEGENT_LAST_ACTIVITY_TS
    _DELEGENT_LAST_ACTIVITY_TS = time.time() if now is None else now


def _delegent_has_active_run() -> bool:
    return any(not rec.get('done') for rec in _DELEGENT_RUNS.values())


def _delegent_should_keepalive(now: float | None = None) -> bool:
    """True while the proxy idle timer must keep being reset: a run is in
    flight, or the user was here within the sleep grace window."""
    if _delegent_has_active_run():
        return True
    grace = _sleep_grace_secs()
    if grace <= 0 or _DELEGENT_LAST_ACTIVITY_TS <= 0:
        return False
    t = time.time() if now is None else now
    return (t - _DELEGENT_LAST_ACTIVITY_TS) < grace


def _fly_self_keepalive_url() -> str | None:
    """The machine's own public Fly hostname for the keepalive ping, or None
    when we are not running on Fly (local/dev/CI) — in which case there is no
    proxy idle-timer to reset and the loop no-ops."""
    app_name = (os.getenv('FLY_APP_NAME') or '').strip()
    if not app_name:
        return None
    return f'https://{app_name}.fly.dev/healthz'


async def _delegent_autostop_keepalive() -> None:
    url = _fly_self_keepalive_url()
    if not url:
        return  # not on Fly — nothing to keep alive
    while True:
        try:
            await asyncio.sleep(DELEGENT_KEEPALIVE_INTERVAL_SECS)
            if not _delegent_should_keepalive():
                continue
            client = _HERMES_API_CLIENT
            if client is None:
                continue
            try:
                # Round-trips out to the Fly edge and back through the proxy,
                # resetting the machine's idle timer. Short timeout: the ping
                # only needs to reach the proxy, not complete cleanly.
                await client.get(url, timeout=10.0)
            except Exception:  # noqa: BLE001
                pass  # best-effort; the Worker orphan-reaper backstops a miss
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # Never let the keepalive loop die on an unexpected error.
            await asyncio.sleep(DELEGENT_KEEPALIVE_INTERVAL_SECS)


def _new_delegent_run_id() -> str:
    return f'run_{_secrets_mod.token_hex(12)}'


def _delegent_platform_base_url(env: dict[str, str] | None = None) -> str:
    source = env if env is not None else os.environ
    host = source.get('DELEGENT_PLATFORM_HOST', '127.0.0.1')
    port = source.get('DELEGENT_PLATFORM_PORT', str(DELEGENT_PLATFORM_DEFAULT_PORT))
    return f'http://{host}:{port}'


def _delegent_platform_secret() -> str:
    return (os.getenv('DELEGENT_PLATFORM_SECRET') or os.getenv('SIDEKICK_RUNNER_SHARED_SECRET') or '').strip()


@app.post('/v1/delegent/message')
async def delegent_inbound_message(request: Request) -> Response:
    authenticated_user_id = require_sidekick_runner_authorization(request)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    text = payload.get('text')
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail='text_required')

    # Self-heal the curated skills library before the turn runs, so a gateway
    # self-re-exec or a Hermes launch-time prune can never leave the agent
    # answering "skill not found" (live incident 2026-07-22). Cheap unless the
    # library has drifted; best-effort, never blocks the turn.
    _ensure_delegent_skills_present(Path(os.environ.get('HERMES_HOME', '/data/hermes')))

    # The run_id is the correlation key for the whole turn: the adapter tags
    # every relayed delta with it, the ingest endpoint queues by it, and the
    # Worker opens the SSE on it. The Worker supplies one (its client run id);
    # mint a fallback so the bridge always has a key.
    run_id = str(payload.get('run_id') or '').strip() or _new_delegent_run_id()
    if not run_id.replace('-', '').replace('_', '').isalnum() or len(run_id) > 128:
        raise HTTPException(status_code=400, detail='invalid_run_id')
    journal = _delegent_journal()
    if journal is not None and not journal.claim(run_id):
        return JSONResponse({'accepted': True, 'run_id': run_id, 'replayed': True})
    if journal is None and run_id in _DELEGENT_RUNS:
        return JSONResponse({'accepted': True, 'run_id': run_id, 'replayed': True})
    # Allocate the queue BEFORE dispatch so an early delta (or the typing
    # heartbeat) can never arrive before there is somewhere to put it. The run
    # RECORD is allocated alongside it — the durable (queue-independent) copy
    # the Worker reconciles from after any premature stream close.
    _delegent_stream_open(run_id)
    _delegent_run_record_open(run_id)

    # The session is keyed by the authenticated user id; never trust a user_id
    # from the body (one runner == one user, but stay strict).
    forward = {
        'user_id': authenticated_user_id,
        'text': text,
        'run_id': run_id,
        'message_id': str(payload.get('message_id') or ''),
        'user_name': str(payload.get('user_name') or 'User'),
    }
    headers = {'content-type': 'application/json'}
    secret = _delegent_platform_secret()
    if secret:
        headers['x-delegent-platform-secret'] = secret
    try:
        client = _hermes_client()
        # handle_message returns fast (it spawns the per-session background
        # task), so this ack comes back quickly; the reply streams via ingest.
        resp = await client.post(
            f'{_delegent_platform_base_url()}/message',
            json=forward,
            headers=headers,
            timeout=30.0,
        )
    except Exception as exc:  # noqa: BLE001
        _delegent_stream_close(run_id)
        _delegent_run_record_update(run_id, {'kind': 'done', 'outcome': 'failure'})
        raise HTTPException(status_code=503, detail='delegent_platform_unavailable') from exc
    if resp.status_code >= 400:
        _delegent_stream_close(run_id)
        _delegent_run_record_update(run_id, {'kind': 'done', 'outcome': 'failure'})
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get('content-type', 'application/json'),
        )
    return JSONResponse({'accepted': True, 'run_id': run_id})


@app.post('/v1/delegent/control')
async def delegent_session_control(request: Request) -> Response:
    user_id = require_sidekick_runner_authorization(request)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict) or payload.get('action') not in ('stop', 'reset'):
        raise HTTPException(status_code=400, detail='invalid_control')
    if payload['action'] == 'reset' and payload.get('confirmed') is not True:
        raise HTTPException(status_code=409, detail='confirmation_required')
    forward = {key: payload.get(key) for key in ('action', 'confirmed', 'run_id')}
    forward['user_id'] = user_id
    try:
        resp = await _hermes_client().post(
            f'{_delegent_platform_base_url()}/control', json=forward,
            headers={'x-delegent-platform-secret': _delegent_platform_secret()}, timeout=30.0,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail='control_unavailable') from exc
    return Response(content=resp.content, status_code=resp.status_code,
                    media_type='application/json')


@app.post('/v1/delegent/approval')
async def delegent_inbound_approval(request: Request) -> Response:
    """Inbound decision for a dangerous-command approval card (HMAC-gated).

    The Worker forwards the app's Approve/Deny button press here; we forward it
    to the gateway adapter's loopback /approval, which resolves the SAME paused
    gate the adapter's send_exec_approval presented, via
    resolve_gateway_approval(session_key, choice). No run/queue allocation: this
    rides the ALREADY-OPEN turn (opened by /v1/delegent/message) — the
    post-approval reply streams on that run's existing SSE, closed by the usual
    `kind:'done'`. Idempotent: a stale/duplicate press resolves nothing."""
    require_sidekick_runner_authorization(request)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    approval_id = str(payload.get('approval_id') or '').strip()
    choice = str(payload.get('choice') or '').strip().lower()
    if not approval_id or choice not in ('once', 'session', 'always', 'deny'):
        raise HTTPException(status_code=400, detail='approval_id_and_choice_required')
    forward = {'approval_id': approval_id, 'choice': choice}
    headers = {'content-type': 'application/json'}
    secret = _delegent_platform_secret()
    if secret:
        headers['x-delegent-platform-secret'] = secret
    try:
        client = _hermes_client()
        resp = await client.post(
            f'{_delegent_platform_base_url()}/approval',
            json=forward,
            headers=headers,
            timeout=30.0,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail='delegent_platform_unavailable') from exc
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get('content-type', 'application/json'),
    )


MAX_CREDENTIAL_PAYLOAD_BYTES = 256 * 1024
MAX_CREDENTIAL_SERVICE_LENGTH = 64


def _credential_store_module():
    """Import the shared encrypted vault the skills already use.

    Same search order as the `delegent-keys` CLI: the seeded copy on the volume
    first, then the env-configured library, then the baked image path, then the
    repo checkout for dev/tests. Raises HTTPException so a boxed runner whose
    library has not been seeded yet returns an honest 503 rather than a 500.
    """
    candidates: list[Path] = []
    hermes_home = os.environ.get('HERMES_HOME')
    if hermes_home:
        candidates.append(Path(hermes_home) / 'skills' / '_shared')
    skills_dir = os.environ.get('DELEGENT_SKILLS_DIR')
    if skills_dir:
        candidates.append(Path(skills_dir) / '_shared')
    candidates.append(Path('/opt/delegent/skills/_shared'))
    candidates.append(Path(__file__).resolve().parent / 'skills' / 'delegent' / '_shared')
    for directory in candidates:
        target = directory / 'credential_store.py'
        if not target.is_file():
            continue
        try:
            spec = importlib.util.spec_from_file_location('credential_store', target)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        except Exception:  # noqa: BLE001 - try the next candidate
            continue
    raise HTTPException(status_code=503, detail='credential_store_unavailable')


def _normalized_credential_service(raw: str) -> str:
    """The vault's own filename rule, applied up front so a bad name is a 400
    rather than a surprise later. Mirrors credential_store._path."""
    service = (raw or '').strip()
    if not service or len(service) > MAX_CREDENTIAL_SERVICE_LENGTH:
        raise HTTPException(status_code=400, detail='invalid_service')
    safe = ''.join(c for c in service if c.isalnum() or c in ('-', '_')).lower()
    if not safe or safe != service.lower():
        raise HTTPException(status_code=400, detail='invalid_service')
    return safe


@app.get('/v1/delegent/credentials')
async def delegent_list_credentials(request: Request) -> Response:
    """What this box has connected. Service names, scopes and non-secret
    metadata only: the vault gives no way to read a stored secret back, so this
    physically cannot leak one."""
    require_sidekick_runner_authorization(request)
    store = _credential_store_module()
    try:
        connections = store.listing()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail='credential_list_failed') from exc
    return JSONResponse({'connections': connections})


@app.put('/v1/delegent/credentials/{service}')
async def delegent_put_credential(service: str, request: Request) -> Response:
    """Store a credential the user typed in the app, straight into the encrypted
    vault.

    This route exists so a secret never has to travel through the chat
    transcript: before it, the only way to connect a service was to paste the
    key into a message, which persisted it in the message history and put it in
    the model's context. Nothing here is logged, and the response echoes only
    the service name.
    """
    require_sidekick_runner_authorization(request)
    safe_service = _normalized_credential_service(service)
    raw = await request.body()
    if len(raw) > MAX_CREDENTIAL_PAYLOAD_BYTES:
        raise HTTPException(status_code=413, detail='credential_too_large')
    try:
        payload = json.loads(raw or b'{}')
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')

    secret_blob = payload.get('secret')
    if not isinstance(secret_blob, dict) or not secret_blob:
        raise HTTPException(status_code=400, detail='secret_required')
    if not all(isinstance(key, str) and isinstance(value, str) and value.strip() for key, value in secret_blob.items()):
        raise HTTPException(status_code=400, detail='secret_required')

    scopes_raw = payload.get('scopes')
    scopes = [s for s in scopes_raw if isinstance(s, str) and s.strip()] if isinstance(scopes_raw, list) else []
    meta_raw = payload.get('meta')
    meta = (
        {k: v for k, v in meta_raw.items() if isinstance(k, str) and isinstance(v, str)}
        if isinstance(meta_raw, dict)
        else {}
    )

    store = _credential_store_module()
    try:
        store.put(safe_service, secret_blob, scopes=scopes, meta=meta)
    except Exception as exc:  # noqa: BLE001 - never let the secret ride out in a traceback
        raise HTTPException(status_code=500, detail='credential_store_failed') from exc
    return JSONResponse({'stored': True, 'service': safe_service, 'scopes': scopes})


@app.delete('/v1/delegent/credentials/{service}')
async def delegent_delete_credential(service: str, request: Request) -> Response:
    require_sidekick_runner_authorization(request)
    safe_service = _normalized_credential_service(service)
    store = _credential_store_module()
    try:
        removed = bool(store.remove(safe_service))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail='credential_remove_failed') from exc
    return JSONResponse({'removed': removed, 'service': safe_service})


def worker_api_url(path: str, env: dict[str, str] | None = None) -> str:
    """Turn the configured worker proxy URL into another worker API path.

    SIDEKICK_WORKER_PROXY_URL is set to the model proxy, so it may or may not
    carry a /v1 or /v1/chat/completions tail. Reuse the same host allowlist the
    chat path enforces so a mis-set env can never point this at someone else.
    """
    source = env if env is not None else os.environ
    raw = require_non_empty(source.get('SIDEKICK_WORKER_PROXY_URL'), 'sidekick_worker_proxy_url').rstrip('/')
    base = worker_chat_completion_url(raw, source).removesuffix('/v1/chat/completions')
    return f'{base}/{path.lstrip("/")}'


async def _worker_connections_call(
    path: str,
    payload: dict[str, Any] | None,
    timeout: float = 20.0,
) -> tuple[int, Any]:
    """Ask the Worker about this user's brokered connections.

    The OAuth grant deliberately does NOT live on this box: the agent runs
    arbitrary code as this user, so a refresh token here would be a refresh
    token the agent could exfiltrate. The Worker holds it, and hands back an
    access token good for minutes. This function is the only thing on the box
    that can ask, because it is the only thing holding the runner secret.
    """
    user_id = require_non_empty(os.environ.get('SIDEKICK_USER_ID'), 'sidekick_user_id')
    shared_secret = require_non_empty(os.environ.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'sidekick_runner_shared_secret')
    headers = {
        'content-type': 'application/json',
        'user-agent': RUNNER_OUTBOUND_USER_AGENT,
        **build_sidekick_runner_headers(user_id=user_id, shared_secret=shared_secret),
    }
    url = worker_api_url(path)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            if payload is None:
                response = await client.get(url, headers=headers)
            else:
                response = await client.post(url, headers=headers, content=json.dumps(payload).encode('utf-8'))
    except Exception:  # noqa: BLE001 - httpx raises many transport classes
        return 502, {'error': 'connections_unreachable'}
    try:
        return response.status_code, response.json()
    except ValueError:
        return response.status_code, {'error': 'connections_unreadable'}


@app.get('/v1/delegent/connections')
async def delegent_list_connections(request: Request) -> Response:
    """Which services the user signed this coworker into. Names only."""
    require_loopback_client(request)
    require_local_adapter_authorization(request.headers.get('authorization'))
    status, body = await _worker_connections_call('/api/runner/connections', None)
    return JSONResponse(body, status_code=status)


@app.post('/v1/delegent/connections/token')
async def delegent_connection_token(request: Request) -> Response:
    """A short-lived access token for one provider call.

    Loopback plus the local adapter key, the same pair that guards the model
    adapter: this is for the agent on this box and nothing else.
    """
    require_loopback_client(request)
    require_local_adapter_authorization(request.headers.get('authorization'))
    try:
        payload = json.loads(await request.body() or b'{}')
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    provider = payload.get('provider') if isinstance(payload, dict) else None
    if not isinstance(provider, str) or not provider.strip():
        raise HTTPException(status_code=400, detail='provider_required')
    status, body = await _worker_connections_call('/api/runner/connections/token', {'provider': provider.strip()})
    return JSONResponse(body, status_code=status)


@app.post('/v1/delegent/connections/composio/execute')
async def delegent_composio_execute(request: Request) -> Response:
    """Run one action on a service brokered by Composio.

    The difference from `/token` above is who does the calling. For our own
    connections we hand the agent a short-lived token and it calls the provider
    itself. Composio holds their grants, so the Worker asks Composio to run the
    action and we pass the result back. Either way nothing lasting is ever on
    this box.

    Same two gates as every other local endpoint: loopback only, plus the local
    adapter key. This is for the agent on this box and nothing else.
    """
    require_loopback_client(request)
    require_local_adapter_authorization(request.headers.get('authorization'))
    try:
        payload = json.loads(await request.body() or b'{}')
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    tool = payload.get('tool')
    if not isinstance(tool, str) or not tool.strip():
        raise HTTPException(status_code=400, detail='tool_required')
    arguments = payload.get('arguments')
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=400, detail='invalid_arguments')
    # Longer than the token call on purpose: fetching a page of mail is a real
    # round trip through Composio to the provider, not a lookup in our own row.
    status, body = await _worker_connections_call(
        '/api/runner/connections/composio/execute',
        {'tool': tool.strip(), 'arguments': arguments},
        timeout=60.0,
    )
    return JSONResponse(body, status_code=status)


@app.post('/v1/delegent/ingest')
async def delegent_ingest(request: Request) -> Response:
    """Loopback ingest for the delegent adapter's outbound deltas.

    The adapter (inside the gateway subprocess) POSTs reply deltas here with
    DELEGENT_RELAY_URL pointed at this endpoint, signed with the shared platform
    secret. We push each onto the run's queue; the Worker's SSE drains it. Every
    legitimate caller is on-box (DELEGENT_RELAY_URL points at 127.0.0.1), so the
    peer-address gate is the primary boundary and the secret is belt-and-braces:
    without the transport gate, a leaked secret alone would let an off-box
    caller write attacker-chosen frames into a live chat transcript."""
    require_loopback_client(request)
    secret = _delegent_platform_secret()
    if secret and not hmac.compare_digest(request.headers.get('x-delegent-platform-secret', ''), secret):
        raise HTTPException(status_code=401, detail='unauthorized')
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='invalid_json') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='invalid_json')
    run_id = str(payload.get('run_id') or '').strip()
    if not run_id:
        # No correlation key — e.g. an autonomous message outside a live turn.
        # Nothing to stream to; ack so the adapter's relay never errors.
        return Response(status_code=204)
    raw_text = payload.get('text')
    item = {
        'kind': str(payload.get('kind') or 'edit'),
        'text': raw_text if isinstance(raw_text, str) else '',
        'final': bool(payload.get('final')),
    }
    outcome = payload.get('outcome')
    if isinstance(outcome, str) and outcome:
        item['outcome'] = outcome
    # Dangerous-command approval card: the adapter's send_exec_approval relays a
    # structured `kind:'approval'` whose fields (approval_id/command/description/
    # choices) the generic text/edit path above would drop. Preserve them so the
    # Worker can forward a button-renderable event to the app. This frame is NOT
    # terminal — only `kind:'done'` closes the stream — so the same turn keeps
    # streaming the post-approval reply.
    if item['kind'] == 'approval':
        for key in ('approval_id', 'command', 'description', 'choices'):
            if key in payload:
                item[key] = payload[key]
    # Clarify question (the adapter's send_clarify): preserve the structured
    # fields so the Worker can finalize the paused turn with the question and
    # unlock the composer for the user's answer. Unlike 'approval' this frame
    # IS terminal for the app run (Worker-side) — the turn's continuation
    # streams on the answer message's own run.
    if item['kind'] == 'clarify':
        for key in ('clarify_id', 'question', 'choices'):
            if key in payload:
                item[key] = payload[key]
    # Record FIRST (authoritative, survives queue close), then best-effort live
    # stream. A frame arriving after the bridge closed still lands in the
    # record, where the Worker's reconcile recovers it.
    _delegent_run_record_update(run_id, item)
    _delegent_stream_push(run_id, item)
    return Response(status_code=204)


@app.get('/v1/delegent/runs/{run_id}/events')
async def delegent_run_events(run_id: str, request: Request) -> StreamingResponse:
    """SSE drain for a delegent turn (HMAC-gated; the Worker proxies this to the
    app). Emits `event: delegent` frames carrying the adapter's raw relay items
    ({kind, text, final}); normalisation (cursor strip + delta computation) is
    the Worker's job, keeping a Hermes-side change out of the runner image.

    Closes on: a terminal `kind:'done'` (the gateway's on_processing_complete
    hook), an idle gap (bypass slash commands never emit 'done' but also emit no
    typing heartbeat), or an absolute max lifetime."""
    require_sidekick_runner_authorization(request)
    if not run_id or not run_id.replace('-', '').replace('_', '').isalnum():
        raise HTTPException(status_code=400, detail='invalid_run_id')
    queue = _delegent_stream_open(run_id)

    async def _drain():
        deadline = time.monotonic() + DELEGENT_STREAM_MAX_LIFETIME_SECS
        last_activity = time.monotonic()
        # Flush headers immediately so the Worker/app sees an open stream.
        yield b': open\n\n'
        # Approval-card replay (2026-07-03): if the run has an UNANSWERED
        # dangerous-command card, re-emit it to this (re)connecting stream.
        # The card frame originally travelled the live queue only, so a
        # dropped app SSE lost it forever while the gate blocked 300s in
        # silence. The Worker translator dedupes by approval_id, so a client
        # that already holds the card renders it once.
        rec = _delegent_run_record_get(run_id)
        if rec and rec.get('done'):
            text = rec['committed'] + rec['segment']
            for replay in ({'kind': 'send', 'text': text, 'final': True},
                           {'kind': 'done', 'outcome': rec.get('outcome'), 'final': True}):
                yield f'event: delegent\ndata: {json.dumps(replay)}\n\n'.encode('utf-8')
            return
        pending = rec.get('pending_approval') if isinstance(rec, dict) else None
        if pending and not (rec or {}).get('done'):
            replay = {'kind': 'approval', 'text': '', 'final': False, **pending}
            yield f'event: delegent\ndata: {json.dumps(replay, separators=(",", ":"))}\n\n'.encode('utf-8')
            last_activity = time.monotonic()
        # Clarify replay (2026-07-10): same durability for an unanswered
        # clarify question — a (re)connecting stream gets it immediately so
        # the Worker can finalize the turn and unlock the composer. The
        # Worker translator dedupes by clarify_id.
        pending_clarify = rec.get('pending_clarify') if isinstance(rec, dict) else None
        if pending_clarify and not (rec or {}).get('done'):
            replay = {'kind': 'clarify', 'final': False, **pending_clarify}
            yield f'event: delegent\ndata: {json.dumps(replay, separators=(",", ":"))}\n\n'.encode('utf-8')
            last_activity = time.monotonic()
        try:
            while True:
                now = time.monotonic()
                if now >= deadline:
                    yield b'event: delegent\ndata: {"kind":"done","final":true,"reason":"max_lifetime"}\n\n'
                    return
                wait = min(DELEGENT_STREAM_KEEPALIVE_SECS, max(0.1, deadline - now))
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=wait)
                except asyncio.TimeoutError:
                    if time.monotonic() - last_activity >= DELEGENT_STREAM_IDLE_SECS:
                        # No relayed activity (not even a typing heartbeat) for
                        # the idle window => the turn is finished. Closes bypass
                        # slash-command streams that never relay 'done'.
                        yield b'event: delegent\ndata: {"kind":"done","final":true,"reason":"idle"}\n\n'
                        return
                    yield b': ka\n\n'
                    continue
                last_activity = time.monotonic()
                data = json.dumps(item, separators=(',', ':'))
                yield f'event: delegent\ndata: {data}\n\n'.encode('utf-8')
                if item.get('kind') == 'done':
                    return
        finally:
            _delegent_stream_close(run_id)

    return StreamingResponse(
        _drain(),
        media_type='text/event-stream',
        headers={
            'cache-control': 'no-store',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
        },
    )


@app.get('/v1/delegent/runs/{run_id}')
async def delegent_run_state(run_id: str, request: Request) -> JSONResponse:
    """Authoritative reconcile read for a delegent turn (HMAC-gated).

    2026-06-12 dropped-reply defect: when the streaming bridge closes early
    (idle gap during a slow tool call, max lifetime, a dropped SSE) the Worker
    used to fabricate a clean completion from whatever partial text it had —
    the user saw a bubble that stopped at the tool markers while the real
    answer landed in a dead queue. This endpoint exposes the run RECORD (the
    queue-independent transcript accumulated by /v1/delegent/ingest) so the
    Worker can keep reconciling until the turn truly finishes — mirroring the
    `GET /v1/runs/{id}` source-of-truth contract the legacy path has.

    404 = no record (pre-fix image, runner restart, or TTL-expired): the
    Worker treats that conservatively and never invents an outcome from it.
    """
    require_sidekick_runner_authorization(request)
    if not run_id or not run_id.replace('-', '').replace('_', '').isalnum():
        raise HTTPException(status_code=400, detail='invalid_run_id')
    _delegent_run_record_sweep()
    rec = _delegent_run_record_get(run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail='run_record_not_found')
    return JSONResponse({
        'found': True,
        'done': bool(rec['done']),
        'outcome': rec['outcome'] or None,
        'text': rec['committed'] + rec['segment'],
        'last_final': bool(rec['last_final']),
        'age_secs': round(time.monotonic() - rec['updated_at'], 3),
        # Unanswered dangerous-command card (2026-07-03): lets the Worker's
        # reconcile path re-surface the Approve card after a dropped stream
        # instead of letting the gate time out silently. None once resolved.
        'pending_approval': rec.get('pending_approval'),
        # Unanswered clarify question (2026-07-10): lets the Worker's reconcile
        # path finalize the paused turn with the question so the composer
        # unlocks for the user's answer. None once resolved.
        'pending_clarify': rec.get('pending_clarify'),
    })


@app.post('/v1/delegent/runs/{run_id}/ack')
async def delegent_run_ack(run_id: str, request: Request) -> JSONResponse:
    require_sidekick_runner_authorization(request)
    rec = _delegent_run_record_get(run_id)
    if rec and rec.get('done'):
        journal = _delegent_journal()
        if journal is not None:
            journal.acknowledge(run_id)
    return JSONResponse({'ok': True})


@app.get('/v1/delegent/gateway-log')
async def delegent_gateway_log(request: Request) -> JSONResponse:
    """Redacted tail of the gateway's combined stdout+stderr (HMAC-gated).

    Operator diagnostics only. Before this existed the gateway ran on DEVNULL,
    so a turn that died inside the agent left no trace anywhere on the box and
    the only symptom was a chat bubble that never filled in.
    """
    require_sidekick_runner_authorization(request)
    try:
        lines = min(max(int(request.query_params.get('lines', '200')), 1), 2000)
    except ValueError:
        lines = 200
    path = _gateway_log_path(Path(os.environ.get('HERMES_HOME', '/data/hermes')))
    if not path.is_file():
        return JSONResponse({'found': False, 'path': str(path), 'lines': []})
    try:
        with path.open('rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            window = min(size, 512 * 1024)
            handle.seek(size - window)
            tail = handle.read().decode('utf-8', errors='replace')
    except OSError as exc:
        raise HTTPException(status_code=500, detail='gateway_log_unreadable') from exc
    return JSONResponse({
        'found': True,
        'path': str(path),
        'size_bytes': size,
        'lines': _redact_gateway_log(tail).splitlines()[-lines:],
    })


if __name__ == '__main__':
    import uvicorn

    raw_port = os.environ.get('PORT', DEFAULT_RUNNER_PORT)
    port = int(raw_port) if raw_port.isdigit() else int(DEFAULT_RUNNER_PORT)
    uvicorn.run(app, host='0.0.0.0', port=port)
