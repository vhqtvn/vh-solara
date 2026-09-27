package server

// notify_history.go — the push-notification delivery history (slice S2;
// see notify_transport.go for the program header): the bounded,
// file-persisted record of every fleet-condition transition the watcher
// EMITTED, with per-token delivery outcomes. Push is best-effort; this
// history is the reliable record.
//
// Storage: a SEPARATE file next to the token registry — path = the
// --notify-store value + ".history" (no new flag). Isolation from
// token-file writes is the point: history appends are far more frequent
// than registry mutations, and sharing one file would couple the raw-
// token registry's read/write cadence to the history's. The file is
// NON-SECRET (no raw tokens — deliveries carry token IDs only), but the
// SAME O_EXCL-0600 tmp+rename persist discipline is kept via the shared
// persistAtomic0600 helper, for uniformity and defense-in-depth (one
// crash-safe write path, one mode posture).
//
// File shape (canonical 2-space JSON + trailing newline):
//
//	{"schema":1,"events":[{
//	  "id":1,                        // monotonic int64, ascending
//	  "ts":"RFC3339",
//	  "kind":"permission_pending",   // one of the nine fleet kinds
//	  "action":"appeared",           // appeared|changed|cleared
//	  "count":2,
//	  "title":"vh-solara",
//	  "body":"2 permissions pending",
//	  "deliveries":[{"token_id":"…","ok":true}]
//	}]}
//
// Bound: at most notifyHistoryMaxEntries (500) entries in memory AND in
// the file — the OLDEST are trimmed on append, so the file is a bounded
// ring of the newest transitions (documented cap; 500 entries ≈ months
// of a single-operator fleet at realistic transition rates). IDs keep
// rising across trims and restarts (nextID resumes above the newest
// persisted id), so `since` cursors never collide after a restart.
//
// Load discipline (mirrors the registry): strict decode
// (DisallowUnknownFields, exactly one document, ascending ids), a MISSING
// file = empty history (first boot — not an error), a PRESENT-but-bad
// file is a startup failure naming the path (the set-but-bad discipline:
// silently discarding the operator's delivery history is a lie). A file
// carrying MORE than the cap (hand-edited) is trimmed to the newest cap
// on load.
//
// Appends are watcher-loop-serialized (single goroutine), which keeps
// ids monotonic and the persist order deterministic; the holder mutex
// still guards readers (the HTTP handler) against the append path.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	// notifyHistorySchema is the history file/API version.
	notifyHistorySchema = 1
	// notifyHistoryMaxEntries bounds the retained history (oldest
	// trimmed on append).
	notifyHistoryMaxEntries = 500
	// notifyHistoryDefaultLimit / notifyHistoryMaxLimit bound GET
	// /vh/notify/history's limit parameter.
	notifyHistoryDefaultLimit = 50
	notifyHistoryMaxLimit     = 200
)

// ---------------------------------------------------------------------------
// Entry + file shape
// ---------------------------------------------------------------------------

// notifyHistoryAction values (the transition vocabulary the watcher
// emits; also the FCM data vh_event values).
const (
	notifyActionAppeared = "appeared"
	notifyActionChanged  = "changed"
	notifyActionCleared  = "cleared"
)

