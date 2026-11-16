#!/usr/bin/env python3
"""Todoist connect wizard for the Operations Manager skill - the one-time human
step. Todoist uses a personal API token (no OAuth dance), so this is a single
agent-mediated step: the user pastes the token, we store it ENCRYPTED and run a
VERIFIED test call before ever saying "connected".

  connect  --token TOKEN
           Stores the token ENCRYPTED (service "todoist"), then runs a VERIFIED
           test call (GET /projects, expecting HTTP 200 + a project list). Only
           prints "connected" if that real call succeeds; on failure the token is
           removed again so a bad token never sticks around.

  status   Prints whether tasks are connected (project count only, no secret).

The user gets the token from https://todoist.com/app/settings/integrations/developer
(the SKILL.md walks them through it). The token is never echoed; only non-secret
confirmation is printed.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path


def _shared(name):
    p = Path(__file__).resolve().parents[3] / "_shared" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, mod)
    spec.loader.exec_module(mod)
    return mod

credential_store = _shared("credential_store")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tasks_client as tk  # noqa: E402


def cmd_connect(a):
    token = a.token.strip()
    if not token:
        print(json.dumps({"connected": False, "error": "empty token"}))
        sys.exit(1)
    # Store first (encrypted) so the verified call uses the exact stored value,
    # then prove it works; remove it again if the proof fails.
    credential_store.put(tk.SERVICE, {"api_token": token},
                         meta={"auth": "personal_token"})
    try:
        projects = tk.list_projects()
    except tk.TasksError as e:
        credential_store.delete(tk.SERVICE)
        print(json.dumps({"connected": False,
                          "error": f"token did not work; removed it again: {e}"}))
        sys.exit(1)
    print(json.dumps({"connected": True, "project_count": len(projects),
                      "verified_with": "GET /projects returned 200 with a project list"},
                     indent=2))


def cmd_status(a):
    if not credential_store.is_connected(tk.SERVICE):
        print(json.dumps({"connected": False}))
        return
    try:
        projects = tk.list_projects()
        print(json.dumps({"connected": True, "project_count": len(projects)}))
    except tk.TasksError as e:
        print(json.dumps({"connected": "stale", "error": str(e)}))


def main():
    ap = argparse.ArgumentParser(description="Todoist connect wizard")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("connect"); c.add_argument("--token", required=True)
    c.set_defaults(fn=cmd_connect)
    st = sub.add_parser("status"); st.set_defaults(fn=cmd_status)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
