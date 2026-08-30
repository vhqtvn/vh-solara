package cmd

// Portable (OS-agnostic) semantics tests for the shared child-aware owned
// restart core (P1-API-005). They exercise the attribution mechanism with
// REAL TCP listeners and channel-based exit oracles — no child processes —
// so every platform Go compiles proves the same rules. The Linux-only
// behavioral crux tests (fake `opencode serve`, foreign squatter markers, the
// production restart path) live in opencode_retarget_test.go, which carries
// the linux build tag for the fake-bin scenario machinery.

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// withOwnedPortStabilize shrinks the attribution stabilization window so the
// portable tests run in milliseconds (mirrors withOwnerReleaseWait).
func withOwnedPortStabilize(t *testing.T, d time.Duration) {
	t.Helper()
	old := ownedPortStabilize
	ownedPortStabilize = d
	t.Cleanup(func() { ownedPortStabilize = old })
}

// withOwnedReadyWait shrinks the per-attempt readiness budget (mirrors
// withOwnerReleaseWait).
func withOwnedReadyWait(t *testing.T, d time.Duration) {
	t.Helper()
	old := ownedReadyWait
	ownedReadyWait = d
	t.Cleanup(func() { ownedReadyWait = old })
}

// TestWaitForChildOwnedPortRequiresExitObserver — without an exit oracle,
// readiness CANNOT be attributed to the child; the wait must refuse instead
// of degrading to the old dial-only lie.
func TestWaitForChildOwnedPortRequiresExitObserver(t *testing.T) {
	if err := waitForChildOwnedPort(1, nil, 50*time.Millisecond); err == nil {
		t.Fatal("nil exit oracle must be refused")
	}
}

// TestWaitForChildOwnedPortAcceptsWhileChildAlive — a listener that answers
// while the child's exit oracle stays open through the stabilization window
// is attributed to the child.
func TestWaitForChildOwnedPortAcceptsWhileChildAlive(t *testing.T) {
	withOwnedPortStabilize(t, 60*time.Millisecond)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	exited := make(chan struct{}) // never closed: the child stays alive

	start := time.Now()
	if err := waitForChildOwnedPort(port, exited, 5*time.Second); err != nil {
		t.Fatalf("attribution wait: %v", err)
	}
	if d := time.Since(start); d < 60*time.Millisecond {
		t.Fatalf("returned after %v — the stabilization window was not honored", d)
	}
}

// TestWaitForChildOwnedPortChildExitBeatsForeignListener — THE portable
// attribution crux: a listener (a foreign squatter) answers, but the child's
// exit oracle closes during the stabilization window. The child's exit is
// authoritative: the wait must fail with errOwnedChildExited, never credit
// the foreign listener to the child.
func TestWaitForChildOwnedPortChildExitBeatsForeignListener(t *testing.T) {
	withOwnedPortStabilize(t, 400*time.Millisecond)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	exited := make(chan struct{})
	// The child dies 100ms into the 400ms window — after its dial acceptance
	// would already have been observed.
	time.AfterFunc(100*time.Millisecond, func() { close(exited) })

	err = waitForChildOwnedPort(port, exited, 5*time.Second)
	if !errors.Is(err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited — the child's exit must beat the foreign listener's dial acceptance", err)
	}
}

// TestWaitForChildOwnedPortPreClosedOracleFailsFast — a child that already
// exited fails the wait immediately, long before any readiness budget burns.
func TestWaitForChildOwnedPortPreClosedOracleFailsFast(t *testing.T) {
	exited := make(chan struct{})
	close(exited)
	start := time.Now()
	err := waitForChildOwnedPort(1, exited, 30*time.Second)
	if !errors.Is(err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v — a pre-closed oracle must fail fast", d)
	}
}

// TestWaitForChildOwnedPortTimeoutIsNotChildExit — no listener and a live
// child: the failure is a readiness TIMEOUT, which the retry policy treats
// as fail-closed (not the bind-race signature).
func TestWaitForChildOwnedPortTimeoutIsNotChildExit(t *testing.T) {
	exited := make(chan struct{}) // child alive, never listens
	err := waitForChildOwnedPort(1, exited, 200*time.Millisecond)
	if err == nil {
		t.Fatal("want timeout error")
	}
	if errors.Is(err, errOwnedChildExited) {
		t.Fatalf("err = %v — a timeout must not be misclassified as a child exit", err)
	}
}

// --- core policy tests (fake Spawn — no real child processes) ---

