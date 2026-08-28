package cmd

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/ringlog"
)

func TestOCStateRoundTripAndOwnership(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())

	if _, ok := readOCState(); ok {
		t.Fatal("expected no state initially")
	}
	writeOCState(ocState{PID: os.Getpid(), Port: 54321})
	s, ok := readOCState()
	if !ok || s.PID != os.Getpid() || s.Port != 54321 {
		t.Fatalf("round-trip failed: %+v ok=%v", s, ok)
	}

	if !ocProcessAlive(os.Getpid()) {
		t.Fatal("current process should be alive")
	}
	if ocProcessAlive(1 << 30) {
		t.Fatal("a bogus pid should not be alive")
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	bound := ln.Addr().(*net.TCPAddr).Port
	if portFree(bound) {
		t.Fatalf("port %d is bound, should not be free", bound)
	}
}

// TestSeedRingFromDiskLog verifies the detached-reconnect ring seeding. On a
// vh restart that reconnects to a still-running detached OpenCode, the in-memory
// ring is fresh and empty but the disk log has the recent history; the seeding
// must surface that history so /vh/opencode/logs honors HasLogTail=true.
func TestSeedRingFromDiskLog(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())

	// 1. No log file yet (fresh instance): seeding a fresh ring is a silent no-op.
	r1 := ringlog.New(ringlog.DefaultCap)
	seedRingFromDiskLog(r1, ocLogPath())
	if got := len(r1.Tail(0)); got != 0 {
		t.Fatalf("expected empty ring when log file absent; got %d bytes", got)
	}

	// 2. Empty log file: also a no-op.
	if err := os.WriteFile(ocLogPath(), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	seedRingFromDiskLog(r1, ocLogPath())
	if got := len(r1.Tail(0)); got != 0 {
		t.Fatalf("expected empty ring for empty log file; got %d bytes", got)
	}

	// 3. Known content: the ring tail must match the disk content exactly.
	want := "detached-opencode-output-line-1\ndetached-opencode-output-line-2\n"
	if err := os.WriteFile(ocLogPath(), []byte(want), 0o644); err != nil {
		t.Fatal(err)
	}
	r2 := ringlog.New(ringlog.DefaultCap)
	seedRingFromDiskLog(r2, ocLogPath())
	if got := string(r2.Tail(0)); got != want {
		t.Fatalf("ring tail mismatch after seed:\nwant=%q\ngot =%q", want, got)
	}

	// 4. File larger than ringlog.DefaultCap: seed must be bounded to the cap
	//    (the ring keeps the most recent bytes; the on-disk head is dropped).
	big := make([]byte, ringlog.DefaultCap+1024)
	for i := range big {
		big[i] = 'x'
	}
	if err := os.WriteFile(ocLogPath(), big, 0o644); err != nil {
		t.Fatal(err)
	}
	r3 := ringlog.New(ringlog.DefaultCap)
	seedRingFromDiskLog(r3, ocLogPath())
	if got := len(r3.Tail(0)); got != ringlog.DefaultCap {
		t.Fatalf("expected bounded tail of %d bytes, got %d", ringlog.DefaultCap, got)
	}

	// 5. nil ring must not panic (defensive guard for non-output topologies).
	seedRingFromDiskLog(nil, ocLogPath())
}

// --- classifyOCInstance gate tests (split-brain guard) ---
//
// The fake "opencode" here is the test binary itself, re-exec'd with a
// cmdline that contains `opencode serve --port N` (the classic
// helper-process trick), so ocCmdlineMatches sees a live, matching process.
// The HTTP side is a fake server standing in for the recorded port.

// TestFakeOpenCodeHelperProcess is never a real test: when GO_WANT_OC_HELPER
// is set it blocks forever (holding the pid alive with a matching cmdline)
// until the parent kills it. A sleep loop, not select{} — the runtime
// deadlock detector panics on a fully-blocked process.
func TestFakeOpenCodeHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_OC_HELPER") != "1" {
		return
	}
	for {
		time.Sleep(time.Hour)
	}
}

