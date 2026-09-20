package web

// Server-managed tab-only named layouts — worker-scoped v1: the durable,
// worker-wide NamedLayoutStore.
//
// This mirrors the PinStore discipline (pins.go) deliberately: a mutex-guarded
// in-memory doc, atomic-rename persistence, and Revision-based
// compare-and-swap. The discipline is duplicated rather than shared so
// diagnostics carry honest "named-layouts:" prefixes and a future pins.go
// refactor cannot silently change layouts persistence (same rationale as
// writePinsAtomic vs writeQueueAtomic).
//
// Differences from pins, by design (card
// task-2026-09-17t20-32-39-server-backed-tab-only-named-layouts-worker-scoped-v1):
//   - Entries are name-keyed (the catalog is a map, not an ordered list); the
//     HTTP mutation is a PER-ENTRY upsert (one entry per PUT), never a
//     whole-catalog replace.
//   - savedAt is client-supplied display metadata ONLY. It is NEVER used as
//     ordering authority (no cross-device ordering exists in v1; revision is
//     CAS-only, never a sequence to sort by).
//   - The layout payload is opaque serialized JSON (a dockview document) held
//     as json.RawMessage; the server validates only that it is a non-empty
//     JSON object within the size cap, never its interior.
//
// Scope (v1): tab layouts only. Entry.Scope must be exactly "tab"; the
// TypeScript side (host-web/src/dockview/namedLayouts.ts) also models a
// "master" scope, which is out of server scope for v1 and rejected here.
//
// State-dir layout: a single flat named-layouts.json directly under
// stateBaseDir() (same worker-wide convention as pins.json — one daemon = one
// worker = one state dir; see pins.go's state-dir note).

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// namedLayoutsSchemaVersion is the on-disk schema version this binary writes
// and reads. Mirrors pinsSchemaVersion's forward-compatible reset policy: a
// future bump makes an old binary reset a newer file cleanly to a zero doc.
const namedLayoutsSchemaVersion = 1

// maxNamedLayouts caps the catalog size. The per-entry upsert path rejects a
// NEW entry (name absent from the catalog) when the catalog is at this cap; an
// upsert of an EXISTING name always succeeds (overwrite, no growth). 100 is
// comfortably above a realistic hand-curated layout set while keeping the doc
// bounded even with worst-case 256 KiB layouts.
const maxNamedLayouts = 100

// ErrNamedLayoutsCatalogFull is returned by Upsert when the entry's name is
// absent from the catalog and the catalog is already at maxNamedLayouts. The
// HTTP layer maps it to a 400 (catalog_full) — the caller must delete or
// overwrite instead of adding.
var ErrNamedLayoutsCatalogFull = errors.New("named-layouts: catalog full")

// TabLayoutEntry is one saved named tab layout. It mirrors the TypeScript
// TabLayoutEntry in host-web/src/dockview/namedLayouts.ts (scope/name/
// tabTitle/layout/savedAt) so the wire shape round-trips without translation.
// Layout is the opaque serialized dockview document (fractional layout JSON);
// the server stores it verbatim and never interprets its interior.
type TabLayoutEntry struct {
	Scope    string          `json:"scope"`
	Name     string          `json:"name"`
	TabTitle string          `json:"tabTitle"`
	Layout   json.RawMessage `json:"layout"`
	SavedAt  int64           `json:"savedAt"`
}

// NamedLayoutsDoc is the persisted and in-memory shape. The JSON field order
// is fixed by the struct tag order: schemaVersion, revision, entries. Entries
// is keyed by entry name; tests pin that byte order on round-trip.
type NamedLayoutsDoc struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Revision      int64                     `json:"revision"`
	Entries       map[string]TabLayoutEntry `json:"entries"`
}

// NamedLayoutStore owns the worker-wide named-layouts doc: a mutex, the
// on-disk path, and the in-memory copy. All mutations persist the new state
// atomically before returning, so a successful response is always durable.
type NamedLayoutStore struct {
	mu   sync.Mutex
	path string
	doc  NamedLayoutsDoc
}

// zeroNamedLayoutsDoc returns a fresh empty doc: schema 1, revision 0, empty
// entries map. Used on missing-file load and on corrupt/schema-mismatch reset.
// It never touches disk.
func zeroNamedLayoutsDoc() NamedLayoutsDoc {
	return NamedLayoutsDoc{
		SchemaVersion: namedLayoutsSchemaVersion,
		Entries:       map[string]TabLayoutEntry{},
	}
}

// NewNamedLayoutStore loads (or initializes) the named-layouts store at path.
//
//   - Missing file: returns a store holding a zero doc WITHOUT writing (the
//     file is created lazily on the first successful mutation).
//   - Present + valid (schemaVersion == 1): unmarshals into the store, with
//     nil-map normalization so callers never observe nil.
//   - Corrupt JSON or schemaVersion != 1: resets to a zero doc IN MEMORY and
//     returns (store, nil) — never panics, never deletes/rewrites the on-disk
//     file on read. A subsequent successful upsert overwrites it atomically.
//   - Any other read error (permission, etc.): returned to the caller.
func NewNamedLayoutStore(path string) (*NamedLayoutStore, error) {
	st := &NamedLayoutStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			st.doc = zeroNamedLayoutsDoc()
			return st, nil
		}
		return nil, fmt.Errorf("named-layouts: read %s: %w", path, err)
	}
	var doc NamedLayoutsDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		// Corrupt → zero doc in memory, on-disk file left intact.
		st.doc = zeroNamedLayoutsDoc()
		return st, nil
	}
	if doc.SchemaVersion != namedLayoutsSchemaVersion {
		// Schema mismatch → zero doc in memory, on-disk file left intact.
		st.doc = zeroNamedLayoutsDoc()
		return st, nil
	}
	// Normalize so callers and the wire shape never see a nil map.
	if doc.Entries == nil {
		doc.Entries = map[string]TabLayoutEntry{}
	}
	st.doc = doc
	return st, nil
}

