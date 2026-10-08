#!/usr/bin/env bash
# End-to-end test: build the e2e image (real opencode + fake LLM + real
# vh-solara aggregator/web), run a real opencode session through it, and
# assert the prompt round-trips and the streamed assistant reply surfaces via
# the vh sync API.
#
#   tests/e2e-docker/run.sh [--keep] [--flow <all|1..9>]
#
# --flow N runs ONLY flow N with its own independent setup/cleanup (flows 8-9
# boot their own real local-server container; flows 1-7 share the e2eserver
# container and create the session they need). Default: all flows, in order.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

IMAGE=vh-solara-e2e
NAME=vh-e2e-run
PORT=8099
BASE="http://127.0.0.1:${PORT}"
# Flow 8 (death-watch self-heal) runs a SECOND container on the REAL
# production binary (`vh-solara local-server --opencode-detached`) instead of
# the bare e2eserver harness, so the operator's "kill my live opencode" ask is
# testable end-to-end: pkill opencode → watcher detects → status failed +
# down_since → death log line → auto-restart heals with a NEW pid.
NAME_REAL=vh-e2e-real
PORT_REAL=8098
BASE_REAL="http://127.0.0.1:${PORT_REAL}"
# Flow 9 (restart causality barrier, send-net-resilience slice 2b / AMEND-A7)
# runs a THIRD real local-server container. It pins the barrier semantics the
# certified redelivery class 3 rests on against REAL OpenCode: (A) a commit
# that completed before a restart SURVIVES it; (B) a prompt POSTed into the
# ambiguous in-flight window then killed mid-flight has a STABLE exact-ID
# observation (once observed it never flips — a classifier keyed on the GET
# is sound); (C) a prompt sent while down never lands (5xx, eternal 404).
NAME_BARRIER=vh-e2e-barrier
PORT_BARRIER=8097
BASE_BARRIER="http://127.0.0.1:${PORT_BARRIER}"

# --- args ---------------------------------------------------------------------
# Parsed (and validated) BEFORE any image/container side effect: an invalid
# selector must exit nonzero without touching docker state.
FLOW="all"
KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="--keep"; shift ;;
    --flow)
      [ $# -ge 2 ] || { echo "run.sh: --flow needs a value (all or 1..9)" >&2; exit 2; }
      FLOW="$2"; shift 2 ;;
    --flow=*) FLOW="${1#--flow=}"; shift ;;
    *) echo "run.sh: unknown argument: $1 (usage: run.sh [--keep] [--flow <all|1..9>])" >&2; exit 2 ;;
  esac
done
case "$FLOW" in
  all|1|2|3|4|5|6|7|8|9) ;;
  *) echo "run.sh: invalid --flow '${FLOW}' (want: all or 1..9)" >&2; exit 2 ;;
esac

# want_flow N: true when flow N is selected (or when all flows run).
want_flow() { [ "$FLOW" = "all" ] || [ "$FLOW" = "$1" ]; }

cleanup() {
  if [ "$KEEP" != "--keep" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rm -f "$NAME_REAL" >/dev/null 2>&1 || true
    docker rm -f "$NAME_BARRIER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- container logs ($NAME) -----" >&2
  docker logs "$NAME" 2>&1 | tail -60 >&2 || true
  echo "----- container logs ($NAME_REAL) -----" >&2
  docker logs "$NAME_REAL" 2>&1 | tail -60 >&2 || true
  echo "----- container logs ($NAME_BARRIER) -----" >&2
  docker logs "$NAME_BARRIER" 2>&1 | tail -60 >&2 || true
  exit 1
}

build_image() {
  echo "==> building $IMAGE (real opencode + fake LLM)"
  docker build -f Dockerfile.e2e -t "$IMAGE" . >/dev/null
}

boot_e2eserver() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "==> starting container"
  docker run -d --name "$NAME" -p "${PORT}:8099" "$IMAGE" >/dev/null

  echo "==> waiting for vh web server"
  for i in $(seq 1 60); do
    if curl -fsS "${BASE}/vh/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
    [ "$i" = 60 ] && fail "vh web server did not become ready"
  done
}

SID=""
# ensure_sid: flows that drive $SID reuse the session a prior flow created
# (the default all-flows run threads one SID from flow 1) or create their own
# when selected in isolation.
ensure_sid() {
  [ -n "$SID" ] && return 0
  echo "==> waiting for opencode session backend (create a session)"
  for i in $(seq 1 60); do
    SID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session" -H 'Content-Type: application/json' -d '{"title":"e2e"}' \
          | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
    [ -n "$SID" ] && break
    sleep 1
    [ "$i" = 60 ] && fail "could not create an opencode session"
  done
  echo "    session id: $SID"
}

build_image
# Flows 8-9 boot their own REAL local-server containers (inside their
# sections below); every other flow (1-7) drives the shared e2eserver
# container.
case "$FLOW" in
  8|9) ;;
  *) boot_e2eserver ;;
esac

# --- Flow 1: prompt -> streamed assistant reply -------------------------------
if want_flow 1; then
ensure_sid

echo "==> waiting for the created session to surface in the aggregated snapshot"
# Cold-hydrate readiness: the session-create 200 only proves OpenCode accepted
# the session. On a COLD aggregator the hydrate may still be retrying
# (pkg/aggregator/lifecycle.go: ~1s initial backoff growing x2, attempts capped
# at 30s each — a bounded ~120s ceiling covers 3 full-timeout failures plus a
# fast 4th). If the 30s stream capture below starts before the SID is in the
# aggregated store, the capture can expire before any of this session's message
# events surface. Poll the aggregated session surface (GET /vh/snapshot ->
# sessions[].id) until the created SID is visible; readiness only gates the
# capture — the prompt POST itself is still sent exactly once (never retried).
SID_VISIBLE=0
LAST_SNAP=""
for i in $(seq 1 120); do
  LAST_SNAP=$(curl -fsS "${BASE}/vh/snapshot" 2>/dev/null || true)
  if printf '%s' "$LAST_SNAP" | python3 -c '
import sys, json
sid = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
ids = [s.get("id", "") for s in d.get("sessions", [])]
sys.exit(0 if sid in ids else 1)
' "$SID"; then
    SID_VISIBLE=1
    echo "    sid ${SID} visible in aggregated snapshot (poll ${i}/120)"
    break
  fi
  sleep 1
done
if [ "$SID_VISIBLE" != "1" ]; then
  echo "----- last aggregated snapshot (truncated) -----" >&2
  printf '%s' "$LAST_SNAP" | head -c 400 >&2; echo >&2
  fail "created session never surfaced in the aggregated snapshot (poll ${i}/120, elapsed ~${i}s, sid=${SID})"
fi

echo "==> capturing the live /vh/stream while prompting"
STREAM_FILE=$(mktemp)
# sessions=all opts into the full firehose (message/part for every session); the
# default stream only carries message events for the subscribed/active session.
( curl -fsS -N --max-time 30 "${BASE}/vh/stream?cursor=0&sessions=all" > "$STREAM_FILE" 2>/dev/null & )
sleep 1 # let the stream subscribe before we prompt

echo "==> sending a prompt (real opencode -> fake LLM)"
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session/${SID}/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello from e2e"}]}' >/dev/null \
  || fail "prompt POST failed"

echo "==> polling for the streamed assistant reply via /vh/snapshot"
for i in $(seq 1 60); do
  SNAP=$(curl -fsS "${BASE}/vh/snapshot?sessions=${SID}" 2>/dev/null || true)
  RESULT=$(printf '%s' "$SNAP" | python3 "${repo_root}/tests/e2e-docker/assert.py" "$SID" 2>/dev/null || true)
  STATUS=$(echo "$RESULT" | sed -n '1p')
  if [ "$STATUS" = "OK" ]; then
    echo "    $(echo "$RESULT" | sed -n '2p')"
    echo "    $(echo "$RESULT" | sed -n '3p')"
    break
  fi
  sleep 1
  [ "$i" = 60 ] && fail "assistant reply not observed (last: $RESULT)"
done

echo "==> verifying the live /vh/stream delivered streaming events"
sleep 1
# SSE frames are `event: <kind>` + `data: <raw payload>`; match the event line.
if ! grep -q '^event: message.upsert' "$STREAM_FILE"; then
  echo "----- stream capture -----" >&2; tail -20 "$STREAM_FILE" >&2
  fail "no message.upsert events on /vh/stream"
