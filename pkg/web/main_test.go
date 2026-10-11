package web

import (
	"os"
	"testing"
)

// TestMain isolates the ENTIRE package from the operator's real user-config
// state. stateBaseDir() (notes.go) grounds worker-wide persistence —
// pins.json, named-layouts.json, per-project labels stores, the one-time
// labels migration, notes — at $VH_STATE_DIR when set, else
// os.UserConfigDir()/vh-solara. Most tests here build a real Server via
// NewServer without pinning VH_STATE_DIR, so a bare `go test ./pkg/web` on a
// dev machine would otherwise read the operator's real pins.json /
// named-layouts.json and run the labels migration against the real config
// dir (its completion marker is written unconditionally, and a real legacy
// labels.json would be partitioned and removed).
//
// The default below redirects that root to a fresh per-run temp dir ONLY
// when VH_STATE_DIR is unset or empty — an explicitly pinned env (CI, an
// operator, a focused local run) keeps control. Per-test
// t.Setenv("VH_STATE_DIR", ...) still wins: it mutates the process env for
// that test's duration after this default is installed, and no test in this
// package runs parallel (verified), so there is no cross-test env race.
func TestMain(m *testing.M) {
	if cur := os.Getenv("VH_STATE_DIR"); cur != "" {
		os.Exit(m.Run())
	}
	dir, err := os.MkdirTemp("", "vh-web-test-state-")
	if err != nil {
		// Without a state root the package would fall back to the
		// operator's real user-config dir — refuse to run rather than
		// risk touching it.
		os.Stderr.WriteString("pkg/web TestMain: cannot create isolated VH_STATE_DIR temp dir: " + err.Error() + "\n")
		os.Exit(1)
	}
	os.Setenv("VH_STATE_DIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
