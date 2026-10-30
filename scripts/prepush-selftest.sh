#!/usr/bin/env bash
# scripts/prepush-selftest.sh — durable self-test for scripts/prepush-check.sh
# (push-safety Phase 1 deferred obligation #2, landed with Phase 2).
#
# Why this exists: Phase 1's verification receipts lived only under gitignored
# tmp/. This script is the durable, re-runnable version: it exercises the
# MECHANICAL GUARDS of prepush-check.sh from a scratch CLONE of this
# repository (never the real worktree — the real tree and any concurrent
# session dirt stay untouched; the clone sees only committed state).
#
# To test the CURRENT working-tree version of the checker (not just the last
# committed one), the script copies scripts/prepush-check.sh into the clone
# before running scenarios.
#
# Scenarios (each asserts exit code + receipt fields via jq):
#   1  green-docs-commit        docs-only range -> exit 0, tier docs-skip, binding exact
#   2  green-go-commit          go-only range   -> exit 0, tier go, all checks pass
#   3  dry-run-selection        --dry-run on the go range -> selected == go tier
#   4  binding-mismatch         dirty tracked file -> exit 2, binding mismatch
#   5  threedot-range           a...b -> exit 2 (merge-base guessing refused)
#   6  range-shape              no-dots arg -> exit 2
#   7  unknown-option           --bogus -> exit 2
#   8  diff-guard-injection     PREPUSH_GIT shim failing `git diff` -> exit 2,
#                               "git diff failed" (Phase-1 deferred obligation #1)
#   9  status-guard-injection   PREPUSH_GIT shim failing `git status` -> exit 2,
#                               "git status failed"
#  10  seam-not-executable      PREPUSH_GIT=/nonexistent -> exit 2
#  11  fmt-red                  unformatted .go commit -> exit 1, failed check
#                               go-fmt-check (fail-fast: vet/test never run)
#  12  not-a-repo               bogus GIT_DIR -> exit 2, "not inside a git
#                               repository"
#
# Output: human progress on stderr; exactly ONE JSON receipt line on stdout
# (schema "prepush-selftest/1"); --help plain text. Exit 0 all green, 1 any
# failure, 2 environment refusal (missing jq/git/go, clone failure).
#
# Requires: git, jq, go (scenarios 2/3/11 run `make fmt-check`/`vet`/
# `test-unit` inside the clone — the REAL go tier executes once; expect
# ~2-3 min cold, seconds when the shared GOCACHE is warm). Scratch:
# gitignored tmp/prepush-selftest.<rand>/, removed on exit (trap).
#
# NOTE: scenarios deliberately avoid web/host-web tiers — a fresh clone has no
# node_modules, so npm lanes would fail for reasons unrelated to the guards.

set -euo pipefail

SCHEMA="prepush-selftest/1"
SCRIPT_START=$(date +%s%N)
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECKER="$SCRIPT_DIR/prepush-check.sh"

# --- PATH hygiene (go lives at /usr/local/go/bin and may be off PATH) ------------
if ! command -v go >/dev/null 2>&1; then
    case ":$PATH:" in
        *:/usr/local/go/bin:*) : ;;
        *) export PATH="/usr/local/go/bin:$PATH" ;;
    esac
fi

usage() {
    cat <<'USAGE'
scripts/prepush-selftest.sh — durable self-test for scripts/prepush-check.sh

Runs the checker's mechanical-guard scenario matrix from a scratch clone of
this repository (real worktree untouched). Covers: range binding (exact vs
mismatch), tier selection (docs/go), dry-run selection, three-dot/range-shape
refusals, unknown-option refusal, PREPUSH_GIT failure injection (diff guard,
status guard, not-executable seam), gofmt red check (exit 1, fail-fast), and
the not-a-repo refusal.

Usage: scripts/prepush-selftest.sh [--help]

stdout: exactly one JSON receipt line (schema prepush-selftest/1).
stderr: human-readable progress.
Exit: 0 all scenarios pass; 1 any failure; 2 environment refusal.
USAGE
}

