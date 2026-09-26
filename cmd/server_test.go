package cmd

import (
	"strings"
	"testing"
)

// TestServerStatusConfigFlag pins the C1 flag reshape: --status-config is
// registered (and rendered in --help usage), and the removed unpushed roster
// flags --status-worker / --status-project are gone.
func TestServerStatusConfigFlag(t *testing.T) {
	f := serverCmd.Flags()
	if f.Lookup("status-config") == nil {
		t.Fatal("--status-config flag not registered on the server command")
	}
	for _, gone := range []string{"status-worker", "status-project"} {
		if f.Lookup(gone) != nil {
			t.Fatalf("flag --%s must be removed (replaced by --status-config)", gone)
		}
	}
	usage := f.FlagUsages()
	if !strings.Contains(usage, "--status-config") {
		t.Fatalf("--help usage must render --status-config, got:\n%s", usage)
	}
	if !strings.Contains(usage, "fleet-status config") {
		t.Fatalf("--status-config usage must say what it selects, got:\n%s", usage)
	}
}
