package web

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// newLabelTestStore builds a LabelStore rooted at a fresh temp dir so each test
// gets a clean filesystem. The returned path is <root>/labels.json.
func newLabelTestStore(t *testing.T) (*LabelStore, string) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "labels.json")
	st, err := NewLabelStore(path)
	if err != nil {
		t.Fatalf("NewLabelStore(%s): %v", path, err)
	}
	return st, path
}

// mustReplaceLabels is a Replace that fatals on error or ok=false (used when the
// test expects success). Returns the post-replace snapshot.
func mustReplaceLabels(t *testing.T, s *LabelStore, baseRevision int64, doc LabelsDoc, activeRootProjects map[string]string) LabelsDoc {
	t.Helper()
	ok, cur, err := s.Replace(baseRevision, doc, activeRootProjects)
	if err != nil {
		t.Fatalf("Replace err: %v", err)
	}
	if !ok {
		t.Fatalf("Replace ok=false, want true (baseRevision=%d)", baseRevision)
	}
	return cur
}

// expectRejection is a Replace that must fail with a *LabelRejection of the
// given reason. It fatals if the call succeeded, returned ok=false (CAS), or
// returned a non-rejection error.
func expectRejection(t *testing.T, s *LabelStore, baseRevision int64, doc LabelsDoc, activeRootProjects map[string]string, wantReason LabelRejectionReason) {
	t.Helper()
	ok, _, err := s.Replace(baseRevision, doc, activeRootProjects)
	if ok {
		t.Fatalf("Replace ok=true, want rejection %s", wantReason)
	}
	if err == nil {
		t.Fatalf("Replace returned CAS mismatch (ok=false, err=nil), want rejection %s", wantReason)
	}
	rej, isRej := err.(*LabelRejection)
	if !isRej {
		t.Fatalf("Replace err = %T %v, want *LabelRejection %s", err, err, wantReason)
	}
	if rej.Reason != wantReason {
		t.Fatalf("Replace rejection reason = %s, want %s (detail: %s ids: %v)", rej.Reason, wantReason, rej.Detail, rej.IDs)
	}
}

// minimalValidDoc builds a LabelsDoc that passes validation given activeRoots:
// one group "g1" (blue) referencing roots in groupRoots, one tag "t1" (red), and
// the given tag assignments. Caller controls which roots are referenced so the
// unknown-root check can be exercised precisely.
func minimalValidDoc(groupRoots []string, tagAssign map[string][]string) LabelsDoc {
	return LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "Group One", Color: "blue", OrderedRootSessionIDs: groupRoots},
		},
		Tags: []LabelTag{
			{ID: "t1", Name: "urgent", Color: "red"},
		},
		TagIDsByRootSessionID: tagAssign,
	}
}

// readPersisted unmarshals the on-disk labels.json into a labelsFile for tests
// that must inspect the PRIVATE schemaVersion / projectByRootSessionId fields.
func readPersisted(t *testing.T, path string) labelsFile {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	var lf labelsFile
	if err := json.Unmarshal(raw, &lf); err != nil {
		t.Fatalf("Unmarshal persisted: %v\nraw: %s", err, raw)
	}
	return lf
}

// 1. Missing file → NewLabelStore returns a zero doc and does NOT create a file.
func TestLabelStoreMissingFileReturnsZeroDoc(t *testing.T) {
	st, path := newLabelTestStore(t)
	snap := st.Snapshot()
	if snap.Revision != 0 {
		t.Fatalf("Revision = %d, want 0", snap.Revision)
	}
	if len(snap.Groups) != 0 {
		t.Fatalf("Groups = %v, want empty", snap.Groups)
	}
	if len(snap.Tags) != 0 {
		t.Fatalf("Tags = %v, want empty", snap.Tags)
	}
	if snap.TagIDsByRootSessionID == nil || len(snap.TagIDsByRootSessionID) != 0 {
		t.Fatalf("TagIDsByRootSessionID = %v, want non-nil empty map", snap.TagIDsByRootSessionID)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing-file load should NOT create a file; stat err=%v", err)
	}
}

