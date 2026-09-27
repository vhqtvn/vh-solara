package state

// S4 measurement slice (fleet-status follow-ups C-F2 + D-F2). TEST-ONLY.
//
// This file is a MEASUREMENT harness, not a behavioral contract: it builds a
// synthetic-but-representative fleet fixture in memory (no files, no network,
// no pkg/fixtures dependency) and produces rerunnable receipts for:
//
//   - C-F2 payload: wire bytes of (a) the fleet fallback's per-project
//     tree-only /vh/snapshot envelopes, (b) the complete gate map isolated
//     from the envelope, and (c) the lean batched GET /vh/gates body — each
//     raw and in the worker's z=1 gzip64 envelope (the actual HTTP body).
//   - D-F2 cost: wall time of computeFleetAggregatesLocked (the DFS), the
//     capture paths it feeds, the store-lock hold those captures imply, and
//     writer contention (session upsert latency with/without a concurrent
//     capture loop).
//
// HONESTY LABELS (read before quoting any number from this file):
//
//   - Everything here is MEASURED on a SYNTHETIC fixture. The results are
//     only as representative as the fixture shape, whose ratios are declared
//     below and justified inline. They are not a claim about any specific
//     operator fleet; the one external anchor (the operator's live fleet
//     showed 5,105 sessions across 7 projects) is context quoted from the
//     dispatching brief, not a measurement made here.
//   - Byte sizes are DETERMINISTIC given the fixture (encoding/json sorts map
//     keys), so size receipts do not need repeated runs. Timing receipts are
//     benchmark outputs and vary per machine/run; variance is reported by
//     running with -count=N, not asserted in-test.
//   - The gzip64 replication below must stay byte-shape-identical to
//     pkg/web/server.go maybeCompressSnapshot: gzip.NewWriter (DEFAULT
//     compression level — NOT level 1; "z=1" is the query-param opt-in, not
//     a level), then {"encoding":"gzip64","data":base64(...)}. The lean-body
//     struct replicates pkg/web handleFleetGates' marshal (same fields, same
//     JSON tags, same order). If pkg/web changes those shapes, this file's
//     byte receipts drift — re-pin on change.
//   - No production code was modified for these measurements. Instrumentation
//     is test-side only (direct calls to the locked helpers, which is
//     possible because this file is in package state).

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// ----------------------------------------------------------------------------
// Fixture: shapes, declared ratios, construction
// ----------------------------------------------------------------------------

// Fixture shapes:
//
//   - representative: 7 projects × varied sizes (see fleetProjectSizes),
//     mixed depth (roots ~67%, children 25%, grandchildren 5%, orphans 3%),
//     activity mix (idle 80% / busy 12% / retry 4% / error 4%), pending mix
//     (permission 2%, question 2%), 80% of sessions carrying a completed
//     user+assistant exchange (finish_reason + tokens ride the gate map), and
//     an authoritative archived-ID snapshot at ~30% of live count. This
//     models a working agent fleet: most sessions are root conversations,
//     subagent children hang off roots, grandchildren are rare, a small
//     post-archive-cascade straggler population remains (orphans pointing at
//     archived parents — effective roots, NOT fleet-selected), and the busy
//     minority keeps most roots' subtree_busy false.
//   - all-roots: same 7 projects and counts, every session parentID="". The
//     control: identical session count, zero tree folding work (no children
//     maps, no subtree summation, no per-session chain walks of depth > 0).
//   - deep-chain: ONE project, all 5,105 sessions in a single parent chain.
//     The stress case: the selection pass's chainTerminatesAtArchivedLocked
//     walk is O(depth) per session, so a single deep chain makes the
//     selection pass O(n²). This is a pathological topology — included
//     because it bounds the worst case and exposes the scaling term, not
//     because real fleets look like this.
//
// RATIO JUSTIFICATIONS (all assumptions, stated so a reader can dispute them):
//   - sizes {850,780,745,725,700,665,640} sum to 5,105 — matches the
//     operator's observed live-fleet session count (5,105 across 7 projects)
//     so per-session byte costs transfer; varied so no single project
//     dominates the mean.
//   - archived-at-30%-of-live: production evicts archived sessions from the
//     live store (upsertSessionLocked deletes time.archived rows), so the
//     archived population manifests ONLY as archivedSnapshot membership that
//     orphan-chain walks consult. 30% models "the operator archives finished
//     work periodically"; the exact value barely affects cost (O(1) lookups)
//     but is declared anyway.
//   - orphans 3%: the residual straggler population a real archive cascade
//     leaves behind (children whose archived parent was removed).
//   - busy 12% / retry 4% / error 4%: an actively-driven fleet where a
//     visible minority is mid-turn at any instant. Error via session.error
//     (the ONLY ActivityError source); retry/busy via session.status.
//   - pending 2%+2%: waits are rare per session but nonzero across a fleet
//     this size (~100 of each kind per project set).
//   - with-exchange 80%: most sessions have at least one completed turn, so
//     finish_reason + tokens (the gate map's variable-size fields) are
//     present on most entries; 20% never-touched sessions keep the
//     hydrated=false minority realistic.
const (
	fleetShapeRepresentative = "representative"
	fleetShapeAllRoots       = "all-roots"
	fleetShapeDeepChain      = "deep-chain"

	// fleetGzipThreshold mirrors pkg/web snapshotCompressThreshold: payloads
	// below it stay raw on the wire even with z=1.
	fleetGzipThreshold = 2048
)

