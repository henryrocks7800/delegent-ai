#!/usr/bin/env python3
"""Bring-your-own Agent Mail helper for the agent-email-inbox skill.

This gives the user's AGENT its OWN dedicated email inbox that the USER owns.

Bring-your-own model (why it is built this way):
  * The human creates a BRAND-NEW email account (Gmail or Outlook are easiest)
    purely for the agent, turns on 2-step verification, and mints an APP
    PASSWORD. Only the address + that app password are handed to the agent.
  * Those credentials live ENCRYPTED on THIS user's own runner and nowhere else.
    The operator (Delegent) holds nothing and is responsible for nobody's mail.
  * The agent never creates the account and never asks for the main account
    password - only an app-specific password, which requires the human to turn
    on 2-step first.

Mechanic: Python standard library only - `imaplib` for receiving, `smtplib` for
sending - so it is reliable on any runner with no external mail binary.

Subcommands:
  connect  --address ADDR --app-password PW
           [--imap-host H --imap-port P --smtp-host H --smtp-port P]
           Auto-detects Gmail/Outlook host+ports (or takes explicit hosts for
           any IMAP/SMTP provider), stores the creds ENCRYPTED, and VERIFIES by
           really logging in to IMAP (receive) AND SMTP (send). Prints
           {"connected": true} only if BOTH real logins succeed.
  test     Sends a real test email from the inbox to itself and confirms it
           lands in the inbox, so "it works" is proven, not assumed.
  inbox    [--limit N] Lists recent messages (subject / from / date) for triage.
  send     --to ADDR --subject S --body B  Sends an email. The agent only calls
           this AFTER the user has approved the draft; this script just performs
           the send.
  status   Prints whether Agent Mail is connected (address only, no secret).

The app password is NEVER printed back. Secrets are stored via the shared
encrypted credential store (_shared/credential_store.py); the agent can list
what is connected but cannot read the secret value, so it physically cannot echo
a credential into chat.
"""
from __future__ import annotations

import argparse
import email
import email.utils
import html
import imaplib
import importlib.util
import json
import re
import smtplib
import ssl
import sys
import time
import uuid
from email.header import decode_header, make_header
from email.message import EmailMessage
from pathlib import Path


# --- load shared foundation (encrypted credential store) ---------------------
def _shared(name):
    p = Path(__file__).resolve().parents[3] / "_shared" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, mod)
    spec.loader.exec_module(mod)
    return mod


credential_store = _shared("credential_store")

SERVICE = "agent_mail"
SCOPES = ["mail.receive", "mail.send"]  # capability-scoped: no delete, no rules

