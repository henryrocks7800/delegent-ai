"""Encrypted per-user credential store for Delegent operator skills.

Design rules this enforces (from the operator-skills brief):
  * Secrets are encrypted at rest on the runner's own volume; the plaintext
    NEVER leaves a helper script. The agent can `list()` what is connected
    (service name + non-secret metadata) but cannot read a secret value, so it
    physically cannot echo a credential back into chat.
  * One file per connection under $HERMES_HOME/credentials/, mode 0600.
  * Capability-by-removal friendly: stores the exact granted scopes so a client
    can refuse to attempt anything outside them.

Encryption: Fernet (AES-128-CBC + HMAC) with a key derived (SHA-256) from a
runner-only secret. That secret is an operator-set `DELEGENT_CRED_KEY` if
present; otherwise it is a durable per-runner key the store generates ONCE on
the runner's own volume (`$HERMES_HOME/.delegent_cred_key`, mode 0600) and
reuses across restarts. This means the vault always has a key available to the
agent's subprocesses without ever exposing the runner's HMAC shared secret
(deliberately kept out of the agent's environment), and it never has to refuse
for a "missing key" — it self-provisions the volume key on first use.

This module is intentionally dependency-light (only `cryptography`, already used
elsewhere) and has no side effects on import.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    # POSIX advisory file locking. Present on the Linux runner (the only place
    # the vault actually runs); absent on Windows, where the module must still
    # import for dev/unit tests (it then uses a lock-free atomic fallback).
    import fcntl
except ImportError:  # pragma: no cover - Windows dev only
    fcntl = None  # type: ignore[assignment]

try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception as exc:  # pragma: no cover - surfaced as a clear runtime error
    raise RuntimeError(
        "credential_store requires the 'cryptography' package (cryptography.fernet)"
    ) from exc


class CredentialError(RuntimeError):
    """Raised for any credential-store failure the caller should surface honestly."""


def _store_dir() -> Path:
    home = os.environ.get("HERMES_HOME", "/data/hermes")
    d = Path(home) / "credentials"
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


def _read_key_file(keyfile: Path) -> str:
    """Return the stripped key material, or "" if the file is missing, empty, or
    unreadable. A missing OR empty file both mean "no durable key yet"."""
    try:
        return keyfile.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return ""


def _write_complete_key(home: Path, material: str) -> str:
    """Write `material` to a private 0600 temp file in `home`, fully flushed +
    fsynced, and return its path. The caller publishes it into place with a
    single atomic rename/link so no reader ever observes a half-written file."""
    fd, tmp = tempfile.mkstemp(dir=str(home), prefix=".delegent_cred_key.")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(material)
            fh.flush()
            os.fsync(fh.fileno())
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return tmp


def _provision_key_file(home: Path, keyfile: Path) -> str:
    """Establish the durable per-runner key file and return its material.

    Correctness under concurrency is the whole point here: interactive,
    background, and cron sessions run as SEPARATE, possibly-simultaneous
    subprocesses, and every one of them must end up with the SAME key or a
    credential stored in one session cannot be decrypted in another (the symptom
    was a spurious "not connected" / "cannot decrypt" in cron runs). The previous
    O_EXCL-then-write scheme left a window in which the file existed but was still
    empty, so a concurrent first-use caller (or one that read the file after an
    interrupted first-write) got an EMPTY key and failed.

    Fix: on the runner (fcntl available) we provision under an exclusive advisory
    file lock, so exactly one process ever writes the key and it is written
    COMPLETE (temp file + fsync + atomic rename) before any name is visible. This
    also self-heals a truncated/empty key file left behind by an earlier crash.
    On platforms without fcntl (Windows dev only) we fall back to a lock-free but
    still atomic create-via-hardlink, adopting the winner on a race.
    """
    home.mkdir(parents=True, exist_ok=True)
    material = base64.urlsafe_b64encode(os.urandom(48)).decode("ascii")

    if fcntl is not None:
        lockfile = home / ".delegent_cred_key.lock"
        lock_fd = os.open(str(lockfile), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            # Re-check under the lock: another process may have just provisioned.
            existing = _read_key_file(keyfile)
            if existing:
                return existing
            tmp = _write_complete_key(home, material)
            try:
                # Safe under the exclusive lock: we are the only writer, so this
                # cannot clobber a concurrent valid key, and it atomically
                # replaces a truncated/empty file if one was left behind.
                os.replace(tmp, keyfile)
            finally:
                if os.path.exists(tmp):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
            return material
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(lock_fd)

    # Lock-free fallback (no fcntl): create-if-absent via hardlink, whose target
    # already holds the complete key, so there is no empty window. Loop to adopt
    # the winner if we lose the race.
    for _ in range(8):
        existing = _read_key_file(keyfile)
        if existing:
            return existing
        tmp = _write_complete_key(home, material)
        try:
            os.link(tmp, keyfile)  # atomic; raises if a name already exists
            return material
        except FileExistsError:
            continue  # someone else won; next loop reads their key
        finally:
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
    raise CredentialError("could not establish the credential-vault encryption key")


def _cred_key_material() -> str:
    """The secret the vault's encryption key is derived from.

    Order of preference:
      1. An explicit operator-set key (`DELEGENT_CRED_KEY`), for tests / overrides.
      2. A durable, per-runner key file on the runner's own volume, provisioned
         once on first use (0600) and IDENTICAL across every session. This is what
         makes the vault actually work: the runner's HMAC shared secret is
         deliberately kept OUT of the agent's environment (secret custody, see
         entrypoint.sh), so the vault must have its OWN key that is available to
         the agent yet never leaves the box and survives restarts.
    Never raises for a "missing key": it self-provisions the volume key. The
    provisioning is concurrency-safe (see _provision_key_file) so simultaneous
    first-use sessions all converge on the same key instead of some getting an
    empty one.
    """
    env_key = (os.environ.get("DELEGENT_CRED_KEY") or "").strip()
    if env_key:
        return env_key

    home = Path(os.environ.get("HERMES_HOME", "/data/hermes"))
    keyfile = home / ".delegent_cred_key"

    # Fast path: a fully-written key already exists (the common case after first
    # use). A plain read needs no lock. Empty/truncated -> fall through to heal.
    existing = _read_key_file(keyfile)
    if existing:
        return existing
    return _provision_key_file(home, keyfile)


def _fernet() -> Fernet:
    secret = _cred_key_material()
    if not secret:
        raise CredentialError("could not obtain a credential-vault encryption key")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def _path(service: str) -> Path:
    safe = "".join(c for c in service if c.isalnum() or c in ("-", "_")).lower()
    if not safe:
        raise CredentialError(f"invalid service name: {service!r}")
    return _store_dir() / f"{safe}.cred"


def put(service: str, secret: dict[str, Any], *, scopes: list[str] | None = None,
        meta: dict[str, Any] | None = None) -> None:
    """Encrypt and store the secret blob for `service` (overwrites any existing).

    `secret` is the sensitive payload (tokens, keys). `scopes`/`meta` are stored
    alongside for capability checks + the agent-visible listing.
    """
    record = {
        "service": service,
        "scopes": list(scopes or []),
        "meta": dict(meta or {}),
        "stored_at": int(time.time()),
        "_secret": secret,
    }
    token = _fernet().encrypt(json.dumps(record).encode("utf-8"))
    p = _path(service)
    # Atomic write with restrictive perms.
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".cred-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(token)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def get(service: str) -> dict[str, Any]:
    """Decrypt and return the FULL record incl. `_secret`. For helper scripts
    only — never print the result to the user."""
    p = _path(service)
    if not p.exists():
        raise CredentialError(f"{service} is not connected")
    try:
        raw = _fernet().decrypt(p.read_bytes())
    except InvalidToken as exc:
        raise CredentialError(
            f"cannot decrypt {service} credential (key changed or file corrupt)"
        ) from exc
    return json.loads(raw)


def secret(service: str) -> dict[str, Any]:
    """Just the sensitive payload for `service`."""
    return get(service)["_secret"]


def is_connected(service: str) -> bool:
    return _path(service).exists()


def listing() -> list[dict[str, Any]]:
    """Agent-safe inventory: service + scopes + meta + stored_at, NEVER the
    secret. Safe to show the user ("you've connected: FreeAgent, Gmail")."""
    out: list[dict[str, Any]] = []
    for p in sorted(_store_dir().glob("*.cred")):
        try:
            rec = _fernet().decrypt(p.read_bytes())
            data = json.loads(rec)
            out.append({
                "service": data.get("service"),
                "scopes": data.get("scopes", []),
                "meta": data.get("meta", {}),
                "stored_at": data.get("stored_at"),
            })
        except Exception:
            out.append({"service": p.stem, "error": "unreadable"})
    return out


def remove(service: str) -> bool:
    """Delete a stored credential's `.cred` file (only ever on explicit user
    request). Returns True if a credential was removed, False if there was none.
    This is the canonical name; `delete` is kept as a backwards-compatible alias
    for the existing connect scripts."""
    p = _path(service)
    if p.exists():
        p.unlink()
        return True
    return False


# Backwards-compatible alias (several connect scripts call `credential_store.delete`).
def delete(service: str) -> bool:
    """Deprecated alias for :func:`remove`."""
    return remove(service)


if __name__ == "__main__":  # tiny CLI: list connected services (no secrets)
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        print(json.dumps(listing(), indent=2))
    else:
        print("usage: credential_store.py list")