json_escape() {
    printf '%s' "$1" \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' \
        | tr '\n' ' ' \
        | tr -d '\000-\010\016-\037'
}

PASS_CNT=0
FAIL_CNT=0
PIECES=""

record() {
    # record <name> <pass 0|1> <exit> <detail>
    local status="fail"
    if [ "$2" = "1" ]; then
        status="pass"
        PASS_CNT=$((PASS_CNT+1))
    else
        FAIL_CNT=$((FAIL_CNT+1))
    fi
    PIECES="${PIECES:+$PIECES,}{\"name\":\"$1\",\"status\":\"$status\",\"exit\":$3,\"detail\":\"$(json_escape "$4")\"}"
    echo "selftest: [$status] $1 (exit=$3) — $4" >&2
}

emit_receipt() {
    local ok=true
    [ "$FAIL_CNT" -eq 0 ] || ok=false
    printf '{"schema":"%s","ok":%s,"scenarios":[%s],"passed":%d,"failed":%d,"total_duration_s":%s,"error":null}\n' \
        "$SCHEMA" "$ok" "$PIECES" "$PASS_CNT" "$FAIL_CNT" \
        "$(awk -v a="$SCRIPT_START" -v b="$(date +%s%N)" 'BEGIN{printf "%.3f",(b-a)/1000000000}')"
}

die_env() {
    echo "selftest: REFUSED: $1" >&2
    exit 2
}

# --- argument parsing ---------------------------------------------------------------
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    "") : ;;
    *) die_env "unexpected argument: $1 (only --help is recognized)" ;;
esac

command -v jq >/dev/null 2>&1 || die_env "jq is required but not on PATH"
command -v git >/dev/null 2>&1 || die_env "git is required but not on PATH"
[ -f "$CHECKER" ] || die_env "cannot find scripts/prepush-check.sh next to this script"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die_env "not inside a git repository"
cd "$REPO_ROOT"

mkdir -p "$REPO_ROOT/tmp"
SCRATCH=$(mktemp -d "$REPO_ROOT/tmp/prepush-selftest.XXXXXX") || die_env "cannot create scratch dir"
trap 'rm -rf "$SCRATCH"' EXIT
CLONE="$SCRATCH/clone"

echo "selftest: cloning the repository into a scratch clone (committed state only)…" >&2
git clone --quiet "$REPO_ROOT" "$CLONE" 2>"$SCRATCH/clone.err" || {
    echo "selftest: clone failed:" >&2; cat "$SCRATCH/clone.err" >&2; die_env "git clone of this repo failed"
}
# Test the CURRENT working-tree checker, not just the committed one. The copy
# makes the tracked file differ from the clone's index, which would read as
# "dirty" and trip the exact-binding guard; --skip-worktree tells git to treat
# the working-tree copy as matching the index, so the clone reads clean while
# still executing the current checker. (Fixture ranges are commit-to-commit —
# this working-tree-only difference is never part of any changeset.)
cp "$CHECKER" "$CLONE/scripts/prepush-check.sh"
git -C "$CLONE" update-index --skip-worktree scripts/prepush-check.sh
git -C "$CLONE" config user.email prepush-selftest@invalid
git -C "$CLONE" config user.name "prepush selftest"
CLONE_HEAD=$(git -C "$CLONE" rev-parse HEAD)

# run_checker <rc-var> <stdout-var> <env assignments…> -- <args…>
# Runs the clone's checker with cwd = clone; captures stdout + exit code.
run_checker() {
    local rcvar="$1" outvar="$2"; shift 2
    local -a envs=() args=()
    local seen_dd=0
    for a in "$@"; do
        if [ "$seen_dd" = "0" ] && [ "$a" = "--" ]; then seen_dd=1; continue; fi
        if [ "$seen_dd" = "0" ]; then envs+=("$a"); else args+=("$a"); fi
    done
    local out rc=0
    out=$(cd "$CLONE" && env "${envs[@]+"${envs[@]}"}" bash "$CLONE/scripts/prepush-check.sh" ${args[@]+"${args[@]}"} 2>"$SCRATCH/last.stderr") || rc=$?
    printf -v "$rcvar" '%s' "$rc"
    printf -v "$outvar" '%s' "$out"
}