// startFakeOCProcess spawns the helper-process fake with a cmdline matching
// `opencode serve --port <port>` and returns the started cmd.
//
// RACE NOTE: /proc/<pid>/cmdline can read back EMPTY in the fork→exec window
// right after Start() (alive, readable, zero bytes — the same signature as a
// zombie), so the helper polls briefly until its cmdline is populated.
// Production never sees this: the state file is written only after
// waitForPort() succeeds, long after the spawn's exec completed.
func startFakeOCProcess(t *testing.T, port int) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0],
		"-test.run=^TestFakeOpenCodeHelperProcess$",
		"--", "opencode", "serve", "--port", strconv.Itoa(port))
	cmd.Env = append(os.Environ(), "GO_WANT_OC_HELPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start fake opencode helper: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait() // no-op if the test already killed + reaped it
	})
	// Wait (bounded) for the exec to be observable in /proc.
	deadline := time.Now().Add(2 * time.Second)
	procPath := fmt.Sprintf("/proc/%d/cmdline", cmd.Process.Pid)
	for {
		b, err := os.ReadFile(procPath)
		if err == nil && len(b) > 0 {
			return cmd
		}
		if time.Now().After(deadline) {
			t.Fatalf("fake opencode helper pid %d never populated its cmdline", cmd.Process.Pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// fakeOCServer stands up an HTTP server on a fresh loopback port.
func fakeOCServer(t *testing.T, h http.HandlerFunc) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

// withFastProbeKnobs shrinks the probe retry window so the occupied-path
// tests run in milliseconds instead of seconds. Tests must not run in
// parallel while the shrunken knobs are active (they don't).
func withFastProbeKnobs(t *testing.T) {
	t.Helper()
	oldTimeout, oldAttempts, oldGap := ocProbeTimeout, ocProbeAttempts, ocProbeRetryGap
	ocProbeTimeout, ocProbeAttempts, ocProbeRetryGap = 150*time.Millisecond, 2, 40*time.Millisecond
	t.Cleanup(func() {
		ocProbeTimeout, ocProbeAttempts, ocProbeRetryGap = oldTimeout, oldAttempts, oldGap
	})
}

func TestClassifyOCInstanceGate(t *testing.T) {
	withFastProbeKnobs(t)

	t.Run("no recorded state → may spawn", func(t *testing.T) {
		rep := classifyOCInstance(ocState{}, false)
		if rep.Verdict != ocGateNoState || !rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateNoState/maySpawn, got verdict=%d maySpawn=%v", rep.Verdict, rep.Verdict.maySpawn())
		}
	})

	t.Run("recorded pid dead → may spawn", func(t *testing.T) {
		port := freePort()
		cmd := startFakeOCProcess(t, port)
		if err := cmd.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		_ = cmd.Wait() // reap so the pid is observably dead (not zombie)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateForeign || !rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateForeign/maySpawn, got verdict=%d maySpawn=%v reason=%q", rep.Verdict, rep.Verdict.maySpawn(), rep.Reason)
		}
	})

	t.Run("recorded pid recycled into foreign cmdline → may spawn", func(t *testing.T) {
		if _, err := os.ReadFile("/proc/self/cmdline"); err != nil {
			t.Skip("no /proc cmdline verification on this platform; mismatch path unreachable")
		}
		// Our own pid is alive but its cmdline is not `opencode serve --port 1`.
		rep := classifyOCInstance(ocState{PID: os.Getpid(), Port: 1}, true)
		if rep.Verdict != ocGateForeign || !rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateForeign/maySpawn, got verdict=%d maySpawn=%v reason=%q", rep.Verdict, rep.Verdict.maySpawn(), rep.Reason)
		}
	})

	t.Run("healthy instance → reattach, never spawn", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		cmd := startFakeOCProcess(t, port)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateReattach || rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateReattach/no-spawn, got verdict=%d maySpawn=%v reason=%q", rep.Verdict, rep.Verdict.maySpawn(), rep.Reason)
		}
	})

	// CRUX (incident 2026-08-28): a live, cmdline-matching instance whose
	// /session is slower than the probe budget. The old gate treated the
	// timeout as "not ours" and spawned a second OpenCode beside it. The new
	// gate MUST NOT reach the spawn branch.
	t.Run("slow-but-alive instance → occupied, NEVER spawn", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(600 * time.Millisecond) // ≫ the 150ms probe budget
			w.WriteHeader(http.StatusOK)
		})
		cmd := startFakeOCProcess(t, port)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateOccupied || rep.Verdict.maySpawn() {
			t.Fatalf("SPLIT-BRAIN REGRESSION: want ocGateOccupied/no-spawn for slow-but-alive instance, got verdict=%d maySpawn=%v", rep.Verdict, rep.Verdict.maySpawn())
		}
		if rep.Reason == "" {
			t.Fatal("occupied verdict should carry a reason for the ocLife failure message")
		}
	})

	// EXPLICIT POLICY, pinned: connection refused + pid alive + cmdline match
	// → occupied, NEVER spawn. The listener may be dead or wedged, but the
	// process still holds the project DB and may finish in-flight runs;
	// recovery is the operator's restart action, not a duplicate instance.
	t.Run("refused + pid alive + cmdline match → occupied, NEVER spawn", func(t *testing.T) {
		port := freePort() // nothing listens here
		cmd := startFakeOCProcess(t, port)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateOccupied || rep.Verdict.maySpawn() {
			t.Fatalf("SPLIT-BRAIN REGRESSION: want ocGateOccupied/no-spawn for refused+alive+matching, got verdict=%d maySpawn=%v", rep.Verdict, rep.Verdict.maySpawn())
		}
	})

	// A live, matching instance answering 5xx on every endpoint: attaching
	// would be degraded, but spawning beside it would split-brain. (The OLD
	// gate spawned here too — status ≥500 counted as "not ours".)
	t.Run("persistent 500 + pid alive → occupied, NEVER spawn", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		cmd := startFakeOCProcess(t, port)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateOccupied || rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateOccupied/no-spawn for 500-but-alive, got verdict=%d maySpawn=%v", rep.Verdict, rep.Verdict.maySpawn())
		}
	})

	// Probe robustness: a transient failure (both endpoints 5xx on the first
	// attempt) must recover on retry into a reattach, not strand the worker
	// in the occupied state.
	t.Run("transient failure recovers on retry → reattach", func(t *testing.T) {
		var calls atomic.Int32
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) <= 2 { // attempt 1: /api/health + /session both fail
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
		cmd := startFakeOCProcess(t, port)
		rep := classifyOCInstance(ocState{PID: cmd.Process.Pid, Port: port}, true)
		if rep.Verdict != ocGateReattach || rep.Verdict.maySpawn() {
			t.Fatalf("want ocGateReattach after transient failure, got verdict=%d maySpawn=%v reason=%q", rep.Verdict, rep.Verdict.maySpawn(), rep.Reason)
		}
	})
}

// TestOCProbePortEndpoints pins the endpoint-level probe semantics without a
// helper process.
func TestOCProbePortEndpoints(t *testing.T) {
	withFastProbeKnobs(t)

	t.Run("404 on /api/health (route absent in older builds) still proves liveness", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
		if got := ocProbePort(port); got != "" {
			t.Fatalf("404 on /api/health must count as answering; got %q", got)
		}
	})

	t.Run("unhealthy /api/health falls back to a healthy /session", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
		})
		if got := ocProbePort(port); got != "" {
			t.Fatalf("healthy /session fallback must count as answering; got %q", got)
		}
	})

	t.Run("5xx everywhere is a failure with the status in the reason", func(t *testing.T) {
		port := fakeOCServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		got := ocProbePort(port)
		if got == "" {
			t.Fatal("all-5xx must not count as answering")
		}
		if !strings.Contains(got, "500") {
			t.Fatalf("reason should mention the HTTP status; got %q", got)
		}
	})
}
