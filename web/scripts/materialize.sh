#!/usr/bin/env bash
# Materialize the staged SPA (web/dist-build/) into the Go embed dir (pkg/web/dist/).
# Clean generated outputs first to avoid stale-asset accumulation across repeated
# local builds; preserve the tracked pkg/web/dist/index.html placeholder.
# Safe on a cold clone with empty staging (cp is a no-op; index.html untouched).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
staging="$repo_root/web/dist-build"
dest="$repo_root/pkg/web/dist"
rm -rf "$dest/assets" "$dest"/*.js "$dest"/*.map "$dest"/*.webmanifest 2>/dev/null || true
cp -r "$staging/." "$dest/"
