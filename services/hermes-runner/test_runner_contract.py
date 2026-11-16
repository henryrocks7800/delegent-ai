import base64
import hashlib
import hmac
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


class SidekickRunnerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # v1.2.8 — the runner now seeds standard workspace dirs on first
        # ensure_runner_workspace() call. The contract tests assert exact
        # file ordering / counts against test-fixture files, so suppress
        # the seed step here. Production behaviour is unchanged.
        os.environ['DELEGENT_SKIP_WORKSPACE_SEED'] = '1'

    @classmethod
    def tearDownClass(cls):
        os.environ.pop('DELEGENT_SKIP_WORKSPACE_SEED', None)

    def test_seed_delegent_soul_overwrites_hermes_persona(self):
        # Identity guard: SOUL.md must present the Delegent coworker and leak
        # nothing about the underlying Hermes / Nous Research / model. Hermes'
        # own default SOUL.md ("You are Hermes Agent, created by Nous Research")
        # otherwise overrides HERMES_SYSTEM_PROMPT on "who made you" (proven
        # live 2026-06-16).
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            server._seed_delegent_soul(home, 'Han', source={})
            soul = (home / 'SOUL.md').read_text(encoding='utf-8')
        self.assertIn('You are Han,', soul)
        self.assertIn('Delegent', soul)
        for banned in ('Hermes', 'Nous Research', 'kimi', 'Moonshot', 'GPT', 'Claude'):
            self.assertNotIn(banned, soul, f'SOUL.md leaks {banned!r}')
        self.assertNotIn('—', soul, 'SOUL.md contains an em-dash')

    def test_seed_delegent_soul_handles_blank_name(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            server._seed_delegent_soul(home, '', source={})
            soul = (home / 'SOUL.md').read_text(encoding='utf-8')
        self.assertIn('your coworker', soul)
        self.assertNotIn('Hermes', soul)

    def test_seed_delegent_soul_carries_the_behavioural_contract(self):
        # 2026-07-25: the in-app chat runs through the gateway SUBPROCESS, whose
        # env is filtered to SAFE_SUBPROCESS_PASSTHROUGH_ENV and therefore never
        # carried HERMES_SYSTEM_PROMPT. The whole per-user behavioural contract
        # was silently absent from every live conversation. SOUL.md lives on the
        # volume, so it reaches the gateway regardless of env filtering.
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            server._seed_delegent_soul(
                home,
                'Han',
                source={'HERMES_SYSTEM_PROMPT': 'Run `delegent-keys list` before you say you have no access.'},
            )
            soul = (home / 'SOUL.md').read_text(encoding='utf-8')
        self.assertIn('delegent-keys list', soul, 'behavioural contract must reach SOUL.md')
        # Identity must stay FIRST so it keeps winning "who made you".
        self.assertTrue(soul.startswith('You are Han,'), 'identity paragraph must lead')

    def test_seed_delegent_soul_without_a_contract_is_identity_only(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            server._seed_delegent_soul(home, 'Han', source={'HERMES_SYSTEM_PROMPT': '   '})
            soul = (home / 'SOUL.md').read_text(encoding='utf-8')
        self.assertIn('You are Han,', soul)
        self.assertNotIn('\n\n', soul, 'a blank contract must not leave a dangling separator')

    def test_build_sidekick_runner_headers_signs_user_and_timestamp(self):
        headers = server.build_sidekick_runner_headers(
            user_id='user_123',
            shared_secret='runner_secret',
            now=1770000000,
        )
        expected = hmac.new(
            b'runner_secret',
            b'v1:user_123:1770000000',
            hashlib.sha256,
        ).hexdigest()

        self.assertEqual(headers['x-sidekick-user-id'], 'user_123')
        self.assertEqual(headers['x-sidekick-runner-timestamp'], '1770000000')
        self.assertEqual(headers['x-sidekick-runner-token'], f'v1.{expected}')
        self.assertNotIn('authorization', {key.lower(): value for key, value in headers.items()})

    def test_build_hermes_query_includes_history_unavailable_caution(self):
        # 2026-06-03 critical defect: a transient history-load failure made the
        # agent tell the user "this is our very first conversation". When the
        # dispatcher flags history_unavailable, the prompt must warn the agent
        # NOT to claim it's a new/first conversation.
        task = server.TaskIn(user_id='user_123', instruction='What happened?', history=None, history_unavailable=True)
        prompt = server.build_hermes_query(task)
        self.assertIn('could not load our earlier conversation', prompt)
        self.assertIn('Do NOT tell the user this is a new or first conversation', prompt)
        self.assertIn('What happened?', prompt)

    def test_build_hermes_query_no_caution_for_genuine_empty_conversation(self):
        # A real new user (no history, no failure) must NOT get the caution.
        task = server.TaskIn(user_id='user_123', instruction='Hello', history=None, history_unavailable=False)
        prompt = server.build_hermes_query(task)
        self.assertNotIn('could not load our earlier conversation', prompt)
        self.assertNotIn('Recent conversation', prompt)

    def test_build_hermes_query_includes_history_when_present(self):
        task = server.TaskIn(
            user_id='user_123',
            instruction='Continue please',
            history=[
                server.ChatHistoryTurn(role='user', content='Make me a spreadsheet'),
                server.ChatHistoryTurn(role='assistant', content='Done, saved it.'),
            ],
            agent_name='Mike',
        )
        prompt = server.build_hermes_query(task)
        self.assertIn('Recent conversation (oldest first):', prompt)
        self.assertIn('Make me a spreadsheet', prompt)
        self.assertIn('Mike: Done, saved it.', prompt)
        self.assertNotIn('could not load our earlier conversation', prompt)

    # --- Step 2: Hermes-session continuity (2026-06-03 chat-memory architecture) ---

    def test_build_hermes_chat_command_resume_vs_seed(self):
        env = {'HERMES_INFERENCE_MODEL': 'openrouter/auto'}
        resume_cmd = server.build_hermes_chat_command(env, 'terminal,file,web', resume=True, query='hi again')
        self.assertIn('--continue', resume_cmd)          # resume the durable session
        self.assertEqual(resume_cmd[-2:], ['--query', 'hi again'])
        seed_cmd = server.build_hermes_chat_command(env, 'terminal,file,web', resume=False, query='full prompt')
        self.assertNotIn('--continue', seed_cmd)         # seed / single-shot
        self.assertEqual(seed_cmd[-2:], ['--query', 'full prompt'])
        self.assertIn('--provider', seed_cmd)

    def test_hermes_session_continuity_flag(self):
        with patch.dict(os.environ, {'SIDEKICK_HERMES_SESSION_CONTINUITY': 'true'}):
            self.assertTrue(server._hermes_session_continuity_enabled())
        with patch.dict(os.environ, {'SIDEKICK_HERMES_SESSION_CONTINUITY': 'false'}):
            self.assertFalse(server._hermes_session_continuity_enabled())
        env = dict(os.environ); env.pop('SIDEKICK_HERMES_SESSION_CONTINUITY', None)
        with patch.dict(os.environ, env, clear=True):
            self.assertFalse(server._hermes_session_continuity_enabled())  # off by default

    def test_hermes_no_session_to_continue_detection(self):
        class R:
            def __init__(self, rc, out='', err=''):
                self.returncode, self.stdout, self.stderr = rc, out, err
        self.assertTrue(server._hermes_no_session_to_continue(R(1, 'No previous CLI session found to continue.')))
        self.assertFalse(server._hermes_no_session_to_continue(R(0, 'a reply')))           # success
        self.assertFalse(server._hermes_no_session_to_continue(R(1, 'some other error')))  # real failure, not cold start

    def _run_subprocess_task(self, flag, fake_run):
        env = {'HERMES_INFERENCE_MODEL': 'm'}
        with patch.dict(os.environ, {'SIDEKICK_HERMES_SESSION_CONTINUITY': flag}), \
             patch.object(server.subprocess, 'run', side_effect=fake_run), \
             patch.object(server, 'build_hermes_subprocess_env', return_value=env), \
             patch.object(server, 'ensure_runner_workspace', return_value=Path('/tmp')):
            task = server.TaskIn(user_id='u', instruction='the new message', history=None)
            return server._create_task_via_subprocess('tid', 'u', 'FULL PROMPT WITH HISTORY', task)

    def test_session_mode_resumes_existing_session_with_only_the_new_message(self):
        calls = []

        class R:
            def __init__(self, rc, out=''):
                self.returncode, self.stdout, self.stderr = rc, out, ''

        def fake_run(cmd, **kw):
            calls.append(cmd)
            return R(0, 'resumed reply')

        resp = self._run_subprocess_task('true', fake_run)
        self.assertEqual(len(calls), 1)                       # resumed, no seed
        self.assertIn('--continue', calls[0])
        self.assertEqual(calls[0][-2:], ['--query', 'the new message'])  # NOT the full history prompt
        self.assertEqual(resp['status'], 'completed')

    def test_session_mode_seeds_when_no_session_yet_cold_box(self):
        calls = []

        class R:
            def __init__(self, rc, out=''):
                self.returncode, self.stdout, self.stderr = rc, out, ''

        def fake_run(cmd, **kw):
            calls.append(cmd)
            if '--continue' in cmd:
                return R(1, 'No previous CLI session found to continue.')
            return R(0, 'seeded reply')

        self._run_subprocess_task('true', fake_run)
        self.assertEqual(len(calls), 2)                       # tried resume, then seeded
        self.assertIn('--continue', calls[0])
        self.assertNotIn('--continue', calls[1])
        self.assertEqual(calls[1][-2:], ['--query', 'FULL PROMPT WITH HISTORY'])  # seeded WITH the Supabase history

    def test_session_mode_off_uses_legacy_single_shot_full_prompt(self):
        calls = []

        class R:
            def __init__(self, rc, out=''):
                self.returncode, self.stdout, self.stderr = rc, out, ''

        def fake_run(cmd, **kw):
            calls.append(cmd)
            return R(0, 'reply')

        self._run_subprocess_task('false', fake_run)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('--continue', calls[0])
        self.assertEqual(calls[0][-2:], ['--query', 'FULL PROMPT WITH HISTORY'])

    def test_healthz_reports_active_window_tokens(self):
        # 2026-08-02: the compaction incident sat unnoticed for nine days
        # because the active window was only visible via an ad-hoc sqlite query
        # over SSH. /healthz now carries it, so `flyctl checks list` shows it on
        # every glance. Contract: a count only (chars/4), no content, and a
        # missing or unreadable state.db must read as null, never a failed probe.
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            db = sqlite3.connect(home / 'state.db')
            db.execute('CREATE TABLE messages (content TEXT, active INTEGER, session_id TEXT)')
            db.execute('CREATE TABLE sessions (id TEXT)')
            db.execute("INSERT INTO messages VALUES (?, 1, 's1')", ('x' * 4000,))
            db.execute("INSERT INTO messages VALUES (?, 1, 's1')", ('y' * 4000,))
            # A SECOND session. Compaction is per-session, so this must NOT be
            # added to s1's window: summing across sessions was the original
            # bug, and it read in the millions on a real box with 2,035 cron
            # sessions while every single one sat under the trigger.
            db.execute("INSERT INTO messages VALUES (?, 1, 's2')", ('w' * 40000,))
            # Compacted rows must NOT count toward the active window.
            db.execute("INSERT INTO messages VALUES (?, 0, 's1')", ('z' * 400000,))
            db.executemany('INSERT INTO sessions VALUES (?)', [('s1',), ('s2',)])
            db.commit()
            db.close()
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}, clear=False):
                body = TestClient(server.app).get('/healthz').json()
            # MAX per session (s2 = 40000 chars), never the 44000-char sum.
            self.assertEqual(body['activeWindowTokens'], 10000)
            self.assertEqual(body['sessionCount'], 2)
            # No content leaks: the healthz payload never carries message text.
            self.assertNotIn('x' * 32, json.dumps(body))

        # Missing db (a runner before its first chat) is null, and healthz is
        # still ok — the field must never fail readiness.
        with tempfile.TemporaryDirectory() as d2:
            with patch.dict(os.environ, {'HERMES_HOME': d2}, clear=False):
                body = TestClient(server.app).get('/healthz').json()
            self.assertIsNone(body['activeWindowTokens'])
            self.assertTrue(body['ok'])

    # /proc/meminfo does not exist off Linux; the endpoint returns memory=None
    # there by design, so the assertions are Linux-only. The runner only ever
    # runs on Linux (Fly); CI's python-runner-gate keeps this honest.
    @unittest.skipUnless(os.path.exists('/proc/meminfo'), 'needs /proc/meminfo (Linux); runner never runs on Windows')
    def test_healthz_reports_memory_for_the_sizing_decision(self):
        # Every runner is allocated 2048 MB and nobody has ever measured whether a
        # real workload goes near it. The storage ladder was built on telemetry;
        # compute sizing should be too, rather than on an opinion about what
        # headless Chromium might need. Sampled by Fly's existing health check
        # poll, so this costs no timer, cron or extra process.
        body = TestClient(server.app).get('/healthz').json()
        mem = body['memory']
        self.assertIsNotNone(mem, '/proc/meminfo should be readable on Linux CI')
        self.assertGreater(mem['totalMb'], 0)
        self.assertGreaterEqual(mem['usedMb'], 0)
        # The peak is a high-water mark, so it can never be below the current
        # reading taken in the same call.
        self.assertGreaterEqual(mem['peakUsedMb'], mem['usedMb'])
        # A count, not content: nothing here may carry conversation text.
        self.assertNotIn('content', json.dumps(mem))

    @unittest.skipUnless(os.path.exists('/proc/meminfo'), 'needs /proc/meminfo (Linux); runner never runs on Windows')
    def test_healthz_memory_peak_never_goes_down(self):
        # A high-water mark that can fall is not a high-water mark, and it would
        # quietly under-report the very spike the sizing decision depends on.
        client = TestClient(server.app)
        first = client.get('/healthz').json()['memory']['peakUsedMb']
        server._PEAK_MEMORY_USED_MB = max(server._PEAK_MEMORY_USED_MB, first + 500)
        raised = client.get('/healthz').json()['memory']['peakUsedMb']
        self.assertGreaterEqual(raised, first + 500)
        # A later, lower current reading must not pull the peak back down.
        again = client.get('/healthz').json()['memory']
        self.assertGreaterEqual(again['peakUsedMb'], raised)

    def test_health_requires_sidekick_runner_headers_and_stays_product_safe(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = server.build_sidekick_runner_headers(
            user_id='user_owner',
            shared_secret='runner_secret',
            now=int(time.time()),
        )
        with patch.dict(os.environ, env, clear=False):
            missing = client.get('/health')
            valid = client.get('/health', headers=headers)

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(valid.status_code, 200)
        body = valid.json()
        # Core auth invariants — must stay regardless of the Series 4 fields below.
        self.assertEqual(body['ok'], True)
        self.assertEqual(body['engine'], 'hermes-agent')
        # Series 4 — /health now surfaces Hermes availability + workspace
        # readiness + the safe (version + short commit) image summary so
        # operators can prove which golden image is running. Values are
        # bools / nullable strings; no secrets, no provider IDs.
        self.assertIn('hermesAvailable', body)
        self.assertIsInstance(body['hermesAvailable'], bool)
        self.assertIn('workspaceReady', body)
        self.assertIsInstance(body['workspaceReady'], bool)
        self.assertIn('hermesVersion', body)
        self.assertIn('hermesCommitShort', body)
        self.assertNotIn('runner_secret', valid.text)
        self.assertNotIn('user_owner', valid.text)

    def test_railway_health_can_be_unsigned_when_explicitly_enabled(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'SIDEKICK_ALLOW_UNSIGNED_HEALTH': 'true',
        }
        with patch.dict(os.environ, env, clear=False):
            response = client.get('/health')

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['ok'], True)
        self.assertEqual(body['engine'], 'hermes-agent')
        # Same Series 4 surface as the signed-health test.
        self.assertIn('hermesAvailable', body)
        self.assertIn('workspaceReady', body)
        self.assertIn('hermesVersion', body)
        self.assertIn('hermesCommitShort', body)
        self.assertNotIn('runner_secret', response.text)
        self.assertNotIn('user_owner', response.text)

    def test_worker_chat_completion_url_accepts_base_or_chat_endpoint(self):
        self.assertEqual(
            server.worker_chat_completion_url('https://worker.sidekick.dev'),
            'https://worker.sidekick.dev/v1/chat/completions',
        )
        self.assertEqual(
            server.worker_chat_completion_url('https://worker.sidekick.dev/v1'),
            'https://worker.sidekick.dev/v1/chat/completions',
        )
        self.assertEqual(
            server.worker_chat_completion_url('https://worker.sidekick.dev/v1/chat/completions'),
            'https://worker.sidekick.dev/v1/chat/completions',
        )
        with self.assertRaises(server.HTTPException):
            server.worker_chat_completion_url('http://worker.sidekick.dev/v1')
        self.assertEqual(
            server.worker_chat_completion_url('http://127.0.0.1:8787/v1', {'SIDEKICK_ALLOW_LOCAL_WORKER_PROXY': 'true'}),
            'http://127.0.0.1:8787/v1/chat/completions',
        )
        with self.assertRaises(server.HTTPException):
            server.worker_chat_completion_url('http://127.0.0.1:8787/v1')
        with self.assertRaises(server.HTTPException):
            server.worker_chat_completion_url('https://user:pass@worker.sidekick.dev/v1')
        with self.assertRaises(server.HTTPException):
            server.worker_chat_completion_url('https://worker.sidekick.dev.evil.test/v1')

    def test_hermes_subprocess_env_points_to_local_signing_adapter_and_strips_provider_secrets(self):
        env = server.build_hermes_subprocess_env({
            'PORT': '8642',
            'HERMES_HOME': '/data/hermes',
            'HERMES_TOOLSETS': 'file,web',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
            'OPENROUTER_API_KEY': 'or_should_not_reach_hermes',
            'SUPABASE_SERVICE_ROLE_KEY': 'service_role_should_not_reach_hermes',
            'RAILWAY_API_TOKEN': 'railway_should_not_reach_hermes',
            'ADMIN_PASSWORD': 'admin_should_not_reach_hermes',
            'CLOUDFLARE_API_TOKEN': 'cloudflare_should_not_reach_hermes',
        })

        self.assertEqual(env['HERMES_HOME'], '/data/hermes')
        self.assertEqual(env['CUSTOM_BASE_URL'], 'http://127.0.0.1:8642/v1')
        self.assertEqual(env['HERMES_MODEL_BASE_URL'], 'http://127.0.0.1:8642/v1')
        self.assertEqual(env['HERMES_INFERENCE_PROVIDER'], 'custom')
        self.assertEqual(env['HERMES_INFERENCE_MODEL'], 'openrouter/auto')
        self.assertEqual(env['OPENAI_API_KEY'], server.derive_local_adapter_api_key('runner_secret'))
        self.assertEqual(env['HERMES_API_KEY'], server.derive_local_adapter_api_key('runner_secret'))
        self.assertNotEqual(env['OPENAI_API_KEY'], 'runner_secret')
        self.assertNotIn('OPENROUTER_API_KEY', env)
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', env)
        self.assertNotIn('RAILWAY_API_TOKEN', env)
        self.assertNotIn('ADMIN_PASSWORD', env)
        self.assertNotIn('CLOUDFLARE_API_TOKEN', env)
        self.assertNotIn('SIDEKICK_WORKER_PROXY_URL', env)
        self.assertNotIn('SIDEKICK_RUNNER_SHARED_SECRET', env)

    def test_hermes_subprocess_env_passes_web_search_provider_keys_to_the_agent(self):
        # 2026-06-04 regression guard: the agent's `web` toolset
        # (web_search/web_extract) is gated on a web-search provider key via
        # Hermes' check_web_api_key. build_hermes_subprocess_env() is the env
        # the gateway (api_server / streaming /v1/runs — the path the app uses)
        # AND the legacy /tasks subprocess actually run with. If the key isn't
        # in the allowlist it is silently dropped and the agent loses web_search
        # even though the machine env has it — the exact "it can't reach the
        # internet, it's curling DuckDuckGo" defect (PRODUCTION_READINESS §24).
        env = server.build_hermes_subprocess_env({
            'PORT': '8642',
            'HERMES_HOME': '/data/hermes',
            'HERMES_TOOLSETS': 'file,web',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'FIRECRAWL_API_KEY': 'fc-live-key',
            'FIRECRAWL_API_URL': 'https://firecrawl.example/v1',
            'SEARXNG_URL': 'https://searxng.example',
            'TAVILY_API_KEY': 'tvly-key',
            'EXA_API_KEY': 'exa-key',
            'PARALLEL_API_KEY': 'parallel-key',
        })

        self.assertEqual(env['FIRECRAWL_API_KEY'], 'fc-live-key')
        self.assertEqual(env['FIRECRAWL_API_URL'], 'https://firecrawl.example/v1')
        self.assertEqual(env['SEARXNG_URL'], 'https://searxng.example')
        self.assertEqual(env['TAVILY_API_KEY'], 'tvly-key')
        self.assertEqual(env['EXA_API_KEY'], 'exa-key')
        self.assertEqual(env['PARALLEL_API_KEY'], 'parallel-key')

    def test_hermes_subprocess_env_disables_pyc_and_passes_timezone(self):
        # 2026-07-22: agent-authored cron scripts inherit this env. Stale .pyc
        # ran old code after in-place edits, and UTC-defaulted times showed
        # wrong to the user. PYTHONDONTWRITEBYTECODE is always on; TZ passes
        # through when ops sets a per-machine value (unset stays UTC).
        env = server.build_hermes_subprocess_env({
            'PORT': '8642',
            'HERMES_HOME': '/data/hermes',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'TZ': 'Europe/London',
        })
        self.assertEqual(env['PYTHONDONTWRITEBYTECODE'], '1')
        self.assertEqual(env['TZ'], 'Europe/London')
        # Unset TZ must NOT appear (container stays UTC; no empty TZ= shadow).
        env_no_tz = server.build_hermes_subprocess_env({
            'PORT': '8642',
            'HERMES_HOME': '/data/hermes',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        })
        self.assertNotIn('TZ', env_no_tz)
        self.assertEqual(env_no_tz['PYTHONDONTWRITEBYTECODE'], '1')

    def test_hermes_subprocess_env_omits_web_search_keys_that_are_unset(self):
        # Only forward keys that are actually present so we never write an empty
        # FIRECRAWL_API_KEY= that could shadow a real value downstream.
        env = server.build_hermes_subprocess_env({
            'PORT': '8642',
            'HERMES_HOME': '/data/hermes',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'FIRECRAWL_API_KEY': 'fc-live-key',
        })

        self.assertEqual(env['FIRECRAWL_API_KEY'], 'fc-live-key')
        self.assertNotIn('TAVILY_API_KEY', env)
        self.assertNotIn('EXA_API_KEY', env)
        self.assertNotIn('SEARXNG_URL', env)

    def test_hermes_subprocess_env_passes_playwright_browsers_path_for_browser_toolset(self):
        # 2026-06-04: the `browser` toolset's agent-browser CLI + Playwright
        # resolve the bundled Chromium via PLAYWRIGHT_BROWSERS_PATH. The image
        # sets it (/opt/playwright); it must survive build_hermes_subprocess_env's
        # allowlist or the agent runtime falls back to ~/.cache/ms-playwright,
        # misses the browser, and check_browser_requirements fails — the same
        # allowlist-strip class as the web-search keys (PRODUCTION_READINESS §24).
        env = server.build_hermes_subprocess_env({
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'PLAYWRIGHT_BROWSERS_PATH': '/opt/playwright',
        })
        self.assertEqual(env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/playwright')

    def test_worker_chat_request_targets_worker_with_signed_headers(self):
        url, headers, body = server.build_worker_chat_request(
            {'model': 'openrouter/auto', 'messages': [{'role': 'user', 'content': 'hi'}]},
            {
                'SIDEKICK_USER_ID': 'user_123',
                'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            },
            now=1770000000,
        )

        expected = hmac.new(
            b'runner_secret',
            b'v1:user_123:1770000000',
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(url, 'https://worker.sidekick.dev/v1/chat/completions')
        self.assertEqual(headers['x-sidekick-user-id'], 'user_123')
        self.assertEqual(headers['x-sidekick-runner-token'], f'v1.{expected}')
        self.assertEqual(headers['content-type'], 'application/json')
        # Cloudflare's default bot protection on workers.dev rejects Python's
        # default `Python-urllib/<ver>` UA with HTTP 403 / "error code 1010",
        # which silently breaks the real `hermes chat` -> adapter -> Worker path.
        # Regression for the P0 runner/model path: outbound requests must
        # carry an identifying coworker-ai User-Agent.
        self.assertEqual(headers['user-agent'], 'coworker-ai-runner/0.1')
        self.assertIn(b'openrouter/auto', body)
        self.assertNotIn(b'runner_secret', body)
        parsed_body = json.loads(body.decode('utf-8'))
        self.assertEqual(parsed_body['stream'], False)
        self.assertEqual(parsed_body['max_tokens'], server.MIN_WORKER_COMPLETION_TOKENS)
        self.assertEqual(parsed_body['reasoning'], {'effort': 'none', 'exclude': True})

    def test_worker_chat_request_preserves_explicit_native_token_budgets(self):
        payload = server.build_worker_chat_payload({
            'messages': [{'role': 'user', 'content': 'hi'}],
            'stream': True,
            'max_tokens': 32,
            'reasoning': {'effort': 'high'},
        })

        # Token-streaming rollout: build_worker_chat_payload PASSES stream through
        # (server.py:595) so the gateway's stream:true reaches the Worker proxy.
        self.assertEqual(payload['stream'], True)
        self.assertEqual(payload['max_tokens'], 32)
        self.assertEqual(payload['reasoning'], {'effort': 'none', 'exclude': True})

    def test_worker_chat_request_keeps_provider_safe_completion_budget(self):
        self.assertLessEqual(server.MIN_WORKER_COMPLETION_TOKENS, 3000)

    def test_worker_chat_request_fails_closed_without_proxy_or_shared_secret(self):
        with self.assertRaises(server.HTTPException) as missing_proxy:
            server.build_worker_chat_request({'messages': []}, {
                'SIDEKICK_USER_ID': 'user_123',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            })
        with self.assertRaises(server.HTTPException) as missing_secret:
            server.build_worker_chat_request({'messages': []}, {
                'SIDEKICK_USER_ID': 'user_123',
                'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
            })

        self.assertEqual(missing_proxy.exception.status_code, 503)
        self.assertEqual(missing_secret.exception.status_code, 503)

    def test_chat_completions_rejects_missing_or_wrong_local_bearer_before_signing(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        with patch.dict(os.environ, env, clear=False):
            with patch('server.urllib.request.urlopen') as urlopen:
                missing = client.post('/v1/chat/completions', json={'messages': []})
                wrong = client.post(
                    '/v1/chat/completions',
                    json={'messages': []},
                    headers={'authorization': 'Bearer sidekick-local-adapter'},
                )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        urlopen.assert_not_called()

    # ------------------------------------------------------------------
    # 2026-07-04 provider-error incident: the streaming relay MUST propagate
    # the Worker's HTTP status. The old relay returned an unconditional
    # HTTP-200 StreamingResponse, so every Worker error (401/402/5xx JSON)
    # reached Hermes as an "empty SSE stream with no finish_reason" —
    # unclassifiable, and fatal to the turn within seconds.
    # ------------------------------------------------------------------

    _ADAPTER_ENV = {
        'SIDEKICK_USER_ID': 'user_owner',
        'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
        'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
    }

    @staticmethod
    def _fake_async_client(send_result=None, send_exc=None):
        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            def build_request(self, method, url, content=None, headers=None):
                return {'method': method, 'url': url}

            async def send(self, request, stream=False):
                if send_exc is not None:
                    raise send_exc
                return send_result

            async def aclose(self):
                return None

        return FakeClient

    def test_chat_completions_stream_propagates_worker_error_status(self):
        client = TestClient(server.app)
        local_key = server.derive_local_adapter_api_key('runner_secret')

        class WorkerError:
            status_code = 503
            headers = {'content-type': 'application/json', 'retry-after': '9'}

            async def aread(self):
                return json.dumps({'error': 'authorization is temporarily unavailable'}).encode('utf-8')

            async def aclose(self):
                return None

        with patch.dict(os.environ, self._ADAPTER_ENV, clear=False):
            with patch.object(server.httpx, 'AsyncClient', self._fake_async_client(send_result=WorkerError())):
                response = client.post(
                    '/v1/chat/completions',
                    json={'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True},
                    headers={'authorization': f'Bearer {local_key}'},
                )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'authorization is temporarily unavailable'})
        self.assertIn('application/json', response.headers['content-type'])
        # The Worker maps upstream 429s through with retry-after so the agent
        # backs off honestly — the header must survive the adapter hop too.
        self.assertEqual(response.headers.get('retry-after'), '9')

    def test_chat_completions_stream_connect_failure_returns_502_not_empty_stream(self):
        client = TestClient(server.app)
        local_key = server.derive_local_adapter_api_key('runner_secret')

        with patch.dict(os.environ, self._ADAPTER_ENV, clear=False):
            with patch.object(
                server.httpx, 'AsyncClient',
                self._fake_async_client(send_exc=server.httpx.ConnectError('connection refused')),
            ):
                response = client.post(
                    '/v1/chat/completions',
                    json={'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True},
                    headers={'authorization': f'Bearer {local_key}'},
                )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {'error': 'worker_proxy_unavailable'})

    def test_chat_completions_stream_relays_200_sse_untouched(self):
        client = TestClient(server.app)
        local_key = server.derive_local_adapter_api_key('runner_secret')

        class WorkerSse:
            status_code = 200
            headers = {'content-type': 'text/event-stream'}

            async def aiter_bytes(self):
                yield b'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n'
                yield b'data: [DONE]\n\n'

            async def aclose(self):
                return None

        with patch.dict(os.environ, self._ADAPTER_ENV, clear=False):
            with patch.object(server.httpx, 'AsyncClient', self._fake_async_client(send_result=WorkerSse())):
                response = client.post(
                    '/v1/chat/completions',
                    json={'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True},
                    headers={'authorization': f'Bearer {local_key}'},
                )

        self.assertEqual(response.status_code, 200)
        self.assertIn('text/event-stream', response.headers['content-type'])
        self.assertIn('"content":"hi"', response.text)
        self.assertIn('data: [DONE]', response.text)

    def test_seed_gateway_config_sets_api_retry_budget(self):
        # 2026-07-04: the default of 3 attempts burned out inside a ~10s blip.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            ok = server._seed_hermes_gateway_config(home, '127.0.0.1', 8643, 'bearer_x')
            self.assertTrue(ok)
            text = (home / 'config.yaml').read_text(encoding='utf-8')
            self.assertIn('agent:\n  api_max_retries: 5\n', text)
            # Dan-quota fix: compact the durable session earlier than Hermes'
            # default (0.5 of the window) so each turn re-sends less history, the
            # dominant token cost.
            #
            # 0.06 against deepseek-v4-flash's 1,048,576 window gives a 64,000
            # trigger, versus 262,144 at the old 0.25. Verified live on
            # 2026-08-02: prompt tokens per turn fell 173,771 -> 46,465.
            #
            # The trigger is max(window * threshold, 64_000), so this fraction is
            # meaningless without the window. On kimi's 262,144 window 0.25 and
            # 0.06 both land near 64K and the setting looks inert. It IS inert
            # there. Re-derive it whenever the model changes.
            # 2026-09-07: 0.06 -> 0.12. On gpt-5.6-luna (1,050,000) the 0.06
            # product is ~55K, so the trigger was the 64K floor, and the fixed
            # prompt had grown to ~66K, above it: compaction on nearly every
            # turn, ~50K of quota per pass. 0.12 is a ~110K trigger with ~45K
            # of headroom, the same headroom the August tuning had.
            self.assertIn('compression:\n  enabled: true\n  threshold: 0.12\n', text)
            self.assertIn('  abort_on_summary_failure: true\n', text)

    def test_seed_gateway_config_switches_off_hermes_profile_onboarding(self):
        # 2026-09-12: Hermes' agent/onboarding.py injects "[System note: This is
        # the user's very first message ever. After a one-sentence introduction
        # (mention /help shows commands), OFFER ... to build a short profile"
        # on the first message of a fresh session store. Every new user since
        # 27 Aug got "`/help` shows the available commands" as their first real
        # reply, and typing /help returns a raw gateway dump. The app has no
        # command menu and the wake message already welcomes them. 'off' is the
        # documented switch (profile_build_mode in hermes-agent v2026.7.20).
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertTrue(server._seed_hermes_gateway_config(home, '127.0.0.1', 8643, 'b'))
            text = (home / 'config.yaml').read_text(encoding='utf-8')
            self.assertIn('onboarding:\n  profile_build: off\n', text)

    def test_seed_gateway_config_pins_narration_display(self):
        # 2026-07-22: pin Hermes v0.19's narration defaults for the in-app
        # platform (interim plain-English lines + tool progress) so an upstream
        # default change can't silently mute or flood the chat. Scoped under
        # display.platforms.delegent — api_server keeps Hermes' own defaults.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            self.assertTrue(server._seed_hermes_gateway_config(home, '127.0.0.1', 8643, 'b'))
            text = (home / 'config.yaml').read_text(encoding='utf-8')
            self.assertIn(
                'display:\n  platforms:\n    delegent:\n'
                '      tool_progress: all\n'
                '      interim_assistant_messages: true\n',
                text,
            )

    def test_seed_gateway_config_narration_env_knobs(self):
        # Per-machine tuning without an image rebuild: DELEGENT_TOOL_PROGRESS
        # (off|new|all|verbose; junk values fall back to all) and
        # DELEGENT_INTERIM_NARRATION (on/off) flow into the seeded display
        # block on the next boot (`fly machine update --env` restarts the box).
        cases = [
            ({'DELEGENT_TOOL_PROGRESS': 'new'}, 'tool_progress: new', 'interim_assistant_messages: true'),
            ({'DELEGENT_TOOL_PROGRESS': 'off', 'DELEGENT_INTERIM_NARRATION': 'off'},
             'tool_progress: off', 'interim_assistant_messages: false'),
            ({'DELEGENT_TOOL_PROGRESS': 'bogus'}, 'tool_progress: all', 'interim_assistant_messages: true'),
        ]
        for env_extra, want_tp, want_interim in cases:
            with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, env_extra, clear=False):
                home = Path(tmp)
                self.assertTrue(server._seed_hermes_gateway_config(home, '127.0.0.1', 8643, 'b'))
                text = (home / 'config.yaml').read_text(encoding='utf-8')
                self.assertIn(want_tp, text, f'{env_extra} -> {want_tp}')
                self.assertIn(want_interim, text, f'{env_extra} -> {want_interim}')

    @unittest.skip(
        "Stale since the token-streaming rollout: /v1/chat/completions now relays the "
        "Worker SSE via httpx (_relay_worker_sse, server.py:1066) when stream:true, but "
        "this still mocks the old urllib JSON->SSE path so it makes a real network call. "
        "Rework to mock httpx.AsyncClient.stream. Streaming works in prod — this is test debt."
    )
    def test_chat_completions_bridges_worker_json_back_to_streaming_chunks(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        local_key = server.derive_local_adapter_api_key('runner_secret')

        class Upstream:
            status = 200
            headers = {'content-type': 'application/json'}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    'id': 'chatcmpl_fixture',
                    'created': 1770000000,
                    'model': 'coworker-ai',
                    'choices': [{'message': {'role': 'assistant', 'content': 'stream bridge ok'}}],
                }).encode('utf-8')

        with patch.dict(os.environ, env, clear=False):
            with patch('server.urllib.request.urlopen', return_value=Upstream()) as urlopen:
                response = client.post(
                    '/v1/chat/completions',
                    json={'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True, 'max_tokens': 4},
                    headers={'authorization': f'Bearer {local_key}'},
                )

        self.assertEqual(response.status_code, 200)
        self.assertIn('text/event-stream', response.headers['content-type'])
        self.assertIn('data: ', response.text)
        self.assertIn('stream bridge ok', response.text)
        self.assertIn('data: [DONE]', response.text)
        outbound_body = json.loads(urlopen.call_args.args[0].data.decode('utf-8'))
        self.assertEqual(outbound_body['stream'], False)
        self.assertEqual(outbound_body['max_tokens'], server.MIN_WORKER_COMPLETION_TOKENS)

    @unittest.skip(
        "Stale since the token-streaming rollout (see the back-to-streaming-chunks test above): "
        "stream:true now relays the Worker SSE via httpx, but this mocks the old urllib JSON path. "
        "Rework to mock httpx.AsyncClient.stream for the tool-call SSE relay."
    )
    def test_chat_completions_bridges_worker_json_tool_calls_back_to_streaming_chunks(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_WORKER_PROXY_URL': 'https://worker.sidekick.dev/v1',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        local_key = server.derive_local_adapter_api_key('runner_secret')

        class Upstream:
            status = 200
            headers = {'content-type': 'application/json'}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    'id': 'chatcmpl_fixture',
                    'created': 1770000000,
                    'model': 'coworker-ai',
                    'choices': [{
                        'finish_reason': 'tool_calls',
                        'message': {
                            'role': 'assistant',
                            'content': None,
                            'tool_calls': [{
                                'id': 'call_fixture',
                                'type': 'function',
                                'function': {
                                    'name': 'write_file',
                                    'arguments': '{"path":"test file.txt","content":"ok"}',
                                },
                            }],
                        },
                    }],
                }).encode('utf-8')

        with patch.dict(os.environ, env, clear=False):
            with patch('server.urllib.request.urlopen', return_value=Upstream()):
                response = client.post(
                    '/v1/chat/completions',
                    json={'messages': [{'role': 'user', 'content': 'create a file'}], 'stream': True},
                    headers={'authorization': f'Bearer {local_key}'},
                )

        self.assertEqual(response.status_code, 200)
        self.assertIn('text/event-stream', response.headers['content-type'])
        self.assertIn('"tool_calls"', response.text)
        self.assertIn('"id":"call_fixture"', response.text)
        self.assertIn('"name":"write_file"', response.text)
        self.assertIn('"arguments":"{\\"path\\":\\"test file.txt\\",\\"content\\":\\"ok\\"}"', response.text)
        self.assertIn('"finish_reason":"tool_calls"', response.text)

    def test_tasks_reject_missing_sidekick_runner_headers_before_running_hermes(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        with patch.dict(os.environ, env, clear=False):
            with patch('server.subprocess.run') as run:
                response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'})

        self.assertEqual(response.status_code, 401)
        run.assert_not_called()

    def test_tasks_reject_local_adapter_bearer_before_running_hermes(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = {'authorization': f"Bearer {server.derive_local_adapter_api_key('runner_secret')}"}
        with patch.dict(os.environ, env, clear=False):
            with patch('server.subprocess.run') as run:
                response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'}, headers=headers)

        self.assertEqual(response.status_code, 401)
        run.assert_not_called()

    def test_create_task_rejects_cross_user_requests_before_running_hermes(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = server.build_sidekick_runner_headers(
            user_id='user_owner',
            shared_secret='runner_secret',
            now=int(time.time()),
        )
        with patch.dict(os.environ, env, clear=False):
            with patch('server.subprocess.run') as run:
                raised = client.post('/tasks', json={'user_id': 'attacker', 'instruction': 'do thing'}, headers=headers)

        self.assertEqual(raised.status_code, 403)
        run.assert_not_called()

    def test_files_endpoint_requires_signed_headers_and_lists_only_safe_workspace_files(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            safe_file = workspace / 'report.txt'
            safe_file.write_text('hello from storage', encoding='utf-8')
            (workspace / '.hidden.txt').write_text('hidden', encoding='utf-8')
            (workspace / '.env').write_text('SIDEKICK_RUNNER_SHARED_SECRET=leak', encoding='utf-8')
            (workspace / 'api_token.txt').write_text('secret', encoding='utf-8')
            (workspace / 'nested').mkdir()
            (workspace / 'nested' / 'notes.md').write_text('# notes', encoding='utf-8')
            outside = Path(home) / 'outside.txt'
            outside.write_text('outside', encoding='utf-8')
            try:
                (workspace / 'escape.txt').symlink_to(outside)
            except OSError:
                pass

            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                missing = client.get('/files')
                response = client.get('/files', headers=headers)

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['ok'], True)
        self.assertEqual(payload['truncated'], False)
        names = {item['name'] for item in payload['files']}
        self.assertIn('report.txt', names)
        self.assertIn('notes.md', names)
        self.assertNotIn('.hidden.txt', names)
        self.assertNotIn('.env', names)
        self.assertNotIn('api_token.txt', names)
        self.assertNotIn('escape.txt', names)
        self.assertNotIn(home, response.text)
        self.assertNotIn('runner_secret', response.text)
        self.assertNotIn('user_owner', response.text)
        self.assertNotIn('SIDEKICK_RUNNER_SHARED_SECRET', response.text)
        for item in payload['files']:
            self.assertRegex(item['id'], r'^file_[a-f0-9]{32}$')
            self.assertIn('downloadable', item)
            self.assertIn('modifiedAt', item)
            self.assertNotIn('path', item)

    def test_file_listing_excludes_build_artifact_noise(self):
        # A cloned repo / `pip install` dumps __pycache__ / *.pyc / *.egg-info;
        # these are excluded from the listing BEFORE the cap so the cap shows real
        # files (mirrors the mobile folderGroups.isNoiseFile so both ends agree).
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            (workspace / 'home' / 'buku' / '__pycache__').mkdir(parents=True)
            (workspace / 'home' / 'buku' / '__pycache__' / 'buku.cpython-311.pyc').write_text('x', encoding='utf-8')
            (workspace / 'home' / 'buku' / 'buku.egg-info').mkdir(parents=True)
            (workspace / 'home' / 'buku' / 'buku.egg-info' / 'PKG-INFO').write_text('meta', encoding='utf-8')
            (workspace / 'home' / 'buku' / 'main.pyc').write_text('x', encoding='utf-8')
            (workspace / 'home' / 'buku' / 'README.md').write_text('# buku', encoding='utf-8')
            (workspace / 'documents').mkdir(parents=True)
            (workspace / 'documents' / 'invoice.pdf').write_text('pdf', encoding='utf-8')
            with patch.dict(os.environ, {'DELEGENT_SKIP_WORKSPACE_SEED': '1'}, clear=False):
                files, truncated = server.list_safe_workspace_files({'HERMES_HOME': home})
            rels = {f.get('relativeName') or f['name'] for f in files}
            self.assertIn('home/buku/README.md', rels)
            self.assertIn('documents/invoice.pdf', rels)
            self.assertFalse(any('__pycache__' in r for r in rels), 'pycache must be excluded')
            self.assertFalse(any(r.endswith('.pyc') for r in rels), '.pyc must be excluded')
            self.assertFalse(any('.egg-info' in r for r in rels), 'egg-info must be excluded')
            self.assertFalse(truncated)

    def test_file_listing_prunes_noise_directories_without_descending(self):
        # 2026-07-22 live "Files didn't refresh": the old rglob walked EVERY
        # path (29,706 live, mostly node_modules) before filtering, taking
        # seconds and timing out behind the proxy whenever the agent had the
        # CPU. The walk must now prune noise/dot dirs in place — never descend
        # — so a workspace full of scaffolded projects still lists instantly.
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            deep = workspace / 'my-app' / 'node_modules' / 'left-pad' / 'nested' / 'deeper'
            deep.mkdir(parents=True)
            for i in range(50):
                (deep / f'mod{i}.js').write_text('x', encoding='utf-8')
            (workspace / 'my-app' / '.git').mkdir(parents=True)
            (workspace / 'my-app' / '.git' / 'config').write_text('x', encoding='utf-8')
            (workspace / 'my-app' / 'index.js').write_text('real', encoding='utf-8')
            (workspace / 'documents').mkdir(parents=True)
            (workspace / 'documents' / 'report.pdf').write_text('pdf', encoding='utf-8')

            real_safe = server._safe_workspace_file
            visited: list[str] = []

            def counting_safe(root, path):
                visited.append(str(path))
                return real_safe(root, path)

            with patch.dict(os.environ, {'DELEGENT_SKIP_WORKSPACE_SEED': '1'}, clear=False), \
                 patch.object(server, '_safe_workspace_file', counting_safe):
                files, truncated = server.list_safe_workspace_files({'HERMES_HOME': home})

            rels = {f.get('relativeName') or f['name'] for f in files}
            self.assertIn('my-app/index.js', rels)
            self.assertIn('documents/report.pdf', rels)
            self.assertFalse(any('node_modules' in r for r in rels))
            self.assertFalse(any('.git' in r for r in rels))
            self.assertFalse(truncated)
            # The decisive assertion: pruned trees are never even VISITED.
            self.assertFalse(any('node_modules' in v or '.git' in v for v in visited),
                             f'walk must not descend into pruned dirs; visited={len(visited)} paths')

    def test_file_listing_orders_newest_files_first_for_current_run_evidence(self):
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            old_file = workspace / 'a-old-run.txt'
            fresh_file = workspace / 'z-fresh-run.txt'
            old_file.write_text('old', encoding='utf-8')
            fresh_file.write_text('fresh', encoding='utf-8')
            os.utime(old_file, (1_770_000_000, 1_770_000_000))
            os.utime(fresh_file, (1_770_000_600, 1_770_000_600))

            files, truncated = server.list_safe_workspace_files({'HERMES_HOME': home})

        self.assertEqual(truncated, False)
        self.assertEqual([item['name'] for item in files[:2]], ['z-fresh-run.txt', 'a-old-run.txt'])
        self.assertGreater(files[0]['modifiedAt'], files[1]['modifiedAt'])

    def test_file_download_requires_signed_headers_and_returns_safe_file(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            (workspace / 'report.txt').write_text('download me', encoding='utf-8')
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                listed = client.get('/files', headers=headers).json()
                file_id = listed['files'][0]['id']
                missing = client.get(f'/files/{file_id}')
                downloaded = client.get(f'/files/{file_id}', headers=headers)
                tampered = client.get('/files/file_00000000000000000000000000000000', headers=headers)

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.content, b'download me')
        self.assertIn('private, no-store', downloaded.headers.get('cache-control', ''))
        self.assertEqual(downloaded.headers.get('x-content-type-options'), 'nosniff')
        self.assertIn('report.txt', downloaded.headers.get('content-disposition', ''))
        self.assertNotIn(home, downloaded.text)
        self.assertNotIn('runner_secret', downloaded.text)
        self.assertEqual(tampered.status_code, 404)

    def test_file_delete_and_rename_require_signed_headers_and_guard_the_workspace(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            (workspace / 'old.txt').write_text('data', encoding='utf-8')
            (workspace / 'gone.txt').write_text('bye', encoding='utf-8')
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                listed = client.get('/files', headers=headers).json()['files']
                ids = {f['name']: f['id'] for f in listed}
                old_id, gone_id = ids['old.txt'], ids['gone.txt']
                unsigned_rename = client.post(f'/files/{old_id}/rename', json={'newName': 'new.txt'})
                bad_traversal = client.post(f'/files/{old_id}/rename', json={'newName': '../escape.txt'}, headers=headers)
                bad_dotfile = client.post(f'/files/{old_id}/rename', json={'newName': '.hidden'}, headers=headers)
                bad_empty = client.post(f'/files/{old_id}/rename', json={'newName': ''}, headers=headers)
                renamed = client.post(f'/files/{old_id}/rename', json={'newName': 'new.txt'}, headers=headers)
                unsigned_del = client.delete(f'/files/{gone_id}')
                deleted = client.delete(f'/files/{gone_id}', headers=headers)
                tampered_del = client.delete('/files/file_00000000000000000000000000000000', headers=headers)
                after = client.get('/files', headers=headers).json()['files']
            names_after = {f['name'] for f in after}
        self.assertEqual(unsigned_rename.status_code, 401)
        self.assertEqual(bad_traversal.status_code, 400)
        self.assertEqual(bad_dotfile.status_code, 400)
        self.assertEqual(bad_empty.status_code, 400)
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()['file']['name'], 'new.txt')
        self.assertNotEqual(renamed.json()['file']['id'], old_id)  # id is a hash of the path -> changes on rename
        self.assertEqual(unsigned_del.status_code, 401)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(tampered_del.status_code, 404)
        self.assertIn('new.txt', names_after)
        self.assertNotIn('old.txt', names_after)
        self.assertNotIn('gone.txt', names_after)

    def test_file_delete_does_not_walk_noise_directories(self):
        # REGRESSION (2026-07-27, live "cannot delete them right now" report):
        # the listing got a pruned walk after the 2026-07-22 slow-Files incident
        # but resolve_safe_workspace_file — which delete, rename AND preview all
        # go through — kept the unpruned rglob and stat-ed every path until it
        # found a match. On a real workspace of ~30k node_modules paths that
        # took seconds, blew the Worker's 12s ceiling, and surfaced as a delete
        # that always failed on both the app and the web app. Counting the
        # safety checks makes the regression deterministic rather than a timing
        # race: the pruned walk inspects the one matching file, the old walk
        # inspected every file in node_modules first.
        client = TestClient(server.app)
        inspected: list[str] = []
        real_safe_check = server._safe_workspace_file

        def counting_safe_check(root, path):
            inspected.append(str(path))
            return real_safe_check(root, path)

        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            (workspace / 'uploads').mkdir(parents=True)
            (workspace / 'uploads' / 'report.txt').write_text('keep me', encoding='utf-8')
            noise = workspace / 'project' / 'node_modules' / 'dep'
            noise.mkdir(parents=True)
            for index in range(60):
                (noise / f'chunk{index}.js').write_text('x', encoding='utf-8')

            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
                'DELEGENT_SKIP_WORKSPACE_SEED': '1',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                listed = client.get('/files', headers=headers).json()['files']
                file_id = {f['name']: f['id'] for f in listed}['report.txt']
                with patch.object(server, '_safe_workspace_file', counting_safe_check):
                    deleted = client.delete(f'/files/{file_id}', headers=headers)
                after = {f['name'] for f in client.get('/files', headers=headers).json()['files']}
            still_on_disk = (workspace / 'uploads' / 'report.txt').exists()

        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(still_on_disk)
        self.assertNotIn('report.txt', after)
        self.assertLessEqual(
            len(inspected), 2,
            f'delete inspected {len(inspected)} files; it must prune noise dirs and match on the id first',
        )
        self.assertFalse([path for path in inspected if 'node_modules' in path])

    def test_file_upload_requires_signed_headers_and_lands_in_uploads_then_lists(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            payload = {
                'name': 'note.txt',
                'mimeType': 'text/plain',
                'contentBase64': base64.b64encode(b'hello').decode('ascii'),
            }
            with patch.dict(os.environ, env, clear=False):
                # Unsigned upload must be rejected before any write happens.
                unsigned = client.post('/files', json=payload)
                # Signed upload lands the file in workspace/uploads/.
                uploaded = client.post('/files', json=payload, headers=headers)
                # The same signed credentials can then list the new file.
                listed = client.get('/files', headers=headers)

            # Read the disk state BEFORE the TemporaryDirectory is torn down on
            # `with` exit — Path.exists()/read_bytes() are evaluated lazily.
            uploaded_path = workspace / 'uploads' / 'note.txt'
            uploaded_exists = uploaded_path.exists()
            uploaded_bytes = uploaded_path.read_bytes() if uploaded_exists else None

        self.assertEqual(unsigned.status_code, 401)
        self.assertEqual(uploaded.status_code, 200)
        body = uploaded.json()
        self.assertEqual(body['ok'], True)
        self.assertEqual(body['file']['name'], 'note.txt')
        self.assertEqual(body['file']['relativeName'], 'uploads/note.txt')
        self.assertRegex(body['file']['id'], r'^file_[a-f0-9]{32}$')
        self.assertTrue(uploaded_exists)
        self.assertEqual(uploaded_bytes, b'hello')

        self.assertEqual(listed.status_code, 200)
        listed_names = {item['relativeName'] for item in listed.json()['files']}
        self.assertIn('uploads/note.txt', listed_names)

        # The 200 response must never leak the secret, the owner user id, or
        # the absolute workspace path.
        self.assertNotIn('runner_secret', uploaded.text)
        self.assertNotIn('user_owner', uploaded.text)
        self.assertNotIn(home, uploaded.text)

    def test_file_upload_rejects_sensitive_name_and_writes_nothing(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                response = client.post(
                    '/files',
                    json={'name': '.env', 'contentBase64': base64.b64encode(b'SECRET=1').decode('ascii')},
                    headers=headers,
                )

            # Capture disk state before the TemporaryDirectory is torn down.
            uploads_dir = workspace / 'uploads'
            written_names = [p.name for p in uploads_dir.glob('*')] if uploads_dir.exists() else []
            env_file_exists = (workspace / 'uploads' / '.env').exists()

        self.assertGreaterEqual(response.status_code, 400)
        self.assertLess(response.status_code, 500)
        # No real upload should have been written (the seed README is skipped
        # in tests, and a leftover temp file would also fail this).
        self.assertEqual([n for n in written_names if not n.startswith('.upload-')], [])
        self.assertFalse(env_file_exists)

    def test_file_upload_rejects_path_traversal_and_writes_outside_workspace(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                response = client.post(
                    '/files',
                    json={'name': '../escape.txt', 'contentBase64': base64.b64encode(b'escape').decode('ascii')},
                    headers=headers,
                )

            # Capture disk state before the TemporaryDirectory is torn down.
            escaped_in_workspace = (workspace / 'escape.txt').exists()
            escaped_outside = (Path(home) / 'escape.txt').exists()
            uploads_escape = (workspace / 'uploads' / 'escape.txt').exists()

        self.assertGreaterEqual(response.status_code, 400)
        self.assertLess(response.status_code, 500)
        self.assertFalse(escaped_in_workspace)
        self.assertFalse(escaped_outside)
        self.assertFalse(uploads_escape)

    def test_file_upload_rejects_oversize_payload_with_413(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'workspace'
            workspace.mkdir()
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            oversize = base64.b64encode(b'\0' * (server.MAX_UPLOAD_BYTES + 1)).decode('ascii')
            with patch.dict(os.environ, env, clear=False):
                response = client.post(
                    '/files',
                    json={'name': 'big.bin', 'contentBase64': oversize},
                    headers=headers,
                )

            # Capture disk state before the TemporaryDirectory is torn down.
            big_exists = (workspace / 'uploads' / 'big.bin').exists()

        self.assertEqual(response.status_code, 413)
        self.assertFalse(big_exists)

    def test_get_task_requires_runner_auth_and_hides_other_users_tasks(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        owner_headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))

        # Seed a task as if it had been completed previously by user_owner so
        # we can assert the read path enforces auth + ownership without going
        # through the full subprocess flow.
        with patch.dict(server.TASKS, {}, clear=True):
            server.TASKS['task_owner'] = {
                'user_id': 'user_owner',
                'status': 'completed',
                'stdout': 'private output',
                'stderr': '',
            }
            server.TASKS['task_other'] = {
                'user_id': 'user_other',
                'status': 'completed',
                'stdout': 'someone else output',
                'stderr': '',
            }

            with patch.dict(os.environ, env, clear=False):
                missing = client.get('/tasks/task_owner')
                owner = client.get('/tasks/task_owner', headers=owner_headers)
                cross = client.get('/tasks/task_other', headers=owner_headers)
                unknown = client.get('/tasks/task_does_not_exist', headers=owner_headers)

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(owner.status_code, 200)
        self.assertEqual(owner.json()['status'], 'completed')
        self.assertEqual(owner.json()['stdout'], 'private output')
        # Owner-id is an internal binding, never echoed to clients.
        self.assertNotIn('user_id', owner.json())
        # Cross-user reads return 404, not 403, so the endpoint cannot be
        # used to discover whether a task exists for another user.
        self.assertEqual(cross.status_code, 404)
        self.assertNotIn('someone else output', cross.text)
        self.assertEqual(unknown.status_code, 404)

    def test_create_task_records_owning_user_for_later_get(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(server.TASKS, {}, clear=True):
                with patch.dict(os.environ, env, clear=False):
                    with patch('server.subprocess.run') as run:
                        run.return_value.returncode = 0
                        run.return_value.stdout = 'done'
                        run.return_value.stderr = ''
                        created = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'}, headers=headers)
                        task_id = created.json()['task_id']
                        self.assertEqual(server.TASKS[task_id]['user_id'], 'user_owner')
                        # Owner can read the task back through the authenticated endpoint.
                        fetched = client.get(f'/tasks/{task_id}', headers=headers)

            self.assertEqual(created.status_code, 200)
            self.assertNotIn('user_id', created.json())
            self.assertEqual(fetched.status_code, 200)
            self.assertEqual(fetched.json()['status'], 'completed')
            self.assertNotIn('user_id', fetched.json())

    def test_create_task_extracts_hermes_boxed_answer_as_result(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                with patch('server.subprocess.run') as run:
                    run.return_value.returncode = 0
                    run.return_value.stdout = (
                        '╭──────────── Hermes Agent v0.13.0 ─────────────╮\n'
                        '│                                       Available Tools                        │\n'
                        '│                                       file: patch, read_file, search_files   │\n'
                        '╰──────────────────────────────────────────────────────────────────────────────╯\n'
                        'Query: hello\n'
                        '╭─ ⚕ Hermes ─────────────────╮\n'
                        '     final answer ok\n'
                        '╰────────────────────────────╯\n'
                        'Resume this session with: hermes --resume abc\n'
                    )
                    run.return_value.stderr = ''
                    response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'hello'}, headers=headers)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['status'], 'completed')
            self.assertEqual(response.json()['result'], 'final answer ok')

    def test_create_task_runs_hermes_from_workspace_root(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
                'HERMES_TOOLSETS': 'file,web',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                with patch('server.subprocess.run') as run:
                    run.return_value.returncode = 0
                    run.return_value.stdout = 'done'
                    run.return_value.stderr = ''
                    response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'}, headers=headers)

            self.assertEqual(response.status_code, 200)
            run.assert_called_once()
            self.assertEqual(run.call_args.kwargs['cwd'], str(Path(home) / 'workspace'))
            # v1.2.7 — TaskIn now accepts optional history + agent_name
            # and the CLI receives a composed system-preamble + history +
            # instruction string built by build_hermes_query. Assert the
            # CLI invocation shape stays correct AND that the final query
            # contains the user's instruction.
            argv = run.call_args.args[0]
            self.assertEqual(argv[:9], [
                'hermes',
                'chat',
                '--provider',
                'custom',
                '--model',
                'openrouter/auto',
                '--toolsets',
                'file,web',
                '--query',
            ])
            self.assertIn('do thing', argv[9],
                          'composed query must end with the user instruction')
            self.assertNotIn('--quiet', argv)

    def test_build_hermes_query_includes_preamble_history_and_instruction(self):
        # v1.2.7+ — the runner now receives a composed query containing
        # a system preamble + recent conversation history + the current
        # instruction, so chat continuity works through the single-shot
        # `hermes chat` CLI. This regression test ensures the structure
        # the worker depends on stays intact.
        task = server.TaskIn(
            user_id='user_owner',
            instruction='Create a file called test.txt with content hello',
            agent_name='Harry',
            history=[
                server.ChatHistoryTurn(role='user', content='Hi Harry'),
                server.ChatHistoryTurn(role='assistant', content='Hello! What shall we work on?'),
            ],
        )
        query = server.build_hermes_query(task)
        self.assertIn('Harry', query, 'agent name surfaces in the preamble')
        self.assertIn('Hi Harry', query, 'history is included')
        self.assertIn('Hello! What shall we work on?', query)
        self.assertIn('Create a file called test.txt', query)
        # Preamble must direct the agent to use tools rather than
        # refuse — Alex hit "I can't write files" in v1.2.6 because
        # the bare-LLM path had no such instruction.
        self.assertRegex(query, r"don't refuse|file.*tool")

    def test_create_task_accepts_history_and_agent_name_from_chat_dispatch(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            with patch.dict(os.environ, env, clear=False):
                with patch('server.subprocess.run') as run:
                    run.return_value.returncode = 0
                    run.return_value.stdout = 'done'
                    run.return_value.stderr = ''
                    response = client.post(
                        '/tasks',
                        json={
                            'user_id': 'user_owner',
                            'instruction': 'Write README',
                            'agent_name': 'Harry',
                            'history': [
                                {'role': 'user', 'content': 'Hi'},
                                {'role': 'assistant', 'content': 'Hello.'},
                            ],
                        },
                        headers=headers,
                    )
            self.assertEqual(response.status_code, 200)
            argv = run.call_args.args[0]
            self.assertEqual(argv[8], '--query')
            self.assertIn('Harry', argv[9])
            self.assertIn('Hi', argv[9])
            self.assertIn('Hello.', argv[9])
            self.assertIn('Write README', argv[9])

    def test_seed_runner_workspace_creates_standard_linux_directories_idempotently(self):
        # v1.2.8 DN8 — Alex asked for the Files tab to surface the
        # standard Linux folders (home / documents / downloads / code /
        # notes). The runner seeds them on first boot via the marker
        # file. This test ensures the seed runs once + every file
        # lands in the expected place.
        try:
            os.environ.pop('DELEGENT_SKIP_WORKSPACE_SEED', None)
            with tempfile.TemporaryDirectory() as home:
                root = server.ensure_runner_workspace({'HERMES_HOME': home})
                for relative in ['home/README.md', 'documents/getting-started.md',
                                  'downloads/README.md', 'code/example.py',
                                  'notes/welcome.md']:
                    self.assertTrue(
                        (root / relative).exists(),
                        f'workspace seed must create {relative}',
                    )
                marker = root / '.delegent-workspace-seeded'
                self.assertTrue(marker.exists(), 'seed marker must be present')

                # Idempotency: re-running ensure_runner_workspace must NOT
                # overwrite user-modified files OR re-seed.
                (root / 'home' / 'README.md').write_text('user-edited', encoding='utf-8')
                server.ensure_runner_workspace({'HERMES_HOME': home})
                self.assertEqual(
                    (root / 'home' / 'README.md').read_text(encoding='utf-8'),
                    'user-edited',
                    'seed must not clobber files after the marker is set',
                )
        finally:
            # Restore the suppression so the rest of the test class
            # (which runs in the same process) stays deterministic.
            os.environ['DELEGENT_SKIP_WORKSPACE_SEED'] = '1'

    def test_runner_artifact_is_directly_executable_on_railway_template(self):
        source = Path(__file__).with_name('server.py').read_text(encoding='utf-8')
        self.assertIn("if __name__ == '__main__':", source)
        self.assertIn("uvicorn.run(app, host='0.0.0.0'", source)
        self.assertIn("os.environ.get('PORT'", source)

    def test_inject_agent_identity_keeps_caller_instructions(self):
        # D36 — when the Worker has already populated `instructions`,
        # the runner must NOT clobber it. Caller's framing wins.
        payload = {'input': 'hi', 'instructions': 'You are Nova, the user coworker.'}
        result = server.inject_agent_identity_into_runs_payload(
            dict(payload),
            {
                'HERMES_SYSTEM_PROMPT': 'fallback prompt that must not be used',
                'SIDEKICK_AGENT_NAME': 'Other',
            },
        )
        self.assertEqual(result['instructions'], 'You are Nova, the user coworker.')

    def test_inject_agent_identity_falls_back_to_env_system_prompt(self):
        # D36 — when the caller omits `instructions`, use the env-set
        # HERMES_SYSTEM_PROMPT that the provisioner bakes per user.
        payload = {'input': 'hello'}
        result = server.inject_agent_identity_into_runs_payload(
            payload,
            {
                'HERMES_SYSTEM_PROMPT': "You are Barry, the user's AI coworker.",
                'SIDEKICK_AGENT_NAME': 'Barry',
            },
        )
        self.assertIn('Barry', result['instructions'])
        self.assertNotIn('Hermes', result['instructions'])

    def test_inject_agent_identity_synthesises_prompt_when_env_missing(self):
        # D36 — if neither the caller nor the env supplied a system
        # prompt, the runner still must NOT let the upstream default
        # ("Hermes agent") win. Synthesise a minimal identity-only
        # prompt from SIDEKICK_AGENT_NAME and bake the bans into it.
        payload = {'input': 'who are you?'}
        result = server.inject_agent_identity_into_runs_payload(
            payload,
            {'SIDEKICK_AGENT_NAME': 'Pip'},
        )
        self.assertIn('Pip', result['instructions'])
        self.assertIn('Hermes', result['instructions'])
        # "never as Hermes" — must explicitly forbid the leak
        self.assertRegex(result['instructions'], r'never.*Hermes')
        # 2026-08-15: and it must forbid advertising slash commands. A brand
        # new user's SECOND message read "...`/help` shows the available
        # commands", and typing it returned the raw gateway dump headed
        # "Hermes Commands" with Telegram topic sessions in it. That defeats
        # the never-say-Hermes rule by routing round the model entirely.
        self.assertRegex(result['instructions'], r'[Nn]ever mention, advertise or suggest slash commands')
        self.assertIn('/help', result['instructions'])

    def test_inject_agent_identity_treats_empty_string_instructions_as_missing(self):
        # Defense — a Worker bug that sends `instructions: ""` must
        # still trigger the env / synthesised fallback so identity
        # framing never silently disappears.
        payload = {'input': 'hi', 'instructions': '   '}
        result = server.inject_agent_identity_into_runs_payload(
            payload,
            {'HERMES_SYSTEM_PROMPT': "You are Atlas, the user's AI coworker.", 'SIDEKICK_AGENT_NAME': 'Atlas'},
        )
        self.assertIn('Atlas', result['instructions'])


class DefectHunt20260610ContractTests(unittest.TestCase):
    """Regression tests for the 2026-06-10 defect-hunt fixes:
    fail-closed owner binding, adapter loopback gate, pre-decode upload caps,
    no-double-execute API-server fallback, subprocess concurrency cap,
    bounded task store, capture-header redaction, web-search-key redaction."""

    @classmethod
    def setUpClass(cls):
        os.environ['DELEGENT_SKIP_WORKSPACE_SEED'] = '1'

    @classmethod
    def tearDownClass(cls):
        os.environ.pop('DELEGENT_SKIP_WORKSPACE_SEED', None)

    def test_runner_auth_fails_closed_without_owner_binding(self):
        # A runner with no SIDEKICK_USER_ID must refuse to serve tasks (503)
        # rather than silently accepting any HMAC-valid user id.
        client = TestClient(server.app)
        env = {
            'DELEGENT_SKIP_WORKSPACE_SEED': '1',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = server.build_sidekick_runner_headers('user_anybody', 'runner_secret', int(time.time()))
        with patch.dict(os.environ, env, clear=True):
            with patch('server.subprocess.run') as run:
                response = client.post('/tasks', json={'user_id': 'user_anybody', 'instruction': 'do thing'}, headers=headers)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json().get('detail'), 'runner_owner_unbound')
        run.assert_not_called()

    def test_local_adapter_rejects_non_loopback_clients(self):
        from types import SimpleNamespace
        from fastapi import HTTPException as FastApiHTTPException

        with self.assertRaises(FastApiHTTPException) as ctx:
            server.require_loopback_client(SimpleNamespace(client=SimpleNamespace(host='203.0.113.9')))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, 'local_adapter_loopback_only')

        # Loopback peers (and Starlette's TestClient placeholder) pass.
        for host in ('127.0.0.1', '::1', 'testclient'):
            server.require_loopback_client(SimpleNamespace(client=SimpleNamespace(host=host)))

    def test_file_upload_rejects_oversize_payload_before_decoding(self):
        # Encoded length over the ceiling must 413 BEFORE base64 decoding:
        # the payload below is not even valid base64, so a 400 here would
        # mean the decoder ran first.
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / 'workspace').mkdir()
            env = {
                'HERMES_HOME': home,
                'SIDEKICK_USER_ID': 'user_owner',
                'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            }
            headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
            not_base64_and_oversize = '!' * (server.MAX_UPLOAD_ENCODED_CHARS + 1)
            with patch.dict(os.environ, env, clear=False):
                response = client.post(
                    '/files',
                    json={'name': 'big.bin', 'contentBase64': not_base64_and_oversize},
                    headers=headers,
                )

        self.assertEqual(response.status_code, 413)

    def test_api_server_failure_after_submit_does_not_double_execute(self):
        # Once a run is accepted by the Hermes API server, a poll failure
        # must surface as an error record — NOT fall back to the subprocess
        # path and execute the same user turn twice.
        class _StubResponse:
            def __init__(self, status_code, payload):
                self.status_code = status_code
                self._payload = payload

            def json(self):
                return self._payload

        class _StubClient:
            async def post(self, url, json=None, headers=None, timeout=None):
                return _StubResponse(200, {'run_id': 'run_1'})

            async def get(self, url, headers=None, timeout=None):
                raise RuntimeError('poll boom')

        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
        state = {'available': True, 'host': '127.0.0.1', 'port': 8643, 'bearer_key': 'test_bearer'}
        with patch.dict(os.environ, env, clear=False):
            with patch.dict(server._HERMES_API_STATE, state, clear=False):
                with patch('server._hermes_client', return_value=_StubClient()):
                    with patch('server.subprocess.run') as run:
                        response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'}, headers=headers)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body.get('status'), 'error')
        self.assertEqual(body.get('error'), 'hermes_api_run_lost')
        run.assert_not_called()

    def test_tasks_concurrency_cap_returns_429_when_saturated(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        }
        headers = server.build_sidekick_runner_headers('user_owner', 'runner_secret', int(time.time()))
        drained = 0
        while server._HERMES_TASK_SEMAPHORE.acquire(blocking=False):
            drained += 1
        try:
            with patch.dict(os.environ, env, clear=False):
                with patch.dict(server._HERMES_API_STATE, {'available': False}, clear=False):
                    with patch('server.subprocess.run') as run:
                        response = client.post('/tasks', json={'user_id': 'user_owner', 'instruction': 'do thing'}, headers=headers)
        finally:
            for _ in range(drained):
                server._HERMES_TASK_SEMAPHORE.release()

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json().get('detail'), 'runner_busy')
        run.assert_not_called()

    def test_task_store_is_bounded(self):
        snapshot = dict(server.TASKS)
        server.TASKS.clear()
        try:
            for index in range(server.TASKS_MAX_RECORDS + 25):
                server.TASKS[f'task_{index}'] = {'user_id': 'u', 'status': 'completed'}
            server._evict_old_tasks()
            self.assertLessEqual(len(server.TASKS), server.TASKS_MAX_RECORDS)
            # Newest records survive; the oldest are evicted first.
            self.assertIn(f'task_{server.TASKS_MAX_RECORDS + 24}', server.TASKS)
            self.assertNotIn('task_0', server.TASKS)
        finally:
            server.TASKS.clear()
            server.TASKS.update(snapshot)

    def test_debug_capture_redacts_credential_headers(self):
        with tempfile.TemporaryDirectory() as capture_dir:
            payload = {
                'request': {
                    'headers': [
                        ['authorization', 'Bearer super_secret_bearer'],
                        ['x-sidekick-runner-token', 'v1.deadbeef'],
                        ['content-type', 'application/json'],
                    ],
                    'body': 'hello world',
                },
            }
            with patch.dict(os.environ, {'SIDEKICK_DEBUG_CAPTURE_DIR': capture_dir}, clear=False):
                server.write_debug_capture('unit_test', payload)
            files = list(Path(capture_dir).glob('*.json'))
            self.assertEqual(len(files), 1)
            written = files[0].read_text(encoding='utf-8')

        self.assertNotIn('super_secret_bearer', written)
        self.assertNotIn('v1.deadbeef', written)
        self.assertIn('[REDACTED]', written)
        self.assertIn('hello world', written)  # bodies stay verbatim
        self.assertIn('application/json', written)  # non-credential headers stay

    def test_runner_secret_restores_from_inherited_fd(self):
        # Secret custody: entrypoint.sh strips the secret from the exec-time
        # env (visible in /proc/<pid>/environ to the same-uid agent) and
        # passes it on an inherited fd instead; the server restores it into
        # process memory exactly once.
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b'super_secret_value\n')
        os.close(write_fd)
        env = {'SIDEKICK_RUNNER_SHARED_SECRET_FD': str(read_fd)}
        restored = server._restore_runner_secret_from_fd(env)
        self.assertTrue(restored)
        self.assertEqual(env.get('SIDEKICK_RUNNER_SHARED_SECRET'), 'super_secret_value')
        self.assertNotIn('SIDEKICK_RUNNER_SHARED_SECRET_FD', env)

    def test_runner_secret_fd_restore_never_overrides_an_explicit_env_secret(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b'fd_secret')
        os.close(write_fd)
        env = {
            'SIDEKICK_RUNNER_SHARED_SECRET': 'env_secret',
            'SIDEKICK_RUNNER_SHARED_SECRET_FD': str(read_fd),
        }
        restored = server._restore_runner_secret_from_fd(env)
        os.close(read_fd)  # the helper must not have consumed it
        self.assertFalse(restored)
        self.assertEqual(env['SIDEKICK_RUNNER_SHARED_SECRET'], 'env_secret')

    def test_redaction_covers_shared_web_search_keys(self):
        env = {
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'FIRECRAWL_API_KEY': 'fc-shared-key-123',
            'TAVILY_API_KEY': 'tvly-shared-456',
        }
        text = 'env dump: FIRECRAWL_API_KEY=fc-shared-key-123 TAVILY_API_KEY=tvly-shared-456'
        redacted = server.redact_runner_secrets(text, env)
        self.assertNotIn('fc-shared-key-123', redacted)
        self.assertNotIn('tvly-shared-456', redacted)

    # credential_store uses os.fchmod, which does not exist on Windows. The
    # store only ever runs inside the Linux runner image; CI covers this.
    @unittest.skipUnless(hasattr(os, 'fchmod'), 'needs os.fchmod (POSIX); runner never runs on Windows')
    def test_redaction_covers_vault_stored_credentials(self):
        # Fable 5 pickup 7 (2026-07-29): a connect script that echoes a stored
        # credential inside an error message must not leak it through tool
        # stdout/stderr or the gateway-log tail. The vault is on-box, so the
        # redactor decrypts it and scrubs every secret string it holds.
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict(os.environ, {'HERMES_HOME': tmp, 'DELEGENT_CRED_KEY': 'unit-test-cred-key'}, clear=False):
            server._VAULT_REDACTION_CACHE.update({'sig': None, 'values': []})
            try:
                store = server._credential_store_module()
                store.put('freeagent', {
                    'access_token': 'fa-access-token-abcdef123456',
                    'nested': {'refresh_token': 'fa-refresh-9876543210'},
                    'note': 'short',  # under the 8-char floor: never worth scrubbing
                })
                sample = ('freeagent API said 401 for fa-access-token-abcdef123456 '
                          '(refresh fa-refresh-9876543210 also rejected)')
                redacted = server.redact_runner_secrets(sample)
                self.assertNotIn('fa-access-token-abcdef123456', redacted)
                self.assertNotIn('fa-refresh-9876543210', redacted)
                self.assertIn('[REDACTED]', redacted)
                self.assertIn('freeagent API said 401', redacted)

                log_line = server._redact_gateway_log('token=fa-access-token-abcdef123456 rejected')
                self.assertNotIn('fa-access-token-abcdef123456', log_line)

                # The stat-signature cache must notice a NEW credential.
                store.put('gmail', {'app_password': 'gm-app-pass-555666777'})
                self.assertNotIn(
                    'gm-app-pass-555666777',
                    server.redact_runner_secrets('smtp auth gm-app-pass-555666777 failed'),
                )
            finally:
                server._VAULT_REDACTION_CACHE.update({'sig': None, 'values': []})


def _symlinks_available() -> bool:
    """True when this process may create a symlink.

    Windows needs SeCreateSymbolicLinkPrivilege (Developer Mode or an elevated
    shell) and raises WinError 1314 without it. Probed once, in a temp dir.
    """
    try:
        probe = Path(tempfile.mkdtemp())
        (probe / 'target').mkdir()
        os.symlink(probe / 'target', probe / 'link', target_is_directory=True)
        return True
    except OSError:
        return False


_SYMLINKS_AVAILABLE = _symlinks_available()


@unittest.skipUnless(
    _SYMLINKS_AVAILABLE,
    'needs symlink privilege (WinError 1314 without Developer Mode); the runner only ever runs on Linux',
)
class HomeDirWorkspaceLinkTests(unittest.TestCase):
    """Regression guard for the 2026-06-11 lost-files defect: the agent saved a
    user's hello-world app under ~/Documents (EPHEMERAL container disk); the
    machine auto-stopped minutes later and the files were destroyed, while the
    app's Files tab (which reads the workspace volume) never showed them.
    link_home_dirs_into_workspace maps the home-dir folder names an agent
    reaches for onto workspace folders and rescues stray real directories."""

    def _dirs(self):
        tmp = Path(tempfile.mkdtemp())
        home = tmp / 'home'
        workspace = tmp / 'workspace'
        home.mkdir()
        workspace.mkdir()
        return home, workspace

    def test_links_created_and_home_write_lands_in_workspace(self):
        home, workspace = self._dirs()
        server.link_home_dirs_into_workspace(workspace, home)
        # ~/Documents is now a symlink onto workspace/documents
        self.assertTrue((home / 'Documents').is_symlink())
        self.assertEqual((home / 'Documents').resolve(), (workspace / 'documents').resolve())
        # the exact failure shape from the live defect: a write through
        # ~/Documents must land on the (durable, app-visible) workspace.
        (home / 'Documents' / 'hello-world').mkdir()
        (home / 'Documents' / 'hello-world' / 'hello_world.py').write_text("print('hi')\n", encoding='utf-8')
        self.assertTrue((workspace / 'documents' / 'hello-world' / 'hello_world.py').is_file())

    def test_rescues_contents_of_a_pre_existing_real_directory(self):
        home, workspace = self._dirs()
        # a stray REAL ~/Documents from before the links existed (the lost-files
        # scenario): its contents must be MOVED into the workspace, not lost.
        stray = home / 'Documents' / 'hello-world'
        stray.mkdir(parents=True)
        (stray / 'README.md').write_text('# hi\n', encoding='utf-8')
        server.link_home_dirs_into_workspace(workspace, home)
        self.assertTrue((workspace / 'documents' / 'hello-world' / 'README.md').is_file())
        self.assertTrue((home / 'Documents').is_symlink())

    def test_idempotent_and_never_overwrites_on_collision(self):
        home, workspace = self._dirs()
        server.link_home_dirs_into_workspace(workspace, home)
        server.link_home_dirs_into_workspace(workspace, home)  # second run: no-op
        self.assertTrue((home / 'Documents').is_symlink())
        # collision: a real dir whose child name already exists in the target
        # keeps the real dir (no silent overwrite, no data loss either side).
        home2, workspace2 = self._dirs()
        (workspace2 / 'documents').mkdir()
        (workspace2 / 'documents' / 'clash.txt').write_text('workspace copy', encoding='utf-8')
        real = home2 / 'Documents'
        real.mkdir()
        (real / 'clash.txt').write_text('home copy', encoding='utf-8')
        server.link_home_dirs_into_workspace(workspace2, home2)
        self.assertEqual((workspace2 / 'documents' / 'clash.txt').read_text(encoding='utf-8'), 'workspace copy')
        self.assertTrue((home2 / 'Documents' / 'clash.txt').exists(), 'colliding home copy must be preserved')

    def test_rescue_stray_volume_root_dirs_merges_legacy_layout(self):
        # Pre-Route-B the volume mounted at .../workspace, so after the remount
        # the OLD user dirs sit at the HERMES_HOME root, invisible to the app.
        # (Made worse by a migration `mv -n` that silently skipped seeded names.)
        tmp = Path(tempfile.mkdtemp())
        hermes_home = tmp / 'hermes'
        workspace = hermes_home / 'workspace'
        workspace.mkdir(parents=True)
        (hermes_home / 'documents').mkdir()
        (hermes_home / 'documents' / 'old-report.md').write_text('legacy', encoding='utf-8')
        (workspace / 'documents').mkdir()
        (workspace / 'documents' / 'getting-started.md').write_text('seed', encoding='utf-8')
        # Hermes' own state at the root must be untouched; 'home' is excluded.
        (hermes_home / 'state.db').write_text('db', encoding='utf-8')
        (hermes_home / 'home').mkdir()
        (hermes_home / 'home' / '.bashrc').write_text('rc', encoding='utf-8')
        server.rescue_stray_volume_root_dirs(workspace, hermes_home)
        self.assertTrue((workspace / 'documents' / 'old-report.md').is_file(), 'legacy file must surface in the workspace')
        self.assertTrue((workspace / 'documents' / 'getting-started.md').is_file(), 'seed must survive the merge')
        self.assertFalse((hermes_home / 'documents').exists(), 'emptied stray dir is removed')
        self.assertTrue((hermes_home / 'state.db').is_file())
        self.assertTrue((hermes_home / 'home' / '.bashrc').is_file(), "'home' (Hermes tool-HOME) must NOT be rescued away")

    def test_agent_tool_home_gets_links_too(self):
        # Hermes injects HOME=$HERMES_HOME/home into agent tool subprocesses
        # whenever that dir exists, so ~/Documents for the AGENT resolves there,
        # not at /home/delegent. The boot hook must create it and install the
        # same workspace links (the second half of the lost-files defect).
        tmp = Path(tempfile.mkdtemp())
        runner_home = tmp / 'rhome'
        runner_home.mkdir()
        hermes_home = tmp / 'hermes'
        workspace = hermes_home / 'workspace'
        workspace.mkdir(parents=True)
        # the lost hello-world scenario: files already sitting in the agent home
        stranded = hermes_home / 'home' / 'Documents' / 'hello-world'
        stranded.mkdir(parents=True)
        (stranded / 'hello_world.py').write_text("print('hi')\n", encoding='utf-8')
        with patch.object(server, '_RUNNER_HOME_DIR', runner_home), \
             patch.object(server.Path, 'home', return_value=runner_home), \
             patch.dict(os.environ, {'HERMES_HOME': str(hermes_home)}):
            server._maybe_link_home_dirs(workspace)
        tool_home = hermes_home / 'home'
        self.assertTrue((tool_home / 'Documents').is_symlink(), 'agent tool-home must get the workspace links')
        self.assertEqual((tool_home / 'Documents').resolve(), (workspace / 'documents').resolve())
        # the stranded files were rescued onto the app-visible workspace
        self.assertTrue((workspace / 'documents' / 'hello-world' / 'hello_world.py').is_file())
        # and a fresh agent write through ~/Documents lands in the workspace
        (tool_home / 'Documents' / 'new.txt').write_text('x', encoding='utf-8')
        self.assertTrue((workspace / 'documents' / 'new.txt').is_file())

    def test_guard_only_links_on_the_runner_home(self):
        home, workspace = self._dirs()
        # _maybe_link_home_dirs must be inert on a dev machine (Path.home() is
        # not the runner's baked-in /home/delegent), so local runs/tests never
        # touch a developer's real home directory.
        with patch.object(server.Path, 'home', return_value=home):
            server._maybe_link_home_dirs(workspace)
        self.assertFalse((home / 'Documents').exists())
        # and the explicit kill-switch wins even on the runner home
        with patch.object(server, '_RUNNER_HOME_DIR', home), \
             patch.object(server.Path, 'home', return_value=home), \
             patch.dict(os.environ, {'DELEGENT_SKIP_HOME_LINKS': '1'}):
            server._maybe_link_home_dirs(workspace)
        self.assertFalse((home / 'Documents').exists())
        # with the guard satisfied, links appear (HERMES_HOME pinned to tmp so
        # the agent-tool-home branch never touches a real /data/hermes)
        with patch.object(server, '_RUNNER_HOME_DIR', home), \
             patch.object(server.Path, 'home', return_value=home), \
             patch.dict(os.environ, {'HERMES_HOME': str(workspace.parent / 'hermes-home')}):
            server._maybe_link_home_dirs(workspace)
        self.assertTrue((home / 'Documents').is_symlink())


class DelegentCredentialEndpointTests(unittest.TestCase):
    """The app-facing route into the encrypted vault.

    These exist so a user never has to paste an API key into the chat, so the
    load-bearing assertions are: HMAC required, the secret is stored in a form
    the skills can read, and a stored secret can NEVER be read back out.
    """

    def _env(self, home):
        return {
            'SIDEKICK_USER_ID': 'user_owner',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
            'HERMES_HOME': str(home),
            'DELEGENT_CRED_KEY': 'test-vault-key',
        }

    def _headers(self):
        return server.build_sidekick_runner_headers(
            user_id='user_owner',
            shared_secret='runner_secret',
            now=int(time.time()),
        )

    def test_credential_routes_require_runner_hmac(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, self._env(Path(tmp)), clear=False):
                self.assertEqual(client.get('/v1/delegent/credentials').status_code, 401)
                self.assertEqual(
                    client.put('/v1/delegent/credentials/todoist', json={'secret': {'api_token': 'x'}}).status_code,
                    401,
                )
                self.assertEqual(client.delete('/v1/delegent/credentials/todoist').status_code, 401)

    # The store replaces a credential file while a handle is open, which
    # Windows forbids (WinError 32). POSIX-only by mechanism; CI covers it.
    @unittest.skipUnless(os.name != 'nt', 'Windows cannot unlink an open file; runner never runs on Windows')
    def test_put_stores_an_encrypted_secret_the_skills_can_read(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with patch.dict(os.environ, self._env(home), clear=False):
                stored = client.put(
                    '/v1/delegent/credentials/todoist',
                    json={'secret': {'api_token': 'SUPER_SECRET_TOKEN'}, 'scopes': ['read'], 'meta': {'account': 'acme'}},
                    headers=self._headers(),
                )
                self.assertEqual(stored.status_code, 200)
                self.assertEqual(stored.json()['service'], 'todoist')
                # The confirmation must not echo the secret back.
                self.assertNotIn('SUPER_SECRET_TOKEN', stored.text)

                # On-disk file is ciphertext, not the plaintext token.
                cred_file = home / 'credentials' / 'todoist.cred'
                self.assertTrue(cred_file.exists())
                self.assertNotIn(b'SUPER_SECRET_TOKEN', cred_file.read_bytes())

                # The skills read through the same vault, so the exact secret
                # shape must survive the round trip.
                store = server._credential_store_module()
                self.assertEqual(store.secret('todoist'), {'api_token': 'SUPER_SECRET_TOKEN'})

                listed = client.get('/v1/delegent/credentials', headers=self._headers())
                self.assertEqual(listed.status_code, 200)
                connections = listed.json()['connections']
                self.assertEqual([c['service'] for c in connections], ['todoist'])
                self.assertEqual(connections[0]['scopes'], ['read'])
                # The listing is the ONLY read path, and it must be secret-free.
                self.assertNotIn('SUPER_SECRET_TOKEN', listed.text)

                removed = client.delete('/v1/delegent/credentials/todoist', headers=self._headers())
                self.assertEqual(removed.status_code, 200)
                self.assertTrue(removed.json()['removed'])
                self.assertFalse(cred_file.exists())

    def test_put_rejects_bad_service_names_and_empty_secrets(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, self._env(Path(tmp)), clear=False):
                headers = self._headers()
                # Path traversal must never reach the vault's filename. The
                # router rejects an encoded separator outright (404); a name
                # that does reach the handler but is not filename-safe is a 400.
                # Either way the only thing that matters is that it is refused.
                self.assertNotEqual(
                    client.put('/v1/delegent/credentials/..%2Fescape', json={'secret': {'k': 'v'}}, headers=headers).status_code,
                    200,
                )
                self.assertEqual(
                    client.put('/v1/delegent/credentials/my.service', json={'secret': {'k': 'v'}}, headers=headers).status_code,
                    400,
                )
                self.assertEqual(
                    client.put('/v1/delegent/credentials/todoist', json={'secret': {}}, headers=headers).status_code,
                    400,
                )
                self.assertEqual(
                    client.put('/v1/delegent/credentials/todoist', json={'secret': {'api_token': '  '}}, headers=headers).status_code,
                    400,
                )

    def test_delegent_platform_defaults_on_when_the_machine_env_lacks_the_flag(self):
        # A machine provisioned without DELEGENT_PLATFORM_ENABLED used to skip
        # the relay URL, the user allowlist and the home channel, while the
        # baked-in adapter self-registered anyway as relay=log-only. Result: the
        # first message hit the gateway pairing gate and the reply went to an
        # on-box log, so the chat bubble never filled in. Unset must mean ON.
        self.assertTrue(server._delegent_platform_is_enabled({}))
        for raw in ('true', 'TRUE', '1', 'yes', 'on', ' true '):
            self.assertTrue(server._delegent_platform_is_enabled({'DELEGENT_PLATFORM_ENABLED': raw}), raw)
        for raw in ('false', '0', 'no', 'off'):
            self.assertFalse(server._delegent_platform_is_enabled({'DELEGENT_PLATFORM_ENABLED': raw}), raw)

    def test_preparing_the_gateway_env_derives_relay_allowlist_and_home_channel(self):
        subprocess_env: dict[str, str] = {}
        base = {'SIDEKICK_USER_ID': 'user-abc', 'PORT': '8080', 'HERMES_HOME': '/data/hermes'}
        with patch.dict(os.environ, base, clear=True):
            self.assertTrue(server._prepare_delegent_gateway_env(subprocess_env))
            self.assertEqual(
                subprocess_env['DELEGENT_RELAY_URL'],
                'http://127.0.0.1:8080/v1/delegent/ingest',
            )
            self.assertEqual(subprocess_env['DELEGENT_ALLOWED_USERS'], 'user-abc')
            self.assertEqual(subprocess_env['DELEGENT_HOME_CHANNEL'], 'user-abc')
            self.assertEqual(subprocess_env['DELEGENT_PLATFORM_ENABLED'], 'true')
            self.assertTrue(subprocess_env['DELEGENT_PLATFORM_SECRET'])

    def test_the_platform_flag_remains_an_explicit_kill_switch(self):
        subprocess_env: dict[str, str] = {}
        with patch.dict(os.environ, {'DELEGENT_PLATFORM_ENABLED': 'false', 'SIDEKICK_USER_ID': 'u'}, clear=True):
            self.assertFalse(server._prepare_delegent_gateway_env(subprocess_env))
        self.assertEqual(subprocess_env, {})

    def test_a_credential_belonging_to_another_user_is_refused(self):
        client = TestClient(server.app)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, self._env(Path(tmp)), clear=False):
                intruder = server.build_sidekick_runner_headers(
                    user_id='someone_else',
                    shared_secret='runner_secret',
                    now=int(time.time()),
                )
                self.assertEqual(client.get('/v1/delegent/credentials', headers=intruder).status_code, 403)


class BrokeredConnectionTests(unittest.TestCase):
    """The OAuth grant is held off this box on purpose. What lives here is a
    borrowing window: loopback only, adapter-key only, short-lived token."""

    ENV = {
        'DELEGENT_SKIP_WORKSPACE_SEED': '1',
        'SIDEKICK_USER_ID': 'user_owner',
        'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret',
        'SIDEKICK_WORKER_PROXY_URL': 'https://sidekick-worker-production.alex-coworker-ai.workers.dev/v1/chat/completions',
    }

    def test_worker_api_url_is_derived_from_the_proxy_url(self):
        for configured in (
            'https://sidekick-worker-production.alex-coworker-ai.workers.dev',
            'https://sidekick-worker-production.alex-coworker-ai.workers.dev/v1',
            'https://sidekick-worker-production.alex-coworker-ai.workers.dev/v1/chat/completions',
        ):
            env = {**self.ENV, 'SIDEKICK_WORKER_PROXY_URL': configured}
            self.assertEqual(
                server.worker_api_url('/api/runner/connections', env),
                'https://sidekick-worker-production.alex-coworker-ai.workers.dev/api/runner/connections',
            )

    def test_worker_api_url_refuses_a_host_outside_the_allowlist(self):
        env = {**self.ENV, 'SIDEKICK_WORKER_PROXY_URL': 'https://tokens.example.com/v1'}
        with self.assertRaises(server.HTTPException):
            server.worker_api_url('/api/runner/connections', env)

    def test_connection_routes_refuse_a_remote_peer(self):
        from types import SimpleNamespace

        with self.assertRaises(server.HTTPException) as ctx:
            server.require_loopback_client(SimpleNamespace(client=SimpleNamespace(host='203.0.113.9')))
        self.assertEqual(ctx.exception.detail, 'local_adapter_loopback_only')

    def test_connection_routes_refuse_a_caller_without_the_adapter_key(self):
        client = TestClient(server.app)
        with patch.dict(os.environ, self.ENV, clear=True):
            self.assertEqual(client.get('/v1/delegent/connections').status_code, 401)
            self.assertEqual(
                client.post('/v1/delegent/connections/token', json={'provider': 'dropbox'},
                            headers={'authorization': 'Bearer wrong'}).status_code,
                401,
            )

    def test_the_agent_can_list_and_borrow_with_the_adapter_key(self):
        client = TestClient(server.app)
        key = server.derive_local_adapter_api_key('runner_secret')
        captured: dict[str, object] = {}

        class _Response:
            status_code = 200

            def __init__(self, payload):
                self._payload = payload

            def json(self):
                return self._payload

        class _Client:
            def __init__(self, *a, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, url, headers=None):
                captured['url'] = url
                captured['headers'] = headers
                return _Response({'connections': [{'provider': 'dropbox', 'status': 'connected'}]})

            async def post(self, url, headers=None, content=None):
                captured['url'] = url
                captured['headers'] = headers
                return _Response({'accessToken': 'sl.short-lived', 'expiresAt': None, 'scopes': []})

        with patch.dict(os.environ, self.ENV, clear=True):
            with patch('server.httpx.AsyncClient', _Client):
                listed = client.get('/v1/delegent/connections', headers={'authorization': f'Bearer {key}'})
                self.assertEqual(listed.status_code, 200)
                self.assertEqual(listed.json()['connections'][0]['provider'], 'dropbox')
                self.assertEqual(captured['url'], 'https://sidekick-worker-production.alex-coworker-ai.workers.dev/api/runner/connections')
                # The box proves who it is with the runner HMAC, not a user token.
                self.assertTrue(str(captured['headers']['x-sidekick-runner-token']).startswith('v1.'))

                token = client.post('/v1/delegent/connections/token', json={'provider': 'dropbox'},
                                    headers={'authorization': f'Bearer {key}'})
                self.assertEqual(token.status_code, 200)
                self.assertEqual(token.json()['accessToken'], 'sl.short-lived')

    def test_a_composio_action_is_forwarded_with_the_runner_identity(self):
        """The door that did not exist until 2026-09-01.

        A Composio connection has no borrowable token: Composio holds the grant
        and runs the action. Without this endpoint the agent had a connected
        Gmail it could not touch, so it reported the service as not connected.
        """
        client = TestClient(server.app)
        key = server.derive_local_adapter_api_key('runner_secret')
        captured = {}

        class _Response:
            status_code = 200

            def json(self):
                return {'result': {'messages': [{'subject': 'hello'}]}}

        class _Client:
            def __init__(self, *a, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers=None, content=None):
                captured['url'] = url
                captured['headers'] = headers
                captured['body'] = json.loads(content)
                return _Response()

        with patch.dict(os.environ, self.ENV, clear=True):
            with patch('server.httpx.AsyncClient', _Client):
                response = client.post(
                    '/v1/delegent/connections/composio/execute',
                    json={'tool': 'GMAIL_FETCH_EMAILS', 'arguments': {'max_results': 2}},
                    headers={'authorization': f'Bearer {key}'},
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['result']['messages'][0]['subject'], 'hello')
        self.assertTrue(captured['url'].endswith('/api/runner/connections/composio/execute'))
        self.assertEqual(captured['body'], {'tool': 'GMAIL_FETCH_EMAILS', 'arguments': {'max_results': 2}})
        # Same identity as every other runner call: the HMAC, never a user token.
        self.assertTrue(str(captured['headers']['x-sidekick-runner-token']).startswith('v1.'))

    def test_a_composio_action_without_a_tool_is_rejected(self):
        client = TestClient(server.app)
        key = server.derive_local_adapter_api_key('runner_secret')
        with patch.dict(os.environ, self.ENV, clear=True):
            for payload, detail in (
                ({}, 'tool_required'),
                ({'tool': '   '}, 'tool_required'),
                ({'tool': 'GMAIL_FETCH_EMAILS', 'arguments': []}, 'invalid_arguments'),
            ):
                response = client.post('/v1/delegent/connections/composio/execute', json=payload,
                                       headers={'authorization': f'Bearer {key}'})
                self.assertEqual(response.status_code, 400, payload)
                self.assertEqual(response.json().get('detail'), detail, payload)

    def test_a_token_request_without_a_provider_is_rejected(self):
        client = TestClient(server.app)
        key = server.derive_local_adapter_api_key('runner_secret')
        with patch.dict(os.environ, self.ENV, clear=True):
            response = client.post('/v1/delegent/connections/token', json={},
                                   headers={'authorization': f'Bearer {key}'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json().get('detail'), 'provider_required')


class DelegentSkillsSelfHealTests(unittest.TestCase):
    """Regression cover for the 2026-07-22/24 incident: a long-running box lost
    34 of 35 curated skills mid-session and the agent answered "skill not
    found" for connect-telegram / agent-email-inbox / report-writer, three
    separate times, in the owner's own chat. The fix is two-layered
    (_seed_delegent_skills at gateway launch, _ensure_delegent_skills_present
    before every turn) and had NO tests until 2026-08-03. These are pure file
    operations, so they run on Windows and Linux alike.
    """

    def _library(self, root: Path) -> Path:
        """Build a minimal /opt/delegent-shaped library: skills/ + _shared/."""
        lib = root / 'lib'
        for slug in server._DELEGENT_SKILL_SENTINELS:
            skill = lib / 'skills' / slug
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text(f'# {slug}\n', encoding='utf-8')
        (lib / '_shared').mkdir()
        (lib / '_shared' / 'credential_store.py').write_text('# shared\n', encoding='utf-8')
        return lib

    def test_seed_mirrors_the_library_and_its_shared_modules(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = self._library(root)
            home = root / 'home'
            with patch.dict(os.environ, {'DELEGENT_SKILLS_DIR': str(lib)}):
                server._seed_delegent_skills(home)
            for slug in server._DELEGENT_SKILL_SENTINELS:
                self.assertTrue((home / 'skills' / 'delegent' / slug / 'SKILL.md').is_file(),
                                f'{slug} not seeded')
            # The connect scripts resolve shared modules at <skills_root>/_shared;
            # without this mirror they import-fail from the seeded copy.
            self.assertTrue((home / 'skills' / '_shared' / 'credential_store.py').is_file())

    def test_seed_refreshes_wholesale_so_a_stale_copy_cannot_linger(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = self._library(root)
            home = root / 'home'
            stale = home / 'skills' / 'delegent' / 'removed-skill'
            stale.mkdir(parents=True)
            (stale / 'SKILL.md').write_text('# stale\n', encoding='utf-8')
            with patch.dict(os.environ, {'DELEGENT_SKILLS_DIR': str(lib)}):
                server._seed_delegent_skills(home)
            self.assertFalse(stale.exists(),
                             'a skill removed from the library must not survive a re-seed')

    def test_ensure_reseeds_when_a_sentinel_skill_has_been_pruned(self):
        # The exact live failure: Hermes' launch-time curation pruned the
        # library down to a subset, so sentinel skills vanished while the
        # gateway kept running.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = self._library(root)
            home = root / 'home'
            with patch.dict(os.environ, {'DELEGENT_SKILLS_DIR': str(lib)}):
                server._seed_delegent_skills(home)
                lost = home / 'skills' / 'delegent' / server._DELEGENT_SKILL_SENTINELS[0]
                import shutil as _shutil
                _shutil.rmtree(lost)
                self.assertFalse(lost.exists())
                server._ensure_delegent_skills_present(home)
            self.assertTrue((lost / 'SKILL.md').is_file(),
                            'a pruned sentinel skill must be re-seeded before the turn runs')

    def test_stock_skills_that_compete_with_a_connection_are_retired(self):
        """2026-09-02. The stock google-workspace skill walks the user through
        creating their own Google Cloud OAuth client for five services the
        Connections screen now connects with one tap (live incident
        2026-07-25). Claiming the phrasings in our manifest is not enough while
        the skill is still on disk, so it is removed at launch AND before every
        turn, because Hermes re-seeds its bundled skills on its own launches.
        """
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = self._library(root)
            home = root / 'home'
            stock = home / 'skills' / 'productivity' / 'google-workspace'
            stock.mkdir(parents=True)
            (stock / 'SKILL.md').write_text('# stock\n', encoding='utf-8')
            with patch.dict(os.environ, {'DELEGENT_SKILLS_DIR': str(lib)}):
                server._seed_delegent_skills(home)
                self.assertFalse(stock.exists(), 'a retired stock skill must not survive a launch')
                # Hermes puts it back mid-session: the per-turn path must remove
                # it again even though the curated library is intact and the
                # cheap early-return would otherwise skip everything.
                stock.mkdir(parents=True)
                (stock / 'SKILL.md').write_text('# stock again\n', encoding='utf-8')
                server._ensure_delegent_skills_present(home)
                self.assertFalse(stock.exists(), 'a re-seeded stock skill must not get a single turn')
            # And the curated library is untouched by the retirement.
            for slug in server._DELEGENT_SKILL_SENTINELS:
                self.assertTrue((home / 'skills' / 'delegent' / slug / 'SKILL.md').is_file())

    def test_ensure_is_a_noop_when_the_library_is_intact(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = self._library(root)
            home = root / 'home'
            with patch.dict(os.environ, {'DELEGENT_SKILLS_DIR': str(lib)}):
                server._seed_delegent_skills(home)
                marker = home / 'skills' / 'delegent' / server._DELEGENT_SKILL_SENTINELS[0] / 'SKILL.md'
                before = marker.stat().st_mtime_ns
                server._ensure_delegent_skills_present(home)
                self.assertEqual(marker.stat().st_mtime_ns, before,
                                 'intact library must not be rewritten on every turn (cheap-path contract)')

    def test_message_dispatch_self_heals_before_the_turn(self):
        # Source pin, same style as the drawer readiness tests: the per-turn
        # dispatch endpoint must call the self-heal BEFORE dispatching. If a
        # refactor drops the call, the 2026-07-22 incident returns silently.
        source = Path(server.__file__).read_text(encoding='utf-8')
        dispatch = source.split("@app.post('/v1/delegent/message')", 1)
        self.assertEqual(len(dispatch), 2, 'delegent message endpoint not found in server.py')
        self.assertIn('_ensure_delegent_skills_present', dispatch[1].split('@app.', 1)[0],
                      'the per-turn self-heal call has been removed from the message dispatch path')


if __name__ == '__main__':
    unittest.main()
