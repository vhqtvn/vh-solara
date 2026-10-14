package alerts

// history_test.go — lane-1 co-located unit tests for the notice-history ring
// (pkg/alerts/history.go) and the engine tap that records every detected
// notice BEFORE delivery gating.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

func rec(h *History, typ, sid string) HistoryEvent {
	return h.Record(Notice{
		Type:      typ,
		SessionID: sid,
		Root:      sid,
		Project:   "proj",
		Title:     "T-" + sid,
		Detail:    "d",
		Ts:        time.Now().UnixMilli(),
	})
}

func ids(events []HistoryEvent) []int64 {
	out := make([]int64, len(events))
	for i, ev := range events {
		out[i] = ev.ID
	}
	return out
}

func eqIDs(t *testing.T, got []int64, want ...int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("ids = %v, want %v", got, want)
		}
	}
}

// TestHistoryRecordAndNewestQuery pins the wire shape and the no-since
// behavior: newest `limit` events, ascending, with lastId = highest allocated.
func TestHistoryRecordAndNewestQuery(t *testing.T) {
	h := NewHistory(t.TempDir())
	rec(h, TypeWaiting, "s1")
	rec(h, TypeStalled, "s2")
	rec(h, TypeFinished, "s3")

	events, lastID := h.Query(0, 50)
	eqIDs(t, ids(events), 1, 2, 3)
	if lastID != 3 {
		t.Fatalf("lastID = %d, want 3", lastID)
	}
	// Exact event shape (all fields present, contract names).
	ev := events[0]
	want := HistoryEvent{ID: 1, Type: TypeWaiting, SessionID: "s1", Root: "s1", Project: "proj", Title: "T-s1", Detail: "d", Ts: ev.Ts}
	if ev != want {
		t.Fatalf("event shape drift:\n got %+v\nwant %+v", ev, want)
	}
	b, _ := json.Marshal(ev)
	for _, key := range []string{`"id"`, `"type"`, `"sessionID"`, `"root"`, `"project"`, `"title"`, `"detail"`, `"ts"`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("event JSON missing key %s: %s", key, b)
		}
	}
}

// TestHistorySinceLimit pins the since/limit semantics: since>0 returns
// events with id > since ascending (oldest-first up to limit, so a paging
// client resumes at since=<last received id>); limit defaults to 50.
func TestHistorySinceLimit(t *testing.T) {
	h := NewHistory(t.TempDir())
	for i := 0; i < 5; i++ {
		rec(h, TypeWaiting, "s")
	}

	events, lastID := h.Query(2, 2)
	eqIDs(t, ids(events), 3, 4)
	if lastID != 5 {
		t.Fatalf("lastID = %d, want 5", lastID)
	}

	// Default limit (0 -> 50): everything past since.
	events, _ = h.Query(4, 0)
	eqIDs(t, ids(events), 5)

	// since beyond the head: empty events, honest lastID.
	events, lastID = h.Query(99, 10)
	eqIDs(t, ids(events))
	if lastID != 5 {
		t.Fatalf("lastID = %d, want 5", lastID)
	}

	// Empty ring answers an empty slice (never nil) so the route's
	// "events":[] is stable.
	empty, _ := NewHistory(t.TempDir()).Query(0, 50)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("empty ring query = %v, want non-nil empty", empty)
	}
}

// TestHistoryNewestLimit pins the no-since window: newest `limit` events,
// still ascending.
func TestHistoryNewestLimit(t *testing.T) {
	h := newHistory(filepath.Join(t.TempDir(), "notify-history.json"), 10)
	for i := 0; i < 10; i++ {
		rec(h, TypeWaiting, "s")
	}
	events, _ := h.Query(0, 3)
	eqIDs(t, ids(events), 8, 9, 10)
}

