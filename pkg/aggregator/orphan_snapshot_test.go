package aggregator

// orphan_snapshot_test.go — archive-defect-chain Slice 2 DEFER p2-arch-defer-001
// (closed): the aggregator-level integration test proving the
// snapshot → sweep → flag wiring end-to-end through a real fake-OpenCode HTTP
// exchange, not just the Store.
//
// Slice 1 added the Store primitives (RefreshArchivedSnapshot →
// sweepOrphansLocked → sessionEntry.orphan, read by IsOrphanFlagged) and wired
// them into the aggregator's hydrate (hydration.go: ArchivedSnapshot run step)
// and 5s reconcile (reconciliation.go). The unit tests in pkg/state prove each
// primitive in isolation; THIS test proves the aggregator actually drives the
// fetch (ListArchivedSessions / /session?archived=true) → snapshot rebuild →
// sweep → flag, so a straggler whose parent was archived is surfaced without any
// direct Store manipulation.

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// TestHydrateFlagsOrphanViaArchivedSnapshot is the end-to-end RT2 wiring proof:
// after the parent "demo" is archived (excluded from /session, present in
// /session?archived=true), a FRESH aggregator hydrate must flag its live child
// "sub" (parentID=demo) as an orphan — the snapshot (rebuilt from the archived
// fetch) is the authority, the sweep sets the flag, and IsOrphanFlagged reads it.
// Also pins RT3: an unrelated live root ("other") is NOT flagged.
func TestHydrateFlagsOrphanViaArchivedSnapshot(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	// Archive the "demo" parent via the native PATCH (sets time.archived in the
	// fake, mirroring real OpenCode). "sub" (parentID=demo) stays live and
	// un-archived, so it remains in /session — the straggler.
	ts := time.Now().UnixMilli()
	patchBody := fmt.Sprintf(`{"time":{"archived":%d}}`, ts)
	req, err := http.NewRequest(http.MethodPatch, oc.URL+"/session/demo", strings.NewReader(patchBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("archive demo: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("archive demo: expected 200, got %d", resp.StatusCode)
	}

	// Fresh aggregator (daemon-restart simulation): hydrate fetches /session
	// (sub live; demo excluded as archived) then /session?archived=true (demo),
	// rebuilds the snapshot, and sweeps. The straggler "sub" must be flagged.
	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed() // drain the async cold-seed before the server tears down

	// RT2 wiring crux: the live child of an archived parent is flagged via the
	// aggregator-driven snapshot→sweep, with no direct Store manipulation.
	if !agg.Store().IsOrphanFlagged("sub") {
		t.Errorf("integration RT2: sub should be flagged orphan after demo archived (snapshot→sweep→flag via aggregator hydrate)")
	}
	// RT3 wiring: an unrelated LIVE root is NEVER flagged (e88f19e gate).
	if agg.Store().IsOrphanFlagged("other") {
		t.Errorf("integration RT3: live root 'other' should NOT be flagged orphan")
	}
}
