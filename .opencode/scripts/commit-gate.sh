#!/usr/bin/env bash
# commit-gate.sh — Gated-commit wrapper (lock-free concurrency, v2 metadata)
#
# Subcommands (recommended — file-based form):
#   acquire   --paths-file FILE --message-file FILE [--session-alias ALIAS]
#              [--rewrite-parity-contract FILE]
#              ^ rewrite-parity is OPT-IN: pass a contract file ONLY for an
#                explicitly-declared deletion/rewrite slice (mode:
#                deletion_replacement | modification_only_rewrite). Omit for
#                ordinary deletes/refactors/renames (zero burden).
#   commit    --uuid UUID --tree-hash HASH --message-file FILE
#   release   [--uuid UUID] [--message-file FILE]
#   heartbeat --uuid UUID
#   status
#   revert    --paths '<JSON_ARRAY>' | --paths-file FILE | <path> [<path>...]
#   stage-message --uuid UUID    # (deprecated) reads message from STDIN,
#                                # writes msg-${UUID} atomically (temp + rename)
#
# Subcommands (legacy — inline form, avoid for messages with newlines/backticks):
#   acquire   --paths JSON_ARRAY [--message MSG] [--session-alias ALIAS]
#   commit    --uuid UUID --tree-hash HASH --message MSG
#
# File-based args take precedence when both forms are provided.
# Paths file: newline-separated (one path per line).
# Message file: raw text (trailing newline stripped).
#
# revert: restores working-tree paths to HEAD with NO lock / NO CAS / NO
#   private index — the sanctioned alternative to SKIP_COMMIT_GATE=1 for
#   unblocking a session whose working-tree edits collided with a concurrent
#   committer. Two-tier in-repo path validation (lexical + realpath) mirrors
#   validateGitCPath in .opencode/plugins/shell-guard.js.
#
# Environment:
#   SKIP_COMMIT_GATE=1         — bypass all gating, run git directly (operator-only, host terminal)
#   COMMIT_GATE_TTL_SECONDS=N  — lock TTL in seconds (default 600)
#
# Lock dir: .git/commit-gate.lock/ (mkdir-based atomic lock, held only during acquire)
# Lock metadata: .git/commit-gate.lock/meta (JSON v2)
# Private index: .git/commit-gate/index-${UUID} (GIT_INDEX_FILE)
# Agent msg scratch: tmp/commit-gate-message/msg-${UUID} (committer-authored via the
#   Write tool; reclaimed by this gate on success/release/no_changes + aged-orphan GC)
#
# NOTE: SKIP_COMMIT_GATE acquire path still uses `git add -A`.
#       The gated cmd_acquire path stages via private index (GIT_INDEX_FILE).
#       Verification commands should scope to cmd_acquire only.
set -euo pipefail

