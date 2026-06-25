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

// sleepConfig's view has NO depends_on, so it registers immediately on grant
// (these tests exercise trust/namespacing, not readiness gating — see
// TestOrchestrator_ViewDeferredUntilReady for the depends_on path).
const sleepConfig = `{
  // a managed project
  "processes": [
    { "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }
  ],
  "views": [
    { "id": "svc", "path_prefix": "/svc", "upstream": "tcp:127.0.0.1:9" }
  ]
}`

// depConfig's view depends on its process, so the view stays pending until the
// process reaches readiness (here: the default 2 s settle of a live sleep).
const depConfig = `{
  "processes": [
    { "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }
  ],
  "views": [
    { "id": "svc", "path_prefix": "/svc", "upstream": "tcp:127.0.0.1:9", "depends_on": "svc" }
  ]
}`

// TestOrchestrator_ConfigEditReGatesAndKeepsTrustedSpec verifies that editing
// the config while the daemon is up (1) is detected immediately as "changed"
// (no cache pinning it to the old state), and (2) does NOT let a start/restart
// launch the unapproved edit — specFor stays on the trusted, running config.
func TestOrchestrator_ConfigEditReGatesAndKeepsTrustedSpec(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	if snap := o.Snapshot(root); snap.State != StateTrusted {
		t.Fatalf("after grant: state=%s want trusted", snap.State)
	}

	// Edit the config on disk (swap the command) WITHOUT re-approving.
	edited := strings.Replace(sleepConfig, "sleep 60", "sleep 61", 1)
	cfgPath := filepath.Join(root, ".vh-solara", "project.jsonc")
	if err := os.WriteFile(cfgPath, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	// (1) The change is seen immediately — not only after a daemon restart.
	if snap := o.Snapshot(root); snap.State != StateChanged {
		t.Fatalf("after edit: state=%s want changed", snap.State)
	}

	// (2) A start/restart relaunches the APPROVED command, never the edit.
	got := strings.Join(o.specFor(root, "svc").Argv, " ")
	if !strings.Contains(got, "sleep 60") || strings.Contains(got, "sleep 61") {
		t.Fatalf("specFor used unapproved edit: %q", got)
	}
}

// TestOrchestrator_ReapprovalEvictsRemovedView verifies that re-approving a
// config that dropped a view unregisters the removed view's proxy (no stale
// prefix left serving).
func TestOrchestrator_ReapprovalEvictsRemovedView(t *testing.T) {
	twoViews := `{
  "processes": [{ "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }],
  "views": [
    { "id": "a", "path_prefix": "/a", "upstream": "tcp:127.0.0.1:9" },
    { "id": "b", "path_prefix": "/b", "upstream": "tcp:127.0.0.1:9" }
  ]
}`
	oneView := `{
  "processes": [{ "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }],
  "views": [
    { "id": "a", "path_prefix": "/a", "upstream": "tcp:127.0.0.1:9" }
  ]
}`
	root := writeManagedConfig(t, twoViews)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	if o.views.match(managedViewPrefix(root, "/a")) == nil || o.views.match(managedViewPrefix(root, "/b")) == nil {
		t.Fatal("both views should be registered after grant")
	}

	// Drop view "b" on disk, then re-approve.
	cfgPath := filepath.Join(root, ".vh-solara", "project.jsonc")
	if err := os.WriteFile(cfgPath, []byte(oneView), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	if o.views.match(managedViewPrefix(root, "/a")) == nil {
		t.Fatal("view a should still be registered after re-approval")
	}
	if v := o.views.match(managedViewPrefix(root, "/b")); v != nil {
		t.Fatalf("view b should be evicted after re-approval, got %+v", v)
	}

	// Rename "a" → "renamed" while keeping prefix /a: the old id must be evicted
	// BEFORE the new one registers, else /a self-conflicts and serves nothing.
	renamed := `{
  "processes": [{ "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }],
  "views": [
    { "id": "renamed", "path_prefix": "/a", "upstream": "tcp:127.0.0.1:9" }
  ]
}`
	if err := os.WriteFile(cfgPath, []byte(renamed), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	v := o.views.match(managedViewPrefix(root, "/a"))
	if v == nil || v.ID != managedViewKey(root, "renamed") {
		t.Fatalf("/a should be served by the renamed view, got %+v", v)
	}
}

// TestOrchestrator_ViewDeferredUntilReady verifies a depends_on view is NOT
// registered until its process reaches readiness (so it never proxies to a
// not-yet-bound upstream), then registers automatically once ready.
func TestOrchestrator_ViewDeferredUntilReady(t *testing.T) {
	root := writeManagedConfig(t, depConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	// Immediately after grant the process is still starting → view is pending,
	// not yet routable.
	if got := o.Snapshot(root).Views[0].Status; got != ViewPending {
		t.Fatalf("view should be pending before readiness, got %s", got)
	}
	if o.views.match(managedViewPrefix(root, "/svc")) != nil {
		t.Fatal("view must not be registered before its process is ready")
	}
	// Once the process settles to ready, the view registers on its own.
	waitFor(t, func() bool {
		return o.views.match(managedViewPrefix(root, "/svc")) != nil
	}, "dependent view registered after process ready")
	if got := o.Snapshot(root).Views[0].Status; got != ViewRegistered {
		t.Fatalf("view should be registered after readiness, got %s", got)
	}
}

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
	}, "process running after grant")

	// View should be registered (origin=managed) at its per-project namespaced path.
	v := o.views.match(managedViewPrefix(root, "/svc"))
	if v == nil || v.Origin != OriginManaged || v.Dir != root {
		t.Fatalf("managed view not registered: %+v", v)
	}
	if got := snap.Views[0].Status; got != ViewRegistered {
		t.Fatalf("view status=%s want registered", got)
	}
}

// dupPrefixConfig declares two views with the SAME prefix in one project.
const dupPrefixConfig = `{
  "processes": [{ "id": "svc", "command": "/bin/sh -c \"sleep 60\"", "cwd": ".", "restart": "no" }],
  "views": [
    { "id": "v1", "path_prefix": "/dash", "upstream": "tcp:127.0.0.1:9" },
    { "id": "v2", "path_prefix": "/dash", "upstream": "tcp:127.0.0.1:9" }
  ]
}`

// With namespacing, the only way to get a prefix conflict is INTRA-project: two
// views in one config declaring the same prefix. It must be non-fatal (process
// still runs; one view wins, the other is prefix-conflict).
func TestOrchestrator_PrefixConflictNonFatal(t *testing.T) {
	root := writeManagedConfig(t, dupPrefixConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		st, _ := mgr.Status(root, "svc")
		return st.Status.IsRunning()
	}, "process should still run despite view conflict")

	snap := o.Snapshot(root)
	var reg, conflict int
	for _, vw := range snap.Views {
		switch vw.Status {
		case ViewRegistered:
			reg++
		case ViewPrefixConflict:
			conflict++
		}
	}
	if reg != 1 || conflict != 1 {
		t.Fatalf("want 1 registered + 1 conflict, got %+v", snap.Views)
	}
	if o.views.match(managedViewPrefix(root, "/dash")) == nil {
		t.Fatal("the winning view should serve the namespaced /dash")
	}
}

