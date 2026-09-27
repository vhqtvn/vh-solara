package server

// notify_history_test.go — lane-1 co-located tests for the notification
// delivery history (slice S2; see notify_history.go). Covers: the strict
// decode matrix, append/trim(500)/persist/reload round-trips, id
// monotonicity across trims and restarts, the query window semantics,
// and GET /vh/notify/history through the REAL handler chain (auth
// ladder, 409-disabled posture, since/limit validation, ascending
// order, additive envelope).

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newHistoryHolder installs a history holder (and its registry holder,
// via the real LoadNotifyStore path) rooted in a temp dir.
func newHistoryHolder(t *testing.T) (*Daemon, *notifyHistoryHolder, string) {
	t.Helper()
	d := NewDaemon(":0", ":0", "")
	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatalf("seed empty store: %v", err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}
	return d, &d.notifyHistory, path + ".history"
}

// histEntry builds a minimal valid entry for append-driven tests.
func histEntry(kind, action string, count int) notifyHistoryEntry {
	return notifyHistoryEntry{Kind: kind, Action: action, Count: count, Title: "vh-solara", Body: "b"}
}

// ---------------------------------------------------------------------------
// Decode matrix
// ---------------------------------------------------------------------------

// TestNotifyHistory_DecodeMatrix pins the file contract: strict fields,
// schema-1 gate, strictly-ascending ids, vocabulary-validated kind and
// action, single document.
func TestNotifyHistory_DecodeMatrix(t *testing.T) {
	valid := []struct{ name, in string }{
		{"empty history", `{"schema":1,"events":[]}`},
		{"nil events", `{"schema":1}`},
		{"one entry", `{"schema":1,"events":[{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"vh-solara","body":"1 worker down","deliveries":[{"token_id":"0011223344556677","ok":true}]}]}`},
		{"retired delivery", `{"schema":1,"events":[{"id":7,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"cleared","count":0,"title":"vh-solara","body":"1 worker down (cleared)","deliveries":[{"token_id":"0011223344556677","ok":false,"error":"boom","retired":true}]}]}`},
	}
	for _, tc := range valid {
		if _, err := decodeNotifyHistory([]byte(tc.in)); err != nil {
			t.Errorf("%s: unexpected error: %v", tc.name, err)
		}
	}
	invalid := []struct{ name, in, marker string }{
		{"empty document", ``, "empty document"},
		{"null document", `null`, "not null"},
		{"trailing document", `{"schema":1,"events":[]} {}`, "exactly one JSON document"},
		{"unknown top key", `{"schema":1,"events":[],"x":1}`, `unknown field "x"`},
		{"unknown entry key", `{"schema":1,"events":[{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b","deliveries":[],"z":1}]}`, `unknown field "z"`},
		{"wrong schema", `{"schema":2,"events":[]}`, "schema version 2"},
		{"non-ascending ids", `{"schema":1,"events":[{"id":2,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b"},{"id":2,"ts":"2026-09-28T00:00:01Z","kind":"worker_down","action":"cleared","count":0,"title":"t","body":"b"}]}`, "strictly ascending"},
		{"unknown kind", `{"schema":1,"events":[{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"made_up","action":"appeared","count":1,"title":"t","body":"b"}]}`, `unknown condition "made_up"`},
		{"unknown action", `{"schema":1,"events":[{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"vanished","count":1,"title":"t","body":"b"}]}`, `unknown action "vanished"`},
	}
	for _, tc := range invalid {
		_, err := decodeNotifyHistory([]byte(tc.in))
		if err == nil {
			t.Errorf("%s: accepted invalid document", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.marker) {
			t.Errorf("%s: error %q does not contain marker %q", tc.name, err.Error(), tc.marker)
		}
	}
}

// TestNotifyHistory_MissingFileStartsEmpty pins the first-boot posture:
// a MISSING history file is an empty history (not an error).
func TestNotifyHistory_MissingFileStartsEmpty(t *testing.T) {
	_, h, path := newHistoryHolder(t)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected no history file yet, stat err=%v", err)
	}
	if got := len(h.queryAllForTest()); got != 0 {
		t.Errorf("fresh history must be empty, has %d entries", got)
	}
	// And appends work from there.
	h.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))
	if entries, _, _ := h.query(0, 10); len(entries) != 1 || entries[0].ID != 1 {
		t.Fatalf("append after empty start: %+v", entries)
	}
}

