#!/bin/bash
# Series 4 — golden Hermes runner image verifier.
#
# Builds (unless --skip-build) and contract-checks the local golden image
# produced from services/hermes-runner/Dockerfile.fly. Used:
#  - by `npm run runner:image:test`
#  - by CI before publishing a new image
#  - by operators after bumping HERMES_VERSION in install-hermes.sh
#
# Checks (against a running container, on localhost):
#  1. /healthz returns { ok: true, hermesAvailable: true, workspaceReady: true }
#  2. /healthz reports the expected Hermes version
#  3. /etc/delegent/hermes-image.json exists with the pinned version + commit
#  4. `hermes --version` and `hermes-agent --help` work inside the image
#  5. The image does not contain any of the secret env names that should
#     only ever be injected at Machine create time.
#
# Never starts the container with real provider secrets. Always cleans up.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-delegent-hermes-runner:local}"
# Default the expected Hermes version from install-hermes.sh (the single source of
# truth), so a HERMES_VERSION bump there never drifts from this contract check.
# Still overridable via the HERMES_VERSION env var.
_INSTALL_HERMES="$(dirname "${BASH_SOURCE[0]}")/install-hermes.sh"
_HERMES_VERSION_PINNED="$(grep -oE 'HERMES_VERSION:-v[0-9][^}\"]*' "${_INSTALL_HERMES}" 2>/dev/null | head -1 | sed 's/.*HERMES_VERSION:-//')"
HERMES_VERSION_EXPECTED="${HERMES_VERSION:-${_HERMES_VERSION_PINNED:-v2026.6.5}}"
CONTAINER_NAME="${CONTAINER_NAME:-delegent-hermes-runner-verify}"
HOST_PORT="${HOST_PORT:-18642}"
WORKDIR_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --help|-h)
      cat <<EOF
usage: $0 [--skip-build]
  --skip-build    Re-verify an image that's already built locally as ${IMAGE_TAG}.
env overrides:
  IMAGE_TAG (default: delegent-hermes-runner:local)
  HERMES_VERSION (default: the HERMES_VERSION pinned in install-hermes.sh)
  HOST_PORT (default: 18642)
EOF
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[verify] %s\n' "$*"; }
fail() { printf '[verify] FAIL %s\n' "$*" >&2; exit 1; }

cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cleanup

if [ "${SKIP_BUILD}" != "true" ]; then
  log "building ${IMAGE_TAG} from services/hermes-runner/Dockerfile.fly"
  docker build \
    -f "${WORKDIR_REPO}/services/hermes-runner/Dockerfile.fly" \
    -t "${IMAGE_TAG}" \
    "${WORKDIR_REPO}"
else
  log "skipping build (--skip-build)"
fi

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  fail "image ${IMAGE_TAG} not present locally"
fi

# 1. Run the container with no provider secrets. The runner should still
#    boot and serve /healthz; /health (with HMAC) requires
#    SIDEKICK_RUNNER_SHARED_SECRET so we don't probe that here.
log "starting throwaway container ${CONTAINER_NAME} on host port ${HOST_PORT}"
# Inject the SAME SHAPE of env a real Fly Machine injects, using DUMMY,
# non-secret throwaway values, so the verifier exercises the FULL contract —
# including the Hermes API Server (/v1/runs + /v1/runs/{id}/events SSE) that the
# in-app live tool-call feed depends on. Without these, the API server's
# build_hermes_subprocess_env() throws and the streaming foundation goes
# unverified. No real provider secret is used; nothing is baked into the image
# (the forbidden-secret check below inspects the image's built-in env, not these
# runtime -e flags). We intentionally do NOT override SIDEKICK_WORKSPACE_DIR so
# the image default (/data/hermes/workspace, created + chowned in the Dockerfile)
# is exercised — overriding it to a non-existent path made workspaceReady false.
docker run -d --name "${CONTAINER_NAME}" \
  -p "${HOST_PORT}:8642" \
  -e SIDEKICK_WORKER_PROXY_URL="https://verify-runner.delegentai.co.uk/v1/chat/completions" \
  -e SIDEKICK_RUNNER_SHARED_SECRET="verify_only_dummy_secret_not_real_padding_32b" \
  -e SIDEKICK_USER_ID="00000000-0000-4000-8000-0000000000ab" \
  -e SIDEKICK_ALLOW_UNSIGNED_HEALTH="true" \
  "${IMAGE_TAG}" >/dev/null

