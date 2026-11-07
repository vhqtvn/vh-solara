#!/usr/bin/env bash
# Build the SPA, then serve it via the real aggregator + web server backed by
# the fake OpenCode fixtures. Used as the Playwright webServer (fixture lane)
# and runnable directly for manual browser checks.
#
# ── Local boot-cost cache (test-speed plan, slice 5) ──────────────────────
# With CI/GITHUB_ACTIONS unset, two per-invocation boot costs are cached under
# tmp/.fixture-cache/ (gitignored; tmp/ is repo-scoped scratch that nothing
# wipes automatically — a manual wipe merely forces one cold rebuild. npm-managed
# dirs are deliberately avoided: `npm ci` would erase them):
#   spa.stamp            inputs+outputs hashes guarding web/dist-build reuse
#   fixtureserver        prebuilt ./tools/fixtureserver binary (no more `go run`)
#   fixtureserver.gosha  hash of the Go module inputs guarding the binary reuse
# The stamp lives in tmp/.fixture-cache/, NOT inside web/dist-build/ —
# materialize.sh does `cp -r staging/.` and would leak it into pkg/web/dist/
# (and from there into the go:embed binary).
# Reuse is hash-guarded: any change to the SPA build inputs (web/src tree,
# web/index.html, web/public, package.json + package-lock.json, vite/tsconfig
# configs, web/scripts/{materialize,fixture-web}.sh), to the module's non-test
# Go sources (+ go.mod/go.sum), OR to the materialized SPA content itself
# forces the matching rebuild. Content hashes, not mtimes: immune to
# git-checkout/touch mtime lies, and conservative in the other direction
# (fixtureserver imports nearly the whole module anyway). The binary cache key
# includes the materialized pkg/web/dist hash because the server serves the
# SPA from //go:embed dist (pkg/web/server.go) — FROZEN at compile time — so
# an SPA-only edit must rebuild the binary, not just dist-build. (host-dist is
# also embedded but never served by the fixtureserver — it calls
# SetHostShellAtRoot(false), tools/fixtureserver/main.go — and is deliberately
# not hashed to avoid pointless rebuilds on host-shell changes.) The
# dist-build OUTPUT hash additionally detects out-of-band corruption of the
# cached build (e.g. a truncated asset) and rebuilds instead of silently
# serving a broken SPA — cost: one sha256 pass over ~7 MB of build output per
# warm start (measured tens of ms; see slice-5 report). Stamp/binary writes
# are atomic (write temp + rename) because two lane-6 configs can start
# concurrently.
#
# CI PR-blocking runs stay fresh-built FOREVER — hard invariant, not a
# preference: when CI or GITHUB_ACTIONS is set, this script takes the legacy
# path verbatim (npm build + materialize + `go run`) and reads/writes NO
# cache. VH_FIXTURE_FRESH=1 is the manual full-bypass/debug escape locally
# (forces both rebuilds; still refreshes the cache so the next run is warm
# again). There is deliberately no VH_FIXTURE_REUSE opt-in: local-default
# reuse, bypass is the escape — keep the surface minimal.
set -euo pipefail

ADDR="${VH_FIXTURE_ADDR:-127.0.0.1:8099}"

web_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$web_dir/.." && pwd)"

cache_dir="$repo_root/tmp/.fixture-cache"
spa_stamp="$cache_dir/spa.stamp"
srv_bin="$cache_dir/fixtureserver"
srv_stamp="$cache_dir/fixtureserver.gosha"

# The consolidated demo project dir MUST be a real writable path on disk (the
# attach-upload handler writes <dir>/.vh-solara/sessions/<id>/attachments). The
# fixtureserver creates it and repoints the Go fixture at it; the TS test
# harness computes the SAME repo-relative path (playwright.config.ts) so both
# agree. Overridable via VH_DEMO_DIR.
export VH_DEMO_DIR="${VH_DEMO_DIR:-$repo_root/tmp/fixture-demo}"
# Demo quota for the Usage panel is baked into fixtureserver (VH_QUOTA_FIXTURE);
# export it here only to override.
#
# Opt-in daemon dispatch (queue-delivery-custody lane): VH_FIXTURE_DAEMON_DISPATCH=1
# forwards the fixtureserver's existing -daemon-dispatch flag so the daemon's
# custody drain loop owns queue dispatch (browser observe-only). DEFAULT
# UNCHANGED: unset/0 keeps the browser-dispatch posture the ordinary lane-6
# suite runs under (no extra flag is passed — behaviorally identical).
extra_args=""
if [[ "${VH_FIXTURE_DAEMON_DISPATCH:-0}" == "1" ]]; then
  extra_args="-daemon-dispatch"
  echo "[fixture-web] daemon dispatch ENABLED (queue custody active)"
