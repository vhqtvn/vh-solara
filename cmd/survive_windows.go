//go:build windows

package cmd

import "os/exec"

// setSurviveAttrs is a best-effort no-op on Windows; survivable detach across a
// daemon restart isn't supported there (the child may exit with the daemon).
func setSurviveAttrs(cmd *exec.Cmd) {}
