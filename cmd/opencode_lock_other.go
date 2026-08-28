//go:build !linux

package cmd

import "os"

// Non-Linux degenerate guard: the two-role flock protocol is Linux-only
// (flock + /proc/<pid>/fd inspection). Everywhere else the guard is a no-op
// that always "acquires" and never reports an owner, so the shared start
// transaction degrades to exactly the pre-protocol best-effort behavior —
// same posture as ocCmdlineMatches, which already returns true (cannot
// verify) on platforms without /proc. The never-spawn-while-alive rule still
// holds there through pid liveness + cmdline matching; only the cross-process
// crash-window exclusion is unavailable.

type ocSpawnGuard struct{}

func acquireOCSpawnGuard() (*ocSpawnGuard, ocLockVerdict, string) {
	return &ocSpawnGuard{}, ocLockAcquired, ""
}

// Release is a no-op (nothing was locked).
func (g *ocSpawnGuard) Release() {}

// ocOwnerLockHeldByOthers always reports free: without the protocol there is
// no owner lock to hold.
func ocOwnerLockHeldByOthers() bool { return false }

// ocOwnerLockHolders has nothing to discover without /proc fd inspection.
func ocOwnerLockHolders() []ocLockHolder { return nil }

// takeOwnerForChild hands nothing to the child (no ExtraFiles on this
// platform).
func (g *ocSpawnGuard) takeOwnerForChild() ([]*os.File, error) { return nil, nil }

// childRetainsOwner cannot be verified here; true mirrors ocCmdlineMatches's
// degrade-to-trust posture on non-/proc platforms.
func (g *ocSpawnGuard) childRetainsOwner(pid int) bool { return true }

// closeParentOwnerCopy is a no-op (no fd was taken).
func (g *ocSpawnGuard) closeParentOwnerCopy() {}

// ownerPathForLog is empty: no owner lock exists on this platform.
func (g *ocSpawnGuard) ownerPathForLog() string { return "" }
