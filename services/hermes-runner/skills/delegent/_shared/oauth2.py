"""Reusable OAuth2 authorization-code helper for Delegent operator skills.

Used by any skill connecting a service that speaks OAuth2 auth-code (FreeAgent,
Google/Gmail, ...). Built around the brief's "one-time human connection" rule:
the flow is TWO agent-mediated steps because a non-technical user authorises in a
browser and pastes a code back into chat (terminal prompts cannot be automated):

  1. authorization_url(cfg)  -> the agent shows the user the link to click.
  2. exchange_code(cfg, code) -> exchange for tokens, store ENCRYPTED via
     credential_store, then the caller MUST run a verified test call before
     telling the user "connected".

Token refresh (refresh_access_token / access_token_for) keeps later API calls
working without re-consent. HTTP uses urllib (stdlib) so there is no new runtime
dependency. Secrets are only ever handled here / in credential_store, never
printed.

Note: no `from __future__ import annotations` here on purpose — these modules are
loaded dynamically (module_from_spec) by skill scripts, and string annotations +
@dataclass need the module in sys.modules to resolve, which dynamic loads skip.
Real annotations (Python 3.10+) sidestep that.
"""
import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import importlib.util
from pathlib import Path

# Load the sibling credential store without requiring a package install.
_cs_spec = importlib.util.spec_from_file_location(
    "credential_store", Path(__file__).resolve().parent / "credential_store.py")
credential_store = importlib.util.module_from_spec(_cs_spec)
_cs_spec.loader.exec_module(credential_store)


class OAuthError(RuntimeError):
    """OAuth failure the caller should surface to the user honestly."""


@dataclass
class OAuth2Config:
    service: str                 # credential_store key, e.g. "freeagent"
    auth_endpoint: str
    token_endpoint: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scopes: list[str] = field(default_factory=list)
    # Some providers (Google) need extra auth params for refresh tokens.
    extra_auth_params: dict[str, str] = field(default_factory=dict)


def http_json(method: str, url: str, *, headers: dict[str, str] | None = None,
              data: bytes | None = None, timeout: int = 30) -> tuple[int, Any]:
    """Minimal JSON-ish HTTP. Returns (status, parsed_body_or_text). Never raises
    on a non-2xx; the caller inspects the status so failures are explicit."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.getcode()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    except urllib.error.URLError as e:
        raise OAuthError(f"network error calling {url}: {e.reason}") from e
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


def authorization_url(cfg: OAuth2Config, state: str = "delegent") -> str:
    params = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "state": state,
    }
    if cfg.scopes:
        params["scope"] = " ".join(cfg.scopes)
    params.update(cfg.extra_auth_params)
    return f"{cfg.auth_endpoint}?{urllib.parse.urlencode(params)}"


def _post_token(cfg: OAuth2Config, form: dict[str, str]) -> dict[str, Any]:
    body = urllib.parse.urlencode(form).encode("utf-8")
    status, payload = http_json(
        "POST", cfg.token_endpoint,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        data=body)
    if status != 200 or not isinstance(payload, dict) or "access_token" not in payload:
        raise OAuthError(f"token endpoint returned {status}: {str(payload)[:200]}")
    return payload


def exchange_code(cfg: OAuth2Config, code: str) -> dict[str, Any]:
    """Exchange an auth code for tokens and STORE them encrypted. Returns the
    non-secret summary (scopes + expiry); does NOT return the tokens."""
    tok = _post_token(cfg, {
        "grant_type": "authorization_code",
        "code": code.strip(),
        "redirect_uri": cfg.redirect_uri,
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
    })
    _store_tokens(cfg, tok)
    return {"service": cfg.service, "scopes": cfg.scopes,
            "expires_in": tok.get("expires_in"), "has_refresh": bool(tok.get("refresh_token"))}


def _store_tokens(cfg: OAuth2Config, tok: dict[str, Any]) -> None:
    expires_at = int(time.time()) + int(tok.get("expires_in", 3600)) - 60  # 60s safety
    secret = {
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token"),
        "expires_at": expires_at,
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
        "token_endpoint": cfg.token_endpoint,
    }
    credential_store.put(cfg.service, secret, scopes=cfg.scopes,
                         meta={"token_endpoint": cfg.token_endpoint})


def refresh_access_token(service: str) -> str:
    """Refresh + persist a service's access token. Returns the new access token
    (for internal use only)."""
    sec = credential_store.secret(service)
    if not sec.get("refresh_token"):
        raise OAuthError(f"{service} has no refresh token; reconnect needed")
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": sec["refresh_token"],
        "client_id": sec["client_id"],
        "client_secret": sec["client_secret"],
    }).encode("utf-8")
    status, payload = http_json(
        "POST", sec["token_endpoint"],
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        data=body)
    if status != 200 or not isinstance(payload, dict) or "access_token" not in payload:
        raise OAuthError(f"refresh failed ({status}): {str(payload)[:160]}")
    sec["access_token"] = payload["access_token"]
    sec["expires_at"] = int(time.time()) + int(payload.get("expires_in", 3600)) - 60
    if payload.get("refresh_token"):
        sec["refresh_token"] = payload["refresh_token"]
    rec = credential_store.get(service)
    credential_store.put(service, sec, scopes=rec.get("scopes"), meta=rec.get("meta"))
    return sec["access_token"]


def access_token_for(service: str) -> str:
    """Return a valid access token for `service`, refreshing if expired. Internal
    use only (never print)."""
    sec = credential_store.secret(service)
    if int(sec.get("expires_at", 0)) <= int(time.time()):
        return refresh_access_token(service)
    return sec["access_token"]
