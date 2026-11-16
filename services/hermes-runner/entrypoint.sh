#!/usr/bin/env bash
# Secret custody (defect hunt 2026-06-10).
#
# Fly injects SIDEKICK_RUNNER_SHARED_SECRET into this process's environment,
# and anything in a process's EXEC-TIME environment is readable by any
# same-uid process via /proc/<pid>/environ -- including the semi-trusted
# Hermes agent, which runs arbitrary shell as the same user. So before the
# server starts we move the secret out of the environment and onto an
# inherited file descriptor:
#
#   1. exec 3<<<"$SECRET"   puts the secret on fd 3 (an unlinked temp file).
#   2. exec env -u ...      REPLACES this process image with uvicorn, with
#                           the secret REMOVED from the exec-time env block
#                           (so /proc/<server pid>/environ never contains it).
#   3. server.py reads fd 3 exactly once at import and closes it, keeping
#      the secret in process memory only. A runtime os.environ write is not
#      reflected back into the /proc environ block.
#
# The agent subprocess env is separately allowlisted
# (build_hermes_subprocess_env), so no child re-inherits the secret either.
# Residual risk: same-uid ptrace where yama ptrace_scope=0; documented in
# SECURITY.md.
set -euo pipefail

if [ -n "${SIDEKICK_RUNNER_SHARED_SECRET:-}" ]; then
  exec 3<<<"${SIDEKICK_RUNNER_SHARED_SECRET}"
  exec env -u SIDEKICK_RUNNER_SHARED_SECRET SIDEKICK_RUNNER_SHARED_SECRET_FD=3 \
    uvicorn server:app --host 0.0.0.0 --port "${PORT:-8642}"
fi

exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8642}"
