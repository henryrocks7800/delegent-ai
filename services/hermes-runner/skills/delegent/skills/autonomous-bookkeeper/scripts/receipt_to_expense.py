#!/usr/bin/env python3
"""Create a FreeAgent expense from receipt details the agent already extracted,
then VERIFY it exists in FreeAgent before reporting success.

The agent does the judgement (reading the receipt photo/PDF from uploads/ with its
vision/OCR tools, picking the category); this script does the deterministic,
verifiable mechanics. Ambiguity (no category, unclear amount) is the agent's job
to resolve with the user FIRST — this script fails loudly on missing inputs
rather than guessing.

Subcommands:
  categories                 list expense categories (url + description)
  users                      list FreeAgent users (url + name) to attribute to
  create  --dated-on YYYY-MM-DD --gross 42.50 --description "..."
          --category-url URL [--user-url URL] [--attachment /path/to/receipt]
          [--currency GBP]
      Creates the expense (attaching the receipt file if given), then re-GETs it
      from FreeAgent and only reports {"created": true} if the read-back matches.
"""
import argparse
import json
import mimetypes
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import freeagent_client as fa  # noqa: E402


def cmd_categories(a):
    print(json.dumps(fa.list_expense_categories(), indent=2))


def cmd_users(a):
    print(json.dumps(fa.list_users(), indent=2))


def cmd_create(a):
    attachment = None
    if a.attachment:
        p = Path(a.attachment)
        if not p.exists():
            print(json.dumps({"created": False, "error": f"attachment not found: {a.attachment}"}))
            sys.exit(2)
        attachment = {"data": p.read_bytes(),
                      "content_type": mimetypes.guess_type(p.name)[0] or "application/octet-stream",
                      "file_name": p.name}
    user_url = a.user_url
    if not user_url:
        users = fa.list_users()
        if not users:
            print(json.dumps({"created": False, "error": "no FreeAgent users found to attribute the expense to"}))
            sys.exit(2)
        user_url = users[0]["url"]
    try:
        created = fa.create_expense(
            user_url=user_url, category_url=a.category_url, dated_on=a.dated_on,
            gross_value=a.gross, description=a.description, currency=a.currency,
            attachment=attachment)
    except fa.FreeAgentError as e:
        print(json.dumps({"created": False, "error": str(e)}))
        sys.exit(1)
    # Non-negotiable: confirm the real end state in FreeAgent, do not trust the POST.
    ok, detail = fa.verify_expense(created)
    print(json.dumps({"created": ok, "expense_url": created.get("url"),
                      "verification": detail,
                      "attached_receipt": bool(attachment)}, indent=2))
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser(description="Receipt -> verified FreeAgent expense")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("categories").set_defaults(fn=cmd_categories)
    sub.add_parser("users").set_defaults(fn=cmd_users)
    c = sub.add_parser("create")
    c.add_argument("--dated-on", required=True)
    c.add_argument("--gross", required=True)
    c.add_argument("--description", required=True)
    c.add_argument("--category-url", required=True)
    c.add_argument("--user-url")
    c.add_argument("--attachment")
    c.add_argument("--currency", default="GBP")
    c.set_defaults(fn=cmd_create)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
