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
	"strings"
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

// withOwnedStopBounds shrinks the owned stop path's SIGTERM grace and
// post-SIGKILL wait so the bounded-stop tests run in milliseconds (mirrors
// withOwnedReadyWait). Safe only under package cmd's strict serial
// discipline — no t.Parallel anywhere in the package (the same documented
// discipline the ocSweepSignal seam relies on).
func withOwnedStopBounds(t *testing.T, grace, kill time.Duration) {
	t.Helper()
	oldGrace, oldKill := ownedStopGrace, ownedKillWait
	ownedStopGrace, ownedKillWait = grace, kill
	t.Cleanup(func() { ownedStopGrace, ownedKillWait = oldGrace, oldKill })
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
	gate := newOwnedExitGate() // never recorded: the child stays alive

	start := time.Now()
	if err := waitForChildOwnedPort(port, gate, 5*time.Second); err != nil {
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
	gate := newOwnedExitGate()
	// The child dies 100ms into the 400ms window — after its dial acceptance
	// would already have been observed.
	time.AfterFunc(100*time.Millisecond, func() { gate.RecordExit(func() {}) })

	err = waitForChildOwnedPort(port, gate, 5*time.Second)
	if !errors.Is(err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited — the child's exit must beat the foreign listener's dial acceptance", err)
	}
}

// TestWaitForChildOwnedPortPreClosedOracleFailsFast — a child that already
// exited fails the wait immediately, long before any readiness budget burns.
func TestWaitForChildOwnedPortPreClosedOracleFailsFast(t *testing.T) {
	gate := newOwnedExitGate()
	gate.RecordExit(func() {})
	start := time.Now()
	err := waitForChildOwnedPort(1, gate, 30*time.Second)
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
	gate := newOwnedExitGate() // child alive, never listens
	err := waitForChildOwnedPort(1, gate, 200*time.Millisecond)
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
// cmd plus a gate whose oracle a goroutine records (fully) after d.
func dyingSpawn(d time.Duration) func(int) (*exec.Cmd, *ownedExitGate, error) {
	return func(port int) (*exec.Cmd, *ownedExitGate, error) {
		gate := newOwnedExitGate()
		time.AfterFunc(d, func() { gate.RecordExit(func() {}) })
		return &exec.Cmd{}, gate, nil
	}
}

// reapingDyingSpawn is dyingSpawn PLUS the real observer's lifecycle record:
// the exit is recorded exactly as reapOwnedOpenCode would (SetFailed with
// the exit-code detail and payload) before the oracle closes. Used where a
// test asserts the FINAL failure summary — the reaper's record is what the
// R1 exhaustion policy lets stand.
func reapingDyingSpawn(life *oclife.Lifecycle, d time.Duration) func(int) (*exec.Cmd, *ownedExitGate, error) {
	return func(port int) (*exec.Cmd, *ownedExitGate, error) {
		gate := newOwnedExitGate()
		time.AfterFunc(d, func() {
			code := 1
			gate.RecordExit(func() { life.SetFailed("opencode serve exited with code 1", &code) })
		})
		return &exec.Cmd{}, gate, nil
	}
}

// listeningSpawn models a healthy replacement child: it binds the port it is
// handed (so the dial acceptance is genuinely ITS listener) and its oracle
// never closes while the listener lives.
func listeningSpawn(t *testing.T) func(int) (*exec.Cmd, *ownedExitGate, error) {
	t.Helper()
	return func(port int) (*exec.Cmd, *ownedExitGate, error) {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return nil, nil, fmt.Errorf("fake child bind: %w", err)
		}
		t.Cleanup(func() { ln.Close() })
		return &exec.Cmd{}, newOwnedExitGate(), nil
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
	spawn := func(port int) (*exec.Cmd, *ownedExitGate, error) {
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
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
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
// failed, publish no readiness, retarget nothing. The R1 extension: the FINAL
// failure summary is the reaper's exit-code detail (the most specific
// diagnostic available), NOT the exhaustion wrap — the wrap names the
// bounded-retry policy, the reaper names WHY the child died.
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
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
			spawns++
			return reapingDyingSpawn(life, 40*time.Millisecond)(port)
		},
	})
	if res.Err == nil {
		t.Fatal("exhausted restart must fail")
	}
	if !errors.Is(res.Err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited (wrapped)", res.Err)
	}
	// The RETURNED error still names the bounded policy (the 502 body the
	// operator sees names exhaustion)…
	if !strings.Contains(res.Err.Error(), "exhausted") {
		t.Fatalf("err = %v, want the exhaustion wrap in the returned error", res.Err)
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
	// …but the LIFECYCLE keeps the reaper's exit-code detail — the exhaustion
	// wrap must NOT overwrite it (R1: the diagnostic the operator needs is
	// why the child died, not that recovery is bounded).
	const reaperSummary = "opencode serve exited with code 1"
	if snap.FailureSummary != reaperSummary {
		t.Fatalf("failure summary = %q, want the reaper's exit-code detail %q — the exhaustion wrap overwrote the reaper's record", snap.FailureSummary, reaperSummary)
	}
	if snap.ExitCode == nil || *snap.ExitCode != 1 {
		t.Fatalf("exit code = %v, want 1 (the reaper's exit payload must stand)", snap.ExitCode)
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
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
			spawns++
			return &exec.Cmd{}, newOwnedExitGate(), nil // alive child, never listens
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
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
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

// --- P1-API-006 A1: the synchronized publication boundary (DEFER-1) ---
//
// The gate serializes the exit recorder against the readiness publisher. A
// single mutex admits exactly two linearizations; these tests drive BOTH
// deterministically (no stress, no timing bound) using the caller-supplied
// closures as the barrier, and a third test drives the boundary through the
// REAL attempt code path. Together they discharge the P1-API-005 DEFER-1
// residual: a child exit landing at the publication boundary can no longer
// be transiently overwritten by the readiness write.

// TestOwnedExitGateExitRecordedAtBoundaryRefusesPublication — THE DEFER-1
// barrier: the child's exit is FULLY recorded (state-set + oracle close) at
// the exact publication boundary; the readiness publisher released after that
// must be refused — the failure state cannot be overwritten by SetReady.
func TestOwnedExitGateExitRecordedAtBoundaryRefusesPublication(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	gate := newOwnedExitGate()

	// The exit recorder completes first — the worst-case placement the old
	// unsynchronized boundary could miss (exit after the final oracle poll).
	gate.RecordExit(func() {
		life.SetFailed("opencode serve exited with code 1", nil)
	})

	published := false
	err := gate.PublishIfAlive(func() {
		published = true
		life.SetReady()
	})
	if err == nil || !errors.Is(err, errOwnedChildExited) {
		t.Fatalf("err = %v, want errOwnedChildExited (wrapped) — publication must be refused after the exit is recorded", err)
	}
	if published {
		t.Fatal("the readiness publication ran after the exit was recorded — the failure state was overwritten")
	}
	if s := life.Snapshot(); s.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed (final, not overwritten)", s.State)
	}
}

// TestOwnedExitGatePublicationBlocksExitRecorder — the converse linearization:
// the readiness publisher is parked INSIDE its critical section (the test
// barrier), and the exit recorder must queue on the gate. Once released, the
// record lands AFTER the publication — the DESIGNED post-readiness-crash
// direction (ready → failed), never the false-ready direction. The parked
// publisher also proves the two publications are mutually exclusive.
func TestOwnedExitGatePublicationBlocksExitRecorder(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	gate := newOwnedExitGate()

	pubEntered := make(chan struct{})
	releasePub := make(chan struct{})
	pubDone := make(chan struct{})
	go func() {
		if err := gate.PublishIfAlive(func() {
			close(pubEntered)
			<-releasePub // the barrier: the publisher HOLDS the gate here
			life.SetReady()
		}); err != nil {
			t.Errorf("publication: %v", err)
		}
		close(pubDone)
	}()
	<-pubEntered // the publisher is inside its critical section

	recDone := make(chan struct{})
	go func() {
		gate.RecordExit(func() {
			life.SetFailed("opencode serve exited with code 1", nil)
		})
		close(recDone)
	}()

	// The recorder must NOT complete while the publisher holds the gate.
	// (Bounded negative wait — the load-bearing assertions below are the
	// deterministic ordering ones.)
	select {
	case <-recDone:
		t.Fatal("the exit recorder completed while the readiness publisher held the gate — the publications are not mutually exclusive")
	case <-time.After(50 * time.Millisecond):
	}

	close(releasePub)
	<-pubDone
	<-recDone
	// pubEntered closed ⇒ the publication DID run; the final state is failed
	// ⇒ the record landed after it. ready→failed is the designed direction.
	if s := life.Snapshot(); s.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed — the post-publication exit record must be final (post-readiness crash semantics)", s.State)
	}
}

// TestOwnedExitGateRecordsOnce — one child, one exit: a second RecordExit
// (e.g. a duplicated observer wiring) must not re-run the record closure or
// double-close the oracle.
func TestOwnedExitGateRecordsOnce(t *testing.T) {
	gate := newOwnedExitGate()
	records := 0
	gate.RecordExit(func() { records++ })
	gate.RecordExit(func() { records++ })
	if records != 1 {
		t.Fatalf("record ran %d times, want exactly 1", records)
	}
	select {
	case <-gate.Done():
	default:
		t.Fatal("the oracle must be closed after the first record")
	}
}

// TestOwnedRestartAttemptBoundaryExitNeverPublishesReady — the boundary
// through the REAL attempt code path. The stable-port "child" binds its
// listener, and its exit recorder fires the moment the readiness wait's dial
// probe arrives — i.e. the exit record completes INSIDE the attempt's
// observation window, anywhere between the wait's last alive poll and the
// publication. Whatever the scheduler decides, the resting outcome is the
// same invariant: the lifecycle never rests on ready for that child — either
// the publication was refused (record first) or the record landed after it
// as the designed post-readiness flip (ready → failed).
//
// Scope note (A1 review checkpoint): forcing the real-path publisher to a
// specific PRE-LOCK position — record strictly between the wait's return and
// PublishIfAlive — is not externally observable without a production pause
// hook, which the gate design deliberately avoids. The exact boundary
// interleavings (recorded-then-refused; publisher-parked-while-recorder-
// waits) are pinned deterministically by the two gate-level barrier tests
// above; this test proves the production attempt surfaces the same resting
// invariant through its real call path.
func TestOwnedRestartAttemptBoundaryExitNeverPublishesReady(t *testing.T) {
	withOwnedPortStabilize(t, 60*time.Millisecond)
	life := oclife.New(oclife.TopologyOwned)
	stable := freeStablePort(t)

	// Dial observation: the listener signals the first readiness probe so the
	// releaser can unblock the exit recording without any sleep-based timing.
	dialed := make(chan struct{}, 1)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", stable))
	if err != nil {
		t.Fatalf("bind stable candidate: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			select {
			case dialed <- struct{}{}:
			default:
			}
			c.Close()
		}
	}()

	var attemptGate *ownedExitGate
	spawn := func(port int) (*exec.Cmd, *ownedExitGate, error) {
		gate := newOwnedExitGate()
		attemptGate = gate
		// The child's observer: the moment the readiness wait's dial probe
		// arrives, record the exit under the gate — modeling a reaper whose
		// Wait() return lands inside the attempt's observation window.
		go func() {
			<-dialed
			gate.RecordExit(func() {
				life.SetFailed("opencode serve exited with code 1", nil)
			})
		}()
		return &exec.Cmd{}, gate, nil
	}

	res, childDied := ownedRestartAttempt(ownedRestartConfig{
		Life:       life,
		Srv:        nil,
		StablePort: stable,
		Spawn:      spawn,
	}, stable, "stable")

	// The scheduling decides WHICH side observes the exit — the record may
	// complete before the wait's final alive poll (wait branch: the attempt
	// reports the retryable child exit), or the publisher may win the gate
	// first and the record then lands as the designed post-readiness flip.
	// Both branches must satisfy the same OUTCOME invariant, asserted below
	// once the record has deterministically completed:
	<-attemptGate.Done()
	s := life.Snapshot()
	if s.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed — a child exit recorded inside the attempt's window must never leave the lifecycle resting on ready (err=%v)", s.State, res.Err)
	}
	if s.FailureSummary == "" {
		t.Fatal("the recorded exit must carry a failure summary")
	}
	// Branch consistency: an error, when present, is exactly the retryable
	// child-exit signature (never a timeout, never a silent success over an
	// unrecorded exit — Done() is closed, so the exit IS recorded).
	if res.Err != nil {
		if !childDied {
			t.Fatalf("err = %v with childDied=false — an errored boundary attempt must report the retryable signature", res.Err)
		}
		if !errors.Is(res.Err, errOwnedChildExited) {
			t.Fatalf("err = %v, want errOwnedChildExited (wrapped)", res.Err)
		}
	}
}

