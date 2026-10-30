#!/usr/bin/env bash
# scripts/prepush-check.sh — changeset-aware fast pre-push verifier (push-safety Phase 1).
#
# Runs the RIGHT fast checks for a given changeset before any push. The verdict
# is MECHANICAL: the exit code is the go/no-go signal (0 green, 1 red check,
# 2 usage/environment/refusal). No auto-fix, no flake exceptions, no network,
# no pushes, no git mutations (read-only git for diffing only).
#
# Usage:
#   scripts/prepush-check.sh [--dry-run] [<base>..<head>]
#
#   (no range)     Changeset = working tree vs HEAD: tracked modifications
#                  plus ALL untracked non-ignored files (git status
#                  --porcelain --untracked-files=all). This is the local
#                  pre-commit posture; it deliberately includes concurrent
#                  session dirt (conservative: the tree is what would ship).
#   <base>..<head> Changeset = tree diff `git diff --name-status <base>
#                  <head>` (exactly the two named trees, NOT a merge-base
#                  guess; exactly one '..', two-dot form only). For real
#                  (non-dry) runs the working tree MUST be exactly <head>
#                  and clean — otherwise the script refuses (exit 2):
#                  results that do not bind to the stated range are stale
#                  evidence by construction. --dry-run never refuses on
#                  binding (it only reports it).
#   --dry-run      Print which checks WOULD run + the path classes seen and
#                  exit 0 (testable seam for the selection logic; runs
#                  nothing).
#
# Path-class selection map (first match wins; conservative by design —
# unknown/shared paths run everything):
#   dependency manifests/lockfiles (go.mod go.sum package.json
#     package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml)
#                                          -> FULL (deps expand, never narrow)
#   **/*.go                                -> go tier
#   web/**                                 -> web tier
#   host-web/**                            -> host-web tier
#   docs/**, researches/**                 -> docs (docs never add checks)
#   tooling (Makefile *.mk Dockerfile* .dockerignore scripts/** .github/**
#     .githooks/** .opencode/** .vh-agent-harness/** tests/** tools/**
#     docker/** *.sh *.py *.yml *.yaml *.toml *.jsonc opencode.jsonc
#     .gitignore .gitattributes .editorconfig) -> FULL
#   docs names (**/*.md **/*.txt **/*.rst **/*.adoc LICENSE* COPYING*
#     NOTICE* CHANGELOG*)                  -> docs
#   anything else                          -> FULL (unknown)
#   any rename/copy/delete whose involved paths are not ALL docs -> FULL
#     (rename detection is similarity-heuristic and deletions can have
#      non-local effects; the conservative direction is cheap)
#
# Tier = docs-only/empty -> no checks; exactly one non-doc class among
# {go, web, host-web} -> that class's checks; >=2 non-doc classes or any
# FULL escalation -> all six checks.
#
# Check order (sequential, fail-fast — first failure stops the run):
#   go-fmt-check       make fmt-check    (CAUTION: bare `gofmt -l` ALWAYS
#                                         exits 0; fmt-check fails on
#                                         non-empty OUTPUT)
#   go-vet             make vet
#   go-test-unit       make test-unit
#   web-typecheck      make typecheck
#   web-test-unit      npm --prefix web run test:unit
#   host-web-typecheck make typecheck-host-web
#
# Output: human progress + per-check results on STDERR; exactly ONE JSON
# receipt line on STDOUT (scripts/release-tag.sh convention), schema
# "prepush-check/1". Exceptions (intentional): --help prints plain usage and
# exits 0 without a receipt (help is not a run); if the script cannot even
# resolve a git repository it refuses with a best-effort receipt.
#   {schema, ok, dry_run, mode, range, base, head, tested_head, dirty,
#    tree_binding, tier, changed:{...}, selected:[...],
#    results:[{name,cmd,exit,duration_s,status}], total_duration_s,
#    failed_check, error}
#
# Fail-closed discovery: git status / git diff failures are REFUSALS (exit 2),
# never an empty changeset — a green receipt always means the changeset was
# actually observed. All unmerged (merge-conflict) porcelain states (AA AU
# UA DD DU UD UU) escalate to FULL.
#
# PATH hygiene: /usr/local/go/bin is added to PATH if go is not found.
#
# Known limitations (deliberate, kept simple): paths containing tabs, a
# " -> " substring, or non-ASCII (porcelain C-quoted) names would confuse
# the line parser; this repo's tree is ASCII-tame. `date +%s%N` is GNU-only
# (this toolchain is Linux-only). **/*.go is matched BEFORE tests/** — Go
# files under tests/ select the go tier, not the tooling escalation. Phase 2
# (scripts/push-checked.sh) will invoke this with a range bound to the
# exact outgoing objects and consume the JSON receipt.

