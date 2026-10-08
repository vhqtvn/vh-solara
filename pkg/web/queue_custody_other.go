//go:build !linux

package web

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
