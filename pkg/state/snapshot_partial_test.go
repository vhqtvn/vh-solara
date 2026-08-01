package state

// snapshot_partial_test.go — slice-A (Direction-3 stage-1, O1 frontier-scoped
// partial-detail) server-side tests. Pins the D4 two-scope tree-Stream-1-only
// capture: SnapshotWithTreePartial.
//
// Contract under test (refined, supersedes stage1-brief.md defaults):
//   - FRONTIER-scoped (client MERGES, must NOT delete buried): sessions / activity
//     / gate / lastAgents / currentVerbs  → only the emitted tree-frontier IDs.
//   - GLOBAL (client AUTHORITATIVE-REPLACE): questions / permissions / unread.
//   - OMITTED (client must NOT touch existing maps): todos / statuses / messages.
//   - subtreeBusy stays ALL sessions (a frontier node's SubtreeBusy reflects a
//     busy BURIED descendant — the gate's no-busy-descendant fact is global).
//   - ONE RLock, shared {epoch,seq} between tree + detail (Q5 consolidation).
//   - D7: full Snapshot() / SnapshotWithTree() stay UNCHANGED (Partial == nil).
//
// G1–G6 supplier coverage:
//   G1 (tree-children structural-only)        — not this file (tree_children.go)
//   G2/G3 (frontier detail facets)            — TestSnapshotWithTreePartial_FrontierScopeAndGlobalMaps
//   G4 (frontier scope == emitted tree)       — TestSnapshotWithTreePartial_FrontierMatchesTreeNodes
//   G5 (full external snapshot retained)      — TestSnapshotWithTreePartial_FullCaptureUnchanged
//   G6 (non-SPA consumers full)               — TestSnapshotWithTreePartial_FullCaptureUnchanged
//   gate subtree-busy from buried             — TestSnapshotWithTreePartial_SubtreeBusyFromBuried
//   DoD ≤300 KB MEASURED                      — TestSnapshotWithTreePartial_FrameSizeScaling

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// --- helpers --------------------------------------------------------------

// partialSessionIDs unmarshals each snap.Sessions entry and returns the set of
// session IDs the detail frame carries.
func partialSessionIDs(t *testing.T, snap Snapshot) map[string]bool {
	t.Helper()
	out := make(map[string]bool, len(snap.Sessions))
	for _, raw := range snap.Sessions {
		var info struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &info); err != nil {
			t.Fatalf("unmarshal session info: %v", err)
		}
		out[info.ID] = true
	}
	return out
}

// heavySessionProps builds a realistic ~800 B session.created payload (title +
// summary + path + agent + model + cost/tokens) so the frame-size measurement
// reflects production session-record weight, not minimal test fixtures.
func heavySessionProps(id, parentID string, i int) string {
	title := fmt.Sprintf("Build R1+R2: negatives gate + endpoint evidence slice %d (@build subagent)", i)
	summary := strings.Repeat("a", 220) // ~220 B summary blob (real sessions carry diff summaries)
	parent := ""
	if parentID != "" {
		parent = fmt.Sprintf(`,"parentID":%q`, parentID)
	}
	return fmt.Sprintf(`{"info":{"id":%q%s,"title":%q,"summary":%q,"path":"/home/work/deep-fake-detection","agent":"build","model":"claude-sonnet","cost":0.4231,"tokensInput":12891,"tokensOutput":7421,"tokensReasoning":3002}}`,
		id, parent, title, summary)
}

// seedScaledFrontierTree seeds 1 LOADED root (made active by a busy direct
// child) + frontierChildren direct children (frontier: direct-children-of-loaded)
// + buriedGrandchildren grandchildren under one direct child (BURIED: not
// direct-children-of-a-loaded node). Returns the expected frontier id set and a
// representative buried id. Uses heavySessionProps so the byte measurement is
// production-realistic.
func seedScaledFrontierTree(t *testing.T, s *Store, frontierChildren, buriedGrandchildren int) (frontier map[string]bool, buriedID string) {
	t.Helper()
	root := "R"
	s.Apply(ev("session.created", heavySessionProps(root, "", 0)))
	// First direct child BUSY → root R is on the active path → loaded:true.
	s.Apply(ev("session.created", heavySessionProps("D0", root, 1)))
	s.Apply(ev("session.status", evStatus("D0", "busy")))
	// Remaining direct children of loaded root R → frontier placeholders.
	for i := 1; i < frontierChildren; i++ {
		id := fmt.Sprintf("D%d", i)
		s.Apply(ev("session.created", heavySessionProps(id, root, i+10)))
	}
	// Buried grandchildren under D1 (D1 is loaded:false placeholder, so its
	// children are NOT direct-children-of-loaded → buried).
	for i := 0; i < buriedGrandchildren; i++ {
		id := fmt.Sprintf("G%d", i)
		s.Apply(ev("session.created", heavySessionProps(id, "D1", i+1000)))
	}
	frontier = map[string]bool{root: true}
	for i := 0; i < frontierChildren; i++ {
		frontier[fmt.Sprintf("D%d", i)] = true
	}
	return frontier, "G0"
}

