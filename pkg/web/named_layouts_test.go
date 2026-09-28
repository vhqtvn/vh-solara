package web

// Store tests for the worker-wide named tab-layout catalog (worker-scoped v1).
// Mirrors the pins_test.go coverage adapted to the per-entry upsert contract:
// persistence/reload + field order, CAS conflict no-op, catalog-cap sentinel,
// corrupt/schema-mismatch reset, snapshot immutability (incl. RawMessage
// bytes), atomic-write temp hygiene. countTmpFiles is shared from
// pins_test.go (same package).

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// newLayoutTestStore builds a NamedLayoutStore rooted at a fresh temp dir so
// each test gets a clean filesystem. The returned path is
// <root>/named-layouts.json.
func newLayoutTestStore(t *testing.T) (*NamedLayoutStore, string) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "named-layouts.json")
	st, err := NewNamedLayoutStore(path)
	if err != nil {
		t.Fatalf("NewNamedLayoutStore(%s): %v", path, err)
	}
	return st, path
}

// testLayout returns a minimal valid serialized-layout JSON object (opaque to
// the server; only "is a JSON object" is validated).
func testLayout(n int) json.RawMessage {
	return json.RawMessage(`{"grid":{"n":` + strconv.Itoa(n) + `},"panels":[]}`)
}

// mustUpsert is an Upsert that fatals on error (used when the test expects
// success). Returns the post-upsert snapshot.
func mustUpsert(t *testing.T, s *NamedLayoutStore, baseRevision int64, entry NamedLayoutEntry) NamedLayoutsDoc {
	t.Helper()
	ok, cur, err := s.Upsert(baseRevision, entry)
	if err != nil {
		t.Fatalf("Upsert err: %v", err)
	}
	if !ok {
		t.Fatalf("Upsert ok=false, want true (baseRevision=%d)", baseRevision)
	}
	return cur
}

// layoutEntry builds a valid tab entry for tests.
func layoutEntry(name string, n int, savedAt int64) NamedLayoutEntry {
	return NamedLayoutEntry{
		Scope:    "tab",
		Name:     name,
		TabTitle: "Title " + name,
		Layout:   testLayout(n),
		SavedAt:  savedAt,
	}
}

// masterLayoutEntry builds a valid master (session) entry for tests: n
// workspaces, the first active by name.
func masterLayoutEntry(name string, n int, savedAt int64) NamedLayoutEntry {
	active := "Ws 1"
	sess := &NamedMasterSession{
		ActiveWorkspaceName: &active,
		Workspaces:          make([]NamedMasterWorkspace, 0, n),
	}
	for i := 0; i < n; i++ {
		sess.Workspaces = append(sess.Workspaces, NamedMasterWorkspace{
			Name:   "Ws " + strconv.Itoa(i+1),
			Layout: testLayout(i + 1),
		})
	}
	return NamedLayoutEntry{
		Scope:   "master",
		Name:    name,
		Session: sess,
		SavedAt: savedAt,
	}
}

// 1. Missing file → NewNamedLayoutStore returns an empty doc and does NOT
// create a file on disk.
func TestNamedLayoutStoreMissingFileReturnsZeroDoc(t *testing.T) {
	st, path := newLayoutTestStore(t)
	snap := st.Snapshot()
	if snap.SchemaVersion != namedLayoutsSchemaVersion {
		t.Fatalf("SchemaVersion = %d, want %d", snap.SchemaVersion, namedLayoutsSchemaVersion)
	}
	if snap.Revision != 0 {
		t.Fatalf("Revision = %d, want 0", snap.Revision)
	}
	if snap.Entries == nil || len(snap.Entries) != 0 {
		t.Fatalf("Entries = %v, want non-nil empty map", snap.Entries)
	}
	// No file created on disk by the read-only constructor.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing-file load should NOT create a file; stat err=%v", err)
	}
}

