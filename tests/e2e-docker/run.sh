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

echo
echo "PASS: real opencode driven by the fake LLM exercised the full flow:"
echo "      - prompt -> streamed assistant reply (snapshot + live stream)"
echo "      - write tool -> tool part + git diff"
echo "      - task tool -> subsession in the tree"
echo "      - bash tool -> permission asked -> reply -> turn resumes"
exit 0
