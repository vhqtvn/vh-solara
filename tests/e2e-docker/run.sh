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
# reconcile ticker (tree reconcile ticker, 5s default) is the only path that can evict
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

echo
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
exit 0
