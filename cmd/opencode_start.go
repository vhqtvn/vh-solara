package cmd

import (
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// DetachedStartVerdict is the structured outcome of the one cooperating
// detached-start transaction (EnsureDetachedOpenCode). Both cobra entry arms
// (client-daemon --web=vh and local-server --opencode-detached) map this onto
// their lifecycle/log/topology wiring via ApplyDetachedOCStart.
type DetachedStartVerdict int

const (
	// DetachedStartSpawned: we won the transaction — a fresh detached
	// `opencode serve` is running and owns the slot; state was published.
	DetachedStartSpawned DetachedStartVerdict = iota
	// DetachedStartReattached: a recorded, live, cmdline-matching instance
	// answered probes; reconnected instead of spawning.
	DetachedStartReattached
	// DetachedStartOccupied: the recorded instance is alive and ours but not
	// answering — NEVER spawn beside it (split-brain guard).
	DetachedStartOccupied
	// DetachedStartContended: another starter is mid-flight (starter lock
	// held). We returned without spawning and without waiting out the
	// winner's spawn/readiness budget. Bounded, though not always
	// milliseconds: when recorded state names a live, cmdline-matching
	// instance the loser still classifies it once (reattaching instantly on
	// success, else paying the bounded probe budget — see below) before
	// returning Occupied.
	DetachedStartContended
	// DetachedStartOrphanedOwner: the owner lock is held but no live recorded
	// `opencode serve` exists — opencode died while a descendant retains its
	// lock fd. Never auto-spawn; holders are listed in Holders.
	DetachedStartOrphanedOwner
	// DetachedStartFailed: spawn/readiness failed. The child may still be
	// running un-recorded (readiness timeout) — the owner lock it holds keeps
	// competitors from spawning beside it.
	DetachedStartFailed
)

func (v DetachedStartVerdict) String() string {
	switch v {
	case DetachedStartSpawned:
		return "spawned"
	case DetachedStartReattached:
		return "reattached"
	case DetachedStartOccupied:
		return "occupied"
	case DetachedStartContended:
		return "contended"
	case DetachedStartOrphanedOwner:
		return "orphaned-owner"
	case DetachedStartFailed:
		return "failed"
	}
	return fmt.Sprintf("DetachedStartVerdict(%d)", int(v))
}

// DetachedStartResult carries everything the wiring needs. PID/Port double as
// the URL-target hint: for Spawned it is the new instance; for
// Reattached/Occupied the recorded one; for Contended/OrphanedOwner the
// recorded port when state was readable (0 = nothing known — the caller's
// dead-loopback fallback applies); for Failed the port we targeted.
type DetachedStartResult struct {
	Verdict DetachedStartVerdict
	PID     int
	Port    int
	Reason  string
	Holders []string // orphaned-owner holder descriptions (pid + cmdline)
	Cmd     *exec.Cmd
}

// EnsureDetachedOpenCode is the ONE detached-start transaction both runtime
// arms route through. It owns the full cooperating-starter sequence:
//
//	bounded starter-lock acquisition
//	  → state read + classifyOCInstance (never a cached pre-lock verdict)
//	  → stable-port selection (recorded port when free)
//	  → spawn with owner-lock handoff (fd 3) + retention check
//	  → readiness wait
//	  → state publication (writeOCState — only after a successful spawn)
//	  → starter-lock release
//
// Invariants preserved by construction:
//
//   - Never-spawn-while-alive: classifyOCInstance remains the spawn
//     authority; Occupied never spawns, with or without locks.
//   - Losers are bounded: a Contended starter never spawns and never waits
//     out the winner's ~13s classification + 30s readiness budgets. Its own
//     worst case is one classify probe of the recorded state (~1s
//     refused-fast → ~7.5s one-endpoint-timeout → ~13s worst) when that
//     state names a live, cmdline-matching instance — bounded by the probe
//     alone, never the winner's budget.
//   - An OrphanedOwner loser never spawns beside maybe-live work; the
//     fd-holders are surfaced for the operator.
//   - State is written only on a successful spawn; Reattach/Occupied/
//     Contended/Orphaned paths leave the state file untouched.
//
// The extraW writers fan the detached process's output into the lifecycle
// ring alongside the per-project disk log (pass none for log-only).
func EnsureDetachedOpenCode(bin string, workspace string, extraW ...io.Writer) DetachedStartResult {
	guard, verdict, reason := acquireOCSpawnGuard()
	if verdict == ocLockContended {
		// Fast-fail loser. We still classify a recorded state (cheap read;
		// the probe runs only when that state names a live, cmdline-matching
		// instance) so a loser that CAN simply reattach does — but we NEVER
		// spawn and NEVER wait out the winner's spawn/readiness budget. A
		// loser whose recorded instance looks reattachable but is not
		// answering pays the probe budget (~1s refused-fast → ~7.5s
		// one-endpoint-timeout → ~13s worst) before returning Occupied.
		st, ok := readOCState()
		switch gate := classifyOCInstance(st, ok); gate.Verdict {
		case ocGateReattach:
			return reattachedResult(gate.State)
		case ocGateOccupied:
			return occupiedResult(gate.State, gate.Reason)
		}
		return DetachedStartResult{
			Verdict: DetachedStartContended,
			PID:     st.PID,
			Port:    st.Port,
			Reason: fmt.Sprintf("another detached-OpenCode starter is mid-flight for this project (%s); NOT spawning and NOT waiting it out — retry once the other starter completes (restart the daemon or use the OpenCode restart action)",
				reason),
		}
	}
	if verdict == ocLockError {
		return DetachedStartResult{
			Verdict: DetachedStartFailed,
			Reason:  fmt.Sprintf("spawn-lock acquisition failed (%s); NOT spawning — ownership could not be established", reason),
		}
	}
	defer guard.Release()

	// Under the starter lock: reread state and classify fresh.
	st, ok := readOCState()
	switch gate := classifyOCInstance(st, ok); gate.Verdict {
	case ocGateReattach:
		return reattachedResult(gate.State)
	case ocGateOccupied:
		return occupiedResult(gate.State, gate.Reason)
	}

	// NoState / Foreign: free to spawn — unless the owner lock says the slot
	// is still owned (live child of a crashed starter, or a descendant that
	// retained the owner fd after opencode itself died).
	if ocOwnerLockHeldByOthers() {
		holders := ocOwnerLockHolders()
		names := make([]string, 0, len(holders))
		for _, h := range holders {
			names = append(names, h.String())
		}
		if len(names) == 0 {
			names = append(names, "(holders undiscoverable — /proc scan found none)")
		}
		return DetachedStartResult{
			Verdict: DetachedStartOrphanedOwner,
			PID:     st.PID,
			Port:    st.Port,
			Reason: fmt.Sprintf("project owner lock is held but no live recorded `opencode serve` matches the state (pid %d dead or recycled); a descendant may still hold the project DB — holders: %s; NOT spawning beside possible live work. Kill the holders (or wait for them to exit), then restart",
				st.PID, strings.Join(names, ", ")),
			Holders: names,
		}
	}

	// Stable-port reuse: prefer the recorded port when it is free.
	port := freePort()
	if ok && portFree(st.Port) {
		port = st.Port
	}
	cmd, err := guard.startChildWithOwner(bin, port, workspace, extraW...)
	if err != nil {
		return DetachedStartResult{
			Verdict: DetachedStartFailed,
			Port:    port,
			Reason:  fmt.Sprintf("failed to start detached opencode serve: %v", err),
		}
	}
	if err := waitForPort(port, 30*time.Second); err != nil {
		// The child is left running deliberately (it may still come up and
		// holds the project DB); the owner lock it holds keeps any competitor
		// from spawning beside it. State stays unpublished — a later starter
		// will classify this exact situation as orphaned-owner, never spawn.
		return DetachedStartResult{
			Verdict: DetachedStartFailed,
			PID:     cmd.Process.Pid,
			Port:    port,
			Reason:  fmt.Sprintf("opencode serve failed to listen on port %d: %v", port, err),
		}
	}
	writeOCState(ocState{PID: cmd.Process.Pid, Port: port}) // best-effort; unchanged discard semantics
	return DetachedStartResult{
		Verdict: DetachedStartSpawned,
		PID:     cmd.Process.Pid,
		Port:    port,
		Cmd:     cmd,
		Reason:  fmt.Sprintf("spawned detached opencode serve pid=%d port=%d (owner lock handed off)", cmd.Process.Pid, port),
	}
}

// ApplyDetachedOCStart maps a transaction result onto the daemon-side wiring:
// lifecycle transitions (ocLife), ring seeding for reattach/occupied, the
// retained child command, and the port/URL the aggregator's lazy proxy should
// target. It is the entire detached arm of both cobra entry paths — keeping
// the boot seam honest (a wiring change lands once, for both arms).
//
// A result with no known port (Contended/OrphanedOwner without readable
// state) returns url "" — the caller's existing dead-loopback fallback
// applies, exactly like any other arm that could not resolve a target.
func ApplyDetachedOCStart(res DetachedStartResult, life *oclife.Lifecycle, prefix string) (port int, url string, cmd *exec.Cmd) {
	urlFor := func(p int) string {
		if p <= 0 {
			return ""
		}
		return fmt.Sprintf("http://127.0.0.1:%d", p)
	}
	switch res.Verdict {
	case DetachedStartSpawned:
		life.SetReady()
		log.Printf("%s: spawned detached OpenCode pid=%d port=%d (spawn-slot ownership handed to the child)", prefix, res.PID, res.Port)
		return res.Port, urlFor(res.Port), res.Cmd

	case DetachedStartReattached:
		life.SetReady()
		// Seed the lifecycle ring with the detached disk-log tail so
		// /vh/opencode/logs reflects recent history after a reconnect: the
		// in-memory ring is fresh, but the process kept accumulating output.
		seedRingFromDiskLog(life.Ring(), ocLogPath())
		log.Printf("%s: reconnected to our detached OpenCode pid=%d port=%d", prefix, res.PID, res.Port)
		return res.Port, urlFor(res.Port), nil

	case DetachedStartOccupied:
		// Alive and OURS but not answering probes. NEVER spawn a second
		// instance beside it (split-brain on the shared project DB). Keep
		// pointing at it — the lazy proxy may still get through once load
		// drops — and record the failure so /vh/opencode/status tells the
		// operator to use the restart action. Worker keeps serving.
		life.SetFailed(res.Reason, nil)
		seedRingFromDiskLog(life.Ring(), ocLogPath())
		log.Printf("%s: detached OpenCode pid=%d port=%d alive but unreachable (%s) — worker stays up; opencode status=failed; refusing to spawn beside it", prefix, res.PID, res.Port, res.Reason)
		return res.Port, urlFor(res.Port), nil

	case DetachedStartContended:
		life.SetFailed(res.Reason, nil)
		log.Printf("%s: detached OpenCode start contended — worker stays up; opencode status=failed; %s", prefix, res.Reason)
		return res.Port, urlFor(res.Port), nil

	case DetachedStartOrphanedOwner:
		life.SetFailed(res.Reason, nil)
		log.Printf("%s: detached OpenCode slot has an orphaned owner — worker stays up; opencode status=failed; %s", prefix, res.Reason)
		return res.Port, urlFor(res.Port), nil

	default: // DetachedStartFailed
		life.SetFailed(res.Reason, nil)
		log.Printf("%s: detached OpenCode start failed (%s) — worker stays up; opencode status=failed", prefix, res.Reason)
		return res.Port, urlFor(res.Port), nil
	}
}

// ocOwnerReleaseWait bounds how long a restart waits for the old owner chain
// (or any live holder of the owner lock) to release the slot before failing
// the restart explicitly. Package var so tests can shrink it, mirroring the
// probe knobs above.
var ocOwnerReleaseWait = 15 * time.Second

// restartDetachedOpenCode is the serialized restart of the detached instance:
// under the same per-project starter lock it rereads state and revalidates the
// recorded pid (alive + cmdline match) IMMEDIATELY before signaling — a
// recycled pid is never signaled — then waits for the old owner to release
// the owner lock, re-checks the spawn port for a foreign listener (port
// parity with the boot path's stable-port selection), and respawns through
// the same guarded handoff, republishing state.
//
// port <= 0 (a boot verdict that left no usable port on the runtime —
// Contended/OrphanedOwner without readable state) is re-derived here the way
// the boot path derives its stable port: the recorded state's port when
// valid, else a fresh free one. `opencode serve --port 0` is never spawned
// (it can never pass the readiness wait, which would wedge the very recovery
// path this function is).
//
// The owner-release wait is bounded (ocOwnerReleaseWait) and applies whenever
// the owner lock is still held after the signaling phase — whether we
// signaled the old owner or merely met a live holder against stale or missing
// state (curPID 0): a wedged holder fails the restart explicitly instead of
// ever spawning beside possible live work.
//
// curPID is the caller's own retained child pid (0 when the daemon
// reconnected instead of spawning); it is ours by construction and
// zombie-safe (an un-reaped dead child cannot have its pid recycled).
//
// On success it returns the new child. On a readiness failure it returns the
// spawned child AND the error so the caller can retain the handle — its pid
// feeds the next restart's curPID — but no production caller ever Wait()s
// the detached child. A dead un-reaped child therefore stays a zombie until
// the daemon (its parent) exits, which is DELIBERATE pid-recycling safety: a
// zombie's pid cannot be recycled, so the curPID signaling above can never
// hit an unrelated process. Do not "fix" this with a reaper goroutine —
// reaping opens exactly that recycling window. The failed child itself is
// left running and owner-covered with state unpublished — the same posture
// as the boot path's readiness failure, which surfaces only the pid/port,
// not the child handle.
func restartDetachedOpenCode(bin string, port int, workspace string, curPID int, extraW ...io.Writer) (*exec.Cmd, error) {
	guard, verdict, reason := acquireOCSpawnGuard()
	if verdict != ocLockAcquired {
		return nil, fmt.Errorf("detached restart serialized out (%s): %s", verdict, reason)
	}
	defer guard.Release()

	// D2 (P1-API-002 follow-up): a restart handed an unusable port (<= 0 —
	// a Contended/OrphanedOwner boot with no readable state leaves port 0
	// wired on the runtime) must never spawn `opencode serve --port 0`:
	// waitForPort(0) can never succeed, so the directed recovery path would
	// hang for the readiness budget and strand the child on an OS-assigned
	// port with the owner lock held and state unpublished. Re-derive under
	// the lock, exactly like the boot path's stable-port selection: the
	// recorded state's port when valid, else a fresh free one.
	if port <= 0 {
		if st, ok := readOCState(); ok {
			port = st.Port
			log.Printf("detached restart: no usable port given — re-derived the recorded port %d", port)
		} else {
			port = freePort()
			log.Printf("detached restart: no usable port given and no valid recorded state — picked a fresh port %d", port)
		}
	}

	// Reread state under the lock and revalidate identity right before
	// signaling. The recorded pid may have died and been recycled between
	// the UI request and now; signaling it would kill an unrelated process.
	killed := map[int]bool{}
	if st, ok := readOCState(); ok {
		if ocProcessAlive(st.PID) && ocCmdlineMatches(st.PID, st.Port) {
			log.Printf("detached restart: stopping recorded instance pid=%d port=%d", st.PID, st.Port)
			killPID(st.PID)
			killed[st.PID] = true
		} else {
			log.Printf("detached restart: recorded pid %d (port %d) is not a live `opencode serve --port %d` (dead or recycled) — NOT signaling it",
				st.PID, st.Port, st.Port)
		}
	}
	// The caller's own retained child (0 when the daemon reconnected instead
	// of spawning). Ours by construction and zombie-safe: an un-reaped dead
	// child cannot have its pid recycled.
	if curPID > 0 && !killed[curPID] {
		killPID(curPID)
	}

	// Wait for the old owner chain to release the owner lock (fds close at
	// process exit). A1 (P1-API-002 follow-up): this runs whenever the lock
	// is still held after the signaling phase — not only when WE signaled
	// someone. A restart against stale or missing state (curPID 0) can still
	// meet a live holder it never named; without the wait it would fail
	// instantly on EWOULDBLOCK in takeOwnerForChild instead of giving that
	// holder the same bounded release window. Bounded either way: a wedged
	// instance — or a descendant that retained fd 3 — fails the restart
	// explicitly instead of ever spawning a second instance beside possible
	// live work.
	deadline := time.Now().Add(ocOwnerReleaseWait)
	for ocOwnerLockHeldByOthers() && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if ocOwnerLockHeldByOthers() {
		var names []string
		for _, h := range ocOwnerLockHolders() {
			names = append(names, h.String())
		}
		if len(names) == 0 {
			names = []string{"(none discoverable)"}
		}
		return nil, fmt.Errorf("old detached OpenCode did not release the project owner lock (a descendant may retain it) — NOT respawning beside it; holders: %s",
			strings.Join(names, ", "))
	}

	// Port parity with the boot path's stable-port selection (P1-API-002
	// advisory cleanup): `port` here is either the D2-re-derived recorded
	// port or a caller-supplied one, and neither has been checked for a
	// FOREIGN listener. Stale state can name a port another process now
	// squats: handing it to the child would kill the child with EADDRINUSE
	// while the dial-only waitForPort below succeeds against the foreign
	// listener — publishing poisoned state (a lying "ready" whose proxy
	// targets the foreign service, re-poisoned by every further restart,
	// healed only at daemon boot). One final freeness check at this single
	// port-finalization point trades that for truthful fresh-port state; the
	// caller's stale URL target heals at the next daemon boot (port
	// propagation is deliberately out of scope).
	if !portFree(port) {
		fresh := freePort()
		log.Printf("detached restart: spawn port %d is taken by a foreign listener — respawning on a fresh port %d", port, fresh)
		port = fresh
	}

	cmd, err := guard.startChildWithOwner(bin, port, workspace, extraW...)
	if err != nil {
		return nil, fmt.Errorf("failed to start detached opencode serve: %v", err)
	}
	if err := waitForPort(port, 30*time.Second); err != nil {
		// Child left running + owner-covered; state stays unpublished (same
		// posture as the boot path's readiness failure).
		return cmd, fmt.Errorf("opencode serve failed to listen on port %d: %v", port, err)
	}
	writeOCState(ocState{PID: cmd.Process.Pid, Port: port}) // best-effort; unchanged discard semantics
	return cmd, nil
}

// reattachedResult / occupiedResult keep the operator-facing reasons of the
// pre-transaction arms verbatim so logs and /vh/opencode/status do not
// regress in information content.
func reattachedResult(st ocState) DetachedStartResult {
	return DetachedStartResult{
		Verdict: DetachedStartReattached,
		PID:     st.PID,
		Port:    st.Port,
		Reason:  fmt.Sprintf("pid %d answering on port %d", st.PID, st.Port),
	}
}

func occupiedResult(st ocState, gateReason string) DetachedStartResult {
	return DetachedStartResult{
		Verdict: DetachedStartOccupied,
		PID:     st.PID,
		Port:    st.Port,
		Reason: fmt.Sprintf("detached OpenCode pid=%d port=%d is alive but not answering probes (%s); NOT spawning a second instance beside it — use the OpenCode restart action to recover",
			st.PID, st.Port, gateReason),
	}
}
