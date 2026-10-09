package cmd

// --daemon-dispatch wiring tests for the client daemon's --web=vh mode
// (send-net-resilience follow-up: the operator runs `client-daemon --web vh`
// behind the controller proxy, so the flag must reach the SAME daemon-owned
// queue-dispatch capability local-server exposes).
//
// setupVHMode itself is too heavy for a unit test (it spawns/attaches a real
// OpenCode serve), so — per the established boot-seam pattern
// (opencode_start_test.go) — the decision is extracted into
// wireDaemonDispatch(flagSet, external) and proven here at the exact seam
// production calls it. The cobra binding (flag string → package var) is
// proven through the real flag set.

import (
	"bytes"
	"log"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/web"
)

// withDaemonDispatchFlag swaps the client-daemon --daemon-dispatch global for
// a test (the wiring seam reads it; tests restore it).
func withDaemonDispatchFlag(t *testing.T, v bool) {
	t.Helper()
	old := daemonDaemonDispatch
	daemonDaemonDispatch = v
	t.Cleanup(func() { daemonDaemonDispatch = old })
}

// resetDaemonDispatchCapability restores the production-default OFF posture
// around each capability test.
func resetDaemonDispatchCapability(t *testing.T) {
	t.Helper()
	web.SetDaemonDispatchEnabled(false)
	t.Cleanup(func() { web.SetDaemonDispatchEnabled(false) })
}

// TestClientDaemonDispatchFlagRegistered: the flag exists on clientDaemonCmd
// in the (vh only) group's namespace, defaults OFF, and its cobra binding
// threads Set("true") into daemonDaemonDispatch — the package var setupVHMode
// reads. This is the flag→wiring half of the threading proof.
func TestClientDaemonDispatchFlagRegistered(t *testing.T) {
	fl := clientDaemonCmd.Flags().Lookup("daemon-dispatch")
	if fl == nil {
		t.Fatal("client-daemon has no --daemon-dispatch flag — the (vh only) group must expose the daemon-dispatch opt-in")
	}
	if fl.Value.Type() != "bool" {
		t.Fatalf("--daemon-dispatch type = %q, want bool", fl.Value.Type())
	}
	if fl.DefValue != "false" {
		t.Fatalf("--daemon-dispatch default = %q, want \"false\" (production default OFF everywhere)", fl.DefValue)
	}
	withDaemonDispatchFlag(t, false)
	if err := fl.Value.Set("true"); err != nil {
		t.Fatal(err)
	}
	if !daemonDaemonDispatch {
		t.Fatal("Set(\"true\") on --daemon-dispatch did not flip daemonDaemonDispatch — the flag is not bound to the var the vh mode reads")
	}
}

// TestWireDaemonDispatchEnablesCapability: flag ON + a spawned/detached
// (non-external) OpenCode topology enables the capability — the client-daemon
// operator behind the controller proxy gets the same daemon-owned,
// custody-fenced dispatch local-server's flag provides.
func TestWireDaemonDispatchEnablesCapability(t *testing.T) {
	resetDaemonDispatchCapability(t)
	if got := wireDaemonDispatch(true, false); !got {
		t.Fatal("wireDaemonDispatch(flag=on, external=false) = false, want true (spawned/detached topologies enable normally)")
	}
	if !web.DaemonDispatchEnabled() {
		t.Fatal("web.DaemonDispatchEnabled() = false after wireDaemonDispatch(flag=on, external=false) — the opt-in did not thread to the capability")
	}
}

// TestWireDaemonDispatchRefusedExternal: flag ON + external OpenCode
// (--opencode-url) is REFUSED — no enable, and the operator-visible
// explanation says why (the restart causality barrier is not certified for
// an externally-managed OpenCode; dispatch stays browser-owned).
func TestWireDaemonDispatchRefusedExternal(t *testing.T) {
	resetDaemonDispatchCapability(t)
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)
	if got := wireDaemonDispatch(true, true); got {
		t.Fatal("wireDaemonDispatch(flag=on, external=true) = true, want false (the external topology must be refused)")
	}
	if web.DaemonDispatchEnabled() {
		t.Fatal("web.DaemonDispatchEnabled() = true after the refused external wiring — dispatch must stay browser-owned")
	}
	if !strings.Contains(buf.String(), "restart causality barrier") {
		t.Fatalf("external refusal log = %q, want the restart-causality-barrier explanation", buf.String())
	}
}

// TestWireDaemonDispatchFlagOffNoop: flag OFF never enables — the production
// default keeps the legacy browser claim/POST/resolve path byte-equivalent.
func TestWireDaemonDispatchFlagOffNoop(t *testing.T) {
	resetDaemonDispatchCapability(t)
	if got := wireDaemonDispatch(false, false); got {
		t.Fatal("wireDaemonDispatch(flag=off, external=false) = true, want false")
	}
	if web.DaemonDispatchEnabled() {
		t.Fatal("web.DaemonDispatchEnabled() = true with the flag off — the default posture must stay OFF")
	}
}
