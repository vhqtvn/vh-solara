package state

import (
	"encoding/json"
	"testing"
	"time"
)

// This file tests Phase 6 Gate E — the versioned cutoff.
//
// Gate E anti-thrash guarantee: demotion happens ONLY at snapshot construction
// time (initial/promotion/reconnect). There are NO timer-driven demotion events.
// The 15s ping ticker in handleStream stays ping-only. This means a session
// active every 9:59 (just under the 10min cutoff) never gets demoted between
// activity bursts, because no snapshot is constructed between bursts.
//
// The cutoff is versioned: cutoffVersion (monotonic policy version) + cutoffMs
// (duration in milliseconds). Both are stamped in every projected snapshot so
// the client can detect a boundary change.

// --- Cutoff stamping ---

func TestSnapshotProjected_StampsCutoff(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))

	snap := s.SnapshotProjected(nil, "initial", false)
	if !snap.Projected {
		t.Fatal("SnapshotProjected should set Projected=true")
	}
	if snap.CutoffVersion != projectionCutoffVersion {
		t.Errorf("CutoffVersion = %d, want %d", snap.CutoffVersion, projectionCutoffVersion)
	}
	wantMs := uint64(defaultProjectionCutoff.Milliseconds())
	if snap.CutoffMs != wantMs {
		t.Errorf("CutoffMs = %d, want %d (10min = 600000ms)", snap.CutoffMs, wantMs)
	}
	if wantMs != 600000 {
		t.Errorf("default cutoff = %v, expected 10min (600000ms)", defaultProjectionCutoff)
	}
}

func TestSnapshotBranch_StampsCutoff(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"root","title":"c1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"root","title":"c2"}}`))

	snap, _ := s.SnapshotBranch("root", "", 10)
	if !snap.Projected {
		t.Fatal("SnapshotBranch should set Projected=true")
	}
	if snap.CutoffVersion != projectionCutoffVersion {
		t.Errorf("CutoffVersion = %d, want %d", snap.CutoffVersion, projectionCutoffVersion)
	}
	wantMs := uint64(defaultProjectionCutoff.Milliseconds())
	if snap.CutoffMs != wantMs {
		t.Errorf("CutoffMs = %d, want %d", snap.CutoffMs, wantMs)
	}
}

// TestSnapshotProjected_CutoffOmittedInAuthorityComplete verifies that
// AUTHORITY_COMPLETE (non-projected) snapshots do NOT stamp cutoff fields.
// Cutoff is only meaningful for projected snapshots.
func TestSnapshotProjected_CutoffOmittedInAuthorityComplete(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))

	snap := s.Snapshot(nil)
	if snap.Projected {
		t.Fatal("non-projected snapshot should not set Projected")
	}
	if snap.CutoffVersion != 0 {
		t.Errorf("non-projected CutoffVersion = %d, want 0 (omitempty)", snap.CutoffVersion)
	}
	if snap.CutoffMs != 0 {
		t.Errorf("non-projected CutoffMs = %d, want 0 (omitempty)", snap.CutoffMs)
	}
}

// --- Anti-thrash: no timer-driven demotion ---

// TestProjection_NoThrash_RecentStaysActive is the core anti-thrash test. A
// session with recent activity (within the cutoff window) should STAY
// materialized across repeated SnapshotProjected calls. It should NOT be
// demoted to a stub between snapshots, because there is no timer event
// triggering demotion — demotion happens ONLY at snapshot construction time
// when the activity is genuinely past the cutoff.
//
// This models the "active-every-9:59" scenario: a session that fires activity
// every 9:59 (just under the 10min cutoff) never gets demoted between bursts.
func TestProjection_NoThrash_RecentStaysActive(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))
	// Fire an activity transition (busy → idle). This sets lastActivityAt to
	// ~now and makes the session "recent" within the 10min cutoff.
	s.Apply(ev("session.status", evStatus("root", "busy")))
	s.Apply(ev("session.status", evStatus("root", "idle")))

	// Repeated snapshots: root should STAY materialized (not demoted to stub).
	// Each snapshot recomputes cutoff from time.Now(); within the 10min window,
	// the session's lastActivityAt is After(cutoff) → "recent" → stays active.
	for i := 0; i < 3; i++ {
		snap := s.SnapshotProjected(nil, "promotion", false)
		materialized := sessionIDsFromProjected(t, snap)
		if !materialized["root"] {
			t.Fatalf("snapshot %d: root should be materialized (recent activity within cutoff), got stub", i)
		}
		stubs := stubIDsFromProjected(t, snap)
		if stubs["root"] {
			t.Fatalf("snapshot %d: root should NOT be a stub (anti-thrash: no timer demotion)", i)
		}
	}
}

