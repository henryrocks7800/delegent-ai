"""Contract tests for the `delegent-keys` central encrypted vault CLI.

Drives the real executable as a subprocess (the way the agent uses it) against an
isolated temp HERMES_HOME, with NO env key set — so it also proves the CLI works
on the self-provisioned per-runner volume key.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KEYS = Path(__file__).resolve().parent / "delegent-keys"


class DelegentKeysCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.env = os.environ.copy()
        self.env["HERMES_HOME"] = self.home
        # Prove the CLI works with NO explicit key (self-provisioned volume key).
        self.env.pop("DELEGENT_CRED_KEY", None)
        self.env.pop("SIDEKICK_RUNNER_SHARED_SECRET", None)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, *args, stdin=None):
        return subprocess.run(
            [sys.executable, str(KEYS), *args],
            input=stdin, env=self.env, capture_output=True, text=True)

    # --- put / list / remove round-trip --------------------------------------
    def test_put_list_remove_roundtrip(self):
        r = self._run("put", "openai-key", "--value", "sk-SECRET-abc", "--scope", "chat")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("sk-SECRET-abc", r.stdout, "put must never echo the secret")
        self.assertIn("openai-key", r.stdout)

        r = self._run("list")
        self.assertEqual(r.returncode, 0, r.stderr)
        listing = json.loads(r.stdout)
        services = [item["service"] for item in listing]
        self.assertIn("openai-key", services)
        # list must never leak the secret anywhere.
        self.assertNotIn("sk-SECRET-abc", r.stdout)

        r = self._run("remove", "openai-key")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["removed"])

        r = self._run("list")
        self.assertEqual([i["service"] for i in json.loads(r.stdout)], [])
        # removing again reports not-found and exits non-zero.
        r = self._run("remove", "openai-key")
        self.assertNotEqual(r.returncode, 0)

    def test_put_json_is_stored_as_dict(self):
        sa = {"type": "service_account", "project_id": "demo", "private_key": "PRIV"}
        r = self._run("put", "firebase-demo", "--stdin", stdin=json.dumps(sa))
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self._run("list")
        self.assertNotIn("PRIV", r.stdout)

    def test_put_rejects_empty_and_multiple_sources(self):
        self.assertNotEqual(self._run("put", "x", "--value", "  ").returncode, 0)
        self.assertNotEqual(
            self._run("put", "x", "--value", "a", "--stdin", stdin="b").returncode, 0)

    # --- run --file: transient 0600 temp file, deleted afterward -------------
    def test_run_with_file_materialises_then_deletes(self):
        sa = {"type": "service_account", "project_id": "demo", "private_key": "PRIVKEY"}
        self._run("put", "firebase-demo", "--stdin", stdin=json.dumps(sa))

        path_marker = Path(self.home) / "seen_path.txt"
        content_marker = Path(self.home) / "seen_content.txt"
        # The child records the path it was handed + its contents, so we can prove
        # (a) the env var pointed at a real file during the run and
        # (b) that file is gone once the run returns.
        script = (f'printf "%s" "$GOOGLE_APPLICATION_CREDENTIALS" > "{path_marker}"; '
                  f'cat "$GOOGLE_APPLICATION_CREDENTIALS" > "{content_marker}"')
        r = self._run("run", "--service", "firebase-demo", "--file",
                      "--var", "GOOGLE_APPLICATION_CREDENTIALS",
                      "--", "bash", "-c", script)
        self.assertEqual(r.returncode, 0, r.stderr)

        temp_path = path_marker.read_text().strip()
        self.assertTrue(temp_path, "the command did not receive a credentials path")
        # The materialised file held the real (decrypted) service account...
        self.assertEqual(json.loads(content_marker.read_text()), sa)
        # ...and it must NOT survive the run.
        self.assertFalse(os.path.exists(temp_path),
                         f"temp key {temp_path} was not cleaned up")
        # The secret never rode out on the CLI's own streams.
        self.assertNotIn("PRIVKEY", r.stdout)
        self.assertNotIn("PRIVKEY", r.stderr)

    def test_run_file_temp_cleaned_up_even_on_failure(self):
        sa = {"type": "service_account", "project_id": "demo", "private_key": "PRIV"}
        self._run("put", "firebase-demo", "--stdin", stdin=json.dumps(sa))
        path_marker = Path(self.home) / "fail_path.txt"
        script = f'printf "%s" "$GOOGLE_APPLICATION_CREDENTIALS" > "{path_marker}"; exit 7'
        r = self._run("run", "--service", "firebase-demo", "--file",
                      "--", "bash", "-c", script)
        self.assertEqual(r.returncode, 7, "run must propagate the child's exit code")
        temp_path = path_marker.read_text().strip()
        self.assertFalse(os.path.exists(temp_path),
                         "temp key must be shredded even when the command fails")

    # --- run without --file: value goes into the env var ---------------------
    def test_run_without_file_sets_value_env(self):
        self._run("put", "api", "--value", "sk-INLINE-999")
        out_marker = Path(self.home) / "env_value.txt"
        r = self._run("run", "--service", "api", "--var", "MY_TOKEN",
                      "--", "bash", "-c", f'printf "%s" "$MY_TOKEN" > "{out_marker}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(out_marker.read_text().strip(), "sk-INLINE-999")

    def test_run_unknown_service_fails_loudly(self):
        r = self._run("run", "--service", "nope", "--", "true")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not connected", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