fi
if ! grep -q '^event: part.upsert' "$STREAM_FILE"; then
  fail "no part.upsert (streaming) events on /vh/stream"
fi
if ! grep -q 'FAKE-LLM reply' "$STREAM_FILE"; then
  fail "streamed assistant text not seen on /vh/stream"
fi
STREAM_PARTS=$(grep -c '^event: part.upsert' "$STREAM_FILE" || true)
rm -f "$STREAM_FILE"
echo "    live stream delivered ${STREAM_PARTS} part.upsert event(s)"
fi # flow 1

# --- Flow 2: tool execution -> file diff -------------------------------------
if want_flow 2; then
ensure_sid
echo "==> [tool flow] prompting the model to call the write tool"
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session/${SID}/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"[[write]] please update the readme"}]}' >/dev/null \
  || fail "write-prompt POST failed"

for i in $(seq 1 60); do
  SNAP=$(curl -fsS "${BASE}/vh/snapshot?sessions=${SID}" 2>/dev/null || true)
  RESULT=$(printf '%s' "$SNAP" | python3 "${repo_root}/tests/e2e-docker/assert_tool.py" "$SID" 2>/dev/null || true)
  [ "$(echo "$RESULT" | sed -n 1p)" = "OK" ] && { echo "    $(echo "$RESULT" | sed -n 2p)"; break; }
  sleep 1
  [ "$i" = 60 ] && fail "write tool part not observed ($RESULT)"
done

echo "==> [tool flow] checking the resulting git diff via /oc/vcs/diff"
for i in $(seq 1 30); do
  DIFF=$(curl -fsS "${BASE}/oc/vcs/diff?mode=git" 2>/dev/null || true)
  echo "$DIFF" | grep -q 'README.md' && { echo "    diff includes README.md"; break; }
  sleep 1
  [ "$i" = 30 ] && fail "git diff did not include the written file (got: ${DIFF:0:160})"
done
fi # flow 2

# --- Flow 3: task tool -> subsession -----------------------------------------
if want_flow 3; then
ensure_sid
echo "==> [subsession flow] prompting the model to spawn a subagent (task tool)"
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session/${SID}/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"[[task]] run a subtask"}]}' >/dev/null \
  || fail "task-prompt POST failed"

for i in $(seq 1 90); do
  TREE=$(curl -fsS "${BASE}/vh/snapshot?sessions=" 2>/dev/null || true)
  RESULT=$(printf '%s' "$TREE" | python3 "${repo_root}/tests/e2e-docker/assert_sub.py" "$SID" 2>/dev/null || true)
  [ "$(echo "$RESULT" | sed -n 1p)" = "OK" ] && { echo "    $(echo "$RESULT" | sed -n 2p)"; break; }
  sleep 1
  [ "$i" = 90 ] && fail "subsession (child of $SID) not observed ($RESULT)"
done
fi # flow 3

# --- Flow 4: permission round-trip -------------------------------------------
# opencode is configured with bash="ask", so a bash tool call pauses the turn on
# a permission request. This is the gold-standard check: it exercises the real
# `permission.asked` event surfacing through the aggregator AND the reply route
# resuming the turn — the exact path the earlier permission bugs broke.
if want_flow 4; then
ensure_sid
echo "==> [permission flow] prompting the model to call the bash tool (asks permission)"
# The /message POST blocks until the turn completes, but this turn pauses on a
# permission request — so fire it in the background and drive the reply below.
( curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session/${SID}/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"[[bash]] run a command"}]}' >/dev/null 2>&1 & )

echo "==> [permission flow] waiting for the aggregator to surface the pending permission"
PID=""
for i in $(seq 1 60); do
  SNAP=$(curl -fsS "${BASE}/vh/snapshot?sessions=${SID}" 2>/dev/null || true)
  RESULT=$(printf '%s' "$SNAP" | python3 "${repo_root}/tests/e2e-docker/assert_perm.py" "$SID" 2>/dev/null || true)
  if [ "$(echo "$RESULT" | sed -n 1p)" = "OK" ]; then
    PID=$(echo "$RESULT" | sed -n 2p)
    echo "    pending permission id: $PID"
    break
  fi
  sleep 1
  [ "$i" = 60 ] && fail "pending bash permission not surfaced via the aggregator ($RESULT)"
done

echo "==> [permission flow] replying 'once' via /oc/permission/:id/reply (canonical route)"
# Mirror the frontend respondPermission: canonical route first, legacy fallback.
if ! curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/permission/${PID}/reply" \
     -H 'Content-Type: application/json' -d '{"reply":"once"}' >/dev/null 2>&1; then
  echo "    canonical route failed; trying legacy session-scoped route"
  curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session/${SID}/permissions/${PID}" \
    -H 'Content-Type: application/json' -d '{"response":"once"}' >/dev/null \
    || fail "permission reply failed on both routes"
fi

echo "==> [permission flow] verifying the turn resumed and finished"
for i in $(seq 1 60); do
  SNAP=$(curl -fsS "${BASE}/vh/snapshot?sessions=${SID}" 2>/dev/null || true)
  RESULT=$(printf '%s' "$SNAP" | python3 "${repo_root}/tests/e2e-docker/assert_perm_done.py" "$SID" 2>/dev/null || true)
  [ "$(echo "$RESULT" | sed -n 1p)" = "OK" ] && { echo "    $(echo "$RESULT" | sed -n 3p)"; break; }
  sleep 1
  [ "$i" = 60 ] && fail "turn did not resume after permission reply ($RESULT)"
done
fi # flow 4

# ===========================================================================
# Flow 5: server-owned session tree (tree=2) -- Phase 2 docker-gold gate.
#
# Seeds a synthetic forest into the container's opencode SQLite, forces a
# rehydrate so the rows enter the aggregator store (raw INSERTs fire no
# session.created event, and the reconcile ticker only catches ghosts/clobbers,
# not new rows), then asserts the four tree=2 behaviors against the REAL
# stream/expand endpoints:
#   A. cold snapshot ships a BOUNDED frontier (<< seeded total); deep idle
#      subtrees collapse to one placeholder (descendantCount > childCount).
#   B. expand paginates a wide node (page1=50 hasMore, page2=10 terminal).
#   C. a raw SQLite DELETE (NO session.deleted event) is caught by the
#      reconcile ticker -> node.remove on the live stream, no resurrection.
#      (THE CRUX: only real opencode SQLite + a raw row delete can produce a
#      genuine missed delete; the in-process e2e's fake opencode cannot.)
#   D. reconnect at the head cursor replays nothing (no snapshot re-ship).
# All seeded rows use the id prefix ses_tree_ so they never collide with the
# real e2e session/subsession exercised above.
# ===========================================================================
if want_flow 5; then
# The seeder (seed_tree.py) self-calibrates project_id/directory/version from
# an existing REAL session row; the default all-flows run gets it from flow 1,
# so an isolated flow-5 run must create it itself.
ensure_sid
echo "==> [tree flow] seeding synthetic forest into container opencode SQLite"
SEED_SQL=$(mktemp)
python3 "$repo_root/tests/e2e-docker/seed_tree.py" > "$SEED_SQL" \
  || fail "seed SQL generation failed"
DBPATH=$(docker exec "$NAME" sh -c 'echo "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"')
[ -n "$DBPATH" ] || fail "could not resolve opencode db path in container"
# Wait until the calibration session's row is actually persisted (opencode
# may write it async to the create POST's 200): the seed's self-calibrating
# subqueries need >=1 real row.
for i in $(seq 1 15); do
  REAL_ROWS=$(docker exec "$NAME" sqlite3 "$DBPATH" "SELECT COUNT(*) FROM session;" 2>/dev/null || true)
  [ "${REAL_ROWS:-0}" -ge 1 ] && break
  sleep 1
  [ "$i" = 15 ] && fail "no real session row in container DB for seed calibration (count=${REAL_ROWS:-0})"
done
echo "    calibration rows in container opencode DB: ${REAL_ROWS:-0}"
docker cp "$SEED_SQL" "$NAME":/tmp/seed.sql >/dev/null \
  || fail "docker cp seed.sql failed"
docker exec "$NAME" sqlite3 "$DBPATH" ".read /tmp/seed.sql" \
  || fail "seed SQL apply failed"
rm -f "$SEED_SQL"

