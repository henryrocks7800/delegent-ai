#!/usr/bin/env python3
"""Pull the user's connected blocks into one prioritised brief - READ ONLY.

The operations manager's "what needs my attention" view. It reads from whatever
the user has connected and never writes anything:

  * Inbox: REUSED from the safe-inbox-manager skill's `gmail_client.py` IF that
    skill is present and Gmail is connected. We import it lazily and degrade
    gracefully (a clear "inbox not connected" note) if it is missing, so this
    skill works standalone too.
  * Calendar: upcoming events from this skill's `calendar_client.py`.
  * Tasks: open tasks from this skill's `tasks_client.py`.

Output is a single JSON brief that the agent turns into prose: what is due, what
is slipping, and what needs a decision. The script does the deterministic
gathering + simple, explainable prioritisation; the agent does the judgement and
the talking. NOTHING here mutates a list, a calendar, an inbox, or a task.

Subcommands:
  brief [--days N] [--max-emails N]   Build the combined prioritised brief.
  sources                             Report which blocks are connected.
"""
import argparse
import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
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
import calendar_client as cal  # noqa: E402
import tasks_client as tk  # noqa: E402


# --- inbox: reuse the safe-inbox-manager skill's client if it is installed ----
def _load_gmail_client():
    """Best-effort import of the sibling safe-inbox-manager skill's gmail_client.
    Returns the module or None (skill absent / not importable). Read-only use."""
    skills_dir = Path(__file__).resolve().parents[2]  # .../skills/
    candidate = skills_dir / "safe-inbox-manager" / "scripts" / "gmail_client.py"
    if not candidate.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("gmail_client", candidate)
        mod = importlib.util.module_from_spec(spec)
        # Make the shared loader path resolve for the imported client too.
        sys.path.insert(0, str(candidate.parent))
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def _now():
    return datetime.now(timezone.utc)


def _rfc3339(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _gather_inbox(max_emails):
    """Return (status, items). status is one of connected/not-connected/unavailable/error."""
    gmail = _load_gmail_client()
    if gmail is None:
        return "unavailable", []  # the inbox skill is not installed on this box
    service = getattr(gmail, "SERVICE", "gmail")
    if not credential_store.is_connected(service):
        return "not-connected", []
    # Use whatever read entrypoint the inbox client exposes, without assuming a
    # specific signature, so we stay decoupled from that skill's internals. The
    # current safe-inbox-manager exposes list_messages(query, max_results).
    fn = None
    for name in ("list_messages", "recent_messages", "list_recent", "unread",
                 "list_unread", "inbox"):
        if hasattr(gmail, name):
            fn = getattr(gmail, name)
            break
    if fn is None:
        return "unavailable", []
    # Try the richest call we can, degrading on signature mismatch. Read-only.
    attempts = [
        lambda: fn(query="newer_than:7d", max_results=max_emails),
        lambda: fn(max_results=max_emails),
        lambda: fn(),
    ]
    items = None
    last_err = None
    for call in attempts:
        try:
            items = call()
            break
        except TypeError as e:
            last_err = e
            continue
        except Exception as e:  # a real API failure - surface honestly
            return "error", [{"error": str(e)[:160]}]
    if items is None:
        return "error", [{"error": f"could not call the inbox reader: {last_err}"}]
    return "connected", list(items or [])[:max_emails]


def _gather_calendar(days):
    if not credential_store.is_connected(cal.SERVICE):
        return "not-connected", []
    try:
        events = cal.upcoming_events(
            time_min=_rfc3339(_now()),
            time_max=_rfc3339(_now() + timedelta(days=days)),
            max_results=25)
    except cal.CalendarError as e:
        return "error", [{"error": str(e)[:160]}]
    return "connected", events


def _gather_tasks():
    if not credential_store.is_connected(tk.SERVICE):
        return "not-connected", []
    try:
        tasks = tk.list_open_tasks(max_results=100)
    except tk.TasksError as e:
        return "error", [{"error": str(e)[:160]}]
    return "connected", tasks


def _parse_date(value):
    """Parse an RFC3339 / date string to an aware datetime, or None."""
    if not value:
        return None
    v = str(value).strip()
    try:
        if v.endswith("Z"):
            v = v[:-1] + "+00:00"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        # Date-only (all-day): treat as start-of-day UTC.
        try:
            dt = datetime.strptime(v[:10], "%Y-%m-%d")
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _prioritise(calendar_items, task_items):
    """Build an explainable due/slipping/decisions split. Read-only over inputs."""
    now = _now()
    due_soon = []     # within 48h
    slipping = []     # past due (tasks only - a past calendar event is just history)
    decisions = []    # things that look like they need a human call

    for ev in calendar_items:
        start = _parse_date(ev.get("start"))
        if start is None:
            continue
        if now <= start <= now + timedelta(hours=48):
            due_soon.append({"kind": "event", "what": ev.get("summary"),
                             "when": ev.get("start"), "link": ev.get("html_link")})

    for t in task_items:
        due = _parse_date(t.get("due"))
        item = {"kind": "task", "what": t.get("content"), "when": t.get("due"),
                "priority": t.get("priority"), "link": t.get("url")}
        if due is not None and due < now:
            slipping.append(item)
        elif due is not None and due <= now + timedelta(hours=48):
            due_soon.append(item)
        # High-priority Todoist tasks (priority 4 == p1) read as "needs a decision".
        if t.get("priority") == 4:
            decisions.append({"kind": "task", "what": t.get("content"),
                              "why": "flagged top priority", "link": t.get("url")})

    # Stable, explainable ordering: soonest first.
    due_soon.sort(key=lambda x: (_parse_date(x.get("when")) or now))
    slipping.sort(key=lambda x: (_parse_date(x.get("when")) or now))
    return {"due_soon": due_soon, "slipping": slipping, "needs_decision": decisions}


def cmd_brief(a):
    inbox_status, inbox_items = _gather_inbox(a.max_emails)
    cal_status, cal_items = _gather_calendar(a.days)
    task_status, task_items = _gather_tasks()
    priorities = _prioritise(cal_items, task_items)
    brief = {
        "generated_at": _rfc3339(_now()),
        "window_days": a.days,
        "read_only": True,
        "sources": {
            "inbox": inbox_status,
            "calendar": cal_status,
            "tasks": task_status,
        },
        "inbox": inbox_items,
        "upcoming_events": cal_items,
        "open_tasks": task_items,
        "priorities": priorities,
    }
    print(json.dumps(brief, indent=2, default=str))


def cmd_sources(a):
    gmail = _load_gmail_client()
    inbox = "unavailable"
    if gmail is not None:
        svc = getattr(gmail, "SERVICE", "gmail")
        inbox = "connected" if credential_store.is_connected(svc) else "not-connected"
    print(json.dumps({
        "inbox": inbox,
        "calendar": "connected" if credential_store.is_connected(cal.SERVICE) else "not-connected",
        "tasks": "connected" if credential_store.is_connected(tk.SERVICE) else "not-connected",
        "connected_services": [r.get("service") for r in credential_store.listing()],
    }, indent=2))


def main():
    ap = argparse.ArgumentParser(description="Read-only operations brief")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("brief")
    b.add_argument("--days", type=int, default=7)
    b.add_argument("--max-emails", type=int, default=10)
    b.set_defaults(fn=cmd_brief)
    sub.add_parser("sources").set_defaults(fn=cmd_sources)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
