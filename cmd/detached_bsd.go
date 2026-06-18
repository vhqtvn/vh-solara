//go:build darwin || freebsd || netbsd || openbsd

package cmd

import (
	"os/exec"
	"syscall"
)

// setDetachedAttrs puts the child in its own process group on the BSDs/macOS.
// Pdeathsig is Linux-only, so on abrupt daemon death the child may be reparented
// to init; graceful shutdown still works via the tracked *exec.Cmd in KillFunc.
func setDetachedAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
