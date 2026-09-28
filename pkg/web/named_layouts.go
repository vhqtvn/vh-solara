package web

// Server-managed named layouts (tab + master scopes) — worker-scoped v1: the
// durable, worker-wide NamedLayoutStore.
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
// Scope: tab AND master layouts share ONE name-keyed catalog (the TS union
// NamedLayoutEntry in host-web/src/dockview/namedLayouts.ts). An upsert of a
// name replaces the entry REGARDLESS of scope — the namespace spans both
// (same rule the local store enforces). Tab entries carry tabTitle + a
// single opaque layout; master entries carry session {activeWorkspaceName,
// workspaces:[{name, layout}]} instead (per-workspace layouts are exactly as
// opaque as tab layouts). The HTTP layer validates the discriminated shape.
//
// SCHEMA VERSIONING & ROLLBACK STORY (why the union doc is v2, not v1):
// the persisted entry shape WIDENED (tab-only → tab/master union) when master
// scope landed, so the on-disk version moved 1 → 2. This binary reads BOTH
// v1 and v2 docs; a v1 (tab-only) doc loads unchanged and upgrades lazily
// (see namedLayoutsSchemaVersion). Verified against the shipped PRE-master
// loader (`git show v1.72.0:pkg/web/named_layouts.go`): an old binary that
// reads a doc whose schemaVersion it does not know resets to a zero catalog
// IN MEMORY, returns nil, and NEVER deletes/rewrites the file at load time.
// Rollback new→old with a v2 file on disk is therefore loss-free by itself:
// the old binary shows an EMPTY layouts catalog (a visible signal) while the
// v2 file — master entries included — survives byte-intact; rolling forward
// again restores it fully. Numbering the union doc v1 would instead be a
// silent-data-loss bug: the old binary would LOAD it (version matches),
// encoding/json would silently discard every unknown master `session` field,
// and its next successful upsert would persist the catalog WITHOUT the
// master payloads — erasure with no signal. Documented residual (the same
// forward-compatible-reset cost pins.go accepts): if the operator SAVES a
// layout while rolled back, the old binary persists a fresh v1 doc from its
// zero in-memory state, replacing the v2 file — a visible, operator-initiated
// loss window, not a silent one.
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

// namedLayoutsSchemaVersion is the on-disk schema version this binary WRITES.
// History: 1 = tab-only catalog (the pre-master binary at git tag v1.72.0
// writes and reads exactly that); 2 = the tab/master union catalog below —
// THIS binary. The READ policy is two-version backward compatible: a v1 doc
// still loads (entries are tab-only by construction; the in-memory doc
// normalizes to the current version and the file upgrades LAZILY on the
// first successful mutation), and any OTHER version — older, newer, or
// foreign — resets to a zero doc IN MEMORY with the on-disk file left intact
// (mirrors pinsSchemaVersion's forward-compatible reset policy; the full
// rollback story, with the v1.72.0 loader evidence, is in the file header).
const namedLayoutsSchemaVersion = 2

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

// NamedMasterWorkspace is one workspace inside a master (session) entry. It
// mirrors NamedMasterWorkspace in host-web/src/dockview/namedLayouts.ts:
// the workspace's durable NAME plus its layout in the same opaque serialized
// form a tab entry stores (same caps, same never-interpret-interior policy).
// Ids are deliberately absent (they re-mint on load).
type NamedMasterWorkspace struct {
	Name   string          `json:"name"`
	Layout json.RawMessage `json:"layout"`
}

// NamedMasterSession is the master (whole-session) payload: every workspace
// plus the active workspace's NAME (JSON null when unknown — the client falls
// back to "activate the first workspace" at load time). Mirrors
// NamedMasterSession in host-web/src/dockview/namedLayouts.ts.
type NamedMasterSession struct {
	ActiveWorkspaceName *string                `json:"activeWorkspaceName"`
	Workspaces          []NamedMasterWorkspace `json:"workspaces"`
}

// NamedLayoutEntry is one saved named layout, either scope. It mirrors the
// TypeScript NamedLayoutEntry union in host-web/src/dockview/namedLayouts.ts
// so the wire shape round-trips without translation. TAB entries carry
// TabTitle + Layout (the opaque serialized dockview document); MASTER entries
// carry Session instead — tabTitle/layout are omitted on the wire for master
// (omitempty) and session is omitted for tab, so each scope's JSON shape is
// exactly the TS variant's. The server stores payloads verbatim and never
// interprets a layout's interior.
type NamedLayoutEntry struct {
	Scope    string              `json:"scope"`
	Name     string              `json:"name"`
	TabTitle string              `json:"tabTitle,omitempty"`
	Layout   json.RawMessage     `json:"layout,omitempty"`
	Session  *NamedMasterSession `json:"session,omitempty"`
	SavedAt  int64               `json:"savedAt"`
}

// NamedLayoutsDoc is the persisted and in-memory shape. The JSON field order
// is fixed by the struct tag order: schemaVersion, revision, entries. Entries
// is keyed by entry name; tests pin that byte order on round-trip.
type NamedLayoutsDoc struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Revision      int64                       `json:"revision"`
	Entries       map[string]NamedLayoutEntry `json:"entries"`
}

