#!/bin/bash
# Series 4 — pinned, reproducible Hermes Agent install.
#
# Used at Docker build time by services/hermes-runner/Dockerfile.fly to bake
# Hermes into the "golden" runner image. Customer Machines boot from the
# image and skip this entirely.
#
# The install is intentionally explicit:
#  - one source: github.com/NousResearch/hermes-agent
#  - one tag:    HERMES_VERSION below (overridable via env for development)
#  - one tool:   uv (Hermes's documented package manager)
#  - one verify: `hermes --version` must succeed; the build fails otherwise.
#
# This script must be idempotent within a single image build; re-running it
# inside an existing layer must produce the same result.
set -euo pipefail

# --- Pinned source ----------------------------------------------------------
# Bumping HERMES_VERSION requires rebuilding + republishing the golden image
# and is a Series 4 migration decision; see docs/releases/SERIES_4_FLY_MACHINES.md.
HERMES_REPO_URL="${HERMES_REPO_URL:-https://github.com/NousResearch/hermes-agent.git}"
# DELIBERATELY HELD at v2026.7.20 (v0.19.0 Quicksilver). Reviewed 2026-08-18,
# decision: do not upgrade yet. Head is v2026.8.16.2 (v0.20.3), which is ~9,000
# commits and ~2,600 merged PRs away. Three specific reasons, not general caution:
#
#  1. approvals.mode is safety-critical here and its DEFAULT already moved once.
#     server.py forces 'manual' because v0.19.0 made 'smart' the default, where an
#     auxiliary LLM auto-approves "low-risk" commands. If that config shape moved
#     again the gate could stop routing to the user and the agent would run
#     destructive commands without asking. That must be proven, not assumed.
#  2. v0.20.3 ships "subprocess Python runtime ownership hardening
#     (PYTHONHOME/PYTHONPATH isolation)". The document toolchain (reportlab,
#     xhtml2pdf) runs as a subprocess, so this could break PDF authoring, which
#     is a flagship bookkeeping feature.
#  3. v0.20.1/.2/.3 are UNDOCUMENTED by the maintainers' own admission - their
#     notes say curated detail "will ship with v0.21.0". That is ~1,180 PRs of
#     unwritten-up change.
#
# WHEN TO REVISIT: after iOS is live and the marketing push has settled, ideally
# once v0.21.0 exists so the intervening windows are actually documented. The
# upgrade is not a version bump: it needs a golden-image rebuild, a green
# `npm run regression -- --release`, a repin, and a re-image of every user runner.
HERMES_VERSION="${HERMES_VERSION:-v2026.7.20}"
HERMES_SRC_DIR="${HERMES_SRC_DIR:-/opt/hermes-agent}"
HERMES_EXTRAS="${HERMES_EXTRAS:-all}"
UV_VERSION="${UV_VERSION:-0.5.20}"

log() { printf '[install-hermes] %s\n' "$*"; }

log "pinned source: ${HERMES_REPO_URL}"
log "pinned version: ${HERMES_VERSION}"
log "extras: [${HERMES_EXTRAS}]"
log "uv: ${UV_VERSION}"

# --- uv install -------------------------------------------------------------
# Hermes's documented installer uses uv. Install a pinned uv into the system
# Python so `uv pip install --system` resolves Hermes's dependency tree the
# way the upstream maintainers expect.
log "installing uv==${UV_VERSION}"
pip install --no-cache-dir --quiet "uv==${UV_VERSION}"
uv --version

# --- Hermes source ----------------------------------------------------------
# Clone exactly the tag; no shallow clone of a moving branch.
if [ -d "${HERMES_SRC_DIR}/.git" ]; then
  log "hermes source already present at ${HERMES_SRC_DIR}; pulling tag"
  git -C "${HERMES_SRC_DIR}" fetch --depth 1 origin "tag" "${HERMES_VERSION}"
  git -C "${HERMES_SRC_DIR}" checkout --quiet "tags/${HERMES_VERSION}"
else
  log "cloning ${HERMES_REPO_URL} @ ${HERMES_VERSION} -> ${HERMES_SRC_DIR}"
  rm -rf "${HERMES_SRC_DIR}"
  git clone --depth 1 --branch "${HERMES_VERSION}" "${HERMES_REPO_URL}" "${HERMES_SRC_DIR}"
fi

