package web

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// newPinTestStore builds a PinStore rooted at a fresh temp dir so each test gets
// a clean filesystem. The returned path is <root>/pins.json.
func newPinTestStore(t *testing.T) (*PinStore, string) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "pins.json")
	st, err := NewPinStore(path)
	if err != nil {
		t.Fatalf("NewPinStore(%s): %v", path, err)
	}
	return st, path
}

// mustReplace is a Replace that fatals on error (used when the test expects
// success). Returns the post-replace snapshot.
func mustReplace(t *testing.T, s *PinStore, baseRevision int64, newOrder []string, activeSessionProjects map[string]string, initializeOnly bool) PinsDoc {
	t.Helper()
	ok, cur, err := s.Replace(baseRevision, newOrder, activeSessionProjects, initializeOnly)
	if err != nil {
		t.Fatalf("Replace err: %v", err)
	}
	if !ok {
		t.Fatalf("Replace ok=false, want true (baseRevision=%d)", baseRevision)
	}
	return cur
}

// countTmpFiles returns the number of entries in dir whose name contains ".tmp".
// The atomic-write helpers name temps ".<base>.tmp-*", so this catches both
// dot-prefixed and bare temp leftovers. Used to pin the "no orphaned temp"
// contract after success and after a simulated write failure.
func countTmpFiles(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	var n int
	for _, e := range entries {
		if bytes.Contains([]byte(e.Name()), []byte(".tmp")) {
			n++
		}
	}
	return n
}

// 1. Missing file → NewPinStore returns an empty uninitialized doc and does NOT
// create a file on disk.
func TestPinStoreMissingFileReturnsZeroDoc(t *testing.T) {
	st, path := newPinTestStore(t)
	snap := st.Snapshot()
	if snap.SchemaVersion != pinsSchemaVersion {
		t.Fatalf("SchemaVersion = %d, want %d", snap.SchemaVersion, pinsSchemaVersion)
	}
	if snap.Initialized {
		t.Fatal("Initialized = true, want false")
	}
	if snap.Revision != 0 {
		t.Fatalf("Revision = %d, want 0", snap.Revision)
	}
	if len(snap.OrderedSessionIDs) != 0 {
		t.Fatalf("OrderedSessionIDs = %v, want empty", snap.OrderedSessionIDs)
	}
	if snap.ProjectBySessionID == nil || len(snap.ProjectBySessionID) != 0 {
		t.Fatalf("ProjectBySessionID = %v, want non-nil empty map", snap.ProjectBySessionID)
	}
	// No file created on disk by the read-only constructor.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing-file load should NOT create a file; stat err=%v", err)
	}
}

// 2. initializeOnly succeeds exactly once. A second initializeOnly (sequential,
// same baseRevision:0) returns ok=false without mutating.
func TestPinStoreInitializeOnlyOnce(t *testing.T) {
	st, _ := newPinTestStore(t)

	// First init: succeeds, sets Initialized, bumps revision to 1.
	cur := mustReplace(t, st, 0, []string{"a"}, map[string]string{"a": "proj-a"}, true)
	if !cur.Initialized {
		t.Fatal("after first init: Initialized = false, want true")
	}
	if cur.Revision != 1 {
		t.Fatalf("after first init: Revision = %d, want 1", cur.Revision)
	}
	if len(cur.OrderedSessionIDs) != 1 || cur.OrderedSessionIDs[0] != "a" {
		t.Fatalf("after first init: order = %v, want [a]", cur.OrderedSessionIDs)
	}
	if cur.ProjectBySessionID["a"] != "proj-a" {
		t.Fatalf("after first init: project[a] = %q, want proj-a", cur.ProjectBySessionID["a"])
	}

	// Second init: must fail (CAS/init mismatch) and NOT mutate.
	ok, cur2, err := st.Replace(0, []string{"b"}, map[string]string{"b": "proj-b"}, true)
	if err != nil {
		t.Fatalf("second init err: %v", err)
	}
	if ok {
		t.Fatal("second init: ok = true, want false (already initialized)")
	}
	if cur2.Revision != 1 {
		t.Fatalf("second init mutated revision: got %d, want 1", cur2.Revision)
	}
	if len(cur2.OrderedSessionIDs) != 1 || cur2.OrderedSessionIDs[0] != "a" {
		t.Fatalf("second init mutated order: got %v, want [a]", cur2.OrderedSessionIDs)
	}
	if cur2.ProjectBySessionID["b"] != "" || cur2.ProjectBySessionID["a"] != "proj-a" {
		t.Fatalf("second init mutated projects: %v", cur2.ProjectBySessionID)
	}
}