// queryAllForTest is an unbounded read for assertions.
func (h *notifyHistoryHolder) queryAllForTest() []notifyHistoryEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]notifyHistoryEntry(nil), h.entries...)
}

// TestNotifyHistory_BadFileFailsLoad pins the set-but-bad discipline: a
// present-but-corrupt history file fails LoadNotifyStore (the reliable
// record is not silently discarded).
func TestNotifyHistory_BadFileFailsLoad(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "tokens.json")
	if err := persistNotifyStore(storePath, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(storePath+".history", []byte(`{"schema":1,"events":[{`), 0o600); err != nil {
		t.Fatal(err)
	}
	d := NewDaemon(":0", ":0", "")
	if err := d.LoadNotifyStore(storePath); err == nil {
		t.Fatal("corrupt history file must fail LoadNotifyStore")
	} else if !strings.Contains(err.Error(), ".history") {
		t.Errorf("error must name the history path: %v", err)
	}
}

// TestNotifyHistory_AppendTrimPersistReload pins the bounded-window
// contract: appending past the cap trims the OLDEST, the file always
// reloads through the strict reader, ids stay monotonic across the trim
// and across a RELOAD (a fresh holder resumes above the newest id), and
// the persisted mode is 0600 like the registry.
func TestNotifyHistory_AppendTrimPersistReload(t *testing.T) {
	_, h, path := newHistoryHolder(t)
	for i := 0; i < notifyHistoryMaxEntries+25; i++ {
		h.append(histEntry(fleetCondSessionError, notifyActionChanged, i+1))
	}
	all := h.queryAllForTest()
	if len(all) != notifyHistoryMaxEntries {
		t.Fatalf("window must be capped at %d, has %d", notifyHistoryMaxEntries, len(all))
	}
	if wantFirst := int64(26); all[0].ID != wantFirst {
		t.Errorf("oldest retained id = %d, want %d (trimmed)", all[0].ID, wantFirst)
	}
	if wantLast := int64(notifyHistoryMaxEntries + 25); all[len(all)-1].ID != wantLast {
		t.Errorf("newest id = %d, want %d", all[len(all)-1].ID, wantLast)
	}

	// Strict reload of our own canonical bytes.
	f, present, err := loadNotifyHistoryFile(path)
	if err != nil || !present {
		t.Fatalf("reload: present=%v err=%v", present, err)
	}
	if len(f.Events) != notifyHistoryMaxEntries || f.Events[0].ID != 26 {
		t.Fatalf("reloaded window: %d entries, first=%d", len(f.Events), firstIDOf(f.Events))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("history file mode = %o, want 600 (same discipline as the registry)", perm)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("persist must leave no tmp artifact, stat err=%v", err)
	}

	// A FRESH holder over the same file resumes ids above the newest.
	d2 := NewDaemon(":0", ":0", "")
	storePath := strings.TrimSuffix(path, ".history")
	if err := d2.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	e := d2.notifyHistory.append(histEntry(fleetCondSessionDone, notifyActionAppeared, 1))
	if e.ID != notifyHistoryMaxEntries+26 {
		t.Errorf("id after reload = %d, want %d (monotonic across restart)", e.ID, notifyHistoryMaxEntries+26)
	}
}

func firstIDOf(entries []notifyHistoryEntry) int64 {
	if len(entries) == 0 {
		return 0
	}
	return entries[0].ID
}

// TestNotifyHistory_QueryWindow pins the since/limit semantics:
// ascending, since-exclusive, limit-bounded.
func TestNotifyHistory_QueryWindow(t *testing.T) {
	_, h, _ := newHistoryHolder(t)
	for i := 0; i < 5; i++ {
		h.append(histEntry(fleetCondWorkerMissing, notifyActionChanged, i+1))
	}
	entries, first, last := h.query(0, 3)
	if len(entries) != 3 || first != 1 || last != 3 {
		t.Fatalf("window(0,3): len=%d first=%d last=%d", len(entries), first, last)
	}
	entries, first, last = h.query(3, 50)
	if len(entries) != 2 || first != 4 || last != 5 {
		t.Fatalf("window(since=3): len=%d first=%d last=%d", len(entries), first, last)
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].ID <= entries[i-1].ID {
			t.Fatalf("query must be ascending: %+v", entries)
		}
	}
	entries, first, last = h.query(99, 10)
	if len(entries) != 0 || first != 0 || last != 0 {
		t.Fatalf("empty window: %+v %d %d", entries, first, last)
	}
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

