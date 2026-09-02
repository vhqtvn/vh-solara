package cmd

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os/exec"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// P1-API-005: the shared, child-aware owned-topology restart operation.
//
// DEFECT this closes: the owned restart used to respawn on the fixed stable
// port with no occupied-port guard, and its dial-only waitForPort accepted a
// FOREIGN listener that squatted the port after the old child exited — the
// replacement child bind-fails (EADDRINUSE) while the dial "succeeds" against
// the squatter, publishing a false SetReady with the running daemon's /oc/*
// proxy serving foreign content.
//
// CONTRACT (do not weaken):
//
//   - Readiness is attributed to THE REPLACEMENT CHILD — never inferred from
//     "something accepts connections" on the port. The child's own exit,
//     observed through the caller-supplied exit oracle (the sole Wait()
//     observer the topology owns), is the authoritative failure signal; a
//     successful dial counts only while that oracle stays closed through a
//     bounded stabilization window. Child stderr wording (e.g. EADDRINUSE) is
//     NOT part of the contract — attribution never parses child output.
//   - The stable port is preferred, but only when it is verifiably free; if it
//     is occupied, or the replacement loses the check-to-bind race (R2 TOCTOU
//     fold: detected as a pre-readiness child exit), there is exactly ONE
//     bounded fresh-port attempt wired through the existing P1-API-003 retarget
//     seam (applyFreshPortRetarget) BEFORE SetReady, so the lifecycle URL, the
//     running proxy, and the aggregators follow the fresh child before
//     readiness is published.
//   - Exhaustion fails closed: SetFailed + the daemon keeps serving (p1-oc-001
//     invariant). No claim is made that the bounded retry eliminates port
//     races; a squatter that wins after the stabilization window is caught
//     honestly by the reaper's post-startup crash recording.
//
// OWNERSHIP SPLIT (brief R1): this operation defines restart OUTCOME and
// RETRY POLICY; process ownership stays with the caller. The caller stops the
// PREVIOUS child before invoking it (client-daemon: signal + wait on the
// reaper-done channel; local-server: signal + direct Wait), and its Spawn
// closure installs the topology's own exit observer for the replacement child
// (client-daemon: the sole-reaper goroutine; local-server: direct wait
// ownership). The core itself never Wait()s a child.

// errOwnedChildExited is the sentinel for "the replacement child exited before
// readiness was attributed to it" — the bind-race/crash signature that makes
// the one fresh-port retry legitimate. Distinguished from a readiness timeout,
// which fails closed without a retry.
var errOwnedChildExited = errors.New("replacement opencode child exited before readiness was attributed")

// ownedExitGate is the SYNCHRONIZED PUBLICATION BOUNDARY between the two
// writers of an owned child's lifecycle state (P1-API-006 A1):
//
//   - the EXIT RECORDER — the child's sole Wait() observer (reapOwnedOpenCode
//     or local-server's direct-wait adapter) — which must publish the exit as
//     a lifecycle failure; and
//   - the READINESS PUBLISHER — the shared owned boot/restart operation —
//     which must publish retarget+SetReady only for a child that is still
//     alive at the moment of publication.
//
// DEFECT this closes (the P1-API-005 DEFER-1 residual): the old core ended its
// readiness wait with a final NON-BLOCKING oracle poll followed by retarget
// work and SetReady as three unsynchronized steps. A child exit landing
// between that poll and SetReady was recorded by the reaper (SetFailed) and
// then TRANSIENTLY OVERWRITTEN by the publisher's SetReady — a false ready
// state on a dead child, with no later write guaranteed to repair it. Another
// oracle poll, stress testing, or a documented timing bound cannot close that
// window: the check and the publication must be ONE atomic step with respect
// to the exit recording.
//
// PROTOCOL: one mutex serializes both publication paths. RecordExit runs the
// caller's record closure (the lifecycle state-set) and then closes the done
// oracle, both under the gate mutex. PublishIfAlive checks the oracle and runs
// the caller's publish closure (retarget + SetReady) as one critical section
// under the SAME mutex, refusing outright when the exit has been recorded.
// The historical overwrite required check-then-publish to be non-atomic with
// record-then-close; here the two critical sections are mutually exclusive,
// so exactly two linearizations exist and both are correct:
//
//   - record first  → PublishIfAlive deterministically refuses; readiness is
//     never published for the dead child (the failure state cannot be
//     overwritten — structurally, not by timing).
//   - publish first → the exit record lands AFTER readiness, which is the
//     DESIGNED direction: a post-readiness crash must flip ready → failed
//     (the reaper doing its job), and the gate's record still runs.
//
// TEST SEAM (A1 review checkpoint: no test-only hook is needed): both sides'
// lifecycle writes are caller-supplied closures, so tests construct the exact
// interleavings — including "exit recorded at the publication boundary" and
// "publisher parked inside its critical section while the recorder waits" —
// by sequencing RecordExit/PublishIfAlive directly, with the closures as the
// barrier. Nothing in production exists only for tests.
type ownedExitGate struct {
	mu   sync.Mutex
	done chan struct{}
}