set -euo pipefail

SCHEMA="prepush-check/1"
SCRIPT_START=$(date +%s%N)

# --- PATH hygiene (go lives at /usr/local/go/bin and may be off PATH) ----------
if ! command -v go >/dev/null 2>&1; then
    case ":$PATH:" in
        *:/usr/local/go/bin:*) : ;;
        *) export PATH="/usr/local/go/bin:$PATH" ;;
    esac
fi

# --- receipt state (initialized up front for set -u) ---------------------------
OK_FLAG=1
DRY_RUN=0
RANGE_ARG=""
MODE="worktree"
BASE_SHA=""
HEAD_RANGE_SHA=""
TESTED_HEAD=""
DIRTY=0
BINDING="worktree"
TIER="empty"
C_TOTAL=0; C_GO=0; C_WEB=0; C_HOST=0; C_DOCS=0; C_TOOL=0; C_LOCK=0; C_UNK=0; C_ESC=0
SELECTED_JSON="[]"
RESULTS_JSON="[]"
ERROR_MSG=""
FAILED_CHECK=""

usage() {
    cat <<'USAGE'
scripts/prepush-check.sh — changeset-aware fast pre-push verifier

Usage:
  scripts/prepush-check.sh [--dry-run] [<base>..<head>]

  no range arg   changeset = working tree vs HEAD (tracked + untracked files)
  <base>..<head> changeset = committed tree diff between the two named revs
                 (real runs refuse unless the clean working tree IS <head>)
  --dry-run      print the checks that would run + path classes; exit 0

Exit codes: 0 = green (or dry-run); 1 = a selected check failed (mechanical
red); 2 = usage error / environment refusal (bad range, not a repo, or — for
real range runs — working tree does not match <head>).

stdout: exactly one JSON receipt line (schema prepush-check/1).
stderr: human-readable progress and per-check results.
USAGE
}

json_escape() {
    # JSON string escaping for receipt fields. Covers the full C0 control
    # class (RFC 8259 forbids raw 0x00-0x1f in strings): backslash/quote/tab
    # as two-char escapes, CR/FF/VT as \uXXXX escapes, LF folded to space,
    # and the remaining exotic controls deleted outright (they cannot occur
    # in any legitimate argument or git message).
    printf '%s' "$1" \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' \
              -e 's/\r/\\u000D/g' -e 's/\f/\\u000C/g' -e 's/\v/\\u000B/g' \
        | tr '\n' ' ' \
        | tr -d '\000-\010\016-\037'
}

bool() { if [ "$1" = "1" ] || [ "$1" = "true" ]; then echo true; else echo false; fi }

