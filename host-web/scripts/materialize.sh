#!/usr/bin/env bash
# Materialize the staged host shell (host-web/dist/) into the Go embed dir
# (pkg/web/host-dist/). Thin caller of the shared web/scripts/materialize.sh —
# the clean-then-copy implementation lives in ONE place; this wrapper only
# supplies the host paths and the same tracked fallback preserve set
# (pkg/web/host-dist/placeholder.html is the cold-build fallback banner).
# Caller-provided VH_MATERIALIZE_* overrides pass through (tests/special
# callers); unset ones default to the host values here.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
export VH_MATERIALIZE_STAGING="${VH_MATERIALIZE_STAGING-$repo_root/host-web/dist}"
export VH_MATERIALIZE_DEST="${VH_MATERIALIZE_DEST-$repo_root/pkg/web/host-dist}"
export VH_MATERIALIZE_PRESERVE="${VH_MATERIALIZE_PRESERVE-placeholder.html}"
exec bash "$repo_root/web/scripts/materialize.sh"