// ==========================================================================
// Test 1 — D4 frontier scope + global maps + shared {epoch,seq} + omission.
// Pins G2/G3/G5/G6 supplier side.
// ==========================================================================
func TestSnapshotWithTreePartial_FrontierScopeAndGlobalMaps(t *testing.T) {
	s := New(64)
	// R(loaded via busy D0) + D0,D1,D2 frontier + G1 buried (child of D1).
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("D0", "R")))
	s.Apply(ev("session.status", evStatus("D0", "busy")))
	s.Apply(ev("session.created", evSessionCreated("D1", "R")))
	s.Apply(ev("session.created", evSessionCreated("D2", "R")))
	s.Apply(ev("session.created", evSessionCreated("G1", "D1"))) // buried (no pending input)

	// Pending question + permission on a FRONTIER session (D2). NOTE: by design
	// (tree_emitter.go isActiveLocked ~:283), ANY session with pending Q/P is
	// promoted into the active path → frontier. So Q/P/unread are ALWAYS subsets
	// of the frontier; the "global" authority tag exists for client-side
	// AUTHORITATIVE-REPLACE semantics (clearing replied questions), not to
	// capture non-frontier sessions. This test pins that the partial frame (a)
	// captures Q/P/unread (does NOT omit them) and (b) tags them "global".
	s.Apply(ev("question.asked", evQuestionAsked("D2", "q1")))
	s.Apply(ev("permission.asked", evPermissionAsked("D2", "p1")))
	// Unread on the root R (a root is cat-1 frontier). Unread does not promote.
	s.mu.Lock()
	s.unread["R"] = true
	s.mu.Unlock()

	e := NewTreeEmitter(s, "/proj")
	detail, tree := s.SnapshotWithTreePartial(e, "cold")

	// (a) Partial metadata present + complete.
	if detail.Partial == nil {
		t.Fatalf("detail.Partial is nil — full path ran instead of partial")
	}
	if detail.Partial.Mode != "tree-stream-1-frontier" {
		t.Errorf("Mode=%q want tree-stream-1-frontier", detail.Partial.Mode)
	}
	for _, k := range []string{"sessions", "activity", "gate", "lastAgents", "currentVerbs",
		"questions", "permissions", "unread", "todos", "statuses", "messages"} {
		if _, ok := detail.Partial.Authority[k]; !ok {
			t.Errorf("Authority missing key %q", k)
		}
	}

	// (b) Frontier-scoped: sessions/gate carry ONLY frontier IDs (not buried G1).
	gotIDs := partialSessionIDs(t, detail)
	wantFrontier := map[string]bool{"R": true, "D0": true, "D1": true, "D2": true}
	if !mapEqual(gotIDs, wantFrontier) {
		t.Errorf("frontier sessions = %v, want %v (G1 must be absent)", gotIDs, wantFrontier)
	}
	if gotIDs["G1"] {
		t.Errorf("BURIED G1 leaked into partial sessions — scope is not frontier-bounded")
	}
	if len(detail.Gate) != len(wantFrontier) {
		t.Errorf("Gate has %d entries, want %d (frontier only)", len(detail.Gate), len(wantFrontier))
	}
	if _, ok := detail.Gate["G1"]; ok {
		t.Errorf("BURIED G1 leaked into partial Gate")
	}

	// (c) GLOBAL: questions/permissions/unread are captured (not omitted) and the
	// authority tag is "global" (client authoritatively-replaces).
	if _, ok := detail.Questions["D2"]; !ok {
		t.Errorf("D2 question missing from partial — questions must be captured")
	}
	if detail.Partial.Authority["questions"] != "global" {
		t.Errorf("questions authority=%q want global", detail.Partial.Authority["questions"])
	}
	if _, ok := detail.Permissions["D2"]; !ok {
		t.Errorf("D2 permission missing from partial — permissions must be captured")
	}
	if detail.Partial.Authority["permissions"] != "global" {
		t.Errorf("permissions authority=%q want global", detail.Partial.Authority["permissions"])
	}
	foundRUnread := false
	for _, id := range detail.Unread {
		if id == "R" {
			foundRUnread = true
		}
	}
	if !foundRUnread {
		t.Errorf("R unread missing from partial — unread must be captured")
	}
	if detail.Partial.Authority["unread"] != "global" {
		t.Errorf("unread authority=%q want global", detail.Partial.Authority["unread"])
	}

	// (d) OMITTED: todos/statuses/messages absent (empty maps; client must not
	// treat empty as authoritative-clear).
	if len(detail.Todos) != 0 {
		t.Errorf("partial Todos must be omitted, got %d entries", len(detail.Todos))
	}
	if len(detail.Statuses) != 0 {
		t.Errorf("partial Statuses must be omitted, got %d entries", len(detail.Statuses))
	}
	if len(detail.Messages) != 0 {
		t.Errorf("partial Messages must be omitted, got %d entries", len(detail.Messages))
	}

	// (e) Shared {epoch,seq}: tree + detail captured under ONE RLock.
	if detail.Epoch != tree.Epoch || detail.Seq != tree.Seq {
		t.Errorf("identity mismatch: detail{epoch=%q seq=%d} tree{epoch=%q seq=%d}",
			detail.Epoch, detail.Seq, tree.Epoch, tree.Seq)
	}
	if detail.Epoch != s.Epoch() {
		t.Errorf("detail.Epoch=%q != store %q", detail.Epoch, s.Epoch())
	}
}

func mapEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// ==========================================================================
// Test 2 — D7: full SnapshotWithTree stays UNCHANGED (Partial nil, all sessions).
// Pins G5/G6 (non-SPA consumers retain the full capture).
// ==========================================================================
func TestSnapshotWithTreePartial_FullCaptureUnchanged(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("D0", "R")))
	s.Apply(ev("session.status", evStatus("D0", "busy")))
	s.Apply(ev("session.created", evSessionCreated("D1", "R")))
	s.Apply(ev("session.created", evSessionCreated("G1", "D1"))) // buried

	e := NewTreeEmitter(s, "/proj")
	full, _ := s.SnapshotWithTree(e, nil, "cold")

	if full.Partial != nil {
		t.Fatalf("full SnapshotWithTree must leave Partial nil (D7), got %+v", full.Partial)
	}
	// Full detail carries ALL sessions incl. buried G1.
	got := partialSessionIDs(t, full)
	for _, want := range []string{"R", "D0", "D1", "G1"} {
		if !got[want] {
			t.Errorf("full capture missing session %q (D7 regression)", want)
		}
	}

	// Plain Snapshot() (used by /vh/snapshot, coordapi, MCP, diag) also stays full.
	plain := s.Snapshot(nil)
	if plain.Partial != nil {
		t.Fatalf("Snapshot(nil) must leave Partial nil (D7), got %+v", plain.Partial)
	}
}