# Wait for /healthz
HEALTHZ_URL="http://127.0.0.1:${HOST_PORT}/healthz"
log "waiting for ${HEALTHZ_URL}"
attempt=0
until curl -sf -m 3 "${HEALTHZ_URL}" >/tmp/healthz.json 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 30 ]; then
    log "container logs (tail):"
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -30 >&2
    fail "/healthz did not respond within 30s"
  fi
  sleep 1
done
log "/healthz responded after ${attempt} retries"

# The Hermes API Server (streaming) boots in a background daemon thread and can
# lag the first /healthz by a few seconds. Poll until it reports available (or
# time out) so we assert steady state, not the boot race.
log "waiting for the Hermes API Server (streaming) to report available"
api_attempt=0
until [ "$(python3 -c "import json; print(json.load(open('/tmp/healthz.json')).get('hermesApiServerAvailable'))" 2>/dev/null)" = "True" ]; do
  api_attempt=$((api_attempt + 1))
  if [ "$api_attempt" -gt 40 ]; then
    log "WARNING: Hermes API Server not available after ~40s; last body: $(cat /tmp/healthz.json)"
    break
  fi
  sleep 1
  curl -sf -m 3 "${HEALTHZ_URL}" >/tmp/healthz.json 2>/dev/null || true
done
log "Hermes API Server settled after ${api_attempt} extra polls"

HEALTHZ_BODY="$(cat /tmp/healthz.json)"
log "/healthz body: ${HEALTHZ_BODY}"

# 2. Parse and assert
require_json_eq() {
  local key="$1" want="$2"
  local got
  got="$(python3 -c "import json,sys; print(json.load(open('/tmp/healthz.json')).get('${key}'))" 2>/dev/null || echo '__missing__')"
  if [ "$got" != "$want" ]; then
    fail "/healthz.${key}: expected '${want}', got '${got}'"
  fi
  log "/healthz.${key} = ${got} (ok)"
}

require_json_eq ok True
require_json_eq runner delegent-hermes-runner
require_json_eq hermesAvailable True
require_json_eq workspaceReady True
require_json_eq hermesVersion "${HERMES_VERSION_EXPECTED}"
# The Hermes API Server (/v1/runs SSE) is the foundation for the in-app live
# tool-call feed (Defect D). Verify it actually boots in the golden image so a
# future regression that breaks streaming is caught here, not in production.
require_json_eq hermesApiServerAvailable True

# 3. /etc/delegent/hermes-image.json provenance
log "checking /etc/delegent/hermes-image.json inside container"
docker exec "${CONTAINER_NAME}" cat /etc/delegent/hermes-image.json >/tmp/manifest.json \
  || fail "could not read /etc/delegent/hermes-image.json from container"
log "manifest: $(cat /tmp/manifest.json)"
MANIFEST_VERSION="$(python3 -c "import json; print(json.load(open('/tmp/manifest.json')).get('hermesVersion'))")"
[ "$MANIFEST_VERSION" = "${HERMES_VERSION_EXPECTED}" ] \
  || fail "image manifest hermesVersion '${MANIFEST_VERSION}' != expected '${HERMES_VERSION_EXPECTED}'"
log "manifest version matches: ${MANIFEST_VERSION}"

# 4. hermes / hermes-agent callable inside the image
log "checking hermes --version inside container"
docker exec "${CONTAINER_NAME}" hermes --version >/tmp/hermes-version 2>&1 \
  || { log "hermes --version output:"; cat /tmp/hermes-version >&2; fail "hermes --version failed in container"; }
log "hermes --version: $(tr -d '\n' </tmp/hermes-version)"

log "checking hermes-agent --help inside container"
docker exec "${CONTAINER_NAME}" hermes-agent --help >/dev/null 2>&1 \
  || fail "hermes-agent --help failed in container"
log "hermes-agent --help: ok"

