package web

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/procmgr"
)

// writeManagedConfig writes a .vh-solara/project.jsonc into root and returns root.
func writeManagedConfig(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".vh-solara"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "project.jsonc"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func newTestOrchestrator(t *testing.T) (*Orchestrator, *procmgr.Manager) {
	t.Helper()
	mgr := procmgr.NewManager(context.Background())
	trust := NewTrustStoreAt(t.TempDir())
	views := newViewRegistry()
	o := NewOrchestrator(mgr, trust, views, "")
	return o, mgr
}

const sleepConfig = `{
  // a managed project
  "processes": [
    { "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }
  ],
  "views": [
    { "id": "svc", "path_prefix": "/svc", "upstream": "tcp:127.0.0.1:9", "depends_on": "svc" }
  ]
}`

func TestOrchestrator_UntrustedThenGrant(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	// 1. Open while untrusted → awaiting-trust, nothing started.
	o.OpenProject(root)
	snap := o.Snapshot(root)
	if snap.State != StateAwaitTrust {
		t.Fatalf("after open: state=%s want awaiting-trust", snap.State)
	}
	if len(snap.Processes) != 0 {
		t.Fatalf("untrusted should not start processes, got %d", len(snap.Processes))
	}
	if snap.Review == nil {
		t.Fatal("review payload should be present when untrusted")
	}

	// 2. Grant → trusted, process started, view registered.
	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	snap = o.Snapshot(root)
	if snap.State != StateTrusted {
		t.Fatalf("after grant: state=%s want trusted", snap.State)
	}
	waitFor(t, func() bool {
		st, _ := mgr.Status(root, "svc")
		return st.Status.IsRunning()
	}, "process running after grant");

	// View should be registered (origin=managed).
	v := o.views.match("/svc")
	if v == nil || v.Origin != OriginManaged || v.Dir != root {
		t.Fatalf("managed view not registered: %+v", v)
	}
	if got := snap.Views[0].Status; got != ViewRegistered {
		t.Fatalf("view status=%s want registered", got)
	}
}

func TestOrchestrator_PrefixConflictNonFatal(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	// Pre-register a MANUAL view on the same prefix.
	manual := &viewReg{ID: "manual-svc", Title: "manual", PathPrefix: "/svc", Upstream: "tcp:127.0.0.1:9", Origin: OriginManual}
	if err := o.views.put(manual); err != nil {
		t.Fatal(err)
	}

	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	// Process still runs (non-fatal).
	waitFor(t, func() bool {
		st, _ := mgr.Status(root, "svc")
		return st.Status.IsRunning()
	}, "process should still run despite view conflict");

	// View marked prefix-conflict; manual view untouched.
	snap := o.Snapshot(root)
	if got := snap.Views[0].Status; got != ViewPrefixConflict {
		t.Fatalf("view status=%s want prefix-conflict", got)
	}
	v := o.views.match("/svc")
	if v == nil || v.Origin != OriginManual {
		t.Fatalf("manual view should remain registered, got %+v", v)
	}
}

func TestOrchestrator_NoConfigIsNoop(t *testing.T) {
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()
	root := t.TempDir() // no .vh-solara/project.jsonc
	o.OpenProject(root)
	snap := o.Snapshot(root)
	if snap.State != StateNone {
		t.Fatalf("state=%s want none", snap.State)
	}
}

// TestOrchestrator_AutoTrustGrantsOnOpen covers the --trust-on-open /
// VH_TRUST_CONFIG escape hatch: an autoTrust orchestrator approves the config
// on open without an explicit Grant, persists the grant, and starts the process.
func TestOrchestrator_AutoTrustGrantsOnOpen(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig)
	mgr := procmgr.NewManager(context.Background())
	defer mgr.StopAll()
	trust := NewTrustStoreAt(t.TempDir())
	o := NewOrchestrator(mgr, trust, newViewRegistry(), "")
	o.autoTrust = true

	o.OpenProject(root)
	snap := o.Snapshot(root)
	if snap.State != StateTrusted {
		t.Fatalf("autoTrust: state=%s want trusted (no explicit grant)", snap.State)
	}
	if !trust.IsTrusted(root, snap.ConfigHash) {
		t.Fatal("autoTrust should have persisted the grant")
	}
	waitFor(t, func() bool {
		st, _ := mgr.Status(root, "svc")
		return st.Status.IsRunning()
	}, "process running after auto-trust")
}

// TestOrchestrator_ConfigChangeReGates covers the changed path: after a config
// is approved, editing it makes a fresh orchestrator (shared trust store, empty
// cache — i.e. a daemon restart) re-gate as "changed" until re-approved.
func TestOrchestrator_ConfigChangeReGates(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig)
	trustDir := t.TempDir()

	// First "daemon lifetime": open + approve config V1.
	mgr1 := procmgr.NewManager(context.Background())
	defer mgr1.StopAll()
	o1 := NewOrchestrator(mgr1, NewTrustStoreAt(trustDir), newViewRegistry(), "")
	o1.OpenProject(root)
	if err := o1.Grant(root); err != nil {
		t.Fatal(err)
	}
	hashV1 := o1.Snapshot(root).ConfigHash

	// Edit the config (V2) → different command, different hash.
	changed := strings.Replace(sleepConfig, "sleep 60", "sleep 90", 1)
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "project.jsonc"), []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}

	// Second "daemon lifetime": fresh cache, SAME persisted trust store → the new
	// hash no longer matches the approved one.
	mgr2 := procmgr.NewManager(context.Background())
	defer mgr2.StopAll()
	o2 := NewOrchestrator(mgr2, NewTrustStoreAt(trustDir), newViewRegistry(), "")
	o2.OpenProject(root)
	snap := o2.Snapshot(root)
	if snap.State != StateChanged {
		t.Fatalf("after config change: state=%s want changed", snap.State)
	}
	if snap.ConfigHash == hashV1 {
		t.Fatal("config hash should differ after edit")
	}
	if snap.Review == nil {
		t.Fatal("review payload should re-appear after a change")
	}

	// Re-approve V2 → trusted again, process started.
	if err := o2.Grant(root); err != nil {
		t.Fatal(err)
	}
	if snap = o2.Snapshot(root); snap.State != StateTrusted {
		t.Fatalf("after re-grant: state=%s want trusted", snap.State)
	}
}