assert_receipt() {
    # assert_receipt <name> <expected-exit> <actual-exit> <stdout> <jq-expr> [detail]
    local name="$1" want="$2" got="$3" out="$4" expr="$5" detail="${6:-}"
    if [ "$got" != "$want" ]; then
        record "$name" 0 "$got" "expected exit $want, got $got; stderr: $(tail -n 2 "$SCRATCH/last.stderr" 2>/dev/null | tr '\n' ' ')"
        return 0
    fi
    if ! printf '%s' "$out" | jq -e "$expr" >/dev/null 2>&1; then
        record "$name" 0 "$got" "receipt assertion failed: $expr; receipt: $(printf '%s' "$out" | cut -c1-300); $detail"
        return 0
    fi
    record "$name" 1 "$got" "$detail"
}

# --- fixture commit 1 (docs-only) + scenario 1 -------------------------------------
# Green docs-only range must be checked while HEAD IS the docs commit (P1
# exact-binding semantics), so this scenario runs BEFORE the go fixture lands.
echo "selftest: planting fixture commits in the clone…" >&2
mkdir -p "$CLONE/docs"
echo "prepush selftest note $(date +%s)" > "$CLONE/docs/prepush-selftest-note.md"
git -C "$CLONE" add docs/prepush-selftest-note.md
git -C "$CLONE" commit --quiet -m "selftest: docs-only fixture"

# --- 1: green docs-only range ---------------------------------------------------------
run_checker RC OUT -- HEAD~1..HEAD
assert_receipt "green-docs-commit" 0 "$RC" "$OUT" \
    '.schema=="prepush-check/1" and .ok==true and .mode=="range" and .tier=="docs-skip" and .tree_binding=="exact" and (.selected|length==0)' \
    "docs-only range is green with binding exact"

# --- fixture commit 2 (go-only, green) ------------------------------------------------
mkdir -p "$CLONE/pkg/prepushselftest"
cat > "$CLONE/pkg/prepushselftest/green.go" <<'EOF'
// Package prepushselftest is a scratch-clone fixture for prepush-selftest.
package prepushselftest

// Green is a gofmt-clean fixture function.
func Green() bool { return true }
EOF
git -C "$CLONE" add pkg/prepushselftest/green.go
git -C "$CLONE" commit --quiet -m "selftest: go-only fixture (green)"

# --- 2: green go-only range -----------------------------------------------------------
run_checker RC OUT -- HEAD~1..HEAD
assert_receipt "green-go-commit" 0 "$RC" "$OUT" \
    '.schema=="prepush-check/1" and .ok==true and .tier=="go" and .tree_binding=="exact" and ([.selected[]]==["go-fmt-check","go-vet","go-test-unit"]) and (all(.results[]?; .exit==0))' \
    "go-only range runs the go tier and all checks pass"

# --- 3: dry-run selection seam --------------------------------------------------------
run_checker RC OUT -- --dry-run HEAD~1..HEAD
assert_receipt "dry-run-selection" 0 "$RC" "$OUT" \
    '.dry_run==true and .tier=="go" and ([.selected[]]==["go-fmt-check","go-vet","go-test-unit"]) and (.results|length==0)' \
    "dry-run reports go tier selection without running checks"

# --- 4: binding mismatch (dirty tracked file) ------------------------------------------
echo "concurrent-dirt-marker" >> "$CLONE/README.md"
run_checker RC OUT -- HEAD~1..HEAD
assert_receipt "binding-mismatch" 2 "$RC" "$OUT" \
    '.ok==false and .tree_binding=="mismatch" and (.error|test("does not match"))' \
    "dirty tracked tree refuses (exit 2) with mismatch binding"
git -C "$CLONE" checkout --quiet -- README.md