// ==========================================================================
// Test 3 — frontier scope == emitted tree node set (G4) + SubtreeBusy correctness.
// A busy node is always pulled into the active path (frontier), so subtreeBusy
// is determined by frontier-resident busy nodes; assert the frontier gates carry
// the correct SubtreeBusy (true for a node whose subtree contains the busy leaf,
// false for a sibling subtree with no busy descendant).
// ==========================================================================
func TestSnapshotWithTreePartial_FrontierMatchesTreeNodesAndSubtreeBusy(t *testing.T) {
	s := New(64)
	// R(loaded via busy D0) + D1(frontier, child of R). D0 busy in R's subtree;
	// D1's subtree has no busy descendant.
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("D0", "R")))
	s.Apply(ev("session.status", evStatus("D0", "busy")))
	s.Apply(ev("session.created", evSessionCreated("D1", "R")))

	e := NewTreeEmitter(s, "/proj")
	detail, tree := s.SnapshotWithTreePartial(e, "cold")

	// G4: detail scope == emitted tree node set.
	treeIDs := map[string]bool{}
	for _, n := range tree.Nodes {
		treeIDs[n.ID] = true
	}
	if !mapEqual(partialSessionIDs(t, detail), treeIDs) {
		t.Errorf("detail scope != tree node set:\n detail=%v\n tree=%v",
			partialSessionIDs(t, detail), treeIDs)
	}
	if len(tree.FrontierIDs) == 0 {
		t.Fatalf("tree.FrontierIDs empty — not populated")
	}
	// tree.FrontierIDs must equal the tree node id set (partial reuses it).
	if !mapEqual(stringSliceToSet(tree.FrontierIDs), treeIDs) {
		t.Errorf("tree.FrontierIDs != tree node set:\n frontier=%v\n tree=%v",
			tree.FrontierIDs, treeIDs)
	}

	// SubtreeBusy correctness for frontier nodes: R's subtree contains busy D0
	// → true; D1's subtree has no busy descendant → false. This pins that the
	// partial detail computed SubtreeBusy (the subtreeBusyCount index is read
	// for every frontier node) rather than defaulting/false-short-circuiting.
	if g, ok := detail.Gate["R"]; !ok {
		t.Fatalf("R missing from partial Gate")
	} else if !g.SubtreeBusy {
		t.Errorf("R.SubtreeBusy=false but busy D0 is in R's subtree")
	}
	if g, ok := detail.Gate["D1"]; !ok {
		t.Fatalf("D1 missing from partial Gate (it is a frontier node)")
	} else if g.SubtreeBusy {
		t.Errorf("D1.SubtreeBusy=true but D1's subtree has no busy descendant")
	}
}

