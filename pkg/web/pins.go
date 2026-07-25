package web

// Server-managed pinned sessions — Phase 1: the durable, worker-wide PinStore.
//
// This slice implements ONLY the standalone store + its tests. There is no HTTP
// handler, no SSE/stream, no web/UI change, and no wiring into the Server struct
// (Phase 2/3 do that). The store is path-agnostic: callers pass the on-disk
// path. Phase 2 will ground it at `filepath.Join(stateBaseDir(), "pins.json")`.
//
// State-dir layout (premise-rechecked against pkg/web/notes.go):
// stateBaseDir() resolves to VH_STATE_DIR, else <userConfigDir>/vh-solara, else
// <tmp>/vh-solara — a per-user/per-host (worker-wide) root, NOT scoped by worker
// identity. notes.go writes per-project files directly under
// stateBaseDir()/"notes"/<sha1(cwd)>.json; there is no worker-id subpath concept
// anywhere in the repo (one daemon = one worker = one state dir). A single flat
// pins.json directly under stateBaseDir() is therefore consistent with the notes
// convention and cannot collide: the file is worker-global by design.
//
// Membership authority: OrderedSessionIDs is the SOLE membership set.
// ProjectBySessionID is cleanup metadata only (which project each pinned session
// belongs to, so the UI can group/label). It is NEVER a second membership
// authority — an ID present in ProjectBySessionID but absent from
// OrderedSessionIDs is not pinned. Replace/RemoveIDs keep the two in lockstep.
//
// Concurrency: every public method takes the store mutex. Replace and RemoveIDs
// use compare-and-swap via Revision: a caller reads Snapshot(), computes a new
// order against baseRevision = doc.Revision, and Replace succeeds only if the
// on-disk revision is still baseRevision. This makes concurrent edits from
// multiple browsers/clients deterministic (last-writer-detects-stale, no blind
// clobber) without a push channel.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// pinsSchemaVersion is the on-disk schema version this binary writes and reads.
// NewPinStore resets an unreadable or schema-mismatched file to a zero doc
// rather than crashing, so a future bump is forward-compatible (an old binary
// reading a newer file resets cleanly; a migration path can be added later).
const pinsSchemaVersion = 1

// maxPinnedSessions caps OrderedSessionIDs length. Replace normalizes input to
// this cap (dropping the tail beyond it) so a runaway caller cannot grow the
// file without bound. 50 is comfortably above any realistic hand-curated pin
// set while keeping the doc tiny and the JSON round-trip cheap.
const maxPinnedSessions = 50

// PinsDoc is the persisted and in-memory shape. The JSON field order is fixed by
// the struct tag order: schemaVersion, revision, initialized, orderedSessionIds,
// projectBySessionId. Tests pin that exact byte order on round-trip.
type PinsDoc struct {
	SchemaVersion      int               `json:"schemaVersion"`
	Revision           int64             `json:"revision"`
	Initialized        bool              `json:"initialized"`
	OrderedSessionIDs  []string          `json:"orderedSessionIds"`
	ProjectBySessionID map[string]string `json:"projectBySessionId"`
}

// PinStore owns the worker-wide pinned-sessions doc: a mutex, the on-disk path,
// and the in-memory copy. All mutations persist the new state atomically before
// returning, so a successful response is always durable (mirrors queue.go).
type PinStore struct {
	mu   sync.Mutex
	path string
	doc  PinsDoc
}

// zeroPinsDoc returns a fresh uninitialized zero doc: schema 1, not initialized,
// empty order, empty project map. Used on missing-file load and on
// corrupt/schema-mismatch reset. It never touches disk.
func zeroPinsDoc() PinsDoc {
	return PinsDoc{
		SchemaVersion:      pinsSchemaVersion,
		Initialized:        false,
		OrderedSessionIDs:  []string{},
		ProjectBySessionID: map[string]string{},
	}
}