// newOwnedExitGate builds the per-child publication gate. One gate per child:
// the Spawn closure creates it, hands it to the child's exit recorder, and
// returns it as the child's exit oracle for the shared core.
func newOwnedExitGate() *ownedExitGate {
	return &ownedExitGate{done: make(chan struct{})}
}

// Done is the child's exit oracle: a receive-only channel closed exactly once,
// AFTER the exit has been fully recorded in the lifecycle (the reapOwnedOpenCode
// ordering invariant, now enforced by the gate's critical section rather than
// by recorder-side code order alone).
func (g *ownedExitGate) Done() <-chan struct{} { return g.done }

// RecordExit publishes one child exit: under the gate mutex, run record (the
// lifecycle state-set — SetFailed/SetStopped), then close the oracle. Second
// and later calls are idempotent no-ops (one child, one exit). While record
// runs, the gate is HELD: a concurrent readiness publisher queues behind this
// critical section and will observe the closed oracle when it finally runs.
func (g *ownedExitGate) RecordExit(record func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-g.done:
		return // already recorded — one child, one exit
	default:
	}
	record()
	close(g.done)
}

// PublishIfAlive publishes readiness under the gate mutex, atomically with the
// liveness check: if the child's exit has already been recorded (or is being
// recorded — RecordExit holds the same mutex), publication is REFUSED and the
// retryable errOwnedChildExited is returned; otherwise publish runs (retarget
// BEFORE the readiness flip, then SetReady) while no exit recording can
// interleave. This is the write-order guarantee the old final non-blocking
// oracle poll could only approximate.
func (g *ownedExitGate) PublishIfAlive(publish func()) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-g.done:
		return fmt.Errorf("readiness publication refused — the child exit was recorded at the publication boundary: %w", errOwnedChildExited)
	default:
	}
	publish()
	return nil
}

// ownedReadyWait is the per-attempt readiness budget (mirrors the historical
// 30s waitForPort budget of the owned arms). Package var so tests can shrink
// it, mirroring ocOwnerReleaseWait.
var ownedReadyWait = 30 * time.Second

// ownedPortStabilize is the stabilization window that separates "our child
// owns the listener" from "a foreign listener answered while our child is
// dying of a failed bind": after the FIRST successful dial, the child must
// stay alive (exit oracle still closed) for this long before readiness is
// attributed. A real child that lost a bind race exits well inside the
// window (its bind attempt precedes any useful work), so a squatter's
// accepting dial cannot carry the attempt through it. Bounded detection, not
// race elimination — a slower-than-window death is still recorded by the
// reaper's post-startup crash handling. Package var so tests can shrink it.
var ownedPortStabilize = 750 * time.Millisecond

// ownedRestartConfig parameterizes one shared owned-restart run. Bin and
// workspace resolution stay inside the caller's Spawn closure (they differ per
// binary and per output-sink wiring), so the core holds only the outcome
// machinery.
type ownedRestartConfig struct {
	// Life is the worker-local OpenCode lifecycle. Non-nil; the core drives
	// SetStarting per attempt, SetReady on guarded success, and SetFailed on
	// spawn error / timeout / exhaustion.
	Life *oclife.Lifecycle
	// Srv is the RUNNING web server to retarget when the restart lands on a
	// fresh port. May be nil (defensive no-server shape); the lifecycle URL
	// is still updated — see applyFreshPortRetarget.
	Srv *web.Server
	// StablePort is the port the runtime is currently serving through. <= 0
	// (not a production shape) goes straight to the fresh-port attempt.
	StablePort int
	// Spawn starts ONE replacement child on the given port and returns the
	// child handle plus its exit oracle — an ownedExitGate whose Done()
	// channel closes once the child has exited AND the caller's observer has
	// fully recorded that exit in the lifecycle (the reapOwnedOpenCode
	// ordering invariant, enforced by the gate: state-set happens BEFORE the
	// close, both under the gate mutex). The gate is what attributes
	// readiness to THIS child and what makes the readiness publication
	// atomic with the exit recording; Spawn returning a nil gate is a caller
	// contract violation and fails the attempt without a retry.
	Spawn func(port int) (*exec.Cmd, *ownedExitGate, error)
}

