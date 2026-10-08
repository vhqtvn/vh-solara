//go:build linux

package web

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// custodyLockAcquire takes the per-project queue-custody flock
// (LOCK_EX|LOCK_NB) on path, creating the file if absent. The lock belongs
// to the returned open file DESCRIPTION: the kernel releases it when every
// fd of that description closes — including on process death, which is the
// crash-recovery primitive (a crashed daemon leaves the lock simply free; a
// second live daemon — or a second open in the SAME process — is refused
// with EWOULDBLOCK, mapped to errQueueCustodyHeld).
//
// Linux-only by design (the certified matrix, AMEND-A1): non-Linux platforms
// compile the fail-closed stub in queue_custody_other.go instead.
func custodyLockAcquire(path string) (custodyLock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_CLOEXEC, 0o644)
	if err != nil {
		return nil, fmt.Errorf("queue custody: open lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w: %s", errQueueCustodyHeld, path)
		}
		return nil, fmt.Errorf("queue custody: flock %s: %w", path, err)
	}
	return &custodyFlock{f: f}, nil
}

// custodyFlock is the held-flock implementation of custodyLock. Release
// closes the file, which drops the lock (close releases flock; an explicit
// LOCK_UN would also race with a waiting acquirer's FD reuse — close-only is
// the disciplined form, mirroring the cmd/ spawn-lock owner handoff).
type custodyFlock struct {
	f *os.File
}

func (l *custodyFlock) Release() {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
}
