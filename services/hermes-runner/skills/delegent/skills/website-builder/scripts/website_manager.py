#!/usr/bin/env python3
"""Build, deploy and manage a NEW website for the user — the code-backed engine.

This is the operator-proven flow (it has built + deployed a real live site and
updated it on request):

  * Auth is a Firebase SERVICE ACCOUNT JSON. The user creates a free Firebase
    project and generates a service-account private key in the Firebase Console
    ON A DESKTOP browser (the mobile console HIDES the "Service accounts" tab),
    then pastes the JSON into chat. We do NOT use `firebase login:ci` — it needs
    an interactive browser and fails headless.
  * We install firebase-tools LOCALLY (never `npm install -g`, which EACCEShes on
    the runner) and deploy with the Firebase CLI (not the raw HTTP hosting API —
    the CLI handles gzip + multipart + version finalisation for us).
  * We VERIFY every deploy by curling the live URL: HTTP 200 AND the exact commit
    we deployed must be being served before we ever claim the site is live.

Security (the one hardening over the operator's tested run, which stored the key
as PLAINTEXT): the service-account JSON is stored ENCRYPTED in the central vault
(`_shared/credential_store.py`, the same store the `delegent-keys` CLI drives),
keyed as `firebase-<projectid>`. It is NEVER written to disk in plaintext and
NEVER echoed. At deploy time it is decrypted to a temp file (mode 0600), used as
GOOGLE_APPLICATION_CREDENTIALS for a split second, and DELETED in a finally block
— exactly what `delegent-keys run --service firebase-<id> --file` does.

Subcommands:

  connect --service-account-json <path|->
      Read the pasted service-account JSON (a file path, or "-" for stdin),
      VERIFY it is a well-formed service_account key, and store it ENCRYPTED in
      the vault as `firebase-<projectid>`. The project id + client email come
      from the key itself. Nothing secret is printed.

  build --site-dir DIR [--project ID] [--brief TEXT] [--name NAME] [--force]
      Scaffold (or refresh) a simple static starter site: public/index.html
      (inline CSS), firebase.json and .firebaserc, and an initial git commit so
      the tree can self-identify at deploy time. Idempotent: an existing
      index.html is left alone unless --force.

  deploy --site-dir DIR [--project ID] [--live-url URL]
      Local-install firebase-tools if needed, decrypt the service account to a
      temp file, `firebase deploy --only hosting`, then curl the live URL and
      confirm the deployed commit is really being served. The temp key is deleted
      whether the deploy succeeds or fails. Reports {"deployed": true} ONLY on a
      verified live read-back.

  status [--project ID]
      Whether a Firebase service account is connected (project id + client email
      only, never the key).
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


# --- load shared foundation (the central encrypted vault) --------------------
def _shared(name):
    p = Path(__file__).resolve().parents[3] / "_shared" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, mod)
    spec.loader.exec_module(mod)
    return mod


credential_store = _shared("credential_store")

SERVICE_PREFIX = "firebase-"
# Firebase Hosting deploy only. Recorded on the stored credential so the intent
# is auditable; a service-account key's real capability is set in Google IAM by
# the user (the SKILL.md tells them to grant "Firebase Hosting Admin" only).
REQUESTED_SCOPES = ["firebasehosting.sites.update"]

VERSION_FILE = "public/version.txt"
INDEX_FILE = "public/index.html"
META_MARK = '<meta name="delegent-version" content="'


class WebsiteError(RuntimeError):
    """A website build/deploy failure to surface to the user honestly."""


def _service_for(project_id):
    return f"{SERVICE_PREFIX}{project_id}"


def _resolve_service(project=None):
    """Return (service_name, project_id) for the connected Firebase project.

    If `project` is given, require that exact one is connected. Otherwise
    auto-resolve when exactly one `firebase-*` credential exists; be explicit
    when there are zero or many."""
    if project:
        svc = _service_for(project)
        if not credential_store.is_connected(svc):
            raise WebsiteError(
                f"no Firebase service account is connected for project {project!r}; "
                f"run `connect` first")
        return svc, project
    connected = [item.get("service") for item in credential_store.listing()
                 if str(item.get("service", "")).startswith(SERVICE_PREFIX)]
    if not connected:
        raise WebsiteError("no Firebase service account is connected; run `connect` first")
    if len(connected) > 1:
        projects = ", ".join(s[len(SERVICE_PREFIX):] for s in sorted(connected))
        raise WebsiteError(
            f"multiple Firebase projects are connected ({projects}); pass --project <id>")
    svc = connected[0]
    return svc, svc[len(SERVICE_PREFIX):]


# --- service-account handling (never plaintext, never echoed) ----------------
def _validate_service_account(sa):
    """Verify the pasted blob really is a Firebase/GCP service-account key before
    we claim it is connected. Raises WebsiteError with a plain-English reason."""
    if not isinstance(sa, dict):
        raise WebsiteError("that is not a JSON object; paste the whole service-account file")
    if sa.get("type") != "service_account":
        raise WebsiteError(
            "that JSON is not a service-account key (its \"type\" is not "
            "\"service_account\"). Generate one under Project settings -> Service "
            "accounts -> Generate new private key, on a DESKTOP browser.")
    for field in ("project_id", "private_key", "client_email"):
        if not str(sa.get(field) or "").strip():
            raise WebsiteError(f"the service-account JSON is missing \"{field}\"")
    if "PRIVATE KEY" not in sa["private_key"]:
        raise WebsiteError("the service-account \"private_key\" does not look like a real key")
    return {"project_id": sa["project_id"], "client_email": sa["client_email"]}


def _load_service_account_arg(value):
    """Resolve --service-account-json: "-" = stdin, an existing path = that file,
    otherwise treat the value itself as a JSON string (last resort)."""
    if value == "-":
        raw = sys.stdin.read()
    else:
        p = Path(value)
        raw = p.read_text(encoding="utf-8") if p.exists() else value
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WebsiteError(f"could not parse the service-account JSON: {exc}") from exc


def _stored_sa(project=None):
    """The decrypted service-account dict (helper-only; never printed)."""
    svc, _project = _resolve_service(project)
    return credential_store.secret(svc)


def _write_temp_credentials(sa):
    """Decrypt the service account to a private temp file (mode 0600) and return
    its path. The caller MUST delete it (see _shred_temp) in a finally block."""
    fd, path = tempfile.mkstemp(prefix="gcp-sa-", suffix=".json")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(sa, fh)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _shred_temp(path):
    """Remove the transient decrypted key. Best-effort, never raises."""
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


# --- firebase CLI (installed LOCALLY, not globally) --------------------------
def _tools_dir():
    home = os.environ.get("HERMES_HOME", "/data/hermes")
    return Path(home) / "tools" / "firebase-cli"


def _ensure_firebase_cli():
    """Return the path to a local firebase-tools binary, installing it into a
    per-runner dir if absent. Never `npm install -g` (EACCES on the runner)."""
    toolsdir = _tools_dir()
    binp = toolsdir / "node_modules" / ".bin" / "firebase"
    if binp.exists():
        return str(binp)
    if shutil.which("npm") is None:
        raise WebsiteError("npm is not available on the runner; cannot install firebase-tools")
    toolsdir.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            ["npm", "install", "--prefix", str(toolsdir), "firebase-tools",
             "--no-fund", "--no-audit"],
            capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as exc:
        raise WebsiteError("installing firebase-tools timed out") from exc
    if not binp.exists():
        raise WebsiteError(
            f"local firebase-tools install failed (rc={proc.returncode}): "
            f"{(proc.stderr or proc.stdout or '')[:200]}")
    return str(binp)


def _run_firebase_deploy(site_dir, project, cred_path, firebase_bin):
    """Run the Firebase CLI deploy with the decrypted service account exported as
    GOOGLE_APPLICATION_CREDENTIALS. Returns (rc, combined_output). Equivalent to
    `delegent-keys run --service firebase-<project> --file --var
    GOOGLE_APPLICATION_CREDENTIALS -- <firebase_bin> deploy --only hosting`."""
    env = os.environ.copy()
    env["GOOGLE_APPLICATION_CREDENTIALS"] = cred_path
    cmd = [firebase_bin, "deploy", "--only", "hosting",
           "--project", project, "--non-interactive"]
    try:
        proc = subprocess.run(cmd, cwd=str(site_dir), env=env,
                              capture_output=True, text=True, timeout=900)
    except FileNotFoundError as exc:
        raise WebsiteError("the firebase CLI binary was not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise WebsiteError("the firebase deploy timed out") from exc
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


# --- git + stamping so the live URL can self-identify ------------------------
def _git(args, cwd, check=True):
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise WebsiteError(f"git {' '.join(args)} failed: {proc.stderr.strip()[:160]}")
    return proc.returncode, proc.stdout.strip()


def _commit_hash(site_dir):
    _rc, out = _git(["rev-parse", "HEAD"], site_dir)
    return out


def stamp(site_dir):
    """Write the current git commit hash into the deployed tree so the live URL
    can self-identify, enabling a real read-back after deploy. Returns the hash."""
    site_dir = Path(site_dir)
    public = site_dir / "public"
    if not public.exists():
        raise WebsiteError(f"{public} does not exist; run `build` first")
    h = _commit_hash(site_dir)
    (site_dir / VERSION_FILE).write_text(h + "\n", encoding="utf-8")
    idx = site_dir / INDEX_FILE
    if idx.exists():
        html = idx.read_text(encoding="utf-8", errors="replace")
        meta = f'{META_MARK}{h}">'
        if META_MARK in html:
            start = html.index(META_MARK)
            end = html.index('>', start) + 1
            html = html[:start] + meta + html[end:]
        elif "</head>" in html:
            html = html.replace("</head>", f"  {meta}\n</head>", 1)
        idx.write_text(html, encoding="utf-8")
    return h


# --- verification (curl the live URL; 200 AND expected content required) -----
def fetch_url(url, *, timeout=30):
    """GET a live URL. Returns (status, text). Never raises on a non-2xx so the
    caller can reason about a 404 explicitly (a 404 while the CLI said "success"
    is exactly the case this skill exists to catch)."""
    req = urllib.request.Request(
        url, method="GET",
        headers={"User-Agent": "Delegent-WebsiteBuilder/1.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise WebsiteError(f"could not reach {url}: {e.reason}") from e


def verify_live(live_url, expected_hash, *, path="/version.txt"):
    """THE core rule. Re-read the live URL and require HTTP 200 AND that the exact
    commit we deployed is being served. Returns (ok, detail). A 404, a stale hash,
    or an unreachable URL is an explicit FAILURE, never a silent success."""
    url = live_url.rstrip("/") + path
    status, text = fetch_url(url)
    if status == 404:
        return False, (f"the live URL served 404 for {path}; the deploy did NOT actually "
                       f"go live (the CLI's own 'success' output is not proof)")
    if status != 200:
        return False, f"reading {url} back returned {status}; cannot confirm the site is live"
    served = (text or "").strip().splitlines()[0].strip() if text else ""
    if served != str(expected_hash).strip():
        return False, (f"content mismatch on the live URL: it is serving '{served[:40]}' but we "
                       f"deployed commit '{str(expected_hash)[:40]}'; an OLD build is live")
    return True, f"verified live: {url} returned 200 serving the deployed commit {served[:12]}"


# --- the deploy orchestrator -------------------------------------------------
def deploy_site(site_dir, project=None, live_url=None):
    """Stamp -> local-install CLI if needed -> decrypt SA to a temp file ->
    `firebase deploy` -> delete the temp key (finally) -> verify the live URL.
    Returns a dict; "deployed" is true ONLY on a verified live read-back."""
    site_dir = Path(site_dir)
    if not (site_dir / "firebase.json").exists() or not (site_dir / "public").exists():
        raise WebsiteError(
            f"{site_dir} is not a built site (need public/ + firebase.json); run `build` first")
    sa = _stored_sa(project)
    project_id = sa["project_id"]
    live_url = live_url or f"https://{project_id}.web.app"

    h = stamp(site_dir)

    cred_path = _write_temp_credentials(sa)
    deploy_output = ""
    try:
        firebase_bin = _ensure_firebase_cli()
        rc, deploy_output = _run_firebase_deploy(site_dir, project_id, cred_path, firebase_bin)
    finally:
        # The decrypted key must never outlive the deploy, success or failure.
        _shred_temp(cred_path)

    if rc != 0:
        return {"deployed": False, "stamped_commit": h, "live_url": live_url,
                "error": f"firebase deploy exited {rc}: {deploy_output[:200]}"}

    # NON-NEGOTIABLE: do not trust the CLI's "success" output. Read the live URL
    # back and confirm the exact commit is being served (HTTP 200 + hash match).
    ok, detail = verify_live(live_url, h)
    return {"deployed": ok, "stamped_commit": h, "live_url": live_url,
            "verification": detail}


# --- the starter site scaffold -----------------------------------------------
def _starter_index_html(name, brief):
    """The default starter site (2026-07-23). When the user gives no look or
    feel, produce a genuinely polished, modern page in the Delegent house style
    (warm off-white paper, sage accent, a serif italic display voice, generous
    spacing, light + dark aware) rather than a bare headline. The agent should
    KEEP this look unless the user asks for something different, and replace the
    three starter points below with the business's real ones."""
    title = name or "Your Business"
    tagline = brief or "Quality work, done properly, and a friendly team behind it."
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      --paper:#F5F2EB; --card:#FBF9F4; --ink:#262420; --ink-soft:#6C665A; --ink-faint:#938C7D;
      --line:#E4DDCF; --sage:#5E7361; --sage-deep:#43554A; --sage-ink:#FBF9F4;
      --serif:Georgia,'Iowan Old Style','Times New Roman',serif;
      --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
      --shadow:0 1px 2px rgba(38,36,32,.05),0 10px 28px rgba(38,36,32,.07);
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{ --paper:#1B1A17; --card:#232219; --ink:#ECE7DC; --ink-soft:#A69F90; --ink-faint:#746E61;
        --line:#35332B; --sage:#8FA895; --sage-deep:#A9BFAE; --sage-ink:#1B1A17;
        --shadow:0 1px 2px rgba(0,0,0,.25),0 12px 30px rgba(0,0,0,.4); }}
    }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans);
            line-height:1.6; -webkit-font-smoothing:antialiased; }}
    .wrap {{ max-width:820px; margin:0 auto; padding:clamp(3rem,10vw,6rem) 1.5rem 4rem; }}
    .eyebrow {{ font-size:.8rem; letter-spacing:.16em; text-transform:uppercase; color:var(--sage);
               font-weight:600; margin:0 0 1.1rem; }}
    h1 {{ font-family:var(--serif); font-style:italic; font-weight:400;
          font-size:clamp(2.3rem,6.5vw,3.6rem); line-height:1.08; letter-spacing:-.01em;
          margin:0 0 1rem; text-wrap:balance; }}
    .lede {{ font-size:1.18rem; color:var(--ink-soft); margin:0 0 2rem; max-width:34em; }}
    .cta {{ display:inline-block; background:var(--sage); color:var(--sage-ink); text-decoration:none;
            padding:.85rem 1.5rem; border-radius:999px; font-weight:600; font-size:.98rem;
            transition:transform .15s ease; }}
    .cta:hover {{ transform:translateY(-1px); }}
    .points {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:1rem;
               margin:3.5rem 0 0; }}
    .point {{ background:var(--card); border:1px solid var(--line); border-radius:16px;
              padding:1.4rem 1.5rem; box-shadow:var(--shadow); }}
    .point h3 {{ margin:0 0 .4rem; font-size:1.05rem; letter-spacing:-.01em; }}
    .point p {{ margin:0; color:var(--ink-soft); font-size:.95rem; }}
    footer {{ margin-top:4rem; padding-top:1.5rem; border-top:1px solid var(--line);
              color:var(--ink-faint); font-size:.88rem; }}
  </style>
