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
//	{"schema":1,"read_id":42,"events":[{
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
// read_id is the operator's GLOBAL read-through cursor (Slice 2,
// 2026-09): the single highest history id the operator has SEEN, shared
// by every device ("seen on the phone → dimmed on the watch"; the
// server is single-operator, so there is exactly one cursor and no
// per-token/per-device dimension). It is persisted IN THIS FILE — the
// same atomic replacement that carries the retained events carries the
// cursor, so an acknowledged cursor can never outrun the events a
// restart would reload (an ack first persists events+cursor together,
// then makes the cursor visible in memory). The field is omitted while
// zero (omitempty), so a never-acked history keeps the legacy byte
// shape. DOWNGRADE HAZARD: an older strict-decoding binary (pre-cursor)
// rejects a file carrying read_id at startup — back the file up before
// downgrading; the controller does not silently reset or migrate it.
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
// on load. A persisted read_id below the oldest retained id is
// PRESERVED as-is (a watermark into the trimmed past is still valid —
// trimming never clamps the cursor); a negative read_id or one above
// the newest retained id is corrupt (the writer always persists the
// cursor with the events that established that high-water) and fails
// load with the same startup-failure posture.
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
	"strings"
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

// notifyHistoryFile is the whole persisted document. ReadID is the
// operator-level read-through cursor (see the file-shape comment above);
// omitempty keeps the zero (never-acked) form byte-identical to the
// legacy file.
type notifyHistoryFile struct {
	Schema int                  `json:"schema"`
	ReadID int64                `json:"read_id,omitempty"`
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
	// Read-cursor validation: negative is corrupt; above the newest
	// retained id is corrupt too (the ack path persists the cursor in
	// the SAME atomic write as the events that established that
	// high-water, so a well-formed file can never claim read-through
	// past what it holds). A cursor below the oldest retained id is
	// FINE (a watermark into the trimmed past — kept as-is).
	if f.ReadID < 0 {
		return nil, fmt.Errorf("read_id %d must be non-negative", f.ReadID)
	}
	if n := len(f.Events); n > 0 && f.ReadID > f.Events[n-1].ID {
		return nil, fmt.Errorf("read_id %d is above the newest retained event id %d", f.ReadID, f.Events[n-1].ID)
	}
	if len(f.Events) == 0 && f.ReadID != 0 {
		return nil, fmt.Errorf("read_id %d set but no events are retained", f.ReadID)
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
// posture answers). readID is the operator-level read-through cursor
// (single operator ⇒ one global cursor; see the file-shape comment).
// Zero value usable.
type notifyHistoryHolder struct {
	mu      sync.Mutex
	path    string
	entries []notifyHistoryEntry
	nextID  int64
	readID  int64
}

// setPath installs the persistence path and loads the file. A missing
// file starts empty; a present-but-bad file (including a corrupt
// read_id) returns the error (the caller — LoadNotifyStore — fails
// startup on it). An over-cap file is trimmed to the newest
// notifyHistoryMaxEntries.
func (h *notifyHistoryHolder) setPath(path string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.path = path
	h.entries = nil
	h.nextID = 1
	h.readID = 0
	f, present, err := loadNotifyHistoryFile(path)
	if err != nil {
		h.path = ""
		return err
	}
	if present {
		h.entries = f.Events
		h.readID = f.ReadID
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

// append records one emitted transition and persists (the cursor rides
// along — every history write carries the current read_id, so the
// file's events and cursor can never drift apart). ids are assigned
// monotonically from nextID. The persist is best-effort-by-log (the
// in-memory window stays authoritative for this process; a failed
// history persist must never unwind the watcher loop) — deliberately
// LOUDER than recordSendResult's silent swallow because this file IS
// the reliable record, but equally non-fatal. Callers: the watcher loop
// only (serialized appends keep ids monotonic); readers go through
// query/advanceRead.
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

// persistLocked writes the canonical form (current entries + current
// cursor); caller holds h.mu.
func (h *notifyHistoryHolder) persistLocked() error {
	return h.persistLockedWith(h.readID)
}

// persistLockedWith writes the canonical form with the GIVEN cursor —
// the candidate-first ack path (advanceRead) persists events+newCursor
// BEFORE the in-memory cursor moves, so a persist failure leaves the
// acknowledged-cursor invariant intact with no partial state; caller
// holds h.mu.
func (h *notifyHistoryHolder) persistLockedWith(readID int64) error {
	if h.path == "" {
		return errors.New("no persistence path configured")
	}
	data, err := json.MarshalIndent(notifyHistoryFile{Schema: notifyHistorySchema, ReadID: readID, Events: h.entries}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal notify history: %v", err)
	}
	data = append(data, '\n')
	return persistAtomic0600(h.path, data)
}

// unreadCountLocked counts retained entries with ID > readID — the
// WHOLE retained window, never an archive total (a cursor below the
// trimmed head simply counts everything retained). Entries are
// ascending, so the count is the window minus the prefix at or below
// the cursor. Caller holds h.mu.
func (h *notifyHistoryHolder) unreadCountLocked() int64 {
	unread := int64(len(h.entries))
	for i := range h.entries {
		if h.entries[i].ID > h.readID {
			break
		}
		unread--
	}
	return unread
}

// errNotifyReadFuture marks a read-advance id above the newest ASSIGNED
// event id (nextID-1): the handler maps it to 400 (never clamp).
var errNotifyReadFuture = errors.New("read id above the newest assigned event id")

// advanceRead advances the global read-through cursor to id
// (forward-only, monotonic) and returns the resulting (readID,
// unreadCount) captured under the lock — the coherent pair the read
// mutation and the history GET both echo.
//
//   - id <= current readID (including 0): no-op success — stale or
//     racing devices must never see a conflict or a regression. No disk
//     write; the persisted cursor is already >= id.
//   - id > nextID-1: errNotifyReadFuture (400 at the handler). Trimmed
//     membership is NOT required — any id ever assigned is a valid
//     watermark.
//   - otherwise: persist ALL retained entries + the candidate cursor
//     atomically FIRST (persistLockedWith); only on success does the
//     in-memory cursor move. A persist failure returns the error with
//     the in-memory cursor UNCHANGED (500 at the handler) — the cursor
//     never advances past what a restart can honor, and the ack
//     transitively flushes any memory-only appends into the same
//     replacement.
func (h *notifyHistoryHolder) advanceRead(id int64) (readID, unread int64, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return 0, 0, errors.New("no persistence path configured")
	}
	if id <= h.readID {
		return h.readID, h.unreadCountLocked(), nil
	}
	if id > h.nextID-1 {
		return h.readID, h.unreadCountLocked(), fmt.Errorf("id %d is above the newest event id %d: %w", id, h.nextID-1, errNotifyReadFuture)
	}
	if err := h.persistLockedWith(id); err != nil {
		return h.readID, h.unreadCountLocked(), fmt.Errorf("persist read cursor: %v", err)
	}
	h.readID = id
	return h.readID, h.unreadCountLocked(), nil
}

// readState returns the current cursor + unread count under the lock.
func (h *notifyHistoryHolder) readState() (readID, unread int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.readID, h.unreadCountLocked()
}

// query returns up to limit entries with id > since, ASCENDING, plus
// the first/last id of the returned slice (0 when empty) AND the
// read-cursor metadata (read_id + unread_count) — one lock acquisition,
// so the page and the metadata the GET echoes are a coherent pair. The
// holder stores ascending, so the slice is a simple window.
// unread_count is the WHOLE retained window's count past the cursor,
// independent of since/limit.
func (h *notifyHistoryHolder) query(since int64, limit int) (entries []notifyHistoryEntry, firstID, lastID, readID, unread int64) {
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
	return entries, firstID, lastID, h.readID, h.unreadCountLocked()
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
//	{"schema":1,"events":[…entries…],"first_id":N,"last_id":M,
//	 "read_id":R,"unread_count":U}
//
// read_id is the operator's GLOBAL read-through cursor (Slice 2) and
// unread_count the RETAINED events strictly after it (whole window —
// never an archive total; a cursor below the trimmed first_id counts
// the entire retained window). Page and metadata are captured under
// one holder lock. first_id/last_id stay page-local; existing fields
// are unchanged (additive).
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
	entries, firstID, lastID, readID, unread := d.notifyHistory.query(since, limit)
	writeNotifyJSON(w, http.StatusOK, struct {
		Schema      int                  `json:"schema"`
		Events      []notifyHistoryEntry `json:"events"`
		FirstID     int64                `json:"first_id"`
		LastID      int64                `json:"last_id"`
		ReadID      int64                `json:"read_id"`
		UnreadCount int64                `json:"unread_count"`
	}{Schema: 1, Events: entries, FirstID: firstID, LastID: lastID, ReadID: readID, UnreadCount: unread})
}

// ---------------------------------------------------------------------------
// HTTP: POST /vh/notify/history/read
// ---------------------------------------------------------------------------

// duplicateTopLevelKey scans the TOP LEVEL of a JSON object body and
// returns the first duplicated key ("" when none / not an object /
// not lexically scannable — the strict decode produces the canonical
// error for those). encoding/json's struct decoding silently keeps the
// LAST duplicate; the read-cursor body must not accept that (the
// frozen shared decoder is deliberately unchanged — this local wrapper
// is the read endpoint's own pre-check).
func duplicateTopLevelKey(body []byte) string {
	dec := json.NewDecoder(bytes.NewReader(body))
	tok, err := dec.Token()
	if err != nil {
		return ""
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return ""
	}
	seen := map[string]bool{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return ""
		}
		key, ok := kt.(string)
		if !ok {
			return ""
		}
		if seen[key] {
			return key
		}
		seen[key] = true
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return ""
		}
	}
	return ""
}

// caseVariantIDKey scans the TOP LEVEL of a JSON object body and returns
// the first key that case-folds to "id" without DECODING to exactly
// "id" (e.g. "ID", "Id"). Keys are compared as DECODED tokens —
// json.Decoder.Token resolves \uXXXX escapes — so the wire spelling is
// irrelevant: "\u0069d" decodes to "id" and is the SAME field, never a
// variant. encoding/json matches struct fields case-INSENSITIVELY, so
// a case variant would silently decode into the id field — and an
// {"id":1,"ID":2} pair would last-win past the decoded-key duplicate
// scan above, defeating the exactly-one-id contract. Returns "" when
// none / not an object / not lexically scannable (the strict decode
// produces the canonical error for those). This check subsumes a
// case-folded duplicate scan for this single-field body: of any two
// keys folding to "id", either both decode to exactly "id" (the
// duplicate scan above trips) or at least one is a case variant (this
// scan trips) — no case-folded pair passes both.
func caseVariantIDKey(body []byte) string {
	dec := json.NewDecoder(bytes.NewReader(body))
	tok, err := dec.Token()
	if err != nil {
		return ""
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return ""
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return ""
		}
		key, ok := kt.(string)
		if !ok {
			return ""
		}
		if key != "id" && strings.EqualFold(key, "id") {
			return key
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return ""
		}
	}
	return ""
}