var fleetShapeOrder = []string{fleetShapeRepresentative, fleetShapeAllRoots, fleetShapeDeepChain}

// fleetProjectSizes: 7 projects summing to 5,105 live sessions.
var fleetProjectSizes = []int{850, 780, 745, 725, 700, 665, 640}

// fleetTitlePool: realistic title lengths (45–75 chars) so the per-session
// row byte cost in the complete envelope carries real-world variance.
var fleetTitlePool = []string{
	"Investigate flaky session-list e2e spec under serial worker contention",
	"Refactor aggregator snapshot capture into two-phase flush+materialize",
	"Add subtree pending-input rollup to the fleet gate map wire",
	"Fix part-append suffix offset drift after a reconnect snapshot",
	"Wire managed-process health facet into the project switcher badge",
	"Reduce cold tree snapshot payload below the 2 MiB tunnel budget",
	"Harden archive cascade against orphaned descendant stragglers",
	"Track down WebRender GPU heat during long reasoning streams",
}

// fleetFixtureStats records the fixture's ACTUAL constructed shape — the
// receipt that travels with every measurement below ("record selected counts
// and fixture construction, not just a savings percentage").
type fleetFixtureStats struct {
	Projects      int
	LiveSessions  int
	Roots         int // parentID == "" (selected population; excludes orphans)
	Children      int
	Grandchildren int
	Orphans       int // live, parentID → archived (absent) id; NOT selected
	ArchivedIDs   int // archivedSnapshot membership (absent from live store)
	SelectedRoots int // sum of len(GateFactsFleetSelected()) across stores
	Busy          int
	Retry         int
	Errored       int
	Idle          int
	PendingPerm   int
	PendingQuest  int
	WithExchange  int // sessions with a completed user+assistant turn
}

func (fs fleetFixtureStats) String() string {
	return fmt.Sprintf(
		"projects=%d live=%d roots=%d children=%d grandchildren=%d orphans=%d archived_ids=%d selected=%d | busy=%d retry=%d error=%d idle=%d | pending_perm=%d pending_quest=%d | with_exchange=%d",
		fs.Projects, fs.LiveSessions, fs.Roots, fs.Children, fs.Grandchildren, fs.Orphans, fs.ArchivedIDs, fs.SelectedRoots,
		fs.Busy, fs.Retry, fs.Errored, fs.Idle, fs.PendingPerm, fs.PendingQuest, fs.WithExchange)
}

// fleetFixture is a built fixture: one Store per project plus its dir name.
type fleetFixture struct {
	shape  string
	dirs   []string
	stores []*Store
	stats  fleetFixtureStats
}

var (
	fleetFixtureCacheMu sync.Mutex
	fleetFixtureCache   = map[string]*fleetFixture{}
)

// fleetFixtureFor returns the cached fixture for a shape, building it on
// first use. Fixtures are IMMUTABLE once built: every benchmark/test that
// only READS (snapshots, gate facts, marshaling) may share them. Mutating
// workloads (BenchmarkFleetWriterUpsert) must build their own store via
// seedFleetStore and must NOT touch this cache.
func fleetFixtureFor(shape string) *fleetFixture {
	fleetFixtureCacheMu.Lock()
	defer fleetFixtureCacheMu.Unlock()
	if fx, ok := fleetFixtureCache[shape]; ok {
		return fx
	}
	fx := buildFleetFixture(shape)
	fleetFixtureCache[shape] = fx
	return fx
}

func buildFleetFixture(shape string) *fleetFixture {
	fx := &fleetFixture{shape: shape}
	if shape == fleetShapeDeepChain {
		st, cs := seedFleetStore("p0", fleetTotalSessions(), shape)
		fx.dirs = []string{"/home/op/work/srv-0"}
		fx.stores = []*Store{st}
		fx.stats = fleetFixtureStats{Projects: 1}
		fx.stats.accumulate(cs)
		fx.stats.SelectedRoots = len(st.GateFactsFleetSelected())
		fx.assertSelectedShape()
		return fx
	}
	for k, n := range fleetProjectSizes {
		tag := fmt.Sprintf("p%d", k)
		st, cs := seedFleetStore(tag, n, shape)
		fx.dirs = append(fx.dirs, fmt.Sprintf("/home/op/work/srv-%d", k))
		fx.stores = append(fx.stores, st)
		fx.stats.Projects++
		fx.stats.accumulate(cs)
	}
	for _, st := range fx.stores {
		fx.stats.SelectedRoots += len(st.GateFactsFleetSelected())
	}
	fx.assertSelectedShape()
	return fx
}

func fleetTotalSessions() int {
	t := 0
	for _, n := range fleetProjectSizes {
		t += n
	}
	return t
}