// TestHistoryRingSaturation pins the bounded ring: past capacity the oldest
// events are evicted and only the newest `cap` remain, with ids still
// strictly increasing.
func TestHistoryRingSaturation(t *testing.T) {
	h := newHistory(filepath.Join(t.TempDir(), "notify-history.json"), 8)
	for i := 0; i < 12; i++ {
		rec(h, TypeWaiting, "s")
	}
	events, lastID := h.Query(0, 50)
	eqIDs(t, ids(events), 5, 6, 7, 8, 9, 10, 11, 12)
	if lastID != 12 {
		t.Fatalf("lastID = %d, want 12", lastID)
	}
	// since inside the retained window still pages correctly.
	events, _ = h.Query(6, 50)
	eqIDs(t, ids(events), 7, 8, 9, 10, 11, 12)
}

// TestHistoryIDStableAcrossReload pins the restart contract: reload carries
// the id counter forward, so the next recorded id strictly increases, and the
// retained events survive.
func TestHistoryIDStableAcrossReload(t *testing.T) {
	dir := t.TempDir()
	h := newHistory(filepath.Join(dir, "notify-history.json"), 500)
	rec(h, TypeWaiting, "s1")
	rec(h, TypeWaiting, "s2")

	h2 := newHistory(filepath.Join(dir, "notify-history.json"), 500)
	events, lastID := h2.Query(0, 50)
	eqIDs(t, ids(events), 1, 2)
	if lastID != 2 {
		t.Fatalf("reloaded lastID = %d, want 2", lastID)
	}
	ev := rec(h2, TypeWaiting, "s3")
	if ev.ID != 3 {
		t.Fatalf("post-reload id = %d, want 3 (strictly increasing across restarts)", ev.ID)
	}
	events, _ = h2.Query(0, 50)
	eqIDs(t, ids(events), 1, 2, 3)
}

// TestHistoryCorruptFileStartsFresh: a corrupt file starts an empty ring
// rather than failing construction (push-subs posture).
func TestHistoryCorruptFileStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notify-history.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHistory(path, 500)
	events, lastID := h.Query(0, 50)
	if len(events) != 0 || lastID != 0 {
		t.Fatalf("corrupt file: want empty ring, got %d events lastID=%d", len(events), lastID)
	}
}

// TestHistoryPersistenceShape pins the on-disk document (counter + events)
// and its 0600 mode so Slice 2 and future readers can rely on it.
func TestHistoryPersistenceShape(t *testing.T) {
	dir := t.TempDir()
	h := NewHistory(dir)
	rec(h, TypeWaiting, "s1")

	path := filepath.Join(dir, "notify-history.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("history file not written: %v", err)
	}
	var f historyFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("history file not the persisted shape: %v (%s)", err, raw)
	}
	if f.LastID != 1 || len(f.Events) != 1 || f.Events[0].ID != 1 {
		t.Fatalf("persisted doc drift: %+v", f)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("history file mode = %v, want 0600", fi.Mode().Perm())
	}
}

// TestHistoryLimitClampedToMax pins the `limit` clamp: a query above
// HistoryMaxLimit (200) serves exactly the newest 200 events — never more,
// even when the ring holds them.
func TestHistoryLimitClampedToMax(t *testing.T) {
	h := newHistory(filepath.Join(t.TempDir(), "notify-history.json"), 300)
	for i := 0; i < 250; i++ {
		rec(h, TypeWaiting, "s")
	}
	events, lastID := h.Query(0, 201) // > HistoryMaxLimit → clamped
	if len(events) != 200 {
		t.Fatalf("limit=201 must clamp to 200 events, got %d", len(events))
	}
	if lastID != 250 {
		t.Fatalf("lastID = %d, want 250", lastID)
	}
	// The newest window: ids 51..250.
	eqIDs(t, ids(events)[:3], 51, 52, 53)
	eqIDs(t, ids(events)[198:], 249, 250)

	// Exactly 200 is at the cap, not clamped away.
	events, _ = h.Query(0, 200)
	if len(events) != 200 {
		t.Fatalf("limit=200 must serve 200 events, got %d", len(events))
	}
	// The clamp also applies to the since-paging form.
	events, _ = h.Query(10, 500)
	if len(events) != 200 {
		t.Fatalf("since=10&limit=500 must clamp to 200 events, got %d", len(events))
	}
	eqIDs(t, ids(events)[:2], 11, 12)
}