# Confirm the seed applied by counting ses_tree_ rows directly in the
# container opencode SQLite (authoritative, unaffected by /session's default
# page cap). opencode re-reads session rows fresh from the DB on every
# /session call, so a present row IS servable; the aggregator's ListSessions
# uses adaptive paging (sessionPageSize=2000, see pkg/opencode/client.go) so
# the store hydrates all 568 -- verified next by polling the tree=2 snapshot.
echo "==> [tree flow] confirming seeded rows are present in container opencode DB"
SEED_COUNT=$(docker exec "$NAME" sqlite3 "$DBPATH" \
  "SELECT COUNT(*) FROM session WHERE id LIKE 'ses_tree_%';") \
  || fail "could not count seeded rows in container DB"
[ "${SEED_COUNT:-0}" -ge 568 ] \
  || fail "seeded rows missing from container DB (got ${SEED_COUNT:-0}, want >=568)"
echo "    seeded sessions in container opencode DB: $SEED_COUNT"

echo "==> [tree flow] forcing aggregator rehydrate so the seed enters the store (POST /vh/reload)"
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/vh/reload" >/dev/null \
  || fail "POST /vh/reload failed"
# Wait for the rehydrate to land the seeded tree in the store by polling the
# tree=2 snapshot for a known seeded root.
for i in $(seq 1 30); do
  TS=$(mktemp)
  curl -fsS -N --max-time 4 "${BASE}/vh/stream?tree=2" > "$TS" 2>/dev/null || true
  if grep -q 'ses_tree_root_deep' "$TS"; then rm -f "$TS"; break; fi
  rm -f "$TS"
  sleep 1
  [ "$i" = 30 ] && fail "seeded tree did not surface on tree=2 stream after reload"
done
echo "    seeded tree present on tree=2 stream"

# --- A. LAZY FRONTIER -------------------------------------------------------
echo "==> [tree flow] A: asserting bounded cold frontier"
A_SNAP=$(mktemp)
curl -fsS -N --max-time 6 "${BASE}/vh/stream?tree=2" > "$A_SNAP" 2>/dev/null || true
A_RES=$(python3 "$repo_root/tests/e2e-docker/assert_tree_snapshot.py" < "$A_SNAP")
rm -f "$A_SNAP"
[ "$(echo "$A_RES" | sed -n 1p)" = "OK" ] \
  || fail "behavior A (lazy frontier) failed ($A_RES)"
echo "    A OK: $(echo "$A_RES" | sed -n 2p)"
echo "         $(echo "$A_RES" | sed -n 3p)"

# --- B. EXPAND --------------------------------------------------------------
echo "==> [tree flow] B: asserting expand pagination (wide node)"
B_P1=$(mktemp)
curl -fsS "${BASE}/vh/tree/children?id=ses_tree_root_wide" > "$B_P1" 2>/dev/null || true
B_RES1=$(python3 "$repo_root/tests/e2e-docker/assert_tree_expand.py" page1 < "$B_P1")
[ "$(echo "$B_RES1" | sed -n 1p)" = "OK" ] || { rm -f "$B_P1"; fail "behavior B page1 failed ($B_RES1)"; }
WIDE_CURSOR=$(echo "$B_RES1" | sed -n 3p)
rm -f "$B_P1"
echo "    B page1 OK: $(echo "$B_RES1" | sed -n 2p) (cursor=$WIDE_CURSOR)"
B_P2=$(mktemp)
curl -fsS "${BASE}/vh/tree/children?id=ses_tree_root_wide&cursor=${WIDE_CURSOR}" > "$B_P2" 2>/dev/null || true
B_RES2=$(python3 "$repo_root/tests/e2e-docker/assert_tree_expand.py" page2 < "$B_P2")
rm -f "$B_P2"
[ "$(echo "$B_RES2" | sed -n 1p)" = "OK" ] || fail "behavior B page2 failed ($B_RES2)"
echo "    B page2 OK: $(echo "$B_RES2" | sed -n 2p)"

# --- C. MISSED-DELETE RECONCILE (THE CRUX -- Phase 2->3 gate) ----------------
# Determinism contract (why the archive seed below exists): the tree reconcile
# ticker full-scans for ghosts EVERY 10s tick only while a live archive
# tombstone exists (pkg/aggregator/reconciliation.go runTreeReconcile ->
# HasLiveArchiveTombstones); with no tombstone it full-reconciles only once
# per the 2m idle interval — far outside any bounded capture window. The seed:
# archive an UNRELATED disposable session through the REAL /vh/archive route.
# The cascade is ASYNC (the POST 200 returns before the store removes the id),
# so completion must be observed as the id DISAPPEARING from the live
# snapshot; that removal is also what arms the 30s tombstone
# (RemoveSessionIfPresent -> recentlyArchived) — the observation starts the
# TTL clock. The victim is NEVER archived (a tombstoned id's absence from
# /session is the expected archive path, not a ghost — pkg/state
# tree_reconcile.go), so its raw-DB absence still classifies as a ghost and is
# evicted with node.remove.
echo "==> [tree flow] C: asserting missed-delete reconcile (raw SQLite delete -> node.remove)"
C_STREAM=$(mktemp)
# Open the long-lived tree=2 stream FIRST: its cold snapshot makes the victim
# `known` to this connection (node.remove is only emitted for known ids)
# BEFORE the tombstone clock starts.
SECONDS=0
( curl -fsS -N --max-time 45 "${BASE}/vh/stream?tree=2" > "$C_STREAM" 2>/dev/null & )
sleep 2  # let the stream subscribe + receive its cold snapshot
if ! grep -q 'ses_tree_victim' "$C_STREAM"; then
  rm -f "$C_STREAM"; fail "victim not present in C stream snapshot (not known)"
fi

snap_has_id() {
  # exit 0 iff $1 is present in the live snapshot's sessions[] list
  curl -fsS "${BASE}/vh/snapshot" 2>/dev/null | python3 -c '
import sys, json
want = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
ids = [s.get("id", "") for s in d.get("sessions", [])]
sys.exit(0 if want in ids else 1)
' "$1"
}

echo "==> [tree flow] C: seeding the fast-reconcile tombstone (archive an unrelated disposable session)"
SEED_SID=""
for i in $(seq 1 30); do
  SEED_SID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session" \
        -H 'Content-Type: application/json' -d '{"title":"archive-seed"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$SEED_SID" ] && break
  sleep 1
  [ "$i" = 30 ] && { rm -f "$C_STREAM"; fail "[tree flow] C: could not create the disposable archive-seed session"; }
done
echo "    disposable session: $SEED_SID"
# It must be VISIBLE in the live tree before archiving: only then does its
# later disappearance mean the cascade actually completed.
SEED_VISIBLE=0
for i in $(seq 1 30); do
  if snap_has_id "$SEED_SID"; then SEED_VISIBLE=1; break; fi
  sleep 1
  [ "$i" = 30 ] && { rm -f "$C_STREAM"; fail "[tree flow] C: disposable session never surfaced in the live snapshot"; }
