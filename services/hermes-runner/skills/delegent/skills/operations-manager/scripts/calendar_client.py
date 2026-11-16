"""Scoped Google Calendar client for the Operations Manager skill.

Capability removal by construction. This client exposes ONLY read +
event-create operations the brief needs (list calendars, list upcoming events,
create a single event after explicit approval). There is deliberately NO
delete, NO cancel, NO clear-calendar, NO batch-delete method anywhere in the
class, so the agent is physically incapable of wiping or destroying calendar
data even if instructed to. Removing or cancelling an event stays a human action
done in the calendar's own UI.

Reads come from the live API. The one create path (`create_event`) returns the
created resource and the caller re-GETs it (see `verify_event`) so success is
read back from the real calendar state, never assumed from the POST response.
"""
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

oauth2 = _shared("oauth2")

API_BASE = "https://www.googleapis.com/calendar/v3"
SERVICE = "google_calendar"

# The exact scopes this client is built around. Note: read + events ONLY.
# It deliberately does NOT request any scope that lets it delete other people's
# calendars or own the account; even the destructive verbs of the events scope
# are unreachable because no method below issues a DELETE.
SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]


class CalendarError(RuntimeError):
    """A Google Calendar API failure to surface to the user honestly."""


def _auth_headers():
    token = oauth2.access_token_for(SERVICE)  # refreshes if expired; never printed
    return {"Authorization": f"Bearer {token}", "Accept": "application/json",
            "User-Agent": "Delegent-Operations/1.0"}


def _get(path):
    status, body = oauth2.http_json("GET", f"{API_BASE}{path}", headers=_auth_headers())
    if status == 401:
        raise CalendarError("the calendar rejected the token (401); the connection needs refreshing")
    if status >= 400:
        raise CalendarError(f"calendar GET {path} -> {status}: {str(body)[:160]}")
    return body


def list_calendars():
    """GET /users/me/calendarList - the canonical 'is the connection live' probe.
    Returns a list of {id, summary, primary}."""
    items = _get("/users/me/calendarList").get("items", [])
    return [{"id": c.get("id"), "summary": c.get("summary"), "primary": bool(c.get("primary"))}
            for c in items]


def primary_calendar():
    """Return the primary calendar dict, or None. Used by the verified test call."""
    for c in list_calendars():
        if c.get("primary"):
            return c
    return None


def upcoming_events(*, calendar_id="primary", time_min, time_max, max_results=25):
    """Read events between two RFC3339 timestamps. Read-only. Returns a list of
    {id, summary, start, end, location, status, html_link}."""
    q = urllib.parse.urlencode({
        "timeMin": time_min,
        "timeMax": time_max,
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": str(max_results),
    })
    cal = urllib.parse.quote(calendar_id, safe="")
    body = _get(f"/calendars/{cal}/events?{q}")
    out = []
    for e in body.get("items", []):
        start = e.get("start", {})
        end = e.get("end", {})
        out.append({
            "id": e.get("id"),
            "summary": e.get("summary"),
            "start": start.get("dateTime") or start.get("date"),
            "end": end.get("dateTime") or end.get("date"),
            "location": e.get("location"),
            "status": e.get("status"),
            "html_link": e.get("htmlLink"),
        })
    return out


def create_event(*, calendar_id="primary", summary, start_iso, end_iso,
                 description=None, location=None):
    """Create a single timed event after explicit user approval. Returns the
    created event dict (which includes its `id`). The caller MUST verify_event()."""
    event = {
        "summary": summary,
        "start": {"dateTime": start_iso},
        "end": {"dateTime": end_iso},
    }
    if description:
        event["description"] = description
    if location:
        event["location"] = location
    cal = urllib.parse.quote(calendar_id, safe="")
    data = json.dumps(event).encode("utf-8")
    headers = _auth_headers()
    headers["Content-Type"] = "application/json"
    status, payload = oauth2.http_json(
        "POST", f"{API_BASE}/calendars/{cal}/events", headers=headers, data=data)
    if status not in (200, 201) or not isinstance(payload, dict) or "id" not in payload:
        raise CalendarError(f"create event failed ({status}): {str(payload)[:200]}")
    return payload


def get_event(*, calendar_id="primary", event_id):
    """Fetch a single event by id."""
    cal = urllib.parse.quote(calendar_id, safe="")
    eid = urllib.parse.quote(event_id, safe="")
    return _get(f"/calendars/{cal}/events/{eid}")


def verify_event(created, *, calendar_id="primary"):
    """Real-end-state check: re-GET the event the calendar says it created and
    confirm it exists with the same summary + start. Returns (ok, detail)."""
    event_id = (created or {}).get("id")
    if not event_id:
        return False, "the calendar did not return an id for the created event"
    try:
        fetched = get_event(calendar_id=calendar_id, event_id=event_id)
    except CalendarError as e:
        return False, f"could not read the event back: {e}"
    if not fetched.get("id"):
        return False, "the event does not exist when read back from the calendar"
    if fetched.get("status") == "cancelled":
        return False, "the event reads back as cancelled, not live"
    if (fetched.get("summary") or "") != (created.get("summary") or ""):
        return False, (f"summary mismatch on read-back: created {created.get('summary')!r} "
                       f"vs stored {fetched.get('summary')!r}")
    cstart = (created.get("start") or {}).get("dateTime")
    fstart = (fetched.get("start") or {}).get("dateTime")
    if cstart and fstart and cstart != fstart:
        return False, f"start-time mismatch on read-back: created {cstart} vs stored {fstart}"
    return True, f"verified in the calendar: {fetched.get('htmlLink') or fetched.get('id')}"