// NewPinStore loads (or initializes) the pin store at path.
//
//   - Missing file: returns a store holding a zero uninitialized doc WITHOUT
//     writing (the file is created lazily on the first successful mutation).
//   - Present + valid (schemaVersion == 1): unmarshals into the store, with
//     nil-slice/nil-map normalization so callers never observe nil.
//   - Corrupt JSON or schemaVersion != 1: resets to a zero doc IN MEMORY and
//     returns (store, nil) — never panics, never deletes/rewrites the on-disk
//     file on read (the operator can inspect the bad file). A subsequent
//     successful Replace overwrites it atomically.
//   - Any other read error (permission, etc.): returned to the caller.
func NewPinStore(path string) (*PinStore, error) {
	st := &PinStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			st.doc = zeroPinsDoc()
			return st, nil
		}
		return nil, fmt.Errorf("pins: read %s: %w", path, err)
	}
	var doc PinsDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		// Corrupt → zero doc in memory, on-disk file left intact.
		st.doc = zeroPinsDoc()
		return st, nil
	}
	if doc.SchemaVersion != pinsSchemaVersion {
		// Schema mismatch → zero doc in memory, on-disk file left intact.
		st.doc = zeroPinsDoc()
		return st, nil
	}
	// Normalize so callers and the wire shape never see nil slice/map.
	if doc.OrderedSessionIDs == nil {
		doc.OrderedSessionIDs = []string{}
	}
	if doc.ProjectBySessionID == nil {
		doc.ProjectBySessionID = map[string]string{}
	}
	st.doc = doc
	return st, nil
}

// Snapshot returns a thread-safe copy of the doc. The returned value is safe for
// callers to mutate without affecting the store: the slice and map are copied.
func (s *PinStore) Snapshot() PinsDoc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

// Replace applies a compare-and-swap replacement of the ordered session list.
//
// initializeOnly mode succeeds ONLY if the doc is not yet initialized; on an
// already-initialized doc it returns (false, doc, nil) — the init-guard form of a
// CAS mismatch. Otherwise the baseRevision CAS guard applies: if baseRevision !=
// doc.Revision the call returns (false, doc, nil) without mutating.
//
// On success: newOrder is normalized (empties dropped, dupes collapsed with
// first-occurrence order preserved, length capped at maxPinnedSessions);
// ProjectBySessionID is rebuilt to exactly the retained IDs — carried over from
// the prior doc for known IDs, populated from activeSessionProjects for newly
// introduced IDs ("" if absent — never block a replace on a missing lookup);
// Initialized is set true; Revision is incremented; the new doc is persisted
// atomically; the new snapshot is returned.
//
// On persist failure the in-memory doc is NOT mutated (the candidate was built
// separately and only assigned after a successful save), so the store stays
// consistent with disk. Returns (false, doc, err).
func (s *PinStore) Replace(baseRevision int64, newOrder []string, activeSessionProjects map[string]string, initializeOnly bool) (ok bool, current PinsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if initializeOnly {
		// Init guard: succeed ONLY if not yet initialized. An already-initialized
		// doc is an init CAS mismatch regardless of baseRevision.
		if s.doc.Initialized {
			return false, s.snapshotLocked(), nil
		}
	}
	if baseRevision != s.doc.Revision {
		// CAS mismatch: do not mutate.
		return false, s.snapshotLocked(), nil
	}

	normalized := normalizeOrderLocked(newOrder)

	// Rebuild ProjectBySessionID for exactly the retained IDs. Carry over prior
	// values for known IDs; for newly introduced IDs record what
	// activeSessionProjects knows ("" if absent — a missing lookup never blocks).
	oldProjects := s.doc.ProjectBySessionID
	newProjects := make(map[string]string, len(normalized))
	for _, id := range normalized {
		if pk, ok := oldProjects[id]; ok {
			newProjects[id] = pk
			continue
		}
		// Indexing a nil activeSessionProjects is safe (returns "").
		newProjects[id] = activeSessionProjects[id]
	}

	candidate := PinsDoc{
		SchemaVersion:      pinsSchemaVersion,
		Revision:           s.doc.Revision + 1,
		Initialized:        true,
		OrderedSessionIDs:  normalized,
		ProjectBySessionID: newProjects,
	}
	if err := s.persistLocked(candidate); err != nil {
		// s.doc untouched (candidate was never assigned) → consistent with disk.
		return false, s.snapshotLocked(), err
	}
	s.doc = candidate
	return true, s.snapshotLocked(), nil
}

