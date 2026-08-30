package cmd

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os/exec"
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
	// child handle plus its exit oracle — a channel closed once the child has
	// exited AND the caller's observer has fully recorded that exit in the
	// lifecycle (the reapOwnedOpenCode ordering invariant: state-set happens
	// BEFORE close). The oracle is what attributes readiness to THIS child;
	// Spawn returning a nil oracle is a caller contract violation and fails
	// the attempt without a retry.
	Spawn func(port int) (*exec.Cmd, <-chan struct{}, error)
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
	cmd, exited, err := cfg.Spawn(port)
	if err != nil {
		err = fmt.Errorf("failed to start opencode serve: %w", err)
		cfg.Life.SetFailed(err.Error(), nil)
		res.Err = err
		return res, false
	}
	if exited == nil {
		// Contract violation: without an exit oracle, readiness CANNOT be
		// attributed to the child — refuse rather than degrade to the old
		// dial-only lie.
		err = fmt.Errorf("owned restart: spawn returned no child exit observer (attempt %s, port %d) — readiness cannot be attributed", label, port)
		cfg.Life.SetFailed(err.Error(), nil)
		res.Err = err
		res.Cmd = cmd
		return res, false
	}
	res.Cmd, res.Exited = cmd, exited
	if err := waitForChildOwnedPort(port, exited, ownedReadyWait); err != nil {
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
	// WRITE-ORDER GUARD (client-daemon requirement): a closed oracle means
	// the child's failure was ALREADY recorded (the observer records state
	// BEFORE closing) — publishing readiness now would overwrite that honest
	// failure. The check is deliberately last: after it, only the child's
	// own observer may speak (a post-startup crash landing after SetReady is
	// the reaper doing its designed job).
	select {
	case <-exited:
		res.Err = fmt.Errorf("port %d: %w", port, errOwnedChildExited)
		log.Printf("owned opencode restart: %s-port child exited at the readiness boundary on port %d — not publishing ready", label, port)
		return res, true
	default:
	}
	// P1-API-003 seam: retarget BEFORE the readiness flip so an observer
	// acting on readiness (Snapshot().OpenCodeURL, the running proxy) never
	// sees ready state served through the old port. Same-port restarts no-op.
	if p, u, retargeted := applyFreshPortRetarget(port, cfg.StablePort, cfg.Life, cfg.Srv); retargeted {
		res.Port, res.URL, res.Retargeted = p, u, true
		log.Printf("owned opencode restart landed on a fresh port %d — retargeted the running daemon (was port %d)", p, cfg.StablePort)
	}
	cfg.Life.SetReady()
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
func waitForChildOwnedPort(port int, exited <-chan struct{}, timeout time.Duration) error {
	if exited == nil {
		return errors.New("waitForChildOwnedPort: no child exit observer supplied")
	}
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