// 2. Upsert with a matching baseRevision persists to disk, increments
// revision, and a reload via a second NewNamedLayoutStore round-trips with
// the exact JSON field order (schemaVersion, revision, entries) and the
// layout bytes verbatim.
func TestNamedLayoutStoreUpsertPersistsAndRoundTrips(t *testing.T) {
	st, path := newLayoutTestStore(t)

	cur := mustUpsert(t, st, 0, layoutEntry("focus", 1, 1726600000000))
	if cur.Revision != 1 {
		t.Fatalf("Revision = %d, want 1", cur.Revision)
	}
	got := cur.Entries["focus"]
	if got.Scope != "tab" || got.TabTitle != "Title focus" || got.SavedAt != 1726600000000 {
		t.Fatalf("entry round-trip mismatch: %+v", got)
	}
	if !bytes.Equal(got.Layout, testLayout(1)) {
		t.Fatalf("layout bytes drifted:\ngot:  %s\nwant: %s", got.Layout, testLayout(1))
	}

	// Second, unrelated entry → revision bumps again.
	cur2 := mustUpsert(t, st, 1, layoutEntry("debug", 2, 1726600001000))
	if cur2.Revision != 2 {
		t.Fatalf("second Upsert: Revision = %d, want 2", cur2.Revision)
	}
	if len(cur2.Entries) != 2 {
		t.Fatalf("second Upsert: len(Entries) = %d, want 2", len(cur2.Entries))
	}

	// Reload from disk via a second NewNamedLayoutStore: values round-trip.
	st2, err := NewNamedLayoutStore(path)
	if err != nil {
		t.Fatalf("reload NewNamedLayoutStore: %v", err)
	}
	reloaded := st2.Snapshot()
	if reloaded.Revision != 2 || len(reloaded.Entries) != 2 {
		t.Fatalf("reload: Revision=%d len(Entries)=%d, want 2/2", reloaded.Revision, len(reloaded.Entries))
	}
	rel := reloaded.Entries["focus"]
	if rel.TabTitle != "Title focus" || rel.SavedAt != 1726600000000 {
		t.Fatalf("reload entry drift: %+v", rel)
	}
	// NOTE: MarshalIndent re-indents embedded RawMessage content, so the
	// layout's exact BYTES are not preserved across a persist/reload cycle —
	// only its JSON VALUE is. Assert semantic equality here (the in-memory
	// snapshot above still holds the verbatim bytes; the disk/reload form is
	// the indented projection). jsonEqual is shared from
	// named_layouts_http_test.go (same package).
	if !jsonEqual(rel.Layout, testLayout(1)) {
		t.Fatalf("reload layout value drifted: %s", rel.Layout)
	}

	// Pin the exact persisted JSON field order: schemaVersion, revision,
	// entries (declaration order).
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	keys := []string{`"schemaVersion"`, `"revision"`, `"entries"`}
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

	// The reloaded doc re-marshals to the same bytes (no drift).
	reMarshal, err := json.MarshalIndent(reloaded, "", "  ")
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	if !bytes.Equal(raw, reMarshal) {
		t.Fatalf("reload bytes drifted from disk:\nDisk: %s\nReload: %s", raw, reMarshal)
	}
}

// 3. Upsert of an EXISTING name overwrites in place: the catalog does not
// grow, the old entry bytes are fully replaced, revision bumps.
func TestNamedLayoutStoreUpsertOverwritesExistingName(t *testing.T) {
	st, _ := newLayoutTestStore(t)
	mustUpsert(t, st, 0, layoutEntry("focus", 1, 1000))
	cur := mustUpsert(t, st, 1, layoutEntry("focus", 99, 2000))
	if len(cur.Entries) != 1 {
		t.Fatalf("overwrite: len(Entries) = %d, want 1", len(cur.Entries))
	}
	got := cur.Entries["focus"]
	if !bytes.Equal(got.Layout, testLayout(99)) || got.SavedAt != 2000 {
		t.Fatalf("overwrite did not replace entry: layout=%s savedAt=%d", got.Layout, got.SavedAt)
	}
}

// 4. Upsert with a mismatched baseRevision returns ok=false and does NOT
// touch the disk file (content byte-identical, no temp siblings left behind).
func TestNamedLayoutStoreUpsertMismatchedRevisionDoesNotTouchDisk(t *testing.T) {
	st, path := newLayoutTestStore(t)

	// First Upsert creates the file at revision 1.
	mustUpsert(t, st, 0, layoutEntry("a", 1, 1000))

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}
	beforeInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat before: %v", err)
	}

	// A stale Upsert (baseRevision=2, but current is 1) must return ok=false
	// WITHOUT mutating disk.
	ok, cur, err := st.Upsert(2, layoutEntry("b", 2, 2000))
	if err != nil {
		t.Fatalf("mismatched Upsert err: %v", err)
	}
	if ok {
		t.Fatal("mismatched Upsert: ok=true, want false")
	}
	if cur.Revision != 1 || len(cur.Entries) != 1 {
		t.Fatalf("mismatched Upsert returned mutated snapshot: rev=%d entries=%d", cur.Revision, len(cur.Entries))
	}
	if _, exists := cur.Entries["b"]; exists {
		t.Fatal("mismatched Upsert leaked the rejected entry into the snapshot")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("mismatched Upsert mutated disk content:\nbefore: %s\nafter:  %s", before, after)
	}
	afterInfo, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat after: %v", err)
	}
	if !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatalf("mismatched Upsert changed mtime: before=%s after=%s", beforeInfo.ModTime(), afterInfo.ModTime())
	}
	if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
		t.Fatalf("expected 0 temp files after mismatched Upsert, got %d", n)
	}
}