// RemoveIDs filters the given session IDs out of the ordered list and prunes
// their ProjectBySessionID entries. Idempotent: if none of the IDs are present,
// it returns (false, doc, nil) WITHOUT bumping Revision or touching disk.
// Otherwise Revision is incremented and the new doc is persisted atomically.
//
// On persist failure the in-memory doc is NOT mutated (same candidate-then-save
// pattern as Replace). Returns (false, doc, err).
func (s *PinStore) RemoveIDs(idsToRemove []string) (changed bool, current PinsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	remove := make(map[string]bool, len(idsToRemove))
	for _, id := range idsToRemove {
		if id == "" {
			continue
		}
		remove[id] = true
	}
	if len(remove) == 0 {
		return false, s.snapshotLocked(), nil
	}

	// Detect whether any target is actually present; if not, this is a no-op.
	present := false
	for _, id := range s.doc.OrderedSessionIDs {
		if remove[id] {
			present = true
			break
		}
	}
	if !present {
		return false, s.snapshotLocked(), nil
	}

	kept := make([]string, 0, len(s.doc.OrderedSessionIDs))
	for _, id := range s.doc.OrderedSessionIDs {
		if !remove[id] {
			kept = append(kept, id)
		}
	}
	// Rebuild ProjectBySessionID for exactly the retained IDs (drops pruned ones).
	newProjects := make(map[string]string, len(kept))
	for _, id := range kept {
		newProjects[id] = s.doc.ProjectBySessionID[id]
	}

	candidate := PinsDoc{
		SchemaVersion:      pinsSchemaVersion,
		Revision:           s.doc.Revision + 1,
		Initialized:        s.doc.Initialized,
		OrderedSessionIDs:  kept,
		ProjectBySessionID: newProjects,
	}
	if err := s.persistLocked(candidate); err != nil {
		return false, s.snapshotLocked(), err
	}
	s.doc = candidate
	return true, s.snapshotLocked(), nil
}

// normalizeOrderLocked drops empty IDs, dedupes (first occurrence wins), and caps
// the length at maxPinnedSessions (dropping the tail). Pure function over its
// input; named "...Locked" only to signal it is intended for use under the store
// mutex (it allocates from the hot path).
func normalizeOrderLocked(order []string) []string {
	seen := make(map[string]bool, len(order))
	out := make([]string, 0, len(order))
	for _, id := range order {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
		if len(out) >= maxPinnedSessions {
			break
		}
	}
	return out
}

// snapshotLocked returns a copy of the doc. Caller MUST hold s.mu.
func (s *PinStore) snapshotLocked() PinsDoc {
	out := PinsDoc{
		SchemaVersion:      s.doc.SchemaVersion,
		Revision:           s.doc.Revision,
		Initialized:        s.doc.Initialized,
		OrderedSessionIDs:  make([]string, len(s.doc.OrderedSessionIDs)),
		ProjectBySessionID: make(map[string]string, len(s.doc.ProjectBySessionID)),
	}
	copy(out.OrderedSessionIDs, s.doc.OrderedSessionIDs)
	for k, v := range s.doc.ProjectBySessionID {
		out.ProjectBySessionID[k] = v
	}
	return out
}

// persistLocked writes doc atomically to s.path: marshal → ensure parent dir
// (0o700) → temp file in the same dir → write → fsync → chmod → rename →
// best-effort dir fsync. Mirrors writeQueueAtomic in pkg/web/queue.go (which
// itself mirrors pkg/projectcfg/atomic.go). The rename is atomic on POSIX, so a
// crash at any earlier point leaves the previous path byte-intact (at worst the
// temp lingers, and every error branch after temp creation removes it). Caller
// MUST hold s.mu (serializes concurrent persists).
func (s *PinStore) persistLocked(doc PinsDoc) error {
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("pins: encode %s: %w", s.path, err)
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("pins: mkdir %s: %w", dir, err)
	}
	return writePinsAtomic(s.path, data, 0o644)
}

// writePinsAtomic writes data to path atomically: temp file in the same dir →
// write → fsync → chmod → rename → best-effort dir fsync. On POSIX the rename is
// atomic, so a crash at any earlier point leaves the previous path byte-intact
// (at worst the temp lingers). Mirrors writeQueueAtomic in pkg/web/queue.go;
// duplicated rather than reused so pins diagnostics carry honest "pins:" prefixes
// and so a future queue.go refactor cannot silently change pins persistence.
func writePinsAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("pins: atomic write %s: create temp: %w", path, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("pins: atomic write %s: write temp: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("pins: atomic write %s: fsync temp: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("pins: atomic write %s: close temp: %w", path, err)
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return fmt.Errorf("pins: atomic write %s: chmod temp: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("pins: atomic write %s: rename: %w", path, err)
	}
	syncPinsDirBestEffort(dir)
	return nil
}

// syncPinsDirBestEffort fsyncs dir, ignoring all errors (tmpfs/network FS may not
// support dir fsync; this is durability, not correctness).
func syncPinsDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
