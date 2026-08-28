package cmd

import (
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
)

// Cross-process mutual exclusion for the detached-OpenCode spawn path
// (P1-API-002, incident 2026-08-28 follow-up). Two vh-solara processes
// starting against the same project (daemon restart racing self-update,
// local-server racing client-daemon) must never both spawn `opencode serve`
// against the same project sqlite DB — including the hard-crash window after
// the first starter has created the child but before it has published
// ocState.
//
// The mechanism (operator-accepted; crash-matrix-verified in
// tmp/agent-runs/oc-spawn-lock-experiment) is a two-role flock(2) protocol on
// two lock files that live beside the per-project ocState file:
//
//   - STARTER lock (<key>.spawn.lock): parent-held, CLOEXEC, held across the
//     whole transaction acquire → classify → spawn → readiness → publication,
//     then released. Serializes cooperating starters; a loser acquires it
//     non-blocking, fails fast (ms), and never waits out the winner's
//     classification (~13s) or readiness (~30s) budget.
//
//   - OWNER lock (<key>.owner.lock): the spawn-slot ownership token. The
//     parent opens it WITHOUT O_CLOEXEC and flocks it BEFORE fork, passes it
//     as the child's fd 3 (exec.Cmd.ExtraFiles), verifies the child retained
//     it, then closes ITS OWN copy — close-only, NEVER LOCK_UN. Because the
//     parent no longer holds any fd of that open file description, no later
//     parent code path can drop the lock; exclusion is exactly coextensive
//     with the opencode process (and any descendant that inherits fd 3, e.g.
//     MCP/LSP servers). A parent SIGKILL at ANY boundary therefore leaves
//     either no child plus freed locks, or a live child that still owns the
//     slot — there is no unowned-live-child window.
//
// Loser policy (never-spawn-beside-maybe-live asymmetry): a starter that
// finds the owner lock held but no live recorded `opencode serve` (opencode
// died while a descendant retains fd 3) reports ORPHANED OWNER and never
// auto-spawns; the holders are discoverable via /proc/*/fd readlink and are
// surfaced in the failure reason for the operator.
//
// Portability: the protocol is Linux-only (flock + /proc fd inspection). On
// other platforms the guard degrades to unlocked best-effort — exactly the
// pre-protocol behavior — and ocCmdlineMatches already degrades the same way
// there (no /proc ⇒ cannot verify ⇒ treat recorded-pid-alive as owned).

// ocLockVerdict is the outcome of acquiring the per-project starter lock.
type ocLockVerdict int

const (
	ocLockAcquired  ocLockVerdict = iota // starter lock held by us
	ocLockContended                      // another live starter holds it
	ocLockError                          // open/flock failed unexpectedly
)

func (v ocLockVerdict) String() string {
	switch v {
	case ocLockAcquired:
		return "acquired"
	case ocLockContended:
		return "contended"
	case ocLockError:
		return "error"
	}
	return fmt.Sprintf("ocLockVerdict(%d)", int(v))
}

// ocLockHolder names a process holding the owner lock fd (orphaned-owner
// reporting).
type ocLockHolder struct {
	PID     int
	Cmdline string
}

func (h ocLockHolder) String() string {
	if h.Cmdline == "" {
		return fmt.Sprintf("pid %d", h.PID)
	}
	return fmt.Sprintf("pid %d (%s)", h.PID, h.Cmdline)
}

// ocSpawnLockPath / ocOwnerLockPath place the lock artifacts under the same
// vh state base and project key as ocState itself
// (<VH_STATE_DIR-or-user-config>/vh-solara/opencode/<sha1(cwd)>.{spawn,owner}.lock),
// NOT in the repository's .vh-solara/ runtime dir: the exclusion object must
// key exactly like the state it protects. ocStateDir's MkdirAll ensures the
// directory exists before the locks are opened.
func ocSpawnLockPath() string { return filepath.Join(ocStateDir(), ocProjectKey()+".spawn.lock") }
func ocOwnerLockPath() string { return filepath.Join(ocStateDir(), ocProjectKey()+".owner.lock") }

// startChildWithOwner performs the gap-free ownership handoff around
// startOpenCodeServeDetached:
//
//  1. take the owner lock on a fresh non-CLOEXEC description (must succeed:
//     we hold the starter lock and the owner test was free);
//  2. spawn the child with that fd as ExtraFiles[0] (fd 3 in the child,
//     CLOEXEC clear by construction of ExtraFiles);
//  3. verify the child retained fd 3 (readlink /proc/<pid>/fd/3); a child
//     that closed it means an upstream change broke fd passing — kill it and
//     fail closed rather than spawn an unowned instance;
//  4. close the parent's own copy — close-only, NEVER LOCK_UN. The parent is
//     then structurally unable to drop the child's lock (this is the proven
//     escape from the shared-OFD LOCK_UN failure that sank the naive
//     inherited-flock design).
//
// If Start itself fails, the parent is still the only holder of the owner
// description, so closing it here releases the lock cleanly (no child ever
// existed).
func (g *ocSpawnGuard) startChildWithOwner(bin string, port int, workspace string, extraW ...io.Writer) (*exec.Cmd, error) {
	extra, err := g.takeOwnerForChild()
	if err != nil {
		// Surface who owns the slot (live opencode or a retaining
		// descendant) — the operator's actionable detail.
		var holders []string
		for _, h := range ocOwnerLockHolders() {
			holders = append(holders, h.String())
		}
		if len(holders) > 0 {
			err = fmt.Errorf("%v; current holders: %s", err, strings.Join(holders, ", "))
		}
		return nil, fmt.Errorf("acquire owner lock for child: %v", err)
	}
	cmd, err := startOpenCodeServeDetached(bin, port, workspace, extra, extraW...)
	if err != nil {
		g.closeParentOwnerCopy() // no child exists: closing releases cleanly
		return nil, err
	}
	if !g.childRetainsOwner(cmd.Process.Pid) {
		// Fail closed: kill the unowned child, then drop our copy (the
		// child's references die with it). Never retry — a second attempt
		// could race another starter into the now-free slot beside a
		// not-yet-dead child.
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		g.closeParentOwnerCopy()
		return nil, fmt.Errorf("child pid %d did not retain the owner lock fd (fd 3 → %s); upstream opencode may now close stray fds — refusing to spawn unowned", cmd.Process.Pid, g.ownerPathForLog())
	}
	g.closeParentOwnerCopy()
	return cmd, nil
}