// freeStablePort returns a port that is free RIGHT NOW (bound then released),
// plus the port number, for use as a stable port the first attempt may spawn
// on. The release-to-spawn gap is the repo's standard freePort pattern.
func freeStablePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return p
}

// dyingSpawn models a replacement child that exits before readiness: a dummy
// cmd plus an oracle a goroutine closes after d.
func dyingSpawn(d time.Duration) func(int) (*exec.Cmd, <-chan struct{}, error) {
	return func(port int) (*exec.Cmd, <-chan struct{}, error) {
		exited := make(chan struct{})
		time.AfterFunc(d, func() { close(exited) })
		return &exec.Cmd{}, exited, nil
	}
}

// listeningSpawn models a healthy replacement child: it binds the port it is
// handed (so the dial acceptance is genuinely ITS listener) and its oracle
// never closes while the listener lives.
func listeningSpawn(t *testing.T) func(int) (*exec.Cmd, <-chan struct{}, error) {
	t.Helper()
	return func(port int) (*exec.Cmd, <-chan struct{}, error) {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return nil, nil, fmt.Errorf("fake child bind: %w", err)
		}
		t.Cleanup(func() { ln.Close() })
		return &exec.Cmd{}, make(chan struct{}), nil
	}
}

// TestOwnedRestartCoreRetriesFreshPortAndRetargetsBeforeReady — the stable
// port is free, the stable-port child exits before readiness (the R2 TOCTOU
// signature), and exactly ONE fresh-port attempt follows: it succeeds, and
// the lifecycle URL is retargeted BEFORE readiness is published (any observer
// that first sees state=ready already sees the fresh URL).
func TestOwnedRestartCoreRetriesFreshPortAndRetargetsBeforeReady(t *testing.T) {
	withOwnedPortStabilize(t, 60*time.Millisecond)

	life := oclife.New(oclife.TopologyOwned)
	oldURL := "http://127.0.0.1:1"
	life.SetOpenCodeURL(oldURL)
	stable := freeStablePort(t)

	var spawnPorts []int
	serving := listeningSpawn(t)
	spawn := func(port int) (*exec.Cmd, <-chan struct{}, error) {
		spawnPorts = append(spawnPorts, port)
		if len(spawnPorts) == 1 {
			return dyingSpawn(40 * time.Millisecond)(port)
		}
		return serving(port)
	}

	// Ordering observer: capture the lifecycle URL at the FIRST sighting of
	// state=ready. SetOpenCodeURL(strictly-before)SetReady in the core means
	// every ready-sighting must already carry the fresh URL.
	firstReadyURL := make(chan string, 1)
	go func() {
		for {
			s := life.Snapshot()
			if s.State == oclife.StateReady {
				firstReadyURL <- s.OpenCodeURL
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       life,
		Srv:        nil, // defensive shape: lifecycle URL still retargets
		StablePort: stable,
		Spawn:      spawn,
	})
	if res.Err != nil {
		t.Fatalf("restart: %v", res.Err)
	}
	if len(spawnPorts) != 2 {
		t.Fatalf("spawned %d attempts (%v), want exactly 2 (stable, then one fresh)", len(spawnPorts), spawnPorts)
	}
	if spawnPorts[0] != stable {
		t.Fatalf("first attempt port = %d, want the stable port %d", spawnPorts[0], stable)
	}
	if spawnPorts[1] == stable || spawnPorts[1] <= 0 {
		t.Fatalf("second attempt port = %d, want a fresh port != %d", spawnPorts[1], stable)
	}
	if !res.Retargeted || res.Port != spawnPorts[1] {
		t.Fatalf("result = port %d retargeted=%v, want the fresh port %d retargeted", res.Port, res.Retargeted, spawnPorts[1])
	}
	wantURL := fmt.Sprintf("http://127.0.0.1:%d", spawnPorts[1])
	if res.URL != wantURL {
		t.Fatalf("result URL = %q, want %q", res.URL, wantURL)
	}
	snap := life.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("state = %s, want ready", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle URL = %q, want %q", snap.OpenCodeURL, wantURL)
	}
	select {
	case u := <-firstReadyURL:
		if u != wantURL {
			t.Fatalf("URL at first ready sighting = %q, want %q — readiness was published before the retarget", u, wantURL)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the ready observer never saw state=ready")
	}
}

// TestOwnedRestartCoreStableOccupiedGoesFreshWithoutSpawn — an occupied
// stable port never receives a spawn attempt (the deterministic squatting
// case); the one fresh-port attempt serves instead.
func TestOwnedRestartCoreStableOccupiedGoesFreshWithoutSpawn(t *testing.T) {
	withOwnedPortStabilize(t, 60*time.Millisecond)

	life := oclife.New(oclife.TopologyOwned)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	stable := ln.Addr().(*net.TCPAddr).Port // occupied for the whole test

	var spawnPorts []int
	serving := listeningSpawn(t)
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       life,
		Srv:        nil,
		StablePort: stable,
		Spawn: func(port int) (*exec.Cmd, <-chan struct{}, error) {
			spawnPorts = append(spawnPorts, port)
			return serving(port)
		},
	})
	if res.Err != nil {
		t.Fatalf("restart: %v", res.Err)
	}
	if len(spawnPorts) != 1 || spawnPorts[0] == stable {
		t.Fatalf("spawn ports = %v, want exactly one spawn on a fresh port (stable %d is occupied)", spawnPorts, stable)
	}
	if !res.Retargeted || res.Port != spawnPorts[0] {
		t.Fatalf("result = port %d retargeted=%v, want fresh port %d retargeted", res.Port, res.Retargeted, spawnPorts[0])
	}
	if s := life.Snapshot(); s.State != oclife.StateReady {
		t.Fatalf("state = %s, want ready", s.State)
	}
}

