#!/usr/bin/env python3
"""FreeAgent connect wizard for the Bookkeeper skill — the one-time human step.

Two agent-mediated steps (a non-technical user authorises in a browser and pastes
a code back into chat; terminal prompts can't be automated):

  start  --client-id ID --client-secret SECRET [--redirect-uri URI]
         Stashes the app credentials ENCRYPTED and prints the FreeAgent
         authorisation URL for the user to open + approve.

  finish --code CODE_OR_REDIRECT_URL
         Exchanges the code for tokens, stores them ENCRYPTED, then runs a
         VERIFIED test call (GET /company). Only prints "connected" if that
         real call succeeds. Clears the temporary app-credential stash.

  status   Prints whether FreeAgent is connected (company name only, no secret).

The user gets client_id/secret by creating a free FreeAgent API app at
https://dev.freeagent.com (the SKILL.md walks them through it). Secrets are never
echoed; only non-secret confirmation is printed.
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
import freeagent_client as fa  # noqa: E402

AUTH_ENDPOINT = "https://api.freeagent.com/v2/approve_app"
TOKEN_ENDPOINT = "https://api.freeagent.com/v2/token_endpoint"
DEFAULT_REDIRECT = "https://delegentai.co.uk/oauth/freeagent/callback"
PENDING = "freeagent_pending"  # holds app creds between start + finish


def _cfg_from_pending():
    p = credential_store.secret(PENDING)
    return oauth2.OAuth2Config(
        service="freeagent", auth_endpoint=AUTH_ENDPOINT, token_endpoint=TOKEN_ENDPOINT,
        client_id=p["client_id"], client_secret=p["client_secret"],
        redirect_uri=p["redirect_uri"], scopes=[])


def cmd_start(a):
    redirect = a.redirect_uri or DEFAULT_REDIRECT
    credential_store.put(PENDING, {"client_id": a.client_id, "client_secret": a.client_secret,
                                   "redirect_uri": redirect}, meta={"stage": "awaiting_code"})
    cfg = _cfg_from_pending()
    url = oauth2.authorization_url(cfg)
    print(json.dumps({
        "step": "authorise",
        "open_this_url": url,
        "instructions": ("Open this link, sign in to FreeAgent and approve access. "
                         "You'll be redirected to a page with a code (or the address bar "
                         "will show ...?code=XXXX). Copy that code and send it to me."),
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
        co = fa.company()
    except fa.FreeAgentError as e:
        print(json.dumps({"connected": False, "error": f"token stored but the test call failed: {e}"}))
        sys.exit(1)
    credential_store.delete(PENDING)
    print(json.dumps({"connected": True, "company": co.get("name"),
                      "verified_with": "GET /company succeeded"}, indent=2))


def cmd_status(a):
    if not credential_store.is_connected("freeagent"):
        print(json.dumps({"connected": False}))
        return
    try:
        co = fa.company()
        print(json.dumps({"connected": True, "company": co.get("name")}))
    except fa.FreeAgentError as e:
        print(json.dumps({"connected": "stale", "error": str(e)}))


def main():
    ap = argparse.ArgumentParser(description="FreeAgent connect wizard")
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
