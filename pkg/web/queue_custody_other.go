//go:build !linux

package web

// custodyPlatformRefusal is the non-Linux arm of the pre-filesystem
// platform gate (tier1_b-F1): refusal happens BEFORE AcquireQueueCustody
// performs ANY filesystem effect (no .vh-solara dir, no lock file, no
// generation authority) — "fail-closed" means fail-BEFORE-effects.
func custodyPlatformRefusal() error { return errQueueCustodyUnsupported }

// custodyLockAcquire is the non-Linux fail-closed stub: queue custody is
// UNAVAILABLE outside the certified matrix (debate-3 AMEND-A1 — the fence
// requires flock(2); pretending to lock without it would hand two daemons
// locally-credible custody, the exact split-brain the fence exists to
// prevent). Callers get errQueueCustodyUnsupported; the custody-mode journal
// and fence paths are unreachable; the legacy browser-dispatch path is
// unaffected and remains the only dispatch path on these platforms.
func custodyLockAcquire(path string) (custodyLock, error) {
	return nil, errQueueCustodyUnsupported
}

// custodyLockHeld is the non-Linux probe stub (D-F2 mixed-writer
// arbitration): custody can never be live-held where it cannot be acquired,
// so the probe constant-false — the browser-facing routes never refuse on
// arbitration grounds outside the certified matrix.
func custodyLockHeld(path string) bool {
	return false
}