// assertSelectedShape validates the fixture against its own construction
// invariants (guards against seeding bugs, not against production drift):
// representative/all-roots select exactly the root population; a single
// deep chain selects exactly its one root.
func (fx *fleetFixture) assertSelectedShape() {
	want := fx.stats.Roots
	if fx.shape == fleetShapeDeepChain {
		want = 1
	}
	if fx.stats.SelectedRoots != want {
		panic(fmt.Sprintf("fixture %s: selected=%d want=%d — seeding bug", fx.shape, fx.stats.SelectedRoots, want))
	}
}

func (fs *fleetFixtureStats) accumulate(cs fleetStoreCounts) {
	fs.LiveSessions += cs.live
	fs.Roots += cs.roots
	fs.Children += cs.children
	fs.Grandchildren += cs.grand
	fs.Orphans += cs.orphans
	fs.ArchivedIDs += cs.archived
	fs.Busy += cs.busy
	fs.Retry += cs.retry
	fs.Errored += cs.error
	fs.Idle += cs.idle
	fs.PendingPerm += cs.perm
	fs.PendingQuest += cs.quest
	fs.WithExchange += cs.exchange
}

// fleetStoreCounts carries one store's construction-time counters.
type fleetStoreCounts struct {
	live                     int
	roots, children, grand   int
	orphans, archived        int
	busy, retry, error, idle int
	perm, quest, exchange    int
}

// seedFleetStore builds ONE project's store via the public Apply/reconcile
// surface (the same reducers production events flow through) plus the public
// hydrate mutators (RefreshArchivedSnapshot / SetPendingQuestions /
// SetPendingPermissions). Deterministic: same inputs → same store, same
// timestamps (fixed epoch base), same titles (pooled by index).
//
// Seeding ORDER is load-bearing: sessions first (parents before children),
// then the archived snapshot (orphans become unselected only after their
// archived parents are in archivedSnapshot), then activity terminals, then
// message history, then pending reconciles.
func seedFleetStore(tag string, n int, shape string) (*Store, fleetStoreCounts) {
	st := New(4096)
	var cs fleetStoreCounts
	cs.live = n

	type node struct {
		id       string
		parentID string
	}
	var nodes []node

	mk := func(i int, parentID string) node {
		id := fmt.Sprintf("%s_s%05d", tag, i)
		return node{id: id, parentID: parentID}
	}

	base := 1_750_000_000_000.0
	info := func(nd node, i int) string {
		title := fleetTitlePool[i%len(fleetTitlePool)]
		dir := "/home/op/work/srv-" + tag[1:]
		parent := ""
		if nd.parentID != "" {
			parent = fmt.Sprintf(`,"parentID":%q`, nd.parentID)
		}
		created := base + float64(i)*61_000
		return fmt.Sprintf(`{"id":%q,"projectID":%q,"title":%q,"directory":%q,"model":{"providerID":"anthropic","id":"claude-sonnet-4-5","variant":"default"}%s,"time":{"created":%.0f,"updated":%.0f}}`,
			nd.id, tag, title, dir, parent, created, created+240_000)
	}

	switch shape {
	case fleetShapeRepresentative:
		orphans := n * 3 / 100
		grand := n * 5 / 100
		children := n * 25 / 100
		roots := n - orphans - grand - children
		cs.roots, cs.children, cs.grand, cs.orphans = roots, children, grand, orphans
		archived := n * 30 / 100
		cs.archived = archived
		i := 0
		for k := 0; k < roots; k++ {
			nodes = append(nodes, mk(i, "")) // roots: parentID == ""
			i++
		}
		for k := 0; k < children; k++ {
			nodes = append(nodes, mk(i, nodes[k%roots].id)) // spread across roots
			i++
		}
		for k := 0; k < grand; k++ {
			nodes = append(nodes, mk(i, nodes[roots+k%children].id)) // under children
			i++
		}
		for k := 0; k < orphans; k++ {
			// Parent = an ARCHIVED (never-live) id → an effective root that
			// chainTerminatesAtArchivedLocked rejects once archivedSnapshot
			// knows the id.
			nodes = append(nodes, mk(i, fmt.Sprintf("%s_a%04d", tag, k%max1(archived))))
			i++
		}
		// Authoritative archived-ID snapshot (absent-from-live population).
		var archivedRows []json.RawMessage
		for k := 0; k < archived; k++ {
			archivedRows = append(archivedRows, json.RawMessage(fmt.Sprintf(
				`{"id":"%s_a%04d","projectID":%q,"time":{"archived":%.0f}}`, tag, k, tag, base+float64(k)*1000)))
		}
		st.RefreshArchivedSnapshot(archivedRows)
	case fleetShapeAllRoots:
		cs.roots = n
		for k := 0; k < n; k++ {
			nodes = append(nodes, mk(k, ""))
		}
		archived := n * 30 / 100
		cs.archived = archived
		var archivedRows []json.RawMessage
		for k := 0; k < archived; k++ {
			archivedRows = append(archivedRows, json.RawMessage(fmt.Sprintf(
				`{"id":"%s_a%04d","projectID":%q,"time":{"archived":%.0f}}`, tag, k, tag, base+float64(k)*1000)))
		}
		st.RefreshArchivedSnapshot(archivedRows)
	case fleetShapeDeepChain:
		cs.roots = 1
		prev := ""
		for k := 0; k < n; k++ {
			nd := mk(k, prev)
			nodes = append(nodes, nd)
			prev = nd.id
		}
		archived := n * 30 / 100
		cs.archived = archived
		var archivedRows []json.RawMessage
		for k := 0; k < archived; k++ {
			archivedRows = append(archivedRows, json.RawMessage(fmt.Sprintf(
				`{"id":"%s_a%04d","projectID":%q,"time":{"archived":%.0f}}`, tag, k, tag, base+float64(k)*1000)))
		}
		st.RefreshArchivedSnapshot(archivedRows)
	default:
		panic("unknown fixture shape: " + shape)
	}

	// Sessions (parents before children — deterministic creation order).
	for i, nd := range nodes {
		st.Apply(ev("session.created", fmt.Sprintf(`{"info":%s}`, info(nd, i))))
	}

	// Activity mix over ALL live sessions (deterministic by index):
	// i%25 ∈ {0,1,2} busy (12%), {3} retry (4%), {4} error (4%), else idle.
	for i, nd := range nodes {
		switch i % 25 {
		case 0, 1, 2:
			st.Apply(ev("session.status", fmt.Sprintf(`{"sessionID":%q,"status":{"type":"busy"}}`, nd.id)))
			cs.busy++
		case 3:
			st.Apply(ev("session.status", fmt.Sprintf(`{"sessionID":%q,"status":{"type":"retry"}}`, nd.id)))
			cs.retry++
		case 4:
			// session.error is the only ActivityError source (session.status
			// normalizes unknown types to idle).
			st.Apply(ev("session.error", fmt.Sprintf(`{"sessionID":%q}`, nd.id)))
			cs.error++
		default:
			cs.idle++
		}
	}

	// Completed exchange on 80% of sessions: one user message + one completed
	// assistant message (finish "stop", realistic tokens) + one text part.
	agentPool := []string{"build", "plan"}
	summary := "Summary: reproduced the failure under the serial e2e worker, traced the root cause to a stale cursor retained across reconnect, and pinned the fix behind a regression spec."
	for i, nd := range nodes {
		if i%5 == 0 {
			continue // the never-touched 20%
		}
		cs.exchange++
		t0 := base + float64(i)*61_000 + 1_000
		agent := agentPool[i%len(agentPool)]
		st.Apply(ev("message.updated", fmt.Sprintf(`{"info":{"id":%q,"sessionID":%q,"role":"user","time":{"created":%.0f}}}`, nd.id+"_mu", nd.id, t0)))
		st.Apply(ev("message.updated", fmt.Sprintf(`{"info":{"id":%q,"sessionID":%q,"role":"assistant","agent":%q,"finish":"stop","tokens":{"input":41288,"output":2311,"reasoning":8622,"cache":{"read":184320,"write":2048}},"time":{"created":%.0f,"completed":%.0f}}}`, nd.id+"_ma", nd.id, agent, t0, t0+45_000)))
		st.Apply(ev("message.part.updated", fmt.Sprintf(`{"part":{"id":%q,"sessionID":%q,"messageID":%q,"type":"text","text":%q}}`, nd.id+"_p1", nd.id, nd.id+"_ma", summary)))
	}

	// Pending reconciles (public hydrate-path mutators): 2% permissions, 2%
	// questions, spread across roots AND children so subtree counts surface
	// on selected roots.
	var perms, quests []json.RawMessage
	for i, nd := range nodes {
		if i%50 == 0 {
			perms = append(perms, json.RawMessage(fmt.Sprintf(`{"id":%q,"sessionID":%q,"type":"bash","pattern":"git commit"}`, nd.id+"_perm", nd.id)))
			cs.perm++
		}
		if i%50 == 25 {
			quests = append(quests, json.RawMessage(fmt.Sprintf(`{"id":%q,"sessionID":%q,"title":"Which fixture ratio should the benchmark use?"}`, nd.id+"_q", nd.id)))
			cs.quest++
		}
	}
	st.SetPendingPermissions(perms)
	st.SetPendingQuestions(quests)
	return st, cs
}