// TestPinStoreInitializeOnlyConcurrentSingleWinner is the -race concurrency
// variant of the once-only init contract: many goroutines race to initialize;
// under the mutex + init guard, exactly one wins and the rest observe ok=false.
func TestPinStoreInitializeOnlyConcurrentSingleWinner(t *testing.T) {
	st, _ := newPinTestStore(t)
	const N = 25
	var winners int64
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, _, err := st.Replace(0, []string{"x"}, nil, true)
			if err != nil {
				t.Errorf("init Replace err: %v", err)
				return
			}
			if ok {
				atomic.AddInt64(&winners, 1)
			}
		}()
	}
	wg.Wait()
	if winners != 1 {
		t.Fatalf("expected exactly 1 init winner, got %d", winners)
	}
	snap := st.Snapshot()
	if !snap.Initialized || snap.Revision != 1 {
		t.Fatalf("post-concurrent-init: Initialized=%v Revision=%d, want true/1", snap.Initialized, snap.Revision)
	}
}

// 3. Replace with matching baseRevision dedupes input (first wins), caps at 50,
// persists to disk, increments revision, sets Initialized=true. Reload via a
// second NewPinStore round-trips with the exact JSON field order.
func TestPinStoreReplaceDedupesCapsPersistsAndRoundTrips(t *testing.T) {
	st, path := newPinTestStore(t)

	// 51 IDs with a duplicate and an empty: normalize must drop the empty,
	// collapse the dup (first wins), and cap at 50 (dropping the 51st).
	order := make([]string, 0, 52)
	order = append(order, "first", "", "first") // empty + dupe of first
	for i := 0; i < 49; i++ {                   // 49 more → total unique non-empty = 50
		order = append(order, "s"+strconv.Itoa(i))
	}
	order = append(order, "overflow-51") // 51st unique → must be dropped by the cap

	projects := map[string]string{"first": "proj-first"}
	for i := 0; i < 49; i++ {
		projects["s"+strconv.Itoa(i)] = "proj-s" + strconv.Itoa(i)
	}
	// "overflow-51" deliberately absent from projects → recorded as "" if it
	// survived (it must NOT survive the cap, so this also pins the cap).

	cur := mustReplace(t, st, 0, order, projects, false)
	if !cur.Initialized {
		t.Fatal("Initialized = false, want true")
	}
	if cur.Revision != 1 {
		t.Fatalf("Revision = %d, want 1", cur.Revision)
	}
	if len(cur.OrderedSessionIDs) != 50 {
		t.Fatalf("order length = %d, want 50 (capped)", len(cur.OrderedSessionIDs))
	}
	if cur.OrderedSessionIDs[0] != "first" {
		t.Fatalf("first ID = %q, want first (dupe first-occurrence wins)", cur.OrderedSessionIDs[0])
	}
	for _, id := range cur.OrderedSessionIDs {
		if id == "overflow-51" {
			t.Fatal("overflow-51 survived the cap; want dropped")
		}
		if id == "" {
			t.Fatal("empty ID survived normalize; want dropped")
		}
	}
	// "first" carried over its project; the sN IDs were newly introduced and
	// populated from activeSessionProjects.
	if cur.ProjectBySessionID["first"] != "proj-first" {
		t.Fatalf("project[first] = %q, want proj-first (carry-over)", cur.ProjectBySessionID["first"])
	}
	if cur.ProjectBySessionID["s0"] != "proj-s0" {
		t.Fatalf("project[s0] = %q, want proj-s0 (new-ID lookup)", cur.ProjectBySessionID["s0"])
	}

	// Reload from disk via a second NewPinStore: values must round-trip.
	st2, err := NewPinStore(path)
	if err != nil {
		t.Fatalf("reload NewPinStore: %v", err)
	}
	reloaded := st2.Snapshot()
	if reloaded.Initialized != true || reloaded.Revision != 1 {
		t.Fatalf("reload: Initialized=%v Revision=%d, want true/1", reloaded.Initialized, reloaded.Revision)
	}
	if len(reloaded.OrderedSessionIDs) != 50 || reloaded.OrderedSessionIDs[0] != "first" {
		t.Fatalf("reload order = %v, want 50 IDs starting with first", reloaded.OrderedSessionIDs)
	}
	if reloaded.ProjectBySessionID["first"] != "proj-first" {
		t.Fatalf("reload project[first] = %q, want proj-first", reloaded.ProjectBySessionID["first"])
	}

	// Pin the exact persisted JSON field order: schemaVersion, revision,
	// initialized, orderedSessionIds, projectBySessionId (declaration order).
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	keys := []string{
		`"schemaVersion"`,
		`"revision"`,
		`"initialized"`,
		`"orderedSessionIds"`,
		`"projectBySessionId"`,
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

	// Sanity: the reloaded doc also re-marshals to the same field order.
	reMarshal, err := json.MarshalIndent(reloaded, "", "  ")
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	prev = -1
	for _, k := range keys {
		idx := bytes.Index(reMarshal, []byte(k))
		if idx < 0 || idx <= prev {
			t.Fatalf("re-marshal field-order drift for %s: %s", k, reMarshal)
		}
		prev = idx
	}

	// And the round-tripped bytes match what was persisted (no drift).
	if !bytes.Equal(raw, reMarshal) {
		t.Fatalf("reload bytes drifted from disk:\nDisk: %s\nReload: %s", raw, reMarshal)
	}
}

// 4. Replace with a mismatched baseRevision returns ok=false and does NOT touch
// the disk file (content byte-identical, no temp siblings left behind).
func TestPinStoreReplaceMismatchedRevisionDoesNotTouchDisk(t *testing.T) {
	st, path := newPinTestStore(t)

	// First Replace creates the file at revision 1.
	mustReplace(t, st, 0, []string{"a", "b"}, map[string]string{"a": "pa", "b": "pb"}, false)

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}
	beforeInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat before: %v", err)
	}

	// A Replace with a stale baseRevision (2, but current is 1) must return
	// ok=false WITHOUT mutating disk. initializeOnly=false so only the CAS guard
	// applies.
	ok, cur, err := st.Replace(2, []string{"c"}, map[string]string{"c": "pc"}, false)
	if err != nil {
		t.Fatalf("mismatched Replace err: %v", err)
	}
	if ok {
		t.Fatal("mismatched Replace: ok=true, want false")
	}
	if cur.Revision != 1 || len(cur.OrderedSessionIDs) != 2 {
		t.Fatalf("mismatched Replace returned mutated snapshot: %+v", cur)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("mismatched Replace mutated disk content:\nbefore: %s\nafter:  %s", before, after)
	}
	afterInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat after: %v", err)
	}
	// A write would bump mtime; assert it did not move. (tmpfs has ns resolution,
	// so this is reliable; the byte-equality check above is the authoritative one.)
	if !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatalf("mismatched Replace changed mtime: before=%s after=%s", beforeInfo.ModTime(), afterInfo.ModTime())
	}
	// No temp siblings left from a CAS-mismatch no-op.
	if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
		t.Fatalf("expected 0 temp files after mismatched Replace, got %d", n)
	}
}