// ownedRestartResult is the shared operation's outcome. On failure Err is
// non-nil and the lifecycle already records the failure; Cmd/Exited are still
// the LAST spawned child's handles (the caller retains them for the next
// restart exactly like the historical waitForPort-failure shape — the child
// may come up late, and its observer keeps running).
type ownedRestartResult struct {
	Cmd        *exec.Cmd
	Exited     <-chan struct{}
	Port       int    // effective port on success; last attempted port on failure
	URL        string // non-empty only when a retarget was applied
	Retargeted bool
	Err        error
}

// restartOwnedOpenCode drives the shared child-aware restart: one attempt on
// the stable port (when verifiably free), then — only when that attempt lost
// the child before readiness — exactly one attempt on a fresh port. Any other
// failure (spawn error, readiness timeout, a fresh-port failure of any kind)
// fails closed.
func restartOwnedOpenCode(cfg ownedRestartConfig) ownedRestartResult {
	// Attempt 1: the stable port, only when verifiably free. A squatted
	// stable port is the deterministic defect case — never hand the child a
	// port it can only lose; go straight to the one fresh-port attempt.
	if cfg.StablePort > 0 && portFree(cfg.StablePort) {
		res, childDied := ownedRestartAttempt(cfg, cfg.StablePort, "stable")
		if !childDied {
			return res
		}
		// The stable-port child exited before readiness (lost the bind race
		// or crashed). The caller's observer has already recorded the exit
		// (SetFailed, via the oracle ordering invariant) — the retry below
		// may legitimately overwrite it with a fresh attempt's outcome.
		log.Printf("owned opencode restart: the replacement on stable port %d exited before readiness (%v) — one bounded fresh-port attempt", cfg.StablePort, res.Err)
		fresh := freePort()
		res2, _ := ownedRestartAttempt(cfg, fresh, "fresh")
		if res2.Err != nil {
			res2.Err = fmt.Errorf("opencode restart exhausted (stable port %d, then fresh port %d): %w", cfg.StablePort, fresh, res2.Err)
			cfg.Life.SetFailed(res2.Err.Error(), nil)
			log.Printf("owned opencode restart exhausted — worker stays up; opencode status=failed")
		}
		return res2
	}
	if cfg.StablePort > 0 {
		log.Printf("owned opencode restart: stable port %d is occupied by a foreign listener — trying one fresh port", cfg.StablePort)
	} else {
		log.Printf("owned opencode restart: no usable stable port (%d) — trying one fresh port", cfg.StablePort)
	}
	fresh := freePort()
	res, _ := ownedRestartAttempt(cfg, fresh, "fresh")
	if res.Err != nil {
		res.Err = fmt.Errorf("opencode restart failed on fresh port %d (stable port %d unavailable): %w", fresh, cfg.StablePort, res.Err)
		cfg.Life.SetFailed(res.Err.Error(), nil)
		log.Printf("owned opencode restart failed — worker stays up; opencode status=failed")
	}
	return res
}

