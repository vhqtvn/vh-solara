//go:build windows

package cmd

import "errors"

// execSelf isn't available on Windows; callers fall back to spawn-then-exit.
func execSelf() error { return errors.New("exec self not supported on windows") }