done
echo "    disposable session visible in the live tree (poll ${i})"
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/vh/archive" \
     -H 'Content-Type: application/json' -d "{\"sessionID\":\"${SEED_SID}\"}" >/dev/null \
  || { rm -f "$C_STREAM"; fail "[tree flow] C: POST /vh/archive for the disposable session failed"; }
# Completion = the id GONE from the live tree (NOT the POST 200 — the cascade
# is async). This observation starts the 30s tombstone TTL; from here the
# remaining steps run back-to-back with NO sleeps before the raw delete.
SEED_GONE=0
for i in $(seq 1 15); do
  if ! snap_has_id "$SEED_SID"; then SEED_GONE=1; break; fi
  sleep 1
  [ "$i" = 15 ] && { rm -f "$C_STREAM"; fail "[tree flow] C: archive cascade completion not observed (${SEED_SID} still in the live tree after ~${i}s)"; }
done
echo "    archive cascade observed complete: ${SEED_SID} gone from the live tree (tombstone armed, 30s TTL running)"

# --- back-to-back from here: NO sleeps before the raw delete -----------------
echo "==> [tree flow] C: raw-deleting ses_tree_victim in container opencode SQLite (bypasses app -> no event)"
docker exec "$NAME" sqlite3 "$DBPATH" "DELETE FROM session WHERE id='ses_tree_victim';" \
  || { rm -f "$C_STREAM"; fail "raw delete of victim failed"; }
# The next 10s reconcile tick (full scan: the tombstone is live) finds the
# victim gone from OpenCode's /session list and emits node.remove for it;
# later ticks inside the capture must NOT resurrect it. Sleep out the
# remainder of the 45s capture window + 1s flush buffer, then assert.
C_REMAIN=$(( 46 - SECONDS ))
[ "$C_REMAIN" -gt 1 ] && sleep "$C_REMAIN"
C_RES=$(python3 "$repo_root/tests/e2e-docker/assert_tree_reconcile.py" < "$C_STREAM")
rm -f "$C_STREAM"
[ "$(echo "$C_RES" | sed -n 1p)" = "OK" ] \
  || fail "behavior C (missed-delete reconcile) FAILED -- PHASE 2->3 GATE BLOCKED ($C_RES)"
echo "    C OK: $(echo "$C_RES" | sed -n 2p)"

# --- D. RECONNECT -----------------------------------------------------------
echo "==> [tree flow] D: asserting reconnect cursor-replay (no re-ship)"
D_INIT=$(mktemp)
curl -fsS -N --max-time 4 "${BASE}/vh/stream?tree=2" > "$D_INIT" 2>/dev/null || true
HEAD_SEQ=$(python3 -c '
import sys,json
want=False
for line in sys.stdin:
    if line.startswith("event:"):
        want = line.split(":",1)[1].strip()=="tree.snapshot"; continue
    if want and line.startswith("data:"):
        try: print(json.loads(line.split(":",1)[1].strip()).get("seq",""))
        except Exception: print("")
        break
' < "$D_INIT")
rm -f "$D_INIT"
[ -n "$HEAD_SEQ" ] || fail "could not extract head seq from initial snapshot"
echo "    head seq captured: $HEAD_SEQ"
D_RECONN=$(mktemp)
curl -fsS -N --max-time 4 -H "Last-Event-ID: ${HEAD_SEQ}" "${BASE}/vh/stream?tree=2" > "$D_RECONN" 2>/dev/null || true
D_RES=$(python3 "$repo_root/tests/e2e-docker/assert_tree_reconnect.py" "$HEAD_SEQ" < "$D_RECONN")
rm -f "$D_RECONN"
[ "$(echo "$D_RES" | sed -n 1p)" = "OK" ] || fail "behavior D (reconnect) failed ($D_RES)"
echo "    D OK: $(echo "$D_RES" | sed -n 2p)"
fi # flow 5

# ===========================================================================
# Flow 6: caller-minted messageID + exact message GET (queue->message-ID
# reconcile contract) -- docker-gold backstop.
#
# The in-process e2e (tests/e2e/) runs against the FAKE opencode, which could
# model behavior real opencode lacks. This flow proves -- against REAL opencode
# -- the OpenCode-side contract vh-solara's queue reconciler depends on (source
# packet: researches/sources/opencode-v1.17.18-messageid-exact-lookup.md). It
# hits opencode's contract DIRECTLY through the transparent /oc/ passthrough
# (handlePassthrough forwards bodies+statuses verbatim; NO vh-solara queue is
# involved -- the queue mints its own id, which would short-circuit the probe):
#   1. prompt_async {"messageID":"msg_<ascending>", ...} -> 204 (caller-id-wins,
#      turn accepted + forked; persistence async to the 204).
#   2. after a bounded wait, GET .../message/<minted> -> 200 with info.id===minted
#      AND role==="user" (caller-id-wins, NO remint -- exact-match authority).
#   3. GET <OTHER_SESSION>/message/<minted> -> 404 (composite key id AND
#      session_id -> session isolation).
#   4. GET .../message/<non-msg-id> -> 400 (brand rejection -- caller bug).
# ===========================================================================
if want_flow 6; then
ensure_sid
echo "==> [msgid flow] minting a valid ascending msg_ id (replicates pkg/opencode/id.go)"
MINTED=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "could not mint msg_ id"
echo "    minted id: $MINTED"

echo "==> [msgid flow] creating a second session for the isolation check"
OTHER_SID=""
for i in $(seq 1 30); do
  OTHER_SID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session" \
        -H 'Content-Type: application/json' -d '{"title":"msgid-iso"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$OTHER_SID" ] && break
  sleep 1
  [ "$i" = 30 ] && fail "could not create a second session for the isolation check"
done
echo "    other session id: $OTHER_SID"

# --- 1. prompt_async with caller messageID -> 204 ---------------------------
echo "==> [msgid flow] 1: POST prompt_async with caller messageID (expect 204)"
PASYNC_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H 'X-VH-CSRF: 1' \
  -X POST "${BASE}/oc/session/${SID}/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"${MINTED}\",\"parts\":[{\"type\":\"text\",\"text\":\"msgid contract probe\"}]}" \
  || true)
[ "$PASYNC_CODE" = "204" ] \
  || fail "[msgid flow] prompt_async with messageID did not return 204 (got $PASYNC_CODE)"
echo "    1 OK: prompt_async -> 204 (turn accepted + forked, persistence async)"

# --- 2. exact GET resolves to the persisted caller-minted user message ------
# Persistence is ASYNC to the 204 (Effect.forkIn), so a lookup immediately after
# the 204 may legitimately 404. Poll until 200 + exact match, bounded.
echo "==> [msgid flow] 2: polling GET .../message/<minted> for the persisted user message"
MSGID_OK=""
for i in $(seq 1 60); do
  G2B=$(mktemp)
  G2CODE=$(curl -s -o "$G2B" -w "%{http_code}" "${BASE}/oc/session/${SID}/message/${MINTED}" 2>/dev/null || true)
  if [ "$G2CODE" = "200" ]; then
    G2RES=$(python3 "$repo_root/tests/e2e-docker/assert_msgid_get.py" "$MINTED" < "$G2B" 2>/dev/null || true)
    if [ "$(echo "$G2RES" | sed -n 1p)" = "OK" ]; then
      MSGID_OK=1
      echo "    2 OK: $(echo "$G2RES" | sed -n 2p)"
      echo "         $(echo "$G2RES" | sed -n 3p)"
    fi
  elif [ "$G2CODE" = "404" ]; then
    : # not persisted yet -- keep polling (persistence is async to the 204)
  else
    rm -f "$G2B"; fail "[msgid flow] unexpected GET status $G2CODE for minted id"
  fi
  rm -f "$G2B"
  [ -n "$MSGID_OK" ] && break
  sleep 1
  [ "$i" = 60 ] && fail "[msgid flow] persisted user message not observed via exact GET (last status=$G2CODE)"
done

# --- 3. session isolation: cross-session GET -> 404 -------------------------
# Composite key id AND session_id: the minted id lives under SID, so querying a
# DIFFERENT session must 404 (cannot accidentally resolve cross-session).
echo "==> [msgid flow] 3: GET <OTHER_SESSION>/message/<minted> (expect 404 isolation)"
ISO_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/oc/session/${OTHER_SID}/message/${MINTED}" 2>/dev/null || true)
[ "$ISO_CODE" = "404" ] \
  || fail "[msgid flow] cross-session GET did not return 404 (got $ISO_CODE; isolation broken)"
echo "    3 OK: GET <other session>/message/<minted> -> 404 (composite-key isolation)"

# --- 4. brand rejection: non-msg id -> 400 ---------------------------------
echo "==> [msgid flow] 4: GET .../message/<non-msg-id> (expect 400 brand rejection)"
BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/oc/session/${SID}/message/not_a_msg_id" 2>/dev/null || true)
[ "$BAD_CODE" = "400" ] \
  || fail "[msgid flow] non-msg id GET did not return 400 (got $BAD_CODE; brand check differs from contract)"
echo "    4 OK: GET .../message/not_a_msg_id -> 400 (brand rejection)"
fi # flow 6

