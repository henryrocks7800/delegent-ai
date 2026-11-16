"""Scoped FreeAgent API client for the Bookkeeper skill.

Capability removal by construction: this client exposes ONLY the read +
create-expense operations the skill needs. There is deliberately NO delete, NO
update, NO "approve/file VAT return", NO bank-deletion method anywhere in the
class, so the agent is physically incapable of a destructive or irreversible
FreeAgent action even if instructed to. Filing with HMRC stays a human action
done in FreeAgent's own UI.

Every create call returns the created resource and the caller is expected to
re-GET it (see verify_expense) so success is read back from FreeAgent's real
state, never assumed from the POST response.
"""
import base64
import importlib.util
import json
import sys
from pathlib import Path

# --- load shared foundation (encrypted credential store + oauth2) ------------
def _shared(name):
    p = Path(__file__).resolve().parents[3] / "_shared" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, mod)
    spec.loader.exec_module(mod)
    return mod

oauth2 = _shared("oauth2")

API_BASE = "https://api.freeagent.com/v2"
SERVICE = "freeagent"


class FreeAgentError(RuntimeError):
    """A FreeAgent API failure to surface to the user honestly."""


def _auth_headers():
    token = oauth2.access_token_for(SERVICE)  # refreshes if expired; never printed
    return {"Authorization": f"Bearer {token}", "Accept": "application/json",
            "User-Agent": "Delegent-Bookkeeper/1.0"}


def _get(path):
    status, body = oauth2.http_json("GET", f"{API_BASE}{path}", headers=_auth_headers())
    if status == 401:
        raise FreeAgentError("FreeAgent rejected the token (401); the connection needs refreshing")
    if status >= 400:
        raise FreeAgentError(f"FreeAgent GET {path} -> {status}: {str(body)[:160]}")
    return body


def company():
    """GET /company — the canonical 'is the connection actually live' probe."""
    return _get("/company").get("company", {})


def list_expense_categories():
    """Categories the user can file an expense against (URL + description)."""
    cats = _get("/categories").get("admin_expenses_categories", [])
    return [{"url": c.get("url"), "description": c.get("description")} for c in cats]


def list_users():
    return [{"url": u.get("url"), "email": u.get("email"),
             "name": f"{u.get('first_name','')} {u.get('last_name','')}".strip()}
            for u in _get("/users").get("users", [])]


def create_expense(*, user_url, category_url, dated_on, gross_value, description,
                   currency="GBP", attachment=None):
    """Create an expense. `attachment`, if given, is a dict:
    {data: bytes, content_type: str, file_name: str}. Returns the created
    expense dict (which includes its `url`). The caller MUST verify_expense()."""
    expense = {
        "user": user_url,
        "category": category_url,
        "dated_on": dated_on,
        "gross_value": str(gross_value),
        "currency": currency,
        "description": description,
    }
    if attachment:
        expense["attachment"] = {
            "data": base64.b64encode(attachment["data"]).decode("ascii"),
            "content_type": attachment["content_type"],
            "file_name": attachment["file_name"],
            "description": "receipt",
        }
    body = json.dumps({"expense": expense}).encode("utf-8")
    headers = _auth_headers()
    headers["Content-Type"] = "application/json"
    status, payload = oauth2.http_json("POST", f"{API_BASE}/expenses", headers=headers, data=body)
    if status not in (200, 201) or not isinstance(payload, dict) or "expense" not in payload:
        raise FreeAgentError(f"create expense failed ({status}): {str(payload)[:200]}")
    return payload["expense"]


def get_expense(url):
    """Fetch a single expense by its full FreeAgent URL."""
    path = url[len(API_BASE):] if url.startswith(API_BASE) else url
    return _get(path).get("expense", {})


def verify_expense(created):
    """Real-end-state check: re-GET the expense FreeAgent says it created and
    confirm it exists with the same amount. Returns (ok, detail)."""
    url = (created or {}).get("url")
    if not url:
        return False, "FreeAgent did not return a URL for the created expense"
    try:
        fetched = get_expense(url)
    except FreeAgentError as e:
        return False, f"could not read the expense back: {e}"
    if not fetched.get("url"):
        return False, "the expense does not exist when read back from FreeAgent"
    if str(fetched.get("gross_value")) != str(created.get("gross_value")):
        return False, (f"amount mismatch on read-back: created {created.get('gross_value')} "
                       f"vs stored {fetched.get('gross_value')}")
    return True, f"verified in FreeAgent: {fetched.get('url')} for {fetched.get('gross_value')} {fetched.get('currency')}"
