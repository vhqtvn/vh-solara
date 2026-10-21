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
//
// Correlation (t1b-F1): the durable source spool OWNS the correlation key.
// Each ring event carries the (epoch, seq) of the spool record recorded for
// the SAME notice (SpoolSeq/SpoolEpoch — internal file shape only; the public
// DTO never exposes them). Public history joins the spool BY THAT PAIR, so a
// ring id reset/reuse — after a ring-file loss, corrupt recovery, or a ring
// persist failure rolled back to the last readable file — can never re-join
// an older spool record: the reused-id event carries its OWN record's key.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// HistoryCap is the retained-notice bound (~500 per the notify contract).
	HistoryCap = 500
	// HistoryDefaultLimit is the `limit` fallback for GET /vh/notify/history.
	HistoryDefaultLimit = 50
	// HistoryMaxLimit caps the `limit` query parameter.
	HistoryMaxLimit = 200
)

// HistoryEvent is one retained notice — the ring's INTERNAL record (persisted
// file shape). The public wire shape GET /vh/notify/history serves is the v4
// DTO built in pkg/web (notifyEventV4); SpoolSeq/SpoolEpoch never cross that
// boundary. All payload fields are always present (no omitempty): a
// daemon-level notice carries type "stalled", title "OpenCode", and EMPTY
// sessionID/root by design. Kind is the one omitempty exception: only waiting
// notices carry a subtype, and pre-S1 legacy documents predate the field.
type HistoryEvent struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
	// Kind is the detection-time waiting subtype (Notice.Kind: permission |
	// question; "" for other types), retained in the ring INDEPENDENTLY of
	// the spool correlation key: the public condition (§9.1: waiting
	// kind=question ⇒ question_pending) must stay servable from the ring
	// alone when the event's spool record is unavailable — the spool append
	// failed, or a later rotation/eviction dropped the record. omitempty is
	// the additive-format rule: legacy documents without it load with ""
	// (the subtype-less default posture).
	Kind      string `json:"kind,omitempty"`
	SessionID string `json:"sessionID"`
	Root      string `json:"root"`
	Project   string `json:"project"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	Ts        int64  `json:"ts"`
	// SpoolSeq/SpoolEpoch identify the durable source-spool record for the
	// SAME notice (the spool-owned correlation key, t1b-F1). SpoolSeq is
	// carried ONLY when the spool append durably succeeded: an append whose
	// persist failed left the seq undurable, and an undurable seq can be
	// re-allocated to a DIFFERENT notice after a crash — carrying it would
	// reintroduce mis-attribution one failure out. SpoolSeq 0 (with ""
	// epoch) means "no durable record" and the event serves source-omitted
	// (the documented ring-only legacy behavior).
	SpoolSeq   int64  `json:"spoolSeq,omitempty"`
	SpoolEpoch string `json:"spoolEpoch,omitempty"`
}

// historyFile is the persisted document: the ring (oldest -> newest) plus the
// id counter, so restarts never reuse an id even when old events were evicted
// from the ring before the file was last written.
type historyFile struct {
	LastID int64          `json:"lastId"`
	Events []HistoryEvent `json:"events"`
	// Generation is the ring's identity era: rotated whenever the ring file
	// is LOST or CORRUPT (the same replacement rule as the spool epoch),
	// stable across ordinary restarts. A lost/corrupt ring resets the id
	// counter to 0, so ids ARE reused after recovery. Generation is no
	// longer a join key (t1b-F1 reversed the join onto the spool-owned
	// (epoch, seq) pair); it survives as the decidable POST-S1-ERA WITNESS
	// the spool's missing-file init consults: a readable ring doc carrying
	// a non-empty generation proves a post-S1 daemon ran on this state dir,
	// so a missing spool file is a LOSS, not a first run (t1b-F2). A doc
	// written before generations existed loads with "" and KEEPS it (never
	// re-minted while the file stays readable).
	Generation string `json:"generation"`
}

// History is the daemon-global notice ring. Safe for concurrent use.
type History struct {
	mu         sync.Mutex
	path       string
	cap        int
	events     []HistoryEvent // logical order: oldest -> newest, len <= cap
	lastID     int64          // highest id ever allocated
	generation string         // identity era; rotated on ring-file loss/corruption (post-S1 witness)
	lastErr    error          // most recent persist failure (""-equivalent when the last persist was clean)
}

// NewHistory loads (or starts) the notice-history ring under stateDir
// (stateDir/notify-history.json).
func NewHistory(stateDir string) *History {
	return newHistory(filepath.Join(stateDir, "notify-history.json"), HistoryCap)
}

// newHistory builds the ring at path with the given capacity. Load semantics
// mirror the spool's replacement rule:
//   - missing or corrupt file ⇒ the ring state was LOST: empty ring, id
//     counter 0, and a FRESH generation (ids restart at 1 and may collide
//     with pre-loss ids — harmless now that the correlation key is
//     spool-owned: a reused id carries its OWN (epoch, seq) and cannot join
//     a pre-loss spool record, t1b-F1);
//   - readable file ⇒ ordinary restart: events, counter, and generation all
//     preserved as persisted (a pre-generation doc keeps "" as its era).
func newHistory(path string, capacity int) *History {
	if capacity < 1 {
		capacity = 1
	}
	h := &History{path: path, cap: capacity}
	raw, err := os.ReadFile(path)
	if err != nil {
		h.generation = newRingGeneration()
		return h
	}
	var f historyFile
	if json.Unmarshal(raw, &f) != nil {
		h.generation = newRingGeneration()
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
	h.generation = f.Generation // "" preserved: the pre-generation era identity
	return h
}

// newRingGeneration mints a fresh ring generation (16 random bytes, hex —
// the newSourceEpoch shape). No relation to prior generations by
// construction, so a rotated generation is unambiguous evidence that a
// post-S1 daemon ran on this state dir (the t1b-F2 witness) — never a
// silent merge of eras.
func newRingGeneration() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure: fall back to time-derived uniqueness (never a
		// constant — that would silently merge eras).
		return fmt.Sprintf("ring-%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// Generation returns the ring's identity era: stable across ordinary
// restarts, rotated on ring-file loss/corrupt recovery. Not a join key (the
// spool-owned (epoch, seq) pair is — t1b-F1); the persisted generation is the
// post-S1-era witness the spool's missing-file init consults (t1b-F2).
// Nil-safe: a nil ring answers "".
func (h *History) Generation() string {
	if h == nil {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.generation
}

// ringBearsPostS1Evidence reports whether the persisted ring document under
// stateDir proves a post-S1 daemon already ran and recorded notices there —
// the decidable prior-existence witness for the spool's missing-file init
// (t1b-F2). Evidence is EITHER a non-empty ring generation (only post-S1 code
// mints one) OR any retained event carrying a spool correlation key (only the
// post-S1 tap stamps SpoolSeq) — the disjunct covers a legacy ""-generation
// doc that kept its pre-generation era across the upgrade while post-S1
// notices were recorded into it. No readable evidence (missing ring file,
// corrupt doc, pre-S1-era events only) ⇒ false: a missing spool file there is
// indistinguishable from a genuine first run.
func ringBearsPostS1Evidence(stateDir string) bool {
	raw, err := os.ReadFile(filepath.Join(stateDir, "notify-history.json"))
	if err != nil {
		return false
	}
	var f historyFile
	if json.Unmarshal(raw, &f) != nil {
		return false
	}
	if f.Generation != "" {
		return true
	}
	for _, ev := range f.Events {
		if ev.SpoolSeq > 0 {
			return true
		}
	}
	return false
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

// Record appends n with the next strictly-increasing id — carrying n.Kind
// (the detection-time subtype, retained ALWAYS: the ring must serve the true
// condition of a waiting notice even when its spool record is unavailable —
// failed append, rotation, or eviction) and the spool-owned correlation key
// (spoolSeq, spoolEpoch) for this notice, when its spool append durably
// succeeded — and persists the ring. The persist happens
// under the lock on purpose: allocation and file write must serialize, or two
// concurrent records could land their files out of order and regress the
// persisted counter (which would reuse an id after a restart). Record is
// called from the engine's fire path, where notices are rare — holding the
// lock across the atomic write is the cheap correct shape.
//
// A persistence error is RETURNED (and retained on LastPersistError — the
// spool's visibility posture, t1b-F1): the event still lands in memory and is
// returned, because retention must never block delivery, but a ring write
// that failed is never silently assumed durable — after a restart the ring
// re-loads from the last READABLE file and re-allocates this id. That reuse
// is exactly why the correlation key is spool-owned: the re-allocated event
// carries its OWN (epoch, seq) and cannot join the failed event's record.
func (h *History) Record(n Notice, spoolSeq int64, spoolEpoch string) (HistoryEvent, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastID++
	ev := HistoryEvent{
		ID:         h.lastID,
		Type:       n.Type,
		Kind:       n.Kind,
		SessionID:  n.SessionID,
		Root:       n.Root,
		Project:    n.Project,
		Title:      n.Title,
		Detail:     n.Detail,
		Ts:         n.Ts,
		SpoolSeq:   spoolSeq,
		SpoolEpoch: spoolEpoch,
	}
	h.append(ev)
	err := h.persistLocked()
	h.lastErr = err
	return ev, err
}

// LastPersistError exposes the ring's most recent persistence failure (""
// when the last persist was clean) for health/diagnostic surfaces — a failed
// ring write must be visible, never silently acknowledged (the spool's
// LastPersistError posture). Nil-safe: a nil ring answers "".
func (h *History) LastPersistError() string {
	if h == nil {
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.lastErr == nil {
		return ""
	}
	return h.lastErr.Error()
}

// persistLocked writes the ring atomically (tmp + rename, 0600). Caller holds mu.
// The generation rides the document so it is stable across ordinary restarts.
func (h *History) persistLocked() error {
	out, err := json.MarshalIndent(historyFile{LastID: h.lastID, Events: h.events, Generation: h.generation}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(h.path), 0o700); err != nil {
		return err
	}
	tmp := h.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, h.path)
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