# ===========================================================================
# Flow 7: queue Claim -> dispatch -> real-opencode persist -> turn-start
# ordering (queue-claim-ordering contract) -- docker-gold backstop.
#
# The in-process e2e (tests/e2e/) runs against the FAKE opencode, which could
# model behavior real opencode lacks. This flow proves -- against REAL opencode
# -- the ordering crux the vh-solara queue reconciler depends on:
#   * Claim (pkg/web/queue.go Claim) is mutex-serialized + atomic: it persists
#     opencodeMsgID (via opencode.MintMessageID, a valid msg_ ascending id) AND
#     transitions the item pending->dispatching in the SAME atomic save, BEFORE
#     any dispatch POST hits the network. So the persisted id is observable via
#     the list endpoint BEFORE the dispatch is issued (THE CRUX).
# The flow uses the REAL vh-solara queue endpoints (enqueue + claim + list) to
# obtain the Claim-minted id, then dispatches through opencode's transparent
# /oc/ passthrough (prompt_async) threading that id as messageID -- mirroring
# how the browser dispatch path consumes a claimed item. It then asserts:
#   1. enqueue -> item id.
#   2. claim -> {opencodeMsgID, state=="dispatching"}.
#   3. (CRUX, before dispatch) list -> the claimed item shows
#      state=="dispatching" AND opencodeMsgID == $MINTED (Claim persisted the
#      id before any dispatch POST reached the network).
#   4. dispatch: prompt_async {"messageID":"$MINTED", ...} -> 204.
#   5. real opencode persisted the user message under $MINTED (assert_msgid_get).
#   6. the turn started (assert_turn_started: gate[sid].activity == "busy").
# A FRESH session is used so the idle->busy transition unambiguously attributes
# to THIS dispatch: the shared $SID carries several prior turns whose residual
# busy/idle state could mask whether Flow 7's dispatch drove the transition.
# ===========================================================================
if want_flow 7; then
echo "==> [queue-claim flow] creating a fresh session for a clean turn-start"
QSID=""
for i in $(seq 1 30); do
  QSID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session" \
        -H 'Content-Type: application/json' -d '{"title":"queue-claim-ordering"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$QSID" ] && break
  sleep 1
  [ "$i" = 30 ] && fail "could not create a fresh session for the queue-claim flow"
done
echo "    queue-claim session id: $QSID"

# --- 1. enqueue a queue item ------------------------------------------------
echo "==> [queue-claim flow] 1: POST /vh/session/$QSID/queue (enqueue)"
QENQ=$(mktemp)
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/vh/session/${QSID}/queue" \
  -H 'Content-Type: application/json' \
  -d '{"text":"queue-ordering probe Q7"}' > "$QENQ" \
  || { rm -f "$QENQ"; fail "[queue-claim flow] enqueue POST failed"; }
QITEM=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("item",{}).get("id",""))' < "$QENQ" 2>/dev/null || true)
rm -f "$QENQ"
[ -n "$QITEM" ] || fail "[queue-claim flow] enqueue response carried no item id"
echo "    1 OK: enqueued item id: $QITEM"

# --- 2. claim -> capture opencodeMsgID, assert state==dispatching -----------
echo "==> [queue-claim flow] 2: POST /vh/session/$QSID/queue/claim (expect dispatching + opencodeMsgID)"
QCLAIM=$(mktemp)
curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/vh/session/${QSID}/queue/claim" > "$QCLAIM" 2>/dev/null \
  || { rm -f "$QCLAIM"; fail "[queue-claim flow] claim POST failed"; }
MINTED=$(python3 -c 'import sys,json;it=json.load(sys.stdin).get("item") or {};print(it.get("opencodeMsgID",""))' < "$QCLAIM" 2>/dev/null || true)
QSTATE=$(python3 -c 'import sys,json;it=json.load(sys.stdin).get("item") or {};print(it.get("state",""))' < "$QCLAIM" 2>/dev/null || true)
rm -f "$QCLAIM"
[ -n "$MINTED" ] || fail "[queue-claim flow] claim returned no opencodeMsgID (Claim did not mint)"
[ "$QSTATE" = "dispatching" ] \
  || fail "[queue-claim flow] claimed item state=$QSTATE (want dispatching; Claim did not transition)"
echo "    2 OK: claim -> state=$QSTATE, opencodeMsgID=$MINTED"

# --- 3. (CRUX, BEFORE dispatch) list shows the id persisted pre-dispatch -----
# Load-bearing ordering assertion: Claim persisted opencodeMsgID in the SAME
# atomic save as pending->dispatching, BEFORE any dispatch POST. The list
# endpoint reads the persisted queue.json, so it MUST surface the id NOW --
# before a single dispatch byte has hit the network.
echo "==> [queue-claim flow] 3 (CRUX): GET /vh/session/$QSID/queue BEFORE dispatch (expect id persisted pre-dispatch)"
QLIST=$(mktemp)
curl -fsS "${BASE}/vh/session/${QSID}/queue" > "$QLIST" 2>/dev/null \
  || { rm -f "$QLIST"; fail "[queue-claim flow] list GET failed"; }
LIST_ID=$(QITEM="$QITEM" python3 -c 'import sys,json,os;q=os.environ["QITEM"];d=json.load(sys.stdin);print(next((it.get("opencodeMsgID","") for it in d.get("items",[]) if it.get("id")==q),""))' < "$QLIST" 2>/dev/null || true)
LIST_STATE=$(QITEM="$QITEM" python3 -c 'import sys,json,os;q=os.environ["QITEM"];d=json.load(sys.stdin);print(next((it.get("state","") for it in d.get("items",[]) if it.get("id")==q),""))' < "$QLIST" 2>/dev/null || true)
rm -f "$QLIST"
[ "$LIST_ID" = "$MINTED" ] \
  || fail "[queue-claim flow] pre-dispatch list opencodeMsgID=$LIST_ID (want $MINTED; Claim did NOT persist the id before dispatch -- ORDERING BROKEN)"
[ "$LIST_STATE" = "dispatching" ] \
  || fail "[queue-claim flow] pre-dispatch list state=$LIST_STATE (want dispatching)"
echo "    3 OK: list (pre-dispatch) shows opencodeMsgID=$LIST_ID, state=$LIST_STATE -- Claim persisted the id BEFORE any dispatch POST"

# --- 4. dispatch: prompt_async with the Claim-minted messageID -> 204 -------
echo "==> [queue-claim flow] 4: POST prompt_async with Claim-minted messageID (expect 204)"
QPASYNC_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H 'X-VH-CSRF: 1' \
  -X POST "${BASE}/oc/session/${QSID}/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"${MINTED}\",\"parts\":[{\"type\":\"text\",\"text\":\"queue-ordering probe Q7\"}]}" \
  || true)
[ "$QPASYNC_CODE" = "204" ] \
  || fail "[queue-claim flow] prompt_async with Claim-minted messageID did not return 204 (got $QPASYNC_CODE)"
echo "    4 OK: prompt_async -> 204 (turn accepted + forked under the Claim-minted id)"

# --- 5. real opencode persisted the user message under the Claim id ---------
# Mirrors Flow 6 step 2: persistence is ASYNC to the 204 (Effect.forkIn), so a
# lookup immediately after the 204 may legitimately 404. Poll until 200 + exact
# match (info.id==MINTED && info.role=="user") via the existing assert helper.
echo "==> [queue-claim flow] 5: polling GET .../message/<claim-minted> for the persisted user message"
QMSG_OK=""
for i in $(seq 1 60); do
  QGB=$(mktemp)
  QGCODE=$(curl -s -o "$QGB" -w "%{http_code}" "${BASE}/oc/session/${QSID}/message/${MINTED}" 2>/dev/null || true)
  if [ "$QGCODE" = "200" ]; then
    QGRES=$(python3 "$repo_root/tests/e2e-docker/assert_msgid_get.py" "$MINTED" < "$QGB" 2>/dev/null || true)
    if [ "$(echo "$QGRES" | sed -n 1p)" = "OK" ]; then
      QMSG_OK=1
      echo "    5 OK: $(echo "$QGRES" | sed -n 2p)"
      echo "         $(echo "$QGRES" | sed -n 3p)"
    fi
  elif [ "$QGCODE" = "404" ]; then
    : # not persisted yet -- keep polling (persistence is async to the 204)
  else
    rm -f "$QGB"; fail "[queue-claim flow] unexpected GET status $QGCODE for claim-minted id"
  fi
  rm -f "$QGB"
  [ -n "$QMSG_OK" ] && break
  sleep 1
  [ "$i" = 60 ] && fail "[queue-claim flow] persisted user message not observed under the claim-minted id (last status=$QGCODE)"
done

# --- 6. the turn started (gate activity -> busy) ----------------------------
echo "==> [queue-claim flow] 6: polling /vh/snapshot for gate.activity==busy (turn started)"
for i in $(seq 1 60); do
  SNAP=$(curl -fsS "${BASE}/vh/snapshot?sessions=${QSID}" 2>/dev/null || true)
  RESULT=$(printf '%s' "$SNAP" | python3 "$repo_root/tests/e2e-docker/assert_turn_started.py" "$QSID" 2>/dev/null || true)
  [ "$(echo "$RESULT" | sed -n 1p)" = "OK" ] && { echo "    6 OK: $(echo "$RESULT" | sed -n 2p)"; break; }
  sleep 1
  [ "$i" = 60 ] && fail "[queue-claim flow] turn did not start after dispatch ($RESULT)"