func max1(v int) int {
	if v < 1 {
		return 1
	}
	return v
}

// ----------------------------------------------------------------------------
// Wire-shape replications (must stay byte-shape-identical to pkg/web)
// ----------------------------------------------------------------------------

// gzip64EnvelopeForTest replicates pkg/web/server.go maybeCompressSnapshot
// byte-for-byte: gzip at the DEFAULT level (gzip.NewWriter — the "z=1" query
// param is the opt-in FLAG, not a compression level), then the
// {"encoding":"gzip64","data":base64} envelope. Returns the exact HTTP body
// bytes a z=1 client receives. The 2 KiB threshold is asserted by callers,
// not re-implemented here (all measured payloads exceed it).
func gzip64EnvelopeForTest(raw []byte) []byte {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf) // default level, same as maybeCompressSnapshot
	_, _ = gw.Write(raw)
	if err := gw.Close(); err != nil {
		panic(err)
	}
	out, err := json.Marshal(struct {
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	}{Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes())})
	if err != nil {
		panic(err)
	}
	return out
}

// fleetGatesProjectForTest replicates pkg/web fleetGatesProject (dir + gate
// pair, same tags/field order).
type fleetGatesProjectForTest struct {
	Dir  string               `json:"dir"`
	Gate map[string]GateFacts `json:"gate"`
}

