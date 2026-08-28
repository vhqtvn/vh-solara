//go:build linux

package cmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// ocSpawnGuard holds the STARTER-role lock for one detached-start
// transaction. The zero value is never used — acquireOCSpawnGuard is the only
// constructor.
type ocSpawnGuard struct {
	starterFD   int
	starterPath string
	ownerPath   string
	ownerFile   *os.File // non-nil only between takeOwnerForChild and closeParentOwnerCopy
}

// acquireOCSpawnGuard takes the per-project starter lock non-blocking. It
// returns (guard, ocLockAcquired, "") on success; on contention it returns
// (nil, ocLockContended, reason) IMMEDIATELY — a loser must never block on
// the winner's classification/readiness budget.
func acquireOCSpawnGuard() (*ocSpawnGuard, ocLockVerdict, string) {
	starterPath := ocSpawnLockPath()
	fd, err := syscall.Open(starterPath, syscall.O_RDWR|syscall.O_CREAT|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, ocLockError, fmt.Sprintf("open starter lock %s: %v", starterPath, err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = syscall.Close(fd)
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ocLockContended, fmt.Sprintf("starter lock %s is held by another detached-OpenCode starter", starterPath)
		}
		return nil, ocLockError, fmt.Sprintf("flock starter lock %s: %v", starterPath, err)
	}
	return &ocSpawnGuard{
		starterFD:   fd,
		starterPath: starterPath,
		ownerPath:   ocOwnerLockPath(),
	}, ocLockAcquired, ""
}

// Release drops the starter lock. Idempotent. It never touches the owner
// lock: by the time Release runs in normal operation the parent no longer
// holds any owner fd (startChildWithOwner closed it), and the child's lock
// must survive everything the parent does.
func (g *ocSpawnGuard) Release() {
	if g == nil || g.starterFD < 0 {
		return
	}
	_ = syscall.Flock(g.starterFD, syscall.LOCK_UN)
	_ = syscall.Close(g.starterFD)
	g.starterFD = -1
	// Defensive: if the parent still holds an untaken-back owner fd (spawn
	// never reached Start), closing it releases the lock — correct, since no
	// child ever received it. This is a close, never a LOCK_UN on a
	// description the child shares.
	if g.ownerFile != nil {
		_ = g.ownerFile.Close()
		g.ownerFile = nil
	}
}

// ocOwnerLockHeldByOthers reports whether some OTHER open file description
// holds the owner lock — i.e. a live opencode (or a descendant that retained
// its fd 3) still owns the spawn slot. Caller must not itself hold the owner
// fd (the transaction only calls this before takeOwnerForChild, and flock
// denial does not distinguish holders).
func ocOwnerLockHeldByOthers() bool {
	path := ocOwnerLockPath()
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		// Unopenable owner lock path: report held (fail closed — never spawn
		// when ownership cannot be established).
		return true
	}
	defer syscall.Close(fd)
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true // held (EWOULDBLOCK/EAGAIN) or otherwise undeterminable
	}
	_ = syscall.Flock(fd, syscall.LOCK_UN)
	return false
}

// ocOwnerLockHolders scans /proc for processes holding an fd that resolves to
// the owner lock file — the discoverable set of owners when the slot is
// orphaned (opencode dead, descendant alive). Best-effort: entries that
// cannot be read are skipped; an unscannable /proc yields an empty list.
func ocOwnerLockHolders() []ocLockHolder {
	ownerPath := ocOwnerLockPath()
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var holders []ocLockHolder
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue // numeric proc dirs only; never report the caller itself
		}
		fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, fd.Name()))
			if err != nil || link != ownerPath {
				continue
			}
			cmdline := ""
			if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil {
				cmdline = strings.ReplaceAll(string(b), "\x00", " ")
				cmdline = strings.TrimSpace(cmdline)
			}
			holders = append(holders, ocLockHolder{PID: pid, Cmdline: cmdline})
			break // one matching fd per process is enough
		}
	}
	return holders
}

// takeOwnerForChild opens the owner lock WITHOUT O_CLOEXEC and flocks it
// exclusively before fork, so the child's fd 3 refers to an already-locked
// description. The returned slice is the exec.Cmd.ExtraFiles payload.
func (g *ocSpawnGuard) takeOwnerForChild() ([]*os.File, error) {
	fd, err := syscall.Open(g.ownerPath, syscall.O_RDWR|syscall.O_CREAT, 0o600) // no O_CLOEXEC
	if err != nil {
		return nil, fmt.Errorf("open owner lock %s: %v", g.ownerPath, err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("flock owner lock %s: %v (slot owned by a live opencode or a retaining descendant?)", g.ownerPath, err)
	}
	g.ownerFile = os.NewFile(uintptr(fd), filepath.Base(g.ownerPath))
	return []*os.File{g.ownerFile}, nil
}

// childRetainsOwner verifies the just-started child still holds the owner
// lock fd (fd 3 → the owner lock file). os/exec dups ExtraFiles into place
// before exec and Start() returns only once exec succeeded, so a missing link
// here means the exec'd program itself closed the stray fd — the documented
// upstream-risk case that must fail closed.
func (g *ocSpawnGuard) childRetainsOwner(pid int) bool {
	link, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/3", pid))
	return err == nil && link == g.ownerPath
}

// closeParentOwnerCopy drops the parent's only reference to the owner
// description — CLOSE ONLY, never LOCK_UN. After this call the parent is
// structurally unable to affect the child's lock.
func (g *ocSpawnGuard) closeParentOwnerCopy() {
	if g.ownerFile != nil {
		_ = g.ownerFile.Close()
		g.ownerFile = nil
	}
}

// ownerPathForLog surfaces the owner lock path in failure messages.
func (g *ocSpawnGuard) ownerPathForLog() string { return g.ownerPath }