// handleNotifyHistoryRead serves POST /vh/notify/history/read — the
// global read-cursor advance (Slice 2). Body: {"id":<n>} — exactly one
// non-negative int64 (the greatest event id the operator has actually
// SEEN; trimmed ids stay valid watermarks; never auto-ack the newest
// from an unrelated page). Key semantics are DECODED-key semantics: the
// pre-checks scan json.Decoder tokens (which resolve \uXXXX escapes),
// so the contract is exactly one top-level member whose DECODED key is
// precisely "id" — no case folding ("ID", "Id" are rejected pre-decode
// with a 400: encoding/json matches struct fields case-insensitively
// and would silently decode or last-win them) and no duplicates (any
// two members decoding to "id" — including an escaped+exact mix like
// {"\u0069d":1,"id":2} — are a 400 duplicate). A single escape-encoded
// spelling that decodes to exactly "id" is unambiguous and accepted as
// the same field. Check order follows the family: in-handler
// CSRF (403) → store configured (409) → strict bounded decode (400) →
// holder mutation.
//
//   - id <= current cursor (0 included): 200 no-op — stale/replaying
//     devices must not see conflicts; returns the CURRENT state, no
//     disk write.
//   - id above the newest ASSIGNED event id: 400 (never clamp).
//   - persistence failure: plain-text 500 and the in-memory cursor
//     does NOT advance (the cursor never outruns what a restart can
//     honor).
//   - success: {"schema":1,"read_id":N,"unread_count":U} — the same
//     coherent pair GET /vh/notify/history echoes, captured under the
//     holder lock.
//
// Wrong method → the mux's 405 (only POST is registered); same
// session-cookie auth family and /vh/notify/ host carve-out as the
// rest of the family. No token-registry or fleet-cache side effects:
// an ack is invisible to the store generation and the status service.
func (d *Daemon) handleNotifyHistoryRead(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	// Read the bounded body once, run the local duplicate-key pre-check,
	// then hand the buffered bytes to the shared strict decoder (the
	// frozen decodeNotifyBody behavior — reused, not copied).
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNotifyBodyBytes))
	if err != nil {
		http.Error(w, "invalid history read: request body exceeds the byte cap", http.StatusBadRequest)
		return
	}
	if key := duplicateTopLevelKey(body); key != "" {
		http.Error(w, fmt.Sprintf("invalid history read: duplicate key %q (send exactly one id)", key), http.StatusBadRequest)
		return
	}
	if key := caseVariantIDKey(body); key != "" {
		http.Error(w, fmt.Sprintf("invalid history read: key %q must be spelled exactly %q (send exactly one id)", key, "id"), http.StatusBadRequest)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var req struct {
		ID *int64 `json:"id"`
	}
	if err := decodeNotifyBody(w, r, "history read", &req); err != nil {
		return
	}
	if req.ID == nil {
		http.Error(w, "invalid history read: id is required (a non-negative integer event id)", http.StatusBadRequest)
		return
	}
	if *req.ID < 0 {
		http.Error(w, "invalid history read: id must be a non-negative integer event id", http.StatusBadRequest)
		return
	}
	readID, unread, err := d.notifyHistory.advanceRead(*req.ID)
	if err != nil {
		if errors.Is(err, errNotifyReadFuture) {
			http.Error(w, "invalid history read: "+err.Error(), http.StatusBadRequest)
			return
		}
		http.Error(w, "notification history: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeNotifyJSON(w, http.StatusOK, struct {
		Schema      int   `json:"schema"`
		ReadID      int64 `json:"read_id"`
		UnreadCount int64 `json:"unread_count"`
	}{Schema: 1, ReadID: readID, UnreadCount: unread})
}