fi

# CI invariant: PR-blocking runs are ALWAYS fresh-built — no cache reads, no
# cache writes, behavior identical to the pre-cache script (npm build +
# materialize + `go run`).
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "[fixture-web] CI detected (CI=${CI:-<unset>} GITHUB_ACTIONS=${GITHUB_ACTIONS:-<unset>}) → fresh build, cache untouched"
  echo "[fixture-web] building SPA…"
  # Build output is NOT silenced: the vite build is a real slice of lane-6 boot
  # cost that was previously invisible (redirected to /dev/null), so timing the
  # e2e lane was impossible to attribute (see docs/ai/test-runtime-budget.md).
  (cd "$web_dir" && npm run build)
  echo "[fixture-web] materializing staged SPA into pkg/web/dist…"
  bash "$web_dir/scripts/materialize.sh"
  echo "[fixture-web] starting fixture server on $ADDR (go run: fresh compile, CI path)"
  cd "$repo_root"
  exec go run ./tools/fixtureserver -addr "$ADDR" $extra_args
fi

# ── Local path: hash-guarded reuse (default) ─────────────────────────────
fresh="${VH_FIXTURE_FRESH:-0}"
mkdir -p "$cache_dir"

# fingerprint <dir>: sha256 of the file list arriving on stdin (one relative
# path per line, sorted here; hashes names + contents into one digest).
# Callers guard the no-whitespace-filename constraint (a blank inside a name
# would corrupt the xargs split → unstable hash): the input lists abort loudly
# on [[:blank:]] before reaching this. node_modules is never an input.
fingerprint() {
  ( cd "$1" && LC_ALL=C sort | LC_ALL=C xargs -r sha256sum | sha256sum | cut -c1-64 )
}

no_blank_names() { # $1=list $2=what (error text)
  if grep -qE '[[:blank:]]' <<<"$1"; then
    echo "[fixture-web] ERROR: $2 filename contains whitespace — refusing to fingerprint (unstable hash)" >&2
    exit 1
  fi
}

# SHA of the current build output tree; empty when web/dist-build is absent
# (cold clone) — empty is treated as a cache miss.
spa_out_now() {
  if [[ -d "$web_dir/dist-build" ]]; then
    (cd "$web_dir" && LC_ALL=C find dist-build -type f | fingerprint "$web_dir")
  fi
}

spa_files="$(cd "$web_dir" && LC_ALL=C find src index.html public package.json package-lock.json vite.config.ts tsconfig.json scripts/materialize.sh scripts/fixture-web.sh -type f 2>/dev/null || true)"
if [[ -z "$spa_files" ]]; then
  echo "[fixture-web] ERROR: no SPA build inputs found under $web_dir (web/src missing?)" >&2
  exit 1
fi
no_blank_names "$spa_files" "SPA build input"
spa_in="$(cd "$web_dir" && printf '%s\n' "$spa_files" | fingerprint "$web_dir")"

stamped_in=""
stamped_out=""
if [[ -f "$spa_stamp" ]]; then
  stamped_in="$(sed -n 's/^inputs //p' "$spa_stamp")"
  stamped_out="$(sed -n 's/^outputs //p' "$spa_stamp")"
fi

reuse_spa=0
if [[ "$fresh" != "1" && -n "$stamped_in" && "$stamped_in" == "$spa_in" ]]; then
  cur_out="$(spa_out_now)"
  if [[ -n "$cur_out" && "$cur_out" == "$stamped_out" ]]; then
    reuse_spa=1
    echo "[fixture-web] SPA cache hit (inputs ${spa_in:0:12}) → reusing web/dist-build"
  else
    echo "[fixture-web] cached dist-build failed integrity check (output hash mismatch — corrupted or incomplete) → rebuilding"
  fi
fi