// TestNotifyHistory_HTTPSurface drives GET /vh/notify/history through
// the REAL chain (auth + userMux): the auth ladder (401 unauthenticated,
// 200 with a session, GET CSRF-exempt), the 409-disabled posture, query
// validation (bad since/limit → 400; limit clamped), and the ascending
// additive envelope.
func TestNotifyHistory_HTTPSurface(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)

	// Disabled posture first: no store configured (authenticated — the
	// auth middleware must pass so the HANDLER's 409 is what answers).
	rec := doNotify(t, h, http.MethodGet, "/vh/notify/history", "", withCookie(session))
	if rec.Code != http.StatusConflict {
		t.Fatalf("disabled history: want 409, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Unauthenticated → clean 401 (API-class /vh/*).
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/history", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: want 401, got %d", rec.Code)
	}

	// Load a store (installs the history path) and seed entries.
	path := filepath.Join(t.TempDir(), "tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	d.notifyHistory.append(notifyHistoryEntry{
		Kind: fleetCondPermissionPending, Action: notifyActionAppeared, Count: 2,
		Title: "vh-solara", Body: "2 permissions pending",
		Deliveries: []notifyDeliveryRecord{{TokenID: "0011223344556677", OK: true}},
	})
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionCleared, 0))

	rec = doNotify(t, h, http.MethodGet, "/vh/notify/history", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("authenticated GET: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var view struct {
		Schema int `json:"schema"`
		Events []struct {
			ID         int64  `json:"id"`
			TS         string `json:"ts"`
			Kind       string `json:"kind"`
			Action     string `json:"action"`
			Count      int    `json:"count"`
			Title      string `json:"title"`
			Body       string `json:"body"`
			Deliveries []struct {
				TokenID string `json:"token_id"`
				OK      bool   `json:"ok"`
				Retired bool   `json:"retired"`
			} `json:"deliveries"`
		} `json:"events"`
		FirstID int64 `json:"first_id"`
		LastID  int64 `json:"last_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode history body: %v (%s)", err, rec.Body.String())
	}
	if view.Schema != 1 || len(view.Events) != 2 || view.FirstID != 1 || view.LastID != 2 {
		t.Fatalf("envelope: schema=%d events=%d first=%d last=%d", view.Schema, len(view.Events), view.FirstID, view.LastID)
	}
	if view.Events[0].Kind != fleetCondPermissionPending || view.Events[0].Action != "appeared" || view.Events[0].Count != 2 {
		t.Fatalf("entry 0: %+v", view.Events[0])
	}
	if view.Events[0].Deliveries[0].TokenID != "0011223344556677" || !view.Events[0].Deliveries[0].OK {
		t.Fatalf("delivery row: %+v", view.Events[0].Deliveries)
	}
	if _, err := time.Parse(time.RFC3339, view.Events[0].TS); err != nil {
		t.Errorf("ts not RFC3339: %q (%v)", view.Events[0].TS, err)
	}

	// since-cursor.
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/history?since=1", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("since query: %d", rec.Code)
	}
	var v2 struct {
		Events  []json.RawMessage `json:"events"`
		FirstID int64             `json:"first_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v2)
	if len(v2.Events) != 1 || v2.FirstID != 2 {
		t.Fatalf("since=1: len=%d first=%d", len(v2.Events), v2.FirstID)
	}

	// Validation ladder.
	for _, q := range []string{"since=-1", "since=abc", "limit=0", "limit=-3", "limit=xyz"} {
		rec = doNotify(t, h, http.MethodGet, "/vh/notify/history?"+q, "", withCookie(session))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("query %q: want 400, got %d (%s)", q, rec.Code, rec.Body.String())
		}
	}

	// limit clamp: asking for 10000 with 2 entries returns both (clamped
	// to 200 — not an error).
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/history?limit=10000", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("clamp query: %d", rec.Code)
	}
}