// 5. Catalog cap: maxNamedLayouts entries fit; a NEW name beyond the cap is
// rejected with ErrNamedLayoutsCatalogFull (revision unmoved, disk
// untouched); an OVERWRITE of an existing name at a full catalog still
// succeeds.
func TestNamedLayoutStoreCatalogCap(t *testing.T) {
	st, path := newLayoutTestStore(t)

	for i := 0; i < maxNamedLayouts; i++ {
		mustUpsert(t, st, int64(i), layoutEntry("layout-"+strconv.Itoa(i), i, int64(1000+i)))
	}
	snap := st.Snapshot()
	if snap.Revision != int64(maxNamedLayouts) || len(snap.Entries) != maxNamedLayouts {
		t.Fatalf("fill: Revision=%d len=%d, want %d/%d", snap.Revision, len(snap.Entries), maxNamedLayouts, maxNamedLayouts)
	}

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}

	// NEW name at a full catalog → sentinel error, no mutation.
	ok, cur, err := st.Upsert(int64(maxNamedLayouts), layoutEntry("one-too-many", 1, 1))
	if ok {
		t.Fatal("over-cap new-name Upsert: ok=true, want false")
	}
	if !errors.Is(err, ErrNamedLayoutsCatalogFull) {
		t.Fatalf("over-cap new-name Upsert err = %v, want ErrNamedLayoutsCatalogFull", err)
	}
	if cur.Revision != int64(maxNamedLayouts) || len(cur.Entries) != maxNamedLayouts {
		t.Fatalf("over-cap Upsert mutated doc: rev=%d len=%d", cur.Revision, len(cur.Entries))
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("over-cap Upsert mutated disk")
	}

	// OVERWRITE of an existing name at a full catalog still succeeds.
	cur2 := mustUpsert(t, st, int64(maxNamedLayouts), layoutEntry("layout-0", 42, 999999))
	if cur2.Revision != int64(maxNamedLayouts)+1 || len(cur2.Entries) != maxNamedLayouts {
		t.Fatalf("overwrite-at-cap: rev=%d len=%d", cur2.Revision, len(cur2.Entries))
	}
	if !bytes.Equal(cur2.Entries["layout-0"].Layout, testLayout(42)) {
		t.Fatalf("overwrite-at-cap did not replace layout: %s", cur2.Entries["layout-0"].Layout)
	}
}

// 6. Atomic save leaves no .tmp siblings after success OR after a simulated
// write failure (rename over a directory destination). On failure the temp is
// cleaned AND the in-memory doc is not mutated.
func TestNamedLayoutStoreAtomicSaveLeavesNoTemp(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		st, path := newLayoutTestStore(t)
		mustUpsert(t, st, 0, layoutEntry("a", 1, 1))
		if n := countTmpFiles(t, filepath.Dir(path)); n != 0 {
			t.Fatalf("after successful Upsert: expected 0 temp files, got %d", n)
		}
	})

	t.Run("write_failure_cleans_temp", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "named-layouts.json")

		// Load a fresh store while the path is still absent (zero doc).
		st, err := NewNamedLayoutStore(path)
		if err != nil {
			t.Fatalf("NewNamedLayoutStore: %v", err)
		}

		// Force the atomic rename to fail AFTER temp creation by making the
		// destination path an existing directory: writeNamedLayoutsAtomic
		// creates the temp, writes/fsyncs/closes/chmods it (all succeed),
		// then os.Rename over a directory fails (EISDIR on Linux). The
		// cleanup branch must remove the temp so no .tmp sibling lingers.
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatalf("mkdir path-as-dir: %v", err)
		}

		ok, _, err := st.Upsert(0, layoutEntry("a", 1, 1))
		if err == nil {
			t.Fatal("Upsert over a directory-destination: want rename error, got nil")
		}
		if ok {
			t.Fatal("Upsert over a directory-destination: ok=true, want false")
		}
		if n := countTmpFiles(t, root); n != 0 {
			t.Fatalf("after failed Upsert: expected 0 temp files (cleanup must run), got %d", n)
		}
		// The on-disk destination is unchanged (still a directory).
		if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
			t.Fatalf("failed Upsert clobbered destination: stat=%v isDir=%v", statErr, info.IsDir())
		}
		// The store's in-memory doc must NOT have mutated on the persist
		// failure (candidate was never assigned).
		snap := st.Snapshot()
		if snap.Revision != 0 || len(snap.Entries) != 0 {
			t.Fatalf("persist failure mutated in-memory doc: Revision=%d entries=%d", snap.Revision, len(snap.Entries))
		}
	})
}