# 4.5 Toolset system prerequisites — parity with upstream Hermes' own image.
# These are the deps our earlier image silently lacked (Node, ripgrep, ffmpeg),
# which degraded file_search / TTS. Assert them so a regression (e.g. a
# base-image bump that drops Node) fails the build HERE, not in a user's runner.
log "checking runtime toolset prerequisites (node, ripgrep, ffmpeg, git)"
docker exec "${CONTAINER_NAME}" sh -c 'command -v node'    >/dev/null 2>&1 || fail "node missing in image"
docker exec "${CONTAINER_NAME}" sh -c 'command -v rg'      >/dev/null 2>&1 || fail "ripgrep (rg) missing in image (fast file_search)"
docker exec "${CONTAINER_NAME}" sh -c 'command -v ffmpeg'  >/dev/null 2>&1 || fail "ffmpeg missing in image (TTS voice messages)"
docker exec "${CONTAINER_NAME}" sh -c 'command -v git'     >/dev/null 2>&1 || fail "git missing in image (dev tasks)"
log "node + ripgrep + ffmpeg + git all present"

# 2026-08-06: the browser assertions are GONE, and their absence is deliberate.
#
# This block used to require Chromium and the agent-browser CLI to be present
# and for the browser toolset's own requirement check to return True. Chromium
# was removed from Dockerfile.fly after checking every assistant message this
# product has ever produced and finding ZERO browser_* invocations. Keeping the
# assertion would now fail every build for a capability we deliberately dropped.
#
# **Chromium must NOT come back by accident**, because its real cost was not the
# install, it was the 2 GB RAM floor it forced onto every tier. So assert the
# opposite: the image should be browser-free, and a base image or upstream
# change that quietly reinstates it should fail here rather than silently double
# everyone's memory bill again.
log "asserting the image is browser-free (Chromium was removed 2026-08-06; see Dockerfile.fly)"
if docker exec "${CONTAINER_NAME}" test -d /opt/playwright 2>/dev/null; then
  fail "/opt/playwright exists — Chromium is back in the image. It was removed deliberately: it is unused (zero browser_* calls ever) and it forces a 2 GB RAM floor on every tier. If this is intentional, update Dockerfile.fly, this check, and DEFAULT_COMPUTE_TIER_BY_PLAN together."
fi
log "image is browser-free, as intended"

# 4.5b web_search lazy dep — Hermes gates web_search behind Feature
# 'search.firecrawl' (tools/lazy_deps.py) and its RUNTIME pip install cannot
# take effect inside the running gateway ("packages still not importable").
# The package must be importable at boot or web_search is dead in production
# (live 2026-07-22). Assert it here so a Hermes bump or a dropped bake step
# fails the build, not the user's research task.
log "asserting firecrawl (web_search lazy dep) is importable in the image"
FIRECRAWL_OK="$(docker exec "${CONTAINER_NAME}" python3 -c 'import firecrawl; print("True")' 2>/tmp/firecrawl-check.err || true)"
if [ "${FIRECRAWL_OK}" != "True" ]; then
  log "firecrawl check stderr:"; cat /tmp/firecrawl-check.err >&2 || true
  fail "firecrawl import failed — web_search would be dead in production"
fi
log "firecrawl import check: True (web_search will work)"

# 4.6 Security hardening — the offensive "red-teaming" skill bundle that Hermes
# ships upstream (godmode / auto_jailbreak / parseltongue; "bypass safety filters
# on GPT, Claude, Gemini, Grok") MUST be pruned from a consumer image. The
# Dockerfile.fly red-team remediation removes it; assert it here so a Hermes bump
# that re-introduces it (or a dropped prune step) fails the build, not production.
log "asserting offensive red-teaming/godmode skill is pruned from the image"
if docker exec "${CONTAINER_NAME}" test -d /opt/hermes-agent/skills/red-teaming; then
  fail "offensive red-teaming/godmode skill present at /opt/hermes-agent/skills/red-teaming — must be pruned (see Dockerfile.fly)"
fi
log "red-teaming/godmode skill absent from image (ok)"

# 4.7 Route B — the `delegent` gateway platform plugin must be bundled,
# discovered by the gateway plugin scanner, and contract-correct against the
# real Hermes base classes (durable per-user session key, inbound routing,
# outbound send/edit). See docs/CHAT_ROUTE_B_DESIGN.md.
log "asserting the delegent in-app chat platform is bundled + discovered"
if ! docker exec "${CONTAINER_NAME}" test -f /opt/hermes-agent/plugins/platforms/delegent/adapter.py; then
  fail "delegent platform plugin missing from /opt/hermes-agent/plugins/platforms/delegent (Dockerfile COPY)"