// ownedRestartAttempt runs one spawn attempt on port and reports whether the
// failure (if any) was a PRE-READINESS CHILD EXIT — the only retryable
// outcome, and only for the stable-port attempt (see restartOwnedOpenCode).
// On non-retryable failure the lifecycle is already SetFailed here.
func ownedRestartAttempt(cfg ownedRestartConfig, port int, label string) (ownedRestartResult, bool) {
	res := ownedRestartResult{Port: port}
	cfg.Life.SetStarting()
	cmd, gate, err := cfg.Spawn(port)
	if err != nil {
		err = fmt.Errorf("failed to start opencode serve: %w", err)
		cfg.Life.SetFailed(err.Error(), nil)
		res.Err = err
		return res, false
	}
	if gate == nil {
		// Contract violation: without an exit gate, readiness CANNOT be
		// attributed to the child — refuse rather than degrade to the old
		// dial-only lie.
		err = fmt.Errorf("owned restart: spawn returned no child exit observer (attempt %s, port %d) — readiness cannot be attributed", label, port)
		cfg.Life.SetFailed(err.Error(), nil)
		res.Err = err
		res.Cmd = cmd
		return res, false
	}
	res.Cmd, res.Exited = cmd, gate.Done()
	if err := waitForChildOwnedPort(port, gate, ownedReadyWait); err != nil {
		res.Err = err
		if errors.Is(err, errOwnedChildExited) {
			// The caller's observer already recorded the exit (ordering
			// invariant); nothing to write here — the retry, if any, owns
			// the next lifecycle write.
			log.Printf("owned opencode restart: %s-port child exited before readiness on port %d", label, port)
			return res, true
		}
		// Readiness timeout: fail closed, keep the child handle + observer
		// (the child may still come up; its eventual exit is recorded).
		cfg.Life.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", port, err), nil)
		return res, false
	}
	// SYNCHRONIZED PUBLICATION BOUNDARY (P1-API-006 A1): the readiness
	// publication runs as ONE critical section under the child's exit gate —
	// the liveness check, the P1-API-003 retarget, and SetReady are atomic
	// with respect to the exit recording. A child exit landing at (or after)
	// the boundary makes PublishIfAlive refuse or serialize AFTER this
	// publication respectively; the historical transient
	// SetFailed-then-SetReady overwrite is structurally impossible. The
	// retarget stays INSIDE the publication so an observer acting on
	// readiness (Snapshot().OpenCodeURL, the running proxy) never sees ready
	// state served through the old port. Same-port restarts no-op.
	if err := gate.PublishIfAlive(func() {
		if p, u, retargeted := applyFreshPortRetarget(port, cfg.StablePort, cfg.Life, cfg.Srv); retargeted {
			res.Port, res.URL, res.Retargeted = p, u, true
			log.Printf("owned opencode restart landed on a fresh port %d — retargeted the running daemon (was port %d)", p, cfg.StablePort)
		}
		cfg.Life.SetReady()
	}); err != nil {
		res.Err = err
		log.Printf("owned opencode restart: %s-port child exit recorded at the publication boundary on port %d — not publishing ready", label, port)
		return res, true
	}
	return res, false
}

// waitForChildOwnedPort is the child-attributed replacement for a dial-only
// readiness wait: the port accepting connections counts ONLY while the
// replacement child's exit oracle stays closed, and only after the acceptance
// survives the stabilization window (ownedPortStabilize). The child's exit is
// authoritative at every point of the wait — once the oracle closes, the
// attempt has failed no matter what the dial says.
//
// Failure modes: errOwnedChildExited (wrapped — retryable by policy), a
// readiness timeout (not retryable), or a missing exit oracle (caller bug).
func waitForChildOwnedPort(port int, gate *ownedExitGate, timeout time.Duration) error {
	if gate == nil {
		return errors.New("waitForChildOwnedPort: no child exit observer supplied")
	}
	exited := gate.Done()
	deadline := time.Now().Add(timeout)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	accepted := false
	var acceptedAt time.Time
	for {
		// The exit oracle is checked at the TOP of every iteration —
		// including the iteration that would return success.
		select {
		case <-exited:
			return fmt.Errorf("port %d: %w", port, errOwnedChildExited)
		default:
		}
		if !accepted {
			if time.Now().After(deadline) {
				return fmt.Errorf("port %d not ready after %v", port, timeout)
			}
			if conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond); err == nil {
				conn.Close()
				accepted = true
				acceptedAt = time.Now()
			}
		} else if time.Since(acceptedAt) >= ownedPortStabilize {
			// The acceptance survived the stabilization window with the
			// child provably alive (oracle checked above, this iteration).
			// Attribute the listener to THIS child.
			return nil
		}
		select {
		case <-exited:
			return fmt.Errorf("port %d: %w", port, errOwnedChildExited)
		case <-time.After(250 * time.Millisecond):
		}
	}
}