# ---------------------------------------------------------------------------
# Pre-commit config validation (scoped to acquire/commit only)
# ---------------------------------------------------------------------------
_config_validate() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  python3 "${script_dir}/validate-opencode-config.py" || {
    echo "commit-gate: opencode config validation failed (see above)" >&2
    return 1
  }
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LOCK_DIR=".git/commit-gate.lock"
LOCK_META="${LOCK_DIR}/meta"
DEFAULT_TTL=600
GATE_INDEX_DIR=".git/commit-gate"
CAS_MAX_RETRY=3
# GC: scratch files (msg-/paths-/meta-/index-/merge-) older than this many
# seconds are eligible for best-effort orphan sweep on successful commit and
# at the end of release. Env: COMMIT_GATE_GC_MAX_AGE. The GC also reclaims the
# AGENT-OWNED message scratch at $MSG_SCRATCH_DIR/msg-${UUID} (the committer
# writes this path with the Write tool; `rm` is not in any agent's bash
# permission map, so the gate owns its reclamation). Same age gate +
# protected-UUID skip apply there.
DEFAULT_GC_MAX_AGE=3600
# Agent-owned commit-message scratch dir (cwd-relative on purpose — tracks
# the target repo = current working dir, mirroring $GATE_INDEX_DIR). The
# committer authors the message here with the Write tool; the gate reclaims
# msg-${UUID} on success/release/no_changes AND sweeps aged orphans here.
MSG_SCRATCH_DIR="tmp/commit-gate-message"
# Durable closeout ledger (JSON-lines, append-only). Survives the per-session
# meta-*/index-*/msg-*/paths-*/merge-* cleanup — those prefixes are the ONLY
# files _cleanup_own_scratch / _gate_gc_sweep touch, so closeouts.log is never
# reclaimed by them. Sub-item 1 (disposition §4.2): records post-commit HEAD
# alongside the existing per-session head_at_acquire so doctor's HEAD-staleness
# check (#19) can read the tail for N-flatline detection after the transient
# session meta is gone. GC: count cap via COMMIT_GATE_CLOSEOUT_LOG_MAX (default
# DEFAULT_CLOSEOUT_LOG_MAX) — _gate_gc_sweep trims to the tail when exceeded.
# Lives under .git/ → gitignored by nature, never committed, never under .local/.
CLOSEOUT_LOG="${GATE_INDEX_DIR}/closeouts.log"
DEFAULT_CLOSEOUT_LOG_MAX=200
# Dedicated lockfile serializing closeout-ledger mutation (append + count-cap
# trim). The commit path is otherwise lock-free after acquire; this narrow,
# ledger-local flock prevents a concurrent GC trim's tail→tmp→mv from dropping a
# record appended by another successful committer in the snapshot-to-rename
# window (a lost closeout could mask the exact HEAD-flatline doctor #19 surfaces).
# Both _closeout_append and the _gate_gc_sweep trim acquire it exclusively.
CLOSEOUT_LOCK="${GATE_INDEX_DIR}/closeouts.lock"
# Persistent session metadata survives the lock-free review phase.
# Each session stores its metadata at ${GATE_INDEX_DIR}/meta-${UUID}.
#
# SECURITY: $1 can be CALLER-CONTROLLED (release's no-lock branch forwards
# the raw --uuid here verbatim at ~line 1030; cmd_heartbeat at ~line 1277;
# cmd_commit at ~line 855). Refuse to interpolate a malformed value into the
# path — a traversal payload like 'x/../../config' would make meta-${u}
# resolve out of ${GATE_INDEX_DIR} and reach an arbitrary file, and the
# result feeds rm -f / cat / write at the call sites (deletion, read, AND
# overwrite classes). Same charset convention as the _cleanup_own_scratch
# uuid guard (~line 245) and cmd_stage_message (~line 1606). A non-conforming
# uuid echoes "" and returns 0 (NOT 1 — `var="$(...)"` call sites like the
# release/commit/heartbeat branches run under `set -e`, so a non-zero return
# would kill the shell; the empty string is the reject signal) so every
# downstream sink becomes a safe no-op: `rm -f ""` is a no-op (and call sites
# add `|| true`); read sites guard with `[[ -f "$session_meta" ]]` (empty fails
# -f); the one bare write redirect (~line 804) uses the internal _uuid, whose
# gen-uuid output is standard [0-9a-f-]+ UUIDs — a strict subset — so the
# guard never trips in the legit acquire→commit→release flow.
_session_meta_path() {
  local u="$1"
  if [[ -n "$u" && ! "$u" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo ""
    return 0
  fi
  echo "${GATE_INDEX_DIR}/meta-${u}"
}

# cwd-independent anchors — commit-gate.sh is invoked from temp/scratch git
# repos during tests and from subdirectories in production, so paths to its
# sibling helper scripts must NOT depend on $PWD. Only .git/* paths stay
# relative on purpose (they track the target repo = current working dir).
_GATE_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly _GATE_SELF_DIR
_GATE_RO_SCRIPT="${_GATE_SELF_DIR}/readonly-scripts.sh"
readonly _GATE_RO_SCRIPT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

json_out() { printf '%s\n' "$1"; }

# Proper JSON string encoding — handles quotes, backslashes, control chars.
json_encode() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'
}

_uuid() {
  "$_GATE_RO_SCRIPT" gen-uuid
}

_iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
_hostname() { hostname 2>/dev/null || echo "unknown"; }

_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

_lock_age_seconds() {
  local lockdir="$1"
  local now epoch
  now=$(date +%s)
  epoch=$(stat -c %Y "$lockdir" 2>/dev/null || echo 0)
  echo $(( now - epoch ))
}

_file_age_seconds() {
  local filepath="$1"
  local now epoch
  now=$(date +%s)
  # On stat FAILURE, treat the file as FRESH (epoch=now => age=0), never as
  # epoch=0 (which would yield age=now ≈ 1.7e9 and make the file look aged).
  # This is load-bearing: a transient stat failure under contention must not
  # cause a UUID-protected in-use scratch file to be reaped. All consumers
  # (incl. _protected_uuids and _gate_gc_sweep) keep files whose age <=
  # max_age, so age=0 => retention. Do NOT change this back to `|| echo 0`.
  epoch=$(stat -c %Y "$filepath" 2>/dev/null || echo "$now")
  echo $(( now - epoch ))
}

_heartbeat_age_seconds() {
  local hb="$1"
  # Use python3 for reliable ISO 8601 parsing across container environments.
  # Returns 999999 on parse failure (treat as "very stale" — safe default).
  python3 -c "
import sys
from datetime import datetime, timezone
try:
    s = sys.argv[1]
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    dt = datetime.fromisoformat(s)
    now = datetime.now(timezone.utc)
    print(int((now - dt).total_seconds()))
except:
    print(999999)
" "$hb" 2>/dev/null || echo 999999
}

# Extract a JSON string field from lock content (simple python parsing for robustness)
_field_str() {
  local json="$1" key="$2"
  echo "$json" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    val = d.get(sys.argv[1], '')
    if val is None:
        print('')
    else:
        print(val)
except:
    print('')
" "$key" 2>/dev/null
}

_field_num() {
  local json="$1" key="$2"
  echo "$json" | grep -o "\"${key}\":[0-9]*" | head -1 | cut -d: -f2
}

_cleanup_private_index() {
  local meta_content="$1"
  local pidx
  pidx=$(_field_str "$meta_content" "private_index")
  if [[ -n "$pidx" && -f "$pidx" ]]; then
    rm -f "$pidx" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# GC: best-effort scratch-file cleanup (post-success commit + release only)
# ---------------------------------------------------------------------------

# Validate a caller-supplied --message-file path for PRIVILEGED reclamation.
# Echoes the raw path iff it is repo-relative AND lexically normalizes to
# ${MSG_SCRATCH_DIR}/msg-* (i.e. tmp/commit-gate-message/msg-<suffix>); echoes
# nothing (safe-reject) otherwise. Rejects: empty, absolute paths, and any path
# containing a '..' segment (a legit agent-authored scratch path never does).
# Pure lexical (no fs reads); mirrors the backlog-preflight normalization.
# SECURITY: this is the chokepoint that lets cmd_commit/cmd_release forward a
# CALLER-CONTROLLED --message-file into the gate's privileged rm (rm is denied
# to all agents; the gate owns it). Without this, `release --message-file
# README.md` or `.git/config` would reach rm -f and delete an arbitrary file.
_safe_msg_reclaim_path() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && return 0
  # Reject absolute paths outright.
  [[ "$raw" == /* ]] && return 0
  local seg="$raw" part
  local -a stk=()
  while [[ -n "$seg" ]]; do
    [[ "$seg" == /* ]] && seg="${seg:1}"
    if [[ "$seg" == */* ]]; then
      part="${seg%%/*}"
      seg="${seg#*/}"
    else
      part="$seg"
      seg=""
    fi
    case "$part" in
      ""|".") continue ;;
      "..")
        # Any '..' either escapes (empty stack) or climbs above the prefix;
        # either way the path cannot remain under ${MSG_SCRATCH_DIR}/msg-, so
        # reject the whole path. Legit scratch paths have no '..'.
        return 0
        ;;
      *) stk+=("$part") ;;
    esac
  done
  local norm=""
  ((${#stk[@]})) && norm="$(IFS=/; printf '%s' "${stk[*]}")"
  [[ "$norm" == "${MSG_SCRATCH_DIR}/msg-"* ]] && printf '%s' "$raw"
  return 0
}

# Remove this session's own message/paths scratch files. Best-effort and
# post-success ONLY — never called before the gate has finished reading them
# (cmd_commit reads --message-file at commit time, so own-UUID removal must
# be strictly after update-ref succeeds).
_cleanup_own_scratch() {
  local uuid="$1"
  [[ -z "$uuid" ]] && return 0
  # SECURITY: $uuid can be CALLER-CONTROLLED (release's no-lock branch forwards
  # the raw --uuid here verbatim at line ~1035). Refuse to interpolate a value
  # containing path or shell-dangerous chars into the privileged rm below —
  # blocks traversal payloads like 'x/../../../.git/config' that would otherwise
  # resolve out of the scratch dir and delete an arbitrary file (rm is denied to
  # all agents; the gate owns this primitive). Same charset guard as
  # cmd_stage_message's uuid validation (~line 1595). A non-conforming uuid
  # skips the uuid-derived rms (no-ops on benign paths); the message_file
  # reclaim below is independent and validated separately via _safe_msg_reclaim_path.
  if [[ "$uuid" =~ ^[A-Za-z0-9_-]+$ ]]; then
    rm -f "${GATE_INDEX_DIR}/msg-${uuid}" "${GATE_INDEX_DIR}/paths-${uuid}" 2>/dev/null || true
    # Also reclaim the AGENT-OWNED message scratch ($MSG_SCRATCH_DIR/msg-${UUID}).
    # `rm` is not in any agent's bash permission map, so the gate owns this path.
    # Best-effort; the dir may be absent in test/scratch repos.
    rm -f "${MSG_SCRATCH_DIR}/msg-${uuid}" 2>/dev/null || true
  fi
  # Optionally reclaim the ACTUAL --message-file path (caller passes $message_file
  # from cmd_commit/cmd_release). Needed because acquire generates its OWN
  # gate-session uuid (stored as the session uuid), which differs from the
  # agent's pre-acquire gen-uuid used to NAME the msg scratch file — so the
  # uuid-derived rm above is a no-op for agent-authored files. Passing the real
  # path reclaims it promptly at commit/release time instead of waiting for aged
  # GC. The guard makes inline --message (empty message_file) a safe no-op.
  #
  # SECURITY: the rm below is the gate's privileged primitive. _safe_msg_reclaim_path
  # constrains $msg_file to the agent-owned scratch surface (${MSG_SCRATCH_DIR}/msg-*)
  # AFTER lexical normalization (rejecting absolute + '..'), so a caller-supplied
  # --message-file README.md / .git/config CANNOT reach rm. This single chokepoint
  # protects commit/no_changes/release uniformly. Best-effort (|| true).
  local msg_file="${2:-}"
  local safe_path
  safe_path="$(_safe_msg_reclaim_path "$msg_file")"
  [[ -n "$safe_path" ]] && rm -f "$safe_path" 2>/dev/null || true
}

# Append a closeout record to the durable ledger ($CLOSEOUT_LOG). This is the
# substrate sub-item 1 (disposition §4.2) adds: it records post-commit HEAD
# alongside the existing per-session head_at_acquire, surviving the session-meta
# cleanup so doctor (#19) can read the tail for N-flatline detection. JSON-lines,
# append-only, one record per line — each printf >> is a single write under
# PIPE_BUF so concurrent committers do not interleave records. Best-effort:
# never returns non-zero, never writes to stdout (call sites run under set -e).
# Fields: uuid, acquired_at, head_at_acquire (acquire-time HEAD), post_commit_head
# (branch HEAD after the commit landed), status, branch, ts.
_closeout_append() {
  local uuid="$1" acquired_at="$2" head_at_acquire="$3"
  local post_commit_head="$4" status="$5" branch="$6"
  # SECURITY: $uuid is caller-influenced (lock_uuid read from session meta, and
  # session meta is populated from acquire's internal _uuid which is gen-uuid
  # output — a strict [0-9a-f-]+ subset — but defend as if it could be anything).
  # Charset-guard before interpolating into the JSON string so a payload cannot
  # break out. head/post are git SHAs (hex) or empty; status is an internal vocab
  # token; branch comes from `git branch --show-current` and is json_encode'd.
  if [[ -z "$uuid" || ! "$uuid" =~ ^[A-Za-z0-9_-]+$ ]]; then
    return 0
  fi
  if [[ ! "$status" =~ ^[A-Za-z0-9_-]+$ ]]; then
    return 0
  fi
  local enc_branch ts
  enc_branch="$(json_encode "$branch")"
  ts="$(_iso_now)"
  # mkdir guards the test/scratch-repo case (GATE_INDEX_DIR may not exist yet).
  mkdir -p "$GATE_INDEX_DIR" 2>/dev/null || true
  # Build the record once (printf -v, no subshell), then append under the
  # ledger-local flock so a concurrent _gate_gc_sweep count-cap trim cannot
  # drop this record in its snapshot-to-rename window. If flock is unavailable
  # (non-Linux), append unlocked — concurrent appends are still atomic under
  # PIPE_BUF, and the trim SKIPS when flock is absent (see _gate_gc_sweep), so
  # there is no append-vs-trim race to lose a record to.
  local line
  printf -v line '{"uuid":"%s","acquired_at":"%s","head_at_acquire":"%s","post_commit_head":"%s","status":"%s","branch":%s,"ts":"%s"}' \
    "$uuid" "$acquired_at" "$head_at_acquire" "$post_commit_head" "$status" "$enc_branch" "$ts"
  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 9 2>/dev/null || exit 1
      printf '%s\n' "$line" >> "$CLOSEOUT_LOG" 2>/dev/null
    ) 9>"$CLOSEOUT_LOCK" 2>/dev/null || true
  else
    printf '%s\n' "$line" >> "$CLOSEOUT_LOG" 2>/dev/null || true
  fi
}

# Build the protected-UUID set: the active lock's UUID, the _current_uuid
# marker, and every UUID whose session meta-* is fresh (mtime <= max_age).
# Echoed one UUID per line on stdout; callers collect into an array.
#
# THIS IS THE SINGLE SOURCE shared by _gate_gc_sweep (canonical GC at
# no_changes/commit/release) AND the acquire-time scratch cleanup. The two
# call sites MUST share one construction: hand-duplicating them was the root
# cause of the 3daca70 acquire-time-sweep bug (the two copies drifted and the
# acquire path lost the protected-UUID skip, rm'ing LIVE concurrent sessions'
# meta-*/index-* scratch). Centralizing here means a future edit cannot
# re-diverge the protected-UUID SET CONSTRUCTION itself — each caller still
# independently supplies its max_age and owns its own prefix-scoped reaping,
# so the surrounding cleanup CONTRACTS can still drift through caller-side
# edits; this helper only guarantees the membership set they consult is
# identical.
#
# Arg 1: max_age (seconds) — the SCRATCH-retention threshold
# (COMMIT_GATE_GC_MAX_AGE, default DEFAULT_GC_MAX_AGE). NOT the lock TTL
# (COMMIT_GATE_TTL_SECONDS): that is a different concept (LOCK staleness) and
# must never be threaded in here. A session is "fresh" (protected) iff its
# meta-* mtime is <= max_age.
_protected_uuids() {
  local max_age="$1"
  # Active lock UUID.
  if [[ -d "$LOCK_DIR" ]]; then
    local lock_content lock_uuid
    lock_content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
    lock_uuid=$(_field_str "$lock_content" "uuid")
    [[ -n "$lock_uuid" ]] && printf '%s\n' "$lock_uuid"
  fi
  # Most-recently-active session marker.
  local cu_file="${GATE_INDEX_DIR}/_current_uuid"
  if [[ -f "$cu_file" ]]; then
    local cu_val
    cu_val=$(tr -d '[:space:]' < "$cu_file" 2>/dev/null || true)
    [[ -n "$cu_val" ]] && printf '%s\n' "$cu_val"
  fi
  # Fresh session-meta UUIDs (active concurrent sessions).
  local m
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local m_age
    m_age=$(_file_age_seconds "$m" 2>/dev/null || echo "0")
    if [[ $m_age -le $max_age ]]; then
      printf '%s\n' "${m#${GATE_INDEX_DIR}/meta-}"
    fi
  done < <(ls -1 "${GATE_INDEX_DIR}"/meta-* 2>/dev/null)
}

# Sweep aged orphan scratch files (msg-/paths-/meta-/index-/merge-) from
# $GATE_INDEX_DIR. Best-effort: never returns non-zero, never writes to stdout
# (diagnostics suppressed). Two layers protect a live/concurrent session:
#   1. Age gate: only files with mtime older than COMMIT_GATE_GC_MAX_AGE
#      (default DEFAULT_GC_MAX_AGE) are removed. This is the primary
#      concurrency safeguard — a fresh concurrent committer's scratch is
#      always younger than the threshold.
#   2. Protected-UUID skip: UUIDs from the active lock, _current_uuid, and
#      any UUID whose meta-* session file is fresh (younger than max_age) are
#      never removed even if their other scratch files are artificially aged
#      (defense-in-depth for concurrent lock-free sessions). Built via the
#      shared _protected_uuids helper so this contract cannot drift from the
#      acquire-time cleanup's.
_gate_gc_sweep() {
  local max_age="${COMMIT_GATE_GC_MAX_AGE:-$DEFAULT_GC_MAX_AGE}"

  # Early-out only when BOTH scratch surfaces are absent. $MSG_SCRATCH_DIR may
  # hold agent-owned message orphans even when $GATE_INDEX_DIR was cleaned, so
  # the gate must still get a chance to sweep it.
  [[ ! -d "$GATE_INDEX_DIR" && ! -d "$MSG_SCRATCH_DIR" ]] && return 0

  # Build the protected-UUID set via the shared helper (also used by the
  # acquire-time cleanup). See _protected_uuids for why these two call sites
  # MUST share one construction.
  local protected_uuids=()
  while IFS= read -r puuid; do
    [[ -n "$puuid" ]] && protected_uuids+=("$puuid")
  done < <(_protected_uuids "$max_age")

  local prefix
  for prefix in msg- paths- meta- index- merge-; do
    local f
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      # UUID suffix = filename with "$GATE_INDEX_DIR/$prefix" stripped.
      local fuuid
      fuuid="${f#${GATE_INDEX_DIR}/${prefix}}"
      # Skip protected UUIDs (exact string match on the UUID portion).
      local is_protected=false
      if [[ ${#protected_uuids[@]} -gt 0 ]]; then
        local prot
        for prot in "${protected_uuids[@]}"; do
          if [[ "$fuuid" == "$prot" ]]; then
            is_protected=true
            break
          fi
        done
      fi
      [[ "$is_protected" == "true" ]] && continue
      # Age gate — protect fresh (concurrent committer) files.
      local age
      age=$(_file_age_seconds "$f" 2>/dev/null || echo "0")
      if [[ $age -gt $max_age ]]; then
        rm -f "$f" 2>/dev/null || true
      fi
    done < <(ls -1 "${GATE_INDEX_DIR}/${prefix}"* 2>/dev/null)
  done

  # Sweep aged orphans in the AGENT-OWNED message scratch dir. The committer
  # writes $MSG_SCRATCH_DIR/msg-${UUID} with the Write tool; `rm` is not in
  # any agent's bash permission map, so the gate owns reclamation here. Only
  # the msg-* prefix is swept — never touch other tmp/ content (other tooling
  # may use tmp/). Same age gate + protected-UUID skip as $GATE_INDEX_DIR.
  if [[ -d "$MSG_SCRATCH_DIR" ]]; then
    local f
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      local fuuid
      fuuid="${f#${MSG_SCRATCH_DIR}/msg-}"
      local is_protected=false
      if [[ ${#protected_uuids[@]} -gt 0 ]]; then
        local prot
        for prot in "${protected_uuids[@]}"; do
          if [[ "$fuuid" == "$prot" ]]; then
            is_protected=true
            break
          fi
        done
      fi
      [[ "$is_protected" == "true" ]] && continue
      local age
      age=$(_file_age_seconds "$f" 2>/dev/null || echo "0")
      if [[ $age -gt $max_age ]]; then
        rm -f "$f" 2>/dev/null || true
      fi
    done < <(ls -1 "${MSG_SCRATCH_DIR}"/msg-* 2>/dev/null)
  fi

  # Cap the durable closeout ledger by record count (keep the most recent N),
  # serialized under the ledger-local flock so the tail→tmp→mv replacement
  # cannot drop a record appended by a concurrent successful committer. The
  # count is RE-READ inside the lock (a concurrent append may have grown it
  # between the outer read and the trim). If flock is unavailable (non-Linux),
  # SKIP the trim entirely — no trim means no append-vs-trim race, so the ledger
  # stays correct (just unbounded) rather than risking a lost record. Best-effort:
  # never fails the sweep.
  if [[ -f "$CLOSEOUT_LOG" ]] && command -v flock >/dev/null 2>&1; then
    local log_max="${COMMIT_GATE_CLOSEOUT_LOG_MAX:-$DEFAULT_CLOSEOUT_LOG_MAX}"
    local _tmp="${CLOSEOUT_LOG}.tmp.$$"
    (
      flock -x 9 2>/dev/null || exit 1
      lc=$(wc -l < "$CLOSEOUT_LOG" 2>/dev/null || echo "0")
      if [[ "$lc" -gt "$log_max" ]]; then
        d=$((lc - log_max))
        if tail -n +"$((d + 1))" "$CLOSEOUT_LOG" > "$_tmp" 2>/dev/null; then
          mv "$_tmp" "$CLOSEOUT_LOG" 2>/dev/null || rm -f "$_tmp" 2>/dev/null || true
        else
          rm -f "$_tmp" 2>/dev/null || true
        fi
      else
        rm -f "$_tmp" 2>/dev/null || true
      fi
    ) 9>"$CLOSEOUT_LOCK" 2>/dev/null || true
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Stale-break (spec §3.4): remove stale lock directory
# ---------------------------------------------------------------------------
_stale_break() {
  local lockdir="$1" expected_uuid="$2"
  local stale_backup="${lockdir}.stale.$$"

  # Fail-safe: refuse to break a lock whose expected identity is empty. An
  # empty expected_uuid means _is_stale could not read the lock's uuid
  # (absent/unparseable meta — a half-born lock). The verify-after-move below
  # compares actual_uuid != expected_uuid; with both empty that guard is
  # vacuously FALSE and we would proceed to destroy a LIVE lock, breaking
  # mutual exclusion (half-born-lock-stale-break). _is_stale now returns
  # non-stale for this case, so this path is unreachable in the normal acquire
  # flow; this guard is defense-in-depth against any future caller reaching
  # here with an empty uuid. Never move/destroy a lock we cannot identify.
  if [[ -z "$expected_uuid" ]]; then
    return 1
  fi

  # Atomic claim: move the lock dir to our unique backup path.
  # If mv fails, another process already moved/removed it. That's fine.
  mv "$lockdir" "$stale_backup" 2>/dev/null || return 0

  # We now own whatever was at lockdir. Verify it's the stale lock we expected.
  local actual_meta actual_uuid
  actual_meta=$(cat "${stale_backup}/meta" 2>/dev/null || echo "{}")
  actual_uuid=$(_field_str "$actual_meta" uuid)

  if [[ "$actual_uuid" != "$expected_uuid" ]]; then
    # We accidentally moved a FRESH lock! Put it back immediately.
    mv "$stale_backup" "$lockdir" 2>/dev/null || true
    return 0
  fi

  # Confirmed: we moved the correct stale lock. Clean up private index first.
  local stale_meta="${stale_backup}/meta"
  if [[ -f "$stale_meta" ]]; then
    local stale_content stale_uuid
    stale_content=$(cat "$stale_meta" 2>/dev/null || echo "{}")
    _cleanup_private_index "$stale_content"
    # Also clean up persistent session metadata
    stale_uuid=$(_field_str "$stale_content" "uuid")
    if [[ -n "$stale_uuid" ]]; then
      rm -f "$(_session_meta_path "$stale_uuid")" 2>/dev/null || true
    fi
  fi

  # Now remove the stale lock directory
  rm -rf "$stale_backup" 2>/dev/null || true

  return 0
}

# ---------------------------------------------------------------------------
# Is current lock stale?
# ---------------------------------------------------------------------------
_is_stale() {
  STALE_UUID=""
  local lockdir="$1"
  local content pid hb ttl lock_hname cur_hname uuid_from_meta
  ttl="${COMMIT_GATE_TTL_SECONDS:-$DEFAULT_TTL}"

  [[ ! -d "$lockdir" ]] && return 1

  content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
  pid=$(_field_num "$content" "pid")
  hb=$(_field_str "$content" "heartbeat_at")
  lock_hname=$(_field_str "$content" "hostname")
  cur_hname=$(_hostname)
  uuid_from_meta=$(_field_str "$content" "uuid")

  # Fail-safe: absent/unparseable meta means the lock is being born (mkdir done,
  # meta not yet written) or is corrupt. In EITHER case we cannot identify it
  # for the verify-after-move in _stale_break — treating it as stale would let a
  # concurrent acquirer destroy a LIVE lock and break mutual exclusion
  # (half-born-lock-stale-break). The empty uuid is the absence signal (no
  # readable heartbeat, pid, or uuid — content collapsed to "{}"). Modeled on
  # internal/cli/profile.go corpusDefaultFeatures: fail-safe, not fail-open.
  # NOTE: this does NOT weaken stale recovery — every genuinely-stale path
  # below requires a readable meta (expired heartbeat, dead pid, cross-host),
  # all of which carry a non-empty uuid. Only the no-meta half-born state is
  # affected, and that state is a LIVE lock mid-birth, never legitimately stale.
  if [[ -z "$uuid_from_meta" ]]; then
    return 1  # cannot identify → not stale (lock being born or corrupt)
  fi

  # Primary check: heartbeat TTL
  # If heartbeat is fresh (within TTL), the lock is NOT stale regardless of PID.
  # This handles the real-world case where each commit-gate.sh invocation is a
  # separate process — the PID will always be dead, but the heartbeat remains valid.
  if [[ -n "$hb" ]]; then
    local age
    age=$(_heartbeat_age_seconds "$hb")
    if [[ $age -le $ttl ]]; then
      return 1  # heartbeat fresh → not stale
    fi
  fi

  # Heartbeat expired (or missing). Check PID with hostname guard.
  if [[ -n "$pid" ]]; then
    if [[ "$lock_hname" != "$cur_hname" ]]; then
      # Different host — can't verify PID, treat as stale ONLY if heartbeat expired
      STALE_UUID="$uuid_from_meta"
      return 0
    fi
    # Same host — check PID liveness
    if ! _pid_alive "$pid"; then
      STALE_UUID="$uuid_from_meta"
      return 0  # dead PID on same host → stale
    fi
  fi

  # Heartbeat expired but PID alive on same host — still stale (process is hung)
  STALE_UUID="$uuid_from_meta"
  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: acquire
# ---------------------------------------------------------------------------
cmd_acquire() {
  # Config validation: gate on acquire so broken config blocks commits,
  # but does NOT block release/status/escape-hatch recovery.
  _config_validate

  local message="" paths="" session_alias=""
  local paths_provided=false
  local message_file="" paths_file=""
  local rewrite_parity_contract=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --message)       message="$2";       shift 2 ;;
      --message-file)  message_file="$2";  shift 2 ;;
      --paths)         paths="$2"; paths_provided=true; shift 2 ;;
      --paths-file)    paths_file="$2";    shift 2 ;;
      --session-alias) session_alias="$2"; shift 2 ;;
      --rewrite-parity-contract) rewrite_parity_contract="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # File-based args take precedence over inline args
  if [[ -n "$message_file" ]]; then
    if [[ ! -r "$message_file" ]]; then
      json_out "{\"status\":\"error\",\"reason\":\"message_file_unreadable\",\"file\":\"${message_file}\"}"
      return 1
    fi
    message=$(cat "$message_file")
  fi

  if [[ -n "$paths_file" ]]; then
    if [[ ! -r "$paths_file" ]]; then
      json_out "{\"status\":\"error\",\"reason\":\"paths_file_unreadable\",\"file\":\"${paths_file}\"}"
      return 1
    fi
    # Read newline-separated paths and convert to JSON array
    paths=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    lines = [l.strip() for l in f if l.strip()]
print(json.dumps(lines))
" "$paths_file" 2>/dev/null) || {
      json_out "{\"status\":\"path_error\",\"reason\":\"paths_file_parse_failed\",\"file\":\"${paths_file}\"}"
      return 1
    }
    paths_provided=true
  fi

  # -------------------------------------------------------------------
  # Validate --paths BEFORE any state mutation (spec: validate-first)
  # -------------------------------------------------------------------
  if [[ "$paths_provided" != "true" ]]; then
    json_out "{\"status\":\"path_error\",\"reason\":\"paths_required\"}"
    return 1
  fi

  if [[ -z "$paths" ]]; then
    json_out "{\"status\":\"path_error\",\"reason\":\"paths_json_invalid\"}"
    return 1
  fi

  # Parse JSON array of paths
  # Use subshell + || true to prevent set -e from exiting on parse failure
  local path_list parse_rc
  parse_rc=0
  path_list=$(python3 -c "
import json, sys
paths = json.loads(sys.stdin.read())
if not isinstance(paths, list) or not all(isinstance(x, str) for x in paths):
    sys.exit(1)
print('\n'.join(paths))
" <<< "$paths" 2>/dev/null) || parse_rc=$?

  # Detect malformed JSON (spec §F3: distinguish parse failure from empty)
  if [[ $parse_rc -ne 0 ]]; then
    json_out "{\"status\":\"path_error\",\"reason\":\"paths_json_invalid\"}"
    return 1
  fi

  if [[ -z "$path_list" && "$paths" != "[]" ]]; then
    # Non-empty JSON input produced empty output without error — shouldn't happen
    # but guard against silent parse issues
    json_out "{\"status\":\"path_error\",\"reason\":\"paths_json_invalid\"}"
    return 1
  fi

  # -------------------------------------------------------------------
  # O1 packaging-policy preflight (W2/split-commit enforcement).
  #
  # This is NOT a merge-algorithm change — it is a pre-acquire path-list
  # guard. The shared docs/planning/backlog.md ledger MUST NOT travel in the
  # same commit as code/docs changes: a concurrent backlog edit would
  # cas_conflict the entire code commit (the original W1 problem). With no
  # real-time per-edit nudge achievable in opencode v1.14.x, agents learn the
  # discipline HERE, at the commit boundary — the rejection message below IS
  # the teaching, which makes split-commit ENFORCED rather than advisory.
  #
  # ALLOW: docs/planning/backlog.md alone, OR a path list with no backlog file.
  # REJECT: docs/planning/backlog.md appears alongside any other path.
  #
  # Path comparison is NORMALIZED, not exact-string: a git-valid but
  # non-canonical spelling (./prefix, embedded /./, /../ collapse) must still
  # trip the guard. Reuses the same lexical stack algorithm as
  # _validate_in_repo_path (ports normalizeGitCPath): split on '/', drop "."
  # and empty segments, pop the stack on "..". No fs reads (lexical only).
  # -------------------------------------------------------------------
  local _has_backlog=0 _total_paths=0 _p _seg _part
  local -a _stk
  while IFS= read -r _p; do
    [[ -z "$_p" ]] && continue
    _total_paths=$((_total_paths + 1))
    # Lexical normalization to canonical repo-relative form.
    _stk=()
    _seg="$_p"
    while [[ -n "$_seg" ]]; do
      [[ "$_seg" == /* ]] && _seg="${_seg:1}"
      if [[ "$_seg" == */* ]]; then
        _part="${_seg%%/*}"
        _seg="${_seg#*/}"
      else
        _part="$_seg"
        _seg=""
      fi
      case "$_part" in
        ""|".") continue ;;
        "..")
          ((${#_stk[@]})) && unset '_stk[${#_stk[@]}-1]'
          ;;
        *) _stk+=("$_part") ;;
      esac
    done
    local _norm=""
    ((${#_stk[@]})) && _norm="$(IFS=/; printf '%s' "${_stk[*]}")"
    [[ "$_norm" == "docs/planning/backlog.md" ]] && _has_backlog=1
  done <<< "$path_list"
  if [[ $_has_backlog -eq 1 && $_total_paths -gt 1 ]]; then
    cat >&2 <<'EOF'
docs/planning/backlog.md must be committed separately from code/docs changes (W1 conflict-prevention policy).
Recovery:
  1. Split this slice: commit the code without the backlog ledger first.
  2. Re-read the current docs/planning/backlog.md from disk.
  3. Re-apply ONLY your owned row changes (stable IDs; never rewrite another lane's row).
  4. Run: node .opencode/scripts/normalize-backlog.js --check
  5. Commit the backlog alone (backlog-only acquire).
  6. Load the `backlog` skill for the full procedure.
Do NOT `commit-gate.sh revert docs/planning/backlog.md` to resolve a conflict.
EOF
    json_out "{\"status\":\"path_error\",\"reason\":\"backlog_must_commit_separately\",\"backlog_path\":\"docs/planning/backlog.md\",\"path_count\":${_total_paths}}"
    return 1
  fi

  # -------------------------------------------------------------------
  # State mutation begins here: lock acquire, index reset, staging
  # -------------------------------------------------------------------

  # If lock exists, check stale
  if [[ -d "$LOCK_DIR" ]]; then
    if _is_stale "$LOCK_DIR"; then
      if ! _stale_break "$LOCK_DIR" "$STALE_UUID"; then
        local holder
        holder=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
        json_out "{\"status\":\"contended\",\"reason\":\"stale_break_failed\",\"holder\":${holder}}"
        return 1
      fi
      # stale break succeeded — fall through to fresh acquire
    else
      local holder
      holder=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
      json_out "{\"status\":\"contended\",\"reason\":\"lock_held\",\"holder\":${holder}}"
      return 1
    fi
  fi

  # -------------------------------------------------------------------
  # Acquire-time scratch cleanup. This MUST mirror _gate_gc_sweep's
  # contract (the canonical GC at no_changes/commit/release), NOT carry a
  # divergent one. Historically this block used the LOCK-TTL age
  # (COMMIT_GATE_TTL_SECONDS, 600s) with NO protected-UUID set, which
  # `rm`'d LIVE concurrent sessions' meta-*/index-* scratch (a session in
  # its lock-free review phase whose heartbeat had lapsed > 600s) and
  # caused spurious uuid_mismatch / private_index-gone failures on commit.
  #
  # Two DISTINCT age concepts travel through this gate — do NOT re-conflate:
  #   - COMMIT_GATE_TTL_SECONDS (600s)  = LOCK staleness (is a held lock dead?).
  #   - COMMIT_GATE_GC_MAX_AGE (3600s)  = SCRATCH retention (may aged scratch
  #     be reaped?). Acquire-time meta cleanup is a SCRATCH-retention concern,
  #     so it uses the GC-max-age concept (3600s), NOT the lock-TTL (600s).
  #
  # The protected-UUID set (active lock UUID + _current_uuid + any UUID whose
  # meta-* is fresh) is consulted so a live concurrent session is never reaped.
  # Built via the SHARED _protected_uuids helper — the acquire-time cleanup
  # and _gate_gc_sweep MUST consult the SAME construction (hand-duplicating
  # them was the 3daca70 bug). Scoped here to meta-/index- only (this is the
  # pre-lock sweep; the full-prefix sweep still runs on no_changes/commit/
  # release via _gate_gc_sweep).
  # -------------------------------------------------------------------
  if [[ -d "$GATE_INDEX_DIR" ]]; then
    local gc_max_age="${COMMIT_GATE_GC_MAX_AGE:-$DEFAULT_GC_MAX_AGE}"
    # Build the protected-UUID set via the shared helper (canonical GC +
    # acquire-time cleanup MUST consult the SAME construction). The acquire
    # path used to hand-duplicate this and lost the protected-UUID skip — the
    # 3daca70 bug. See _protected_uuids for the shared contract.
    local protected_uuids=()
    while IFS= read -r puuid; do
      [[ -n "$puuid" ]] && protected_uuids+=("$puuid")
    done < <(_protected_uuids "$gc_max_age")

    local meta_file
    while IFS= read -r meta_file; do
      [[ -z "$meta_file" ]] && continue
      local meta_age
      meta_age=$(_file_age_seconds "$meta_file" 2>/dev/null || echo "0")
      if [[ $meta_age -gt $gc_max_age ]]; then
        # Extract UUID from filename (meta-${UUID}).
        local stale_uuid
        stale_uuid="${meta_file#${GATE_INDEX_DIR}/meta-}"
        # Skip protected UUIDs (exact string match on the UUID portion).
        local is_protected=false
        if [[ ${#protected_uuids[@]} -gt 0 ]]; then
          local prot
          for prot in "${protected_uuids[@]}"; do
            if [[ "$stale_uuid" == "$prot" ]]; then
              is_protected=true
              break
            fi
          done
        fi
        [[ "$is_protected" == "true" ]] && continue
        rm -f "$meta_file" 2>/dev/null || true
        rm -f "${GATE_INDEX_DIR}/index-${stale_uuid}" 2>/dev/null || true
      fi
    done < <(ls -1 "$GATE_INDEX_DIR"/meta-* 2>/dev/null)
  fi

  # Atomic acquire via mkdir (POSIX mkdir is atomic)
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # Race: another process grabbed it
    local holder
    holder=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
    json_out "{\"status\":\"contended\",\"reason\":\"race_lost\",\"holder\":${holder}}"
    return 1
  fi

  # We now hold the lock exclusively — write metadata v2, then release.
  local uuid now pid hname
  uuid=$(_uuid)
  now=$(_iso_now)
  pid=$$
  hname=$(_hostname)

  # Record HEAD at acquire time for CAS in Phase 3
  local head_at_acquire
  head_at_acquire=$(git rev-parse --verify HEAD^{commit} 2>/dev/null || echo "")

  # Private index path (inside .git, NOT /tmp — survives container restarts)
  local private_index="${GATE_INDEX_DIR}/index-${uuid}"
  "$_GATE_RO_SCRIPT" prep-tempdir
  # prep-tempdir targets REPO_ROOT (script-relative, see readonly-scripts.sh),
  # but GATE_INDEX_DIR is cwd-relative and tracks the target repo. Ensure the
  # cwd-relative dir exists so GIT_INDEX_FILE writes succeed regardless of
  # whether cwd == REPO_ROOT (production) or cwd == a temp/scratch repo (tests).
  mkdir -p "$GATE_INDEX_DIR"

  # Write lock metadata v2 with private_index, head_at_acquire, and paths fields
  local msg_enc alias_enc paths_json
  msg_enc=$(json_encode "$message")
  alias_enc=$(json_encode "$session_alias")
  paths_json=$(printf '%s\n' "$path_list" | python3 -c "
import json, sys
print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))
" 2>/dev/null || echo "[]")
  printf '{"version":2,"uuid":"%s","acquired_at":"%s","heartbeat_at":"%s","pid":%d,"session_alias":%s,"hostname":"%s","tree_hash":null,"message":%s,"private_index":"%s","head_at_acquire":"%s","paths":%s}\n' \
    "$uuid" "$now" "$now" "$pid" "$alias_enc" "$hname" "$msg_enc" "$private_index" "$head_at_acquire" "$paths_json" > "$LOCK_META"

  # Also persist session metadata for lock-free phase
  cp "$LOCK_META" "$(_session_meta_path "$uuid")" 2>/dev/null || true

  # Release lock immediately — review (Phase 2) is lock-free
  rm -rf "$LOCK_DIR"

  # Phase 1 staging: use private index, never touch shared .git/index
  if [[ -n "$path_list" ]]; then
    # Seed private index from HEAD
    if [[ -n "$head_at_acquire" ]]; then
      GIT_INDEX_FILE="$private_index" git read-tree "$head_at_acquire" 2>/dev/null || true
    fi

    # Stage paths — support both working-tree files and tracked-file deletions
    local missing=()
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      if [[ -e "$p" ]]; then
        # File exists on disk — normal add
        if ! GIT_INDEX_FILE="$private_index" git add -- "$p" 2>/dev/null; then
          rm -f "$private_index" 2>/dev/null || true
          rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
          json_out "{\"status\":\"path_error\",\"reason\":\"stage_failed\",\"file\":$(json_encode "$p")}"
          return 1
        fi
      else
        # Missing from disk — check if it's a tracked-file deletion
        if [[ -n "$head_at_acquire" ]] && git ls-tree -r --name-only "$head_at_acquire" -- "$p" 2>/dev/null | grep -q .; then
          # Tracked file deleted from working tree — stage the removal
          if ! GIT_INDEX_FILE="$private_index" git rm --cached -r -- "$p" 2>/dev/null; then
            rm -f "$private_index" 2>/dev/null || true
            rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
            json_out "{\"status\":\"path_error\",\"reason\":\"stage_remove_failed\",\"file\":$(json_encode "$p")}"
            return 1
          fi
        else
          # Not on disk and not tracked — genuine error
          missing+=("$p")
        fi
      fi
    done <<< "$path_list"

    if [[ ${#missing[@]} -gt 0 ]]; then
      rm -f "$private_index" 2>/dev/null || true
      rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
      local missing_json
      missing_json=$(printf '%s\n' "${missing[@]}" | python3 -c "
import json, sys
print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))
" 2>/dev/null || echo "[]")
      json_out "{\"status\":\"path_error\",\"missing\":${missing_json}}"
      return 1
    fi
  fi

  # Capture tree hash from private index
  local tree_hash
  tree_hash=$(GIT_INDEX_FILE="$private_index" git write-tree 2>/dev/null || echo "")

  if [[ -z "$tree_hash" ]]; then
    rm -f "$private_index" 2>/dev/null || true
    rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
    json_out "{\"status\":\"error\",\"reason\":\"write_tree_failed\"}"
    return 1
  fi

  # Check if there are actual changes
  local diff_output
  local diff_base="${head_at_acquire:-4b825dc642cb6eb9a060e54bf8d69288fbee4904}"
  diff_output=$(git diff-tree --no-commit-id -r "$diff_base" "$tree_hash" 2>/dev/null || true)

  if [[ -z "$diff_output" ]]; then
    # No changes to commit
    rm -f "$private_index" 2>/dev/null || true
    rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
    # Reclaim this session's own scratch (incl. the agent-authored msg file at
    # $MSG_SCRATCH_DIR/msg-${uuid}) immediately — mirrors the success sites.
    # Safe here: no commit/update-ref happened, so the msg file is leftover
    # scratch with no durability ordering to preserve. Pass the real
    # $message_file path too (acquire's uuid differs from the agent's filename
    # uuid, so the uuid-derived rm alone would miss it).
    _cleanup_own_scratch "$uuid" "$message_file"
    _gate_gc_sweep || true
    json_out "{\"status\":\"no_changes\",\"tree_hash\":\"${tree_hash}\"}"
    return 0
  fi

  # Build file list
  local files_json
  files_json=$(git diff-tree --no-commit-id --name-status -r "$diff_base" "$tree_hash" 2>/dev/null | python3 -c "
import json, sys
lines = [l.strip() for l in sys.stdin if l.strip()]
files = []
for l in lines:
    parts = l.split('\t', 1)
    if len(parts) == 2:
        files.append({'status': parts[0], 'path': parts[1]})
print(json.dumps(files))
  " 2>/dev/null || echo "[]")

  # -------------------------------------------------------------------
  # Private redlines scan — MANDATORY pre-acquire check.
  #
  # Scans the EXACT immutable tree object ($tree_hash, content-addressed by
  # `git write-tree` above) for private-redline violations BEFORE the acquire
  # is authorized. The scanner reads ONLY the named tree — never the working
  # tree, shared index, or HEAD — and is paste-safe: stdout carries only
  # opaque subj-* ids, generic reason codes, and committed-tree paths;
  # configured terms are NEVER echoed.
  #
  # EXIT CODE CONTRACT the gate depends on:
  #   0 = pass OR non-applicable (no registry / no binding subject / clean).
  #       The scanner prints a short status line on exit 0, but the gate
  #       DISCARDS captured output here so a non-adopter sees ZERO footprint.
  #   1 = violation(s) found     -> BLOCK the acquire.
  #   2 = fail-closed (invalid/unreadable registry, git failure) -> BLOCK.
  #   any other non-zero          -> BLOCK (fail-closed; never silently pass).
  #
  # The harness binary is resolved via PATH (the installed-harness surface).
  # redlines is a feature of a CURRENT installed harness, so the check is a
  # silent no-op when EITHER (a) `vh-agent-harness` is not on PATH at all, OR
  # (b) the installed binary predates the `redlines scan` subcommand. Both mean
  # "feature not available here" — the gate never blocks on a binary that cannot
  # run the scan. The cheap `redlines scan --help` probe (output discarded)
  # distinguishes a redlines-capable binary from a stale/older one and keeps the
  # gate robust across version skew and in minimal test environments.
  # -------------------------------------------------------------------
  if command -v vh-agent-harness >/dev/null 2>&1 && vh-agent-harness redlines scan --help >/dev/null 2>&1; then
    local rl_repo_root rl_out rl_rc
    rl_repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
    rl_rc=0
    rl_out=$(vh-agent-harness redlines scan -C "$rl_repo_root" --tree "$tree_hash" 2>&1) || rl_rc=$?
    if [[ "$rl_rc" -ne 0 ]]; then
      rm -f "$private_index" 2>/dev/null || true
      rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
      local rl_reason rl_status rl_detail_enc
      if [[ "$rl_rc" -eq 1 ]]; then
        rl_status="redlines_violation"
        rl_reason="private_redlines_blocked"
        echo "commit-gate: acquire BLOCKED - private redlines violation(s) in tree ${tree_hash}:" >&2
      elif [[ "$rl_rc" -eq 2 ]]; then
        rl_status="redlines_error"
        rl_reason="private_redlines_fail_closed"
        echo "commit-gate: acquire BLOCKED (fail-closed) - private redlines scan could not complete (invalid registry or scan error); tree ${tree_hash}:" >&2
      else
        rl_status="redlines_error"
        rl_reason="private_redlines_unexpected_exit"
        echo "commit-gate: acquire BLOCKED (fail-closed) - private redlines scan returned unexpected exit code ${rl_rc}; tree ${tree_hash}:" >&2
      fi
      printf '%s\n' "$rl_out" >&2
      rl_detail_enc=$(json_encode "$rl_out")
      json_out "{\"status\":\"${rl_status}\",\"reason\":\"${rl_reason}\",\"exit_code\":${rl_rc},\"tree_hash\":\"${tree_hash}\",\"detail\":${rl_detail_enc}}"
      return 1
    fi
    # exit 0 -> pass / non-applicable. DISCARD captured output (zero-footprint).
  fi

  # -------------------------------------------------------------------
  # Stage 1: rewrite-parity contract mechanical precheck (OPT-D).
  #
  # OPT-IN: only fires when --rewrite-parity-contract <file> is passed.
  # Ordinary deletes/refactors/renames carry NO rewrite-parity burden
  # (the flag is absent => this block is skipped entirely). When supplied,
  # the contract must be structurally valid AND its prior_surface.paths
  # must cross-check against the tree-bound acquire diff, with
  # prior_surface.revision bound to head_at_acquire. The check is a
  # MECHANICAL precheck; commit-reviewer still assesses semantic quality
  # (defense-in-depth) and does NOT replace it.
  #
  # The validator script is a sibling in this scripts dir. It returns
  # JSON {valid,errors,...} and exits 0/1. On failure the acquire is
  # refused with status rewrite_parity_error (no metadata is written).
  # -------------------------------------------------------------------
  if [[ -n "$rewrite_parity_contract" ]]; then
    if [[ ! -r "$rewrite_parity_contract" ]]; then
      rm -f "$private_index" 2>/dev/null || true
      rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
      json_out "{\"status\":\"rewrite_parity_error\",\"reason\":\"contract_file_unreadable\",\"file\":$(json_encode "$rewrite_parity_contract")}"
      return 1
    fi
    local _rp_script rp_out rp_rc
    _rp_script="$(dirname "$0")/rewrite-parity-validate.py"
    rp_rc=0
    rp_out=$(python3 "$_rp_script" \
        --contract-file "$rewrite_parity_contract" \
        --stage precommit \
        --head-at-acquire "$head_at_acquire" \
        --diff-files "$files_json" 2>/dev/null) || rp_rc=$?
    if [[ $rp_rc -ne 0 ]]; then
      rm -f "$private_index" 2>/dev/null || true
      rm -f "$(_session_meta_path "$uuid")" 2>/dev/null || true
      local _rp_errors
      _rp_errors=$(printf '%s' "$rp_out" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(json.dumps(d.get('errors', [])))
except Exception:
    print(json.dumps(['validator produced no parseable result']))
" 2>/dev/null || echo '["validator produced no parseable result"]')
      json_out "{\"status\":\"rewrite_parity_error\",\"reason\":\"contract_precheck_failed\",\"errors\":${_rp_errors}}"
      return 1
    fi
  fi

  # Write final metadata directly to per-session file — no global lock needed
  # (UUID-specific file has zero contention)
  printf '{"version":2,"uuid":"%s","acquired_at":"%s","heartbeat_at":"%s","pid":%d,"session_alias":%s,"hostname":"%s","tree_hash":"%s","message":%s,"private_index":"%s","head_at_acquire":"%s","paths":%s}\n' \
    "$uuid" "$now" "$now" "$pid" "$alias_enc" "$hname" "$tree_hash" "$msg_enc" "$private_index" "$head_at_acquire" "$paths_json" > "$(_session_meta_path "$uuid")"

  # Record the most-recently-active session so GC sweep can protect it.
  echo "$uuid" > "${GATE_INDEX_DIR}/_current_uuid" 2>/dev/null || true

  json_out "{\"status\":\"acquired\",\"tree_hash\":\"${tree_hash}\",\"files\":${files_json},\"lockfile\":\"none\",\"uuid\":\"${uuid}\",\"private_index\":\"${private_index}\",\"head_at_acquire\":\"${head_at_acquire}\"}"
  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: commit
# ---------------------------------------------------------------------------
cmd_commit() {
  # Config validation on commit too (belt-and-suspenders with acquire).
  _config_validate

  local message="" tree_hash="" uuid=""
  local message_file=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --message)      message="$2";   shift 2 ;;
      --message-file) message_file="$2"; shift 2 ;;
      --tree-hash)    tree_hash="$2"; shift 2 ;;
      --uuid)         uuid="$2";      shift 2 ;;
      *) shift ;;
    esac
  done

  # File-based arg takes precedence over inline arg
  if [[ -n "$message_file" ]]; then
    if [[ ! -r "$message_file" ]]; then
      json_out "{\"status\":\"error\",\"reason\":\"message_file_unreadable\",\"file\":\"${message_file}\"}"
      return 1
    fi
    message=$(cat "$message_file")
  fi

  # Phase 3: commit with CAS retry (lock-free)
  # The lock is NOT held during commit — acquire releases it for lock-free review.
  # Atomicity is provided by update-ref CAS (compare-and-swap with old-oid).
  local lock_content=""
  local session_meta=""
  
  if [[ -d "$LOCK_DIR" ]]; then
    lock_content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
  fi

  # Try to load from persistent session metadata
  local lock_uuid=""
  if [[ -n "$uuid" ]]; then
    session_meta="$(_session_meta_path "$uuid")"
    if [[ -f "$session_meta" ]]; then
      # Prefer lock content if lock exists; otherwise use persistent metadata
      if [[ -z "$lock_content" || "$lock_content" == "{}" ]]; then
        lock_content=$(cat "$session_meta" 2>/dev/null || echo "{}")
      fi
    fi
  fi

  # Verify UUID (spec §3.3 step 3a)
  lock_uuid=$(_field_str "$lock_content" "uuid")
  if [[ -n "$uuid" && "$lock_uuid" != "$uuid" ]]; then
    json_out "{\"status\":\"uuid_mismatch\",\"lock_uuid\":\"${lock_uuid}\",\"given_uuid\":\"${uuid}\"}"
    return 1
  fi

  # Verify tree_hash
  local lock_tree
  lock_tree=$(_field_str "$lock_content" "tree_hash")
  if [[ -n "$tree_hash" && "$lock_tree" != "$tree_hash" ]]; then
    json_out "{\"status\":\"tree_hash_mismatch\",\"lock_tree\":\"${lock_tree}\",\"given_tree\":\"${tree_hash}\"}"
    return 1
  fi

  # Use lock tree hash if caller didn't specify
  [[ -z "$tree_hash" ]] && tree_hash="$lock_tree"

  # Get current branch
  local branch
  branch=$(git branch --show-current 2>/dev/null || echo "main")

  # Read head_at_acquire and private_index from metadata
  local head_at_acquire private_index_path
  head_at_acquire=$(_field_str "$lock_content" "head_at_acquire")
  private_index_path=$(_field_str "$lock_content" "private_index")

  # Track the reviewed tree for rebased detection
  local original_tree="$tree_hash"

  # CAS retry loop (Phase 3)
  local cas_attempt=0
  local current_head
  current_head=$(git rev-parse --verify HEAD^{commit} 2>/dev/null || echo "")

  while [[ $cas_attempt -lt $CAS_MAX_RETRY ]]; do
    cas_attempt=$((cas_attempt + 1))

    local expected_head="$head_at_acquire"

    if [[ "$current_head" != "$expected_head" ]]; then
      # HEAD moved since acquire — 3-way merge using git objects only (never working tree)
      # base = original HEAD at acquire, theirs = new HEAD (winner), ours = reviewed tree
      local base_tree new_head_tree
      if [[ -z "$head_at_acquire" ]]; then
        # Unborn branch at acquire — no base tree for merge, use empty tree
        base_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
      else
        base_tree=$(git rev-parse "${head_at_acquire}^{tree}" 2>/dev/null || echo "")
      fi
      if [[ -n "$current_head" ]]; then
        new_head_tree=$(git rev-parse "${current_head}^{tree}" 2>/dev/null || echo "")
      else
        new_head_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
      fi

      if [[ -z "$base_tree" || -z "$new_head_tree" ]]; then
        json_out "{\"status\":\"error\",\"reason\":\"cas_tree_resolve_failed\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

      # Create temporary merge index for 3-way merge
      local merge_index="${GATE_INDEX_DIR}/merge-${lock_uuid}"
      rm -f "$merge_index" 2>/dev/null || true

      # 3-way merge: base (original HEAD), theirs (new HEAD), ours (reviewed tree)
      if ! GIT_INDEX_FILE="$merge_index" git read-tree -m -i "$base_tree" "$new_head_tree" "$tree_hash" 2>/dev/null; then
        rm -f "$merge_index" 2>/dev/null || true
        # Content tangle: the 3-way merge could not reconcile the reviewed tree
        # with the concurrent winner's HEAD. Distinct from cas_conflict (which is
        # concurrent HEAD MOVEMENT the retry loop handles) — this is a terminal
        # could-not-land (disposition §4.2: reason "tangle"). Record it durably
        # so doctor's stall/flatline surfacing can see it. post_commit_head is
        # current_head (the branch did not move — no commit landed).
        _closeout_append "$lock_uuid" \
          "$(_field_str "$lock_content" "acquired_at")" \
          "$(_field_str "$lock_content" "head_at_acquire")" \
          "$current_head" "could_not_land" "$branch"
        json_out "{\"status\":\"could_not_land\",\"reason\":\"merge_failed\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

      local new_tree
      new_tree=$(GIT_INDEX_FILE="$merge_index" git write-tree 2>/dev/null || echo "")
      rm -f "$merge_index" 2>/dev/null || true

      if [[ -z "$new_tree" ]]; then
        # Same content-tangle class as merge_failed above (could_not_land).
        _closeout_append "$lock_uuid" \
          "$(_field_str "$lock_content" "acquired_at")" \
          "$(_field_str "$lock_content" "head_at_acquire")" \
          "$current_head" "could_not_land" "$branch"
        json_out "{\"status\":\"could_not_land\",\"reason\":\"write_tree_failed\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

      # S2: approved-tree integrity under concurrency. The CAS 3-way merge
      # produced a tree that DIFFERS from the reviewed tree the committer
      # asked to land. Committing it would substitute a tree the reviewer
      # never saw (the concurrent winner's content fused into the approved
      # scope by the merge). Fail closed: REFUSE the commit, record it
      # durably as a terminal sibling of could_not_land, and require
      # re-acquire + re-review. The deferred RE-VIEW/auto-retry path will
      # key off these rebased_refused closeouts. post_commit_head is
      # current_head (the branch did not move on this session's behalf —
      # no commit landed).
      if [[ "$new_tree" != "$original_tree" ]]; then
        _closeout_append "$lock_uuid" \
          "$(_field_str "$lock_content" "acquired_at")" \
          "$(_field_str "$lock_content" "head_at_acquire")" \
          "$current_head" "rebased_refused" "$branch"
        json_out "{\"status\":\"rebased_refused\",\"reason\":\"reviewed_tree_diverged\",\"reviewed_tree\":\"${original_tree}\",\"merged_tree\":\"${new_tree}\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

      # The merge reproduced the reviewed tree exactly (new_tree ==
      # original_tree): safe to land. Take the reconciled tree and advance
      # the anchor so commit-tree parents onto current_head.
      tree_hash="$new_tree"
      head_at_acquire="$current_head"
    fi

    # Create commit object
    local commit_hash
    if [[ -n "$current_head" ]]; then
      commit_hash=$(git commit-tree "$tree_hash" -p "$current_head" -m "$message" 2>/dev/null || echo "")
    else
      commit_hash=$(git commit-tree "$tree_hash" -m "$message" 2>/dev/null || echo "")
    fi

    if [[ -z "$commit_hash" ]]; then
      json_out "{\"status\":\"error\",\"reason\":\"commit_tree_failed\"}"
      return 1
    fi

    # Update branch ref WITH CAS (old-oid = current_head)
    if [[ -n "$current_head" ]]; then
      if git update-ref "refs/heads/${branch}" "$commit_hash" "$current_head" 2>/dev/null; then
        # Closeout status (sub-item 3, disposition §4.2): no_head_progress if the
        # branch did not advance past the reference this commit was built on
        # (the P3 "pre/post HEAD equal" canary). A normal commit-tree always
        # produces a new object on top of current_head, so this is structurally
        # unreachable via the normal acquire→commit flow (the no_changes guard
        # also blocks no-op trees); it emits on the genuine post==pre edge /
        # fault condition. Otherwise committed.
        local closeout_status="committed"
        if [[ -n "$current_head" && "$commit_hash" == "$current_head" ]]; then
          closeout_status="no_head_progress"
        fi
        # Record post-commit HEAD to the durable closeout ledger (sub-item 1,
        # disposition §4.2). head_at_acquire from lock_content is the ORIGINAL
        # acquire-time HEAD (mirrors the per-session field); post_commit_head is
        # where the branch actually landed.
        _closeout_append "$lock_uuid" \
          "$(_field_str "$lock_content" "acquired_at")" \
          "$(_field_str "$lock_content" "head_at_acquire")" \
          "$commit_hash" "$closeout_status" "$branch"
        # Success — clean up
        rm -f "$private_index_path" 2>/dev/null || true
        rm -f "$(_session_meta_path "$lock_uuid")" 2>/dev/null || true
        _cleanup_own_scratch "$lock_uuid" "$message_file"
        _gate_gc_sweep || true
        # Resync shared index to new HEAD
        git read-tree HEAD 2>/dev/null || true
        # S2: under refuse-on-rebase the only success paths reproduce the
        # reviewed tree exactly (tree_hash == original_tree) — either no HEAD
        # movement (current_head == expected_head) or a CAS merge that
        # reproduced the reviewed tree. Any divergence was refused above, so
        # no rebased flag is emitted on success.
        json_out "{\"status\":\"${closeout_status}\",\"commit_hash\":\"${commit_hash}\",\"tree_hash\":\"${tree_hash}\",\"branch\":\"${branch}\",\"cas_attempts\":${cas_attempt}}"
        return 0
      else
        # CAS failed — HEAD moved under us
  current_head=$(git rev-parse --verify HEAD^{commit} 2>/dev/null || echo "")
        if [[ $cas_attempt -ge $CAS_MAX_RETRY ]]; then
          json_out "{\"status\":\"error\",\"reason\":\"cas_retry_exhausted\",\"head_at_acquire\":\"${expected_head}\",\"current_head\":\"${current_head}\"}"
          return 1
        fi
        continue
      fi
    else
      # Initial commit (no parent): use zero-old-oid to prevent concurrent
      # initial commits from silently overwriting each other.
      if git update-ref "refs/heads/${branch}" "$commit_hash" "0000000000000000000000000000000000000000" 2>/dev/null; then
        # Record the initial commit to the durable closeout ledger (sub-item 1).
        _closeout_append "$lock_uuid" \
          "$(_field_str "$lock_content" "acquired_at")" \
          "$(_field_str "$lock_content" "head_at_acquire")" \
          "$commit_hash" "committed" "$branch"
        rm -f "$private_index_path" 2>/dev/null || true
        rm -f "$(_session_meta_path "$lock_uuid")" 2>/dev/null || true
        _cleanup_own_scratch "$lock_uuid" "$message_file"
        _gate_gc_sweep || true
        # Resync shared index to new HEAD
        git read-tree HEAD 2>/dev/null || true
        json_out "{\"status\":\"committed\",\"commit_hash\":\"${commit_hash}\",\"tree_hash\":\"${tree_hash}\",\"branch\":\"${branch}\",\"initial\":true}"
        return 0
      else
        json_out "{\"status\":\"error\",\"reason\":\"update_ref_failed\"}"
        return 1
      fi
    fi
  done

  # Should not reach here, but guard
  json_out "{\"status\":\"error\",\"reason\":\"cas_retry_exhausted\"}"
  return 1
}

# ---------------------------------------------------------------------------
# Subcommand: release
# ---------------------------------------------------------------------------
cmd_release() {
  local uuid=""
  local message_file=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uuid) uuid="$2"; shift 2 ;;
      --message-file) message_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ ! -d "$LOCK_DIR" ]]; then
    # Lock not held — try to find persistent session metadata
    if [[ -n "$uuid" ]]; then
      local session_meta
      session_meta="$(_session_meta_path "$uuid")"
      if [[ -f "$session_meta" ]]; then
        local sm_content
        sm_content=$(cat "$session_meta" 2>/dev/null || echo "{}")
        _cleanup_private_index "$sm_content"
        rm -f "$session_meta" 2>/dev/null || true
      fi
    fi
    # Reclaim the agent-authored message scratch ($MSG_SCRATCH_DIR/msg-${UUID_A})
    # too. release's uuid is the GATE session uuid (from acquire), which differs
    # from the agent's pre-acquire gen-uuid used to NAME the msg scratch file, so
    # the uuid-derived rm in _cleanup_own_scratch is a no-op for agent files.
    # Passing the real $message_file reclaims it promptly instead of waiting for
    # the aged-GC backstop. Invariant preserved: own-UUID/msg reclaim stays
    # strictly AFTER any state mutation (meta removal above); release has no
    # update-ref, so ordering is simpler. Best-effort (|| true).
    _cleanup_own_scratch "$uuid" "$message_file"
    _gate_gc_sweep || true
    json_out "{\"status\":\"released\",\"note\":\"no_lock\"}"
    return 0
  fi

  local lock_content lock_uuid
  lock_content=$(cat "$LOCK_META")

  # Verify UUID if provided
  if [[ -n "$uuid" ]]; then
    lock_uuid=$(_field_str "$lock_content" "uuid")
    if [[ "$lock_uuid" != "$uuid" ]]; then
      json_out "{\"status\":\"uuid_mismatch\",\"lock_uuid\":\"${lock_uuid}\",\"given_uuid\":\"${uuid}\"}"
      return 1
    fi
  fi

  # Clean up private index if present
  _cleanup_private_index "$lock_content"

  # Clean up persistent session metadata
  local lock_uuid_for_meta
  lock_uuid_for_meta=$(_field_str "$lock_content" "uuid")
  rm -f "$(_session_meta_path "$lock_uuid_for_meta")" 2>/dev/null || true

  # Remove lock
  rm -rf "$LOCK_DIR"

  _cleanup_own_scratch "$lock_uuid_for_meta" "$message_file"
  _gate_gc_sweep || true
  json_out "{\"status\":\"released\"}"
  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: status
# ---------------------------------------------------------------------------
cmd_status() {
  if [[ ! -d "$LOCK_DIR" ]]; then
    # Check for any lingering session metadata (lock-free review sessions)
    local sessions_json="[]"
    if [[ -d "$GATE_INDEX_DIR" ]] && compgen -G "$GATE_INDEX_DIR"/meta-\* &>/dev/null; then
      sessions_json=$(ls -1 "$GATE_INDEX_DIR"/meta-* 2>/dev/null | head -5 | python3 -c "
import json, sys
items = [l.strip().split('/')[-1] for l in sys.stdin if l.strip()]
print(json.dumps(items))
" 2>/dev/null || echo "[]")
    fi
    # Count session-metadata files aged past the GC-retention window
    # (COMMIT_GATE_GC_MAX_AGE) — i.e. reaping candidates _gate_gc_sweep will
    # reap on the next sweep. This is a SCRATCH-retention concept, NOT lock
    # staleness: do NOT re-conflate with COMMIT_GATE_TTL_SECONDS (the LOCK
    # TTL). The cleanup paths all key off GC_MAX_AGE; the diagnostic matches
    # so its language cannot reintroduce the TTL/GC conflation.
    local aged_count=0
    if [[ "$sessions_json" != "[]" ]]; then
      local gc_max_age="${COMMIT_GATE_GC_MAX_AGE:-$DEFAULT_GC_MAX_AGE}"
      aged_count=$(ls -1 "$GATE_INDEX_DIR"/meta-* 2>/dev/null | while IFS= read -r f; do
        local a
        a=$(_file_age_seconds "$f" 2>/dev/null || echo "0")
        if [[ $a -gt $gc_max_age ]]; then echo "aged"; fi
      done | wc -l | tr -d ' ')
      json_out "{\"status\":\"free\",\"note\":\"session_metadata_exists\",\"sessions\":${sessions_json},\"gc_aged_count\":${aged_count}}"
    else
      json_out "{\"status\":\"free\"}"
    fi
    return 0
  fi

  local lock_content uuid pid alias tree hb message
  lock_content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
  uuid=$(_field_str "$lock_content" "uuid")
  pid=$(_field_num "$lock_content" "pid")
  alias=$(_field_str "$lock_content" "session_alias")
  tree=$(_field_str "$lock_content" "tree_hash")
  hb=$(_field_str "$lock_content" "heartbeat_at")
  message=$(_field_str "$lock_content" "message")

  local pidx_field head_acquire_field
  pidx_field=$(_field_str "$lock_content" "private_index")
  head_acquire_field=$(_field_str "$lock_content" "head_at_acquire")

  local age=0
  age=$(_lock_age_seconds "$LOCK_DIR")

  local is_stale=false pid_dead=false

  # Primary check: heartbeat TTL (same logic as _is_stale)
  # If heartbeat is fresh, the lock is held regardless of PID state.
  local ttl
  ttl="${COMMIT_GATE_TTL_SECONDS:-$DEFAULT_TTL}"
  if [[ -n "$hb" ]]; then
    local hb_age
    hb_age=$(_heartbeat_age_seconds "$hb")
    if [[ $hb_age -le $ttl ]]; then
      # Heartbeat fresh → not stale. Still report pid_dead for diagnostics.
      if [[ -n "$pid" ]] && ! _pid_alive "$pid" 2>/dev/null; then
        pid_dead=true
      fi
      is_stale=false
    else
      # Heartbeat expired → stale
      is_stale=true
      if [[ -n "$pid" ]] && ! _pid_alive "$pid" 2>/dev/null; then
        pid_dead=true
      fi
    fi
  else
    # No heartbeat — use PID as fallback
    if [[ -n "$pid" ]] && ! _pid_alive "$pid" 2>/dev/null; then
      pid_dead=true
      is_stale=true
    fi
  fi

  local state="held"
  [[ "$is_stale" == "true" ]] && state="stale"

  # Use json_encode for user-controlled fields to prevent JSON injection
  local msg_enc alias_enc uuid_enc tree_enc hb_enc
  msg_enc=$(json_encode "${message:-}")
  alias_enc=$(json_encode "${alias:-}")
  uuid_enc=$(json_encode "${uuid:-}")
  tree_enc=$(json_encode "${tree:-}")
  hb_enc=$(json_encode "${hb:-}")

  json_out "{\"status\":\"${state}\",\"uuid\":${uuid_enc},\"pid\":${pid:-0},\"session_alias\":${alias_enc},\"tree_hash\":${tree_enc},\"age_seconds\":${age},\"pid_dead\":${pid_dead},\"heartbeat_at\":${hb_enc},\"message\":${msg_enc},\"private_index\":$(json_encode "${pidx_field:-}"),\"head_at_acquire\":$(json_encode "${head_acquire_field:-}")}"
  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: heartbeat
# ---------------------------------------------------------------------------
cmd_heartbeat() {
  local uuid=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uuid) uuid="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$uuid" ]]; then
    json_out "{\"status\":\"error\",\"reason\":\"uuid_required\"}"
    return 1
  fi

  local lock_hb_ok=false

  # --- Lock-based heartbeat (if lock dir exists) ---
  if [[ -d "$LOCK_DIR" ]]; then
    local lock_content lock_uuid
    lock_content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
    lock_uuid=$(_field_str "$lock_content" "uuid")

    if [[ "$lock_uuid" != "$uuid" ]]; then
      json_out "{\"status\":\"uuid_mismatch\",\"lock_uuid\":\"${lock_uuid}\",\"given_uuid\":\"${uuid}\"}"
      return 1
    fi

    # Do not refresh a stale lock — heartbeat is proactive, not retroactive revival.
    if _is_stale "$LOCK_DIR"; then
      json_out "{\"status\":\"error\",\"reason\":\"stale_lock\",\"uuid\":\"${lock_uuid}\"}"
      return 1
    fi

    # Atomic read-validate-write via python3: eliminates TOCTOU between UUID
    # check and meta write, and preserves null fields (e.g. tree_hash:null)
    # that _field_str would collapse to "".
    local hb_result
    hb_result=$(python3 -c "
import json, sys, os, tempfile
from datetime import datetime, timezone

meta_path = sys.argv[1]
expected_uuid = sys.argv[2]
lock_dir = os.path.dirname(meta_path)

# Capture inode before reading to detect directory replacement by stale reclamation.
dir_inode_before = os.stat(lock_dir).st_ino

with open(meta_path, 'r') as f:
    data = json.load(f)

_SEP = (',', ':')

if data.get('uuid') != expected_uuid:
    print(json.dumps({'status': 'uuid_mismatch', 'lock_uuid': data.get('uuid', ''), 'given_uuid': expected_uuid}, separators=_SEP))
    sys.exit(2)

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
data['heartbeat_at'] = now

fd, tmp_path = tempfile.mkstemp(dir=lock_dir, suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as tmp:
        json.dump(data, tmp, separators=_SEP)
    # Verify the lock directory was not replaced between read and write.
    try:
        dir_inode_after = os.stat(lock_dir).st_ino
    except FileNotFoundError:
        os.unlink(tmp_path)
        print(json.dumps({'status': 'error', 'reason': 'lock_replaced', 'uuid': expected_uuid}, separators=_SEP))
        sys.exit(1)
    if dir_inode_before != dir_inode_after:
        os.unlink(tmp_path)
        print(json.dumps({'status': 'error', 'reason': 'lock_replaced', 'uuid': expected_uuid}, separators=_SEP))
        sys.exit(1)
    os.replace(tmp_path, meta_path)
except SystemExit:
    raise
except:
    os.unlink(tmp_path) if os.path.exists(tmp_path) else None
    raise

print(json.dumps({'status': 'heartbeat_refreshed', 'uuid': data['uuid'], 'heartbeat_at': now}, separators=_SEP))
" "$LOCK_META" "$uuid" 2>/dev/null)
    local rc=$?
    if [[ $rc -eq 2 ]]; then
      # python3 detected UUID mismatch after re-read
      echo "$hb_result"
      return 1
    elif [[ $rc -ne 0 ]]; then
      json_out "{\"status\":\"error\",\"reason\":\"heartbeat_write_failed\"}"
      return 1
    fi
    echo "$hb_result"
    lock_hb_ok=true
  fi

  # --- Per-session metadata heartbeat (lock-free sessions) ---
  # Refreshes mtime on the per-session meta file so the acquire-time and
  # _gate_gc_sweep scratch cleanups (both use COMMIT_GATE_GC_MAX_AGE, default
  # 3600s, with a protected-UUID skip — see cmd_acquire ~756 and _gate_gc_sweep
  # ~368) treat this meta as fresh and never reap it during an active review.
  # Do NOT confuse the scratch retention window (GC_MAX_AGE, 1h) with the lock
  # TTL (COMMIT_GATE_TTL_SECONDS, 600s) — they are distinct concepts.
  local session_meta
  session_meta="$(_session_meta_path "$uuid")"
  if [[ -f "$session_meta" ]]; then
    local now_hb
    now_hb=$(_iso_now)
    python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    d = json.load(f)
d['heartbeat_at'] = sys.argv[2]
with open(sys.argv[1], 'w') as f:
    json.dump(d, f)
    " "$session_meta" "$now_hb" 2>/dev/null || touch "$session_meta"

    # Refresh _current_uuid so GC sweep protects this active session's scratch.
    echo "$uuid" > "${GATE_INDEX_DIR}/_current_uuid" 2>/dev/null || true
  fi

  # If lock-based heartbeat already printed its result, return that.
  if [[ "$lock_hb_ok" == true ]]; then
    return 0
  fi

  # Lock-free path: no lock dir existed but session meta was refreshed (or absent).
  if [[ -f "$session_meta" ]]; then
    json_out "{\"status\":\"heartbeat_refreshed\",\"uuid\":\"${uuid}\",\"heartbeat_at\":\"${now_hb}\"}"
    return 0
  fi

  json_out "{\"status\":\"error\",\"reason\":\"no_lock_or_session\"}"
  return 1
}

# ---------------------------------------------------------------------------
# In-repo path validation for cmd_revert (lexical + realpath two-tier).
#
# Ports validateGitCPath / normalizeGitCPath from
# .opencode/plugins/shell-guard.js (~lines 258-353) into bash.  Two tiers,
# mirroring the JS reference exactly:
#   Tier 1 (lexical, no fs): resolve the path against the repo root and confirm
#     the target IS the repo root or beneath it.  Catches `..` escapes and
#     absolute-escape.  Works for non-existent paths too.
#   Tier 2 (symlink, fs): if the lexical target exists, realpath both the
#     target and the repo root and re-confirm containment on the realpaths.
#     Catches symlink escapes.  If the path does not yet exist, Tier 1 is
#     authoritative (a non-existent path cannot yet be a symlink escape).
#
# Relative paths resolve against `git rev-parse --show-toplevel`, NOT $PWD
# (mirrors the plugin's repoRoot() resolution — $PWD is unreliable).
#
# Args: $1 = path to validate (relative or absolute)
# Sets: _validate_reason (empty on success, a short reason token on failure)
# Returns: 0 = valid (in-repo); 1 = rejected
# ---------------------------------------------------------------------------
_validate_in_repo_path() {
  local raw="$1"
  _validate_reason=""

  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [[ -z "$repo_root" ]]; then
    _validate_reason="not_a_git_repo"
    return 1
  fi

  # --- Tier 1: lexical resolution against repo root (no fs reads) ---
  local joined
  if [[ "$raw" == /* ]]; then
    joined="$raw"
  else
    joined="${repo_root}/${raw}"
  fi

  # Normalize lexically (path.resolve semantics): split on '/', collapse
  # "." and "..".  Empty segments (from leading/double/trailing slashes)
  # are dropped.  ".." at an empty stack clamps to root (path.resolve).
  local -a stack=()
  local part
  while [[ -n "$joined" ]]; do
    # Strip a single leading '/' so the next segment can be peeled.
    [[ "$joined" == /* ]] && joined="${joined:1}"
    if [[ "$joined" == */* ]]; then
      part="${joined%%/*}"
      joined="${joined#*/}"
    else
      part="$joined"
      joined=""
    fi
    case "$part" in
      ""|".") continue ;;
      "..")
        if ((${#stack[@]})); then
          unset 'stack[${#stack[@]}-1]'
        fi
        ;;
      *) stack+=("$part") ;;
    esac
  done

  local normalized
  if ((${#stack[@]})); then
    normalized="/$(IFS=/; printf '%s' "${stack[*]}")"
  else
    normalized="/"
  fi

  if [[ "$normalized" != "$repo_root" && "$normalized" != "$repo_root/"* ]]; then
    _validate_reason="path_escapes_repo"
    return 1
  fi

  # --- Tier 2: realpath containment (catches symlink escapes) ---
  if [[ -e "$normalized" ]]; then
    local real_target real_root
    real_target=$(realpath -- "$normalized" 2>/dev/null || readlink -f -- "$normalized" 2>/dev/null || true)
    real_root=$(realpath -- "$repo_root" 2>/dev/null || readlink -f -- "$repo_root" 2>/dev/null || true)
    if [[ -z "$real_target" || -z "$real_root" ]]; then
      _validate_reason="realpath_unavailable"
      return 1
    fi
    if [[ "$real_target" != "$real_root" && "$real_target" != "$real_root/"* ]]; then
      _validate_reason="symlink_escape"
      return 1
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: revert
#
# Restores working-tree paths to HEAD WITHOUT acquiring the commit-gate lock,
# CAS, or private index.  This is the sanctioned alternative to the
# operator-only SKIP_COMMIT_GATE=1 escape hatch: it unblocks a session whose
# working-tree edits collided with a concurrent committer.
#
# revert is a pre-acquire / post-FAIL working-tree op — NO lock, NO CAS,
#   NO private index.  Option B (a `revert)` case in the SKIP_COMMIT_GATE
#   switch in main()) is explicitly REJECTED: revert IS the sanctioned path
#   and must not piggyback the operator-only escape hatch.
#
# Path-scope rejection (fail-closed): two-tier in-repo validation mirroring
# validateGitCPath / normalizeGitCPath in .opencode/plugins/shell-guard.js.
# ALL paths are validated BEFORE any mutation — on any rejection the working
# tree is left untouched and a path_error is returned.
#
# Usage:
#   commit-gate.sh revert --paths '<JSON_ARRAY>'
#   commit-gate.sh revert --paths-file FILE
#   commit-gate.sh revert <path> [<path> ...]
# ---------------------------------------------------------------------------
cmd_revert() {
  local -a paths=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --paths)
        local pj="$2"; shift 2
        local pl
        pl=$(python3 -c "
import json, sys
arr = json.loads(sys.stdin.read())
if not isinstance(arr, list) or not all(isinstance(x, str) for x in arr):
    sys.exit(1)
print('\n'.join(arr))
" <<< "$pj" 2>/dev/null) || {
          json_out "{\"status\":\"path_error\",\"reason\":\"paths_json_invalid\"}"
          return 1
        }
        local l
        while IFS= read -r l; do [[ -n "$l" ]] && paths+=("$l"); done <<< "$pl"
        ;;
      --paths-file)
        local pf="$2"; shift 2
        if [[ ! -r "$pf" ]]; then
          json_out "{\"status\":\"error\",\"reason\":\"paths_file_unreadable\",\"file\":$(json_encode "$pf")}"
          return 1
        fi
        local l2
        while IFS= read -r l2; do [[ -n "$l2" ]] && paths+=("$l2"); done < "$pf"
        ;;
      --)
        shift
        while [[ $# -gt 0 ]]; do paths+=("$1"); shift; done
        ;;
      -*)
        shift
        ;;
      *)
        paths+=("$1"); shift
        ;;
    esac
  done

  if [[ ${#paths[@]} -eq 0 ]]; then
    json_out "{\"status\":\"path_error\",\"reason\":\"paths_required\"}"
    return 1
  fi

  local repo_root head_ref
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [[ -z "$repo_root" ]]; then
    json_out "{\"status\":\"error\",\"reason\":\"not_a_git_repo\"}"
    return 1
  fi
  # HEAD tree is the restore source.  Empty tree fallback covers unborn repos.
  head_ref=$(git rev-parse --verify HEAD^{commit} 2>/dev/null || echo "")

  # -------------------------------------------------------------------
  # Validate ALL paths FIRST (fail-closed).  No mutation before this passes.
  # -------------------------------------------------------------------
  local p
  local -a rejected_paths=() rejected_reasons=()
  for p in "${paths[@]}"; do
    if ! _validate_in_repo_path "$p"; then
      rejected_paths+=("$p")
      rejected_reasons+=("${_validate_reason}")
    fi
  done

  if [[ ${#rejected_paths[@]} -gt 0 ]]; then
    local rejected_json
    rejected_json=$(python3 -c "
import json, sys
n = int(sys.argv[1])
paths = sys.argv[2:2+n]
reasons = sys.argv[2+n:2+2*n]
print(json.dumps([{'path': p, 'reason': r} for p, r in zip(paths, reasons)]))
" "${#rejected_paths[@]}" "${rejected_paths[@]}" "${rejected_reasons[@]}" 2>/dev/null || echo "[]")
    json_out "{\"status\":\"path_error\",\"reason\":\"path_scope_rejected\",\"rejected\":${rejected_json}}"
    return 1
  fi

  # -------------------------------------------------------------------
  # Mutation phase: restore each path to HEAD.  Best-effort: attempt every
  # path, collect failures, then report.  In-repo scope is already proven,
  # so any remaining failure is "not tracked at HEAD" (untracked/missing).
  # -------------------------------------------------------------------
  local -a restored=() failed_paths=()
  for p in "${paths[@]}"; do
    if git checkout HEAD -- "$p" 2>/dev/null; then
      restored+=("$p")
    else
      failed_paths+=("$p")
    fi
  done

  local restored_json
  restored_json=$(python3 -c "
import json, sys
print(json.dumps(sys.argv[1:]))
" "${restored[@]}" 2>/dev/null || echo "[]")

  if [[ ${#failed_paths[@]} -gt 0 ]]; then
    local failed_json
    failed_json=$(python3 -c "
import json, sys
print(json.dumps(sys.argv[1:]))
" "${failed_paths[@]}" 2>/dev/null || echo "[]")
    json_out "{\"status\":\"path_error\",\"reason\":\"not_in_head\",\"restored\":${restored_json},\"failed\":${failed_json}}"
    return 1
  fi

  json_out "{\"status\":\"reverted\",\"restored\":${restored_json},\"head\":\"${head_ref}\"}"
  return 0
}

# ---------------------------------------------------------------------------
# Subcommand: stage-message   (DEPRECATED — see rationale below)
#
# DEPRECATED (decision C3; v0.2.1 migration). The mandated commit-message
# flow since v0.2.1 is: the committer authors the message with the Write tool
# at tmp/commit-gate-message/msg-${UUID}, then passes it via
# `acquire --message-file FILE` / `commit --message-file FILE` (--message-file
# is accepted symmetrically on BOTH subcommands). That path is one Write call
# + one --message-file flag and does not need this subcommand.
#
# This subcommand is retained for backward compatibility and for symmetry in
# the SKIP_COMMIT_GATE dispatch path; it is NOT removed. The v0.2.1 migration
# BANS the heredoc form (the STDIN <<'GATE_MSG_EOF' idiom this command was
# built around) — new committer code MUST use the Write-tool -> --message-file
# flow instead. Invoking it prints a one-line deprecation notice to stderr.
#
# Historical context (INFRA-GATE-004a): stage-message predates the scoped
# edit-permission model. The original rationale claimed the committer had
# flat edit:deny — that was never accurate for the rendered output:
# internal/permconfig emits the committer's edit permission as the scoped
# object form {"*":"deny","tmp/commit-gate-message/**":"allow"} (see
# internal/permconfig/tables.go: EditOverrides + CommitGateMessageGlob, and
# emit.go: computeEditBlock), so the committer CAN Write the message file
# directly. (Note: templates/core/opencode.jsonc.tmpl still carries a flat
# "edit":"deny" literal and disagrees with the emitter; that template seam
# is tracked separately and is NOT fixed here.)
#
# The write itself is still ATOMIC: STDIN -> sibling temp file -> rename into
# ${GATE_INDEX_DIR}/msg-${UUID}. On ANY failure the temp file is removed and
# a JSON error is returned -- a partial msg-${UUID} is never left in place.
# This is a pure scratch-file write (no gating to bypass), so it routes to
# cmd_stage_message unchanged in BOTH the normal and SKIP_COMMIT_GATE
# dispatch paths.
#
# Usage:
#   commit-gate.sh stage-message --uuid UUID    # reads message from STDIN
# ---------------------------------------------------------------------------
cmd_stage_message() {
  # Deprecation notice (decision C3): routed to stderr so the JSON status
  # object on stdout is not corrupted. The v0.2.1-mandated flow is the
  # Write tool -> acquire/commit --message-file; this subcommand is retained
  # for backward compatibility and SKIP_COMMIT_GATE symmetry only.
  echo "stage-message: deprecated; use Write tool -> acquire/commit --message-file" >&2

  local uuid=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uuid) uuid="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$uuid" ]]; then
    json_out "{\"status\":\"error\",\"reason\":\"uuid_required\"}"
    return 1
  fi

  # UUID is a filename component (msg-${UUID}). gen-uuid emits standard
  # hex+dashes UUIDs, but validate defensively to reject path traversal
  # (/ .. \) and shell metacharacters regardless of caller.
  if [[ ! "$uuid" =~ ^[A-Za-z0-9_-]+$ ]]; then
    json_out "{\"status\":\"error\",\"reason\":\"uuid_invalid\",\"uuid\":$(json_encode "$uuid")}"
    return 1
  fi

  # Ensure the scratch dir exists (cwd-relative -- tracks the target repo).
  # Same dir cmd_acquire creates; stage-message runs BEFORE acquire.
  mkdir -p "$GATE_INDEX_DIR"

  local final_path="${GATE_INDEX_DIR}/msg-${uuid}"
  # Sibling temp path: same filesystem so mv is atomic (POSIX rename). The
  # PID + RANDOM suffix guards against concurrent stage-message calls for the
  # same UUID (fail-safe, never fail-silent).
  local tmp_path="${GATE_INDEX_DIR}/.msg-${uuid}.tmp.$$.${RANDOM:-0}"

  # Atomic write: capture STDIN into the temp file. On failure, remove the
  # temp and error loudly -- never leave a partial msg-${UUID} in place.
  if ! cat > "$tmp_path"; then
    rm -f "$tmp_path" 2>/dev/null || true
    json_out "{\"status\":\"error\",\"reason\":\"stage_message_write_failed\",\"file\":$(json_encode "$tmp_path")}"
    return 1
  fi

  # Rename into place (atomic on POSIX same-filesystem rename).
  if ! mv -f "$tmp_path" "$final_path"; then
    rm -f "$tmp_path" 2>/dev/null || true
    json_out "{\"status\":\"error\",\"reason\":\"stage_message_rename_failed\",\"file\":$(json_encode "$final_path")}"
    return 1
  fi

  local bytes=0
  bytes=$(wc -c < "$final_path" 2>/dev/null | tr -d '[:space:]' || echo 0)

  json_out "{\"status\":\"staged\",\"file\":$(json_encode "$final_path"),\"bytes\":${bytes}}"
  return 0
}

# ---------------------------------------------------------------------------
# Main — dispatch with escape hatch
# ---------------------------------------------------------------------------
main() {
  # Escape hatch: SKIP_COMMIT_GATE=1 bypasses all gating.
  # Operator-only: if running inside OpenCode (OPENCODE_SESSION_ID is set),
  # SKIP_COMMIT_GATE is refused. The operator must use the host terminal.
  if [[ "${SKIP_COMMIT_GATE:-0}" == "1" ]]; then
    # Check for OpenCode agent context via /proc/self/environ (non-overridable).
    # Shell env var assignments can clear OPENCODE_SESSION_ID, but /proc/self/environ
    # captures the initial inherited environment at process start time.
    # Fail-closed: if /proc/self/environ is unavailable, SKIP_COMMIT_GATE is refused
    # because we cannot verify non-OpenCode context.
    if [[ -r /proc/self/environ ]]; then
      local _environ_content
      _environ_content=$(tr '\0' '\n' < /proc/self/environ 2>/dev/null) || {
        json_out "{\"status\":\"error\",\"reason\":\"skip_gate_refused\",\"message\":\"Cannot read process environment. Use the host terminal escape hatch instead.\"}"
        return 1
      }
      if [[ "$_environ_content" == *"OPENCODE_SESSION_ID="* ]]; then
        json_out "{\"status\":\"error\",\"reason\":\"skip_gate_refused\",\"message\":\"SKIP_COMMIT_GATE is operator-only and cannot be used inside OpenCode. Use the host terminal escape hatch instead.\"}"
        return 1
      fi
    else
      json_out "{\"status\":\"error\",\"reason\":\"skip_gate_refused\",\"message\":\"Cannot verify non-OpenCode context (no /proc/self/environ). Use the host terminal escape hatch instead.\"}"
      return 1
    fi
    local subcmd="${1:-}"
    shift || true

    case "$subcmd" in
      acquire)
        local message=""
        local message_file=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --message)      message="$2"; shift 2 ;;
            --message-file) message_file="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ -n "$message_file" && -r "$message_file" ]]; then
          message=$(cat "$message_file")
        fi
        git add -A 2>/dev/null || true
        json_out "{\"status\":\"acquired\",\"skip_gate\":true}"
        return 0
        ;;
      commit)
        local message=""
        local message_file=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --message)      message="$2"; shift 2 ;;
            --message-file) message_file="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ -n "$message_file" && -r "$message_file" ]]; then
          message=$(cat "$message_file")
        fi
        if git commit -m "${message:-skip-gate commit}" 2>/dev/null; then
          local ch
          ch=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
          json_out "{\"status\":\"committed\",\"commit_hash\":\"${ch}\",\"skip_gate\":true}"
        else
          json_out "{\"status\":\"error\",\"reason\":\"git_commit_failed\",\"skip_gate\":true}"
          return 1
        fi
        return 0
        ;;
      release)
        rm -rf "$LOCK_DIR"
        json_out "{\"status\":\"released\",\"skip_gate\":true}"
        return 0
        ;;
      heartbeat)
        json_out "{\"status\":\"heartbeat_refreshed\",\"skip_gate\":true}"
        return 0
        ;;
      status)
        cmd_status
        return $?
        ;;
      stage-message)
        # Pure scratch-file write (no gating to bypass) -- routes to the same
        # handler as the normal path. Available in SKIP mode for symmetry.
        cmd_stage_message "$@"
        return $?
        ;;
      # NOTE: `revert` is deliberately NOT handled in the SKIP_COMMIT_GATE
      # switch. revert is the sanctioned alternative to the escape hatch (a
      # no-lock / no-CAS working-tree restore) and routes through the normal
      # gated dispatch above. Option B (a `revert)` case here piggybacking
      # the skip-gate branch) is explicitly REJECTED.
      *)
        json_out "{\"status\":\"error\",\"reason\":\"unknown_subcommand\",\"subcommand\":\"${subcmd}\"}"
        return 1
        ;;
    esac
  fi

  # Normal gated path
  local subcmd="${1:-}"
  shift || true

  case "$subcmd" in
    acquire)        cmd_acquire        "$@" ;;
    commit)         cmd_commit         "$@" ;;
    release)        cmd_release        "$@" ;;
    heartbeat)      cmd_heartbeat      "$@" ;;
    status)         cmd_status              ;;
    revert)         cmd_revert        "$@" ;;
    stage-message)  cmd_stage_message "$@" ;;
    *)
      json_out "{\"status\":\"error\",\"reason\":\"unknown_subcommand\",\"subcommand\":\"${subcmd}\"}"
      return 1
      ;;
  esac
}

main "$@"
