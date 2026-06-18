//go:build linux

package cmd

import (
	"os/exec"
	"syscall"
)

// setDetachedAttrs puts the child in its own process group and asks the kernel
// to signal it (SIGTERM) when the daemon dies, so it never gets orphaned.
func setDetachedAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGTERM,
	}
}
