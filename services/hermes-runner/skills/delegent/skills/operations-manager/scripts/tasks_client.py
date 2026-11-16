"""Scoped Todoist client for the Operations Manager skill.

Capability removal by construction. This client exposes ONLY read +
add/close-task operations the brief needs (list projects, list open tasks, add a
task, close/complete a task). There is deliberately NO delete-task, NO
delete-project, NO permanent-destroy method anywhere in the class, so the agent
is physically incapable of permanently destroying the user's task data even if
instructed to. Closing a task is reversible (it can be reopened in Todoist);
permanent deletion stays a human action done in Todoist's own UI.

Reads come from the live API. The add path (`add_task`) returns the created task
and the caller re-GETs it (see `verify_task`) so success is read back from the
real task state, never assumed from the POST response.

Auth is a personal API token the user pastes once (no OAuth dance); it is stored
encrypted under service "todoist" and only ever read here, never printed.
"""
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

oauth2 = _shared("oauth2")
credential_store = _shared("credential_store")

API_BASE = "https://api.todoist.com/rest/v2"
SERVICE = "todoist"


class TasksError(RuntimeError):
    """A Todoist API failure to surface to the user honestly."""


def _token():
    sec = credential_store.secret(SERVICE)  # never printed
    tok = sec.get("api_token")
    if not tok:
        raise TasksError("no Todoist token stored; reconnect needed")
    return tok


def _auth_headers():
    return {"Authorization": f"Bearer {_token()}", "Accept": "application/json",
            "User-Agent": "Delegent-Operations/1.0"}


def _get(path):
    status, body = oauth2.http_json("GET", f"{API_BASE}{path}", headers=_auth_headers())
    if status == 401 or status == 403:
        raise TasksError(f"the task list rejected the token ({status}); the connection needs refreshing")
    if status >= 400:
        raise TasksError(f"tasks GET {path} -> {status}: {str(body)[:160]}")
    return body


def list_projects():
    """GET /projects - the canonical 'is the connection live' probe.
    Returns a list of {id, name}."""
    body = _get("/projects")
    if not isinstance(body, list):
        raise TasksError(f"unexpected projects payload: {str(body)[:120]}")
    return [{"id": p.get("id"), "name": p.get("name")} for p in body]


def list_open_tasks(*, project_id=None, max_results=50):
    """Read open (active) tasks. Read-only. Returns a list of
    {id, content, due, priority, project_id, url}."""
    path = "/tasks"
    if project_id:
        path += f"?project_id={project_id}"
    body = _get(path)
    if not isinstance(body, list):
        raise TasksError(f"unexpected tasks payload: {str(body)[:120]}")
    out = []
    for t in body[:max_results]:
        due = t.get("due") or {}
        out.append({
            "id": t.get("id"),
            "content": t.get("content"),
            "due": due.get("date") or due.get("datetime"),
            "priority": t.get("priority"),
            "project_id": t.get("project_id"),
            "url": t.get("url"),
        })
    return out


def add_task(*, content, project_id=None, due_string=None, priority=None):
    """Add a task (a light-touch list update) after the user's go-ahead. Returns
    the created task dict (which includes its `id`). The caller MUST verify_task()."""
    payload = {"content": content}
    if project_id:
        payload["project_id"] = project_id
    if due_string:
        payload["due_string"] = due_string
    if priority:
        payload["priority"] = int(priority)
    data = json.dumps(payload).encode("utf-8")
    headers = _auth_headers()
    headers["Content-Type"] = "application/json"
    status, body = oauth2.http_json("POST", f"{API_BASE}/tasks", headers=headers, data=data)
    if status not in (200, 201) or not isinstance(body, dict) or "id" not in body:
        raise TasksError(f"add task failed ({status}): {str(body)[:200]}")
    return body


def close_task(*, task_id):
    """Mark a task complete. Reversible in Todoist (it can be reopened); this is
    NOT a permanent delete. Returns True on a 2xx, then the caller verifies the
    task is no longer in the open list."""
    headers = _auth_headers()
    status, body = oauth2.http_json(
        "POST", f"{API_BASE}/tasks/{task_id}/close", headers=headers, data=b"")
    if status not in (200, 204):
        raise TasksError(f"close task failed ({status}): {str(body)[:160]}")
    return True


def get_task(*, task_id):
    """Fetch a single task by id."""
    return _get(f"/tasks/{task_id}")


def verify_task(created):
    """Real-end-state check: re-GET the task Todoist says it created and confirm
    it exists with the same content. Returns (ok, detail)."""
    task_id = (created or {}).get("id")
    if not task_id:
        return False, "the task list did not return an id for the created task"
    try:
        fetched = get_task(task_id=task_id)
    except TasksError as e:
        return False, f"could not read the task back: {e}"
    if not isinstance(fetched, dict) or not fetched.get("id"):
        return False, "the task does not exist when read back from the task list"
    if (fetched.get("content") or "") != (created.get("content") or ""):
        return False, (f"content mismatch on read-back: created {created.get('content')!r} "
                       f"vs stored {fetched.get('content')!r}")
    return True, f"verified in the task list: {fetched.get('url') or fetched.get('id')}"


def verify_closed(*, task_id):
    """Real-end-state check for a close: confirm the task is gone from the open
    list. Returns (ok, detail)."""
    try:
        open_ids = {t["id"] for t in list_open_tasks(max_results=200)}
    except TasksError as e:
        return False, f"could not confirm the close: {e}"
    if task_id in open_ids:
        return False, "the task is still in the open list; the close did not take"
    return True, "verified: the task is no longer in the open list"
