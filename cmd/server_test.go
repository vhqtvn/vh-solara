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

// TestServerNotifyFlags pins the S1 notification wiring flags:
// --notify-store and --notify-fcm-credentials are registered and their
// help text names what each selects (including the honest unset postures).
func TestServerNotifyFlags(t *testing.T) {
	f := serverCmd.Flags()
	for _, name := range []string{"notify-store", "notify-fcm-credentials"} {
		if f.Lookup(name) == nil {
			t.Fatalf("--%s flag not registered on the server command", name)
		}
	}
	usage := f.FlagUsages()
	for _, marker := range []string{
		"--notify-store",
		"push-notification token registry",
		"answer 409",
		"--notify-fcm-credentials",
		"service-account JSON",
		"test-send answers 409",
	} {
		if !strings.Contains(usage, marker) {
			t.Errorf("notify flags usage must contain %q, got:\n%s", marker, usage)
		}
	}
}