# Easy, reliable free providers that support app-password IMAP/SMTP. Gmail and
# Outlook are the recommended options. Zoho free is deliberately absent (its free
# tier blocks IMAP). Any other IMAP/SMTP provider works if host/port are given.
PROVIDERS = {
    "gmail.com": {"name": "Gmail", "imap_host": "imap.gmail.com", "imap_port": 993,
                  "smtp_host": "smtp.gmail.com", "smtp_port": 465},
    "googlemail.com": {"name": "Gmail", "imap_host": "imap.gmail.com", "imap_port": 993,
                       "smtp_host": "smtp.gmail.com", "smtp_port": 465},
    "outlook.com": {"name": "Outlook", "imap_host": "outlook.office365.com", "imap_port": 993,
                    "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587},
    "hotmail.com": {"name": "Outlook", "imap_host": "outlook.office365.com", "imap_port": 993,
                    "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587},
    "live.com": {"name": "Outlook", "imap_host": "outlook.office365.com", "imap_port": 993,
                 "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587},
    "msn.com": {"name": "Outlook", "imap_host": "outlook.office365.com", "imap_port": 993,
                "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587},
    "yahoo.com": {"name": "Yahoo", "imap_host": "imap.mail.yahoo.com", "imap_port": 993,
                  "smtp_host": "smtp.mail.yahoo.com", "smtp_port": 465},
    "icloud.com": {"name": "iCloud", "imap_host": "imap.mail.me.com", "imap_port": 993,
                   "smtp_host": "smtp.mail.me.com", "smtp_port": 587},
    "me.com": {"name": "iCloud", "imap_host": "imap.mail.me.com", "imap_port": 993,
               "smtp_host": "smtp.mail.me.com", "smtp_port": 587},
    # AgentMail — an agent-native inbox (agentmail.to). The account's API key is
    # used as the app-password here. Its IMAP can be slow to make a just-sent
    # message visible, so `test` may report the send succeeded before delivery
    # confirms (see the slow-provider note in SKILL.md).
    "agentmail.to": {"name": "AgentMail", "imap_host": "imap.agentmail.to", "imap_port": 993,
                     "smtp_host": "smtp.agentmail.to", "smtp_port": 587},
}

# Some providers' IMAP is slow to answer; without a socket timeout a login can
# hang indefinitely and blow past the agent's command budget with no result.
_IMAP_TIMEOUT_SECONDS = 30


class AgentMailError(RuntimeError):
    """A mail failure to surface to the user honestly (never with the secret)."""


# --- helpers -----------------------------------------------------------------
def _emit(payload: dict) -> None:
    """Print a JSON result. Payload must never contain the app password."""
    print(json.dumps(payload, indent=2))


def _scrub(text: str, secret: str | None) -> str:
    """Defensively redact the app password from any error text before printing."""
    if not text:
        return text
    if secret:
        text = text.replace(secret, "***")
    return text


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _resolve_hosts(address: str, imap_host=None, imap_port=None,
                   smtp_host=None, smtp_port=None) -> dict:
    """Auto-detect Gmail/Outlook (etc.) from the address domain; explicit
    host/port overrides win so any IMAP/SMTP provider is supported."""
    domain = address.split("@")[-1].strip().lower() if "@" in address else ""
    known = PROVIDERS.get(domain, {})
    cfg = {
        "provider": known.get("name", "Custom"),
        "imap_host": imap_host or known.get("imap_host"),
        "imap_port": int(imap_port) if imap_port else known.get("imap_port", 993),
        "smtp_host": smtp_host or known.get("smtp_host"),
        "smtp_port": int(smtp_port) if smtp_port else known.get("smtp_port", 587),
    }
    missing = [k for k in ("imap_host", "smtp_host") if not cfg[k]]
    if missing:
        raise AgentMailError(
            "could not auto-detect the mail server for "
            f"'{domain or address}'. Re-run connect with explicit "
            "--imap-host/--imap-port and --smtp-host/--smtp-port for this provider."
        )
    return cfg


def _imap_login(host: str, port: int, address: str, app_password: str):
    try:
        conn = imaplib.IMAP4_SSL(host, int(port), timeout=_IMAP_TIMEOUT_SECONDS)
    except TypeError:
        # Very old Pythons (<3.9) lack the timeout kwarg; fall back so we never
        # hard-fail on it. Modern runners always take the timeout path.
        conn = imaplib.IMAP4_SSL(host, int(port))
    conn.login(address, app_password)
    return conn


def _smtp_login(host: str, port: int, address: str, app_password: str):
    port = int(port)
    if port == 465:
        conn = smtplib.SMTP_SSL(host, port, timeout=30, context=ssl.create_default_context())
    else:
        conn = smtplib.SMTP(host, port, timeout=30)
        conn.ehlo()
        conn.starttls(context=ssl.create_default_context())
        conn.ehlo()
    conn.login(address, app_password)
    return conn


def _quiet_close(conn, method: str) -> None:
    try:
        getattr(conn, method)()
    except Exception:
        pass


def _load_creds() -> dict:
    """Decrypt the stored mail credentials. Helper-only; never printed."""
    if not credential_store.is_connected(SERVICE):
        raise AgentMailError(
            "Agent Mail is not connected yet. Run `connect` first to create the "
            "agent's inbox."
        )
    return credential_store.secret(SERVICE)


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _part_text(part) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, "replace")
    except (LookupError, TypeError):
        return payload.decode("utf-8", "replace")


def _html_to_text(raw: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = _HTML_TAG_RE.sub("", text)
    return html.unescape(text)


def _extract_text(msg) -> str:
    """Best plain-text body from a parsed email (multipart-aware, compat32-safe)."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and \
               "attachment" not in str(part.get("Content-Disposition", "")):
                return _part_text(part)
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                return _html_to_text(_part_text(part))
        return ""
    if msg.get_content_type() == "text/html":
        return _html_to_text(_part_text(msg))
    return _part_text(msg)


def _clean_body(raw_text: str) -> str:
    """Trim quoted replies, forwarded blocks and signatures so the agent drafts
    against the sender's actual message, and so a reply we send carries only the
    clean text (no system metadata, no quoted history)."""
    out = []
    for ln in (raw_text or "").splitlines():
        s = ln.strip()
        if s.startswith(">") or re.match(r"(?i)^on .+wrote:$", s) \
           or re.match(r"(?i)^-+\s*(original message|forwarded message)\s*-+$", s) \
           or re.match(r"(?i)^from:\s.+@", s):
            break
        if s == "--" or re.match(r"(?i)^sent from my (iphone|ipad|android|samsung|mobile)", s):
            break
        out.append(ln)
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return cleaned


def _send_message(creds: dict, to: str, subject: str, body: str,
                  cc: str | None = None, in_reply_to: str | None = None) -> str:
    """Send a message and return its Message-ID. `cc` may be a comma-separated
    list; `in_reply_to` threads the message as a reply. smtplib derives the
    envelope recipients from the To/Cc headers."""
    msg = EmailMessage()
    msg["From"] = creds["address"]
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    mid = email.utils.make_msgid()
    msg["Message-ID"] = mid
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body)
    conn = _smtp_login(creds["smtp_host"], creds["smtp_port"],
                       creds["address"], creds["app_password"])
    try:
        conn.send_message(msg)
    finally:
        _quiet_close(conn, "quit")
    return mid


def _search_subject(conn, token: str) -> list:
    conn.select("INBOX")
    typ, data = conn.search(None, "SUBJECT", '"%s"' % token)
    if typ != "OK" or not data or not data[0]:
        return []
    return data[0].split()


# --- subcommands -------------------------------------------------------------
def cmd_connect(a) -> int:
    address = (a.address or "").strip()
    app_password = a.app_password or ""
    if not address or "@" not in address:
        _emit({"connected": False, "error": "a valid --address is required"})
        return 1
    if not app_password:
        _emit({"connected": False, "error": "an --app-password is required"})
        return 1
    try:
        cfg = _resolve_hosts(address, a.imap_host, a.imap_port, a.smtp_host, a.smtp_port)
    except AgentMailError as e:
        _emit({"connected": False, "error": str(e)})
        return 1

    # VERIFY the RECEIVE path with a real IMAP login before claiming anything.
    try:
        conn = _imap_login(cfg["imap_host"], cfg["imap_port"], address, app_password)
        try:
            conn.select("INBOX")
        finally:
            _quiet_close(conn, "logout")
    except Exception as e:  # noqa: BLE001 - report honestly, redacting the secret
        _emit({"connected": False, "stage": "imap",
               "error": _scrub(f"could not log in to receive mail (IMAP): {e}", app_password)})
        return 1

    # VERIFY the SEND path with a real SMTP login. BOTH must pass.
    try:
        conn = _smtp_login(cfg["smtp_host"], cfg["smtp_port"], address, app_password)
        _quiet_close(conn, "quit")
    except Exception as e:  # noqa: BLE001
        _emit({"connected": False, "stage": "smtp",
               "error": _scrub(f"could not log in to send mail (SMTP): {e}", app_password)})
        return 1

    # Both real logins succeeded -> now (and only now) store the creds encrypted.
    credential_store.put(
        SERVICE,
        {"address": address, "app_password": app_password,
         "imap_host": cfg["imap_host"], "imap_port": cfg["imap_port"],
         "smtp_host": cfg["smtp_host"], "smtp_port": cfg["smtp_port"]},
        scopes=SCOPES,
        meta={"address": address, "provider": cfg["provider"],
              "imap_host": cfg["imap_host"], "smtp_host": cfg["smtp_host"]},
    )
    _emit({"connected": True, "address": address, "provider": cfg["provider"],
           "verified": "IMAP login (receive) + SMTP login (send) both succeeded",
           "next": "run `test` to send a proof message to the inbox"})
    return 0


def cmd_test(a) -> int:
    try:
        creds = _load_creds()
    except AgentMailError as e:
        _emit({"tested": False, "error": str(e)})
        return 1
    token = uuid.uuid4().hex
    subject = f"Delegent Agent Mail self-test {token}"
    body = ("This is an automated self-test from your Delegent agent's inbox. "
            "If you can see this, the agent's email is working. Safe to delete.")
    try:
        _send_message(creds, to=creds["address"], subject=subject, body=body)
    except Exception as e:  # noqa: BLE001
        _emit({"tested": False, "stage": "send",
               "error": _scrub(f"the test send failed: {e}", creds.get("app_password"))})
        return 1

    # Poll IMAP for the message we just sent to ourselves; delivery can lag.
    attempts = max(1, int(a.attempts))
    delay = max(0, int(a.delay))
    landed = False
    try:
        for i in range(attempts):
            conn = _imap_login(creds["imap_host"], creds["imap_port"],
                               creds["address"], creds["app_password"])
            try:
                if _search_subject(conn, token):
                    landed = True
            finally:
                _quiet_close(conn, "logout")
            if landed:
                break
            if i < attempts - 1:
                time.sleep(delay)
    except Exception as e:  # noqa: BLE001
        _emit({"tested": False, "stage": "receive",
               "error": _scrub(f"sent, but could not confirm delivery: {e}",
                               creds.get("app_password"))})
        return 1

    if not landed:
        _emit({"tested": False, "sent": True, "delivered": False,
               "note": ("the test email was sent but has not appeared in the inbox "
                        f"yet after {attempts} checks; it may still be in transit")})
        return 1
    _emit({"tested": True, "sent": True, "delivered": True,
           "address": creds["address"],
           "proof": "a self-test email was sent and then found in the inbox"})
    return 0


def cmd_inbox(a) -> int:
    try:
        creds = _load_creds()
    except AgentMailError as e:
        _emit({"error": str(e)})
        return 1
    limit = max(1, int(a.limit))
    try:
        conn = _imap_login(creds["imap_host"], creds["imap_port"],
                           creds["address"], creds["app_password"])
        try:
            conn.select("INBOX")
            typ, data = conn.search(None, "ALL")
            ids = data[0].split() if (typ == "OK" and data and data[0]) else []
            recent = ids[-limit:][::-1]
            messages = []
            for mid in recent:
                typ, msgdata = conn.fetch(
                    mid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                if typ != "OK" or not msgdata or not msgdata[0]:
                    continue
                raw = msgdata[0][1]
                msg = email.message_from_bytes(raw)
                messages.append({
                    "from": _decode_header(msg.get("From")),
                    "subject": _decode_header(msg.get("Subject")),
                    "date": msg.get("Date", ""),
                })
        finally:
            _quiet_close(conn, "logout")
    except Exception as e:  # noqa: BLE001
        _emit({"error": _scrub(f"could not read the inbox: {e}",
                               creds.get("app_password"))})
        return 1
    _emit({"address": creds["address"], "count": len(messages), "messages": messages})
    return 0


def cmd_send(a) -> int:
    try:
        creds = _load_creds()
    except AgentMailError as e:
        _emit({"sent": False, "error": str(e)})
        return 1
    to = (a.to or "").strip()
    if not to:
        _emit({"sent": False, "error": "--to is required"})
        return 1
    if not a.subject:
        _emit({"sent": False, "error": "--subject is required"})
        return 1
    try:
        _send_message(creds, to=to, subject=a.subject, body=a.body or "")
    except Exception as e:  # noqa: BLE001
        _emit({"sent": False,
               "error": _scrub(f"the send failed: {e}", creds.get("app_password"))})
        return 1
    _emit({"sent": True, "from": creds["address"], "to": to, "subject": a.subject})
    return 0


def cmd_status(a) -> int:
    if not credential_store.is_connected(SERVICE):
        _emit({"connected": False})
        return 0
    # Non-secret metadata only; never touches the password.
    meta = {}
    for rec in credential_store.listing():
        if rec.get("service") == SERVICE:
            meta = rec.get("meta", {})
            break
    _emit({"connected": True, "address": meta.get("address"),
           "provider": meta.get("provider")})
    return 0


def cmd_read(a) -> int:
    """Fetch recent messages WITH their cleaned body + the sender address and
    Message-ID, so the agent can draft a reply and later thread it correctly."""
    try:
        creds = _load_creds()
    except AgentMailError as e:
        _emit({"error": str(e)})
        return 1
    limit = max(1, int(a.limit))
    try:
        conn = _imap_login(creds["imap_host"], creds["imap_port"],
                           creds["address"], creds["app_password"])
        try:
            conn.select("INBOX")
            typ, data = conn.search(None, "ALL")
            ids = data[0].split() if (typ == "OK" and data and data[0]) else []
            out = []
            for mid in ids[-limit:][::-1]:
                typ, msgdata = conn.fetch(mid, "(BODY.PEEK[])")
                if typ != "OK" or not msgdata or not msgdata[0]:
                    continue
                msg = email.message_from_bytes(msgdata[0][1])
                addr = email.utils.parseaddr(msg.get("From", ""))[1]
                body = _clean_body(_extract_text(msg))
                out.append({
                    "from": _decode_header(msg.get("From")),
                    "from_email": addr,
                    "subject": _decode_header(msg.get("Subject")),
                    "message_id": msg.get("Message-ID", ""),
                    "date": msg.get("Date", ""),
                    "body": body[:4000],
                })
        finally:
            _quiet_close(conn, "logout")
    except Exception as e:  # noqa: BLE001
        _emit({"error": _scrub(f"could not read the inbox: {e}", creds.get("app_password"))})
        return 1
    _emit({"address": creds["address"], "count": len(out), "messages": out})
    return 0


def cmd_reply(a) -> int:
    """Send a clean, threaded reply back to the ORIGINAL sender (the missing
    'send the approved reply' step). Only the agreed body is sent - no quoted
    history, no system/notification metadata. The agent calls this ONLY after the
    user approves the draft. `--cc` supports the 'always CC me' preference."""
    try:
        creds = _load_creds()
    except AgentMailError as e:
        _emit({"sent": False, "error": str(e)})
        return 1
    to = (a.to or "").strip()
    if not to or "@" not in to:
        _emit({"sent": False, "error": "a valid --to (the original sender) is required"})
        return 1
    subject = (a.subject or "").strip()
    if subject and not subject.lower().startswith("re:"):
        subject = "Re: " + subject
    try:
        mid = _send_message(creds, to=to, subject=subject or "Re:", body=a.body or "",
                            cc=(a.cc or None), in_reply_to=(a.in_reply_to or None))
    except Exception as e:  # noqa: BLE001
        _emit({"sent": False, "error": _scrub(f"the reply failed: {e}", creds.get("app_password"))})
        return 1
    _emit({"sent": True, "from": creds["address"], "to": to, "cc": (a.cc or None),
           "subject": subject, "in_reply_to": (a.in_reply_to or None), "message_id": mid})
    return 0


def run(argv) -> int:
    ap = argparse.ArgumentParser(
        prog="agent_mail",
        description="Bring-your-own Agent Mail: give the agent its own inbox (you own it).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("connect", help="verify + store the agent's own mailbox creds")
    c.add_argument("--address", required=True)
    c.add_argument("--app-password", required=True,
                   help="app-specific password (NOT the main account password)")
    c.add_argument("--imap-host")
    c.add_argument("--imap-port")
    c.add_argument("--smtp-host")
    c.add_argument("--smtp-port")
    c.set_defaults(fn=cmd_connect)

    t = sub.add_parser("test", help="send a real self-test email and confirm it lands")
    t.add_argument("--attempts", default=6, help="IMAP delivery checks (default 6)")
    t.add_argument("--delay", default=5, help="seconds between checks (default 5)")
    t.set_defaults(fn=cmd_test)

    i = sub.add_parser("inbox", help="list recent messages for triage")
    i.add_argument("--limit", default=10)
    i.set_defaults(fn=cmd_inbox)

    s = sub.add_parser("send", help="send an email (only after the user approves)")
    s.add_argument("--to", required=True)
    s.add_argument("--subject", required=True)
    s.add_argument("--body", default="")
    s.set_defaults(fn=cmd_send)

    r = sub.add_parser("read", help="fetch recent messages WITH cleaned body + sender + message-id")
    r.add_argument("--limit", default=5)
    r.set_defaults(fn=cmd_read)

    rp = sub.add_parser("reply", help="send a clean threaded reply to the original sender (after approval)")
    rp.add_argument("--to", required=True, help="the original sender's email")
    rp.add_argument("--subject", default="", help="original subject (Re: is added automatically)")
    rp.add_argument("--body", default="")
    rp.add_argument("--cc", default="", help="optional comma-separated CC (e.g. the user's own address)")
    rp.add_argument("--in-reply-to", dest="in_reply_to", default="", help="original Message-ID for threading")
    rp.set_defaults(fn=cmd_reply)

    st = sub.add_parser("status", help="show whether Agent Mail is connected")
    st.set_defaults(fn=cmd_status)

    args = ap.parse_args(argv)
    return args.fn(args)


def main() -> None:
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