// 5. RemoveIDs drops targets and prunes their projectBySessionId, bumping
// revision; RemoveIDs of IDs not present returns changed=false and does NOT bump
// revision or write. Idempotent.
func TestPinStoreRemoveIDsDropsPrunesBumpsAndIsIdempotent(t *testing.T) {
	st, _ := newPinTestStore(t)

	cur := mustReplace(t, st, 0, []string{"a", "b", "c"}, map[string]string{"a": "pa", "b": "pb", "c": "pc"}, false)
	if cur.Revision != 1 {
		t.Fatalf("setup Revision = %d, want 1", cur.Revision)
	}

	// Remove a present ID → changed, revision bumps, projects pruned.
	changed, cur2, err := st.RemoveIDs([]string{"b"})
	if err != nil {
		t.Fatalf("RemoveIDs([b]): %v", err)
	}
	if !changed {
		t.Fatal("RemoveIDs([b]): changed=false, want true (b was present)")
	}
	if cur2.Revision != 2 {
		t.Fatalf("RemoveIDs([b]): Revision = %d, want 2", cur2.Revision)
	}
	if len(cur2.OrderedSessionIDs) != 2 || cur2.OrderedSessionIDs[0] != "a" || cur2.OrderedSessionIDs[1] != "c" {
		t.Fatalf("RemoveIDs([b]): order = %v, want [a c]", cur2.OrderedSessionIDs)
	}
	if _, ok := cur2.ProjectBySessionID["b"]; ok {
		t.Fatalf("RemoveIDs([b]): project[b] still present: %v", cur2.ProjectBySessionID)
	}
	if cur2.ProjectBySessionID["a"] != "pa" || cur2.ProjectBySessionID["c"] != "pc" {
		t.Fatalf("RemoveIDs([b]): survivor projects changed: %v", cur2.ProjectBySessionID)
	}

	// Remove a NOT-present ID → changed=false, revision NOT bumped, no write.
	changed3, cur3, err := st.RemoveIDs([]string{"not-present"})
	if err != nil {
		t.Fatalf("RemoveIDs([not-present]): %v", err)
	}
	if changed3 {
		t.Fatal("RemoveIDs([not-present]): changed=true, want false")
	}
	if cur3.Revision != 2 {
		t.Fatalf("RemoveIDs([not-present]): Revision = %d, want 2 (no bump)", cur3.Revision)
	}

	// Empty input → changed=false, no write.
	changed4, cur4, err := st.RemoveIDs([]string{})
	if err != nil {
		t.Fatalf("RemoveIDs([]): %v", err)
	}
	if changed4 {
		t.Fatal("RemoveIDs([]): changed=true, want false")
	}
	if cur4.Revision != 2 {
		t.Fatalf("RemoveIDs([]): Revision = %d, want 2 (no bump)", cur4.Revision)
	}

	// Remove the remaining IDs → changed, order empties, projects empty.
	changed5, cur5, err := st.RemoveIDs([]string{"a", "c", "also-absent"})
	if err != nil {
		t.Fatalf("RemoveIDs([a,c]): %v", err)
	}
	if !changed5 {
		t.Fatal("RemoveIDs([a,c]): changed=false, want true")
	}
	if cur5.Revision != 3 {
		t.Fatalf("RemoveIDs([a,c]): Revision = %d, want 3", cur5.Revision)
	}
	if len(cur5.OrderedSessionIDs) != 0 {
		t.Fatalf("RemoveIDs([a,c]): order = %v, want empty", cur5.OrderedSessionIDs)
	}
	if len(cur5.ProjectBySessionID) != 0 {
		t.Fatalf("RemoveIDs([a,c]): projects = %v, want empty", cur5.ProjectBySessionID)
	}

	// Idempotent re-removal of an already-removed ID → changed=false, no bump.
	changed6, cur6, err := st.RemoveIDs([]string{"a"})
	if err != nil {
		t.Fatalf("idempotent RemoveIDs([a]): %v", err)
	}
	if changed6 {
		t.Fatal("idempotent RemoveIDs([a]): changed=true, want false")
	}
	if cur6.Revision != 3 {
		t.Fatalf("idempotent RemoveIDs([a]): Revision = %d, want 3", cur6.Revision)
	}
}

