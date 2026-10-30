#!/usr/bin/env bash
# scripts/push-checked.sh — mechanical checked push (push-safety Phase 2).
#
# Sanctioned-wrapper pattern (precedent: scripts/release-tag.sh; brief E13):
# an exec-capable agent invokes this script; ALL enforcement is mechanical
# INSIDE this file. The executor is executor-agnostic — if an upstream
# commit-gate `push` verb ever lands, this logic moves behind it unchanged.
#
# What it does: resolve the EXACT outgoing objects for ONE branch push to an
# existing remote-tracking branch, run scripts/prepush-check.sh over exactly
# that range, fail-close on anything less than a fresh fully-green receipt
# bound to the exact tree being pushed, re-verify every input immediately
# before transport, and then push exactly the approved object. Exactly one
# JSON receipt line on stdout (schema "push-checked/1"); human summary on
# stderr; --help prints plain usage and exits 0 (help is not a run).
#
# Usage:
#   scripts/push-checked.sh [--remote <name>] [<refspec>]
#
#   --remote <name>   push to this configured remote (default: the current
#                     branch's upstream remote, from branch.<b>.remote)
#   <refspec>         ONE branch refspec, default = current branch -> its
#                     upstream destination (branch.<b>.merge). Accepted
#                     forms (initial surface, deliberately narrow):
#                       <branch>                 src+dst = that branch
#                       refs/heads/<branch>      ditto
#                       <branch>:<branch>        explicit src:dst
#                       refs/heads/a:refs/heads/b
#
# Refusals (exit 2 + reason; remote untouched) — fail-closed, initial surface:
#   usage errors / unknown options / bad refspec characters
#   not a git repo / detached HEAD / missing or unresolvable refs
#   no upstream (when neither --remote nor refspec supplies the target)
#   unknown remote name
#   ambiguous destination: more than one pushurl, or more than one url
#   force (`+`), deletion (`:dst` / `src:`), tag refspecs, globs
#   multi-ref pushes (more than one refspec argument)
#   source branch is not the current branch (the checked tree must BE the
#     pushed tree — prepush-check.sh binding semantics)
#   new branch on the remote (destination ref does not exist there)
#   non-fast-forward (remote destination is not an ancestor of the source)
#   prepush-check refused (exit 2: bad range, dirty tree, failed discovery…)
#   prepush receipt verification failure (schema/version/ok/binding/head/
#     per-check exits — anything less than exact is stale evidence)
#   prepush-check timed out (PREPUSH_CHECK_TIMEOUT_S, default 3600s)
#   inputs changed between check and push (HEAD moved, source branch moved,
#     working tree dirtied, remote destination moved)
#   push transport failure / post-push verification mismatch
#
# Destination binding (F-B1): `git push <name>` honors remote.<name>.pushurl
# while `git ls-remote <name>` resolves the FETCH url. This wrapper resolves
# exactly ONE effective push destination (the single pushurl if set, else the
# single url; multiples of either are refused) and pins it for EVERY remote
# interaction — outgoing-range reads, pre-transport re-verification, the push
# itself, and the post-push check — so the checked range always describes the
# repository that is actually mutated. An applicable url.<base>.pushInsteadOf
# rewrite is REFUSED for the same reason (`git push <url>` applies it while
# `git ls-remote <url>` does not — transport would diverge from the checked
# endpoint); plain insteadOf is allowed (it rewrites fetch and push
# identically, so both stay bound to one endpoint). Tag transport is
# explicitly neutralized with --no-follow-tags (F-B2): push.followTags=true
# must never smuggle annotated tags past the single-refspec contract. The
# receipt deliberately records the remote NAME, never the URL — URLs can
# embed credentials and receipts are shareable. Push-failure diagnostics
# follow the same rule: the RAW stderr goes to the operator's stderr channel;
# the receipt error is sanitized (pinned URL replaced by the remote name, any
# remaining url-shaped token scrubbed).
#
# Exit codes (mirror scripts/prepush-check.sh):
#   0  green — pushed (or already up to date; up_to_date=true, no transport)
#   1  prepush check failed (mechanical red — fix before pushing)
#   2  refusal / environment / transport failure
#
# Concurrency posture: gitignored dirt (tmp/, node_modules/, build outputs…)
# never blocks a push. Tracked or untracked-non-ignored dirt DOES block: the
# checks run against the working tree, so a dirty tree cannot prove the
# pushed tree is green (fail-closed by construction). The wrapper NEVER
# stashes, cleans, reverts, or otherwise mutates the working tree to get
# past this — unrelated concurrent edits are preserved untouched; commit or
# stash them and re-run. (Future option, deliberately not built here: run
# the checks in an isolated `git worktree` at the exact head.)
#
# Output receipt (stdout, one line, schema push-checked/1):
#   {schema, ok, remote, src_branch, dst_ref, push_spec, remote_before,
#    up_to_date, pushed, pushed_sha,
#    prepush:{exit, schema, tier, selected, tested_head, tree_binding,
#             digest, duration_s},
#    push_duration_s, total_duration_s, error}
#
# Dependencies: git, jq, sha256sum, timeout (fail-closed if missing).
# Scratch: repo tmp/push-checked.<rand>/ (gitignored), removed on exit.
#
# NO pushes to anywhere except the single approved branch ref on the named
# remote. Never --force/--all/--tags/--mirror. The wrapper performs the push
# itself with the EXACT approved sha as the refspec source, so not even a
# concurrently-moved branch can change what is transported.