// Snapshot returns a thread-safe deep copy of the doc. The returned value is
// safe for callers to mutate without affecting the store: the map is copied
// AND each entry's Layout RawMessage bytes are copied (RawMessage is a byte
// slice — a shallow map copy would alias it).
func (s *NamedLayoutStore) Snapshot() NamedLayoutsDoc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

// Upsert applies a compare-and-swap insert-or-replace of ONE entry, keyed by
// entry.Name.
//
// The catalog-cap check happens under the store lock AFTER the CAS guard: an
// upsert of an EXISTING name always proceeds (overwrite, no growth); an
// upsert of a NEW name is rejected with ErrNamedLayoutsCatalogFull when the
// catalog is at maxNamedLayouts (the entry does not silently evict another).
//
// On CAS mismatch (baseRevision != doc.Revision): returns (false, doc, nil)
// WITHOUT mutating — the caller re-reads and retries.
//
// On success: the entry is stored as a deep copy (Layout bytes duplicated),
// Revision is incremented, the new doc is persisted atomically, and the new
// snapshot is returned.
//
// On persist failure the in-memory doc is NOT mutated (candidate-then-save,
// same as PinStore.Replace), so the store stays consistent with disk.
// Returns (false, doc, err).
//
// Note: Upserting an entry identical to the stored one still bumps Revision
// and persists — idempotence is the caller's job (the client holds the CAS
// revision; a duplicate write is a no-op semantically but consumes a
// revision). This matches the pins Replace contract.
func (s *NamedLayoutStore) Upsert(baseRevision int64, entry TabLayoutEntry) (ok bool, current NamedLayoutsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if baseRevision != s.doc.Revision {
		// CAS mismatch: do not mutate.
		return false, s.snapshotLocked(), nil
	}
	if _, exists := s.doc.Entries[entry.Name]; !exists && len(s.doc.Entries) >= maxNamedLayouts {
		return false, s.snapshotLocked(), ErrNamedLayoutsCatalogFull
	}

	entries := make(map[string]TabLayoutEntry, len(s.doc.Entries)+1)
	for k, v := range s.doc.Entries {
		entries[k] = v
	}
	// Deep-copy the entry (Layout bytes) so the caller cannot mutate stored
	// state through the argument after the call returns.
	stored := entry
	stored.Layout = append(json.RawMessage(nil), entry.Layout...)
	entries[entry.Name] = stored

	candidate := NamedLayoutsDoc{
		SchemaVersion: namedLayoutsSchemaVersion,
		Revision:      s.doc.Revision + 1,
		Entries:       entries,
	}
	if err := s.persistLocked(candidate); err != nil {
		// s.doc untouched (candidate was never assigned) → consistent with disk.
		return false, s.snapshotLocked(), err
	}
	s.doc = candidate
	return true, s.snapshotLocked(), nil
}

// snapshotLocked returns a deep copy of the doc. Caller MUST hold s.mu.
func (s *NamedLayoutStore) snapshotLocked() NamedLayoutsDoc {
	out := NamedLayoutsDoc{
		SchemaVersion: s.doc.SchemaVersion,
		Revision:      s.doc.Revision,
		Entries:       make(map[string]TabLayoutEntry, len(s.doc.Entries)),
	}
	for k, v := range s.doc.Entries {
		v.Layout = append(json.RawMessage(nil), v.Layout...)
		out.Entries[k] = v
	}
	return out
}

// persistLocked writes doc atomically to s.path: marshal → ensure parent dir
// (0o700) → writeNamedLayoutsAtomic. Mirrors PinStore.persistLocked. Caller
// MUST hold s.mu (serializes concurrent persists).
func (s *NamedLayoutStore) persistLocked(doc NamedLayoutsDoc) error {
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("named-layouts: encode %s: %w", s.path, err)
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("named-layouts: mkdir %s: %w", dir, err)
	}
	return writeNamedLayoutsAtomic(s.path, data, 0o644)
}

// writeNamedLayoutsAtomic writes data to path atomically: temp file in the
// same dir → write → fsync → chmod → rename → best-effort dir fsync. On POSIX
// the rename is atomic, so a crash at any earlier point leaves the previous
// path byte-intact (at worst the temp lingers, and every error branch after
// temp creation removes it). Duplicated from writePinsAtomic (not shared) so
// named-layouts diagnostics carry honest prefixes and a future pins/queue
// refactor cannot silently change layouts persistence.
func writeNamedLayoutsAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("named-layouts: atomic write %s: create temp: %w", path, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("named-layouts: atomic write %s: write temp: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("named-layouts: atomic write %s: fsync temp: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("named-layouts: atomic write %s: close temp: %w", path, err)
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return fmt.Errorf("named-layouts: atomic write %s: chmod temp: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("named-layouts: atomic write %s: rename: %w", path, err)
	}
	syncNamedLayoutsDirBestEffort(dir)
	return nil
}

// syncNamedLayoutsDirBestEffort fsyncs dir, ignoring all errors (tmpfs/network
// FS may not support dir fsync; this is durability, not correctness).
func syncNamedLayoutsDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