</head>
<body>
  <main class="wrap">
    <p class="eyebrow">{title}</p>
    <h1>{tagline}</h1>
    <p class="lede">Welcome to {title}. Tell people in a line or two what you do and why they should choose you.</p>
    <a class="cta" href="mailto:hello@example.com">Get in touch</a>
    <!-- Replace these three with the business's real points. -->
    <div class="points">
      <div class="point"><h3>What we do</h3><p>A clear, one-line description of your main service or product.</p></div>
      <div class="point"><h3>Why us</h3><p>The single reason customers pick you: quality, speed, care, price.</p></div>
      <div class="point"><h3>Get started</h3><p>How to reach you or book, in one simple step.</p></div>
    </div>
    <footer>&copy; {title}. Built with Delegent.</footer>
  </main>
</body>
</html>
"""


def _firebase_json():
    return json.dumps({
        "hosting": {
            "public": "public",
            "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
        }
    }, indent=2) + "\n"


def _firebaserc(project):
    return json.dumps({"projects": {"default": project}}, indent=2) + "\n"


def build_site(site_dir, *, project=None, name=None, brief=None, force=False):
    """Scaffold (or refresh) the simple static starter site + firebase config and
    make an initial git commit so the tree self-identifies at deploy time."""
    _svc, project_id = _resolve_service(project)  # need the project id for .firebaserc
    site_dir = Path(site_dir)
    public = site_dir / "public"
    public.mkdir(parents=True, exist_ok=True)

    index = site_dir / INDEX_FILE
    wrote_index = False
    if force or not index.exists():
        index.write_text(_starter_index_html(name, brief), encoding="utf-8")
        wrote_index = True

    (site_dir / "firebase.json").write_text(_firebase_json(), encoding="utf-8")
    (site_dir / ".firebaserc").write_text(_firebaserc(project_id), encoding="utf-8")

    committed = False
    try:
        if not (site_dir / ".git").exists():
            _git(["init"], site_dir, check=False)
        _git(["add", "-A"], site_dir, check=False)
        rc, _ = _git(["commit", "-m", "Scaffold website"], site_dir, check=False)
        committed = rc == 0
    except WebsiteError:
        committed = False

    return {
        "built": True,
        "site_dir": str(site_dir),
        "project": project_id,
        "wrote_index_html": wrote_index,
        "files": ["public/index.html", "firebase.json", ".firebaserc"],
        "committed": committed,
        "next": "Edit public/index.html as you like, then run `deploy`.",
    }


# --- CLI ---------------------------------------------------------------------
def cmd_connect(a):
    try:
        sa = _load_service_account_arg(a.service_account_json)
        meta = _validate_service_account(sa)
    except WebsiteError as e:
        print(json.dumps({"connected": False, "error": str(e)}))
        sys.exit(1)
    credential_store.put(
        _service_for(meta["project_id"]), sa, scopes=REQUESTED_SCOPES,
        meta={"project_id": meta["project_id"], "client_email": meta["client_email"],
              "kind": "service_account"})
    print(json.dumps({
        "connected": True,
        "service": _service_for(meta["project_id"]),
        "project_id": meta["project_id"],
        "client_email": meta["client_email"],
        "stored": "encrypted",
        "verified_with": "service-account key is well-formed; live proof comes at deploy time",
    }, indent=2))


def cmd_build(a):
    try:
        result = build_site(a.site_dir, project=a.project, name=a.name,
                            brief=a.brief, force=a.force)
    except WebsiteError as e:
        print(json.dumps({"built": False, "error": str(e)}))
        sys.exit(1)
    print(json.dumps(result, indent=2))


def cmd_deploy(a):
    try:
        result = deploy_site(a.site_dir, project=a.project, live_url=a.live_url)
    except WebsiteError as e:
        print(json.dumps({"deployed": False, "error": str(e)}))
        sys.exit(1)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("deployed") else 1)


def cmd_status(a):
    try:
        svc, project_id = _resolve_service(a.project)
    except WebsiteError:
        print(json.dumps({"connected": False}))
        return
    meta = credential_store.get(svc).get("meta", {})
    print(json.dumps({
        "connected": True,
        "service": svc,
        "project_id": meta.get("project_id", project_id),
        "client_email": meta.get("client_email"),
    }, indent=2))


def main():
    ap = argparse.ArgumentParser(description="Build, deploy and manage a new website")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("connect", help="verify + store the Firebase service-account JSON (encrypted)")
    c.add_argument("--service-account-json", required=True,
                   help="path to the pasted service-account JSON, or '-' for stdin")
    c.set_defaults(fn=cmd_connect)

    b = sub.add_parser("build", help="scaffold or refresh the starter site")
    b.add_argument("--site-dir", required=True)
    b.add_argument("--project", help="Firebase project id (auto if only one connected)")
    b.add_argument("--brief")
    b.add_argument("--name")
    b.add_argument("--force", action="store_true")
    b.set_defaults(fn=cmd_build)

    d = sub.add_parser("deploy", help="deploy to Firebase Hosting and verify it is live")
    d.add_argument("--site-dir", required=True)
    d.add_argument("--project", help="Firebase project id (auto if only one connected)")
    d.add_argument("--live-url", help="override the live URL (default https://<project>.web.app)")
    d.set_defaults(fn=cmd_deploy)

    st = sub.add_parser("status", help="show the connected Firebase project (never the key)")
    st.add_argument("--project", help="Firebase project id (auto if only one connected)")
    st.set_defaults(fn=cmd_status)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