set -euo pipefail

SCHEMA="push-checked/1"
SCRIPT_START=$(date +%s%N)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PREPUSH="$SCRIPT_DIR/prepush-check.sh"

# --- receipt state (initialized up front for set -u) ----------------------------
OK_FLAG=1
REMOTE_ARG=""
REFSPEC_ARG=""
REMOTE_NAME=""
SRC_BRANCH=""
DST_BRANCH=""
DST_REF=""
PUSH_SPEC=""
REMOTE_BEFORE=""     # remote destination sha before the push ("" = absent)
REMOTE_RESOLVED=0    # 1 once REMOTE_BEFORE holds a real sha
UP_TO_DATE=0
PUSHED=0
PUSHED_SHA=""
P1_RC=""
P1_TIER=""
P1_SELECTED="[]"
P1_TESTED_HEAD=""
P1_BINDING=""
P1_DIGEST=""
P1_DURATION="null"
PUSH_DURATION="null"
ERROR_MSG=""

usage() {
    cat <<'USAGE'
scripts/push-checked.sh — mechanical checked push (push-safety Phase 2)

Usage:
  scripts/push-checked.sh [--remote <name>] [<refspec>]

  --remote <name>  target remote (default: current branch's upstream remote)
  <refspec>        ONE branch refspec (default: current branch -> upstream
                   destination). Forms: <branch>, refs/heads/<branch>,
                   <src>:<dst>, refs/heads/<src>:refs/heads/<dst>.

Refused initially (exit 2): force, deletions, tags, globs, multi-ref,
new branches on the remote, non-fast-forwards, detached HEAD, no upstream,
source branch != current branch, dirty tracked tree, missing/stale/mismatched
prepush receipt, prepush timeout, inputs changed between check and push,
ambiguous destination (multiple pushurls or urls), applicable
url.<base>.pushInsteadOf rewrites (including empty rewrite values) — the
transport endpoint must always equal the checked endpoint.

Destination binding: exactly ONE effective push destination is used for
checks AND transport (the single pushurl if set, else the single url);
git push runs with --no-follow-tags so config can never leak tags.

Exit codes: 0 = pushed (or up-to-date no-op); 1 = prepush check failed;
2 = refusal / environment / transport failure.

stdout: exactly one JSON receipt line (schema push-checked/1).
stderr: human-readable progress.

Env:
  PREPUSH_CHECK_TIMEOUT_S  soft timeout for prepush-check.sh (default 3600).
                           The test seam PREPUSH_GIT is UNSET for the check —
                           a real push gate never runs shimmed discovery.
USAGE
}

json_escape() {
    # Same escaping contract as prepush-check.sh (C0 controls handled; LF folded).
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
    printf '{"schema":"%s","ok":%s,"remote":%s,"src_branch":%s,"dst_ref":%s,"push_spec":%s,"remote_before":%s,"up_to_date":%s,"pushed":%s,"pushed_sha":%s,"prepush":{"exit":%s,"schema":"prepush-check/1","tier":%s,"selected":%s,"tested_head":%s,"tree_binding":%s,"digest":%s,"duration_s":%s},"push_duration_s":%s,"total_duration_s":%s,"error":%s}\n' \
        "$SCHEMA" \
        "$(bool "$OK_FLAG")" \
        "$(if [ -n "$REMOTE_NAME" ]; then printf '"%s"' "$(json_escape "$REMOTE_NAME")"; else echo null; fi)" \
        "$(if [ -n "$SRC_BRANCH" ]; then printf '"%s"' "$(json_escape "$SRC_BRANCH")"; else echo null; fi)" \
        "$(if [ -n "$DST_REF" ]; then printf '"%s"' "$DST_REF"; else echo null; fi)" \
        "$(if [ -n "$PUSH_SPEC" ]; then printf '"%s"' "$(json_escape "$PUSH_SPEC")"; else echo null; fi)" \
        "$(if [ "$REMOTE_RESOLVED" = 1 ]; then printf '"%s"' "$(json_escape "$REMOTE_BEFORE")"; else echo null; fi)" \
        "$(bool "$UP_TO_DATE")" \
        "$(bool "$PUSHED")" \
        "$(if [ -n "$PUSHED_SHA" ]; then printf '"%s"' "$PUSHED_SHA"; else echo null; fi)" \
        "$(if [ -n "$P1_RC" ]; then echo "$P1_RC"; else echo null; fi)" \
        "$(if [ -n "$P1_TIER" ]; then printf '"%s"' "$P1_TIER"; else echo null; fi)" \
        "$P1_SELECTED" \
        "$(if [ -n "$P1_TESTED_HEAD" ]; then printf '"%s"' "$P1_TESTED_HEAD"; else echo null; fi)" \
        "$(if [ -n "$P1_BINDING" ]; then printf '"%s"' "$P1_BINDING"; else echo null; fi)" \
        "$(if [ -n "$P1_DIGEST" ]; then printf '"%s"' "$P1_DIGEST"; else echo null; fi)" \
        "$P1_DURATION" \
        "$PUSH_DURATION" \
        "$(awk -v a="$SCRIPT_START" -v b="$(date +%s%N)" 'BEGIN{printf "%.3f",(b-a)/1000000000}')" \
        "$esc_error"
}

refuse() {
    # refuse <message> — mechanical refusal: receipt + exit 2, remote untouched.
    ERROR_MSG="$1"
    OK_FLAG=0
    echo "push-checked: REFUSED: $1" >&2
    emit_receipt
    exit 2
}

check_red() {
    # check_red <message> — prepush check failed: receipt + exit 1, no push.
    ERROR_MSG="$1"
    OK_FLAG=0
    echo "push-checked: CHECK FAILED: $1" >&2
    emit_receipt
    exit 1
}

# --- dependencies --------------------------------------------------------------------
[ -f "$PREPUSH" ] || refuse "cannot find scripts/prepush-check.sh next to this script ($PREPUSH)"
command -v jq >/dev/null 2>&1 || refuse "jq is required (receipt verification) but not on PATH"
command -v sha256sum >/dev/null 2>&1 || refuse "sha256sum is required (receipt digest) but not on PATH"
command -v timeout >/dev/null 2>&1 || refuse "timeout is required (check timeout) but not on PATH"

# --- argument parsing ------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --remote)
            [ $# -ge 2 ] || refuse "--remote requires a value (remote name)"
            [ -z "$REMOTE_ARG" ] || refuse "--remote given more than once"
            REMOTE_ARG="$2"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --*)
            refuse "unknown option: $1"
            ;;
        -*)
            refuse "unexpected option-like argument: $1 (supported: --remote <name>, one optional refspec)"
            ;;
        *)
            if [ -n "$REFSPEC_ARG" ]; then
                refuse "multi-ref pushes are refused — exactly one refspec allowed (got extra: $1)"
            fi
            REFSPEC_ARG="$1"
            ;;
    esac
    shift