emit_receipt() {
    local esc_error
    if [ -n "$ERROR_MSG" ]; then
        esc_error="\"$(json_escape "$ERROR_MSG")\""
    else
        esc_error="null"
    fi
    printf '{"schema":"%s","ok":%s,"dry_run":%s,"mode":"%s","range":%s,"base":%s,"head":%s,"tested_head":%s,"dirty":%s,"tree_binding":"%s","tier":"%s","changed":{"total":%d,"go":%d,"web":%d,"host_web":%d,"docs":%d,"tooling":%d,"lockfile":%d,"unknown":%d,"escalated":%d},"selected":%s,"results":%s,"total_duration_s":%s,"failed_check":%s,"error":%s}\n' \
        "$SCHEMA" \
        "$(bool "$OK_FLAG")" \
        "$(bool "$DRY_RUN")" \
        "$MODE" \
        "$(if [ -n "$RANGE_ARG" ]; then printf '"%s"' "$(json_escape "$RANGE_ARG")"; else echo null; fi)" \
        "$(if [ -n "$BASE_SHA" ]; then printf '"%s"' "$BASE_SHA"; else echo null; fi)" \
        "$(if [ -n "$HEAD_RANGE_SHA" ]; then printf '"%s"' "$HEAD_RANGE_SHA"; else echo null; fi)" \
        "$(if [ -n "$TESTED_HEAD" ]; then printf '"%s"' "$TESTED_HEAD"; else echo null; fi)" \
        "$(bool "$DIRTY")" \
        "$BINDING" \
        "$TIER" \
        "$C_TOTAL" "$C_GO" "$C_WEB" "$C_HOST" "$C_DOCS" "$C_TOOL" "$C_LOCK" "$C_UNK" "$C_ESC" \
        "$SELECTED_JSON" \
        "$RESULTS_JSON" \
        "$(awk -v a="$SCRIPT_START" -v b="$(date +%s%N)" 'BEGIN{printf "%.3f",(b-a)/1000000000}')" \
        "$(if [ -n "$FAILED_CHECK" ]; then printf '"%s"' "$FAILED_CHECK"; else echo null; fi)" \
        "$esc_error"
}

refuse() {
    # refuse <message> — mechanical refusal: JSON receipt on stdout + exit 2.
    ERROR_MSG="$1"
    OK_FLAG=0
    echo "prepush-check: REFUSED: $1" >&2
    emit_receipt
    exit 2
}

# --- argument parsing ------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        --*)
            ERROR_MSG="unknown option: $1"
            OK_FLAG=0
            echo "prepush-check: $ERROR_MSG" >&2
            emit_receipt
            exit 2
            ;;
        *)
            if [ -n "$RANGE_ARG" ]; then
                ERROR_MSG="unexpected extra argument: $1 (expected at most one <base>..<head>)"
                OK_FLAG=0
                echo "prepush-check: $ERROR_MSG" >&2
                emit_receipt
                exit 2
            fi
            RANGE_ARG="$1"
            ;;
    esac
    shift
done

# --- environment -------------------------------------------------------------------
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    # Outside a repository: refuse through the receipt-emitting path so the
    # "exit 2 ⇒ one JSON receipt" contract holds even here.
    ERROR_MSG="not inside a git repository (git rev-parse --show-toplevel failed)"
    OK_FLAG=0
    echo "prepush-check: $ERROR_MSG" >&2
    emit_receipt
    exit 2
}
cd "$REPO_ROOT"
TESTED_HEAD=$(git rev-parse HEAD 2>/dev/null) || refuse "could not resolve HEAD"
# Fail-closed discovery: a failed `git status` (e.g. corrupt/locked index) is
# a REFUSAL, never an empty "clean" changeset.
STATUS_RC=0
STATUS_OUT=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null) || STATUS_RC=$?
if [ "$STATUS_RC" -ne 0 ]; then
    refuse "git status failed (exit $STATUS_RC) — cannot observe the working-tree changeset; refusing rather than guessing"
fi
if [ -n "$STATUS_OUT" ]; then DIRTY=1; fi

# --- range validation ----------------------------------------------------------------
if [ -n "$RANGE_ARG" ]; then
    MODE="range"
    case "$RANGE_ARG" in
        *...*)
            # git refnames can never contain '..', so '...' is unambiguously
            # the three-dot/merge-base form — refused per the no-guessing rule.
            refuse "three-dot (merge-base) ranges are refused — supply an explicit two-dot <base>..<head> (got: $RANGE_ARG)"
            ;;
        *..*..*)
            refuse "range must contain exactly one '..' (got: $RANGE_ARG)"
            ;;
        *..*) : ;;
        *)
            refuse "range argument must look like <base>..<head> (got: $RANGE_ARG)"
            ;;
    esac
    BASE_REF="${RANGE_ARG%%..*}"
    HEAD_REF="${RANGE_ARG##*..}"
    if [ -z "$BASE_REF" ] || [ -z "$HEAD_REF" ]; then
        refuse "range must have non-empty base and head (got: $RANGE_ARG)"
    fi
    case "$BASE_REF" in -*) refuse "range base must not start with '-' (got: $BASE_REF)" ;; esac
    case "$HEAD_REF" in -*) refuse "range head must not start with '-' (got: $HEAD_REF)" ;; esac
    if ! printf '%s\n' "$BASE_REF$HEAD_REF" | grep -Eq '^[A-Za-z0-9._/@~^+-]+$'; then
        refuse "range contains invalid characters (got: $RANGE_ARG)"
    fi
    BASE_SHA=$(git rev-parse --verify --quiet "${BASE_REF}^{commit}" 2>/dev/null) \
        || refuse "base does not resolve to a commit: $BASE_REF"
    HEAD_RANGE_SHA=$(git rev-parse --verify --quiet "${HEAD_REF}^{commit}" 2>/dev/null) \
        || refuse "head does not resolve to a commit: $HEAD_REF"