// TestOwnedRestartCoreExhaustionFailsClosed — when the fresh-port attempt's
// child also exits before readiness, recovery is EXHAUSTED: error out, record
// failed, publish no readiness, retarget nothing.
func TestOwnedRestartCoreExhaustionFailsClosed(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	oldURL := "http://127.0.0.1:1"
	life.SetOpenCodeURL(oldURL)
	stable := freeStablePort(t)

	var spawns int
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       life,
		Srv:        nil,
		StablePort: stable,
		Spawn: func(port int) (*exec.Cmd, <-chan struct{}, error) {
			spawns++
			return dyingSpawn(40 * time.Millisecond)(port)
		},
	})
	if res.Err == nil {
		t.Fatal("exhausted restart must fail")
	}
	if !errors.Is(res.Err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited (wrapped)", res.Err)
	}
	if spawns != 2 {
		t.Fatalf("spawns = %d, want exactly 2 (stable + one fresh; recovery is bounded)", spawns)
	}
	if res.Retargeted || res.URL != "" {
		t.Fatalf("retargeted=%v url=%q on failure — a failed restart must not rewire the target", res.Retargeted, res.URL)
	}
	snap := life.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed", snap.State)
	}
	if snap.FailureSummary == "" {
		t.Fatal("exhaustion must record a failure summary")
	}
}

// TestOwnedRestartCoreTimeoutFailsClosedNoRetry — a readiness TIMEOUT (child
// alive, port never answers) is not a bind-race loss: it fails closed with no
// second attempt, and the child handle is retained for the caller.
func TestOwnedRestartCoreTimeoutFailsClosedNoRetry(t *testing.T) {
	withOwnedReadyWait(t, 150*time.Millisecond)
	life := oclife.New(oclife.TopologyOwned)
	stable := freeStablePort(t)

	var spawns int
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       life,
		Srv:        nil,
		StablePort: stable,
		Spawn: func(port int) (*exec.Cmd, <-chan struct{}, error) {
			spawns++
			return &exec.Cmd{}, make(chan struct{}), nil // alive child, never listens
		},
	})
	if res.Err == nil || errors.Is(res.Err, errOwnedChildExited) {
		t.Fatalf("err = %v, want a readiness timeout (not a child exit)", res.Err)
	}
	if spawns != 1 {
		t.Fatalf("spawns = %d, want 1 — a timeout is not retryable", spawns)
	}
	if res.Cmd == nil || res.Exited == nil {
		t.Fatal("the timed-out child's handle + oracle must be retained for the caller")
	}
	if s := life.Snapshot(); s.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed", s.State)
	}
}

// TestOwnedRestartCoreRefusesNilOracle — a Spawn that returns no exit oracle
// is a caller contract violation: the attempt refuses (readiness cannot be
// attributed) and does not retry.
func TestOwnedRestartCoreRefusesNilOracle(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	stable := freeStablePort(t)

	var spawns int
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       life,
		Srv:        nil,
		StablePort: stable,
		Spawn: func(port int) (*exec.Cmd, <-chan struct{}, error) {
			spawns++
			return &exec.Cmd{}, nil, nil
		},
	})
	if res.Err == nil {
		t.Fatal("nil oracle must fail the attempt")
	}
	if spawns != 1 {
		t.Fatalf("spawns = %d, want 1 (not retryable)", spawns)
	}
	if s := life.Snapshot(); s.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed", s.State)
	}
}