// NamedLayoutStore owns the worker-wide named-layouts doc: a mutex, the
// on-disk path, and the in-memory copy. All mutations persist the new state
// atomically before returning, so a successful response is always durable.
type NamedLayoutStore struct {
	mu   sync.Mutex
	path string
	doc  NamedLayoutsDoc
}

// zeroNamedLayoutsDoc returns a fresh empty doc: the current schema version,
// revision 0, empty entries map. Used on missing-file load and on
// corrupt/schema-mismatch reset. It never touches disk.
func zeroNamedLayoutsDoc() NamedLayoutsDoc {
	return NamedLayoutsDoc{
		SchemaVersion: namedLayoutsSchemaVersion,
		Entries:       map[string]NamedLayoutEntry{},
	}
}

// NewNamedLayoutStore loads (or initializes) the named-layouts store at path.
//
//   - Missing file: returns a store holding a zero doc WITHOUT writing (the
//     file is created lazily on the first successful mutation).
//   - Present + valid (schemaVersion 1 or 2): unmarshals into the store, with
//     nil-map normalization so callers never observe nil. A v1 (tab-only) doc
//     loads unchanged — its entries are tab-shaped by construction and its
//     in-memory SchemaVersion normalizes to the CURRENT version, while the
//     on-disk file is NOT rewritten on load (it upgrades to v2 lazily on the
//     first successful mutation; see namedLayoutsSchemaVersion).
//   - Corrupt JSON or an unknown schemaVersion (not 1 or 2): resets to a zero
//     doc IN MEMORY and returns (store, nil) — never panics, never
//     deletes/rewrites the on-disk file on read. A subsequent successful
//     upsert overwrites it atomically.
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
	if doc.SchemaVersion != namedLayoutsSchemaVersion && doc.SchemaVersion != 1 {
		// Unknown version (older than 1, newer than this binary, or foreign)
		// → zero doc in memory, on-disk file left intact — the SAME mismatch
		// branch the v1.72.0 loader takes on a v2 doc (the rollback story in
		// the file header): an old binary resets in memory WITHOUT persisting,
		// so a rolled-back binary can never rewrite-and-erase a union doc by
		// merely loading it.
		st.doc = zeroNamedLayoutsDoc()
		return st, nil
	}
	// Normalize so callers and the wire shape never see a nil map.
	if doc.Entries == nil {
		doc.Entries = map[string]NamedLayoutEntry{}
	}
	// Normalize the in-memory version to the CURRENT schema: a v1 doc is
	// understood fully by this binary, and every doc this store PERSISTS
	// carries the current version (Upsert's candidate always does). The
	// on-disk file itself is untouched by the load.
	doc.SchemaVersion = namedLayoutsSchemaVersion
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
func (s *NamedLayoutStore) Upsert(baseRevision int64, entry NamedLayoutEntry) (ok bool, current NamedLayoutsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if baseRevision != s.doc.Revision {
		// CAS mismatch: do not mutate.
		return false, s.snapshotLocked(), nil
	}
	if _, exists := s.doc.Entries[entry.Name]; !exists && len(s.doc.Entries) >= maxNamedLayouts {
		return false, s.snapshotLocked(), ErrNamedLayoutsCatalogFull
	}

	entries := make(map[string]NamedLayoutEntry, len(s.doc.Entries)+1)
	for k, v := range s.doc.Entries {
		entries[k] = v
	}
	// Deep-copy the entry (Layout bytes + a master Session's workspace slice,
	// their Layout bytes, and the activeName pointer) so the caller cannot
	// mutate stored state through the argument after the call returns.
	stored := entry
	stored.Layout = append(json.RawMessage(nil), entry.Layout...)
	stored.Session = copyNamedMasterSession(entry.Session)
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
		Entries:       make(map[string]NamedLayoutEntry, len(s.doc.Entries)),
	}
	for k, v := range s.doc.Entries {
		v.Layout = append(json.RawMessage(nil), v.Layout...)
		v.Session = copyNamedMasterSession(v.Session)
		out.Entries[k] = v
	}
	return out
}

// copyNamedMasterSession deep-copies a master session (nil stays nil): a
// fresh Workspaces slice, fresh Layout bytes per workspace, and a fresh
// ActiveWorkspaceName pointer — callers of Snapshot/Upsert can never alias
// stored state through any of them.
func copyNamedMasterSession(s *NamedMasterSession) *NamedMasterSession {
	if s == nil {
		return nil
	}
	out := &NamedMasterSession{
		Workspaces: make([]NamedMasterWorkspace, len(s.Workspaces)),
	}
	if s.ActiveWorkspaceName != nil {
		v := *s.ActiveWorkspaceName
		out.ActiveWorkspaceName = &v
	}
	for i, w := range s.Workspaces {
		w.Layout = append(json.RawMessage(nil), w.Layout...)
		out.Workspaces[i] = w
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
