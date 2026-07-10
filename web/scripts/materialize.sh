#!/usr/bin/env bash
# Materialize the staged SPA (web/dist-build/) into the Go embed dir (pkg/web/dist/).
# Clean generated outputs first to avoid stale-asset accumulation across repeated
# local builds. The cleanup removes generated artifacts (stale index.html, assets/,
# *.js, *.map, *.webmanifest, icons) but EXPLICITLY preserves the tracked
# pkg/web/dist/placeholder.html (the cold-build fallback banner). Safe on a cold
# clone with empty staging (cp is a no-op; placeholder.html untouched).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
staging="$repo_root/web/dist-build"
dest="$repo_root/pkg/web/dist"
# Remove generated SPA artifacts, preserving the tracked placeholder.html.
rm -rf "$dest/assets" "$dest"/index.html "$dest"/*.js "$dest"/*.map "$dest"/*.webmanifest "$dest"/*.svg "$dest"/*.png 2>/dev/null || true
cp -r "$staging/." "$dest/"