// marshalLeanGatesBodyForTest replicates pkg/web handleFleetGates' response
// marshal exactly: {schema:1, fleet_selection, projects sorted by dir}, gate
// maps from Store.GateFactsFleetSelected(). Same fields, tags, and order —
// byte-identical to the real handler body for the same gate maps.
func marshalLeanGatesBodyForTest(dirs []string, stores []*Store) []byte {
	out := make([]fleetGatesProjectForTest, 0, len(stores))
	for k, st := range stores {
		out = append(out, fleetGatesProjectForTest{Dir: dirs[k], Gate: st.GateFactsFleetSelected()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	b, err := json.Marshal(struct {
		Schema         int                        `json:"schema"`
		FleetSelection string                     `json:"fleet_selection"`
		Projects       []fleetGatesProjectForTest `json:"projects"`
	}{Schema: 1, FleetSelection: FleetSelectionRootUnarchivedV1, Projects: out})
	if err != nil {
		panic(err)
	}
	return b
}

// ----------------------------------------------------------------------------
// C-F2: payload measurement receipts
// ----------------------------------------------------------------------------

// TestFleetPayloadMeasurementReceipts measures the three wire shapes on the
// representative fixture and logs the receipts table. Byte sizes are
// deterministic given the fixture, so this is a stable test (asserts
// structural facts, never timing). Run with -v to capture the table.
//
// What is measured vs computed:
//   - MEASURED (in-process, real production code paths): Snapshot(empty
//     filter) marshal bytes per project (the fallback's actual JSON), the
//     complete GateFacts() map marshal, the selected GateFactsFleetSelected()
//     map marshal, the batched lean body marshal, and each payload's gzip64
//     envelope bytes via the replicated worker envelope.
//   - COMPUTED from those measurements: all reduction percentages and
//     per-session/per-selected-root byte costs.
func TestFleetPayloadMeasurementReceipts(t *testing.T) {
	fx := fleetFixtureFor(fleetShapeRepresentative)
	t.Logf("fixture shape=%s %s", fx.shape, fx.stats.String())
	t.Logf("context (quoted from the dispatching brief, not measured here): operator live fleet = 5,105 sessions across 7 projects")

	treeOnly := func() map[string]bool { return map[string]bool{} } // the fallback's no-sessions-param filter shape

	// (a) Fallback wire: one tree-only snapshot envelope per project.
	var fallbackRaw, fallbackGz int64
	var perProj []string
	for k, st := range fx.stores {
		snap := st.Snapshot(treeOnly())
		raw, err := json.Marshal(snap)
		if err != nil {
			t.Fatalf("marshal snapshot: %v", err)
		}
		gz := gzip64EnvelopeForTest(raw)
		if len(raw) < fleetGzipThreshold {
			t.Fatalf("project %d raw %d < threshold %d — gzip would not engage; fixture too small", k, len(raw), fleetGzipThreshold)
		}
		fallbackRaw += int64(len(raw))
		fallbackGz += int64(len(gz))
		perProj = append(perProj, fmt.Sprintf("%s:%d/%d", fx.dirs[k], len(raw), len(gz)))
	}

	// (b) Complete gate map, isolated from the envelope (per project).
	var gateRaw, gateGz int64
	for _, st := range fx.stores {
		raw, err := json.Marshal(st.GateFacts())
		if err != nil {
			t.Fatalf("marshal gate map: %v", err)
		}
		gateRaw += int64(len(raw))
		gateGz += int64(len(gzip64EnvelopeForTest(raw)))
	}

	// (c2) Selected-only gate map, still isolated (selection filtering alone,
	// no lean envelope overhead): per-project marshal sum.
	var selRaw, selGz int64
	var selEntries int
	for _, st := range fx.stores {
		m := st.GateFactsFleetSelected()
		selEntries += len(m)
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("marshal selected gate map: %v", err)
		}
		selRaw += int64(len(raw))
		selGz += int64(len(gzip64EnvelopeForTest(raw)))
	}

	// (c) The lean batched /vh/gates body (the actual lean wire: ONE response
	// for all seven projects, envelope included).
	leanRawB := marshalLeanGatesBodyForTest(fx.dirs, fx.stores)
	leanRaw := int64(len(leanRawB))
	leanGz := int64(len(gzip64EnvelopeForTest(leanRawB)))

	pct := func(num, den int64) string {
		if den == 0 {
			return "n/a"
		}
		return fmt.Sprintf("%.1f%%", 100*(1-float64(num)/float64(den)))
	}

	t.Logf("=== C-F2 payload receipts (bytes; raw/gzip64 = the z=1 HTTP body) ===")
	t.Logf("fallback per project raw/gz: %s", strings.Join(perProj, "  "))
	t.Logf("FALLBACK total  (7 snapshots, incl. sessions): raw=%d gz=%d (%.0f B/session raw)", fallbackRaw, fallbackGz, float64(fallbackRaw)/float64(fx.stats.LiveSessions))
	t.Logf("COMPLETE GATE MAP (isolated, no envelope):     raw=%d gz=%d (%.0f B/session raw)", gateRaw, gateGz, float64(gateRaw)/float64(fx.stats.LiveSessions))
	t.Logf("SELECTED GATE MAP (isolated, selection only):  raw=%d gz=%d (%d entries)", selRaw, selGz, selEntries)
	t.Logf("LEAN /vh/gates body (ONE batched response):    raw=%d gz=%d (%.0f B/selected-root raw)", leanRaw, leanGz, float64(leanRaw)/float64(fx.stats.SelectedRoots))
	t.Logf("--- reductions (computed from the measurements above) ---")
	t.Logf("wire-to-wire (lean gz vs fallback gz total):        %s", pct(leanGz, fallbackGz))
	t.Logf("wire-to-wire (lean raw vs fallback raw total):      %s", pct(leanRaw, fallbackRaw))
	t.Logf("selection-only within gate vocabulary (raw):        %s", pct(selRaw, gateRaw))
	t.Logf("selection-only within gate vocabulary (gz):         %s", pct(selGz, gateGz))
	t.Logf("envelope share of fallback (gate map vs envelope, raw): gate map is %s of the fallback envelope", fmt.Sprintf("%.1f%%", 100*float64(gateRaw)/float64(fallbackRaw)))

	// Structural sanity (deterministic; guards the receipts' meaning).
	if leanGz >= fallbackGz {
		t.Fatalf("lean gz %d >= fallback gz %d — the lean path must be smaller on this fixture", leanGz, fallbackGz)
	}
	if leanRaw >= fallbackRaw {
		t.Fatalf("lean raw %d >= fallback raw %d", leanRaw, fallbackRaw)
	}
	if selRaw >= gateRaw {
		t.Fatalf("selected gate map raw %d >= complete gate map raw %d", selRaw, gateRaw)
	}
	if gateRaw >= fallbackRaw {
		t.Fatalf("isolated gate map raw %d >= full envelope raw %d — sessions must dominate the envelope", gateRaw, fallbackRaw)
	}
	if selEntries != fx.stats.SelectedRoots {
		t.Fatalf("selected entries %d != fixture selected %d", selEntries, fx.stats.SelectedRoots)
	}
	// The fixture's honest population ratio — the selection denominator.
	t.Logf("selected population: %d of %d live sessions (%.1f%%)", fx.stats.SelectedRoots, fx.stats.LiveSessions, 100*float64(fx.stats.SelectedRoots)/float64(fx.stats.LiveSessions))
}

// ----------------------------------------------------------------------------
// D-F2 (lock evidence): TryLock hold probe
// ----------------------------------------------------------------------------

// TestFleetLockHoldProbeReceipts directly measures store-lock hold episodes
// on the REAL capture paths without production instrumentation, using
// sync.RWMutex.TryLock as the probe, and logs same-process cross-checks of
// the phase decomposition the benchmarks report.
//
// WHAT IS MEASURED (and the inference chain, stated):
//   - GateFactsFleetSelected / GateFacts: their RLock span structurally
//     covers 100% of the call (single RLock at entry, defer RUnlock, all
//     work inside — snapshots.go). End-to-end call duration IS the lock-hold
//     duration; the TryLock probe independently confirms the mutex is
//     continuously held for that span.
//   - Snapshot(treeOnly): the WRITE lock spans flush + capture only;
//     materialization runs after Unlock. The probe measures the actual held
//     windows (failure streaks of TryLock on the write-locked mutex); the
//     same-process phase timings (flush-noop + capture, materialize) show
//     the decomposition the streaks should track.
//   - PROBE CAVEAT (labeled, not hidden): the TryLock CAS loop adds a small
//     contention overhead to the measured path and the streak resolution is
//     the probe loop's period (sub-microsecond). Streaks are a direct
//     observation of held episodes, slightly inflated by probe interference.
func TestFleetLockHoldProbeReceipts(t *testing.T) {
	fx := fleetFixtureFor(fleetShapeRepresentative)
	st := fx.stores[0]
	n := len(st.sessions)

	// --- Phase timings (same-process cross-check for the benchmarks). ---
	var flushSum, captureSum, matSum, dfsSum time.Duration
	const tries = 20
	for i := 0; i < tries; i++ {
		st.mu.Lock()
		t0 := time.Now()
		st.flushAllBufferedDeltasLocked()
		flushSum += time.Since(t0)
		t1 := time.Now()
		dfsSink = st.computeFleetAggregatesLocked()
		dfsSum += time.Since(t1)
		t2 := time.Now()
		c := st.captureSnapshotLocked(map[string]bool{})
		captureSum += time.Since(t2)
		st.mu.Unlock()
		t3 := time.Now()
		snapSink = st.materializeSnapshot(c)
		matSum += time.Since(t3)
	}
	t.Logf("phase means over %d tries (n=%d sessions): dfs=%v capture(incl dfs)=%v flush-noop=%v materialize(no lock)=%v",
		tries, n, dfsSum/tries, captureSum/tries, flushSum/tries, matSum/tries)

	// --- Probe: write-lock hold during Snapshot(treeOnly). ---
	runProbe := func(label string, work func()) (streakCount int, meanStreak, maxStreak time.Duration, workMean time.Duration) {
		stop := make(chan struct{})
		var durations []time.Duration
		var wg sync.WaitGroup
		wg.Add(1)
		go func() { // probe goroutine
			defer wg.Done()
			var open time.Time
			for {
				select {
				case <-stop:
					if !open.IsZero() {
						durations = append(durations, time.Since(open))
					}
					return
				default:
				}
				if st.mu.TryLock() {
					if !open.IsZero() {
						durations = append(durations, time.Since(open))
						open = time.Time{}
					}
					st.mu.Unlock()
				} else if open.IsZero() {
					open = time.Now()
				}
			}
		}()
		const iters = 25
		start := time.Now()
		for i := 0; i < iters; i++ {
			work()
		}
		total := time.Since(start)
		close(stop)
		wg.Wait()
		var sum, mx time.Duration
		for _, d := range durations {
			sum += d
			if d > mx {
				mx = d
			}
		}
		if len(durations) > 0 {
			meanStreak = sum / time.Duration(len(durations))
		}
		maxStreak = mx
		streakCount = len(durations)
		workMean = total / iters
		t.Logf("%s: %d held-episodes observed; mean streak=%v max=%v; mean end-to-end call=%v (episodes/call≈%.1f)",
			label, streakCount, meanStreak, maxStreak, workMean, float64(streakCount)/float64(iters))
		return
	}

	sc, sMean, _, sWork := runProbe("Snapshot(treeOnly) write-lock hold (fallback capture path)", func() {
		snapSink = st.Snapshot(map[string]bool{})
	})
	_ = sc

	gc, gMean, _, gWork := runProbe("GateFactsFleetSelected RLock hold (lean path)", func() {
		gatesSink = st.GateFactsFleetSelected()
	})
	_ = gc

	// Structural sanity only — no tight timing asserts (machine-dependent).
	// A held episode is a SUBSET of one work() call, so the MEAN streak must
	// sit under the mean end-to-end call (with headroom for probe-loop
	// granularity). MAX streaks are receipts only — a max streak may exceed
	// the MEAN call (the slowest episode rides the slowest call), so they are
	// logged, never asserted.
	if sMean > 2*sWork {
		t.Fatalf("snapshot mean streak %v > 2x mean end-to-end %v — probe inconsistent", sMean, sWork)
	}
	if gMean > 2*gWork {
		t.Fatalf("gates mean streak %v > 2x end-to-end %v — unexpected", gMean, gWork)
	}
}

// Sinks defeat dead-code elimination in benchmarks/probes.
var (
	dfsSink     map[string]fleetNodeAgg
	snapSink    Snapshot
	gatesSink   map[string]GateFacts
	captureSink snapshotCapture
)

// ----------------------------------------------------------------------------
// D-F2: benchmarks — DFS, capture paths, phases
// ----------------------------------------------------------------------------

// benchOneStore picks the fixture's largest store as the benchmark unit (a
// per-project capture is the operation the fleet paths actually run; ~850
// sessions here, vs the 729 mean).
func benchOneStore(fx *fleetFixture) *Store {
	best := fx.stores[0]
	for _, st := range fx.stores {
		if len(st.sessions) > len(best.sessions) {
			best = st
		}
	}
	return best
}

// BenchmarkFleetAggregatesDFS measures the memoized cycle-guarded DFS alone
// (computeFleetAggregatesLocked under RLock) — the shared aggregation core
// every fleet capture path runs.
func BenchmarkFleetAggregatesDFS(b *testing.B) {
	for _, shape := range fleetShapeOrder {
		b.Run(shape, func(b *testing.B) {
			st := benchOneStore(fleetFixtureFor(shape))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				st.mu.RLock()
				dfsSink = st.computeFleetAggregatesLocked()
				st.mu.RUnlock()
			}
		})
	}
}

// BenchmarkGateFactsComplete measures the complete lean accessor (every
// session). Its single RLock span covers the whole call, so ns/op IS the
// RLock-hold duration for this path (see TestFleetLockHoldProbeReceipts).
func BenchmarkGateFactsComplete(b *testing.B) {
	for _, shape := range fleetShapeOrder {
		b.Run(shape, func(b *testing.B) {
			st := benchOneStore(fleetFixtureFor(shape))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				gatesSink = st.GateFacts()
			}
		})
	}
}