done
fi # flow 7

# ===========================================================================
# Flow 8: death-watch self-heal against the REAL production binary.
#
# The operator's ask, automated: "kill my live opencode and prove the daemon
# detects it, tells me, and brings it back." Flows 1-7 run against
# tools/e2eserver (a bare exec harness with NO watcher), so this flow boots a
# SEPARATE container running the real `vh-solara local-server` in the
# production detached topology. Asserted, end to end:
#   1. pkill -x opencode → /vh/opencode/status flips to
#      "state":"failed" WITH "down_since" (the S2 retry-storm gate's input).
#   2. the death-watch log line names the dead pid
#      (cmd/opencode_watch.go: "opencode watch: pid N exited (…)).
#   3. auto-restart heals: status "ready", down_since ABSENT, and a NEW
#      opencode pid (the snapshot carries no pid field — pids come from
#      pgrep, the process-visible truth).
#   4. (stretch) a prompt POSTed while OpenCode is down FAILS VISIBLY
#      (dead upstream → lazy-proxy 502) and never lands; the same prompt
#      retried after recovery lands EXACTLY ONCE (caller-minted msg id:
#      exact GET 200 for the retry's id, permanent 404 for the down-probe's).
# Default watcher knobs apply (250ms tick, 1s initial backoff) — well inside
# the lane's existing 30-90x1s poll budgets.
# ===========================================================================
if want_flow 8; then
echo "==> [death-watch flow] starting the REAL vh-solara local-server container"
docker rm -f "$NAME_REAL" >/dev/null 2>&1 || true
docker run -d --name "$NAME_REAL" -p "${PORT_REAL}:8099" --entrypoint /bin/sh "$IMAGE" -c '
  /usr/local/bin/fakellm -addr 127.0.0.1:11434 &
  cd /work && exec /usr/local/bin/vh-solara local-server \
    --addr 0.0.0.0:8099 \
    --opencode-bin /root/.opencode/bin/opencode \
    --opencode-detached' >/dev/null \
  || fail "[death-watch flow] could not start $NAME_REAL"

echo "==> [death-watch flow] waiting for the local-server web listener"
for i in $(seq 1 60); do
  if curl -fsS "${BASE_REAL}/vh/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && fail "[death-watch flow] local-server did not become ready"
done

echo "==> [death-watch flow] waiting for detached opencode to reach ready"
for i in $(seq 1 60); do
  STATUS_REAL=$(curl -fsS "${BASE_REAL}/vh/opencode/status" 2>/dev/null || true)
  echo "$STATUS_REAL" | grep -q '"state":"ready"' && break
  sleep 1
  [ "$i" = 60 ] && fail "[death-watch flow] opencode never reached ready (last: $STATUS_REAL)"
done

echo "==> [death-watch flow] creating a session + minting the down-probe id"
RSID=""
for i in $(seq 1 30); do
  RSID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE_REAL}/oc/session" \
        -H 'Content-Type: application/json' -d '{"title":"death-watch"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$RSID" ] && break
  sleep 1
  [ "$i" = 30 ] && fail "[death-watch flow] could not create a session on local-server"
done
echo "    session id: $RSID"
DOWN_ID=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "[death-watch flow] could not mint down-probe msg_ id"
echo "    down-probe id: $DOWN_ID"

echo "==> [death-watch flow] capturing the live opencode pid"
OLD_PIDS=""
for i in $(seq 1 30); do
  OLD_PIDS=$(docker exec "$NAME_REAL" pgrep -x opencode 2>/dev/null || true)
  [ -n "$OLD_PIDS" ] && break
  sleep 1
  [ "$i" = 30 ] && fail "[death-watch flow] no opencode process found in $NAME_REAL"
done
echo "    opencode pid(s): $(echo "$OLD_PIDS" | tr '\n' ' ')"

echo "==> [death-watch flow] killing opencode (SIGTERM)"
docker exec "$NAME_REAL" pkill -x opencode

echo "==> [death-watch flow] asserting status flips to failed + down_since"
for i in $(seq 1 30); do
  STATUS_REAL=$(curl -fsS "${BASE_REAL}/vh/opencode/status" 2>/dev/null || true)
  echo "$STATUS_REAL" | grep -q '"state":"failed"' \
    && echo "$STATUS_REAL" | grep -q '"down_since"' && break
  sleep 1
  [ "$i" = 30 ] && fail "[death-watch flow] status never showed failed+down_since (last: $STATUS_REAL)"
done
echo "    $(echo "$STATUS_REAL" | python3 -c 'import sys,json;s=json.load(sys.stdin);print("state=%s down_since=%s attempts=%s" % (s.get("state"), bool(s.get("down_since")), s.get("restart_attempts")))')"

echo "==> [death-watch flow] probing a prompt while down (must fail visibly, never land)"
# Deterministic dead-window probe: poll a cheap /oc GET until the lazy proxy
# surfaces its dead-upstream 502, then POST the prompt immediately (ms later).
# The respawn's boot (~1s) cannot complete inside the POST's flight time, so
# the prompt deterministically hits the dead upstream — vh-solara rejects it
# visibly and it never reaches opencode.
DOWN_PROBE=""
for i in $(seq 1 15); do
  DOWN_PROBE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_REAL}/oc/session" 2>/dev/null || true)
  [ "$DOWN_PROBE" = "502" ] && break
  sleep 0.2
done
[ "$DOWN_PROBE" = "502" ] \
  || fail "[death-watch flow] upstream never went visibly down (last probe: $DOWN_PROBE)"
DOWN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H 'X-VH-CSRF: 1' \
  -X POST "${BASE_REAL}/oc/session/${RSID}/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"${DOWN_ID}\",\"parts\":[{\"type\":\"text\",\"text\":\"sent while down\"}]}" \
  || true)
case "$DOWN_CODE" in
  5*) echo "    prompt while down -> $DOWN_CODE (fails visibly, never landed)" ;;
  *) fail "[death-watch flow] prompt while down returned $DOWN_CODE (want a visible 5xx)" ;;
esac

echo "==> [death-watch flow] asserting the death log line names the dead pid"
# Tight match per captured OLD_PID: the watcher logs exactly
# `opencode watch: pid <N> exited (<reason>) after <uptime>` (cmd/opencode_watch.go),
# so anchor on `pid <N> exited (` — a loose `pid.*exited` would also match a
# LATER respawn generation's death line (e.g. under a crash loop), proving the
# wrong pid's death. Every pid we killed must be named.
DEATH_LINE_OK=""
for i in $(seq 1 30); do
  DEATH_ALL_OK=1
  for p in $OLD_PIDS; do
    docker logs "$NAME_REAL" 2>&1 | grep -q "opencode watch: pid ${p} exited (" || DEATH_ALL_OK=""
  done
  if [ -n "$DEATH_ALL_OK" ]; then
    DEATH_LINE_OK=1
    for p in $OLD_PIDS; do
      docker logs "$NAME_REAL" 2>&1 | grep "opencode watch: pid ${p} exited (" | tail -1 | sed 's/^/    /'
    done
    break
  fi
  sleep 1
  [ "$i" = 30 ] && fail "[death-watch flow] death-watch log line for killed pid(s) $(echo "$OLD_PIDS" | tr '\n' ' ')never appeared"
done

echo "==> [death-watch flow] waiting for auto-restart to heal (new pid, down_since cleared)"
for i in $(seq 1 90); do
  STATUS_REAL=$(curl -fsS "${BASE_REAL}/vh/opencode/status" 2>/dev/null || true)
  echo "$STATUS_REAL" | grep -q '"state":"ready"' \
    && ! echo "$STATUS_REAL" | grep -q '"down_since"' && break
  sleep 1
  [ "$i" = 90 ] && fail "[death-watch flow] opencode did not self-heal to ready (last: $STATUS_REAL)"
