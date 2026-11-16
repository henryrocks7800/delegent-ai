#!/usr/bin/env python3
"""Google Calendar connect wizard for the Operations Manager skill - the
one-time human step.

Two agent-mediated steps (a non-technical user authorises in a browser and
pastes a code back into chat; terminal prompts can't be automated):

  start  --client-id ID --client-secret SECRET [--redirect-uri URI]
         Stashes the app credentials ENCRYPTED and prints the Google
         authorisation URL (offline + consent so we get a refresh token) for the
         user to open + approve.

  finish --code CODE_OR_REDIRECT_URL
         Exchanges the code for tokens, stores them ENCRYPTED, then runs a
         VERIFIED test call (GET /users/me/calendarList, expecting the primary
         calendar). Only prints "connected" if that real call succeeds. Clears
         the temporary app-credential stash.

  status   Prints whether the calendar is connected (primary calendar id only,
           no secret).

The user gets client_id/secret from a Google Cloud OAuth client (the SKILL.md
walks them through it). Secrets are never echoed; only non-secret confirmation is
printed.
"""
import argparse
import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path


def _shared(name):
    p = Path(__file__).resolve().parents[3] / "_shared" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, mod)
    spec.loader.exec_module(mod)
    return mod

credential_store = _shared("credential_store")
oauth2 = _shared("oauth2")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import calendar_client as cal  # noqa: E402

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
DEFAULT_REDIRECT = "https://delegentai.co.uk/oauth/google/callback"
PENDING = "google_calendar_pending"  # holds app creds between start + finish


def _cfg_from_pending():
    p = credential_store.secret(PENDING)
    return oauth2.OAuth2Config(
        service=cal.SERVICE, auth_endpoint=AUTH_ENDPOINT, token_endpoint=TOKEN_ENDPOINT,
        client_id=p["client_id"], client_secret=p["client_secret"],
        redirect_uri=p["redirect_uri"], scopes=list(cal.SCOPES),
        # offline + consent so Google returns a refresh token for unattended runs.
        extra_auth_params={"access_type": "offline", "prompt": "consent",
                           "include_granted_scopes": "true"})


def cmd_start(a):
    redirect = a.redirect_uri or DEFAULT_REDIRECT
    credential_store.put(PENDING, {"client_id": a.client_id, "client_secret": a.client_secret,
                                   "redirect_uri": redirect}, meta={"stage": "awaiting_code"})
    cfg = _cfg_from_pending()
    url = oauth2.authorization_url(cfg)
    print(json.dumps({
        "step": "authorise",
        "open_this_url": url,
        "instructions": ("Open this link, sign in to Google and approve calendar access. "
                         "You'll be redirected to a page; the address bar will show "
                         "...?code=XXXX. Copy that code and send it to me."),
    }, indent=2))


def cmd_finish(a):
    code = a.code.strip()
    if "code=" in code:  # accept a full pasted redirect URL too
        code = urllib.parse.parse_qs(urllib.parse.urlparse(code).query).get("code", [code])[0]
    cfg = _cfg_from_pending()
    try:
        oauth2.exchange_code(cfg, code)
    except oauth2.OAuthError as e:
        print(json.dumps({"connected": False, "error": f"could not exchange the code: {e}"}))
        sys.exit(1)
    # VERIFIED test: a real authenticated call before we ever say "connected".
    try:
        primary = cal.primary_calendar()
    except cal.CalendarError as e:
        print(json.dumps({"connected": False, "error": f"token stored but the test call failed: {e}"}))
        sys.exit(1)
    if not primary:
        print(json.dumps({"connected": False,
                          "error": "token works but no primary calendar was returned"}))
        sys.exit(1)
    credential_store.delete(PENDING)
    print(json.dumps({"connected": True, "primary_calendar": primary.get("summary") or primary.get("id"),
                      "verified_with": "GET /users/me/calendarList returned the primary calendar"},
                     indent=2))


def cmd_status(a):
    if not credential_store.is_connected(cal.SERVICE):
        print(json.dumps({"connected": False}))
        return
    try:
        primary = cal.primary_calendar()
        print(json.dumps({"connected": True,
                          "primary_calendar": (primary or {}).get("summary")}))
    except cal.CalendarError as e:
        print(json.dumps({"connected": "stale", "error": str(e)}))


def main():
    ap = argparse.ArgumentParser(description="Google Calendar connect wizard")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start"); s.add_argument("--client-id", required=True)
    s.add_argument("--client-secret", required=True); s.add_argument("--redirect-uri")
    s.set_defaults(fn=cmd_start)
    f = sub.add_parser("finish"); f.add_argument("--code", required=True); f.set_defaults(fn=cmd_finish)
    st = sub.add_parser("status"); st.set_defaults(fn=cmd_status)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
