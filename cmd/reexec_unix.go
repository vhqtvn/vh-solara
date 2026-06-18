//go:build !windows

package cmd

import (
	"os"
	"syscall"
)

// execSelf replaces the current process image with a fresh copy of the binary
// (picks up a self-update), keeping the same PID. Never returns on success.
func execSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}
