package e2e

// coldload_boundary_demand_test.go — Part-B behavioral crux: a cold-opened
// session with >WindowMaxCount messages pages its OLDER history via the
// boundary-demand path (GET /vh/session/:id/messages?before=<anchor> → handler
// D-trigger → EnsureOlderMessages → Client.MessagesBefore(cursor) →
// Store.MergeOlderMessages → re-project), WITHOUT reconnect.
//
// Flow:
//  1. Seed a session with WindowMaxCount+50 chronological messages (each with
//     info.time.created so the backward cursor works).
//  2. GET /vh/snapshot?sessions=<sid> — handleSnapshot's ensureMessages runs the
//     BOUNDED cold-load (MessagesTail(WindowMaxCount)) → resident = newest 100.
//  3. GET /vh/session/<sid>/messages?before=<oldest-resident> — the boundary is
//     resident but nothing older is; the D-trigger fires (not count/byte limited,
//     not historyExhausted) → EnsureOlderMessages fetches the older page via the
//     cursor → MergeOlderMessages prepends it → the response carries the older
//     page paged back to cm1.
//
// Asserts the DoD crux: older history is natively accessible via boundary-demand.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

func TestColdLoadBoundaryDemandPagesOlderHistory(t *testing.T) {
	c, err := StartCluster()
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	defer c.Close()
	const dir = "/work/demo" // fixtures.DemoDir()
	const sid = "bigcursor"
	n := state.WindowMaxCount + 50 // 150 > WindowMaxCount (100)
	c.Fake.SeedChronologicalMessages(sid, n)

	// 1. Bounded cold-load: poll the snapshot until bigcursor is ADMITTED (the
	//    aggregator's hydrate picks up the seeded session — it runs after
	//    StartCluster, so the first GET(s) may no-op until then) AND LOADED
	//    (ensureMessages → EnsureMessages → MessagesTail(WindowMaxCount)).
	//    projectScopedFilter drops a not-yet-admitted ?sessions= id, so we poll
	//    gate.messagesLoaded rather than assuming the first GET loads it.
	snapURL := c.WorkerVHURL + "/vh/snapshot?dir=" + url.QueryEscape(dir) + "&sessions=" + sid
	loadedDeadline := time.Now().Add(20 * time.Second)
	loaded := false
	for time.Now().Before(loadedDeadline) {
		r, err := http.Get(snapURL)
		if err != nil {
			t.Fatalf("snapshot GET: %v", err)
		}
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		var snapJSON map[string]any
		if json.Unmarshal(body, &snapJSON) == nil {
			if gate, ok := snapJSON["gate"].(map[string]any); ok {
				if g, ok := gate[sid].(map[string]any); ok {
					if ml, _ := g["messagesLoaded"].(bool); ml {
						loaded = true
						break
					}
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !loaded {
		t.Fatalf("session %s not admitted+loaded within 20s (hydrate/projectScopedFilter)", sid)
	}
	// Resident is now the bounded newest WindowMaxCount: cm{n-WindowMaxCount+1}..cm{n}.
	// (The bound is pinned by coldload_bounded_guard_test in pkg/aggregator; the
	// boundary-demand below implicitly validates it — if unbounded, the oldest
	// resident would not be cm{n-WindowMaxCount+1}.)

	// 2. Boundary-demand: page backward from the oldest resident. After the
	//    bounded cold-load the oldest resident is cm{n-WindowMaxCount+1}.
	oldestResident := fmt.Sprintf("cm%d", n-state.WindowMaxCount+1)
	pageURL := c.WorkerVHURL + "/vh/session/" + sid + "/messages?before=" + oldestResident + "&dir=" + url.QueryEscape(dir)
	deadline := time.Now().Add(5 * time.Second)
	var page struct {
		Items       []struct {
			Info struct {
				ID string `json:"id"`
			} `json:"info"`
		} `json:"items"`
		OldestID      string `json:"oldest_id"`
		BoundaryFound bool   `json:"boundary_found"`
		HasOlder      bool   `json:"has_older"`
	}
	// The boundary-demand triggers an ASYNC EnsureOlderMessages fetch + merge +
	// re-project inside the handler; retry briefly until the older page lands.
	for time.Now().Before(deadline) {
		r, err := http.Get(pageURL)
		if err != nil {
			t.Fatalf("boundary-demand GET: %v", err)
		}
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		_ = json.Unmarshal(body, &page)
		if len(page.Items) > 1 {
			break // older page landed
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 3. CRUX — the boundary-demand paged the older history back to cm1.
	if !page.BoundaryFound {
		t.Fatalf("boundary_found: want true (anchor %s resident), got false", oldestResident)
	}
	if len(page.Items) <= 1 {
		t.Fatalf("CRUX FAIL: boundary-demand must return the older page (older history natively accessible); got %d items — D-trigger/EnsureOlderMessages did not fire or merge", len(page.Items))
	}
	if page.OldestID != "cm1" {
		t.Fatalf("oldest_id: want cm1 (paged back to the transcript start via boundary-demand); got %q", page.OldestID)
	}
	t.Logf("CRUX PASS: boundary-demand paged older history — %d items, oldest=%s (paged from %s back to cm1 without reconnect)", len(page.Items), page.OldestID, oldestResident)
	// The fixture returned ≤ WindowMaxCount strictly-older (50 ≤ 100) → no
	// X-Next-Cursor → historyExhausted=true → HasOlder=false (truthful end).
	if page.HasOlder {
		t.Fatalf("has_older: want false (history exhausted after the boundary-demand walk to cm1), got true")
	}
}