// 2. Replace with a matching baseRevision persists to disk, increments
// revision, and round-trips through a second NewLabelStore with the exact JSON
// field order: schemaVersion, revision, groups, tags, tagIdsByRootSessionId,
// projectByRootSessionId.
func TestLabelStoreReplacePersistsRoundTripsAndFieldOrder(t *testing.T) {
	st, path := newLabelTestStore(t)

	activeRoots := map[string]string{"r1": "projA", "r2": "projA", "r3": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "Backend", Color: "blue", Collapsed: true, OrderedRootSessionIDs: []string{"r1", "r2"}},
			{ID: "g2", Name: "Frontend", Color: "green", OrderedRootSessionIDs: []string{"r3"}},
		},
		Tags: []LabelTag{
			{ID: "t1", Name: "urgent", Color: "red"},
			{ID: "t2", Name: "bug", Color: "orange"},
		},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1", "t2"},
			"r2": {"t2"},
			"r3": {"t1"},
		},
	}

	cur := mustReplaceLabels(t, st, 0, doc, activeRoots)
	if cur.Revision != 1 {
		t.Fatalf("Revision = %d, want 1", cur.Revision)
	}
	if len(cur.Groups) != 2 || cur.Groups[0].ID != "g1" || len(cur.Groups[0].OrderedRootSessionIDs) != 2 {
		t.Fatalf("post-replace groups = %+v", cur.Groups)
	}
	if cur.Groups[0].OrderedRootSessionIDs[0] != "r1" || cur.Groups[0].OrderedRootSessionIDs[1] != "r2" {
		t.Fatalf("g1 root order = %v, want [r1 r2]", cur.Groups[0].OrderedRootSessionIDs)
	}
	if !cur.Groups[0].Collapsed {
		t.Fatal("g1 Collapsed = false, want true (persisted)")
	}
	if len(cur.Tags) != 2 {
		t.Fatalf("Tags = %+v, want 2", cur.Tags)
	}
	if got := cur.TagIDsByRootSessionID["r1"]; len(got) != 2 || got[0] != "t1" || got[1] != "t2" {
		t.Fatalf("tag assign r1 = %v, want [t1 t2]", got)
	}

	// Reload from disk: values must round-trip.
	st2, err := NewLabelStore(path)
	if err != nil {
		t.Fatalf("reload NewLabelStore: %v", err)
	}
	reloaded := st2.Snapshot()
	if reloaded.Revision != 1 || len(reloaded.Groups) != 2 || len(reloaded.Tags) != 2 {
		t.Fatalf("reload drifted: %+v", reloaded)
	}
	if !reloaded.Groups[0].Collapsed || reloaded.Groups[0].OrderedRootSessionIDs[0] != "r1" {
		t.Fatalf("reload group0 = %+v", reloaded.Groups[0])
	}

	// Pin the exact persisted JSON field order (declaration + embed-promotion
	// order): schemaVersion, revision, groups, tags, tagIdsByRootSessionId,
	// projectByRootSessionId.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	keys := []string{
		`"schemaVersion"`,
		`"revision"`,
		`"groups"`,
		`"tags"`,
		`"tagIdsByRootSessionId"`,
		`"projectByRootSessionId"`,
	}
	prev := -1
	for _, k := range keys {
		idx := bytes.Index(raw, []byte(k))
		if idx < 0 {
			t.Fatalf("persisted JSON missing key %s in: %s", k, raw)
		}
		if idx <= prev {
			t.Fatalf("field-order drift: key %s at byte %d not after prev %d: %s", k, idx, prev, raw)
		}
		prev = idx
	}
	// projectByRootSessionId must carry all three referenced roots with projA.
	lf := readPersisted(t, path)
	if lf.ProjectByRootSessionID["r1"] != "projA" || lf.ProjectByRootSessionID["r2"] != "projA" || lf.ProjectByRootSessionID["r3"] != "projA" {
		t.Fatalf("project sidecar = %v, want r1/r2/r3 -> projA", lf.ProjectByRootSessionID)
	}
	// Sanity: re-marshal of the reloaded private doc reproduces the same bytes
	// (no round-trip drift).
	reMarshal, err := json.MarshalIndent(lf, "", "  ")
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	if !bytes.Equal(raw, reMarshal) {
		t.Fatalf("reload bytes drifted from disk:\nDisk: %s\nReload: %s", raw, reMarshal)
	}
}

// 3. Replace with a mismatched baseRevision returns ok=false and does NOT touch
// the disk file (content byte-identical, no temp siblings left behind).
func TestLabelStoreReplaceMismatchedRevisionDoesNotTouchDisk(t *testing.T) {
	st, path := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	mustReplaceLabels(t, st, 0, minimalValidDoc([]string{"r1"}, nil), activeRoots)

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}

	ok, cur, err := st.Replace(2, minimalValidDoc([]string{"r1"}, nil), activeRoots)
	if err != nil {
		t.Fatalf("mismatched Replace err: %v", err)
	}
	if ok {
		t.Fatal("mismatched Replace: ok=true, want false")
	}
	if cur.Revision != 1 {
		t.Fatalf("mismatched Replace returned mutated snapshot: %+v", cur)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("mismatched Replace mutated disk:\nbefore: %s\nafter:  %s", before, after)
	}
	if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
		t.Fatalf("expected 0 temp files after mismatched Replace, got %d", n)
	}
}