// 7. Corrupt-on-disk JSON (or wrong schemaVersion) → NewNamedLayoutStore
// returns a zero doc in memory without panicking and does NOT rewrite the
// on-disk file.
func TestNamedLayoutStoreCorruptOrSchemaMismatchResetsToZeroDoc(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
	}{
		{"malformed_json", []byte(`{"schemaVersion":1,"revision":1,"entries":{ BROKEN`)},
		// 3 = a version THIS binary never reads or writes (1 and 2 both load;
		// see namedLayoutsSchemaVersion) — the still-unknown "wrong" version.
		{"wrong_schema", []byte(`{"schemaVersion":3,"revision":1,"entries":{"a":{"scope":"tab"}}}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "named-layouts.json")
			if err := os.WriteFile(path, tc.body, 0o644); err != nil {
				t.Fatal(err)
			}

			// Must not panic; must return a zero doc with nil err.
			st, err := NewNamedLayoutStore(path)
			if err != nil {
				t.Fatalf("NewNamedLayoutStore on %s: err=%v, want nil (resilient reset)", tc.name, err)
			}
			snap := st.Snapshot()
			if snap.SchemaVersion != namedLayoutsSchemaVersion {
				t.Fatalf("%s: SchemaVersion = %d, want %d", tc.name, snap.SchemaVersion, namedLayoutsSchemaVersion)
			}
			if snap.Revision != 0 {
				t.Fatalf("%s: Revision = %d, want 0", tc.name, snap.Revision)
			}
			if len(snap.Entries) != 0 {
				t.Fatalf("%s: Entries = %v, want empty", tc.name, snap.Entries)
			}

			// The on-disk file must be UNCHANGED — the constructor does not
			// rewrite on read.
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

// 8. Snapshot is immutable to the caller: mutating the returned map, an
// entry's fields, or an entry's Layout bytes must not leak into the store.
func TestNamedLayoutStoreSnapshotIsImmutableToCaller(t *testing.T) {
	st, _ := newLayoutTestStore(t)
	mustUpsert(t, st, 0, layoutEntry("a", 1, 1000))

	snap := st.Snapshot()
	// Mutate the returned snapshot: the map, a struct field, and the Layout
	// bytes (RawMessage is a byte slice — a shallow copy would alias it).
	snap.Entries["injected"] = layoutEntry("injected", 9, 9)
	e := snap.Entries["a"]
	e.TabTitle = "MUTATED"
	e.Layout[0] = 'X'
	snap.Entries["a"] = e

	again := st.Snapshot()
	if _, ok := again.Entries["injected"]; ok {
		t.Fatal("caller injected an entry into the store")
	}
	a := again.Entries["a"]
	if a.TabTitle != "Title a" {
		t.Fatalf("caller field mutation leaked: tabTitle=%q", a.TabTitle)
	}
	if !bytes.Equal(a.Layout, testLayout(1)) {
		t.Fatalf("caller Layout byte mutation leaked: %s", a.Layout)
	}
}

// 9. The Upsert argument must not alias store state: mutating the entry (or
// its Layout bytes) AFTER a successful Upsert must not change the stored doc.
func TestNamedLayoutStoreUpsertArgumentNotAliased(t *testing.T) {
	st, _ := newLayoutTestStore(t)
	entry := layoutEntry("a", 1, 1000)
	mustUpsert(t, st, 0, entry)

	// Mutate the caller-side entry after the fact.
	entry.TabTitle = "MUTATED"
	entry.Layout[0] = 'X'

	snap := st.Snapshot()
	a := snap.Entries["a"]
	if a.TabTitle != "Title a" || !bytes.Equal(a.Layout, testLayout(1)) {
		t.Fatalf("post-Upsert caller mutation leaked into store: %+v layout=%s", a, a.Layout)
	}
}

// 10. Concurrency: racing Upserts against the same baseRevision — exactly one
// winner per revision, the rest observe ok=false. Pinned by the mutex + CAS
// discipline (the -race detector exercises the locking).
func TestNamedLayoutStoreConcurrentSingleWinner(t *testing.T) {
	st, _ := newLayoutTestStore(t)
	const N = 25
	var winners int64
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ok, _, err := st.Upsert(0, layoutEntry("racer-"+strconv.Itoa(i), i, int64(i)))
			if err != nil {
				t.Errorf("racing Upsert err: %v", err)
				return
			}
			if ok {
				atomic.AddInt64(&winners, 1)
			}
		}(i)
	}
	wg.Wait()
	if winners != 1 {
		t.Fatalf("expected exactly 1 Upsert winner at revision 0, got %d", winners)
	}
	snap := st.Snapshot()
	if snap.Revision != 1 || len(snap.Entries) != 1 {
		t.Fatalf("post-race: Revision=%d len(Entries)=%d, want 1/1", snap.Revision, len(snap.Entries))
	}
}

// 11. Master (session) upsert persists to disk and a reload via a second
// NewNamedLayoutStore round-trips the session (workspace names, per-workspace
// layout values, activeWorkspaceName) and the null-active variant.
func TestNamedLayoutStoreMasterUpsertPersistsAndRoundTrips(t *testing.T) {
	st, path := newLayoutTestStore(t)

	cur := mustUpsert(t, st, 0, masterLayoutEntry("fleet", 2, 1726600099999))
	if cur.Revision != 1 {
		t.Fatalf("Revision = %d, want 1", cur.Revision)
	}
	e := cur.Entries["fleet"]
	if e.Scope != "master" || e.TabTitle != "" || len(e.Layout) != 0 {
		t.Fatalf("master entry carries tab-variant fields: %+v", e)
	}
	if e.Session == nil || len(e.Session.Workspaces) != 2 {
		t.Fatalf("master entry session mismatch: %+v", e.Session)
	}
	if e.Session.ActiveWorkspaceName == nil || *e.Session.ActiveWorkspaceName != "Ws 1" {
		t.Fatalf("activeWorkspaceName mismatch: %v", e.Session.ActiveWorkspaceName)
	}
	for i, w := range e.Session.Workspaces {
		if w.Name != "Ws "+strconv.Itoa(i+1) {
			t.Fatalf("workspace[%d].Name = %q", i, w.Name)
		}
		if !jsonEqual(w.Layout, testLayout(i+1)) {
			t.Fatalf("workspace[%d] layout drifted: %s", i, w.Layout)
		}
	}

	// Reload from disk: the session round-trips (semantic layout equality —
	// MarshalIndent re-indents RawMessage bytes; same note as test 2).
	st2, err := NewNamedLayoutStore(path)
	if err != nil {
		t.Fatalf("reload NewNamedLayoutStore: %v", err)
	}
	rel := st2.Snapshot().Entries["fleet"]
	if rel.Session == nil || len(rel.Session.Workspaces) != 2 {
		t.Fatalf("reload session mismatch: %+v", rel.Session)
	}
	if rel.Session.ActiveWorkspaceName == nil || *rel.Session.ActiveWorkspaceName != "Ws 1" {
		t.Fatalf("reload activeWorkspaceName mismatch: %v", rel.Session.ActiveWorkspaceName)
	}
	if rel.Session.Workspaces[1].Name != "Ws 2" {
		t.Fatalf("reload workspace name drifted: %q", rel.Session.Workspaces[1].Name)
	}
	if !jsonEqual(rel.Session.Workspaces[1].Layout, testLayout(2)) {
		t.Fatalf("reload workspace layout drifted: %s", rel.Session.Workspaces[1].Layout)
	}

	// The null-active variant round-trips too (JSON null activeWorkspaceName).
	cur2 := mustUpsert(t, st, 1, NamedLayoutEntry{
		Scope: "master", Name: "no-active", SavedAt: 1,
		Session: &NamedMasterSession{
			ActiveWorkspaceName: nil,
			Workspaces:          []NamedMasterWorkspace{{Name: "solo", Layout: testLayout(7)}},
		},
	})
	rel2 := cur2.Entries["no-active"]
	if rel2.Session == nil || rel2.Session.ActiveWorkspaceName != nil {
		t.Fatalf("null-active round-trip mismatch: %+v", rel2.Session)
	}
}

// 12. Same-name CROSS-SCOPE replace: the name namespace spans both scopes —
// an upsert of an existing name replaces the entry regardless of scope (same
// CAS path, no growth, revision bumps).
func TestNamedLayoutStoreSameNameCrossScopeReplace(t *testing.T) {
	st, _ := newLayoutTestStore(t)

	mustUpsert(t, st, 0, layoutEntry("dual", 1, 1000))
	cur := mustUpsert(t, st, 1, masterLayoutEntry("dual", 3, 2000))
	if len(cur.Entries) != 1 {
		t.Fatalf("cross-scope replace grew the catalog: len=%d", len(cur.Entries))
	}
	e := cur.Entries["dual"]
	if e.Scope != "master" || e.Session == nil || len(e.Session.Workspaces) != 3 {
		t.Fatalf("cross-scope replace did not install the master entry: %+v", e)
	}

	// And back: a tab upsert of the same name replaces the master entry.
	cur2 := mustUpsert(t, st, 2, layoutEntry("dual", 9, 3000))
	if len(cur2.Entries) != 1 {
		t.Fatalf("reverse cross-scope replace grew the catalog: len=%d", len(cur2.Entries))
	}
	e2 := cur2.Entries["dual"]
	if e2.Scope != "tab" || e2.Session != nil || e2.TabTitle != "Title dual" {
		t.Fatalf("reverse cross-scope replace did not install the tab entry: %+v", e2)
	}
}

// 13. A master entry's Upsert argument must not alias store state: mutating
// the session (workspace layout bytes, the activeName pointer, the slice)
// AFTER a successful Upsert must not change the stored doc (the Session
// deep-copy companion of test 9).
func TestNamedLayoutStoreMasterUpsertArgumentNotAliased(t *testing.T) {
	st, _ := newLayoutTestStore(t)
	entry := masterLayoutEntry("m", 2, 1000)
	mustUpsert(t, st, 0, entry)

	// Mutate the caller-side entry after the fact.
	entry.Session.Workspaces[0].Layout[0] = 'X'
	*entry.Session.ActiveWorkspaceName = "MUTATED"
	entry.Session.Workspaces = append(entry.Session.Workspaces, NamedMasterWorkspace{
		Name: "injected", Layout: testLayout(99),
	})

	snap := st.Snapshot()
	e := snap.Entries["m"]
	if e.Session == nil || len(e.Session.Workspaces) != 2 {
		t.Fatalf("post-Upsert caller slice mutation leaked: %+v", e.Session)
	}
	if !bytes.Equal(e.Session.Workspaces[0].Layout, testLayout(1)) {
		t.Fatalf("post-Upsert caller layout mutation leaked: %s", e.Session.Workspaces[0].Layout)
	}
	if e.Session.ActiveWorkspaceName == nil || *e.Session.ActiveWorkspaceName != "Ws 1" {
		t.Fatalf("post-Upsert caller activeName mutation leaked: %v", e.Session.ActiveWorkspaceName)
	}
}

// 14. Backward compat: a hand-written v1 (tab-only) document — exactly what a
// pre-master binary (git tag v1.72.0) persists — loads into THIS binary
// unchanged (entries + revision intact, file byte-identical on load), and the
// first successful mutation upgrades the on-disk file to the current schema
// (lazy upgrade: the load itself never rewrites).
func TestNamedLayoutStoreV1DocLoadsAndUpgradesLazily(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "named-layouts.json")
	// A v1 doc as the OLD binary writes it: schemaVersion 1, tab-only entries
	// (scope/name/tabTitle/layout/savedAt — no session field exists in v1).
	v1Body := []byte(`{
  "schemaVersion": 1,
  "revision": 5,
  "entries": {
    "focus": {"scope":"tab","name":"focus","tabTitle":"Title focus","layout":{"grid":{"n":1},"panels":[]},"savedAt":1726600000000},
    "debug": {"scope":"tab","name":"debug","tabTitle":"Title debug","layout":{"grid":{"n":2},"panels":[]},"savedAt":1726600001000}
  }
}`)
	if err := os.WriteFile(path, v1Body, 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := NewNamedLayoutStore(path)
	if err != nil {
		t.Fatalf("NewNamedLayoutStore(v1 doc): %v", err)
	}
	snap := st.Snapshot()
	// The v1 doc LOADS: both tab entries and the CAS revision survive…
	if snap.Revision != 5 || len(snap.Entries) != 2 {
		t.Fatalf("v1 doc did not load: Revision=%d len(Entries)=%d, want 5/2", snap.Revision, len(snap.Entries))
	}
	focus := snap.Entries["focus"]
	if focus.Scope != "tab" || focus.TabTitle != "Title focus" || focus.SavedAt != 1726600000000 {
		t.Fatalf("v1 entry drifted on load: %+v", focus)
	}
	if !jsonEqual(focus.Layout, testLayout(1)) {
		t.Fatalf("v1 layout value drifted: %s", focus.Layout)
	}
	// …the in-memory doc is normalized to the CURRENT schema version…
	if snap.SchemaVersion != namedLayoutsSchemaVersion {
		t.Fatalf("in-memory SchemaVersion = %d, want %d (normalized on load)", snap.SchemaVersion, namedLayoutsSchemaVersion)
	}
	// …and the load did NOT rewrite the on-disk file (still the v1 bytes).
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, v1Body) {
		t.Fatalf("load rewrote the v1 file:\ngot:  %s\nwant: %s", got, v1Body)
	}

	// LAZY UPGRADE: the first successful mutation (CAS against the v1 doc's
	// carried revision) persists the catalog as the CURRENT schema.
	cur := mustUpsert(t, st, 5, layoutEntry("added", 1, 1))
	if cur.Revision != 6 || len(cur.Entries) != 3 {
		t.Fatalf("post-upgrade Upsert: Revision=%d len=%d, want 6/3", cur.Revision, len(cur.Entries))
	}
	upgraded, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile upgraded: %v", err)
	}
	var onDisk struct {
		SchemaVersion int                         `json:"schemaVersion"`
		Entries       map[string]NamedLayoutEntry `json:"entries"`
	}
	if err := json.Unmarshal(upgraded, &onDisk); err != nil {
		t.Fatalf("upgraded doc unmarshal: %v", err)
	}
	if onDisk.SchemaVersion != namedLayoutsSchemaVersion {
		t.Fatalf("upgraded file schemaVersion = %d, want %d", onDisk.SchemaVersion, namedLayoutsSchemaVersion)
	}
	if len(onDisk.Entries) != 3 {
		t.Fatalf("upgraded file lost entries: %d, want 3 (v1 pair + the new one)", len(onDisk.Entries))
	}
	if _, ok := onDisk.Entries["focus"]; !ok {
		t.Fatal("upgraded file lost the v1 entry \"focus\"")
	}
}

// oldReaderTabEntry + oldReaderDoc mirror the PRE-master on-disk shape at git
// tag v1.72.0 (pkg/web/named_layouts.go): schemaVersion 1, entries keyed by
// name with TAB-ONLY values — no session field exists in the old struct, so
// encoding/json SILENTLY DISCARDS a master entry's session payload when an
// old binary unmarshals a union doc (the erasure mechanism under test).
type oldReaderTabEntry struct {
	Scope    string          `json:"scope"`
	Name     string          `json:"name"`
	TabTitle string          `json:"tabTitle"`
	Layout   json.RawMessage `json:"layout"`
	SavedAt  int64           `json:"savedAt"`
}

type oldReaderDoc struct {
	SchemaVersion int                          `json:"schemaVersion"`
	Revision      int64                        `json:"revision"`
	Entries       map[string]oldReaderTabEntry `json:"entries"`
}

// loadAsV1BinaryReader replicates the v1.72.0 NewNamedLayoutStore READ path
// against path (verified line-for-line against
// `git show v1.72.0:pkg/web/named_layouts.go`): ReadFile; on unmarshal error
// OR SchemaVersion != 1 → a zero doc IN MEMORY (nil error, file NEVER
// deleted/rewritten); on success the unmarshaled doc. It performs no writes
// of any kind — the old binary's ONLY write path is a successful Upsert.
func loadAsV1BinaryReader(path string) (oldReaderDoc, error) {
	zero := oldReaderDoc{SchemaVersion: 1, Entries: map[string]oldReaderTabEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return zero, nil
		}
		return zero, err
	}
	var doc oldReaderDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return zero, nil // corrupt → zero doc in memory, file intact
	}
	if doc.SchemaVersion != 1 {
		return zero, nil // mismatch → zero doc in memory, file intact
	}
	if doc.Entries == nil {
		doc.Entries = map[string]oldReaderTabEntry{}
	}
	return doc, nil
}

// 15. ROLLBACK REGRESSION (the data-integrity crux): a v2 catalog containing
// a master entry, read by the OLD (v1-only) binary's exact load semantics,
// is NOT ingested (the old binary sees a zero catalog — no silent
// session-discard) and the on-disk document is NOT rewritten by the load —
// the master entry survives byte-intact. Also demonstrates the counterfactual:
// had the SAME union doc been numbered v1 (the pre-fix state), the old reader
// WOULD ingest the master entry with its session payload silently discarded —
// the mangled catalog its next upsert would then persist.
func TestNamedLayoutStoreRollbackOldBinaryCannotEraseMasterDoc(t *testing.T) {
	st, path := newLayoutTestStore(t)
	mustUpsert(t, st, 0, masterLayoutEntry("fleet", 2, 1726600099999))

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}
	// The persisted union doc carries the CURRENT schema version — this
	// assertion is the red signal for the pre-fix state (version left at 1).
	var head struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(before, &head); err != nil {
		t.Fatalf("parse persisted doc: %v", err)
	}
	if head.SchemaVersion != namedLayoutsSchemaVersion {
		t.Fatalf("persisted master catalog schemaVersion = %d, want %d (the union doc MUST not be v1-numbered)", head.SchemaVersion, namedLayoutsSchemaVersion)
	}
	if !bytes.Contains(before, []byte(`"session"`)) {
		t.Fatalf("persisted master catalog lacks the session payload: %s", before)
	}

	// The OLD binary (v1.72.0 load semantics) reads the v2 doc.
	oldDoc, err := loadAsV1BinaryReader(path)
	if err != nil {
		t.Fatalf("old reader errored (v1.72.0 returns nil on mismatch): %v", err)
	}
	// (a) The old binary ingested NOTHING — the mismatch branch fired before
	// any unmarshaled entry could reach its in-memory catalog, so the silent
	// session-discard path is unreachable.
	if len(oldDoc.Entries) != 0 || oldDoc.Revision != 0 {
		t.Fatalf("old reader ingested the v2 doc: Revision=%d entries=%d, want 0/0 (in-memory reset)", oldDoc.Revision, len(oldDoc.Entries))
	}
	// (b) No rewrite-and-erase: the load never touched the file — the master
	// entry survives byte-intact for a roll-forward.
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("old reader's load rewrote the on-disk doc:\nbefore: %s\nafter:  %s", before, after)
	}

	// COUNTERFACTUAL (why the version NUMBER is load-bearing): the same union
	// bytes numbered v1 — the pre-fix on-disk form — load SUCCESSFULLY into
	// the old binary, which silently discards the master session payload.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(before, &raw); err != nil {
		t.Fatalf("reparse: %v", err)
	}
	raw["schemaVersion"], _ = json.Marshal(1)
	flipped, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("flip marshal: %v", err)
	}
	if err := json.Unmarshal(flipped, &oldDoc); err != nil {
		t.Fatalf("old reader rejected the v1-numbered union doc: %v", err)
	}
	if len(oldDoc.Entries) != 1 {
		t.Fatalf("v1-numbered union doc did not ingest into the old reader: %+v", oldDoc.Entries)
	}
	mangled := oldDoc.Entries["fleet"]
	if mangled.Scope != "master" || len(mangled.Layout) != 0 {
		t.Fatalf("v1-numbered union doc ingested unexpectedly shaped entry: %+v", mangled)
	}
	// The session payload WAS in the bytes the old decoder consumed, yet the
	// ingested entry carries none of it (the old struct has no session field;
	// a master entry carries no layout either) — silent discard demonstrated.
	// The old binary's next successful upsert would persist exactly this
	// mangled catalog; the v2 numbering makes the ingestion itself unreachable.
	if !bytes.Contains(flipped, []byte(`"session"`)) {
		t.Fatalf("counterfactual doc lost the session payload before the old reader saw it: %s", flipped)
	}
}
