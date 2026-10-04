# OpenCode Death Recovery: Verification & Spot-Check

This guide describes the automated verification layers and the optional operator procedure to spot-check the live self-healing mechanisms for OpenCode death recovery (introduced in the oc-death-watch workstream).

## Automated Verification

Three automated layers verify the OpenCode death/recovery path (manual checking is demoted to an optional spot-check on live data):

1. **Go boot-glue test** (`cmd/opencode_bootglue_test.go`): Drives real `setupVHMode()` wiring with a stub opencode. Simulates SIGTERM on the child → verifies live SSE notice (stalled/OpenCode) on `/vh/stream` → failed+down_since → auto-heal ready with new pid → aggregator upstream-down gating.
   Run: `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./cmd/ -run TestOCBootGlue -count=1 -v'`

2. **Web end-to-end** (`web/tests/e2e/opencode-down.spec.ts`): Uses the fixtureserver `/vh/fixture/oclife?mode=down|restarting|capped|ready|off` fixture (OFF by default; `off` restores exact pre-change 503) to pin the panel's exact down-state strings.
   Run: `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e -- opencode-down'`

3. **Docker gold lane (Flow 8)**: Uses the `vh-e2e-real` container (real binary `local-server --opencode-detached` + real opencode). Exercises pkill → death log line → failed+down_since → dead-window prompt 5xx → heal (fresh pid; old pid intentional zombie) → retry-after-recovery lands exactly once. Timing expectations are ~2–3min. (Note pre-existing lane flakes: Flow 5-C 2m-boundary race and Flow 1 cold-start hydrate stall).
   Run: `bash tests/e2e-docker/run.sh`

## Optional Live Spot-Check Prerequisites

1. Deployed build is **at or past commit `6c15b91`**. Check: `vh-solara --version` (release builds print the tag; a `dev` build must be one built from ≥ this HEAD).
2. The daemon service is running: `systemctl --user status vh-opencode.service` (active). `log.Printf` output lands in its journal.
3. The web UI is open (desktop or phone) on the worker, chat view visible.
4. A journal tail is running in a second terminal: `journalctl --user -u vh-opencode.service -f`
5. Find the live `opencode serve` pid: `pgrep -x opencode` (or read the state file `~/.config/vh-solara/opencode/<sha1-of-daemon-cwd>.json`, field `pid`). Confirm the UI shows no health panel.

## Optional Step 1: Simulating an Unexpected Kill

Run the following command to simulate the exact shape of the 2026-10-03 incident:
```bash
pkill -x opencode
```

### Journal Sequence (Timing expectations are knob-derived)
Detection is bounded by the watcher's `250ms` poll tick (knobs in `cmd/opencode_watch.go`).
1. **Death line + restart scheduling** (within ~1s):
   `opencode watch: pid <N> exited (signal TERM/15) after <uptime> — unexpected; restart 1/5 in 1s`
2. **Restart arm runs**: After the `1s` backoff, spawn to readiness.
   If port moved: `detached opencode restart landed on a fresh port <P> — retargeted the running daemon (was port <old>)`
3. **Aggregator gating**:
   `[aggregator] upstream down — hydrate retry backoff capped at 30s`
   `[aggregator] upstream down — reconnect backoff capped at 30s`
   `[aggregator] event stream ended (...); reconnecting in 30s`
4. **Recovery**:
   `[aggregator] hydrated; tailing events`

### UI Experience
- **Within ~2–3 s**: Red panel appears with `OpenCode down since HH:MM — restarting (attempt 1)`. Meta row shows `exit: 143`.
- **In-app notification**: Exactly one fires per down-spell: `opencode serve pid <N> exited (signal TERM/15) after <uptime>`.
- **Chat sending**: Red error `Message not sent — OpenCode is down`. Composer chip shows `Outcome unknown` with guidance. Shell commands get `OpenCode is down — command not sent`.

### Recovery Timing
- Watcher backoff is 1s, then restart. Total kill to ready is typically **~2–5s**. No service restart is needed.
- Panel flips to `OpenCode ready` (auto-fades in 4s).
- Chat reconnects within `30s` (the capped backoff).
- The failed-to-send chip grows a circular-arrow retry button.

## Optional Step 2: The Zombie Invariant Check

Between the kill and replacement spawn (~1–2s window), check the old PID:
```bash
ps -o pid,stat,cmd -p <old-pid>
```
`STAT` should show `Z` (zombie) and `CMD` shows `[opencode] <defunct>`.

This is the **no-reap invariant**: the daemon observes the exit WITHOUT reaping (Linux `waitid(WNOWAIT)`), so the pid stays reserved and can never be recycled under the restart arm's `curPID` check.

## Optional Step 3: Crash-Loop Cap and Give-Up

Force the cap by killing every replacement within a few seconds (preventing it from resetting the 30s healthy-reset timer):
1. `pkill -x opencode` as soon as it appears.
2. Backoff doubles: **1s → 2s → 4s → 8s → 16s** (capped at 30s; max 5 attempts in 10 minutes). Panel advances `restarting (attempt 2)`...
3. After the 6th kill (5 attempts consumed), watcher gives up:
   `opencode watch: pid <N> exited (…) after … — crash-loop cap reached: 5 restarts in 10m0s — giving up`
   Panel shows: `OpenCode down since HH:MM — restart paused after 5 attempts`.
4. Recover via the UI **`Restart OpenCode`** button.

## Systemd Notes
- `systemctl --user restart vh-opencode.service` is the **manual fallback only**.
- Watcher NEVER restarts the daemon itself. Deliberate stops or ctx cancellation exit silently.
- Deliberate user stops log `… — deliberate stop — not restarting`.