// A managed view and a manual view that declare the SAME prefix do NOT collide:
// managed views live under a per-project namespace, manual views are global.
func TestOrchestrator_ManagedIndependentOfManualSamePrefix(t *testing.T) {
	root := writeManagedConfig(t, sleepConfig) // declares view "svc" at /svc
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	manual := &viewReg{ID: "manual-svc", Title: "manual", PathPrefix: "/svc", Upstream: "tcp:127.0.0.1:9", Origin: OriginManual}
	if err := o.views.put(manual); err != nil {
		t.Fatal(err)
	}
	if err := o.Grant(root); err != nil {
		t.Fatal(err)
	}
	if got := o.Snapshot(root).Views[0].Status; got != ViewRegistered {
		t.Fatalf("managed view should register independently of the manual /svc, got %s", got)
	}
	if v := o.views.match("/svc"); v == nil || v.Origin != OriginManual {
		t.Fatalf("manual /svc should be intact, got %+v", v)
	}
	if v := o.views.match(managedViewPrefix(root, "/svc")); v == nil || v.Origin != OriginManaged {
		t.Fatalf("managed view should serve its namespaced prefix, got %+v", v)
	}
}

// Two different projects declaring the SAME view id and prefix both register,
// independently, at distinct namespaced paths; and each project's view list is
// scoped to itself.
func TestOrchestrator_CrossProjectViewsIndependent(t *testing.T) {
	rootA := writeManagedConfig(t, sleepConfig)
	rootB := writeManagedConfig(t, sleepConfig)
	o, mgr := newTestOrchestrator(t)
	defer mgr.StopAll()

	if err := o.Grant(rootA); err != nil {
		t.Fatal(err)
	}
	if err := o.Grant(rootB); err != nil {
		t.Fatal(err)
	}
	va := o.views.match(managedViewPrefix(rootA, "/svc"))
	vb := o.views.match(managedViewPrefix(rootB, "/svc"))
	if va == nil || vb == nil {
		t.Fatalf("both projects' views should register; a=%v b=%v", va, vb)
	}
	if va.PathPrefix == vb.PathPrefix || va.ID == vb.ID {
		t.Fatalf("cross-project views must be namespaced apart: a=%s/%s b=%s/%s", va.ID, va.PathPrefix, vb.ID, vb.PathPrefix)
	}
	if got := o.Snapshot(rootA).Views[0].Status; got != ViewRegistered {
		t.Fatalf("project A view should be registered, got %s", got)
	}
	if got := o.Snapshot(rootB).Views[0].Status; got != ViewRegistered {
		t.Fatalf("project B view should be registered, got %s", got)
	}
	// listFor(A) must not leak B's managed view.
	for _, vw := range o.views.listFor(rootA) {
		if vw.Origin == OriginManaged && vw.Dir == rootB {
			t.Fatalf("project A's view list leaked project B's managed view: %+v", vw)
		}
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
