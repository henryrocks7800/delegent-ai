# Series 4 — golden Hermes runner image contract tests.
#
# These run without Docker and prove the image-level contract that the
# server.py wrapper enforces:
#  1. /healthz exposes hermesAvailable, workspaceReady, hermesVersion, and
#     hermesCommitShort fields with the right types.
#  2. The Hermes image provenance manifest at /etc/delegent/hermes-image.json
#     is read and surfaced safely (never the install_at timestamp or full
#     commit SHA; never the install script path; never the repo URL).
#  3. /healthz still works when the manifest is missing (dev / non-Fly boot).
#  4. Forbidden secret env names are never in the response.
#
# Run via the existing services/hermes-runner test harness:
#   scripts/test-hermes-runner.sh
# or directly:
#   python3 -m pytest services/hermes-runner/test_golden_image_contract.py
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


FORBIDDEN_SECRET_NAMES = (
    'FLY_API_TOKEN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'OPENROUTER_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RAILWAY_API_TOKEN',
    'SIDEKICK_TELEGRAM_BOT_TOKEN',
)
FORBIDDEN_PRIVATE_FIELDS = (
    'installedBy',
    'installedAt',
    'hermesRepo',
    'extras',
    'hermesCommit',  # full commit; only hermesCommitShort is safe to surface
)


class HealthzContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(server.app)

    def _read_with_manifest(self, manifest: dict) -> dict:
        # Stub the manifest reader rather than writing /etc/delegent, which
        # may not be writable on test runners.
        with patch.object(server, '_safe_hermes_image_summary', return_value={
            'version': manifest.get('hermesVersion'),
            'commitShort': (manifest.get('hermesCommit') or '')[:12] or None,
        }):
            response = self.client.get('/healthz')
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_healthz_surfaces_series4_fields_with_correct_types(self):
        body = self._read_with_manifest({
            'hermesVersion': 'v2026.5.7',
            'hermesCommit': '0123456789abcdef0123456789abcdef01234567',
        })
        self.assertEqual(body['ok'], True)
        self.assertEqual(body['runner'], 'delegent-hermes-runner')
        self.assertIn('hermesAvailable', body)
        self.assertIsInstance(body['hermesAvailable'], bool)
        self.assertIn('workspaceReady', body)
        self.assertIsInstance(body['workspaceReady'], bool)
        self.assertEqual(body['hermesVersion'], 'v2026.5.7')
        # Short commit only — never the full SHA.
        self.assertEqual(body['hermesCommitShort'], '0123456789ab')
        self.assertEqual(len(body['hermesCommitShort']), 12)

    def test_healthz_redacts_private_manifest_fields(self):
        # Even if a future change to install-hermes.sh writes more verbose
        # provenance, /healthz must not surface it.
        body = self._read_with_manifest({
            'hermesVersion': 'v2026.5.7',
            'hermesCommit': 'abcabcabcabcabcabcabcabcabcabcabcabcabca',
            'hermesRepo': 'https://github.com/NousResearch/hermes-agent.git',
            'extras': 'all',
            'installedBy': 'services/hermes-runner/scripts/install-hermes.sh',
            'installedAt': '2026-05-15T18:00:00Z',
        })
        for forbidden in FORBIDDEN_PRIVATE_FIELDS:
            self.assertNotIn(forbidden, body, f'{forbidden} leaked into /healthz')

    def test_healthz_tolerates_missing_manifest(self):
        # Dev boots / non-Fly hosts have no /etc/delegent/hermes-image.json.
        # /healthz must still return 200 and signal that version info is
        # unknown without crashing.
        with patch.object(server, '_safe_hermes_image_summary', return_value={
            'version': None,
            'commitShort': None,
        }):
            response = self.client.get('/healthz')
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body['ok'], True)
        self.assertIsNone(body['hermesVersion'])
        self.assertIsNone(body['hermesCommitShort'])

    def test_healthz_does_not_leak_secret_env_names(self):
        # The response body should never echo back any of the secret env
        # variable names — that includes the *names*, not just values, so
        # even an accidental "debug: dump env" change would fail this.
        with patch.dict(os.environ, {name: 'live-value' for name in FORBIDDEN_SECRET_NAMES}, clear=False):
            response = self.client.get('/healthz')
        text = response.text
        for forbidden in FORBIDDEN_SECRET_NAMES:
            self.assertNotIn(forbidden, text, f'{forbidden} leaked into /healthz response')
        self.assertNotIn('live-value', text)


class HealthFullContractTests(unittest.TestCase):
    # /health requires HMAC; verify it carries the same Series 4 fields and
    # the same redaction guarantees as /healthz.
    def test_signed_health_surfaces_series4_fields(self):
        client = TestClient(server.app)
        env = {
            'SIDEKICK_USER_ID': 'user_a',
            'SIDEKICK_RUNNER_SHARED_SECRET': 'runner_secret_test_value_32chars',
        }
        import time as _time
        headers = server.build_sidekick_runner_headers(
            user_id='user_a',
            shared_secret=env['SIDEKICK_RUNNER_SHARED_SECRET'],
            now=int(_time.time()),
        )
        with patch.dict(os.environ, env, clear=False), patch.object(
            server, '_safe_hermes_image_summary',
            return_value={'version': 'v2026.5.7', 'commitShort': 'abc123def456'},
        ):
            response = client.get('/health', headers=headers)
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body['hermesVersion'], 'v2026.5.7')
        self.assertEqual(body['hermesCommitShort'], 'abc123def456')
        self.assertIsInstance(body['hermesAvailable'], bool)
        self.assertIsInstance(body['workspaceReady'], bool)


class ManifestReaderTests(unittest.TestCase):
    # _safe_hermes_image_summary is what /healthz and /health call. Exercise
    # its parsing directly so /healthz tests above can mock it confidently.
    def test_reader_returns_nones_when_manifest_missing(self):
        with patch.object(server, 'HERMES_IMAGE_MANIFEST_PATH', '/nonexistent/delegent/missing.json'):
            summary = server._safe_hermes_image_summary()
        self.assertEqual(summary, {'version': None, 'commitShort': None})

    def test_reader_returns_nones_when_manifest_is_garbage(self, tmp_path=None):
        # Write an invalid JSON file and prove the reader doesn't throw.
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
            fh.write('this is not json {{{')
            fh.flush()
            tmp_path = Path(fh.name)
        try:
            with patch.object(server, 'HERMES_IMAGE_MANIFEST_PATH', str(tmp_path)):
                summary = server._safe_hermes_image_summary()
            self.assertEqual(summary, {'version': None, 'commitShort': None})
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_reader_truncates_long_commit_to_12_chars(self):
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
            json.dump({
                'hermesVersion': 'v2026.5.7',
                'hermesCommit': 'a' * 40,
            }, fh)
            fh.flush()
            tmp_path = Path(fh.name)
        try:
            with patch.object(server, 'HERMES_IMAGE_MANIFEST_PATH', str(tmp_path)):
                summary = server._safe_hermes_image_summary()
            self.assertEqual(summary['version'], 'v2026.5.7')
            self.assertEqual(summary['commitShort'], 'a' * 12)
        finally:
            tmp_path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
