package state

import "testing"

// TestBusyDiag pins Store.BusyDiag's contract: it reports RunningRoots +
// RootCount consistent with the public accessors, lists busy root ids, and
// surfaces every live session's activity + subtreeBusy contribution. It reads
// the SAME index RunningRoots derives from (subtreeBusyCount), so the two can
// never disagree — the load-bearing property for the one-query phantom
// diagnostic.
func TestBusyDiag(t *testing.T) {
	s := New(100)
	defer s.Close()

	// Empty store: 0 running, 0 roots, non-nil slices.
	snap := s.BusyDiag()
	if snap.RunningRoots != 0 || snap.RootCount != 0 {
		t.Fatalf("empty store: runningRoots=%d rootCount=%d, want 0/0", snap.RunningRoots, snap.RootCount)
	}
	if snap.BusyRootIDs == nil || snap.Sessions == nil {
		t.Fatalf("empty store: BusyRootIDs/Sessions should be non-nil (stable JSON shape), got %+v", snap)
	}

	// Root R with busy child C under it.
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("C", "R")))
	s.Apply(ev("session.status", evStatus("C", "busy")))

	snap = s.BusyDiag()
	if snap.RunningRoots != s.RunningRoots() {
		t.Fatalf("BusyDiag.RunningRoots=%d != Store.RunningRoots()=%d", snap.RunningRoots, s.RunningRoots())
	}
	if snap.RootCount != s.RootCount() {
		t.Fatalf("BusyDiag.RootCount=%d != Store.RootCount()=%d", snap.RootCount, s.RootCount())
	}
	if snap.RunningRoots != 1 || len(snap.BusyRootIDs) != 1 || snap.BusyRootIDs[0] != "R" {
		t.Fatalf("busy child under R: runningRoots=%d busyRootIds=%v, want 1/[R]", snap.RunningRoots, snap.BusyRootIDs)
	}
	// Both sessions surfaced; C is busy (subtreeBusy>=1), R aggregates it.
	byID := map[string]BusyDiagSession{}
	for _, ds := range snap.Sessions {
		byID[ds.ID] = ds
	}
	if c, ok := byID["C"]; !ok {
		t.Fatalf("BusyDiag missing session C: %+v", snap.Sessions)
	} else if c.Activity != "busy" || c.SubtreeBusy < 1 || c.IsRoot {
		t.Fatalf("session C: want activity=busy subtreeBusy>=1 isRoot=false, got %+v", c)
	}
	if r, ok := byID["R"]; !ok {
		t.Fatalf("BusyDiag missing session R: %+v", snap.Sessions)
	} else if !r.IsRoot || r.SubtreeBusy < 1 {
		t.Fatalf("session R: want isRoot=true subtreeBusy>=1, got %+v", r)
	}
}
