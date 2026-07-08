#!/usr/bin/env bash
# commit-gate.sh — Gated-commit wrapper (lock-free concurrency, v2 metadata)
#
# Subcommands (recommended — file-based form):
#   acquire   --paths-file FILE --message-file FILE [--session-alias ALIAS]
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
#
# Design: researches/decisions/2026-06-09-concurrent-commit-gate-design.md
# Spec: researches/decisions/2026-06-03-gated-commit-brief.md §§5-7

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
  epoch=$(stat -c %Y "$filepath" 2>/dev/null || echo 0)
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
#      (defense-in-depth for concurrent lock-free sessions).
_gate_gc_sweep() {
  local max_age="${COMMIT_GATE_GC_MAX_AGE:-$DEFAULT_GC_MAX_AGE}"

  # Early-out only when BOTH scratch surfaces are absent. $MSG_SCRATCH_DIR may
  # hold agent-owned message orphans even when $GATE_INDEX_DIR was cleaned, so
  # the gate must still get a chance to sweep it.
  [[ ! -d "$GATE_INDEX_DIR" && ! -d "$MSG_SCRATCH_DIR" ]] && return 0

  # Build the protected-UUID set (active lock UUID + _current_uuid value).
  local protected_uuids=()
  if [[ -d "$LOCK_DIR" ]]; then
    local lock_content lock_uuid
    lock_content=$(cat "$LOCK_META" 2>/dev/null || echo "{}")
    lock_uuid=$(_field_str "$lock_content" "uuid")
    [[ -n "$lock_uuid" ]] && protected_uuids+=("$lock_uuid")
  fi
  local cu_file="${GATE_INDEX_DIR}/_current_uuid"
  if [[ -f "$cu_file" ]]; then
    local cu_val
    cu_val=$(tr -d '[:space:]' < "$cu_file" 2>/dev/null || true)
    [[ -n "$cu_val" ]] && protected_uuids+=("$cu_val")
  fi
  # Also protect UUIDs with fresh session metadata (active concurrent sessions).
  local m
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local m_age m_uuid
    m_age=$(_file_age_seconds "$m" 2>/dev/null || echo "0")
    if [[ $m_age -le $max_age ]]; then
      m_uuid="${m#${GATE_INDEX_DIR}/meta-}"
      protected_uuids+=("$m_uuid")
    fi
  done < <(ls -1 "${GATE_INDEX_DIR}"/meta-* 2>/dev/null)

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

  return 0
}

# ---------------------------------------------------------------------------
# Stale-break (spec §3.4): remove stale lock directory
# ---------------------------------------------------------------------------
_stale_break() {
  local lockdir="$1" expected_uuid="$2"
  local stale_backup="${lockdir}.stale.$$"

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

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --message)       message="$2";       shift 2 ;;
      --message-file)  message_file="$2";  shift 2 ;;
      --paths)         paths="$2"; paths_provided=true; shift 2 ;;
      --paths-file)    paths_file="$2";    shift 2 ;;
      --session-alias) session_alias="$2"; shift 2 ;;
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

  # Clean up stale session metadata (older than TTL)
  if [[ -d "$GATE_INDEX_DIR" ]]; then
    local ttl="${COMMIT_GATE_TTL_SECONDS:-$DEFAULT_TTL}"
    local meta_file
    while IFS= read -r meta_file; do
      [[ -z "$meta_file" ]] && continue
      local meta_age
      meta_age=$(_file_age_seconds "$meta_file" 2>/dev/null || echo "0")
      if [[ $meta_age -gt $ttl ]]; then
        # Extract UUID from filename (meta-${UUID})
        local stale_uuid
        stale_uuid=$(basename "$meta_file" | sed 's/^meta-//')
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
          if ! GIT_INDEX_FILE="$private_index" git rm --cached -- "$p" 2>/dev/null; then
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
        json_out "{\"status\":\"cas_conflict\",\"reason\":\"merge_failed\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

      local new_tree
      new_tree=$(GIT_INDEX_FILE="$merge_index" git write-tree 2>/dev/null || echo "")
      rm -f "$merge_index" 2>/dev/null || true

      if [[ -z "$new_tree" ]]; then
        json_out "{\"status\":\"cas_conflict\",\"reason\":\"write_tree_failed\",\"original_head\":\"${head_at_acquire}\",\"current_head\":\"${current_head}\"}"
        return 1
      fi

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
        # Success — clean up
        rm -f "$private_index_path" 2>/dev/null || true
        rm -f "$(_session_meta_path "$lock_uuid")" 2>/dev/null || true
        _cleanup_own_scratch "$lock_uuid" "$message_file"
        _gate_gc_sweep || true
        # Resync shared index to new HEAD
        git read-tree HEAD 2>/dev/null || true
        local rebased_flag=""
        if [[ "$tree_hash" != "$original_tree" ]]; then
          rebased_flag=",\"rebased\":true,\"original_tree\":\"${original_tree}\""
        fi
        json_out "{\"status\":\"committed\",\"commit_hash\":\"${commit_hash}\",\"tree_hash\":\"${tree_hash}\",\"branch\":\"${branch}\",\"cas_attempts\":${cas_attempt}${rebased_flag}}"
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
    # Count stale sessions (older than TTL)
    local stale_count=0
    if [[ "$sessions_json" != "[]" ]]; then
      local ttl="${COMMIT_GATE_TTL_SECONDS:-$DEFAULT_TTL}"
      stale_count=$(ls -1 "$GATE_INDEX_DIR"/meta-* 2>/dev/null | while IFS= read -r f; do
        local a
        a=$(_file_age_seconds "$f" 2>/dev/null || echo "0")
        if [[ $a -gt $ttl ]]; then echo "stale"; fi
      done | wc -l | tr -d ' ')
      json_out "{\"status\":\"free\",\"note\":\"session_metadata_exists\",\"sessions\":${sessions_json},\"stale_count\":${stale_count}}"
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
  # Refreshes mtime on the per-session meta file so TTL-based stale cleanup
  # in cmd_acquire does not delete metadata for an active review.
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
# Design: researches/decisions/2026-06-09-concurrent-commit-gate-design.md
#   revert is a pre-acquire / post-FAIL working-tree op — NO lock, NO CAS,
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
      # the skip-gate branch) is explicitly REJECTED per
      # researches/decisions/2026-06-09-concurrent-commit-gate-design.md.
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