fi
DELEGENT_DISCOVERED="$(docker exec "${CONTAINER_NAME}" python3 -c 'from gateway.config import Platform; print("delegent" in Platform._scan_bundled_plugin_platforms())' 2>/tmp/delegent-disc.err || true)"
if [ "${DELEGENT_DISCOVERED}" != "True" ]; then
  cat /tmp/delegent-disc.err >&2 || true
  fail "delegent platform NOT discovered by the gateway plugin scanner (got '${DELEGENT_DISCOVERED}')"
fi
log "delegent platform discovered; running its contract test in-image"
if ! docker exec "${CONTAINER_NAME}" python3 /opt/hermes-agent/plugins/platforms/delegent/test_delegent_adapter.py; then
  fail "delegent adapter contract test failed in-image"
fi
log "delegent platform: discovered + contract test passed (durable per-user session, inbound/outbound ok)"

# 4.8 Route B streaming bridge — the runner-wrapper side (per-run delta queue +
# /v1/delegent/ingest + the SSE drain in the BAKED server.py). Copy the bridge
# contract test into the running container and exercise it against the shipping
# /app/server.py via an in-process ASGI client (no Durable Object). See
# docs/CHAT_ROUTE_B_DESIGN.md §2 (Outbound, streaming).
log "running the delegent streaming-bridge contract test against the baked server.py"
docker cp "${WORKDIR_REPO}/services/hermes-runner/test_delegent_bridge.py" \
  "${CONTAINER_NAME}:/app/test_delegent_bridge.py" \
  || fail "could not copy test_delegent_bridge.py into the container"
if ! docker exec \
    -e PYTHONPYCACHEPREFIX=/tmp/pyc \
    -e SIDEKICK_HERMES_API_DISABLED=true \
    -e DELEGENT_PLATFORM_SECRET=bridge_test_secret \
    -w /app "${CONTAINER_NAME}" python3 /app/test_delegent_bridge.py; then
  fail "delegent streaming-bridge contract test failed against baked server.py"
fi
log "delegent streaming bridge: ingest -> per-run queue -> SSE drain ok (close-on-done + idle-close)"

# 4.9 Route B session-reset policy — the runner-seeded config.yaml must make the
# REAL gateway loader set the durable session to never auto-reset (mode='none'),
# else the weeks/months memory is wiped after 24h idle / daily. Guards the
# loader quirk that `session_reset` (default policy) is read from config.yaml but
# `reset_by_platform` is not. See docs/CHAT_ROUTE_B_DESIGN.md Phase 3.
log "validating the delegent durable session never auto-resets (mode: none) via the real loader"
docker cp "${WORKDIR_REPO}/services/hermes-runner/test_delegent_reset_policy.py" \
  "${CONTAINER_NAME}:/app/test_delegent_reset_policy.py" \
  || fail "could not copy test_delegent_reset_policy.py into the container"
if ! docker exec \
    -e PYTHONPYCACHEPREFIX=/tmp/pyc \
    -e SIDEKICK_HERMES_API_DISABLED=true \
    -w /app "${CONTAINER_NAME}" python3 /app/test_delegent_reset_policy.py; then
  fail "delegent reset-policy validation failed (durable session would auto-reset)"
fi
log "delegent session reset policy: mode='none' honored by the gateway loader (weeks/months memory)"

# 4.9b Curated skills reach the agent's `skills` tool. The skills tool only reads
# skills under HERMES_HOME/skills; our library is baked at /opt/delegent/skills.
# `_seed_delegent_skills` mirrors it into HERMES_HOME/skills/delegent/ on launch so
# the agent actually discovers skills like autonomous-bookkeeper (instead of
# improvising its own approach). Guards the 2026-06-17 skills-wiring fix.
log "validating the curated Delegent skills seed into HERMES_HOME/skills/delegent (skills-tool discovery)"
docker cp "${WORKDIR_REPO}/services/hermes-runner/test_delegent_skills_seed.py" \
  "${CONTAINER_NAME}:/app/test_delegent_skills_seed.py" \
  || fail "could not copy test_delegent_skills_seed.py into the container"
