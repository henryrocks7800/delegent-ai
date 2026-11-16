"""Contract tests for the operator-skills encrypted credential store."""
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("credential_store", HERE / "credential_store.py")
cs = importlib.util.module_from_spec(spec)


class CredentialStoreTests(unittest.TestCase):
    """With an explicit DELEGENT_CRED_KEY set (the override path)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "test-runner-secret-value-32bytes-or-more"
        spec.loader.exec_module(cs)  # re-exec so env is picked up fresh

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    def test_roundtrip_and_scopes(self):
        cs.put("freeagent", {"access_token": "tok_SECRET_123", "refresh_token": "ref_456"},
               scopes=["read", "write_expenses"], meta={"company": "Acme Ltd"})
        self.assertTrue(cs.is_connected("freeagent"))
        self.assertEqual(cs.secret("freeagent")["access_token"], "tok_SECRET_123")
        rec = cs.get("freeagent")
        self.assertEqual(rec["scopes"], ["read", "write_expenses"])
        self.assertEqual(rec["meta"]["company"], "Acme Ltd")

    def test_secret_is_encrypted_at_rest(self):
        cs.put("gmail", {"refresh_token": "PLAINTEXT_SHOULD_NOT_APPEAR"})
        blob = (Path(self._tmp.name) / "credentials" / "gmail.cred").read_bytes()
        self.assertNotIn(b"PLAINTEXT_SHOULD_NOT_APPEAR", blob)

    def test_listing_never_leaks_secret(self):
        cs.put("freeagent", {"access_token": "tok_SECRET_123"}, scopes=["read"])
        listing = cs.listing()
        self.assertEqual(len(listing), 1)
        self.assertEqual(listing[0]["service"], "freeagent")
        self.assertEqual(listing[0]["scopes"], ["read"])
        # The whole serialized listing must not contain the secret anywhere.
        self.assertNotIn("tok_SECRET_123", json.dumps(listing))
        self.assertNotIn("_secret", json.dumps(listing))

    def test_get_unconnected_raises_clearly(self):
        with self.assertRaises(cs.CredentialError):
            cs.get("not_connected")

    def test_remove(self):
        cs.put("xero", {"k": "v"})
        self.assertTrue(cs.is_connected("xero"))
        self.assertTrue(cs.remove("xero"))
        self.assertFalse(cs.is_connected("xero"))
        # Removing again is a no-op that reports nothing was there.
        self.assertFalse(cs.remove("xero"))

    def test_delete_alias_still_works(self):
        # The connect scripts still call `delete`; keep it working.
        cs.put("stripe", {"k": "v"})
        self.assertTrue(cs.delete("stripe"))
        self.assertFalse(cs.is_connected("stripe"))


class CredentialStoreVolumeKeyTests(unittest.TestCase):
    """With NO env key at all: the store must self-provision a durable per-runner
    volume key (0600) under HERMES_HOME and still work end to end."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ.pop("DELEGENT_CRED_KEY", None)
        os.environ.pop("SIDEKICK_RUNNER_SHARED_SECRET", None)
        spec.loader.exec_module(cs)

    def tearDown(self):
        self._tmp.cleanup()

    def test_volume_key_roundtrip_and_provisioning(self):
        keyfile = Path(self._tmp.name) / ".delegent_cred_key"
        self.assertFalse(keyfile.exists(), "key must not exist before first use")

        cs.put("openai", {"value": "sk-SECRET-xyz"}, scopes=["chat"])
        # put+secret round-trips without any env key.
        self.assertEqual(cs.secret("openai")["value"], "sk-SECRET-xyz")

        # A durable per-runner key file was created, mode 0600.
        self.assertTrue(keyfile.exists(), "self-provisioned volume key not created")
        mode = stat.S_IMODE(keyfile.stat().st_mode)
        self.assertEqual(mode, 0o600, f"volume key must be 0600, got {oct(mode)}")

        # listing() never contains the secret.
        listing = cs.listing()
        self.assertNotIn("sk-SECRET-xyz", json.dumps(listing))
        self.assertEqual(listing[0]["service"], "openai")

        # remove() deletes it.
        self.assertTrue(cs.remove("openai"))
        self.assertFalse(cs.is_connected("openai"))

    def test_volume_key_is_stable_across_reload(self):
        cs.put("svc", {"value": "PERSIST_ME"})
        # A brand-new load of the module (simulating a later process) must decrypt
        # the same secret using the persisted volume key.
        spec.loader.exec_module(cs)
        self.assertEqual(cs.secret("svc")["value"], "PERSIST_ME")

    def test_empty_key_file_self_heals(self):
        # An interrupted or raced first-write can leave a 0-byte key file. The old
        # code then returned an EMPTY key forever (a permanent brick / spurious
        # "cannot decrypt"). The store must treat an empty file as "no key yet",
        # provision a real one, and work end to end.
        keyfile = Path(self._tmp.name) / ".delegent_cred_key"
        keyfile.write_text("")  # simulate the truncated/empty key file
        self.assertEqual(keyfile.read_text(), "")

        cs.put("svc", {"value": "HEALED"})
        self.assertEqual(cs.secret("svc")["value"], "HEALED")
        self.assertNotEqual(keyfile.read_text().strip(), "",
                            "empty key file was not self-healed")


def _provision_worker(args):
    """Child-process entry point: load the store against a shared HERMES_HOME and
    return the provisioned key material. Module-level so it is picklable."""
    import importlib.util as _ilu
    import os as _os
    home, store_path = args
    _os.environ["HERMES_HOME"] = home
    _os.environ.pop("DELEGENT_CRED_KEY", None)
    _spec = _ilu.spec_from_file_location("credential_store", store_path)
    _mod = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    try:
        return _mod._cred_key_material()
    except Exception as exc:  # surface as a sentinel so the parent can assert
        return "ERROR:" + type(exc).__name__


class ConcurrentFirstUseTests(unittest.TestCase):
    """Simultaneous first-use sessions (interactive + background/cron) must all
    converge on ONE key. This is the regression guard for the empty/divergent-key
    race that surfaced as intermittent 'not connected' in cron runs."""

    def test_concurrent_first_use_converges_to_one_key(self):
        import multiprocessing as mp
        store_path = str(HERE / "credential_store.py")
        rounds, procs = 8, 16
        for _ in range(rounds):
            with tempfile.TemporaryDirectory() as home:
                with mp.Pool(procs) as pool:
                    keys = pool.map(_provision_worker, [(home, store_path)] * procs)
                self.assertNotIn("", keys, "a session got an EMPTY key (race window)")
                self.assertFalse([k for k in keys if str(k).startswith("ERROR:")],
                                 f"a session errored provisioning: {keys}")
                self.assertEqual(len(set(keys)), 1,
                                 f"sessions diverged on the key: {set(keys)}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
