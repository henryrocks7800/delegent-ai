"""Contract tests for the Operations Manager scoped clients (HTTP mocked).

Covers the brief's three required guarantees:
  * capability removal - the client classes physically have no dangerous method;
  * scope exclusion - the requested OAuth scopes exclude the dangerous ones;
  * end-state verification - success only when the read-back confirms.
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class CalendarClientTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "ops-test-secret-value-32bytes-or-more!"
        self.cal = _load("calendar_client")
        self.cal.oauth2.access_token_for = lambda service: "TEST_TOKEN"
        self._responses = {}
        self._posts = []

        def fake_http(method, url, headers=None, data=None, timeout=30):
            if method == "POST":
                self._posts.append((url, json.loads(data.decode())))
                return 200, {"id": "evt_99", "summary": "Team sync",
                             "start": {"dateTime": "2026-06-20T10:00:00Z"},
                             "status": "confirmed",
                             "htmlLink": "https://calendar.google.com/evt_99"}
            return self._responses.get(url, (404, {}))
        self.cal.oauth2.http_json = fake_http

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    # --- capability removal -------------------------------------------------
    def test_capability_removal_no_destructive_methods(self):
        names = [n for n in dir(self.cal) if not n.startswith("_")]
        for forbidden in ("delete", "destroy", "remove", "cancel", "delete_event",
                          "cancel_event", "clear", "clear_calendar", "delete_calendar",
                          "batch_delete", "purge"):
            self.assertNotIn(forbidden, names, f"calendar client must not expose {forbidden}")

    # --- scope exclusion ----------------------------------------------------
    def test_scopes_exclude_dangerous(self):
        # Only read + events; no full-account, no settings, no sharing/ACL scope.
        self.assertIn("https://www.googleapis.com/auth/calendar.readonly", self.cal.SCOPES)
        self.assertIn("https://www.googleapis.com/auth/calendar.events", self.cal.SCOPES)
        joined = " ".join(self.cal.SCOPES)
        for dangerous in ("calendar.acls", "calendar.settings", "calendar.app.created",
                          "/auth/calendar "):  # the broad read/write-everything scope
            self.assertNotIn(dangerous, joined, f"must not request {dangerous}")
        # The bare full-access scope must not be present as an exact element.
        self.assertNotIn("https://www.googleapis.com/auth/calendar", self.cal.SCOPES)

    # --- end-state verification --------------------------------------------
    def test_verify_reads_back_and_matches(self):
        self._responses["https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_99"] = (
            200, {"id": "evt_99", "summary": "Team sync", "status": "confirmed",
                  "start": {"dateTime": "2026-06-20T10:00:00Z"},
                  "htmlLink": "https://calendar.google.com/evt_99"})
        created = self.cal.create_event(
            summary="Team sync", start_iso="2026-06-20T10:00:00Z",
            end_iso="2026-06-20T10:30:00Z")
        ok, detail = self.cal.verify_event(created)
        self.assertTrue(ok, detail)

    def test_verify_fails_when_not_found(self):
        self._responses["https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_99"] = (
            200, {})
        ok, detail = self.cal.verify_event({"id": "evt_99", "summary": "Team sync"})
        self.assertFalse(ok)
        self.assertIn("does not exist", detail)

    def test_verify_fails_on_summary_mismatch(self):
        self._responses["https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_99"] = (
            200, {"id": "evt_99", "summary": "Something else", "status": "confirmed"})
        ok, detail = self.cal.verify_event({"id": "evt_99", "summary": "Team sync"})
        self.assertFalse(ok)
        self.assertIn("mismatch", detail)

    def test_verify_fails_when_cancelled(self):
        self._responses["https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_99"] = (
            200, {"id": "evt_99", "summary": "Team sync", "status": "cancelled"})
        ok, detail = self.cal.verify_event({"id": "evt_99", "summary": "Team sync"})
        self.assertFalse(ok)
        self.assertIn("cancelled", detail)

    def test_list_calendars_probe(self):
        self._responses["https://www.googleapis.com/calendar/v3/users/me/calendarList"] = (
            200, {"items": [{"id": "me@x.com", "summary": "Primary", "primary": True}]})
        self.assertEqual(self.cal.primary_calendar()["id"], "me@x.com")

    def test_401_is_explicit(self):
        self._responses["https://www.googleapis.com/calendar/v3/users/me/calendarList"] = (401, {})
        with self.assertRaises(self.cal.CalendarError):
            self.cal.list_calendars()


class TasksClientTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "ops-test-secret-value-32bytes-or-more!"
        self.tk = _load("tasks_client")
        # Seed a stored token so _token() works without a real connect.
        self.tk.credential_store.put("todoist", {"api_token": "TEST_TODOIST_TOKEN"})
        self._responses = {}
        self._posts = []

        def fake_http(method, url, headers=None, data=None, timeout=30):
            if method == "POST":
                payload = json.loads(data.decode()) if data else {}
                self._posts.append((url, payload))
                if url.endswith("/tasks"):
                    return 200, {"id": "task_99", "content": payload.get("content"),
                                 "url": "https://todoist.com/task/99"}
                return 204, {}
            return self._responses.get(url, (404, {}))
        self.tk.oauth2.http_json = fake_http

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    # --- capability removal -------------------------------------------------
    def test_capability_removal_no_destructive_methods(self):
        names = [n for n in dir(self.tk) if not n.startswith("_")]
        for forbidden in ("delete", "destroy", "remove", "delete_task", "delete_project",
                          "purge", "erase", "wipe"):
            self.assertNotIn(forbidden, names, f"tasks client must not expose {forbidden}")

    # --- scope exclusion (token-auth, but the safe surface is the method set) -
    def test_no_destructive_http_verb_paths(self):
        # The module source must not issue an HTTP DELETE anywhere.
        src = (HERE / "tasks_client.py").read_text()
        self.assertNotIn('"DELETE"', src)
        self.assertNotIn("'DELETE'", src)

    # --- end-state verification --------------------------------------------
    def test_add_then_verify_reads_back(self):
        created = self.tk.add_task(content="Call the accountant")
        self._responses["https://api.todoist.com/rest/v2/tasks/task_99"] = (
            200, {"id": "task_99", "content": "Call the accountant",
                  "url": "https://todoist.com/task/99"})
        ok, detail = self.tk.verify_task(created)
        self.assertTrue(ok, detail)

    def test_verify_fails_when_not_found(self):
        self._responses["https://api.todoist.com/rest/v2/tasks/task_99"] = (404, {})
        ok, detail = self.tk.verify_task({"id": "task_99", "content": "x"})
        self.assertFalse(ok)

    def test_verify_fails_on_content_mismatch(self):
        self._responses["https://api.todoist.com/rest/v2/tasks/task_99"] = (
            200, {"id": "task_99", "content": "totally different"})
        ok, detail = self.tk.verify_task({"id": "task_99", "content": "Call the accountant"})
        self.assertFalse(ok)
        self.assertIn("mismatch", detail)

    def test_close_then_verify_closed(self):
        # After a close, the task must be gone from the open list to count.
        self.assertTrue(self.tk.close_task(task_id="task_99"))
        self._responses["https://api.todoist.com/rest/v2/tasks"] = (
            200, [{"id": "task_42", "content": "still open"}])
        ok, detail = self.tk.verify_closed(task_id="task_99")
        self.assertTrue(ok, detail)

    def test_verify_closed_fails_if_still_open(self):
        self._responses["https://api.todoist.com/rest/v2/tasks"] = (
            200, [{"id": "task_99", "content": "still open"}])
        ok, detail = self.tk.verify_closed(task_id="task_99")
        self.assertFalse(ok)
        self.assertIn("still", detail)

    def test_projects_probe(self):
        self._responses["https://api.todoist.com/rest/v2/projects"] = (
            200, [{"id": "p1", "name": "Inbox"}])
        self.assertEqual(self.tk.list_projects()[0]["name"], "Inbox")

    def test_401_is_explicit(self):
        self._responses["https://api.todoist.com/rest/v2/projects"] = (401, {})
        with self.assertRaises(self.tk.TasksError):
            self.tk.list_projects()


class CredentialStoreNeverEchoesSecretTests(unittest.TestCase):
    """The agent-visible listing must never carry the secret payload."""
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "ops-test-secret-value-32bytes-or-more!"
        # Reuse the exact credential_store the clients load (same shared module).
        self.store = _load("tasks_client").credential_store

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)

    def test_listing_omits_secret(self):
        self.store.put("todoist", {"api_token": "SUPER_SECRET"}, meta={"auth": "personal_token"})
        listed = self.store.listing()
        blob = json.dumps(listed)
        self.assertNotIn("SUPER_SECRET", blob)
        self.assertIn("todoist", blob)


if __name__ == "__main__":
    unittest.main(verbosity=2)