// 6. Atomic save leaves no .tmp siblings in the directory after success OR after
// a simulated write failure (a rename that fails post-temp-creation).
func TestPinStoreAtomicSaveLeavesNoTemp(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		st, path := newPinTestStore(t)
		mustReplace(t, st, 0, []string{"a"}, nil, false)
		if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
			t.Fatalf("after successful Replace: expected 0 temp files, got %d", n)
		}
		// A RemoveIDs success also leaves no temp.
		if _, _, err := st.RemoveIDs([]string{"a"}); err != nil {
			t.Fatalf("RemoveIDs: %v", err)
		}
		if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
			t.Fatalf("after successful RemoveIDs: expected 0 temp files, got %d", n)
		}
	})

	t.Run("write_failure_cleans_temp", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "pins.json")

		// Load a fresh store while the path is still absent (zero doc).
		st, err := NewPinStore(path)
		if err != nil {
			t.Fatalf("NewPinStore: %v", err)
		}

		// Force the atomic rename to fail AFTER temp creation by making the
		// destination path an existing directory: writePinsAtomic creates the
		// temp, writes/fsyncs/closes/chmods it (all succeed), then os.Rename
		// over a directory fails (EISDIR on Linux). The cleanup branch must
		// remove the temp so no .tmp sibling lingers.
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatalf("mkdir path-as-dir: %v", err)
		}

		ok, _, err := st.Replace(0, []string{"a"}, nil, false)
		if err == nil {
			t.Fatal("Replace over a directory-destination: want rename error, got nil")
		}
		if ok {
			t.Fatal("Replace over a directory-destination: ok=true, want false")
		}
		if n := countTmpFiles(t, root); n != 0 {
			t.Fatalf("after failed Replace: expected 0 temp files (cleanup must run), got %d", n)
		}
		// The on-disk destination is unchanged (still a directory) — the failed
		// rename did not clobber it.
		if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
			t.Fatalf("failed Replace clobbered destination: stat=%v isDir=%v", statErr, info.IsDir())
		}
		// The store's in-memory doc must NOT have mutated on the persist
		// failure (candidate was never assigned).
		snap := st.Snapshot()
		if snap.Initialized || snap.Revision != 0 {
			t.Fatalf("persist failure mutated in-memory doc: Initialized=%v Revision=%d", snap.Initialized, snap.Revision)
		}
	})
}