fi

# --- harvest changeset entries ----------------------------------------------------------
# Entries are collected as "kind<TAB>pathA[<TAB>pathB]" lines in ENTRIES,
# kind in {chg, del, ren, unm}; renames/copies carry both paths. ANSI-C
# quoting ($'\t' / $'\n') inserts the literal characters — command
# substitution $(printf '\n') would strip the trailing newline and
# concatenate every entry onto one line.
ENTRIES=""
if [ "$MODE" = "range" ]; then
    # Fail-closed discovery: a failed `git diff` is a REFUSAL, never an
    # empty changeset.
    DIFF_RC=0
    DIFF_OUT=$(git diff --name-status --find-renames "$BASE_SHA" "$HEAD_RANGE_SHA" 2>/dev/null) || DIFF_RC=$?
    if [ "$DIFF_RC" -ne 0 ]; then
        refuse "git diff failed (exit $DIFF_RC) for range $BASE_SHA..$HEAD_RANGE_SHA — cannot observe the changeset; refusing rather than guessing"
    fi
    while IFS=$'\t' read -r st pa pb; do
        [ -n "${st:-}" ] || continue
        case "$st" in
            D) ENTRIES="${ENTRIES}del"$'\t'"${pa}"$'\n' ;;
            R*|C*) ENTRIES="${ENTRIES}ren"$'\t'"${pa}"$'\t'"${pb}"$'\n' ;;
            *) ENTRIES="${ENTRIES}chg"$'\t'"${pa}"$'\n' ;;
        esac
    done <<< "$DIFF_OUT"
else
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        xy="${line:0:2}"
        rest="${line:3}"
        case "$xy" in
            "??") ENTRIES="${ENTRIES}chg"$'\t'"${rest}"$'\n' ;;
            *U*|U*|AA|DD)
                # unmerged path (any merge-conflict porcelain state):
                # force escalation
                ENTRIES="${ENTRIES}unm"$'\t'"${rest}"$'\n'
                ;;
            R*|C*)
                old="${rest% -> *}"
                new="${rest##* -> }"
                ENTRIES="${ENTRIES}ren"$'\t'"${old}"$'\t'"${new}"$'\n'
                ;;
            *"D"|"D"*)
                ENTRIES="${ENTRIES}del"$'\t'"${rest}"$'\n'
                ;;
            *) ENTRIES="${ENTRIES}chg"$'\t'"${rest}"$'\n' ;;
        esac
    done <<< "$STATUS_OUT"
fi