// notifyDeliveryRecord is the per-token outcome of one history entry's
// fan-out. token_id ONLY — the raw token never reaches the history (the
// ID resolves through the registry when the entry still exists).
// retired marks the UNREGISTERED-class outcome that removed the entry
// from the registry (see notify_watcher.go).
type notifyDeliveryRecord struct {
	TokenID string `json:"token_id"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Retired bool   `json:"retired,omitempty"`
}

// notifyHistoryEntry is one emitted transition.
type notifyHistoryEntry struct {
	ID         int64                  `json:"id"`
	TS         time.Time              `json:"ts"`
	Kind       string                 `json:"kind"`
	Action     string                 `json:"action"` // appeared|changed|cleared
	Count      int                    `json:"count"`
	Title      string                 `json:"title"`
	Body       string                 `json:"body"`
	Deliveries []notifyDeliveryRecord `json:"deliveries"`
}

// notifyHistoryFile is the whole persisted document.
type notifyHistoryFile struct {
	Schema int                  `json:"schema"`
	Events []notifyHistoryEntry `json:"events"`
}

// ---------------------------------------------------------------------------
// Decode / load
// ---------------------------------------------------------------------------

// decodeNotifyHistory strictly decodes exactly one JSON document into a
// validated history: schema 1, ids strictly ascending (the writer's
// invariant), kinds from the nine-vocabulary, actions from the three-
// value transition vocabulary. Shared by the startup file load.
func decodeNotifyHistory(data []byte) (*notifyHistoryFile, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f *notifyHistoryFile
	if err := dec.Decode(&f); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("empty document")
		}
		return nil, fmt.Errorf("invalid JSON: %v", err)
	}
	if f == nil {
		return nil, errors.New("document must be a JSON object, not null")
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("expected exactly one JSON document (trailing content)")
	}
	if f.Schema != notifyHistorySchema {
		return nil, fmt.Errorf("schema version %d not supported (want %d)", f.Schema, notifyHistorySchema)
	}
	var lastID int64
	for i := range f.Events {
		e := &f.Events[i]
		if e.ID <= lastID {
			return nil, fmt.Errorf("events[%d]: id %d must be strictly ascending (previous %d)", i, e.ID, lastID)
		}
		lastID = e.ID
		if !notifyConditionSet[e.Kind] {
			return nil, fmt.Errorf("events[%d]: unknown condition %q", i, e.Kind)
		}
		switch e.Action {
		case notifyActionAppeared, notifyActionChanged, notifyActionCleared:
		default:
			return nil, fmt.Errorf("events[%d]: unknown action %q", i, e.Action)
		}
	}
	if f.Events == nil {
		f.Events = []notifyHistoryEntry{}
	}
	return f, nil
}

// loadNotifyHistoryFile reads/validates the history at path. A MISSING
// file is an empty history (first boot), signaled by ok=false — the
// caller decides the posture. A present-but-invalid file is an error
// naming the path (set-but-bad discipline).
func loadNotifyHistoryFile(path string) (f *notifyHistoryFile, present bool, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("read notify history %s: %v", path, err)
	}
	f, derr := decodeNotifyHistory(data)
	if derr != nil {
		return nil, false, fmt.Errorf("notify history %s: %v", path, derr)
	}
	return f, true, nil
}

// ---------------------------------------------------------------------------
// Holder
// ---------------------------------------------------------------------------

// notifyHistoryHolder is the daemon's history state: the in-memory
// bounded window plus the persistence path ("" = unconfigured — the
// registry is disabled, so history is too; the family's honest 409
// posture answers). Zero value usable.
type notifyHistoryHolder struct {
	mu      sync.Mutex
	path    string
	entries []notifyHistoryEntry
	nextID  int64
}

// setPath installs the persistence path and loads the file. A missing
// file starts empty; a present-but-bad file returns the error (the
// caller — LoadNotifyStore — fails startup on it). An over-cap file is
// trimmed to the newest notifyHistoryMaxEntries.
func (h *notifyHistoryHolder) setPath(path string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.path = path
	h.entries = nil
	h.nextID = 1
	f, present, err := loadNotifyHistoryFile(path)
	if err != nil {
		h.path = ""
		return err
	}
	if present {
		h.entries = f.Events
		if len(h.entries) > notifyHistoryMaxEntries {
			h.entries = h.entries[len(h.entries)-notifyHistoryMaxEntries:]
			// Trim is a load-time repair of a hand-edited file; persist
			// the trimmed shape so the file matches memory.
			if err := h.persistLocked(); err != nil {
				log.Printf("notify: history load-trim persist failed (continuing in memory): %v", err)
			}
		}
		if n := len(h.entries); n > 0 {
			h.nextID = h.entries[n-1].ID + 1
		}
	}
	return nil
}

// append records one emitted transition and persists. ids are assigned
// monotonically from nextID. The persist is best-effort-by-log (the
// in-memory window stays authoritative for this process; a failed
// history persist must never unwind the watcher loop) — deliberately
// LOUDER than recordSendResult's silent swallow because this file IS
// the reliable record, but equally non-fatal. Callers: the watcher loop
// only (serialized appends keep ids monotonic); readers go through
// query.
func (h *notifyHistoryHolder) append(e notifyHistoryEntry) notifyHistoryEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return e // unconfigured: no-op (the watcher never runs in this posture)
	}
	if e.ID == 0 {
		e.ID = h.nextID
		h.nextID++
	}
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	if e.Deliveries == nil {
		e.Deliveries = []notifyDeliveryRecord{}
	}
	h.entries = append(h.entries, e)
	if over := len(h.entries) - notifyHistoryMaxEntries; over > 0 {
		h.entries = h.entries[over:]
	}
	if err := h.persistLocked(); err != nil {
		log.Printf("notify: history append persist failed (kept in memory): %v", err)
	}
	return e
}

// persistLocked writes the canonical form; caller holds h.mu.
func (h *notifyHistoryHolder) persistLocked() error {
	if h.path == "" {
		return errors.New("no persistence path configured")
	}
	data, err := json.MarshalIndent(notifyHistoryFile{Schema: notifyHistorySchema, Events: h.entries}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal notify history: %v", err)
	}
	data = append(data, '\n')
	return persistAtomic0600(h.path, data)
}

// query returns up to limit entries with id > since, ASCENDING, plus
// the first/last id of the returned slice (0 when empty). The holder
// stores ascending, so the slice is a simple window.
func (h *notifyHistoryHolder) query(since int64, limit int) (entries []notifyHistoryEntry, firstID, lastID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entries = []notifyHistoryEntry{}
	for i := range h.entries {
		if h.entries[i].ID <= since {
			continue
		}
		entries = append(entries, h.entries[i])
		if len(entries) == limit {
			break
		}
	}
	if n := len(entries); n > 0 {
		firstID, lastID = entries[0].ID, entries[n-1].ID
	}
	return entries, firstID, lastID
}

// ---------------------------------------------------------------------------
// HTTP: GET /vh/notify/history
// ---------------------------------------------------------------------------

// handleNotifyHistory serves GET /vh/notify/history — the reliable
// delivery record for the companion app / management UI. Same
// session-cookie auth family as the rest of /vh/notify/* (read-only,
// CSRF-exempt by the repo GET convention); automatically carved out of
// the worker-subdomain proxy by the existing /vh/notify/ prefix rule.
//
// Query: since=<id> (exclusive cursor; default 0 = from the oldest
// retained), limit=<n> (default 50, clamped to 200; non-numeric values
// are 400s). Response (ascending):
//
//	{"schema":1,"events":[…entries…],"first_id":N,"last_id":M}
//
// 409 when the registry is disabled (no --notify-store): the history
// derives from the registry path, so there is nothing honest to serve.
// Entries survive restarts (file-backed); the bounded window means
// since-cursors older than the trim line simply return from the oldest
// retained entry.
func (d *Daemon) handleNotifyHistory(w http.ResponseWriter, r *http.Request) {
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	q := r.URL.Query()
	since := int64(0)
	if s := q.Get("since"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			http.Error(w, "invalid since: must be a non-negative integer event id", http.StatusBadRequest)
			return
		}
		since = v
	}
	limit := notifyHistoryDefaultLimit
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 {
			http.Error(w, "invalid limit: must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = v
	}
	if limit > notifyHistoryMaxLimit {
		limit = notifyHistoryMaxLimit
	}
	entries, firstID, lastID := d.notifyHistory.query(since, limit)
	writeNotifyJSON(w, http.StatusOK, struct {
		Schema  int                  `json:"schema"`
		Events  []notifyHistoryEntry `json:"events"`
		FirstID int64                `json:"first_id"`
		LastID  int64                `json:"last_id"`
	}{Schema: 1, Events: entries, FirstID: firstID, LastID: lastID})
}
