package server

// notify_history_test.go — lane-1 co-located tests for the notification
// delivery history (slice S2; see notify_history.go). Covers: the strict
// decode matrix, append/trim(500)/persist/reload round-trips, id
// monotonicity across trims and restarts, the query window semantics,
// and GET /vh/notify/history through the REAL handler chain (auth
// ladder, 409-disabled posture, since/limit validation, ascending
// order, additive envelope).

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	if entries, _, _, _, _ := h.query(0, 10); len(entries) != 1 || entries[0].ID != 1 {
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
	entries, first, last, _, _ := h.query(0, 3)
	if len(entries) != 3 || first != 1 || last != 3 {
		t.Fatalf("window(0,3): len=%d first=%d last=%d", len(entries), first, last)
	}
	entries, first, last, _, _ = h.query(3, 50)
	if len(entries) != 2 || first != 4 || last != 5 {
		t.Fatalf("window(since=3): len=%d first=%d last=%d", len(entries), first, last)
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].ID <= entries[i-1].ID {
			t.Fatalf("query must be ascending: %+v", entries)
		}
	}
	entries, first, last, _, _ = h.query(99, 10)
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

// ---------------------------------------------------------------------------
// Global read cursor (Slice 2 — POST /vh/notify/history/read)
// ---------------------------------------------------------------------------

// withReadCursor is decodeNotifyHistory's file fixture helper: a valid
// event list plus an explicit read_id.
func withReadCursor(events, readID string) string {
	return `{"schema":1,"read_id":` + readID + `,"events":[` + events + `]}`
}

const hist3Events = `{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b"},{"id":2,"ts":"2026-09-28T00:01:00Z","kind":"worker_down","action":"changed","count":2,"title":"t","body":"b"},{"id":3,"ts":"2026-09-28T00:02:00Z","kind":"worker_down","action":"cleared","count":0,"title":"t","body":"b"}`