# --- path classification (first match wins) ----------------------------------------------
classify() {
    local p="$1" b
    b="${p##*/}"
    case "$b" in
        go.mod|go.sum|package.json|package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.yaml)
            echo lockfile; return ;;
    esac
    case "$p" in
        *.go) echo go; return ;;
        web/*) echo web; return ;;
        host-web/*) echo host-web; return ;;
        docs/*|researches/*) echo docs; return ;;
        scripts/*|.github/*|.githooks/*|.opencode/*|.vh-agent-harness/*|tests/*|tools/*|docker/*)
            echo tooling; return ;;
    esac
    case "$b" in
        Makefile|makefile|*.mk|Dockerfile*|.dockerignore|opencode.jsonc|.gitignore|.gitattributes|.editorconfig|*.sh|*.py|*.yml|*.yaml|*.toml|*.jsonc)
            echo tooling; return ;;
        *.md|*.txt|*.rst|*.adoc|LICENSE*|COPYING*|NOTICE*|CHANGELOG*)
            echo docs; return ;;
    esac
    echo unknown
}

count_class() {
    case "$1" in
        go) C_GO=$((C_GO+1)) ;;
        web) C_WEB=$((C_WEB+1)) ;;
        host-web) C_HOST=$((C_HOST+1)) ;;
        docs) C_DOCS=$((C_DOCS+1)) ;;
        tooling) C_TOOL=$((C_TOOL+1)) ;;
        lockfile) C_LOCK=$((C_LOCK+1)) ;;
        *) C_UNK=$((C_UNK+1)) ;;
    esac
}

while IFS=$'\t' read -r kind pa pb; do
    [ -n "${kind:-}" ] || continue
    C_TOTAL=$((C_TOTAL+1))
    case "$kind" in
        chg) count_class "$(classify "$pa")" ;;
        del)
            cls="$(classify "$pa")"
            if [ "$cls" = "docs" ]; then
                count_class docs
            else
                C_ESC=$((C_ESC+1)); count_class "$cls"
            fi
            ;;
        ren)
            ca="$(classify "$pa")"; cb="$(classify "$pb")"
            if [ "$ca" = "docs" ] && [ "$cb" = "docs" ]; then
                C_DOCS=$((C_DOCS+1))
            else
                C_ESC=$((C_ESC+1)); count_class "$ca"
            fi
            ;;
        unm)
            # unmerged: force escalation, count under unknown
            C_ESC=$((C_ESC+1)); C_UNK=$((C_UNK+1))
            ;;
        *)
            C_ESC=$((C_ESC+1)); C_UNK=$((C_UNK+1))
            ;;
    esac
done <<< "$ENTRIES"

# --- tier selection ------------------------------------------------------------------------
NONDOCS=0
[ "$C_GO" -gt 0 ] && NONDOCS=$((NONDOCS+1))
[ "$C_WEB" -gt 0 ] && NONDOCS=$((NONDOCS+1))
[ "$C_HOST" -gt 0 ] && NONDOCS=$((NONDOCS+1))
FORCE_FULL=0
if [ "$C_TOOL" -gt 0 ] || [ "$C_LOCK" -gt 0 ] || [ "$C_UNK" -gt 0 ] || [ "$C_ESC" -gt 0 ]; then
    FORCE_FULL=1
fi

CK_NAMES=("go-fmt-check" "go-vet" "go-test-unit" "web-typecheck" "web-test-unit" "host-web-typecheck")
CK_CMDS=("make fmt-check" "make vet" "make test-unit" "make typecheck" "npm --prefix web run test:unit" "make typecheck-host-web")

SEL_IDX=()
if [ "$C_TOTAL" -eq 0 ]; then
    TIER="empty"
elif [ "$FORCE_FULL" -eq 1 ] || [ "$NONDOCS" -ge 2 ]; then
    TIER="full"; SEL_IDX=(0 1 2 3 4 5)
elif [ "$C_GO" -gt 0 ]; then
    TIER="go"; SEL_IDX=(0 1 2)
elif [ "$C_WEB" -gt 0 ]; then
    TIER="web"; SEL_IDX=(3 4)
elif [ "$C_HOST" -gt 0 ]; then
    TIER="host-web"; SEL_IDX=(5)
else
    TIER="docs-skip"; SEL_IDX=()
fi

SELECTED_JSON="[]"
if [ "${#SEL_IDX[@]}" -gt 0 ]; then
    _sel=""
    for i in ${SEL_IDX[@]+"${SEL_IDX[@]}"}; do
        _sel="${_sel:+$_sel,}\"${CK_NAMES[$i]}\""
    done
    SELECTED_JSON="[$_sel]"
fi

# --- tree binding (range mode) ---------------------------------------------------------------
if [ "$MODE" = "range" ]; then
    if [ "$TESTED_HEAD" = "$HEAD_RANGE_SHA" ] && [ "$DIRTY" -eq 0 ]; then
        BINDING="exact"
    else
        BINDING="mismatch"
    fi
fi

# --- human summary (stderr) --------------------------------------------------------------------
{
    echo "prepush-check: mode=$MODE tier=$TIER binding=$BINDING changed(total=$C_TOTAL go=$C_GO web=$C_WEB host_web=$C_HOST docs=$C_DOCS tooling=$C_TOOL lockfile=$C_LOCK unknown=$C_UNK escalated=$C_ESC)"
    if [ "$MODE" = "range" ]; then
        echo "prepush-check: range=$RANGE_ARG base=$BASE_SHA head=$HEAD_RANGE_SHA tested_head=$TESTED_HEAD dirty=$DIRTY"
    fi
} >&2

# Real (non-dry) range runs refuse on binding mismatch: results that do not
# bind to the stated range are stale evidence by construction.
if [ "$MODE" = "range" ] && [ "$DRY_RUN" -eq 0 ] && [ "$BINDING" = "mismatch" ]; then
    refuse "working tree does not match range head $HEAD_RANGE_SHA (HEAD=$TESTED_HEAD dirty=$DIRTY); a real range run must verify the exact stated tree — use --dry-run to inspect selection only"
fi

# --- dry-run: selection seam ---------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    {
        echo "prepush-check: DRY-RUN — checks that WOULD run (tier=$TIER):"
        if [ "${#SEL_IDX[@]}" -eq 0 ]; then
            echo "  (none)"
        else
            for i in ${SEL_IDX[@]+"${SEL_IDX[@]}"}; do
                echo "  - ${CK_NAMES[$i]}  (${CK_CMDS[$i]})"
            done
        fi
    } >&2
    RESULTS_JSON="[]"
    emit_receipt
    exit 0
fi

# --- execute selected checks (sequential, fail-fast) -----------------------------------------------
RESULT_PIECES=""
RUN_STARTED=0
for i in ${SEL_IDX[@]+"${SEL_IDX[@]}"}; do
    name="${CK_NAMES[$i]}"
    cmd="${CK_CMDS[$i]}"
    if [ "$OK_FLAG" -ne 1 ]; then
        piece="{\"name\":\"$name\",\"cmd\":\"$cmd\",\"exit\":null,\"duration_s\":null,\"status\":\"skipped\"}"
        RESULT_PIECES="${RESULT_PIECES:+$RESULT_PIECES,}$piece"
        continue
    fi
    RUN_STARTED=1
    echo "prepush-check: >> $name: $cmd" >&2
    t0=$(date +%s%N)
    rc=0
    bash -c "$cmd" 1>&2 || rc=$?
    t1=$(date +%s%N)
    dur=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f",(b-a)/1000000000}')
    if [ "$rc" -eq 0 ]; then
        echo "prepush-check: [PASS] $name (${dur}s)" >&2
        piece="{\"name\":\"$name\",\"cmd\":\"$cmd\",\"exit\":0,\"duration_s\":$dur,\"status\":\"pass\"}"
        RESULT_PIECES="${RESULT_PIECES:+$RESULT_PIECES,}$piece"
    else
        echo "prepush-check: [FAIL] $name exited $rc (${dur}s) — stopping (fail-fast)" >&2
        piece="{\"name\":\"$name\",\"cmd\":\"$cmd\",\"exit\":$rc,\"duration_s\":$dur,\"status\":\"fail\"}"
        RESULT_PIECES="${RESULT_PIECES:+$RESULT_PIECES,}$piece"
        OK_FLAG=0
        FAILED_CHECK="$name"
    fi
done

if [ -n "$RESULT_PIECES" ]; then
    RESULTS_JSON="[$RESULT_PIECES]"
else
    RESULTS_JSON="[]"
fi

{
    echo "prepush-check: summary — tier=$TIER checks=${#SEL_IDX[@]} result=$(if [ "$OK_FLAG" -eq 1 ]; then echo GREEN; else echo RED; fi)"
    if [ -n "$FAILED_CHECK" ]; then
        echo "prepush-check: failed check: $FAILED_CHECK"
    fi
    if [ "$RUN_STARTED" -eq 0 ]; then
        echo "prepush-check: no checks selected (tier=$TIER) — nothing to run"
    fi
} >&2

emit_receipt
if [ "$OK_FLAG" -eq 1 ]; then
    exit 0
else
    exit 1
fi