done

# --- repository / branch -----------------------------------------------------------------
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || refuse "not inside a git repository (git rev-parse --show-toplevel failed)"
cd "$REPO_ROOT"

BRANCH_REF=$(git symbolic-ref --quiet HEAD 2>/dev/null) \
    || refuse "detached HEAD — checkout the branch to push (the checked tree must be the pushed tree)"
CURRENT_BRANCH="${BRANCH_REF#refs/heads/}"
[ -n "$CURRENT_BRANCH" ] || refuse "could not derive current branch from $BRANCH_REF"

# --- resolve remote ---------------------------------------------------------------------
if [ -n "$REMOTE_ARG" ]; then
    REMOTE_NAME="$REMOTE_ARG"
else
    REMOTE_NAME=$(git config --get "branch.${CURRENT_BRANCH}.remote" 2>/dev/null) \
        || refuse "no upstream remote for branch ${CURRENT_BRANCH} (branch.${CURRENT_BRANCH}.remote unset) — pass --remote <name> or set an upstream"
fi
printf '%s' "$REMOTE_NAME" | grep -Eq '^[A-Za-z0-9._-]+$' \
    || refuse "remote name has invalid characters: $REMOTE_NAME"
git remote | grep -Fxq "$REMOTE_NAME" \
    || refuse "unknown remote: $REMOTE_NAME (not in \`git remote\`)"