if ! docker exec \
    -e PYTHONPYCACHEPREFIX=/tmp/pyc \
    -e SIDEKICK_HERMES_API_DISABLED=true \
    -w /app "${CONTAINER_NAME}" python3 /app/test_delegent_skills_seed.py; then
  fail "delegent skills seed validation failed (skills tool would not see the curated library)"
fi
log "delegent skills seed: curated library mirrored into the skills-tool read path"

# 4.10 Home-dir -> workspace mapping (lost-files defect, 2026-06-11). The agent's
# `~` is ephemeral container disk; a user's hello-world saved to ~/Documents was
# destroyed on the next machine stop and never visible in the app's Files tab.
# The runner must symlink ~/Documents (+Downloads/Pictures/Desktop/Notes and the
# lowercase set) onto the workspace at boot, so a home-dir write IS a durable,
# app-visible workspace write.
log "asserting ~/Documents et al. are symlinked onto the workspace (lost-files guard)"
if ! docker exec "${CONTAINER_NAME}" bash -lc '
  set -e
  for name in Documents Downloads Pictures Desktop Notes documents downloads pictures notes uploads code; do
    test -L "/home/delegent/${name}" || { echo "MISSING LINK: ~/${name}"; exit 1; }
  done
  target="$(readlink -f /home/delegent/Documents)"
  case "${target}" in
    /data/hermes/workspace/*) ;;
    *) echo "~/Documents resolves OUTSIDE the workspace: ${target}"; exit 1 ;;
  esac
  echo "probe" > /home/delegent/Documents/.verify-home-link-probe
  test -f /data/hermes/workspace/documents/.verify-home-link-probe || { echo "write via ~/Documents did NOT land in the workspace"; exit 1; }
  rm -f /data/hermes/workspace/documents/.verify-home-link-probe
  # The AGENT'\''S home: Hermes injects HOME=$HERMES_HOME/home into tool
  # subprocesses whenever that dir exists, so the same mapping must be there.
  test -d /data/hermes/home || { echo "MISSING: \$HERMES_HOME/home (agent tool-home)"; exit 1; }
  test -L /data/hermes/home/Documents || { echo "MISSING LINK: \$HERMES_HOME/home/Documents"; exit 1; }
  agent_target="$(readlink -f /data/hermes/home/Documents)"
  case "${agent_target}" in
    /data/hermes/workspace/*) ;;
    *) echo "agent ~/Documents resolves OUTSIDE the workspace: ${agent_target}"; exit 1 ;;
  esac
'; then
  fail "home-dir -> workspace mapping broken (user files saved via ~ would be lost + invisible)"
fi
log "home-dir mapping ok: ~/Documents writes land on the durable, app-visible workspace"

# 5. No customer/provider secrets baked into the image
log "checking image env for forbidden secret names"
IMAGE_ENV="$(docker image inspect "${IMAGE_TAG}" --format '{{range .Config.Env}}{{println .}}{{end}}')"
FORBIDDEN_PATTERNS=(
  '^FLY_API_TOKEN='
  '^STRIPE_SECRET_KEY='
  '^STRIPE_WEBHOOK_SECRET='
  '^OPENROUTER_API_KEY='
  '^SUPABASE_SERVICE_ROLE_KEY='
  '^RAILWAY_API_TOKEN='
  '^SIDEKICK_TELEGRAM_BOT_TOKEN='
  '^SIDEKICK_RUNNER_SHARED_SECRET=.+'
)
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  if printf '%s\n' "${IMAGE_ENV}" | grep -E -q "${pattern}"; then
    fail "forbidden secret env baked into image: matches ${pattern}"
  fi
done
log "no forbidden secrets present in image env"

echo
log "GOLDEN IMAGE PASSED CONTRACT CHECKS"
log "  image:    ${IMAGE_TAG}"
log "  hermes:   ${HERMES_VERSION_EXPECTED} (matches manifest)"
log "  healthz:  ok / hermesAvailable=true / workspaceReady=true"
log "  stream:   Hermes API Server (/v1/runs SSE) boots + reports available"
log "  cli:      hermes --version + hermes-agent --help both succeed"
log "  secrets:  none of FLY_API_TOKEN, STRIPE_*, OPENROUTER_*, etc. baked in"
