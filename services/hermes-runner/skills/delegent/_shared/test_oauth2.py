"""Contract tests for the shared OAuth2 wizard base (HTTP mocked)."""
import importlib.util
import os
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load():
    spec = importlib.util.spec_from_file_location("oauth2", HERE / "oauth2.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class OAuth2Tests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "oauth-test-secret-value-32bytes-plus"
        self.o = _load()
        self.cfg = self.o.OAuth2Config(
            service="freeagent",
            auth_endpoint="https://api.freeagent.com/v2/approve_app",
            token_endpoint="https://api.freeagent.com/v2/token_endpoint",
            client_id="cid", client_secret="csec",
            redirect_uri="https://delegentai.co.uk/oauth/callback",
            scopes=["read", "write"])

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    def test_authorization_url(self):
        url = self.o.authorization_url(self.cfg, state="abc")
        self.assertIn("response_type=code", url)
        self.assertIn("client_id=cid", url)
        self.assertIn("redirect_uri=https%3A%2F%2Fdelegentai.co.uk", url)
        self.assertIn("scope=read+write", url)
        self.assertIn("state=abc", url)
        self.assertNotIn("csec", url)  # client secret never in the auth URL

    def test_exchange_stores_encrypted_and_returns_no_secret(self):
        calls = {}
        def fake_http(method, url, headers=None, data=None, timeout=30):
            calls["data"] = data
            return 200, {"access_token": "AT_SECRET", "refresh_token": "RT_SECRET", "expires_in": 3600}
        self.o.http_json = fake_http
        summary = self.o.exchange_code(self.cfg, "the_code")
        # Returned summary carries no secret.
        import json
        self.assertNotIn("AT_SECRET", json.dumps(summary))
        self.assertTrue(summary["has_refresh"])
        self.assertEqual(summary["scopes"], ["read", "write"])
        # Stored + retrievable internally, encrypted at rest.
        self.assertEqual(self.o.credential_store.secret("freeagent")["access_token"], "AT_SECRET")
        blob = (Path(self._tmp.name) / "credentials" / "freeagent.cred").read_bytes()
        self.assertNotIn(b"AT_SECRET", blob)

    def test_access_token_refreshes_when_expired(self):
        # Seed an already-expired token.
        self.o.credential_store.put("freeagent", {
            "access_token": "OLD", "refresh_token": "RT", "expires_at": int(time.time()) - 10,
            "client_id": "cid", "client_secret": "csec",
            "token_endpoint": self.cfg.token_endpoint}, scopes=["read"])
        self.o.http_json = lambda *a, **k: (200, {"access_token": "NEW", "expires_in": 3600})
        self.assertEqual(self.o.access_token_for("freeagent"), "NEW")
        # Persisted.
        self.assertEqual(self.o.credential_store.secret("freeagent")["access_token"], "NEW")

    def test_access_token_uses_cached_when_valid(self):
        self.o.credential_store.put("freeagent", {
            "access_token": "CACHED", "refresh_token": "RT", "expires_at": int(time.time()) + 999,
            "client_id": "cid", "client_secret": "csec", "token_endpoint": self.cfg.token_endpoint},
            scopes=["read"])
        def boom(*a, **k):
            raise AssertionError("should not refresh a valid token")
        self.o.http_json = boom
        self.assertEqual(self.o.access_token_for("freeagent"), "CACHED")

    def test_exchange_failure_is_explicit(self):
        self.o.http_json = lambda *a, **k: (401, {"error": "invalid_grant"})
        with self.assertRaises(self.o.OAuthError):
            self.o.exchange_code(self.cfg, "bad")


if __name__ == "__main__":
    unittest.main(verbosity=2)