if [[ "$reuse_spa" != "1" ]]; then
  if [[ "$fresh" == "1" ]]; then
    echo "[fixture-web] VH_FIXTURE_FRESH=1 → building SPA… (inputs ${spa_in:0:12})"
  elif [[ -z "$stamped_in" ]]; then
    echo "[fixture-web] no SPA cache stamp → building SPA… (inputs ${spa_in:0:12})"
  elif [[ "$stamped_in" != "$spa_in" ]]; then
    echo "[fixture-web] SPA build inputs changed (${stamped_in:0:12} → ${spa_in:0:12}) → building SPA…"
  fi
  # Build output is NOT silenced (see CI-path comment above for the rationale).
  (cd "$web_dir" && npm run build)
  spa_out="$(spa_out_now)"
  if [[ -z "$spa_out" ]]; then
    echo "[fixture-web] ERROR: vite build produced no web/dist-build output" >&2
    exit 1
  fi
  stamp_tmp="$cache_dir/.spa.stamp.$$"
  { echo "inputs $spa_in"; echo "outputs $spa_out"; } >"$stamp_tmp"
  mv -f "$stamp_tmp" "$spa_stamp"  # atomic rename: concurrent lane-6 starts never read a torn stamp
fi

echo "[fixture-web] materializing staged SPA into pkg/web/dist…"
bash "$web_dir/scripts/materialize.sh"

# Prebuilt fixtureserver binary. The binary serves the SPA from //go:embed dist
# (pkg/web/server.go) — frozen at COMPILE time — so its cache key binds BOTH the
# module's non-test Go sources (+ go.mod/go.sum, hashed as go_in) AND the
# materialized pkg/web/dist content (hashed as embed_in, AFTER materialize ran).
# An SPA-only edit (no Go change) therefore rebuilds the binary too: without
# this, the standard dev loop would silently serve the PREVIOUS SPA from a
# reused binary. host-dist is also embedded but never served by the
# fixtureserver (SetHostShellAtRoot(false)) — not hashed on purpose. This
# script hashes itself into the Go list so edits to the caching logic
# invalidate the old stamp exactly once.
go_files="$(cd "$repo_root" && find . \( -name .git -o -name node_modules -o -name tmp \) -prune -o -type f \( \( -name '*.go' -not -name '*_test.go' \) -o -name go.mod -o -name go.sum \) -print 2>/dev/null || true)"
if [[ -z "$go_files" ]]; then
  echo "[fixture-web] ERROR: no Go module sources found under $repo_root" >&2
  exit 1
fi
no_blank_names "$go_files" "Go module source"
go_in="$(cd "$repo_root" && { printf '%s\n' "$go_files"; echo web/scripts/fixture-web.sh; } | fingerprint "$repo_root")"

if [[ ! -d "$repo_root/pkg/web/dist" ]]; then
  echo "[fixture-web] ERROR: $repo_root/pkg/web/dist missing (tracked placeholder.html gone?)" >&2
  exit 1
fi
embed_in="$(cd "$repo_root" && LC_ALL=C find pkg/web/dist -type f | fingerprint "$repo_root")"
srv_in="$(printf 'go %s\nembed %s\n' "$go_in" "$embed_in" | sha256sum | cut -c1-64)"

srv_stamped=""
if [[ -f "$srv_stamp" ]]; then
  srv_stamped="$(<"$srv_stamp")"
fi

if [[ "$fresh" != "1" && -x "$srv_bin" && "$srv_stamped" == "$srv_in" ]]; then
  echo "[fixture-web] fixtureserver cache hit (key ${srv_in:0:12} = go ${go_in:0:12} + embedded SPA ${embed_in:0:12}) → reusing $srv_bin"
else
  echo "[fixture-web] compiling fixtureserver → $srv_bin (key ${srv_in:0:12} = go ${go_in:0:12} + embedded SPA ${embed_in:0:12})"
  bin_tmp="$cache_dir/.fixtureserver.$$"
  (cd "$repo_root" && go build -o "$bin_tmp" ./tools/fixtureserver)
  mv -f "$bin_tmp" "$srv_bin"  # atomic rename: a concurrent start execs either the old or the new complete binary
  printf '%s\n' "$srv_in" >"$srv_stamp.$$"
  mv -f "$srv_stamp.$$" "$srv_stamp"
fi

echo "[fixture-web] starting fixture server on $ADDR"
cd "$repo_root"
exec "$srv_bin" -addr "$ADDR" $extra_args
