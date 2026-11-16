"""Access tokens for services the user signed into on the Connections screen.

The sibling of `oauth2.py`, and the difference is where the sign-in lives.
`oauth2.py` holds a refresh token in this machine's own vault, which is right
for a credential the user typed in. A Connections sign-in is deliberately NOT
held here: the agent runs arbitrary code as this user, so a refresh token on
this box would be a refresh token the agent could hand out. It is kept off the
machine and we borrow an access token good for minutes, per call.

`access_token_for(service)` returns that token, or None when the user has not
connected this service, so a skill script can try here first and fall back to
the vault without knowing which route the user took.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

_TIMEOUT_SECONDS = 30


def _local_base() -> str:
    base = (os.environ.get('OPENAI_BASE_URL') or os.environ.get('HERMES_MODEL_BASE_URL') or '').strip()
    if base:
        return base.rstrip('/')
    port = (os.environ.get('PORT') or '8642').strip()
    return f'http://127.0.0.1:{port}/v1'


def _local_key() -> str | None:
    key = (os.environ.get('OPENAI_API_KEY') or os.environ.get('HERMES_API_KEY') or '').strip()
    return key or None


def _call(path: str, payload: dict | None) -> tuple[int, dict]:
    key = _local_key()
    if not key:
        return 0, {}
    request = urllib.request.Request(
        f'{_local_base()}{path}',
        data=json.dumps(payload).encode('utf-8') if payload is not None else None,
        headers={'content-type': 'application/json', 'authorization': f'Bearer {key}'},
        method='POST' if payload is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            return response.status, json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b'{}')
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}


def connected_services() -> list[dict]:
    status, body = _call('/delegent/connections', None)
    if status != 200:
        return []
    connections = body.get('connections')
    return connections if isinstance(connections, list) else []


def is_connected(service: str) -> bool:
    return any(c.get('provider') == service and c.get('status') == 'connected' for c in connected_services())


def access_token_for(service: str) -> str | None:
    """A short-lived access token, or None when this route does not have the
    service. Never print the return value."""
    status, body = _call('/delegent/connections/token', {'provider': service})
    if status != 200:
        return None
    token = body.get('accessToken')
    return token if isinstance(token, str) and token else None
