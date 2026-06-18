//go:build !windows

package cmd

import (
	"os/exec"
	"syscall"
)

// setSurviveAttrs detaches the child into its own session (Setsid) so it keeps
// running after the daemon exits — used for the managed-but-survivable OpenCode
// (vh restarts and reconnects to it). No Pdeathsig.
func setSurviveAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
