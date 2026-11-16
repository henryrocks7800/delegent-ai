"""Contract tests for the bring-your-own Agent Mail helper (imap/smtp mocked).

These prove the safety-critical behaviour without touching a real mail server:

  * `connect` only reports connected after BOTH a real IMAP (receive) login AND
    a real SMTP (send) login succeed.
  * A failed IMAP login, or a failed SMTP login, does NOT report connected and
    does NOT persist any credential.
  * The app password is never printed to stdout, on success or on failure.
  * `test` genuinely sends a message and confirms it landed in the inbox.
  * `send` / `inbox` operate against the stored creds.

The fake IMAP + SMTP share one in-memory MAILBOX, so `test` (send-to-self then
search) exercises the real send->receive round trip against the fakes.
"""
import email
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
APP_PASSWORD = "abcd efgh ijkl mnop"  # a Gmail-style 16-char app password
ADDRESS = "my.agent.9f2c@gmail.com"

# Shared in-memory inbox the fake SMTP writes to and the fake IMAP reads from.
MAILBOX: list[bytes] = []


def _load_module():
    spec = importlib.util.spec_from_file_location("agent_mail", HERE / "agent_mail.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeIMAP:
    """Stand-in for imaplib.IMAP4_SSL backed by the shared MAILBOX."""
    login_fails = False
    instances: list["FakeIMAP"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.logged_in = None
        FakeIMAP.instances.append(self)

    def login(self, user, password):
        if FakeIMAP.login_fails:
            raise __import__("imaplib").IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")
        self.logged_in = (user, password)
        return ("OK", [b"LOGIN completed"])

    def select(self, mailbox="INBOX"):
        return ("OK", [str(len(MAILBOX)).encode()])

    def search(self, charset, *criteria):
        if criteria and criteria[0] == "ALL":
            ids = [str(i).encode() for i in range(1, len(MAILBOX) + 1)]
            return ("OK", [b" ".join(ids)])
        needle = criteria[-1].strip('"') if criteria else ""
        ids = []
        for idx, raw in enumerate(MAILBOX, start=1):
            msg = email.message_from_bytes(raw)
            if needle and needle in (msg.get("Subject") or ""):
                ids.append(str(idx).encode())
        return ("OK", [b" ".join(ids)])

    def fetch(self, mid, parts):
        raw = MAILBOX[int(mid) - 1]
        return ("OK", [(b"1 (BODY[HEADER])", raw)])

    def logout(self):
        return ("BYE", [b""])

    def close(self):
        return ("OK", [b""])


class FakeSMTP:
    """Stand-in for smtplib.SMTP (STARTTLS path)."""
    login_fails = False
    instances: list["FakeSMTP"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.logged_in = None
        self.started_tls = False
        FakeSMTP.instances.append(self)

    def ehlo(self, *a):
        return (250, b"ok")

    def starttls(self, *a, **k):
        self.started_tls = True
        return (220, b"ready")

    def login(self, user, password):
        if FakeSMTP.login_fails:
            raise __import__("smtplib").SMTPAuthenticationError(535, b"auth failed")
        self.logged_in = (user, password)
        return (235, b"accepted")

    def send_message(self, msg):
        MAILBOX.append(msg.as_bytes())
        return {}

    def quit(self):
        return (221, b"bye")


class FakeSMTP_SSL(FakeSMTP):
    """Stand-in for smtplib.SMTP_SSL (implicit-TLS path, e.g. Gmail :465)."""
    def __init__(self, host, port, timeout=None, context=None):
        super().__init__(host, port, timeout=timeout)


class AgentMailTests(unittest.TestCase):
    def setUp(self):
        MAILBOX.clear()
        FakeIMAP.instances.clear()
        FakeSMTP.instances.clear()
        FakeIMAP.login_fails = False
        FakeSMTP.login_fails = False
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self._tmp.name
        os.environ["DELEGENT_CRED_KEY"] = "agent-mail-test-secret-32bytes-minimum!"
        self.am = _load_module()
        self._patchers = [
            mock.patch.object(self.am.imaplib, "IMAP4_SSL", FakeIMAP),
            mock.patch.object(self.am.smtplib, "SMTP", FakeSMTP),
            mock.patch.object(self.am.smtplib, "SMTP_SSL", FakeSMTP_SSL),
        ]
        for p in self._patchers:
            p.start()

    def tearDown(self):
        for p in self._patchers:
            p.stop()
        self._tmp.cleanup()
        os.environ.pop("DELEGENT_CRED_KEY", None)
        os.environ.pop("HERMES_HOME", None)

    def _run(self, argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = self.am.run(argv)
        out = buf.getvalue()
        try:
            payload = json.loads(out)
        except json.JSONDecodeError:
            payload = None
        return rc, out, payload

    def _connect(self):
        return self._run(["connect", "--address", ADDRESS, "--app-password", APP_PASSWORD])

    # --- connect verifies BOTH IMAP and SMTP before reporting connected ------
    def test_connect_verifies_both_imap_and_smtp(self):
        rc, out, payload = self._connect()
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload["connected"])
        self.assertEqual(payload["provider"], "Gmail")
        # A real IMAP login AND a real SMTP login both happened.
        self.assertTrue(any(i.logged_in for i in FakeIMAP.instances),
                        "IMAP login was never attempted/succeeded")
        self.assertTrue(any(s.logged_in for s in FakeSMTP.instances),
                        "SMTP login was never attempted/succeeded")
        # Gmail auto-detected to imap.gmail.com / smtp.gmail.com:465 (SSL).
        self.assertTrue(any(i.host == "imap.gmail.com" for i in FakeIMAP.instances))
        self.assertTrue(any(isinstance(s, FakeSMTP_SSL) and s.port == 465
                            for s in FakeSMTP.instances))
        # Creds actually persisted only after both logins passed.
        self.assertTrue(self.am.credential_store.is_connected("agent_mail"))

    # --- AgentMail auto-detects its hosts (no manual --imap-host needed) ------
    def test_agentmail_address_autodetects_hosts_and_connects(self):
        cfg = self.am._resolve_hosts("agent2@agentmail.to")
        self.assertEqual(cfg["provider"], "AgentMail")
        self.assertEqual(cfg["imap_host"], "imap.agentmail.to")
        self.assertEqual(cfg["smtp_host"], "smtp.agentmail.to")
        self.assertEqual(cfg["smtp_port"], 587)
        # connect works with NO explicit host flags (the fix for Dan having to
        # pass every host by hand). The API key is passed as the app-password.
        rc, out, payload = self._run(
            ["connect", "--address", "agent2@agentmail.to", "--app-password", "am_us_inbox_testkey"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload["connected"])
        self.assertEqual(payload["provider"], "AgentMail")
        self.assertTrue(any(i.host == "imap.agentmail.to" for i in FakeIMAP.instances))

    def test_imap_login_passes_a_socket_timeout(self):
        # A slow/hung IMAP host must not block forever: the login opens with a
        # bounded socket timeout rather than the default (no timeout).
        self._connect()
        self.assertTrue(any(getattr(i, "timeout", None) == self.am._IMAP_TIMEOUT_SECONDS
                            for i in FakeIMAP.instances),
                        "IMAP4_SSL was opened without the bounded timeout")

    # --- a failed login does NOT report connected ----------------------------
    def test_failed_imap_login_not_connected_and_not_stored(self):
        FakeIMAP.login_fails = True
        rc, out, payload = self._connect()
        self.assertEqual(rc, 1)
        self.assertFalse(payload["connected"])
        self.assertEqual(payload["stage"], "imap")
        # No credential was written.
        self.assertFalse(self.am.credential_store.is_connected("agent_mail"))

    def test_failed_smtp_login_not_connected_and_not_stored(self):
        # IMAP succeeds, SMTP fails -> still must NOT report connected.
        FakeSMTP.login_fails = True
        rc, out, payload = self._connect()
        self.assertEqual(rc, 1)
        self.assertFalse(payload["connected"])
        self.assertEqual(payload["stage"], "smtp")
        self.assertFalse(self.am.credential_store.is_connected("agent_mail"))

    # --- the app password is never printed -----------------------------------
    def test_app_password_never_printed_on_success(self):
        rc, out, _ = self._connect()
        self.assertNotIn(APP_PASSWORD, out)
        self.assertNotIn("mnop", out)  # a fragment of the password

    def test_app_password_never_printed_on_failure(self):
        FakeSMTP.login_fails = True
        rc, out, _ = self._connect()
        self.assertNotIn(APP_PASSWORD, out)
        self.assertNotIn("mnop", out)

    def test_missing_inputs_fail_loudly(self):
        rc, out, payload = self._run(["connect", "--address", "", "--app-password", APP_PASSWORD])
        self.assertEqual(rc, 1)
        self.assertFalse(payload["connected"])

    # --- test sends a real message and confirms it landed --------------------
    def test_test_command_sends_and_confirms(self):
        self._connect()
        self.assertEqual(len(MAILBOX), 0)
        rc, out, payload = self._run(["test", "--attempts", "3", "--delay", "0"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload["tested"])
        self.assertTrue(payload["delivered"])
        # Exactly one message was sent (to self) and it is now in the inbox.
        self.assertEqual(len(MAILBOX), 1)
        self.assertNotIn(APP_PASSWORD, out)

    def test_test_reports_not_delivered_if_never_lands(self):
        self._connect()
        # Neuter the send so the mailbox stays empty; delivery must fail honestly.
        with mock.patch.object(self.am, "_send_message", lambda *a, **k: None):
            rc, out, payload = self._run(["test", "--attempts", "2", "--delay", "0"])
        self.assertEqual(rc, 1)
        self.assertFalse(payload["tested"])
        self.assertFalse(payload.get("delivered", False))

    # --- send + inbox operate against stored creds ---------------------------
    def test_send_then_inbox_lists_message(self):
        self._connect()
        rc, out, payload = self._run(
            ["send", "--to", "someone@example.com", "--subject", "Hello there",
             "--body", "Body text"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload["sent"])
        self.assertNotIn(APP_PASSWORD, out)
        rc, out, payload = self._run(["inbox", "--limit", "5"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["messages"][0]["subject"], "Hello there")

    def test_commands_before_connect_fail_cleanly(self):
        rc, out, payload = self._run(["inbox"])
        self.assertEqual(rc, 1)
        self.assertIn("not connected", out.lower())

    # --- custom (non-Gmail/Outlook) provider via explicit hosts --------------
    def test_custom_provider_uses_starttls_on_587(self):
        rc, out, payload = self._run([
            "connect", "--address", "agent@my-own-domain.example",
            "--app-password", APP_PASSWORD,
            "--imap-host", "imap.my-own-domain.example", "--imap-port", "993",
            "--smtp-host", "smtp.my-own-domain.example", "--smtp-port", "587"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload["connected"])
        # Port 587 must go through the STARTTLS SMTP path, not SMTP_SSL.
        smtp = [s for s in self.am.smtplib.SMTP.instances
                if not isinstance(s, FakeSMTP_SSL)]
        self.assertTrue(any(s.started_tls and s.port == 587 for s in smtp))


if __name__ == "__main__":
    unittest.main(verbosity=2)
