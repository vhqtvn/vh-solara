package cmd

import (
	"net"
	"os"
	"testing"

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