// TestEngineTapRecordsSuppressedNotices is the alerts-level crux: notices the
// engine detects are recorded into history BEFORE delivery gating — here the
// active profile is "Silent" (PolicyNever), so the dispatcher suppresses ALL
// outbound delivery, and the watcher's deliver sink is swapped for a no-op
// (the test-harness pattern), yet BOTH the session-shaped notice (waiting,
// fired through the real onEvent → fire path) and the daemon-level notice
// (EmitDaemonNotice) are retained with ascending ids and the contract shapes.
func TestEngineTapRecordsSuppressedNotices(t *testing.T) {
	dir := t.TempDir()
	cfg, err := NewStore(filepath.Join(dir, "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	// "Silent" = PolicyNever: dispatcher.Dispatch returns before any channel
	// work — the notices below are genuinely suppressed outbound.
	if err := cfg.SetActive("Silent"); err != nil {
		t.Fatal(err)
	}
	pres := NewPresence()
	eng := NewEngine(cfg, pres, NewDispatcher(cfg, pres))
	h := NewHistory(dir)
	eng.SetHistory(h)

	// Session-shaped notice through the REAL fire path (onEvent → fire), with
	// the deliver sink swapped out — recording happens in fire(), before
	// deliver, so the tap is proven independent of the sink.
	w := &watcher{
		engine:   eng,
		dir:      "proj",
		store:    state.New(4096),
		now:      time.Now,
		sessions: map[string]*sessTrack{},
		finishAt: map[string]time.Time{},
		firedRun: map[string]bool{},
		firedReq: map[string]bool{},
		deliver:  func(Notice) {}, // no-op sink: history must record anyway
	}
	w.onEvent(ev(1, state.KindPermissionSet, map[string]any{"sessionID": "s1", "id": "p1"}))

	// Daemon-level notice through EmitDaemonNotice (no watchers attached —
	// the fan-out loop is empty; dispatcher suppressed by Silent).
	eng.EmitDaemonNotice("opencode serve pid 7 exited")

	events, lastID := h.Query(0, 50)
	if len(events) != 2 {
		t.Fatalf("want 2 retained notices, got %d: %+v", len(events), events)
	}
	first, second := events[0], events[1]
	if lastID != 2 {
		t.Fatalf("lastID = %d, want 2", lastID)
	}
	if first.ID != 1 || first.Type != TypeWaiting || first.SessionID != "s1" || first.Root != "s1" || first.Project != "proj" {
		t.Fatalf("session notice shape drift: %+v", first)
	}
	if second.ID != 2 || second.Type != TypeStalled || second.Title != "OpenCode" ||
		second.SessionID != "" || second.Root != "" || second.Detail != "opencode serve pid 7 exited" {
		t.Fatalf("daemon notice shape drift: %+v", second)
	}
}

// TestEngineWithoutHistoryRunsUnchanged: a bare engine (no SetHistory)
// records nothing and never breaks notice delivery.
func TestEngineWithoutHistoryRunsUnchanged(t *testing.T) {
	cfg, err := NewStore(filepath.Join(t.TempDir(), "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	eng := NewEngine(cfg, NewPresence(), NewDispatcher(cfg, NewPresence()))
	if eng.History() != nil {
		t.Fatal("bare engine history should be nil")
	}
	eng.EmitDaemonNotice("x")                    // must not panic
	events, lastID := eng.History().Query(0, 50) // nil-safe query
	if len(events) != 0 || lastID != 0 {
		t.Fatalf("nil history query: want empty, got %d events lastID=%d", len(events), lastID)
	}
}
