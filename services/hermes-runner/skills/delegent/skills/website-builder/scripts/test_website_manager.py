"""Contract tests for website_manager.py (build + deploy + manage a NEW site).

Everything network / CLI / git is mocked. The load-bearing guarantees under test:
  * connect stores the Firebase service-account key ENCRYPTED in the central
    vault (never plaintext on disk, never printed);
  * deploy materialises the key to a 0600 temp file, runs the CLI, verifies the
    live URL, and shreds the temp key — even when the deploy fails;
  * a failed live read-back (404 / stale / unreachable) => NOT live;
  * the verify-the-real-end-state rule (200 + exact commit) holds.
"""
import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

# A well-formed service-account key with a unique marker we can hunt for on disk.
SECRET_MARKER = "SECRET_PRIVATE_KEY_MARKER_9Z"
FAKE_SA = {
    "type": "service_account",
    "project_id": "demo-proj",
    "client_email": "svc@demo-proj.iam.gserviceaccount.com",
    "private_key": f"-----BEGIN PRIVATE KEY-----\n{SECRET_MARKER}\n-----END PRIVATE KEY-----\n",
}


def _load():
    spec = importlib.util.spec_from_file_location("website_manager", HERE / "website_manager.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["website_manager"] = mod
    spec.loader.exec_module(mod)
    return mod


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "wm-test-secret-value-32bytes-or-more!"
        self.wm = _load()
        self.cs = self.wm.credential_store  # the exact store instance wm uses

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    def _connect(self):
        # Feed the "pasted" JSON on stdin (as the agent does), so nothing plaintext
        # is written to disk by the harness itself.
        args = self._ns(service_account_json="-")
        buf = io.StringIO()
        real_stdin = sys.stdin
        sys.stdin = io.StringIO(json.dumps(FAKE_SA))
        try:
            with contextlib.redirect_stdout(buf):
                self.wm.cmd_connect(args)
        finally:
            sys.stdin = real_stdin
        return buf.getvalue()

    @staticmethod
    def _ns(**kw):
        import argparse
        return argparse.Namespace(**kw)

    def _built_site(self):
        site = Path(self._tmp.name) / "site"
        (site / "public").mkdir(parents=True)
        (site / "public" / "index.html").write_text(
            "<html><head></head><body>hi</body></html>", encoding="utf-8")
        (site / "firebase.json").write_text(self.wm._firebase_json(), encoding="utf-8")
        return site


class ConnectStoresInVault(_Base):
    def test_connect_stores_encrypted_and_never_prints_secret(self):
        out = self._connect()
        payload = json.loads(out)
        self.assertTrue(payload["connected"])
        self.assertEqual(payload["service"], "firebase-demo-proj")
        self.assertEqual(payload["project_id"], "demo-proj")
        self.assertEqual(payload["stored"], "encrypted")
        # The secret is NEVER printed on connect.
        self.assertNotIn(SECRET_MARKER, out)

        # It really landed in the vault, keyed firebase-<projectid>.
        self.assertTrue(self.cs.is_connected("firebase-demo-proj"))
        self.assertEqual(self.cs.secret("firebase-demo-proj")["private_key"],
                         FAKE_SA["private_key"])

    def test_no_plaintext_key_persisted_anywhere_under_home(self):
        self._connect()
        # Walk every file under HERMES_HOME: the marker must appear in NONE of
        # them (the .cred blob is encrypted; nothing else should hold the key).
        offenders = []
        for p in Path(self._tmp.name).rglob("*"):
            if p.is_file():
                try:
                    if SECRET_MARKER.encode() in p.read_bytes():
                        offenders.append(str(p))
                except OSError:
                    pass
        self.assertEqual(offenders, [], f"plaintext key leaked to: {offenders}")

    def test_connect_rejects_non_service_account(self):
        sa_file = Path(self._tmp.name) / "bad.json"
        sa_file.write_text(json.dumps({"type": "authorized_user"}), encoding="utf-8")
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stdout(io.StringIO()):
                self.wm.cmd_connect(self._ns(service_account_json=str(sa_file)))


class DeployMaterialisesAndCleansUp(_Base):
    def setUp(self):
        super().setUp()
        self._connect()
        self.site = self._built_site()
        self.wm._commit_hash = lambda _d: "deadbeefcafe1234"
        self.wm._ensure_firebase_cli = lambda: "/fake/node_modules/.bin/firebase"
        self.seen = {}

    def _spy_deploy(self, *, rc=0, out="Success! Published", raise_exc=None):
        """Install a fake _run_firebase_deploy that records what it saw about the
        materialised credential file at call time."""
        def fake(site_dir, project, cred_path, firebase_bin):
            self.seen["cred_path"] = cred_path
            self.seen["existed_during"] = os.path.exists(cred_path)
            self.seen["mode"] = stat.S_IMODE(os.stat(cred_path).st_mode)
            self.seen["content"] = json.loads(Path(cred_path).read_text())
            self.seen["project"] = project
            self.seen["firebase_bin"] = firebase_bin
            if raise_exc:
                raise raise_exc
            return rc, out
        self.wm._run_firebase_deploy = fake

    def test_deploy_materialises_temp_verifies_then_shreds(self):
        self._spy_deploy(rc=0)
        self.wm.verify_live = lambda url, h, path="/version.txt": (True, "verified live: ...")

        result = self.wm.deploy_site(str(self.site))
        self.assertTrue(result["deployed"], result)
        self.assertEqual(result["stamped_commit"], "deadbeefcafe1234")

        # The key was really materialised (0600, correct project) during deploy...
        self.assertTrue(self.seen["existed_during"])
        self.assertEqual(self.seen["mode"], 0o600)
        self.assertEqual(self.seen["project"], "demo-proj")
        self.assertEqual(self.seen["content"]["private_key"], FAKE_SA["private_key"])
        self.assertTrue(self.seen["firebase_bin"].endswith(".bin/firebase"))
        # ...and it must NOT survive the deploy.
        self.assertFalse(os.path.exists(self.seen["cred_path"]),
                         "temp key was not shredded")
        # The commit really got stamped into the deployed tree.
        self.assertEqual((self.site / "public" / "version.txt").read_text().strip(),
                         "deadbeefcafe1234")

    def test_temp_key_shredded_even_when_cli_raises(self):
        self._spy_deploy(raise_exc=self.wm.WebsiteError("boom"))
        with self.assertRaises(self.wm.WebsiteError):
            self.wm.deploy_site(str(self.site))
        self.assertFalse(os.path.exists(self.seen["cred_path"]),
                         "temp key must be shredded even when the deploy errors")

    def test_deploy_nonzero_rc_is_not_deployed_and_temp_gone(self):
        self._spy_deploy(rc=1, out="firebase: permission denied")
        result = self.wm.deploy_site(str(self.site))
        self.assertFalse(result["deployed"])
        self.assertIn("exited 1", result["error"])
        self.assertFalse(os.path.exists(self.seen["cred_path"]))


class FailedCurlMeansNotLive(_Base):
    def setUp(self):
        super().setUp()
        self._connect()
        self.site = self._built_site()
        self.wm._commit_hash = lambda _d: "abc123"
        self.wm._ensure_firebase_cli = lambda: "/fake/firebase"
        self.wm._run_firebase_deploy = lambda *a, **k: (0, "Success! Published")

    def test_404_readback_means_not_live(self):
        # The CLI "succeeds" but the live URL serves a 404 => NOT live.
        self.wm.fetch_url = lambda url, *, timeout=30: (404, "Not Found")
        result = self.wm.deploy_site(str(self.site))
        self.assertFalse(result["deployed"])
        self.assertIn("404", result["verification"])
        self.assertIn("did NOT actually", result["verification"])

    def test_stale_build_means_not_live(self):
        self.wm.fetch_url = lambda url, *, timeout=30: (200, "OLDOLDOLD\n")
        result = self.wm.deploy_site(str(self.site))
        self.assertFalse(result["deployed"])
        self.assertIn("mismatch", result["verification"])

    def test_verified_match_is_live(self):
        self.wm.fetch_url = lambda url, *, timeout=30: (200, "abc123\n")
        result = self.wm.deploy_site(str(self.site))
        self.assertTrue(result["deployed"], result)
        self.assertIn("verified live", result["verification"])


class ManageAndResolve(_Base):
    def test_status_reports_connected_project_never_key(self):
        self._connect()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.wm.cmd_status(self._ns(project=None))
        payload = json.loads(buf.getvalue())
        self.assertTrue(payload["connected"])
        self.assertEqual(payload["project_id"], "demo-proj")
        self.assertNotIn(SECRET_MARKER, buf.getvalue())

    def test_build_scaffolds_site_and_firebaserc(self):
        self._connect()
        self.wm._git = lambda *a, **k: (0, "")  # no real git in the test
        site = Path(self._tmp.name) / "newsite"
        result = self.wm.build_site(str(site), name="Acme", brief="we do things")
        self.assertTrue(result["built"])
        self.assertTrue((site / "public" / "index.html").is_file())
        self.assertTrue((site / "firebase.json").is_file())
        rc = json.loads((site / ".firebaserc").read_text())
        self.assertEqual(rc["projects"]["default"], "demo-proj")

    def test_deploy_without_connect_is_explicit(self):
        # No credential stored -> a clear error, not a crash.
        site = self._built_site()
        with self.assertRaises(self.wm.WebsiteError):
            self.wm.deploy_site(str(site))


if __name__ == "__main__":
    unittest.main(verbosity=2)
