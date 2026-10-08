//go:build !linux

package web

// Non-Linux fail-closed contracts (send-net-resilience slice 2b phase 1,
// B-F6): queue custody — and with it the restart causality barrier — is
// EXCLUDED from the certified matrix outside Linux (debate-3 AMEND-A1: the
// fence requires flock(2); a pretend lock would hand two daemons
// locally-credible custody, the exact split-brain the fence exists to
// prevent). This file pins the exclusion on non-Linux hosts. On a Linux host
// these compile via the same package and the sibling tests
// (TestCustodyBarrierCertificationMatrix, TestQueueDrainFlagOffByteEquivalence)
// pin the Linux arms; cross-compile receipts (GOOS=darwin/windows go build +
// go vet, which compiles this file) live in the slice report.

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestNonLinuxCustodyFailClosed: acquisition refuses with
// errQueueCustodyUnsupported BEFORE any filesystem effect — no lock file, no
// generation authority. The legacy browser-dispatch path remains the only
// dispatch path on these platforms.
func TestNonLinuxCustodyFailClosed(t *testing.T) {
	root := custodyTestRoot(t) // arms the test hook; acquisition must STILL refuse
	if _, err := AcquireQueueCustody(root); !errors.Is(err, errQueueCustodyUnsupported) {
		t.Fatalf("non-Linux acquire err = %v, want errQueueCustodyUnsupported (fail-closed stub)", err)
	}
	// Fail-closed means fail-BEFORE-effects: neither custody artifact exists.
	for _, name := range []string{custodyLockFileRel, custodyGenFileRel} {
		if _, err := os.Stat(filepath.Join(root, ".vh-solara", name)); !os.IsNotExist(err) {
			t.Fatalf("non-Linux acquire created %s (%v) — the stub must not touch the FS", name, err)
		}
	}
	// The raw platform stub agrees (documented skip-with-proof shape: on this
	// host we can and do execute the stub directly).
	if _, err := custodyLockAcquire(filepath.Join(root, ".vh-solara", custodyLockFileRel)); !errors.Is(err, errQueueCustodyUnsupported) {
		t.Fatalf("custodyLockAcquire err = %v, want errQueueCustodyUnsupported", err)
	}
}

// TestNonLinuxBarrierNeverCertified: the restart causality barrier is NEVER
// certified off-Linux — not even for a spawned OpenCode instance. Custody
// cannot hold here, so no barrier claim may survive either.
func TestNonLinuxBarrierNeverCertified(t *testing.T) {
	if custodyBarrierCertified(false) {
		t.Fatal("non-Linux + spawned-OC must not certify the restart barrier (AMEND-A1 platform exclusion)")
	}
	if custodyBarrierCertified(true) {
		t.Fatal("non-Linux + external-OC must not certify the restart barrier")
	}
}

// TestNonLinuxCustodyLockHeldProbeStub: the D-F2 arbitration probe stub is
// constant-false — custody can never be live-held where it cannot be
// acquired, so the browser-facing routes never refuse on arbitration grounds
// outside the certified matrix.
func TestNonLinuxCustodyLockHeldProbeStub(t *testing.T) {
	root := t.TempDir()
	// Even a physically present lock "file" must not read as held: there is
	// no flock discipline to observe on this platform.
	lockPath := filepath.Join(root, ".vh-solara", custodyLockFileRel)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if custodyLockHeld(lockPath) {
		t.Fatal("non-Linux custodyLockHeld reported held — stub must be constant-false")
	}
}