# Pin the exact commit SHA so it's recorded in the image and `hermes --version`
# output can be cross-checked against it later.
HERMES_COMMIT="$(git -C "${HERMES_SRC_DIR}" rev-parse HEAD)"
log "resolved commit: ${HERMES_COMMIT}"

# --- Install Hermes + extras ------------------------------------------------
# `uv pip install --system` writes to the system Python (matches what Hermes's
# own installer does on a fresh box). The Docker base image is a single-purpose
# image so a venv would just add a layer of indirection.
log "installing hermes-agent==${HERMES_VERSION} with [${HERMES_EXTRAS}] extras"
cd "${HERMES_SRC_DIR}"
uv pip install --system --no-cache --quiet -e ".[${HERMES_EXTRAS}]"

# --- Bake lazy optional deps the product depends on -------------------------
# Hermes resolves web_search through Feature 'search.firecrawl'
# (tools/lazy_deps.py) and attempts a RUNTIME `uv pip install` on first use.
# Inside the running gateway process that install can never take effect
# ("install reported success but packages still not importable (may require
# Python restart)") — live 2026-07-22, web_search dead in production. Bake the
# package at image build so the feature is importable from boot. Pin matches
# tools/lazy_deps.py in the pinned Hermes version above.
log "baking firecrawl-py (web_search lazy dep)"
uv pip install --system --no-cache --quiet "firecrawl-py==4.17.0"

# --- Install Hermes Node deps (browser tools) -------------------------------
# Hermes' `browser` toolset shells out to the `agent-browser` CLI declared in
# the cloned repo's package.json ("agent-browser" + "@askjo/camofox-browser").
# Upstream's own install/Dockerfile runs `npm install` for exactly this; our
# prior golden image skipped the entire Node side, so `_find_agent_browser()`
# found nothing and the browser toolset was silently dropped at requirement
# check time. Node itself is provided by Dockerfile.fly (build + runtime
# stages). We install only the top-level deps (the agent-browser CLI) — not
# web/ or ui-tui/ (the dashboard + TUI we do not ship). The resulting
# node_modules/ lives under ${HERMES_SRC_DIR} and is carried into the runtime
# image by the Dockerfile's `COPY --from=hermes-installer /opt/hermes-agent`.
log "installing hermes node deps (agent-browser CLI) via npm — node $(node --version)"
npm install --prefer-offline --no-audit --no-fund
AGENT_BROWSER_BIN="${HERMES_SRC_DIR}/node_modules/.bin/agent-browser"
if [ ! -x "${AGENT_BROWSER_BIN}" ]; then
  log "ERROR: agent-browser CLI missing after npm install — browser toolset would not load" >&2
  ls -la "${HERMES_SRC_DIR}/node_modules/.bin/" 2>/dev/null | head -20 >&2 || true
  exit 1
fi
log "agent-browser CLI present: ${AGENT_BROWSER_BIN}"

# --- Record provenance ------------------------------------------------------
# Write a tiny manifest the runner FastAPI wrapper can read at /healthz so we
# can prove (a) which Hermes version is baked into the image and (b) the
# image was built from this script — not from a hand-edited Fly VM.
mkdir -p /etc/delegent
cat > /etc/delegent/hermes-image.json <<JSON
{
  "hermesVersion": "${HERMES_VERSION}",
  "hermesCommit": "${HERMES_COMMIT}",
  "hermesRepo": "${HERMES_REPO_URL}",
  "extras": "${HERMES_EXTRAS}",
  "installedBy": "services/hermes-runner/scripts/install-hermes.sh",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
log "wrote provenance to /etc/delegent/hermes-image.json"

# --- Smoke-check the install ------------------------------------------------
# Fail the build loudly if Hermes is not callable. The whole point of the
# golden-image model is to catch this at build time, not at customer
# provisioning time.
log "verifying hermes is callable"
if ! hermes --version >/tmp/hermes-version 2>&1; then
  log "ERROR: 'hermes --version' failed" >&2
  cat /tmp/hermes-version >&2 || true
  exit 1
fi
log "hermes --version: $(tr -d '\n' </tmp/hermes-version)"

# `hermes-agent --help` is the closer-to-runtime command path; check it boots.
if ! hermes-agent --help >/dev/null 2>&1; then
  log "ERROR: 'hermes-agent --help' failed" >&2
  exit 1
fi
log "hermes-agent --help: ok"

log "install complete"