// --- R11: the bounded owned stop path (portable, channel-only unit tests;
// the wedged-child behavioral cruxes with real processes live in the
// linux-gated files) ---

// TestStopOwnedChildPreClosedOracleReturnsFast — a child that already exited
// (oracle closed) stops immediately: no grace is burned, no error.
func TestStopOwnedChildPreClosedOracleReturnsFast(t *testing.T) {
	gate := newOwnedExitGate()
	gate.RecordExit(func() {})
	life := oclife.New(oclife.TopologyOwned)
	start := time.Now()
	if err := stopOwnedOpenCodeChild(life, nil, gate.Done()); err != nil {
		t.Fatalf("stop with a pre-closed oracle: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v — a pre-closed oracle must return immediately", d)
	}
}

// TestStopOwnedChildNilCmdNilDoneIsNoOp — nothing to signal, nothing to
// wait on: the historical no-previous-child shape must stay a no-op.
func TestStopOwnedChildNilCmdNilDoneIsNoOp(t *testing.T) {
	if err := stopOwnedOpenCodeChild(nil, nil, nil); err != nil {
		t.Fatalf("nil cmd + nil done must be a no-op, got %v", err)
	}
}

// TestStopOwnedChildRefusalFailsClosed — an oracle that NEVER closes (the
// wedged-child shape, modeled with channels only): the stop must burn the
// SIGTERM grace, escalate (nothing to signal with a nil cmd — the SIGKILL
// branch is skipped, the wait is still bounded), then FAIL CLOSED — the
// lifecycle records the refusal summary and the error carries it. This is
// the liveness defect's unit signature: the call RETURNS within the bound
// instead of waiting forever.
func TestStopOwnedChildRefusalFailsClosed(t *testing.T) {
	withOwnedStopBounds(t, 40*time.Millisecond, 60*time.Millisecond)
	life := oclife.New(oclife.TopologyOwned)
	never := make(chan struct{}) // never closed
	start := time.Now()
	err := stopOwnedOpenCodeChild(life, nil, never)
	if err == nil {
		t.Fatal("a never-closing oracle must fail the stop")
	}
	const want = "old opencode did not exit after SIGKILL"
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to name the refusal (%q)", err, want)
	}
	if d := time.Since(start); d < 100*time.Millisecond {
		t.Fatalf("returned after %v — the grace+kill bounds were not honored", d)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v — the stop must be bounded", d)
	}
	snap := life.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("state = %s, want failed (fail-closed refusal records the lifecycle failure)", snap.State)
	}
	if snap.FailureSummary != want {
		t.Fatalf("failure summary = %q, want %q", snap.FailureSummary, want)
	}
}