# Effective push destination (F-B1): `git push <name>` honors
# remote.<name>.pushurl while `git ls-remote <name>` reads the FETCH url —
# with a divergent pushurl the checked range and the mutated repository would
# differ. Pin exactly ONE effective URL and use it for EVERY remote
# interaction (reads, re-verify, transport, post-push check). Multiple
# pushurls (git pushes to all of them) or multiple urls are refused.
# awk counting (never a nonzero-exit `grep -c`) and NF-filtering (never
# `head -n 1`, which could pick a blank line) keep this fail-closed with a
# receipt on every path.
count_nonempty() { awk 'NF{n++} END{print n+0}'; }
first_nonempty()  { awk 'NF{print; exit}'; }
PUSHURL_ALL=$(git config --get-all "remote.${REMOTE_NAME}.pushurl" 2>/dev/null || true)
URL_ALL=$(git config --get-all "remote.${REMOTE_NAME}.url" 2>/dev/null || true)
PUSH_URL_N=$(printf '%s\n' "$PUSHURL_ALL" | count_nonempty)
URL_N=$(printf '%s\n' "$URL_ALL" | count_nonempty)
if [ "$PUSH_URL_N" -ge 1 ]; then
    [ "$PUSH_URL_N" -eq 1 ] \
        || refuse "remote $REMOTE_NAME has $PUSH_URL_N pushurls configured — the wrapper refuses to push when the transport destination is not exactly one repository"
    PUSH_URL=$(printf '%s\n' "$PUSHURL_ALL" | first_nonempty)
else
    [ "$URL_N" -eq 1 ] \
        || refuse "remote $REMOTE_NAME must have exactly one url (found $URL_N) — ambiguous destination"
    PUSH_URL=$(printf '%s\n' "$URL_ALL" | first_nonempty)
fi
[ -n "$PUSH_URL" ] || refuse "could not resolve an effective push URL for $REMOTE_NAME"

# pushInsteadOf guard (round-2/3 B-F1): `git push <url>` applies
# url.<base>.pushInsteadOf prefix rewrites; `git ls-remote <url>` does not —
# an applicable rewrite would transport to a different repository than every
# pinned read. (Plain insteadOf is NOT guarded: it applies to fetch AND push
# equally, so reads and transport stay bound to one endpoint.) Parsing uses
# `git config -z` (entries are `key\nvalue`, NUL-terminated) which survives
# spaces inside <base> and <value>; an EMPTY rewrite value is refused by the
# prefix match itself (an empty prefix matches every URL — never skipped).
# The refusal text deliberately names NO URL and NO prefix: receipts are
# shareable and URLs can embed credentials (receipt contract: remote NAME
# only). Re-run before transport — config may change while checks run.
refuse_if_pushinsteadof_applies() {
    local entry instead_of
    while IFS= read -r -d '' entry; do
        instead_of="${entry#*$'\n'}"
        if [ -z "$instead_of" ]; then
            refuse "an empty url.<base>.pushInsteadOf value is configured for remote $REMOTE_NAME (an empty prefix may match every URL) — remove it before pushing"
        fi
        # LITERAL prefix test (no case-pattern glob semantics — a configured
        # base containing glob metacharacters must not fail the guard open).
        if [ "${PUSH_URL#"$instead_of"}" != "$PUSH_URL" ]; then
            refuse "an applicable url.<base>.pushInsteadOf rewrite was detected for remote $REMOTE_NAME — transport would diverge from the checked endpoint; remove the rewrite or push a URL it does not match"
        fi
    done < <(git config -z --get-regexp '^url\..*\.pushinsteadof$' 2>/dev/null || true)
}
refuse_if_pushinsteadof_applies

