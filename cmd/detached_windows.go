//go:build windows

package cmd

import "os/exec"

// setDetachedAttrs is a no-op on Windows; the tracked *exec.Cmd in KillFunc
// handles graceful shutdown.
func setDetachedAttrs(cmd *exec.Cmd) {}