// TestProjection_CutoffBoundaryDemotesIdle verifies the OTHER side of the
// anti-thrash guarantee: when activity genuinely ages past the cutoff, the
// session IS demoted to a stub at the NEXT snapshot construction. This is the
// correct demotion path (at snapshot time, NOT via a timer event).
//
// We use a very short cutoff (1ms) so the test runs fast: the activity ages
// past the cutoff in 2ms, and the next SnapshotProjected demotes the session.
func TestProjection_CutoffBoundaryDemotesIdle(t *testing.T) {
	savedCutoff := defaultProjectionCutoff
	savedVer := projectionCutoffVersion
	defer func() {
		defaultProjectionCutoff = savedCutoff
		projectionCutoffVersion = savedVer
	}()

	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))
	s.Apply(ev("session.status", evStatus("root", "busy")))
	s.Apply(ev("session.status", evStatus("root", "idle")))

	// With the default 10min cutoff: session is recent → materialized.
	defaultProjectionCutoff = 10 * time.Minute
	projectionCutoffVersion = 1
	snap1 := s.SnapshotProjected(nil, "initial", false)
	materialized1 := sessionIDsFromProjected(t, snap1)
	if !materialized1["root"] {
		t.Fatal("with 10min cutoff: root should be materialized (activity is recent)")
	}

	// Switch to a 1ms cutoff + bump version. Activity ages past cutoff.
	defaultProjectionCutoff = 1 * time.Millisecond
	projectionCutoffVersion = 2
	time.Sleep(2 * time.Millisecond)

	// Next snapshot: root is now idle (activity past cutoff) → demoted to stub.
	snap2 := s.SnapshotProjected(nil, "promotion", false)
	materialized2 := sessionIDsFromProjected(t, snap2)
	if materialized2["root"] {
		t.Fatal("with 1ms cutoff after 2ms: root should be demoted to stub (activity past cutoff)")
	}
	stubs2 := stubIDsFromProjected(t, snap2)
	if !stubs2["root"] {
		t.Fatal("with 1ms cutoff after 2ms: root should appear as a stub")
	}
	// Verify the cutoff fields reflect the new policy.
	if snap2.CutoffVersion != 2 {
		t.Errorf("CutoffVersion = %d, want 2 (bumped)", snap2.CutoffVersion)
	}
	if snap2.CutoffMs != 1 {
		t.Errorf("CutoffMs = %d, want 1 (1ms cutoff)", snap2.CutoffMs)
	}
}

// --- Cutoff change detection ---

// TestProjection_CutoffChangeReflectedInSnapshot verifies that changing the
// cutoff package vars is reflected in the NEXT snapshot's cutoffVersion +
// cutoffMs fields. The client uses cutoffVersion to detect a boundary policy
// change between snapshots.
func TestProjection_CutoffChangeReflectedInSnapshot(t *testing.T) {
	savedCutoff := defaultProjectionCutoff
	savedVer := projectionCutoffVersion
	defer func() {
		defaultProjectionCutoff = savedCutoff
		projectionCutoffVersion = savedVer
	}()

	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))

	// Initial cutoff: version 1, 10min.
	projectionCutoffVersion = 1
	defaultProjectionCutoff = 10 * time.Minute
	snap1 := s.SnapshotProjected(nil, "initial", false)
	if snap1.CutoffVersion != 1 {
		t.Errorf("snap1 CutoffVersion = %d, want 1", snap1.CutoffVersion)
	}
	if snap1.CutoffMs != 600000 {
		t.Errorf("snap1 CutoffMs = %d, want 600000", snap1.CutoffMs)
	}

	// Change cutoff: version 2, 5min.
	projectionCutoffVersion = 2
	defaultProjectionCutoff = 5 * time.Minute
	snap2 := s.SnapshotProjected(nil, "promotion", false)
	if snap2.CutoffVersion != 2 {
		t.Errorf("snap2 CutoffVersion = %d, want 2 (changed)", snap2.CutoffVersion)
	}
	if snap2.CutoffMs != 300000 {
		t.Errorf("snap2 CutoffMs = %d, want 300000 (5min)", snap2.CutoffMs)
	}
}

// --- JSON wire shape ---

// TestSnapshotProjected_CutoffJSONShape verifies the cutoff fields appear in
// the JSON wire shape of a projected snapshot and are absent in AUTHORITY_COMPLETE.
func TestSnapshotProjected_CutoffJSONShape(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))

	// Projected snapshot: cutoffVersion + cutoffMs present.
	psnap := s.SnapshotProjected(nil, "initial", false)
	pdata, _ := json.Marshal(psnap)
	var pmap map[string]any
	json.Unmarshal(pdata, &pmap)
	if pmap["cutoffVersion"] == nil {
		t.Error("projected snapshot JSON should contain cutoffVersion")
	}
	if pmap["cutoffMs"] == nil {
		t.Error("projected snapshot JSON should contain cutoffMs")
	}

	// AUTHORITY_COMPLETE: cutoffVersion + cutoffMs absent (omitempty).
	csnap := s.Snapshot(nil)
	cdata, _ := json.Marshal(csnap)
	var cmap map[string]any
	json.Unmarshal(cdata, &cmap)
	if cmap["cutoffVersion"] != nil {
		t.Error("AUTHORITY_COMPLETE JSON should NOT contain cutoffVersion")
	}
	if cmap["cutoffMs"] != nil {
		t.Error("AUTHORITY_COMPLETE JSON should NOT contain cutoffMs")
	}
}