// BenchmarkGateFactsFleetSelected measures the selected-only lean accessor
// behind GET /vh/gates. Single RLock span ⇒ ns/op is the hold duration.
func BenchmarkGateFactsFleetSelected(b *testing.B) {
	for _, shape := range fleetShapeOrder {
		b.Run(shape, func(b *testing.B) {
			st := benchOneStore(fleetFixtureFor(shape))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				gatesSink = st.GateFactsFleetSelected()
			}
		})
	}
}

// BenchmarkSnapshotCaptureTreeOnly measures the fallback's end-to-end capture
// (Snapshot with an empty filter): write-lock span (flush+capture) PLUS the
// lock-free materialization. Use BenchmarkSnapshotPhases to decompose.
func BenchmarkSnapshotCaptureTreeOnly(b *testing.B) {
	for _, shape := range fleetShapeOrder {
		b.Run(shape, func(b *testing.B) {
			st := benchOneStore(fleetFixtureFor(shape))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				snapSink = st.Snapshot(map[string]bool{})
			}
		})
	}
}

// BenchmarkSnapshotPhases decomposes the fallback capture on the
// representative store (plus the deep-chain stress shape):
//
//   - dfs-only:    computeFleetAggregatesLocked under RLock (the shared DFS)
//   - capture:     captureSnapshotLocked under RLock (includes the DFS)
//   - materialize: lock-free assembly from a pre-captured snapshotCapture
//   - flush-noop:  flushAllBufferedDeltasLocked under the write lock on a
//     quiescent store (the fixture buffers no deltas, so this is the no-op
//     scan cost; the write-lock hold of Snapshot ≈ flush-noop + capture)
func BenchmarkSnapshotPhases(b *testing.B) {
	for _, shape := range []string{fleetShapeRepresentative, fleetShapeDeepChain} {
		st := benchOneStore(fleetFixtureFor(shape))
		b.Run(shape+"/dfs-only", func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				st.mu.RLock()
				dfsSink = st.computeFleetAggregatesLocked()
				st.mu.RUnlock()
			}
		})
		b.Run(shape+"/capture", func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				st.mu.RLock()
				captureSink = st.captureSnapshotLocked(map[string]bool{})
				st.mu.RUnlock()
			}
		})
		b.Run(shape+"/materialize", func(b *testing.B) {
			st.mu.RLock()
			c := st.captureSnapshotLocked(map[string]bool{})
			st.mu.RUnlock()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				snapSink = st.materializeSnapshot(c)
			}
		})
		b.Run(shape+"/flush-noop", func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				st.mu.Lock()
				st.flushAllBufferedDeltasLocked()
				st.mu.Unlock()
			}
		})
	}
}

