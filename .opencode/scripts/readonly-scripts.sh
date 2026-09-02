#!/usr/bin/env bash
# Audited read-only gate helper scripts.
# Usage: .opencode/scripts/readonly-scripts.sh <subcommand>
#   gen-uuid       — emit a UUID (uuidgen > python3 > /proc)
#   prep-tempdir   — mkdir -p <git-dir>/commit-gate/ (git dir resolved per
#                    invocation; worktree-safe)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

case "${1:-}" in
  gen-uuid)
    # Prefer uuidgen (allowlisted for the committer), then python3, then /proc
    # last. The command calls live in the if/elif CONDITIONS (not the body) so
    # that a permission denial or absence falls through instead of tripping
    # `set -e`. The /proc read is only a last-resort fallback.
    if command -v uuidgen >/dev/null 2>&1 && uuidgen 2>/dev/null; then
      :
    elif command -v python3 >/dev/null 2>&1 && python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null; then
      :
    elif [ -r /proc/sys/kernel/random/uuid ]; then
      cat /proc/sys/kernel/random/uuid
    else
      echo "gen-uuid: no UUID source available (uuidgen/python3/proc all failed)" >&2
      exit 1
    fi
    ;;
  prep-tempdir)
    # Worktree-safe: a linked worktree's `.git` is a FILE, so the historical
    # REPO_ROOT-relative literal failed ENOTDIR (and, under this script's
    # set -e, killed the caller mid-acquire). Resolve the git dir per
    # invocation — same resolution commit-gate.sh uses, from the same cwd —
    # so the helper and the gate always agree on the same directory. Fall
    # back to the historical literal outside a git repo.
    _gd="$(git rev-parse --git-dir 2>/dev/null || echo ".git")"
    mkdir -p "${_gd}/commit-gate/"
    ;;
  *)
    echo "Usage: $0 {gen-uuid|prep-tempdir}" >&2
    exit 1
    ;;
esac
