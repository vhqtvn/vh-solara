package alerts

// Notice history ring (/vh/notify/history backing store): a daemon-global,
// bounded (~500) ring that records EVERY notice the engine emits — BEFORE any
// delivery gating (attendance / profile / cooldown suppression happens
// downstream in the dispatcher and pusher) — so suppressed notices still
// appear in the history a polling client reads.
//
// Persistence follows the push-subs.json pattern: a JSON file under the state
// dir, written atomically (tmp + rename, 0600), reloaded on daemon start. The
// id counter is persisted WITH the ring so ids stay strictly increasing across
// daemon restarts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const (
	// HistoryCap is the retained-notice bound (~500 per the notify contract).
	HistoryCap = 500
	// HistoryDefaultLimit is the `limit` fallback for GET /vh/notify/history.
	HistoryDefaultLimit = 50
	// HistoryMaxLimit caps the `limit` query parameter.
	HistoryMaxLimit = 200
)

// HistoryEvent is one retained notice — exactly the wire shape GET
// /vh/notify/history serves per event. All fields are always present (no
// omitempty): a daemon-level notice carries type "stalled", title "OpenCode",
// and EMPTY sessionID/root by design.
type HistoryEvent struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	SessionID string `json:"sessionID"`
	Root      string `json:"root"`
	Project   string `json:"project"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	Ts        int64  `json:"ts"`
}

// historyFile is the persisted document: the ring (oldest -> newest) plus the
// id counter, so restarts never reuse an id even when old events were evicted
// from the ring before the file was last written.
type historyFile struct {
	LastID int64          `json:"lastId"`
	Events []HistoryEvent `json:"events"`
}

// History is the daemon-global notice ring. Safe for concurrent use.
type History struct {
	mu     sync.Mutex
	path   string
	cap    int
	events []HistoryEvent // logical order: oldest -> newest, len <= cap
	lastID int64          // highest id ever allocated
}

// NewHistory loads (or starts) the notice-history ring under stateDir
// (stateDir/notify-history.json).
func NewHistory(stateDir string) *History {
	return newHistory(filepath.Join(stateDir, "notify-history.json"), HistoryCap)
}

// newHistory builds the ring at path with the given capacity. A missing or
// corrupt file starts an empty ring (the push-subs load posture).
func newHistory(path string, capacity int) *History {
	if capacity < 1 {
		capacity = 1
	}
	h := &History{path: path, cap: capacity}
	raw, err := os.ReadFile(path)
	if err != nil {
		return h
	}
	var f historyFile
	if json.Unmarshal(raw, &f) != nil {
		return h
	}
	for _, ev := range f.Events {
		if ev.ID > h.lastID {
			h.lastID = ev.ID
		}
		h.append(ev)
	}
	if f.LastID > h.lastID {
		h.lastID = f.LastID // counter may outrun the ring after evictions
	}
	return h
}

// append inserts ev at the newest end, evicting the oldest entry once full.
// Caller holds mu. (A shift-down slice keeps serialization trivially in
// logical order; notices arrive at most a few per 20s sweep, so the O(cap)
// copy is negligible.)
func (h *History) append(ev HistoryEvent) {
	if len(h.events) == h.cap {
		copy(h.events, h.events[1:])
		h.events[len(h.events)-1] = ev
		return
	}
	h.events = append(h.events, ev)
}

// Record appends n with the next strictly-increasing id and persists the ring.
// The persist happens under the lock on purpose: allocation and file write
// must serialize, or two concurrent records could land their files out of
// order and regress the persisted counter (which would reuse an id after a
// restart). Record is called from the engine's fire path, where notices are
// rare — holding the lock across the atomic write is the cheap correct shape.
// A persistence error is swallowed here: history must never block delivery.
func (h *History) Record(n Notice) HistoryEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastID++
	ev := HistoryEvent{
		ID:        h.lastID,
		Type:      n.Type,
		SessionID: n.SessionID,
		Root:      n.Root,
		Project:   n.Project,
		Title:     n.Title,
		Detail:    n.Detail,
		Ts:        n.Ts,
	}
	h.append(ev)
	h.persistLocked()
	return ev
}

// persistLocked writes the ring atomically (tmp + rename, 0600). Caller holds mu.
func (h *History) persistLocked() {
	out, err := json.MarshalIndent(historyFile{LastID: h.lastID, Events: h.events}, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o700); err != nil {
		return
	}
	tmp := h.path + ".tmp"
	if os.WriteFile(tmp, out, 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, h.path)
}

// Query serves the GET /vh/notify/history contract:
//   - since > 0: events with id > since, ascending, at most `limit` of them,
//     OLDEST-first so a paging client resumes at since=<last received id>;
//   - since <= 0 (omitted/0): the NEWEST `limit` events, ascending.
//
// limit is normalized: <=0 → HistoryDefaultLimit, >HistoryMaxLimit → clamped.
// lastID is the highest id ever allocated (the client's resume cursor — it can
// outrun the returned events when the ring overflowed). Nil-safe: a nil
// History answers empty.
func (h *History) Query(since int64, limit int) (events []HistoryEvent, lastID int64) {
	if limit <= 0 {
		limit = HistoryDefaultLimit
	}
	if limit > HistoryMaxLimit {
		limit = HistoryMaxLimit
	}
	events = []HistoryEvent{}
	if h == nil {
		return events, 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if since > 0 {
		for _, ev := range h.events {
			if ev.ID > since {
				events = append(events, ev)
				if len(events) == limit {
					break
				}
			}
		}
		return events, h.lastID
	}
	start := len(h.events) - limit
	if start < 0 {
		start = 0
	}
	events = append(events, h.events[start:]...)
	return events, h.lastID
}
