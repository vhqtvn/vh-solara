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
func mustUpsert(t *testing.T, s *NamedLayoutStore, baseRevision int64, entry TabLayoutEntry) NamedLayoutsDoc {
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
func layoutEntry(name string, n int, savedAt int64) TabLayoutEntry {
	return TabLayoutEntry{
		Scope:    "tab",
		Name:     name,
		TabTitle: "Title " + name,
		Layout:   testLayout(n),
		SavedAt:  savedAt,
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
		{"wrong_schema", []byte(`{"schemaVersion":2,"revision":1,"entries":{"a":{"scope":"tab"}}}`)},
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