done
NEW_PIDS=$(docker exec "$NAME_REAL" pgrep -x opencode 2>/dev/null || true)
[ -n "$NEW_PIDS" ] || fail "[death-watch flow] no opencode process after heal"
# The killed child stays an UNREAPED zombie (the watcher deliberately never
# reaps it — the PID-reuse invariant), so pgrep still lists the old pid. The
# honest respawn proof: a NEW pid in the set AND the old pid no longer
# runnable (zombie stat Z, or fully gone).
FRESH_PIDS=""
for p in $NEW_PIDS; do
  case " $OLD_PIDS " in
    *" $p "*) ;;
    *) FRESH_PIDS="$FRESH_PIDS $p" ;;
  esac
done
[ -n "$FRESH_PIDS" ] \
  || fail "[death-watch flow] no NEW opencode pid after heal (set: $(echo "$NEW_PIDS" | tr '\n' ' '))"
OLD_STAT=$(docker exec "$NAME_REAL" ps -o stat= -p $OLD_PIDS 2>/dev/null || true)
case "$OLD_STAT" in
  Z*|"") echo "    healed: new pid(s)$(echo "$FRESH_PIDS" | tr '\n' ' ')(old pid $(echo "$OLD_PIDS" | tr '\n' ' ')stat='${OLD_STAT:-gone}')" ;;
  *) fail "[death-watch flow] old opencode pid still runnable after heal (stat=$OLD_STAT)" ;;
esac

echo "==> [death-watch flow] retrying the prompt after recovery (lands exactly once)"
RETRY_ID=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "[death-watch flow] could not mint retry msg_ id"
RETRY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H 'X-VH-CSRF: 1' \
  -X POST "${BASE_REAL}/oc/session/${RSID}/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"messageID\":\"${RETRY_ID}\",\"parts\":[{\"type\":\"text\",\"text\":\"retry after recovery\"}]}" \
  || true)
[ "$RETRY_CODE" = "204" ] \
  || fail "[death-watch flow] post-recovery prompt_async did not return 204 (got $RETRY_CODE)"

# The retry lands (poll the exact GET), the down-probe NEVER does (404) —
# exactly-once landing across the down window.
RETRY_OK=""
for i in $(seq 1 60); do
  RB=$(mktemp)
  RCODE=$(curl -s -o "$RB" -w "%{http_code}" "${BASE_REAL}/oc/session/${RSID}/message/${RETRY_ID}" 2>/dev/null || true)
  if [ "$RCODE" = "200" ]; then
    RRES=$(python3 "$repo_root/tests/e2e-docker/assert_msgid_get.py" "$RETRY_ID" < "$RB" 2>/dev/null || true)
    [ "$(echo "$RRES" | sed -n 1p)" = "OK" ] && RETRY_OK=1
  elif [ "$RCODE" = "404" ]; then
    : # persistence is async to the 204 — keep polling
  else
    rm -f "$RB"; fail "[death-watch flow] unexpected retry GET status $RCODE"
  fi
  rm -f "$RB"
  [ -n "$RETRY_OK" ] && break
  sleep 1
  [ "$i" = 60 ] && fail "[death-watch flow] retried prompt never landed (last status=$RCODE)"
done
echo "    retry id $RETRY_ID -> landed (exact GET 200)"
DOWN_GET=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_REAL}/oc/session/${RSID}/message/${DOWN_ID}" 2>/dev/null || true)
[ "$DOWN_GET" = "404" ] \
  || fail "[death-watch flow] down-probe id resolved after recovery (got $DOWN_GET; the never-landed prompt must stay 404)"
echo "    down-probe id $DOWN_ID -> still 404 (sent-while-down never landed)"
fi # flow 8

if want_flow 9; then
# =============================================================================
# Flow 9 — restart causality barrier (send-net-resilience slice 2b, AMEND-A7).
# Against REAL OpenCode on the REAL local-server binary, pin the three legs
# the certified redelivery class 3 (post-restart-barrier + exact-ID GET 404)
# rests on:
#   A. COMMITTED-SURVIVES: a prompt that landed (exact GET 200) BEFORE a
#      restart is STILL 200 after it (durable commit survives; the barrier
#      never misreads a landed prompt as lost).
#   B. OBSERVATION-STABILITY: a prompt POSTed into the ambiguous in-flight
#      window and killed mid-flight has a STABLE exact-ID observation — the
#      GET may flip 404→200 at most once (the fork raced the kill and won)
#      and thereafter NEVER flips again, in either direction, across the
#      restart AND after full heal. A classifier keyed on this GET is sound.
#   C. NEVER-LANDS-WHILE-DOWN: a prompt sent while opencode is down fails
#      visibly (5xx) and its id stays 404 forever (no phantom persistence).
# =============================================================================
echo "==> [restart-barrier flow] starting the REAL vh-solara local-server container"
docker rm -f "$NAME_BARRIER" >/dev/null 2>&1 || true
docker run -d --name "$NAME_BARRIER" -p "${PORT_BARRIER}:8099" --entrypoint /bin/sh "$IMAGE" -c '
  /usr/local/bin/fakellm -addr 127.0.0.1:11434 &
  cd /work && exec /usr/local/bin/vh-solara local-server \
    --addr 0.0.0.0:8099 \
    --opencode-bin /root/.opencode/bin/opencode \
    --opencode-detached' >/dev/null \
  || fail "[restart-barrier flow] could not start $NAME_BARRIER"

echo "==> [restart-barrier flow] waiting for the local-server web listener"
for i in $(seq 1 60); do
  if curl -fsS "${BASE_BARRIER}/vh/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = "60" ] && fail "[restart-barrier flow] local-server did not become ready"
done

echo "==> [restart-barrier flow] waiting for detached opencode to reach ready"
barrier_ready() {
  curl -fsS "${BASE_BARRIER}/vh/opencode/status" 2>/dev/null \
    | grep -q '"state":"ready"'
}
# After a kill, wait for the watcher to DETECT the death (failed + down_since)
# before waiting for the heal — otherwise the stale pre-death "ready" state
# passes immediately and requests hit the dead port (flow-8 lesson).
barrier_wait_down_then_ready() {
  for i in $(seq 1 30); do
    S=$(curl -fsS "${BASE_BARRIER}/vh/opencode/status" 2>/dev/null || true)
    echo "$S" | grep -q '"state":"failed"' && echo "$S" | grep -q '"down_since"' && break
    sleep 1
    [ "$i" = "30" ] && fail "[restart-barrier flow] watcher never flagged the death (last: $S)"
  done
  for i in $(seq 1 90); do
    barrier_ready && break
    sleep 1
    [ "$i" = "90" ] && fail "[restart-barrier flow] opencode did not self-heal to ready"
  done
}
for i in $(seq 1 60); do
  barrier_ready && break
  sleep 1
  [ "$i" = "60" ] && fail "[restart-barrier flow] opencode never reached ready"
done

echo "==> [restart-barrier flow] creating a session"
BSID=""
for i in $(seq 1 30); do
  BSID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE_BARRIER}/oc/session" \
        -H 'Content-Type: application/json' -d '{"title":"restart-barrier"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$BSID" ] && break
  sleep 1
  [ "$i" = "30" ] && fail "[restart-barrier flow] could not create a session on local-server"
done
echo "    session id: $BSID"

barrier_post_prompt() { # $1 = messageID, $2 = text -> echoes http code
  curl -s -o /dev/null -w "%{http_code}" -H 'X-VH-CSRF: 1' \
    -X POST "${BASE_BARRIER}/oc/session/${BSID}/prompt_async" \
    -H 'Content-Type: application/json' \
    -d "{\"messageID\":\"$1\",\"parts\":[{\"type\":\"text\",\"text\":\"$2\"}]}" \
    || true
}
barrier_get_code() { # $1 = messageID -> echoes http code of the exact-ID GET
  curl -s -o /dev/null -w "%{http_code}" \
    "${BASE_BARRIER}/oc/session/${BSID}/message/$1" 2>/dev/null || true
}

# --- A: committed-survives ----------------------------------------------------
A_ID=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "[restart-barrier flow] could not mint id A"
A_POST=$(barrier_post_prompt "$A_ID" "committed before restart")
[ "$A_POST" = "204" ] \
  || fail "[restart-barrier flow] prompt A did not return 204 (got $A_POST)"
A_PRE=""
for i in $(seq 1 60); do
  A_PRE=$(barrier_get_code "$A_ID")
  [ "$A_PRE" = "200" ] && break
  [ "$A_PRE" = "404" ] || fail "[restart-barrier flow] unexpected GET status for A ($A_PRE)"
  sleep 1
  [ "$i" = "60" ] && fail "[restart-barrier flow] prompt A never landed (persistence is async to the 204, but not THIS async)"
