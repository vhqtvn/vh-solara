#!/usr/bin/env bash
# End-to-end test: build the e2e image (real opencode + fake LLM + real
# vh-solara aggregator/web), run a real opencode session through it, and
# assert the prompt round-trips and the streamed assistant reply surfaces via
# the vh sync API.
#
#   tests/e2e-docker/run.sh [--keep]
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

IMAGE=vh-solara-e2e
NAME=vh-e2e-run
PORT=8099
BASE="http://127.0.0.1:${PORT}"
KEEP="${1:-}"

cleanup() {
  if [ "$KEEP" != "--keep" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "----- container logs -----" >&2
  docker logs "$NAME" 2>&1 | tail -60 >&2 || true
  exit 1
}

echo "==> building $IMAGE (real opencode + fake LLM)"
docker build -f Dockerfile.e2e -t "$IMAGE" . >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "==> starting container"
docker run -d --name "$NAME" -p "${PORT}:8099" "$IMAGE" >/dev/null

echo "==> waiting for vh web server"
for i in $(seq 1 60); do
  if curl -fsS "${BASE}/vh/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && fail "vh web server did not become ready"
done

echo "==> waiting for opencode session backend (create a session)"
SID=""
for i in $(seq 1 60); do
  SID=$(curl -fsS -H 'X-VH-CSRF: 1' -X POST "${BASE}/oc/session" -H 'Content-Type: application/json' -d '{"title":"e2e"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
  [ -n "$SID" ] && break
  sleep 1
  [ "$i" = 60 ] && fail "could not create an opencode session"
done
echo "    session id: $SID"

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

# --- Flow 2: tool execution -> file diff -------------------------------------
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

# --- Flow 3: task tool -> subsession -----------------------------------------
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

# --- Flow 4: permission round-trip -------------------------------------------
# opencode is configured with bash="ask", so a bash tool call pauses the turn on
# a permission request. This is the gold-standard check: it exercises the real
# `permission.asked` event surfacing through the aggregator AND the reply route
# resuming the turn — the exact path the earlier permission bugs broke.
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
echo "==> [tree flow] seeding synthetic forest into container opencode SQLite"
SEED_SQL=$(mktemp)
python3 "$repo_root/tests/e2e-docker/seed_tree.py" > "$SEED_SQL" \
  || fail "seed SQL generation failed"
DBPATH=$(docker exec "$NAME" sh -c 'echo "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"')
[ -n "$DBPATH" ] || fail "could not resolve opencode db path in container"
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
echo "==> [tree flow] C: asserting missed-delete reconcile (raw SQLite delete -> node.remove)"
C_STREAM=$(mktemp)
# Open a long-lived tree=2 stream: it captures the cold snapshot (victim is now
# `known` to this connection), then we raw-DELETE the victim row directly in
# opencode SQLite, bypassing the app so NO session.deleted event fires. The
# reconcile ticker (TreeReconcileInterval=5s) is the only path that can evict
# the resulting ghost -> it emits node.remove for known ids.
( curl -fsS -N --max-time 25 "${BASE}/vh/stream?tree=2" > "$C_STREAM" 2>/dev/null & )
sleep 2  # let the stream subscribe + receive its cold snapshot
if ! grep -q 'ses_tree_victim' "$C_STREAM"; then
  rm -f "$C_STREAM"; fail "victim not present in C stream snapshot (not known)"
fi
echo "    raw-deleting ses_tree_victim in container opencode SQLite (bypasses app -> no event)"
docker exec "$NAME" sqlite3 "$DBPATH" "DELETE FROM session WHERE id='ses_tree_victim';" \
  || { rm -f "$C_STREAM"; fail "raw delete of victim failed"; }
# Wait through multiple reconcile ticks (~5s each): the first tick after the
# delete detects the ghost and emits node.remove; subsequent ticks must NOT
# resurrect it. The max-time-25 curl closes at t=25; we sleep 24s after the
# 2s snapshot wait + 1s flush buffer so the capture is complete.
sleep 23
sleep 1
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

echo
echo "PASS: real opencode driven by the fake LLM exercised the full flow:"
echo "      - prompt -> streamed assistant reply (snapshot + live stream)"
echo "      - write tool -> tool part + git diff"
echo "      - task tool -> subsession in the tree"
echo "      - bash tool -> permission asked -> reply -> turn resumes"
echo "      - tree=2: bounded frontier (A), expand pagination (B),"
echo "                missed-delete reconcile -> node.remove (C), reconnect no-ship (D)"
exit 0
