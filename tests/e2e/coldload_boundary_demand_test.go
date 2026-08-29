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
		Items []struct {
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

// TestColdLoadBoundaryDemandOversizedFloorRemoteHistory is the OF1 crux: an
// OVERSIZED message (two ~600 KiB parts, ~1.2 MiB total > the 1 MiB
// WindowMaxBytes budget) sitting at the resident-floor boundary — the oldest
// message of the bounded cold tail — with REMOTE older history upstream
// (cm1..cm50). Before the remedy both readers were broken at that floor: the
// envelope forced has_older=false (affordance died on first click) and the
// D-trigger's !OversizedItem guard suppressed the remote fetch.
//
// Derived walk (n=150, oversized cm51 = oldest of the newest-100 tail):
//   - cold tail = cm51..cm150 (all resident); the WINDOW projection excludes
//     the oversized cm51 (byte budget) → window oldest_loaded_id = cm52.
//   - Click 1 (before=cm52): sub-case c pair [cm51, cm52]; envelope OR keeps
//     has_older=true; D-trigger must NOT fire (before≠floor) — anti-misfire.
//   - Click 2 (before=cm51==floor): sub-case A projects [cm51] alone, then the
//     D-trigger FIRES — EnsureOlderMessages actually reaches opencode (the
//     fixture's MessagesBefore counter advances; a REAL fetch, not a flipped
//     boolean) — merges cm1..cm50 (50 ≤ 100 → no X-Next-Cursor → exhausted),
//     and the re-projected response is the sub-case B pair [cm50, cm51] with
//     has_older=true (resident-local older beyond the neighbor).
//   - Click 3 (before=cm50): ordinary page down to cm1; exhausted + no limits
//     → has_older=false — the walk settles ONLY at true end-of-history.
//
// Exactly ONE MessagesBefore call across the whole walk (asserted by delta).
func TestColdLoadBoundaryDemandOversizedFloorRemoteHistory(t *testing.T) {
	c, err := StartCluster()
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	defer c.Close()
	const dir = "/work/demo" // fixtures.DemoDir()
	const sid = "bigfloor"
	n := state.WindowMaxCount + 50                          // 150
	oversizedIdx := n - state.WindowMaxCount + 1            // 51: oldest of the newest-100 tail
	c.Fake.SeedOversizedFloorMessages(sid, n, oversizedIdx) // cm51 is the oversized floor

	// 1. Bounded cold-load (same admission poll as the sibling test above).
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

	// The window's oldest_loaded_id is the walk's initial cursor (the same
	// field the SPA reads). It must be cm52 — the window projection EXCLUDED
	// the oversized cm51 by the byte budget (its inclusion would blow 1 MiB),
	// while cm51 stayed resident (the cold tail stored it verbatim).
	r, err := http.Get(snapURL)
	if err != nil {
		t.Fatalf("window snapshot GET: %v", err)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	var winSnap struct {
		MessageWindows map[string]struct {
			OldestLoadedID string `json:"oldest_loaded_id"`
			HasOlder       bool   `json:"has_older"`
		} `json:"messageWindows"`
	}
	if err := json.Unmarshal(body, &winSnap); err != nil {
		t.Fatalf("window snapshot parse: %v", err)
	}
	win, ok := winSnap.MessageWindows[sid]
	if !ok {
		t.Fatalf("snapshot carried no messageWindows for %s", sid)
	}
	if win.OldestLoadedID != "cm52" {
		t.Fatalf("window oldest_loaded_id: want cm52 (oversized cm51 excluded by the byte budget), got %q — walk derivation broken", win.OldestLoadedID)
	}
	if !win.HasOlder {
		t.Fatalf("window has_older: want true (bounded, not-exhausted tail), got false")
	}

	type pageJSON struct {
		Items []struct {
			Info struct {
				ID string `json:"id"`
			} `json:"info"`
		} `json:"items"`
		OldestID       string `json:"oldest_id"`
		BoundaryFound  bool   `json:"boundary_found"`
		HasOlder       bool   `json:"has_older"`
		OversizedItem  bool   `json:"oversized_item"`
		HistoryExhaust bool   `json:"history_exhausted"`
	}
	getPage := func(before string) pageJSON {
		t.Helper()
		u := c.WorkerVHURL + "/vh/session/" + sid + "/messages?before=" + before + "&dir=" + url.QueryEscape(dir)
		resp, err := http.Get(u)
		if err != nil {
			t.Fatalf("page GET before=%s: %v", before, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var p pageJSON
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatalf("page GET before=%s parse: %v (body head: %.200s)", before, err, b)
		}
		return p
	}
	fetchBase := c.Fake.MessagesBeforeCount()

	// 2. Click 1 — before=cm52 (window oldest, NOT the floor): sub-case c pair
	// [cm51, cm52]. The oversized item prepends (walk advances), the envelope
	// OR keeps the affordance alive, and the D-trigger must NOT fire —
	// resident-local older history remains (anti-misfire).
	p1 := getPage("cm52")
	if !p1.BoundaryFound {
		t.Fatalf("click1 boundary_found: want true, got false")
	}
	if !p1.OversizedItem {
		t.Fatalf("click1 oversized_item: want true (cm51 alone exceeds the byte budget), got false")
	}
	if len(p1.Items) != 2 || p1.OldestID != "cm51" {
		t.Fatalf("click1 items: want the sub-case c pair [cm51, cm52] (oldest=cm51), got %d items oldest=%q", len(p1.Items), p1.OldestID)
	}
	// THE OF1 envelope half: has_older must SURVIVE the oversized page — the
	// affordance must not die at the oversized resident floor's doorstep.
	if !p1.HasOlder {
		t.Fatalf("click1 has_older: want true (oversized page, historyExhausted=false — OF1 envelope fix), got false")
	}
	// Anti-misfire: no remote fetch while before != resident floor.
	if got := c.Fake.MessagesBeforeCount() - fetchBase; got != 0 {
		t.Fatalf("click1 anti-misfire: MessagesBefore fired %d time(s) before the walk reached the floor (want 0)", got)
	}

	// 3. Click 2 — before=cm51 == the RESIDENT FLOOR with the oversized item:
	// the D-trigger fires past the oversized anchor. EnsureOlderMessages must
	// actually reach opencode (counter +1: a real fetch, not a flipped
	// boolean), and the merged state re-projects into the sub-case B pair
	// [cm50, cm51] — cm50 is a REMOTE-older id that was not resident before
	// the fetch.
	p2 := getPage("cm51")
	if got := c.Fake.MessagesBeforeCount() - fetchBase; got != 1 {
		t.Fatalf("click2 D-trigger: want exactly ONE real MessagesBefore fetch at the oversized floor, got %d", got)
	}
	if !p2.BoundaryFound {
		t.Fatalf("click2 boundary_found: want true, got false")
	}
	if !p2.OversizedItem {
		t.Fatalf("click2 oversized_item: want true (anchor cm51 still oversized), got false")
	}
	if len(p2.Items) != 2 || p2.OldestID != "cm50" {
		t.Fatalf("click2 items: want the re-projected sub-case B pair [cm50, cm51] with the REMOTE-older cm50 prepended, got %d items oldest=%q", len(p2.Items), p2.OldestID)
	}
	if !p2.HasOlder {
		t.Fatalf("click2 has_older: want true (resident-local older beyond the neighbor after the merge), got false")
	}
	if !p2.HistoryExhaust {
		t.Fatalf("click2 history_exhausted: want true (the backward fetch returned 50 ≤ WindowMaxCount → no X-Next-Cursor), got false")
	}

	// 4. Click 3 — before=cm50: ordinary page down to cm1; exhausted + no
	// limits → has_older=false. The walk settles ONLY at true end-of-history
	// (the fetch evidence: still exactly one MessagesBefore call).
	p3 := getPage("cm50")
	if !p3.BoundaryFound {
		t.Fatalf("click3 boundary_found: want true, got false")
	}
	if p3.OldestID != "cm1" {
		t.Fatalf("click3 oldest_id: want cm1 (paged to the transcript start), got %q", p3.OldestID)
	}
	if p3.HasOlder {
		t.Fatalf("click3 has_older: want false (true end-of-history — exhausted, no limits), got true")
	}
	if got := c.Fake.MessagesBeforeCount() - fetchBase; got != 1 {
		t.Fatalf("click3: want still exactly ONE MessagesBefore call across the whole walk, got %d", got)
	}
	t.Logf("CRUX PASS: oversized-floor walk — click1 pair [cm51,cm52] has_older=true (no fetch), click2 D-trigger fired ONCE at the floor (re-projected [cm50,cm51]), click3 settled has_older=false at cm1 (empty cursor)")
}
