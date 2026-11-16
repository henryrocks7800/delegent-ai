"""Contract tests for the Bookkeeper FreeAgent client (HTTP mocked)."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_client():
    spec = importlib.util.spec_from_file_location("freeagent_client", HERE / "freeagent_client.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class BookkeeperTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "bk-test-secret-value-32bytes-or-more!"
        self.fa = _load_client()
        # Never make real network calls / token refreshes in tests.
        self.fa.oauth2.access_token_for = lambda service: "TEST_TOKEN"
        self._responses = {}
        self._posts = []

        def fake_http(method, url, headers=None, data=None, timeout=30):
            if method == "POST":
                self._posts.append((url, json.loads(data.decode())))
                return 201, {"expense": {"url": "https://api.freeagent.com/v2/expenses/99",
                                         "gross_value": "42.5", "currency": "GBP"}}
            return self._responses.get(url, (404, {}))
        self.fa.oauth2.http_json = fake_http

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    def test_company_probe(self):
        self._responses["https://api.freeagent.com/v2/company"] = (200, {"company": {"name": "Acme Ltd"}})
        self.assertEqual(self.fa.company()["name"], "Acme Ltd")

    def test_create_expense_payload_and_attachment(self):
        created = self.fa.create_expense(
            user_url="https://api.freeagent.com/v2/users/1",
            category_url="https://api.freeagent.com/v2/categories/285",
            dated_on="2026-06-15", gross_value="42.50", description="Staples, office paper",
            attachment={"data": b"JPEGBYTES", "content_type": "image/jpeg", "file_name": "r.jpg"})
        url, payload = self._posts[0]
        self.assertTrue(url.endswith("/expenses"))
        exp = payload["expense"]
        self.assertEqual(exp["dated_on"], "2026-06-15")
        self.assertEqual(exp["gross_value"], "42.50")
        self.assertEqual(exp["attachment"]["content_type"], "image/jpeg")
        self.assertIn("data", exp["attachment"])  # base64 of the bytes
        self.assertEqual(created["url"], "https://api.freeagent.com/v2/expenses/99")

    def test_verify_reads_back_and_matches(self):
        self._responses["https://api.freeagent.com/v2/expenses/99"] = (
            200, {"expense": {"url": "https://api.freeagent.com/v2/expenses/99",
                              "gross_value": "42.5", "currency": "GBP"}})
        ok, detail = self.fa.verify_expense({"url": "https://api.freeagent.com/v2/expenses/99",
                                             "gross_value": "42.5"})
        self.assertTrue(ok, detail)

    def test_verify_fails_when_not_found(self):
        self._responses["https://api.freeagent.com/v2/expenses/99"] = (200, {"expense": {}})
        ok, detail = self.fa.verify_expense({"url": "https://api.freeagent.com/v2/expenses/99",
                                             "gross_value": "42.5"})
        self.assertFalse(ok)
        self.assertIn("does not exist", detail)

    def test_verify_fails_on_amount_mismatch(self):
        self._responses["https://api.freeagent.com/v2/expenses/99"] = (
            200, {"expense": {"url": "https://api.freeagent.com/v2/expenses/99", "gross_value": "9999"}})
        ok, detail = self.fa.verify_expense({"url": "https://api.freeagent.com/v2/expenses/99",
                                             "gross_value": "42.5"})
        self.assertFalse(ok)
        self.assertIn("mismatch", detail)

    def test_capability_removal_no_destructive_methods(self):
        # The client must physically expose no delete/update/file capability.
        names = [n for n in dir(self.fa) if not n.startswith("_")]
        for forbidden in ("delete", "destroy", "remove", "update_expense", "file_vat", "delete_expense"):
            self.assertNotIn(forbidden, names, f"client must not expose {forbidden}")

    def test_401_is_explicit(self):
        self._responses["https://api.freeagent.com/v2/company"] = (401, {"error": "bad"})
        with self.assertRaises(self.fa.FreeAgentError):
            self.fa.company()


if __name__ == "__main__":
    unittest.main(verbosity=2)