// 4. Corrupt-on-disk JSON (or wrong schemaVersion) → NewLabelStore returns a
// zero doc in memory without panicking, and does NOT rewrite the on-disk file.
func TestLabelStoreCorruptOrSchemaMismatchResetsToZeroDoc(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"malformed_json", []byte(`{"schemaVersion":1,"revision":1,"groups":[ BROKEN`)},
		{"wrong_schema", []byte(`{"schemaVersion":2,"revision":1,"groups":[],"tags":[],"tagIdsByRootSessionId":{}}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "labels.json")
			if err := os.WriteFile(path, tc.body, 0o644); err != nil {
				t.Fatal(err)
			}
			st, err := NewLabelStore(path)
			if err != nil {
				t.Fatalf("NewLabelStore on %s: err=%v, want nil (resilient reset)", tc.name, err)
			}
			snap := st.Snapshot()
			if snap.Revision != 0 || len(snap.Groups) != 0 || len(snap.Tags) != 0 {
				t.Fatalf("%s: snap = %+v, want zero doc", tc.name, snap)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if !bytes.Equal(got, tc.body) {
				t.Fatalf("%s: on-disk file rewritten by read:\nbefore: %s\nafter:  %s", tc.name, tc.body, got)
			}
		})
	}
}

// 5. Snapshot is a deep copy: mutating the returned Groups / nested root lists
// / Tags / TagIDsByRootSessionID (incl. per-root tag slices) MUST NOT leak into
// the store.
func TestLabelStoreSnapshotIsImmutableToCaller(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA", "r2": "projA"}
	mustReplaceLabels(t, st, 0, LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "G", Color: "blue", OrderedRootSessionIDs: []string{"r1", "r2"}},
		},
		Tags:                  []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{"r1": {"t1"}},
	}, activeRoots)

	snap := st.Snapshot()
	// Mutate every reachable collection on the returned snapshot.
	snap.Groups[0].Name = "MUTATED"
	snap.Groups[0].Color = "red"
	snap.Groups[0].OrderedRootSessionIDs[0] = "MUTATED"
	snap.Groups[0].OrderedRootSessionIDs = append(snap.Groups[0].OrderedRootSessionIDs, "EXTRA")
	snap.Tags[0].Name = "MUTATED"
	snap.TagIDsByRootSessionID["r1"][0] = "MUTATED"
	snap.TagIDsByRootSessionID["injected"] = []string{"x"}
	delete(snap.TagIDsByRootSessionID, "r1")

	again := st.Snapshot()
	if again.Groups[0].Name != "G" || again.Groups[0].Color != "blue" {
		t.Fatalf("caller mutation leaked into store: group0=%+v", again.Groups[0])
	}
	if again.Groups[0].OrderedRootSessionIDs[0] != "r1" || len(again.Groups[0].OrderedRootSessionIDs) != 2 {
		t.Fatalf("caller mutation leaked into store root list: %v", again.Groups[0].OrderedRootSessionIDs)
	}
	if again.Tags[0].Name != "T" {
		t.Fatalf("caller mutation leaked into store tags: %+v", again.Tags)
	}
	got := again.TagIDsByRootSessionID["r1"]
	if len(got) != 1 || got[0] != "t1" {
		t.Fatalf("caller mutation leaked into store tag assign r1: %v", got)
	}
	if _, ok := again.TagIDsByRootSessionID["injected"]; ok {
		t.Fatalf("caller injected a tag-assign key into the store: %v", again.TagIDsByRootSessionID)
	}
}

// 6. Atomic save leaves no .tmp siblings after success OR after a simulated
// write failure (a rename that fails post-temp-creation).
func TestLabelStoreAtomicSaveLeavesNoTemp(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		st, path := newLabelTestStore(t)
		activeRoots := map[string]string{"r1": "projA"}
		mustReplaceLabels(t, st, 0, minimalValidDoc([]string{"r1"}, nil), activeRoots)
		if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
			t.Fatalf("after successful Replace: expected 0 temp files, got %d", n)
		}
		if _, _, err := st.RemoveRootIDs([]string{"r1"}); err != nil {
			t.Fatalf("RemoveRootIDs: %v", err)
		}
		if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
			t.Fatalf("after successful RemoveRootIDs: expected 0 temp files, got %d", n)
		}
	})

	t.Run("write_failure_cleans_temp_and_rolls_back", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "labels.json")
		st, err := NewLabelStore(path)
		if err != nil {
			t.Fatalf("NewLabelStore: %v", err)
		}
		// Force the atomic rename to fail AFTER temp creation by making the
		// destination path an existing directory (EISDIR on rename). The
		// cleanup branch must remove the temp, and the in-memory doc must NOT
		// have mutated (candidate was never assigned).
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatalf("mkdir path-as-dir: %v", err)
		}
		activeRoots := map[string]string{"r1": "projA"}
		ok, _, err := st.Replace(0, minimalValidDoc([]string{"r1"}, nil), activeRoots)
		if err == nil {
			t.Fatal("Replace over a directory-destination: want rename error, got nil")
		}
		if ok {
			t.Fatal("Replace over a directory-destination: ok=true, want false")
		}
		if n := countTmpFiles(t, root); n != 0 {
			t.Fatalf("after failed Replace: expected 0 temp files, got %d", n)
		}
		snap := st.Snapshot()
		if snap.Revision != 0 || len(snap.Groups) != 0 {
			t.Fatalf("persist failure mutated in-memory doc: %+v", snap)
		}
	})
}

// 7. Each successful Replace bumps Revision by exactly 1 (monotonic).
func TestLabelStoreMonotonicRevision(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA", "r2": "projA", "r3": "projA"}
	roots := []string{"r1", "r2", "r3"}
	for i, rid := range roots {
		cur := mustReplaceLabels(t, st, int64(i), minimalValidDoc([]string{rid}, nil), activeRoots)
		if cur.Revision != int64(i+1) {
			t.Fatalf("iter %d: Revision = %d, want %d", i, cur.Revision, i+1)
		}
		if cur.Revision != st.Snapshot().Revision {
			t.Fatalf("iter %d: snapshot revision drifted from returned", i)
		}
	}
}

// 8. CAS concurrency: many goroutines race to Replace against the same
// baseRevision; under the mutex + CAS guard, exactly one wins, the rest observe
// ok=false, and the revision advances by exactly 1.
func TestLabelStoreReplaceConcurrentSingleWinner(t *testing.T) {
	st, _ := newLabelTestStore(t)
	const N = 25
	activeRoots := map[string]string{"rx": "projA"}
	var winners int64
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _, err := st.Replace(0, minimalValidDoc([]string{"rx"}, nil), activeRoots)
			if err != nil {
				t.Errorf("Replace err: %v", err)
				return
			}
			if ok {
				atomic.AddInt64(&winners, 1)
			}
		}()
	}
	wg.Wait()
	if winners != 1 {
		t.Fatalf("expected exactly 1 Replace winner, got %d", winners)
	}
	if got := st.Snapshot().Revision; got != 1 {
		t.Fatalf("post-concurrent-Replace: Revision=%d, want 1", got)
	}
}

// --- label-specific invariant tests -----------------------------------------

// 9. Exclusive-group violation: a root in two groups is rejected.
func TestLabelStoreRejectsExclusiveGroupViolation(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "G1", Color: "blue", OrderedRootSessionIDs: []string{"r1"}},
			{ID: "g2", Name: "G2", Color: "green", OrderedRootSessionIDs: []string{"r1"}},
		},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
	expectRejection(t, st, 0, doc, activeRoots, LabelRejectionExclusiveGroup)
}

// 10. Duplicate root within a single group's list is rejected.
func TestLabelStoreRejectsDuplicateRootInGroup(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "G1", Color: "blue", OrderedRootSessionIDs: []string{"r1", "r1"}},
		},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
	expectRejection(t, st, 0, doc, activeRoots, LabelRejectionDuplicateRootInGroup)
}

// 11. Dangling tag reference: a tag assignment references a tag id not in Tags.
func TestLabelStoreRejectsDanglingTagRef(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{},
		Tags:   []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1", "t-ghost"},
		},
	}
	expectRejection(t, st, 0, doc, activeRoots, LabelRejectionDanglingTagRef)
}

// 12. Unknown root: a referenced root not in the authoritative active-root
// inventory (and not retained) is rejected — the store enforces roots-only,
// NOT trusting the client.
func TestLabelStoreRejectsUnknownRoot(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"} // r2 deliberately absent
	doc := minimalValidDoc([]string{"r1", "r2"}, nil)
	expectRejection(t, st, 0, doc, activeRoots, LabelRejectionUnknownRoot)
	// A tag-only reference to an unknown root is also rejected.
	doc2 := LabelsDoc{
		Groups: []LabelGroup{},
		Tags:   []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{
			"r2": {"t1"}, // r2 not in activeRoots
		},
	}
	expectRejection(t, st, 0, doc2, activeRoots, LabelRejectionUnknownRoot)
}

// 13. Retained-root skip (anti-resurrection mirror): a root that is already in
// the current server doc is NOT re-validated against activeRootProjects, so a
// Replace right after the inventory stopped listing it still succeeds (cleanup,
// not Replace, evicts archived roots).
func TestLabelStoreRetainedRootSkipsRevalidation(t *testing.T) {
	st, _ := newLabelTestStore(t)
	// First Replace: r1 is a known root.
	mustReplaceLabels(t, st, 0, minimalValidDoc([]string{"r1"}, nil), map[string]string{"r1": "projA"})
	// Second Replace: r1 retained, but activeRootProjects no longer lists it.
	// Must still succeed (retained-skip) and keep r1's carried-over project.
	cur := mustReplaceLabels(t, st, 1, minimalValidDoc([]string{"r1"}, nil), map[string]string{})
	if cur.Revision != 2 {
		t.Fatalf("Revision = %d, want 2", cur.Revision)
	}
}

// 14. Bad color token: a group/tag color not in validColorTokens is rejected.
func TestLabelStoreRejectsBadColorToken(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	// Group bad color.
	docG := LabelsDoc{
		Groups:                []LabelGroup{{ID: "g1", Name: "G", Color: "chartreuse", OrderedRootSessionIDs: []string{"r1"}}},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
	expectRejection(t, st, 0, docG, activeRoots, LabelRejectionBadGroupColor)
	// Tag bad color.
	docT := LabelsDoc{
		Groups: []LabelGroup{},
		Tags:   []LabelTag{{ID: "t1", Name: "T", Color: "#ff0000"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1"},
		},
	}
	expectRejection(t, st, 0, docT, activeRoots, LabelRejectionBadTagColor)
}

// 15. Empty / whitespace name: a group/tag name empty after trimming is rejected.
func TestLabelStoreRejectsEmptyName(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	// Group empty name.
	docG := LabelsDoc{
		Groups:                []LabelGroup{{ID: "g1", Name: "   ", Color: "blue", OrderedRootSessionIDs: []string{"r1"}}},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
	expectRejection(t, st, 0, docG, activeRoots, LabelRejectionEmptyGroupName)
	// Tag empty name.
	docT := LabelsDoc{
		Groups: []LabelGroup{},
		Tags:   []LabelTag{{ID: "t1", Name: "", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1"},
		},
	}
	expectRejection(t, st, 0, docT, activeRoots, LabelRejectionEmptyTagName)
}

// 16. Duplicate name (case-insensitive) within a collection is rejected.
func TestLabelStoreRejectsDuplicateNameCaseInsensitive(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	// Group duplicate name ci.
	docG := LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "Alpha", Color: "blue", OrderedRootSessionIDs: []string{"r1"}},
			{ID: "g2", Name: "alpha", Color: "green"}, // case-insensitive dupe
		},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
	expectRejection(t, st, 0, docG, activeRoots, LabelRejectionDuplicateGroupName)
	// Tag duplicate name ci.
	docT := LabelsDoc{
		Groups: []LabelGroup{},
		Tags: []LabelTag{
			{ID: "t1", Name: "Bug", Color: "red"},
			{ID: "t2", Name: "BUG", Color: "orange"}, // case-insensitive dupe
		},
		TagIDsByRootSessionID: map[string][]string{"r1": {"t1"}},
	}
	expectRejection(t, st, 0, docT, activeRoots, LabelRejectionDuplicateTagName)
}

// 17. Groups and tags are SEPARATE namespaces: a group and a tag may share a
// name without collision.
func TestLabelStoreGroupAndTagShareName(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{{ID: "g1", Name: "Shared", Color: "blue", OrderedRootSessionIDs: []string{"r1"}}},
		Tags:   []LabelTag{{ID: "t1", Name: "Shared", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1"},
		},
	}
	cur := mustReplaceLabels(t, st, 0, doc, activeRoots)
	if cur.Groups[0].Name != "Shared" || cur.Tags[0].Name != "Shared" {
		t.Fatalf("shared name not preserved: %+v / %+v", cur.Groups[0], cur.Tags[0])
	}
}

// 18. Too many groups / tags: exceeding the caps is rejected.
func TestLabelStoreRejectsCountCaps(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{}
	// Too many groups.
	tooManyGroups := make([]LabelGroup, 0, maxGroups+1)
	for i := 0; i <= maxGroups; i++ {
		tooManyGroups = append(tooManyGroups, LabelGroup{ID: "g" + strconv.Itoa(i), Name: "G" + strconv.Itoa(i), Color: "blue"})
	}
	expectRejection(t, st, 0, LabelsDoc{Groups: tooManyGroups, Tags: []LabelTag{}, TagIDsByRootSessionID: map[string][]string{}}, activeRoots, LabelRejectionTooManyGroups)
	// Too many tags.
	tooManyTags := make([]LabelTag, 0, maxTags+1)
	for i := 0; i <= maxTags; i++ {
		tooManyTags = append(tooManyTags, LabelTag{ID: "t" + strconv.Itoa(i), Name: "T" + strconv.Itoa(i), Color: "red"})
	}
	expectRejection(t, st, 0, LabelsDoc{Groups: []LabelGroup{}, Tags: tooManyTags, TagIDsByRootSessionID: map[string][]string{}}, activeRoots, LabelRejectionTooManyTags)
}

// 19. Definitions survive with zero assignments: a group with an empty root
// list and a tag with no assignments persist (invariant #6).
func TestLabelStoreDefinitionsSurviveZeroAssignments(t *testing.T) {
	st, _ := newLabelTestStore(t)
	cur := mustReplaceLabels(t, st, 0, LabelsDoc{
		Groups:                []LabelGroup{{ID: "g1", Name: "Empty Group", Color: "blue", OrderedRootSessionIDs: []string{}}},
		Tags:                  []LabelTag{{ID: "t1", Name: "Unused Tag", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{},
	}, map[string]string{})
	if len(cur.Groups) != 1 || cur.Groups[0].ID != "g1" || len(cur.Groups[0].OrderedRootSessionIDs) != 0 {
		t.Fatalf("empty group not preserved: %+v", cur.Groups)
	}
	if len(cur.Tags) != 1 || cur.Tags[0].ID != "t1" {
		t.Fatalf("unused tag not preserved: %+v", cur.Tags)
	}
}

// 20. Per-root tag lists are silently deduped (tags are not exclusive; a dupe
// is noise). The order is preserved (first occurrence wins).
func TestLabelStoreDedupesTagListSilently(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA"}
	doc := LabelsDoc{
		Groups: []LabelGroup{},
		Tags:   []LabelTag{{ID: "t1", Name: "T", Color: "red"}, {ID: "t2", Name: "U", Color: "orange"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t2", "t1", "t2", "t1", ""}, // dupes + an empty
		},
	}
	cur := mustReplaceLabels(t, st, 0, doc, activeRoots)
	got := cur.TagIDsByRootSessionID["r1"]
	if len(got) != 2 || got[0] != "t2" || got[1] != "t1" {
		t.Fatalf("deduped tag list = %v, want [t2 t1] (first-occurrence order, empties dropped)", got)
	}
}

// 21. RemoveRootIDs strips root refs from groups + tag assignments + project
// sidecar while PRESERVING group/tag definitions (invariant #7); idempotent and
// a no-op when nothing matches.
func TestLabelStoreRemoveRootIDsStripsRefsKeepsDefinitions(t *testing.T) {
	st, _ := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA", "r2": "projA", "r3": "projA"}
	mustReplaceLabels(t, st, 0, LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "G1", Color: "blue", OrderedRootSessionIDs: []string{"r1", "r2", "r3"}},
		},
		Tags: []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1"},
			"r2": {"t1"},
		},
	}, activeRoots)

	// Remove r1 + a not-referenced id r9.
	changed, cur, err := st.RemoveRootIDs([]string{"r1", "r9"})
	if err != nil {
		t.Fatalf("RemoveRootIDs: %v", err)
	}
	if !changed {
		t.Fatal("RemoveRootIDs([r1,r9]): changed=false, want true (r1 was referenced)")
	}
	if cur.Revision != 2 {
		t.Fatalf("RemoveRootIDs: Revision = %d, want 2", cur.Revision)
	}
	// r2,r3 remain in g1; r1 stripped.
	if len(cur.Groups) != 1 || cur.Groups[0].ID != "g1" {
		t.Fatalf("group definition not preserved: %+v", cur.Groups)
	}
	if got := cur.Groups[0].OrderedRootSessionIDs; len(got) != 2 || got[0] != "r2" || got[1] != "r3" {
		t.Fatalf("g1 root list after remove = %v, want [r2 r3]", got)
	}
	// Tag definitions preserved; r1 assignment gone, r2 assignment kept.
	if len(cur.Tags) != 1 || cur.Tags[0].ID != "t1" {
		t.Fatalf("tag definition not preserved: %+v", cur.Tags)
	}
	if _, ok := cur.TagIDsByRootSessionID["r1"]; ok {
		t.Fatalf("r1 tag assignment not stripped: %v", cur.TagIDsByRootSessionID)
	}
	if got := cur.TagIDsByRootSessionID["r2"]; len(got) != 1 || got[0] != "t1" {
		t.Fatalf("r2 tag assignment not preserved: %v", got)
	}

	// Idempotent: re-removing r1 is a no-op (changed=false, no bump).
	changed2, cur2, err := st.RemoveRootIDs([]string{"r1"})
	if err != nil {
		t.Fatalf("idempotent RemoveRootIDs([r1]): %v", err)
	}
	if changed2 {
		t.Fatal("idempotent RemoveRootIDs([r1]): changed=true, want false")
	}
	if cur2.Revision != 2 {
		t.Fatalf("idempotent RemoveRootIDs([r1]): Revision = %d, want 2", cur2.Revision)
	}
	// No-op when none match.
	changed3, cur3, err := st.RemoveRootIDs([]string{"never-was"})
	if err != nil {
		t.Fatalf("RemoveRootIDs([never-was]): %v", err)
	}
	if changed3 {
		t.Fatal("RemoveRootIDs([never-was]): changed=true, want false")
	}
	if cur3.Revision != 2 {
		t.Fatalf("RemoveRootIDs([never-was]): Revision = %d, want 2", cur3.Revision)
	}
	// Empty input is a no-op.
	changed4, _, err := st.RemoveRootIDs(nil)
	if err != nil {
		t.Fatalf("RemoveRootIDs(nil): %v", err)
	}
	if changed4 {
		t.Fatal("RemoveRootIDs(nil): changed=true, want false")
	}
}

// 22. Project sidecar carry-over vs new-root populate (mirrors pins' carry-over
// test, adapted for the labels roots-only rule): retained roots keep their
// prior project; newly-introduced roots get activeRootProjects[id]; dropped
// roots vanish from the sidecar. Verified by reading the private persisted file.
//
// NOTE on the pins difference: PinStore records a newly-added id NOT in
// activeSessionProjects as "" (a missing lookup never blocks). The label store
// instead REJECTS such a root (invariant #1: roots-only, enforced by the
// store), so every accepted root has a real project key here — the "" case
// never arises for labels and is intentionally NOT tested.
func TestLabelStoreReplaceCarriesOverAndPopulatesProjectSidecar(t *testing.T) {
	st, path := newLabelTestStore(t)
	// Initial: r1,r2 in g1, projects projA.
	mustReplaceLabels(t, st, 0, minimalValidDoc([]string{"r1", "r2"}, nil), map[string]string{"r1": "projA", "r2": "projA"})

	// Replace: keep r1 (retain), drop r2, add r3 (known projB). r1 is retained
	// so it keeps projA even though the new activeRootProjects maps r1 to projC
	// (carry-over wins); r3 is newly-introduced and gets projB from the map.
	cur := mustReplaceLabels(t, st, 1, minimalValidDoc([]string{"r3", "r1"}, nil), map[string]string{"r1": "projC", "r3": "projB"})
	if len(cur.Groups[0].OrderedRootSessionIDs) != 2 || cur.Groups[0].OrderedRootSessionIDs[0] != "r3" || cur.Groups[0].OrderedRootSessionIDs[1] != "r1" {
		t.Fatalf("g1 root order = %v, want [r3 r1]", cur.Groups[0].OrderedRootSessionIDs)
	}
	lf := readPersisted(t, path)
	if lf.ProjectByRootSessionID["r1"] != "projA" {
		t.Fatalf("carry-over failed: project[r1]=%q, want projA", lf.ProjectByRootSessionID["r1"])
	}
	if lf.ProjectByRootSessionID["r3"] != "projB" {
		t.Fatalf("new-root populate failed: project[r3]=%q, want projB", lf.ProjectByRootSessionID["r3"])
	}
	if _, ok := lf.ProjectByRootSessionID["r2"]; ok {
		t.Fatalf("dropped root r2 still in sidecar: %v", lf.ProjectByRootSessionID)
	}
}

// 23. Replace stores a DEEP COPY of the candidate: mutating the caller's input
// doc (Groups, nested OrderedRootSessionIDs, Tags, TagIDsByRootSessionID) AFTER
// a successful Replace MUST NOT drift the store's in-memory state OR rewrite
// disk — no CAS revision bump, no re-validation, no persist. Regression guard
// for the F1 input-aliasing hardening (mirrors PinStore's defensive copy).
//
// This is a true regression guard, not a tautology: under the old (aliased)
// store the candidate shared the caller's Groups/Tags slices and
// TagIDsByRootSessionID map with s.doc, so the field-reassign + map mutations
// below leak into in-memory state and the DeepEqual assertions fail.
func TestLabelStoreReplaceDeepCopiesInputDoc(t *testing.T) {
	st, path := newLabelTestStore(t)
	activeRoots := map[string]string{"r1": "projA", "r2": "projA"}
	input := LabelsDoc{
		Groups: []LabelGroup{
			{ID: "g1", Name: "Group One", Color: "blue", OrderedRootSessionIDs: []string{"r1", "r2"}},
		},
		Tags: []LabelTag{
			{ID: "t1", Name: "urgent", Color: "red"},
			{ID: "t2", Name: "bug", Color: "orange"},
		},
		TagIDsByRootSessionID: map[string][]string{
			"r1": {"t1", "t2"},
			"r2": {"t1"},
		},
	}
	committed := mustReplaceLabels(t, st, 0, input, activeRoots)
	if committed.Revision != 1 {
		t.Fatalf("Revision = %d, want 1", committed.Revision)
	}
	diskBefore, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before mutation: %v", err)
	}

	// Mutate EVERY reachable collection on the caller's input doc. Under the
	// aliased store these leak into s.doc; after the deep-copy fix the store
	// owns isolated memory and none of these reach it.
	// (a) Append to a group's OrderedRootSessionIDs + mutate an existing
	//     element in-bounds (reassigns the field through the shared struct in
	//     the Groups backing array; the in-bounds write hits the shared cleaned
	//     slice the validator allocated).
	input.Groups[0].OrderedRootSessionIDs = append(input.Groups[0].OrderedRootSessionIDs, "LEAKED-ROOT")
	input.Groups[0].OrderedRootSessionIDs[0] = "LEAKED-ROOT-0"
	//     Mutate an existing group's scalar fields (shared struct memory).
	input.Groups[0].Name = "LEAKED-NAME"
	input.Groups[0].Color = "red"
	// (b) Append a brand-new group + append to Tags (top-level slice appends,
	//     exercising the Groups/Tags backing-array aliasing surface).
	input.Groups = append(input.Groups, LabelGroup{ID: "leaked-g", Name: "Leaked", Color: "green"})
	input.Tags = append(input.Tags, LabelTag{ID: "leaked-t", Name: "Leaked", Color: "purple"})
	//     Mutate an existing tag's scalar field (shared struct memory).
	input.Tags[0].Name = "LEAKED-TAG-NAME"
	// (c) Add + mutate TagIDsByRootSessionID entries (shared map + shared
	//     per-root deduped value slices).
	input.TagIDsByRootSessionID["r1"][0] = "LEAKED-TAG"
	input.TagIDsByRootSessionID["newroot"] = []string{"leaked"}
	delete(input.TagIDsByRootSessionID, "r2")

	// Assert the store's in-memory snapshot is exactly the committed doc.
	after := st.Snapshot()
	if after.Revision != committed.Revision {
		t.Fatalf("post-mutation Revision = %d, want %d (input mutation must not bump revision)", after.Revision, committed.Revision)
	}
	if !reflect.DeepEqual(after.Groups, committed.Groups) {
		t.Fatalf("input mutation drifted store Groups:\n got  %+v\n want %+v", after.Groups, committed.Groups)
	}
	if !reflect.DeepEqual(after.Tags, committed.Tags) {
		t.Fatalf("input mutation drifted store Tags:\n got  %+v\n want %+v", after.Tags, committed.Tags)
	}
	if !reflect.DeepEqual(after.TagIDsByRootSessionID, committed.TagIDsByRootSessionID) {
		t.Fatalf("input mutation drifted store TagIDsByRootSessionID:\n got  %+v\n want %+v", after.TagIDsByRootSessionID, committed.TagIDsByRootSessionID)
	}

	// Assert the persisted file is unchanged (no spurious persist).
	diskAfter, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after mutation: %v", err)
	}
	if !bytes.Equal(diskBefore, diskAfter) {
		t.Fatalf("input mutation rewrote disk:\nbefore: %s\nafter:  %s", diskBefore, diskAfter)
	}
}
