package cmd

import (
	"net"
	"os"
	"testing"
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