// ----------------------------------------------------------------------------
// D-F2: writer contention
// ----------------------------------------------------------------------------

// BenchmarkFleetWriterUpsert measures a realistic writer — a session.updated
// Apply (entry replace + 7 index maintainers on the same-parent fast path +
// last-assistant recompute + emit) — alone and against a CONTINUOUS capture
// loop. Contention variants deliberately omit b.ReportAllocs: the background
// capture goroutine's allocations would be attributed to this benchmark's
// B/op (Go counts allocations process-wide during the run), so its
// alloc/op numbers would be contaminated; ns/op writer latency is the
// measurement. The tight capture loop is a WORST CASE (a real fleet poller
// captures periodically, not continuously).
func BenchmarkFleetWriterUpsert(b *testing.B) {
	const n = 850 // the largest representative project
	st, cs := seedFleetStore("pW", n, fleetShapeRepresentative)
	_ = cs

	// Pre-build 64 churn payloads OUTSIDE the timed loop (the writer cost we
	// want is the reducer's, not fmt.Sprintf's). Each payload PRESERVES the
	// target's real parentID so the upsert exercises the same-parent fast
	// path (a title/metadata refresh) — reparenting on every op would run
	// full index maintenance and distort the store shape mid-benchmark.
	type target struct{ id, parent string }
	var targetsInfo []target
	st.mu.RLock()
	for k := 0; k < 64; k++ {
		sid := fmt.Sprintf("pW_s%05d", k*7%n)
		if se := st.sessions[sid]; se != nil {
			targetsInfo = append(targetsInfo, target{id: sid, parent: se.parentID})
		}
	}
	st.mu.RUnlock()
	if len(targetsInfo) == 0 {
		b.Fatal("no churn targets resolved — fixture id scheme drifted")
	}
	targets := make([]string, 0, len(targetsInfo))
	for k, tg := range targetsInfo {
		title := fmt.Sprintf("%s (churn %d)", fleetTitlePool[k%len(fleetTitlePool)], k)
		created := 1_750_000_000_000.0 + float64(k)*61_000
		parent := ""
		if tg.parent != "" {
			parent = fmt.Sprintf(`,"parentID":%q`, tg.parent)
		}
		targets = append(targets, fmt.Sprintf(`{"info":{"id":%q,"projectID":"pW","title":%q,"directory":"/home/op/work/srv-W","model":{"providerID":"anthropic","id":"claude-sonnet-4-5","variant":"default"}%s,"time":{"created":%.0f,"updated":%.0f}}}`,
			tg.id, title, parent, created, created+300_000+float64(k)*1000))
	}

	b.Run("baseline", func(b *testing.B) {
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			st.Apply(ev("session.updated", targets[i%len(targets)]))
		}
	})

	spawnCapture := func(work func()) (stop, done chan struct{}) {
		stop = make(chan struct{})
		done = make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-stop:
					return
				default:
					work()
				}
			}
		}()
		return stop, done
	}

	b.Run("during-lean-capture", func(b *testing.B) {
		stop, done := spawnCapture(func() { gatesSink = st.GateFactsFleetSelected() })
		b.Cleanup(func() { close(stop); <-done })
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			st.Apply(ev("session.updated", targets[i%len(targets)]))
		}
	})

	b.Run("during-snapshot-capture", func(b *testing.B) {
		stop, done := spawnCapture(func() { snapSink = st.Snapshot(map[string]bool{}) })
		b.Cleanup(func() { close(stop); <-done })
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			st.Apply(ev("session.updated", targets[i%len(targets)]))
		}
	})
}
