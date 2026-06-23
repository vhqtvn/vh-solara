//go:build !windows

package procmgr

import (
	"os/exec"
	"syscall"
)

// setProcGroup puts the child in its own process group so a stop can signal the
// whole group (-pid) and reap shell-launched grandchildren too. Setpgid makes
// cmd.Process.Pid the group id.
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killGroup sends sig to the process group -pid (negative pid = group).
func killGroup(pid int, sig syscall.Signal) error {
	return syscall.Kill(-pid, sig)
}