func stringSliceToSet(xs []string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// ==========================================================================
// Test 4 — DoD §1: cold/reconnect detail frame ≤ 300 KB MEASURED for a scaled
// dir (~980 sessions), target 240–260 KB. Also prints the scaling curve
// (full vs partial) so the payload-bound is quantified at the unit level.
// ==========================================================================
func TestSnapshotWithTreePartial_FrameSizeScaling(t *testing.T) {
	cases := []struct{ frontier, buried int }{
		{50, 50},    // ~100 total, frontier ~51
		{195, 785},  // ~980 total, frontier ~196 (matches the live ses_05ff9273 shape)
	}
	for _, c := range cases {
		s := New(64)
		frontier, _ := seedScaledFrontierTree(t, s, c.frontier, c.buried)
		e := NewTreeEmitter(s, "/proj")

		partial, tree := s.SnapshotWithTreePartial(e, "cold")
		full, _ := s.SnapshotWithTree(e, nil, "cold")

		pBytes, err := json.Marshal(partial)
		if err != nil {
			t.Fatalf("marshal partial: %v", err)
		}
		fBytes, err := json.Marshal(full)
		if err != nil {
			t.Fatalf("marshal full: %v", err)
		}

		// The partial detail ships exactly the frontier count (not the whole dir).
		gotFrontier := partialSessionIDs(t, partial)
		if len(gotFrontier) != len(frontier) {
			t.Errorf("frontier=%d: partial shipped %d sessions, want %d",
				c.frontier, len(gotFrontier), len(frontier))
		}
		// Tree identity shared with detail.
		if partial.Epoch != tree.Epoch || partial.Seq != tree.Seq {
			t.Errorf("frontier=%d: identity mismatch", c.frontier)
		}

		t.Logf("SCALING total=%d frontier=%d: partial=%d B (%.1f KB), full=%d B (%.1f KB), ratio full/partial=%.1fx",
			c.frontier+c.buried+1, len(frontier),
			len(pBytes), float64(len(pBytes))/1024,
			len(fBytes), float64(len(fBytes))/1024,
			float64(len(fBytes))/float64(len(pBytes)))
	}

	// DoD: the ~980-session cold detail frame must be ≤ 300 KB raw.
	s := New(64)
	seedScaledFrontierTree(t, s, 195, 785)
	e := NewTreeEmitter(s, "/proj")
	detail, _ := s.SnapshotWithTreePartial(e, "cold")
	b, _ := json.Marshal(detail)
	kb := float64(len(b)) / 1024
	if kb > 300 {
		t.Errorf("DoD FAIL: 980-session partial detail = %.1f KB, want ≤ 300 KB", kb)
	}
	t.Logf("DoD MEASURED: 980-session partial detail frame = %.1f KB (target 240–260 KB)", kb)
}

// ==========================================================================
// Test 5 — D2 ExpandChildrenWithDetail: page + bounded detail bundle under ONE
// RLock. Pins G1 (expand is a detail supplier): the expand returns detail for
// EXACTLY the page's IDs (every returned ID has facets; no unrelated/buried IDs;
// the parent itself is not in its own expand page). req4.
// ==========================================================================
func TestExpandChildrenWithDetail_PageBoundedBundle(t *testing.T) {
	s := New(64)
	// R(loaded via busy D0) + direct children D0..D4 (the page) + buried G1 under
	// D1 (must NOT appear — it is a grandchild, not in R's direct-children page).
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("D0", "R")))
	s.Apply(ev("session.status", evStatus("D0", "busy")))
	s.Apply(ev("session.created", evSessionCreated("D1", "R")))
	s.Apply(ev("session.created", evSessionCreated("D2", "R")))
	s.Apply(ev("session.created", evSessionCreated("D3", "R")))
	s.Apply(ev("session.created", evSessionCreated("D4", "R")))
	s.Apply(ev("session.created", evSessionCreated("G1", "D1"))) // buried grandchild

	e := NewTreeEmitter(s, "/proj")
	nodes, hasMore, nextCursor, stale, detail := e.ExpandChildrenWithDetail("R", "", 0)

	// (a) Page = R's direct children, terminal (no cursor), not stale.
	if stale {
		t.Fatalf("expand returned stale=true unexpectedly")
	}
	if hasMore || nextCursor != "" {
		t.Errorf("expected terminal page, got hasMore=%v cursor=%q", hasMore, nextCursor)
	}
	gotPage := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		gotPage[n.ID] = true
	}
	wantPage := map[string]bool{"D0": true, "D1": true, "D2": true, "D3": true, "D4": true}
	if !mapEqual(gotPage, wantPage) {
		t.Fatalf("page = %v, want %v", gotPage, wantPage)
	}

	// (b) Detail bundle present + tagged expand-page, scope == page IDs.
	if detail.Partial == nil {
		t.Fatalf("detail.Partial nil — expand did not stamp the bundle")
	}
	if detail.Partial.Mode != "expand-page" {
		t.Errorf("Mode=%q want expand-page", detail.Partial.Mode)
	}
	gotScope := stringSliceToSet(detail.Partial.Scope)
	if !mapEqual(gotScope, wantPage) {
		t.Errorf("detail scope = %v, want page %v", gotScope, wantPage)
	}
	// (c) Every returned ID has a session record + gate; NO unrelated IDs (R is
	// the parent, not in its own page; G1 is a buried grandchild, not in page).
	gotDetailIDs := partialSessionIDs(t, detail)
	if gotDetailIDs["R"] {
		t.Errorf("parent R leaked into its own expand detail — not page-bounded")
	}
	if gotDetailIDs["G1"] {
		t.Errorf("BURIED G1 leaked into expand detail — not page-bounded")
	}
	if !mapEqual(gotDetailIDs, wantPage) {
		t.Errorf("detail sessions = %v, want page %v", gotDetailIDs, wantPage)
	}
	for _, id := range []string{"D0", "D1", "D2", "D3", "D4"} {
		if _, ok := detail.Gate[id]; !ok {
			t.Errorf("Gate[%s] missing — expand must supply gate for every page ID", id)
		}
	}
	// (d) Global Q/P/unread authority + omitted todos/statuses/messages.
	if detail.Partial.Authority["questions"] != "global" || detail.Partial.Authority["permissions"] != "global" || detail.Partial.Authority["unread"] != "global" {
		t.Errorf("Q/P/unread authority = %v — want global", detail.Partial.Authority)
	}
	for _, k := range []string{"todos", "statuses", "messages"} {
		if detail.Partial.Authority[k] != "omitted" {
			t.Errorf("%s authority = %q — want omitted", k, detail.Partial.Authority[k])
		}
	}
	// (e) Snapshot identity is set (the bundle is a well-formed Snapshot).
	if detail.Epoch == "" || detail.Seq == 0 {
		t.Errorf("detail identity empty: epoch=%q seq=%d", detail.Epoch, detail.Seq)
	}
	t.Logf("D2 expand-page: %d nodes, detail scope=%d, mode=%q — page-bounded bundle OK", len(nodes), len(detail.Partial.Scope), detail.Partial.Mode)
}