# --- resolve refspec (src branch + dst branch) ---------------------------------------------
SRC_BRANCH=""
DST_BRANCH=""
if [ -n "$REFSPEC_ARG" ]; then
    case "$REFSPEC_ARG" in
        +*) refuse "force refspecs are refused (+prefix): $REFSPEC_ARG" ;;
        refs/tags/*|*:refs/tags/*) refuse "tag refspecs are refused: $REFSPEC_ARG" ;;
        :*) refuse "deletion refspecs are refused (empty source): $REFSPEC_ARG" ;;
        *:) refuse "deletion refspecs are refused (empty destination): $REFSPEC_ARG" ;;
    esac
    case "$REFSPEC_ARG" in
        *:*) SRC_PART="${REFSPEC_ARG%%:*}"; DST_PART="${REFSPEC_ARG##*:}" ;;
        *)   SRC_PART="$REFSPEC_ARG"; DST_PART="$REFSPEC_ARG" ;;
    esac
    # git refspec semantics split at the FIRST colon; anything with residual
    # colons after that split is malformed input, not a nested ref (F-R5).
    N_COLONS=${REFSPEC_ARG//[!:]/}
    [ "${#N_COLONS}" -le 1 ] || refuse "refspec must contain at most one ':' (got ${#N_COLONS}): $REFSPEC_ARG"
    [ -n "$SRC_PART" ] || refuse "empty source in refspec: $REFSPEC_ARG"
    [ -n "$DST_PART" ] || refuse "empty destination in refspec: $REFSPEC_ARG"
    # Non-branch refs are refused in the PARENT shell (a refuse() inside a
    # command substitution would die without emitting the stdout receipt).
    for _part in "$SRC_PART" "$DST_PART"; do
        case "$_part" in
            refs/heads/*) : ;;
            refs/*) refuse "refspec halves must be branches, got non-branch ref: $_part" ;;
            *) : ;;
        esac
    done
    SRC_BRANCH="${SRC_PART#refs/heads/}"
    DST_BRANCH="${DST_PART#refs/heads/}"
else
    MERGE_REF=$(git config --get "branch.${CURRENT_BRANCH}.merge" 2>/dev/null) \
        || refuse "no upstream destination for branch ${CURRENT_BRANCH} (branch.${CURRENT_BRANCH}.merge unset) — pass an explicit refspec or set an upstream"
    case "$MERGE_REF" in
        refs/heads/*) : ;;
        *) refuse "unsupported upstream merge ref for ${CURRENT_BRANCH}: $MERGE_REF (only refs/heads/* initially)" ;;
    esac
    SRC_BRANCH="$CURRENT_BRANCH"
    DST_BRANCH="${MERGE_REF#refs/heads/}"
fi

# Refname validation (canonical): charset first, then git's own checker.
for _name in "$SRC_BRANCH" "$DST_BRANCH"; do
    printf '%s' "$_name" | grep -Eq '^[A-Za-z0-9._/-]+$' \
        || refuse "branch name has invalid characters: $_name"
    git check-ref-format "refs/heads/$_name" 2>/dev/null \
        || refuse "invalid branch refname: refs/heads/$_name"
done
[ -n "$SRC_BRANCH" ] || refuse "empty source branch"
[ -n "$DST_BRANCH" ] || refuse "empty destination branch"

if [ "$SRC_BRANCH" != "$CURRENT_BRANCH" ]; then
    refuse "source branch '$SRC_BRANCH' is not the current branch '$CURRENT_BRANCH' — the checked tree must be the pushed tree; checkout $SRC_BRANCH first"
fi

DST_REF="refs/heads/${DST_BRANCH}"

# --- resolve SHAs ---------------------------------------------------------------------------
SRC_SHA=$(git rev-parse --verify --quiet "refs/heads/${SRC_BRANCH}^{commit}" 2>/dev/null) \
    || refuse "source branch does not resolve to a commit: refs/heads/${SRC_BRANCH}"

ls_remote_dst() {
    # Prints the sha the remote holds at DST_REF (empty if absent); nonzero rc
    # on transport failure or an ambiguous answer. Read-only — mutates
    # nothing. Always reads $PUSH_URL (the pinned effective destination), so
    # checks can never bind to a different repository than transport mutates.
    local out n
    out=$(git ls-remote "$PUSH_URL" "$DST_REF" 2>/dev/null) || return 1
    n=$(printf '%s\n' "$out" | awk 'NF{n++} END{print n+0}')
    [ "$n" -le 1 ] || return 2
    printf '%s\n' "$out" | awk 'NR==1{print $1}'
}

LS_OUT=$(ls_remote_dst) || refuse "cannot read remote state unambiguously (git ls-remote $REMOTE_NAME $DST_REF)"
if [ -n "$LS_OUT" ]; then
    REMOTE_BEFORE="$LS_OUT"
    REMOTE_RESOLVED=1
else
    refuse "new-branch pushes are refused (remote $REMOTE_NAME has no $DST_REF); create the branch on the remote deliberately, then push with this wrapper"
fi

# Redact userinfo for the human stderr line (receipts carry no URL at all).
# Password payload optional: every authority form redacts — TOKEN@, TOKEN:@
# (explicitly empty password), :pass@, user:pass@.
PUSH_URL_DISPLAY=$(printf '%s' "$PUSH_URL" | sed -E 's#(://)([^/@:]*)(:[^/@]*)?@#\1***@#')
echo "push-checked: remote=$REMOTE_NAME pinned-dest=$PUSH_URL_DISPLAY src=$SRC_BRANCH dst=$DST_REF remote_before=$REMOTE_BEFORE head=$SRC_SHA" >&2

# --- fast-forward / up-to-date classification --------------------------------------------------
if [ "$REMOTE_BEFORE" = "$SRC_SHA" ]; then
    UP_TO_DATE=1
elif git merge-base --is-ancestor "$REMOTE_BEFORE" "$SRC_SHA" >/dev/null 2>&1; then
    : # fast-forward — the supported form
else
    refuse "not a fast-forward: remote $DST_REF is at $REMOTE_BEFORE, which is not an ancestor of $SRC_SHA — fetch/rebase first (force pushes are refused)"
fi

# --- scratch ------------------------------------------------------------------------------------
mkdir -p "$REPO_ROOT/tmp"
TMPDIR_PC=$(mktemp -d "$REPO_ROOT/tmp/push-checked.XXXXXX") || refuse "cannot create scratch dir under repo tmp/"
trap 'rm -rf "$TMPDIR_PC"' EXIT
P1_OUT="$TMPDIR_PC/prepush-stdout.json"

# --- run prepush-check over the EXACT outgoing range ----------------------------------------------
RANGE="${REMOTE_BEFORE}..${SRC_SHA}"
echo "push-checked: running prepush-check over exact outgoing range $RANGE" >&2

P1_RC=0
(
    unset PREPUSH_GIT   # test seam must never gate a real push
    exec timeout "${PREPUSH_CHECK_TIMEOUT_S:-3600}" bash "$PREPUSH" "$RANGE"
) >"$P1_OUT" || P1_RC=$?

# Extract what we can from the receipt for the wrapper receipt, best-effort.
if [ -s "$P1_OUT" ] && jq -e . "$P1_OUT" >/dev/null 2>&1; then
    P1_TIER=$(jq -r '.tier // ""' "$P1_OUT")
    P1_SELECTED=$(jq -c '.selected // []' "$P1_OUT")
    P1_TESTED_HEAD=$(jq -r '.tested_head // ""' "$P1_OUT")
    P1_BINDING=$(jq -r '.tree_binding // ""' "$P1_OUT")
    P1_DIGEST=$(sha256sum "$P1_OUT" | awk '{print $1}')
    P1_DURATION=$(jq -r '.total_duration_s // "null"' "$P1_OUT")
fi

if [ "$P1_RC" -eq 124 ] || [ "$P1_RC" -eq 137 ]; then
    refuse "prepush-check timed out (exit $P1_RC after PREPUSH_CHECK_TIMEOUT_S=${PREPUSH_CHECK_TIMEOUT_S:-3600}s) — stale evidence, refusing"
elif [ "$P1_RC" -eq 125 ] || [ "$P1_RC" -eq 126 ] || [ "$P1_RC" -eq 127 ]; then
    # timeout(1): 125 = bad --timeout value; 126/127 = command could not run.
    # Launcher failure is an environment refusal, never a check failure.
    refuse "prepush-check could not run (exit $P1_RC — bad PREPUSH_CHECK_TIMEOUT_S or launcher failure); nothing was transported"
elif [ "$P1_RC" -eq 2 ]; then
    P1_ERR=$(jq -r '.error // "prepush-check refused (exit 2)"' "$P1_OUT" 2>/dev/null || echo "prepush-check refused (exit 2)")
    refuse "prepush-check refused over range $RANGE: $P1_ERR"
elif [ "$P1_RC" -ne 0 ]; then
    P1_FAIL=$(jq -r '.failed_check // "?"' "$P1_OUT" 2>/dev/null || echo "?")
    check_red "prepush check failed (exit $P1_RC, failed check: $P1_FAIL) — fix before pushing; nothing was transported"
fi

# --- verify the receipt mechanically (fail-closed on ANY deviation) ------------------------------
P1_LINES=$(awk 'NF{n++} END{print n+0}' "$P1_OUT")
if [ "$P1_LINES" -ne 1 ]; then
    refuse "prepush receipt malformed: expected exactly one JSON line on stdout, got $P1_LINES"
fi
P1_VERIFY_ERR=$(jq -e --arg base "$REMOTE_BEFORE" --arg head "$SRC_SHA" '
    .schema == "prepush-check/1" and
    .ok == true and
    .dry_run == false and
    .mode == "range" and
    .base == $base and
    .head == $head and
    .tested_head == $head and
    .tree_binding == "exact" and
    ([.results[]? | select((.exit // -1) != 0)] | length == 0)
' "$P1_OUT" 2>&1 >/dev/null) || refuse "prepush receipt verification failed (schema/version/ok/binding/head/check-exits): $P1_VERIFY_ERR"

echo "push-checked: prepush receipt VERIFIED — schema=prepush-check/1 ok=true binding=exact head=$SRC_SHA tier=$P1_TIER selected=$P1_SELECTED" >&2

# --- re-verify every input immediately before transport (changed-input guard) ----------------------
HEAD_NOW=$(git rev-parse HEAD 2>/dev/null) || HEAD_NOW="unresolvable"
[ "$HEAD_NOW" = "$SRC_SHA" ] \
    || refuse "inputs changed between check and push: HEAD moved ($HEAD_NOW != $SRC_SHA) — re-run the wrapper"
SRC_NOW=$(git rev-parse --verify --quiet "refs/heads/${SRC_BRANCH}^{commit}" 2>/dev/null) || SRC_NOW="unresolvable"
[ "$SRC_NOW" = "$SRC_SHA" ] \
    || refuse "inputs changed between check and push: refs/heads/$SRC_BRANCH moved ($SRC_NOW != $SRC_SHA) — re-run the wrapper"
STATUS_NOW_RC=0
STATUS_NOW=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null) || STATUS_NOW_RC=$?
[ "$STATUS_NOW_RC" -eq 0 ] || refuse "inputs changed between check and push: git status failed (exit $STATUS_NOW_RC)"
[ -z "$STATUS_NOW" ] \
    || refuse "inputs changed between check and push: working tree is now dirty ($(printf '%s\n' "$STATUS_NOW" | awk 'NF{n++} END{print n+0}') entries) — commit/stash and re-run"
REMOTE_NOW=$(ls_remote_dst) || refuse "cannot re-read remote state before transport (git ls-remote failed)"
[ "$REMOTE_NOW" = "$REMOTE_BEFORE" ] \
    || refuse "inputs changed between check and push: remote $DST_REF moved ($REMOTE_NOW != $REMOTE_BEFORE) — re-run the wrapper"
# Config may have changed while the checks ran — re-run the rewrite guard so
# transport cannot be redirected away from the endpoint every read used.
refuse_if_pushinsteadof_applies

# --- push exactly the approved object --------------------------------------------------------------
if [ "$UP_TO_DATE" = "1" ]; then
    echo "push-checked: remote already at $SRC_SHA — nothing to transport (up-to-date green no-op)" >&2
    emit_receipt
    exit 0
fi

PUSH_SPEC="${SRC_SHA}:${DST_REF}"
echo "push-checked: pushing $PUSH_SPEC to $REMOTE_NAME" >&2

PUSH_RC=0
PUSH_T0=$(date +%s%N)
# --no-follow-tags (F-B2): with push.followTags=true git would additionally
# transport annotated tags reachable from the pushed commit — outside the
# single-refspec contract this wrapper enforces. Neutralize it explicitly.
# BOTH streams are captured: stdout is the receipt channel, and a client-side
# pre-push hook may write to it — hook chatter must never precede the JSON
# receipt on a successful push.
git push "$PUSH_URL" --no-follow-tags "$PUSH_SPEC" >"$TMPDIR_PC/push.out" 2>"$TMPDIR_PC/push.err" || PUSH_RC=$?
# Anything git (or a hook) wrote to push stdout belongs on the operator
# stderr channel, never on the receipt stdout channel.
[ -s "$TMPDIR_PC/push.out" ] && sed 's/^/push-checked: push-stdout: /' "$TMPDIR_PC/push.out" >&2
PUSH_T1=$(date +%s%N)
PUSH_DURATION=$(awk -v a="$PUSH_T0" -v b="$PUSH_T1" 'BEGIN{printf "%.3f",(b-a)/1000000000}')

if [ "$PUSH_RC" -ne 0 ]; then
    # Raw failure detail goes to the OPERATOR stderr channel (head+tail so
    # nothing actionable is lost); the shareable receipt gets a sanitized
    # form. git transport failures echo the destination URL exactly as
    # passed (userinfo included). SCRUB FIRST, TRUNCATE AFTER (the reverse
    # order could hide a leak beyond the cut): replace the exact pinned URL
    # with the remote NAME (literal bash substitution — no regex-metachar
    # pitfalls), then scrub any remaining url-shaped token, then cap length.
    RAW_FULL=$(tr '\n' ' ' < "$TMPDIR_PC/push.err" 2>/dev/null | sed 's/  */ /g')
    if [ -n "$RAW_FULL" ]; then
        echo "push-checked: git push stderr (raw): $(printf '%s' "$RAW_FULL" | cut -c1-400)$(printf '%s' "$RAW_FULL" | awk 'length>400{printf " …tail… %s", substr($0, length-199)}')" >&2
    else
        echo "push-checked: git push stderr (raw): <none>" >&2
    fi
    PUSH_ERR=$(printf '%s' "${RAW_FULL//"$PUSH_URL"/"$REMOTE_NAME"}" \
        | sed -E 's#[a-zA-Z][a-zA-Z0-9+.-]*://[^ ]+#\{url\}#g' \
        | cut -c1-500)
    refuse "git push failed (exit $PUSH_RC): ${PUSH_ERR:-<no stderr captured>}"
fi

# --- post-push verification ---------------------------------------------------------------------------
# Transport already happened by the time these checks run — reflect that in
# the receipt (pushed:true) and carry any uncertainty in ERROR_MSG.
REMOTE_AFTER=$(ls_remote_dst) || {
    PUSHED=1
    PUSHED_SHA="$SRC_SHA"
    ERROR_MSG="push transport succeeded but post-push ls-remote failed — verify $DST_REF on $REMOTE_NAME manually"
    OK_FLAG=0
    emit_receipt
    exit 2
}
if [ "$REMOTE_AFTER" != "$SRC_SHA" ]; then
    PUSHED=1
    PUSHED_SHA="$SRC_SHA"
    ERROR_MSG="post-push mismatch: remote $DST_REF is at ${REMOTE_AFTER:-<absent>}, expected $SRC_SHA"
    OK_FLAG=0
    emit_receipt
    exit 2
fi

PUSHED=1
PUSHED_SHA="$SRC_SHA"
echo "push-checked: PUSHED $PUSHED_SHA -> $REMOTE_NAME $DST_REF (verified)" >&2
emit_receipt
exit 0
