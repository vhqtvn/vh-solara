#!/usr/bin/env bash
# Materialize the staged SPA (web/dist-build/) into the Go embed dir (pkg/web/dist/).
# SHARED implementation: host-web/scripts/materialize.sh is a thin caller of
# this script and the Makefile clean-web-embed/clean-host-web-embed targets
# use its clean mode, so the clean-then-copy contract cannot drift between
# embed sites.
#
# Clean generated outputs first to avoid stale-asset accumulation across
# repeated local builds. The cleanup removes EVERY top-level dest entry — any
# extension, subdirectories included (the old fixed extension allowlist could
# never remove e.g. a deleted web/public/screenshots/ subdir or a
# non-index *.html; such "ghosts" survived every rebuild and were embedded
# forever) — except the preserved tracked fallback files (default
# placeholder.html, the cold-build fallback banner). Safe on a cold clone
# with empty staging (cp is a no-op; preserved files untouched).
#
# Env overrides (defaults cover all ordinary callers; used by
# pkg/web/materialize_test.go and by callers with a different staging dir,
# e.g. host-web/scripts/deploy-transition-run.sh):
#   VH_MATERIALIZE_STAGING  staging dir        (default <repo>/web/dist-build)
#   VH_MATERIALIZE_DEST     embed dest dir     (default <repo>/pkg/web/dist)
#   VH_MATERIALIZE_PRESERVE space-separated top-level names that survive the
#                           clean (default "placeholder.html"; explicitly set
#                           empty to preserve nothing)
#   VH_MATERIALIZE_CLEAN=1  clean-only mode: remove generated entries, skip
#                           the copy-in (make clean-*-embed)
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
staging="${VH_MATERIALIZE_STAGING-$repo_root/web/dist-build}"
dest="${VH_MATERIALIZE_DEST-$repo_root/pkg/web/dist}"
preserve="${VH_MATERIALIZE_PRESERVE-placeholder.html}"

# Remove every top-level generated entry, preserving the tracked fallbacks.
# `-mindepth 1` keeps the dest dir itself; the per-name `! -name` clauses
# exclude the preserve set (top level only — a preserve name inside a
# removed subdirectory is gone with its parent, as intended).
find_args=()
for name in $preserve; do
  find_args+=(! -name "$name")
done
find "$dest" -mindepth 1 -maxdepth 1 "${find_args[@]}" -exec rm -rf {} +

if [[ "${VH_MATERIALIZE_CLEAN:-0}" != "1" ]]; then
  cp -r "$staging/." "$dest/"
fi