# --- 5/6/7: argument refusals -----------------------------------------------------------
run_checker RC OUT -- "HEAD~1...HEAD"
assert_receipt "threedot-range" 2 "$RC" "$OUT" '.error|test("three-dot")' "three-dot range refused"

run_checker RC OUT -- "HEAD"
assert_receipt "range-shape" 2 "$RC" "$OUT" '.error|test("must look like")' "dotless range refused"

run_checker RC OUT -- --bogus
assert_receipt "unknown-option" 2 "$RC" "$OUT" '.error|test("unknown option")' "unknown option refused"

# --- 8/9/10: PREPUSH_GIT failure injection (deferred obligation #1) ----------------------
cat > "$SCRATCH/git-diff-fail" <<'EOF'
#!/bin/sh
# test shim: fail `git diff`, delegate everything else to the real git
case "$1" in
    diff) echo "shim: injected diff failure" >&2; exit 70 ;;
    *)    exec git "$@" ;;
esac
EOF
chmod +x "$SCRATCH/git-diff-fail"
cat > "$SCRATCH/git-status-fail" <<'EOF'
#!/bin/sh
# test shim: fail `git status`, delegate everything else to the real git
case "$1" in
    status) echo "shim: injected status failure" >&2; exit 71 ;;
    *)      exec git "$@" ;;
esac
EOF
chmod +x "$SCRATCH/git-status-fail"

run_checker RC OUT "PREPUSH_GIT=$SCRATCH/git-diff-fail" -- HEAD~1..HEAD
assert_receipt "diff-guard-injection" 2 "$RC" "$OUT" \
    '.ok==false and (.error|test("git diff failed"))' \
    "failing git diff (rev-parse still real) refuses — never an empty changeset"

run_checker RC OUT "PREPUSH_GIT=$SCRATCH/git-status-fail" --
assert_receipt "status-guard-injection" 2 "$RC" "$OUT" \
    '.ok==false and (.error|test("git status failed"))' \
    "failing git status refuses in worktree mode"

run_checker RC OUT "PREPUSH_GIT=$SCRATCH/definitely-missing" -- HEAD~1..HEAD
assert_receipt "seam-not-executable" 2 "$RC" "$OUT" \
    '.ok==false and (.error|test("not executable"))' \
    "non-executable PREPUSH_GIT refuses"

# --- 11: gofmt red check (exit 1, fail-fast) ---------------------------------------------
cat > "$CLONE/pkg/prepushselftest/bad.go" <<'EOF'
// Package prepushselftest is a scratch-clone fixture for prepush-selftest.
package prepushselftest

// Bad is deliberately NOT gofmt-clean (double space before the name).
func  Bad() bool { return false }
EOF
git -C "$CLONE" add pkg/prepushselftest/bad.go
git -C "$CLONE" commit --quiet -m "selftest: unformatted go fixture (red)"
run_checker RC OUT -- HEAD~1..HEAD
assert_receipt "fmt-red" 1 "$RC" "$OUT" \
    '.ok==false and .failed_check=="go-fmt-check" and .results[0].status=="fail" and (.results|length==3) and (.results[1].status=="skipped") and (.results[2].status=="skipped")' \
    "unformatted go file -> exit 1, fail-fast marks the rest skipped"

# --- 12: not a repository ------------------------------------------------------------------
RC=0
OUT=$(cd "$SCRATCH" && env GIT_DIR="$SCRATCH/nonexistent.git" GIT_WORK_TREE="$SCRATCH" bash "$CLONE/scripts/prepush-check.sh" 2>"$SCRATCH/last.stderr") || RC=$?
assert_receipt "not-a-repo" 2 "$RC" "$OUT" \
    '.ok==false and (.error|test("not inside a git repository"))' \
    "bogous GIT_DIR refuses with a receipt"

# --- summary --------------------------------------------------------------------------------
echo "selftest: clone HEAD was $CLONE_HEAD; scenarios: $PASS_CNT passed, $FAIL_CNT failed" >&2
emit_receipt
[ "$FAIL_CNT" -eq 0 ]
