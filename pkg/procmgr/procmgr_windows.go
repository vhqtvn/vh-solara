//go:build windows

package procmgr

import (
	"os"
	"os/exec"
	"syscall"
)

// setProcGroup is a no-op on Windows: there is no setpgid. Teardown falls back
// to terminating the process directly (see killGroup). Shell-launched
// grandchildren are not reaped as a group; the daemon's primary target is unix.
func setProcGroup(cmd *exec.Cmd) {}

// killGroup terminates the process on Windows. There is no POSIX signal model,
// so the signal is ignored and the process is force-terminated via Process.Kill
// (the only portable option exec exposes). os.FindProcess never errors on
// Windows for a live pid.
func killGroup(pid int, sig syscall.Signal) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