// TestNotifyRead_DecodeMatrix pins the PERSISTED read_id contract:
// optional (legacy files decode at 0), any watermark within the retained
// window is valid (including below the oldest retained — a trimmed
// watermark), and negative / above-newest / empty-events-nonzero /
// wrong-typed values are corrupt.
func TestNotifyRead_DecodeMatrix(t *testing.T) {
	valid := []struct{ name, in string }{
		{"legacy no cursor", `{"schema":1,"events":[{"id":3,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b"}]}`},
		{"cursor zero explicit", `{"schema":1,"read_id":0,"events":[{"id":3,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b"}]}`},
		{"cursor at newest", withReadCursor(hist3Events, "3")},
		{"cursor mid window", withReadCursor(hist3Events, "2")},
		{"cursor below oldest retained (trimmed watermark)", withReadCursor(hist3Events, "0")},
	}
	for _, tc := range valid {
		f, err := decodeNotifyHistory([]byte(tc.in))
		if err != nil {
			t.Errorf("%s: unexpected error: %v", tc.name, err)
			continue
		}
		if tc.name == "legacy no cursor" && f.ReadID != 0 {
			t.Errorf("%s: legacy file must decode read_id 0, got %d", tc.name, f.ReadID)
		}
	}
	invalid := []struct{ name, in, marker string }{
		{"negative cursor", withReadCursor(hist3Events, "-1"), "non-negative"},
		{"cursor above newest", withReadCursor(hist3Events, "4"), "above the newest retained event id 3"},
		{"cursor with empty events", `{"schema":1,"read_id":2,"events":[]}`, "no events are retained"},
		{"cursor wrong type", withReadCursor(hist3Events, `"2"`), "cannot unmarshal"},
		{"unknown cursor key", `{"schema":1,"readCursor":2,"events":[]}`, `unknown field "readCursor"`},
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

// TestNotifyRead_LoadLegacyZeroAndReloadHonored pins the restart
// contract end to end: a legacy (cursor-less) file loads at 0; an ack
// persists events+cursor together (0600, no tmp artifact); a FRESH
// holder over the same file honors the cursor.
func TestNotifyRead_LoadLegacyZeroAndReloadHonored(t *testing.T) {
	dir := t.TempDir()
	storePath := filepath.Join(dir, "tokens.json")
	if err := persistNotifyStore(storePath, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(storePath+".history", []byte(withReadCursor(hist3Events, "0")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d := NewDaemon(":0", ":0", "")
	if err := d.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	if rid, unread := d.notifyHistory.readState(); rid != 0 || unread != 3 {
		t.Fatalf("legacy load: read_id=%d unread=%d, want 0/3", rid, unread)
	}
	rid, unread, err := d.notifyHistory.advanceRead(2)
	if err != nil || rid != 2 || unread != 1 {
		t.Fatalf("advance(2): rid=%d unread=%d err=%v", rid, unread, err)
	}
	// The ack persist keeps the 0600 discipline and no tmp artifact.
	info, err := os.Stat(storePath + ".history")
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("history file mode after ack = %o, want 600", perm)
	}
	if _, err := os.Stat(storePath + ".history.tmp"); !os.IsNotExist(err) {
		t.Errorf("ack persist must leave no tmp artifact, stat err=%v", err)
	}
	// Fresh holder (restart) honors the cursor.
	d2 := NewDaemon(":0", ":0", "")
	if err := d2.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	if rid, unread := d2.notifyHistory.readState(); rid != 2 || unread != 1 {
		t.Fatalf("after reload: read_id=%d unread=%d, want 2/1", rid, unread)
	}
	// and ids resume above the persisted newest.
	if e := d2.notifyHistory.append(histEntry(fleetCondSessionDone, notifyActionAppeared, 1)); e.ID != 4 {
		t.Fatalf("append after reload: id=%d, want 4", e.ID)
	}
}

// TestNotifyRead_BadPersistedCursorFailsLoad pins the startup-failure
// posture for a corrupt persisted cursor (negative / future).
func TestNotifyRead_BadPersistedCursorFailsLoad(t *testing.T) {
	for _, tc := range []struct{ name, cursor string }{
		{"negative", "-1"},
		{"above newest", "4"},
	} {
		dir := t.TempDir()
		storePath := filepath.Join(dir, "tokens.json")
		if err := persistNotifyStore(storePath, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(storePath+".history", []byte(withReadCursor(hist3Events, tc.cursor)+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		d := NewDaemon(":0", ":0", "")
		err := d.LoadNotifyStore(storePath)
		if err == nil {
			t.Errorf("%s: corrupt cursor must fail LoadNotifyStore", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), ".history") || !strings.Contains(err.Error(), "read_id") {
			t.Errorf("%s: error must name the history path and the cursor: %v", tc.name, err)
		}
	}
}

// TestNotifyRead_AdvanceMatrix pins the holder-level advance semantics:
// stale/equal/zero ids are no-op successes with NO disk write, future
// ids are refused without clamping and without a write, success
// advances and recounts, and a TRIMMED id remains a valid watermark
// (a cursor below the trimmed head is preserved, never clamped).
func TestNotifyRead_AdvanceMatrix(t *testing.T) {
	_, h, path := newHistoryHolder(t)
	for i := 0; i < 5; i++ {
		h.append(histEntry(fleetCondSessionError, notifyActionChanged, i+1))
	}
	before, _ := os.ReadFile(path)

	// Zero on a fresh cursor: no-op success, byte-identical file.
	rid, unread, err := h.advanceRead(0)
	if err != nil || rid != 0 || unread != 5 {
		t.Fatalf("advance(0): rid=%d unread=%d err=%v", rid, unread, err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Fatal("advance(0) must not touch the file")
	}

	// Advance to 3: unread drops to 2.
	if rid, unread, err = h.advanceRead(3); err != nil || rid != 3 || unread != 2 {
		t.Fatalf("advance(3): rid=%d unread=%d err=%v", rid, unread, err)
	}
	state3, _ := os.ReadFile(path)

	// Stale (1) and equal (3): no-op success, unchanged state, no write.
	for _, id := range []int64{1, 3} {
		if rid, unread, err = h.advanceRead(id); err != nil || rid != 3 || unread != 2 {
			t.Fatalf("advance(%d) after 3: rid=%d unread=%d err=%v", id, rid, unread, err)
		}
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(state3, after) {
		t.Fatal("no-op advance must not touch the file")
	}

	// Future id (above newest assigned 5): refused, never clamped,
	// no write, cursor unmoved.
	if _, _, err = h.advanceRead(6); !errors.Is(err, errNotifyReadFuture) {
		t.Fatalf("advance(6): want errNotifyReadFuture, got %v", err)
	}
	if rid, _ = h.readState(); rid != 3 {
		t.Fatalf("refused advance must not move the cursor, got %d", rid)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(state3, after) {
		t.Fatal("refused advance must not touch the file")
	}

	// Trimmed watermark: a hand-made file whose cursor (7) is below its
	// oldest retained id (400) loads preserved — not clamped — and
	// re-acking the watermark stays a no-op; advancing to the retained
	// newest works from there.
	dir := t.TempDir()
	storePath := filepath.Join(dir, "tokens.json")
	if err := persistNotifyStore(storePath, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	trimmed := `{"id":400,"ts":"2026-09-28T00:00:00Z","kind":"worker_down","action":"appeared","count":1,"title":"t","body":"b"},{"id":401,"ts":"2026-09-28T00:01:00Z","kind":"worker_down","action":"cleared","count":0,"title":"t","body":"b"}`
	if err := os.WriteFile(storePath+".history", []byte(withReadCursor(trimmed, "7")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d2 := NewDaemon(":0", ":0", "")
	if err := d2.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	if rid, unread := d2.notifyHistory.readState(); rid != 7 || unread != 2 {
		t.Fatalf("trimmed-head cursor: read_id=%d unread=%d, want 7/2 (whole retained window)", rid, unread)
	}
	if rid, unread, err := d2.notifyHistory.advanceRead(7); err != nil || rid != 7 || unread != 2 {
		t.Fatalf("re-ack trimmed watermark: rid=%d unread=%d err=%v", rid, unread, err)
	}
	if rid, unread, err := d2.notifyHistory.advanceRead(401); err != nil || rid != 401 || unread != 0 {
		t.Fatalf("advance to retained newest: rid=%d unread=%d err=%v", rid, unread, err)
	}
}

// breakHistoryFileForPersist replaces the history file with a directory
// so persistAtomic0600's rename fails deterministically (rename(file →
// empty dir) fails with EEXIST/EISDIR on Linux; works even as root).
// The file's bytes are snapshotted and restored, so the pre-break
// persisted state survives the round trip. Returns a restore func.
func breakHistoryFileForPersist(t *testing.T, path string) (restore func()) {
	t.Helper()
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("break: history file must exist first: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	return func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, saved, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// TestNotifyRead_PersistFailureAtomicity pins the failure/restart
// invariants (the brief's B1 condition):
//   - a failed ack persist → error, in-memory cursor UNCHANGED, retry
//     succeeds once the disk recovers;
//   - memory-only appends (failed append persist) + a successful ack
//     persist entries+cursor TOGETHER — a restart keeps both;
//   - after an acknowledged cursor, a failed append persist + restart
//     reuses only UNACKNOWLEDGED ids (the pre-existing append-failure
//     semantics are preserved);
//   - subsequent appends carry the cursor.
func TestNotifyRead_PersistFailureAtomicity(t *testing.T) {
	_, h, path := newHistoryHolder(t)

	// --- Phase 1: failed ack leaves the cursor unchanged. ---
	h.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))
	h.append(histEntry(fleetCondWorkerDown, notifyActionCleared, 0))
	restore := breakHistoryFileForPersist(t, path)
	rid, _, err := h.advanceRead(2)
	if err == nil || errors.Is(err, errNotifyReadFuture) {
		t.Fatalf("advance under broken persist: want persist error, got %v", err)
	}
	if rid != 0 {
		t.Fatalf("failed advance must not move the in-memory cursor, got %d", rid)
	}
	if rid, _ := h.readState(); rid != 0 {
		t.Fatalf("failed advance must not move the cursor, got %d", rid)
	}
	restore()

	// Retry after recovery: succeeds, and the file carries events+cursor.
	if rid, unread, err := h.advanceRead(2); err != nil || rid != 2 || unread != 0 {
		t.Fatalf("retry advance(2): rid=%d unread=%d err=%v", rid, unread, err)
	}
	fixed, _ := os.ReadFile(path)
	if !strings.Contains(string(fixed), `"read_id": 2`) {
		t.Fatalf("persisted file must carry the cursor, got: %s", fixed)
	}

	// --- Phase 2: memory-only appends + ack = one atomic flush. ---
	restore = breakHistoryFileForPersist(t, path)
	e3 := h.append(histEntry(fleetCondSessionError, notifyActionChanged, 3)) // persist fails, kept in memory
	if e3.ID != 3 {
		t.Fatalf("memory-only append id=%d, want 3", e3.ID)
	}
	if got := len(h.queryAllForTest()); got != 3 {
		t.Fatalf("memory-only append must stay in memory (original semantics), have %d", got)
	}
	restore()
	if rid, unread, err := h.advanceRead(3); err != nil || rid != 3 || unread != 0 {
		t.Fatalf("ack after memory-only append: rid=%d unread=%d err=%v", rid, unread, err)
	}

	// Restart: entries (incl. the memory-only one) AND cursor survive.
	storePath := strings.TrimSuffix(path, ".history")
	d2 := NewDaemon(":0", ":0", "")
	if err := d2.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	if got := len(d2.notifyHistory.queryAllForTest()); got != 3 {
		t.Fatalf("restart after ack flush: %d entries, want 3 (memory-only append persisted by the ack)", got)
	}
	if rid, _ := d2.notifyHistory.readState(); rid != 3 {
		t.Fatalf("restart after ack flush: read_id=%d, want 3", rid)
	}

	// --- Phase 3: ack then failed append then restart: the acked id is
	// never reused; only the UNACKNOWLEDGED id may be reused. ---
	restore = breakHistoryFileForPersist(t, path)
	e4 := h.append(histEntry(fleetCondSessionDone, notifyActionAppeared, 1)) // id 4, memory-only
	if e4.ID != 4 {
		t.Fatalf("memory-only append id=%d, want 4", e4.ID)
	}
	restore() // disk recovers; nothing re-persisted yet
	d3 := NewDaemon(":0", ":0", "")
	if err := d3.LoadNotifyStore(storePath); err != nil {
		t.Fatal(err)
	}
	if rid, _ := d3.notifyHistory.readState(); rid != 3 {
		t.Fatalf("restart after ack+failed-append: read_id=%d, want 3 (the acknowledged cursor survives)", rid)
	}
	if got := len(d3.notifyHistory.queryAllForTest()); got != 3 {
		t.Fatalf("restart after ack+failed-append: %d entries, want 3 (the unacknowledged append is lost — original semantics)", got)
	}
	next := d3.notifyHistory.append(histEntry(fleetCondSessionDone, notifyActionAppeared, 1))
	if next.ID != 4 {
		t.Fatalf("next id after restart = %d, want 4 (reuse allowed only for the unacknowledged id)", next.ID)
	}
	if rid, unread := d3.notifyHistory.readState(); rid != 3 || unread != 1 {
		t.Fatalf("post-restart state: read_id=%d unread=%d, want 3/1 (the re-emitted event is unread again)", rid, unread)
	}

	// --- Phase 4: subsequent appends carry the cursor. ---
	fin, _ := os.ReadFile(path)
	if !strings.Contains(string(fin), `"read_id": 3`) {
		t.Fatalf("append after ack must persist the cursor too, got: %s", fin)
	}
}

// TestNotifyRead_UnreadWindow pins the retained-window unread
// semantics: the count is independent of pagination, a cursor below the
// trimmed head stays put (no clamp) and counts the whole window, an
// empty history counts zero, and page-local first/last are unchanged.
func TestNotifyRead_UnreadWindow(t *testing.T) {
	_, h, _ := newHistoryHolder(t)
	// Empty history: cursor 0, unread 0.
	if entries, first, last, rid, unread := h.query(0, 50); len(entries) != 0 || first != 0 || last != 0 || rid != 0 || unread != 0 {
		t.Fatalf("empty history: entries=%d %d %d %d %d", len(entries), first, last, rid, unread)
	}
	for i := 0; i < 8; i++ {
		h.append(histEntry(fleetCondWorkerMissing, notifyActionChanged, i+1))
	}
	if _, _, _, rid, unread := h.query(0, 1); rid != 0 || unread != 8 {
		t.Fatalf("limit=1 page: read_id=%d unread=%d, want 0/8 (whole-window count, pagination-independent)", rid, unread)
	}
	if _, _, _, _, unread := h.query(0, 200); unread != 8 {
		t.Fatalf("limit=200 page: unread=%d, want 8", unread)
	}
	if _, _, err := h.advanceRead(5); err != nil {
		t.Fatal(err)
	}
	// read-through 5 leaves later appends unread.
	h.append(histEntry(fleetCondWorkerMissing, notifyActionChanged, 9))
	if _, _, _, rid, unread := h.query(0, 1); rid != 5 || unread != 4 {
		t.Fatalf("after read-through 5 + new event: read_id=%d unread=%d, want 5/4", rid, unread)
	}
	// Stale replay is a no-op even here.
	if _, _, err := h.advanceRead(2); err != nil {
		t.Fatal(err)
	}

	// 500 more appends: the window trims past the cursor (oldest
	// retained becomes 10). Cursor preserved (not clamped), unread =
	// the whole retained window, page-local first/last unchanged.
	for i := 0; i < notifyHistoryMaxEntries; i++ {
		h.append(histEntry(fleetCondWorkerMissing, notifyActionChanged, i+1))
	}
	entries, first, last, rid, unread := h.query(0, 2)
	if rid != 5 {
		t.Fatalf("trim must not clamp the cursor: read_id=%d, want 5", rid)
	}
	if unread != notifyHistoryMaxEntries {
		t.Fatalf("cursor below trimmed head: unread=%d, want %d (whole retained window)", unread, notifyHistoryMaxEntries)
	}
	if len(entries) != 2 || first != 10 || last != 11 {
		t.Fatalf("page shape after trim: len=%d first=%d last=%d, want 2/10/11", len(entries), first, last)
	}
}

// TestNotifyRead_ConcurrentNoRegress drives concurrent increasing and
// decreasing advances (plus stale replays) against one holder; the
// cursor must end at the highest acknowledged id and never regress
// (run under -race for the lock proof).
func TestNotifyRead_ConcurrentNoRegress(t *testing.T) {
	_, h, _ := newHistoryHolder(t)
	for i := 0; i < 20; i++ {
		h.append(histEntry(fleetCondSessionRetry, notifyActionChanged, i+1))
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			if _, _, err := h.advanceRead(id); err != nil {
				t.Errorf("advance(%d): %v", id, err)
			}
		}(int64(i + 1))
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := h.advanceRead(7); err != nil { // stale replays
				t.Errorf("stale advance: %v", err)
			}
		}()
	}
	wg.Wait()
	if rid, unread := h.readState(); rid != 20 || unread != 0 {
		t.Fatalf("after concurrent advances: read_id=%d unread=%d, want 20/0", rid, unread)
	}
}

// TestNotifyRead_NoStoreOrFleetSideEffects pins that an ack touches
// neither the token registry (no structural-generation bump) nor the
// fleet-status machinery (same current generation, no refresh, no
// stream subscribers after an ack through the real handler).
func TestNotifyRead_NoStoreOrFleetSideEffects(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	path := filepath.Join(t.TempDir(), "tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))

	d.notifyStore.mu.Lock()
	genBefore := d.notifyStore.gen
	d.notifyStore.mu.Unlock()
	d.fleetStatus.mu.Lock()
	curBefore, refreshesBefore, subsBefore := d.fleetStatus.cur, d.fleetStatus.refreshes, len(d.fleetStatus.subs)
	d.fleetStatus.mu.Unlock()

	rec := doRead(t, h, `{"id":1}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("ack through handler: %d (%s)", rec.Code, rec.Body.String())
	}

	d.notifyStore.mu.Lock()
	genAfter := d.notifyStore.gen
	d.notifyStore.mu.Unlock()
	d.fleetStatus.mu.Lock()
	curAfter, refreshesAfter, subsAfter := d.fleetStatus.cur, d.fleetStatus.refreshes, len(d.fleetStatus.subs)
	d.fleetStatus.mu.Unlock()
	if genBefore != genAfter {
		t.Fatalf("ack must not bump the token-store generation: %d -> %d", genBefore, genAfter)
	}
	if curBefore != curAfter || refreshesBefore != refreshesAfter || subsBefore != subsAfter {
		t.Fatalf("ack must not touch the fleet-status service: cur %p->%p refreshes %d->%d subs %d->%d",
			curBefore, curAfter, refreshesBefore, refreshesAfter, subsBefore, subsAfter)
	}
}

// ---------------------------------------------------------------------------
// HTTP: POST /vh/notify/history/read (real chain)
// ---------------------------------------------------------------------------

// doRead issues a POST /vh/notify/history/read through the real chain
// with the standard decorators.
func doRead(t *testing.T, h http.Handler, body string, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	return doNotify(t, h, http.MethodPost, "/vh/notify/history/read", body, opts...)
}

// TestNotifyRead_HTTPMatrix drives the read mutation through the REAL
// chain: auth ladder (401/403/405), 409-disabled (after CSRF), the
// strict body matrix, the future-id refusal, success + echo, no-op
// replay, the history GET echo, and the persist-failure 500 without an
// in-memory advance.
func TestNotifyRead_HTTPMatrix(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)

	// Unauthenticated → clean 401 (API-class /vh/*).
	if rec := doRead(t, h, `{"id":1}`, withCSRF()); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read: want 401, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Authenticated but no CSRF → the in-handler 403 fires BEFORE the
	// 409 (store not yet configured — check-order proof).
	if rec := doRead(t, h, `{"id":1}`, withCookie(session)); rec.Code != http.StatusForbidden {
		t.Fatalf("read without CSRF: want 403, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Disabled store (with CSRF) → honest 409.
	if rec := doRead(t, h, `{"id":1}`, withCookie(session), withCSRF()); rec.Code != http.StatusConflict {
		t.Fatalf("read with no store: want 409, got %d (%s)", rec.Code, rec.Body.String())
	}
	// Wrong method: GET on the read path → the mux 405.
	if rec := doNotify(t, h, http.MethodGet, "/vh/notify/history/read", "", withCookie(session), withCSRF()); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET read path: want 405, got %d", rec.Code)
	}

	// Configure the store, seed two entries.
	path := filepath.Join(t.TempDir(), "tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	d.notifyHistory.append(histEntry(fleetCondPermissionPending, notifyActionAppeared, 2))
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionCleared, 0))

	// Strict body matrix — every one a 400, none advancing the cursor.
	for _, tc := range []struct{ name, body string }{
		{"missing id", `{}`},
		{"null id", `{"id":null}`},
		{"duplicate id", `{"id":1,"id":2}`},
		{"duplicate reversed", `{"id":2,"id":1}`},
		{"case-variant key alone", `{"ID":2}`},
		{"exact plus case-variant key", `{"id":1,"ID":2}`},
		{"unknown field", `{"id":1,"x":2}`},
		{"negative", `{"id":-1}`},
		{"fraction", `{"id":1.5}`},
		{"exponent", `{"id":1e3}`},
		{"overflow", `{"id":9223372036854775808}`},
		{"string", `{"id":"2"}`},
		{"bool", `{"id":true}`},
		{"trailing doc", `{"id":1}{"id":2}`},
		{"empty body", ``},
		{"array body", `[1]`},
		{"future id", `{"id":99}`},
	} {
		rec := doRead(t, h, tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
		if tc.name == "future id" && !strings.Contains(rec.Body.String(), "newest event id 2") {
			t.Errorf("future id refusal must name the newest id: %s", rec.Body.String())
		}
	}
	// Oversized body → the byte-cap 400.
	rec := doRead(t, h, `{"id":1,"pad":"`+strings.Repeat("x", maxNotifyBodyBytes)+`"}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusBadRequest {
		t.Errorf("oversized body: want 400, got %d", rec.Code)
	}
	if rid, _ := d.notifyHistory.readState(); rid != 0 {
		t.Fatalf("rejected bodies must not advance the cursor, got %d", rid)
	}

	// Zero is a valid (no-op) acknowledgement.
	rec = doRead(t, h, `{"id":0}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("read(0): want 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Success: the response echoes the coherent pair.
	rec = doRead(t, h, `{"id":2}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("read(2): want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var ack struct {
		Schema      int   `json:"schema"`
		ReadID      int64 `json:"read_id"`
		UnreadCount int64 `json:"unread_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil {
		t.Fatalf("ack body: %v (%s)", err, rec.Body.String())
	}
	if ack.Schema != 1 || ack.ReadID != 2 || ack.UnreadCount != 0 {
		t.Fatalf("ack echo: %+v", ack)
	}

	// Stale replay: 200, state unchanged.
	rec = doRead(t, h, `{"id":1}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("stale read(1): want 200, got %d", rec.Code)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil || ack.ReadID != 2 || ack.UnreadCount != 0 {
		t.Fatalf("stale read echo: %+v (%v)", ack, err)
	}

	// History GET echoes the same pair alongside the unchanged fields.
	d.notifyHistory.append(histEntry(fleetCondSessionDone, notifyActionAppeared, 1))
	rec = doNotify(t, h, http.MethodGet, "/vh/notify/history", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("history GET after ack: %d", rec.Code)
	}
	var view struct {
		Schema int `json:"schema"`
		Events []struct {
			ID int64 `json:"id"`
		} `json:"events"`
		FirstID     int64 `json:"first_id"`
		LastID      int64 `json:"last_id"`
		ReadID      int64 `json:"read_id"`
		UnreadCount int64 `json:"unread_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("history body: %v", err)
	}
	if view.ReadID != 2 || view.UnreadCount != 1 || view.FirstID != 1 || view.LastID != 3 || len(view.Events) != 3 {
		t.Fatalf("history echo: read_id=%d unread=%d first=%d last=%d events=%d",
			view.ReadID, view.UnreadCount, view.FirstID, view.LastID, len(view.Events))
	}

	// Persistence failure through the HTTP chain: 500, no advance.
	restore := breakHistoryFileForPersist(t, path+".history")
	rec = doRead(t, h, `{"id":3}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("read under broken persist: want 500, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rid, _ := d.notifyHistory.readState(); rid != 2 {
		t.Fatalf("failed persist advanced the cursor: %d", rid)
	}
	restore()
	rec = doRead(t, h, `{"id":3}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("read after restore: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rid, _ := d.notifyHistory.readState(); rid != 3 {
		t.Fatalf("cursor after recovery: %d", rid)
	}
}

// TestNotifyRead_CaseVariantIDKey pins the key-spelling contract of the
// read body's single field on DECODED keys. encoding/json matches
// struct fields case-INSENSITIVELY, so {"ID":2} would silently decode
// into id and {"id":1,"ID":2} would last-win past the decoded-key
// duplicate scan — both silently advancing the cursor. The pre-decode
// validation rejects any top-level key that case-folds to "id" without
// decoding to exactly "id": 400 naming the offending key, cursor
// unmoved, history file untouched — and the plain "id" spelling keeps
// working.
func TestNotifyRead_CaseVariantIDKey(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	path := filepath.Join(t.TempDir(), "tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionChanged, 2))
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionCleared, 0))
	before, err := os.ReadFile(path + ".history")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ name, body string }{
		{"case-variant key alone", `{"ID":2}`},
		{"exact plus case-variant key (last-win hazard)", `{"id":1,"ID":2}`},
	} {
		rec := doRead(t, h, tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
		if body := rec.Body.String(); !strings.Contains(body, `must be spelled exactly "id"`) || !strings.Contains(body, `"ID"`) {
			t.Errorf("%s: 400 must name the case-variant key and the exact spelling, got: %s", tc.name, body)
		}
		if rid, _ := d.notifyHistory.readState(); rid != 0 {
			t.Errorf("%s: rejected body advanced the cursor to %d", tc.name, rid)
		}
		if after, err := os.ReadFile(path + ".history"); err != nil || !bytes.Equal(before, after) {
			t.Errorf("%s: rejected body must not touch the history file (err=%v)", tc.name, err)
		}
	}

	// The plain "id" spelling is unchanged: a well-formed ack still
	// advances through the real chain.
	rec := doRead(t, h, `{"id":2}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("exact-spelling ack: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rid, _ := d.notifyHistory.readState(); rid != 2 {
		t.Fatalf("exact-spelling ack must advance the cursor to 2, got %d", rid)
	}
}

// TestNotifyRead_EscapedIDKeyDecodedSemantics pins the DECODED-key
// contract (round-2 F1 codification): both pre-checks scan
// json.Decoder tokens, which resolve \uXXXX escapes, so the invariant
// is exactly one top-level member whose DECODED key is precisely "id".
//   - a single escape-encoded key decoding to exactly "id" is the SAME
//     field: accepted (200) and the cursor advances — documented
//     acceptance, not an accident;
//   - an escaped + exact pair both decode to "id": the duplicate scan
//     (decoded tokens) rejects it (400 naming the decoded key), cursor
//     unmoved, history file untouched.
//
// These are GREEN-on-current-behavior pins: the slice deliberately
// changes NO behavior (the fix is codifying the semantics the code
// already had), so no red-first exists — a red would only exist
// against the retired "byte-exact wire spelling" comment text.
func TestNotifyRead_EscapedIDKeyDecodedSemantics(t *testing.T) {
	d, h, session := newNotifyAuthDaemon(t)
	path := filepath.Join(t.TempDir(), "tokens.json")
	if err := persistNotifyStore(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatal(err)
	}
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionAppeared, 1))
	d.notifyHistory.append(histEntry(fleetCondWorkerDown, notifyActionChanged, 2))

	// Acceptance pin: "\u0069d" decodes to exactly "id" — the same
	// field, a valid ack through the real chain.
	rec := doRead(t, h, `{"\u0069d":2}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("escaped-id ack: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var ack struct {
		Schema      int   `json:"schema"`
		ReadID      int64 `json:"read_id"`
		UnreadCount int64 `json:"unread_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ack); err != nil || ack.Schema != 1 || ack.ReadID != 2 {
		t.Fatalf("escaped-id ack echo: %+v (%v)", ack, err)
	}
	if rid, _ := d.notifyHistory.readState(); rid != 2 {
		t.Fatalf("escaped-id ack must advance the cursor to 2, got %d", rid)
	}

	// Duplicate pin: escaped + exact spellings both decode to "id" —
	// the decoded-token duplicate scan rejects the pair; the cursor
	// stays at 2 and the file is untouched.
	before, err := os.ReadFile(path + ".history")
	if err != nil {
		t.Fatal(err)
	}
	rec = doRead(t, h, `{"\u0069d":1,"id":2}`, withCookie(session), withCSRF())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("escaped+exact duplicate: want 400, got %d (%s)", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !strings.Contains(body, `duplicate key "id"`) {
		t.Errorf("escaped+exact duplicate must be rejected as a duplicate of the decoded key, got: %s", body)
	}
	if rid, _ := d.notifyHistory.readState(); rid != 2 {
		t.Errorf("rejected escaped+exact duplicate moved the cursor to %d", rid)
	}
	if after, err := os.ReadFile(path + ".history"); err != nil || !bytes.Equal(before, after) {
		t.Errorf("rejected escaped+exact duplicate must not touch the history file (err=%v)", err)
	}
}