done
echo "    A: id $A_ID committed (exact GET 200) before the restart"

echo "==> [restart-barrier flow] killing opencode (SIGTERM) — restart epoch"
docker exec "$NAME_BARRIER" pkill -x opencode
echo "==> [restart-barrier flow] waiting for death detection + auto-restart heal"
barrier_wait_down_then_ready

A_POST_RESTART=$(barrier_get_code "$A_ID")
[ "$A_POST_RESTART" = "200" ] \
  || fail "[restart-barrier flow] A did NOT survive the restart (GET $A_POST_RESTART, want 200) — the barrier would misread landed prompts as lost"
echo "    A: survived the restart (still 200)"

# --- B: observation-stability across the kill-raced in-flight window ---------
B_ID=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "[restart-barrier flow] could not mint id B"
B_POST=$(barrier_post_prompt "$B_ID" "in flight when killed")
[ "$B_POST" = "204" ] \
  || fail "[restart-barrier flow] prompt B did not return 204 (got $B_POST)"
# Kill IMMEDIATELY: the forked persistence fiber races the kill. Whichever
# side wins, the exact-ID observation must be STABLE from then on.
docker exec "$NAME_BARRIER" pkill -x opencode

# Poll the observation across ~10s of the down/restart window: sample every
# 0.5s; a 5xx (proxy dead) is NOT an observation — only exact 200/404 count.
# Among real observations: at most ONE transition, only 404->200; 200->404
# (a committed row vanishing) or oscillation is a FAIL.
B_FLIPS=0
B_LAST=""
B_SAMPLE=$(barrier_get_code "$B_ID")
case "$B_SAMPLE" in
  200|404) B_LAST="$B_SAMPLE" ;;
esac
B_FIRST="${B_LAST:-none-yet}"
for i in $(seq 1 20); do
  sleep 0.5
  B_NOW=$(barrier_get_code "$B_ID")
  case "$B_NOW" in
    200|404) ;;
    *) continue ;; # dead-window 5xx: the new instance has not answered yet
  esac
  if [ -n "$B_LAST" ] && [ "$B_NOW" != "$B_LAST" ]; then
    B_FLIPS=$((B_FLIPS + 1))
    if [ "$B_LAST" = "200" ] && [ "$B_NOW" = "404" ]; then
      fail "[restart-barrier flow] B observation flipped 200->404 — a committed message VANISHED (durable row disappeared across restart)"
    fi
    [ "$B_FLIPS" -le 1 ] \
      || fail "[restart-barrier flow] B observation oscillated ($B_FLIPS flips) — classifier input is unstable"
    [ "$B_LAST" = "404" ] && [ "$B_NOW" = "200" ] \
      || fail "[restart-barrier flow] B flipped $B_LAST->$B_NOW (only 404->200 may ever happen)"
  fi
  B_LAST="$B_NOW"
done
echo "    B: in-flight id $B_ID — observation ${B_FIRST} -> ${B_LAST:-unobserved} (${B_FLIPS} flip(s)) across the kill window (stable)"

# Post-heal consistency: the observation settled in the window must HOLD.
# If B landed (200): stays 200. If B never landed (404): it must STILL be 404
# after full heal — the dead fiber cannot resurrect; this is exactly the
# post-restart-barrier + 404 => never-persisted contract of certified class 3.
# NOTE: the B kill's death may already have been detected AND healed DURING
# the sampling window above (fast restart), so waiting for "failed" here
# would never fire — wait for ready + a REAL (non-5xx) observation instead.
for i in $(seq 1 60); do
  barrier_ready || { sleep 1; continue; }
  B_PROBE=$(barrier_get_code "$B_ID")
  case "$B_PROBE" in 200|404) break ;; esac
  sleep 1
  [ "$i" = "60" ] && fail "[restart-barrier flow] upstream never answered with a real observation after the B kill (last: $B_PROBE)"
done
sleep 2
B_FINAL=$(barrier_get_code "$B_ID")
if [ -z "$B_LAST" ]; then
  B_LAST="$B_FINAL" # every in-window sample was a dead 5xx — first real observation is now
fi
[ "$B_FINAL" = "$B_LAST" ] \
  || fail "[restart-barrier flow] B observation moved AFTER heal ($B_LAST -> $B_FINAL) — the barrier's 404 verdict is not sound"
if [ "$B_FINAL" = "200" ]; then
  echo "    B: landed after all (fork beat the kill) — still 200 post-heal"
else
  echo "    B: never landed — still 404 post-heal (post-restart-barrier 404 => never persisted)"
fi

# --- C: never-lands-while-down ------------------------------------------------
# Deterministic dead-window probe (flow-8 pattern): wait for the lazy proxy to
# surface its dead-upstream 5xx, THEN post — C must fail visibly and stay 404.
C_ID=$(python3 "$repo_root/tests/e2e-docker/mint_msg_id.py") \
  || fail "[restart-barrier flow] could not mint id C"
echo "==> [restart-barrier flow] killing opencode once more for the dead-window probe"
docker exec "$NAME_BARRIER" pkill -x opencode
C_DOWN=""
for i in $(seq 1 15); do
  C_DOWN=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_BARRIER}/oc/session" 2>/dev/null || true)
  [ "$C_DOWN" = "502" ] && break
  sleep 0.2
done
[ "$C_DOWN" = "502" ] \
  || fail "[restart-barrier flow] upstream never went visibly down (last probe: $C_DOWN)"
C_POST=$(barrier_post_prompt "$C_ID" "sent while down")
case "$C_POST" in
  5*) echo "    C: prompt while down -> $C_POST (fails visibly, never landed)" ;;
  *) fail "[restart-barrier flow] prompt while down returned $C_POST (want a visible 5xx)" ;;
esac

echo "==> [restart-barrier flow] final heal + C never-lands verdict"
# Same as post-B: the death may already be healed by the time we look —
# wait for ready + a REAL observation of C (non-5xx) before the verdict.
for i in $(seq 1 90); do
  barrier_ready || { sleep 1; continue; }
  C_PROBE=$(barrier_get_code "$C_ID")
  case "$C_PROBE" in 200|404) break ;; esac
  sleep 1
  [ "$i" = "90" ] && fail "[restart-barrier flow] upstream never answered with a real observation after the C kill (last: $C_PROBE)"
done
sleep 2
C_FINAL=$(barrier_get_code "$C_ID")
[ "$C_FINAL" = "404" ] \
  || fail "[restart-barrier flow] C resolved after the restart (GET $C_FINAL; a never-delivered prompt must stay 404)"
echo "    C: id $C_ID -> still 404 after full heal (never landed)"
fi # flow 9

echo
if [ "$FLOW" = "all" ]; then
echo "PASS: real opencode driven by the fake LLM exercised the full flow:"
echo "      - prompt -> streamed assistant reply (snapshot + live stream)"
echo "      - write tool -> tool part + git diff"
echo "      - task tool -> subsession in the tree"
echo "      - bash tool -> permission asked -> reply -> turn resumes"
echo "      - tree=2: bounded frontier (A), expand pagination (B),"
echo "                missed-delete reconcile -> node.remove (C), reconnect no-ship (D)"
echo "      - msgid: prompt_async caller messageID -> 204, exact GET -> 200 (caller-id-wins),"
echo "               cross-session 404 (isolation), non-msg 400 (brand reject)"
echo "      - queue-claim: Claim persisted opencodeMsgID BEFORE dispatch (list),"
echo "                     prompt_async -> 204, exact GET -> persisted user msg,"
echo "                     gate.activity -> busy (turn started)"
echo "      - death-watch (REAL vh-solara local-server): pkill opencode -> failed +"
echo "                     down_since, death log line, auto-restart heals with a new pid;"
echo "                     prompt while down -> 5xx (never lands), retry after recovery"
echo "                     lands exactly once"
echo "      - restart-barrier (REAL vh-solara local-server): committed-survives (A),"
echo "                     kill-raced in-flight observation stable / never flips (B),"
echo "                     sent-while-down never lands (C) — the certified class-3"
echo "                     barrier semantics against real OpenCode"
else
echo "PASS: flow ${FLOW} completed on its own scoped setup"
echo "      (selected via --flow ${FLOW}; the other flows were NOT run this invocation)"
fi
exit 0