// 7. Corrupt-on-disk JSON (or wrong schemaVersion) → NewPinStore returns a zero
// doc in memory without panicking, and does NOT rewrite the on-disk file.
func TestPinStoreCorruptOrSchemaMismatchResetsToZeroDoc(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"malformed_json", []byte(`{"schemaVersion":1,"revision":1,"orderedSessionIds":[ BROKEN`)},
		{"wrong_schema", []byte(`{"schemaVersion":2,"revision":1,"initialized":true,"orderedSessionIds":["a"],"projectBySessionId":{"a":"p"}}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "pins.json")
			if err := os.WriteFile(path, tc.body, 0o644); err != nil {
				t.Fatal(err)
			}

			// Must not panic; must return a zero uninitialized doc with nil err.
			st, err := NewPinStore(path)
			if err != nil {
				t.Fatalf("NewPinStore on %s: err=%v, want nil (resilient reset)", tc.name, err)
			}
			snap := st.Snapshot()
			if snap.SchemaVersion != pinsSchemaVersion {
				t.Fatalf("%s: SchemaVersion = %d, want %d", tc.name, snap.SchemaVersion, pinsSchemaVersion)
			}
			if snap.Initialized {
				t.Fatalf("%s: Initialized = true, want false", tc.name)
			}
			if snap.Revision != 0 {
				t.Fatalf("%s: Revision = %d, want 0", tc.name, snap.Revision)
			}
			if len(snap.OrderedSessionIDs) != 0 {
				t.Fatalf("%s: OrderedSessionIDs = %v, want empty", tc.name, snap.OrderedSessionIDs)
			}

			// The on-disk file must be UNCHANGED — NewPinStore does not rewrite
			// on read (the operator can inspect the bad file).
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

// TestPinStoreSnapshotIsImmutableToCaller pins the Snapshot contract: mutating
// the returned slice/map MUST NOT affect the store's internal state (the
// snapshot is a deep-enough copy of the slice and map).
func TestPinStoreSnapshotIsImmutableToCaller(t *testing.T) {
	st, _ := newPinTestStore(t)
	mustReplace(t, st, 0, []string{"a", "b"}, map[string]string{"a": "pa", "b": "pb"}, false)

	snap := st.Snapshot()
	// Mutate the returned snapshot.
	snap.OrderedSessionIDs[0] = "MUTATED"
	snap.OrderedSessionIDs = append(snap.OrderedSessionIDs, "EXTRA")
	snap.ProjectBySessionID["a"] = "MUTATED"
	snap.ProjectBySessionID["injected"] = "x"

	// The store's own snapshot must be unaffected.
	again := st.Snapshot()
	if again.OrderedSessionIDs[0] != "a" || len(again.OrderedSessionIDs) != 2 {
		t.Fatalf("caller mutation leaked into store: order=%v", again.OrderedSessionIDs)
	}
	if again.ProjectBySessionID["a"] != "pa" {
		t.Fatalf("caller mutation leaked into store: project[a]=%q", again.ProjectBySessionID["a"])
	}
	if _, ok := again.ProjectBySessionID["injected"]; ok {
		t.Fatalf("caller injected a project key into the store: %v", again.ProjectBySessionID)
	}
}

// TestPinStoreReplaceCarriesOverAndPopulatesNew pins the carry-over vs new-ID
// project-population rule precisely, separate from the cap/dedupe test: retained
// IDs keep their prior project; new IDs get activeSessionProjects[id] (or "" when
// absent — a missing lookup never blocks a replace); dropped IDs vanish from the
// project map.
func TestPinStoreReplaceCarriesOverAndPopulatesNew(t *testing.T) {
	st, _ := newPinTestStore(t)
	// Initial: [a,b] with projects.
	mustReplace(t, st, 0, []string{"a", "b"}, map[string]string{"a": "pa", "b": "pb"}, false)

	// Replace keeping a, dropping b, adding c (known project) and d (unknown → "").
	cur := st.Snapshot()
	got, cur2, err := st.Replace(cur.Revision, []string{"c", "a", "d"}, map[string]string{"c": "pc"}, false)
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if !got {
		t.Fatal("Replace ok=false, want true")
	}
	if len(cur2.OrderedSessionIDs) != 3 || cur2.OrderedSessionIDs[0] != "c" || cur2.OrderedSessionIDs[1] != "a" || cur2.OrderedSessionIDs[2] != "d" {
		t.Fatalf("order = %v, want [c a d]", cur2.OrderedSessionIDs)
	}
	if cur2.ProjectBySessionID["a"] != "pa" {
		t.Fatalf("carry-over failed: project[a]=%q, want pa", cur2.ProjectBySessionID["a"])
	}
	if cur2.ProjectBySessionID["c"] != "pc" {
		t.Fatalf("new-ID populate failed: project[c]=%q, want pc", cur2.ProjectBySessionID["c"])
	}
	if v, ok := cur2.ProjectBySessionID["d"]; !ok || v != "" {
		t.Fatalf("missing-lookup populate failed: project[d]=%q ok=%v, want \"\" true", v, ok)
	}
	if _, ok := cur2.ProjectBySessionID["b"]; ok {
		t.Fatalf("dropped ID b still in project map: %v", cur2.ProjectBySessionID)
	}
}
