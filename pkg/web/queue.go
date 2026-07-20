package web

// Backend-authoritative per-session message queue.
//
// The queue is keyed by (project root, sessionID). The browser is a thin view
// over it plus the SOLE dispatcher: it lists, enqueues, removes, claims, and
// resolves items. The backend owns the lifecycle, ordering, and durability — a
// reload/switch/device-handoff reads the same file. Correctness never depends on
// a push channel: the FE pulls on open, after every mutation, on focus/
// visibility, on stream reconnect, and polls ~5s while a selected session has
// queue state.
//
// Lifecycle (no auto-retry anywhere — the operator's explicit intent: "if it
// fails there's a reason, I'll look into it"):
//
//	pending → dispatching → {sent | failed | unknown}
//
// `claim` is the atomic cross-client boundary: only one browser wins the oldest
// pending item and moves it to `dispatching`. Neither `failed` nor `unknown`
// ever returns to `pending`; they persist until explicit operator dismissal.
// `resolve` records a terminal outcome and can never repend.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// QueueItemState is the lifecycle state of a queue item.
type QueueItemState string

const (
	QueuePending     QueueItemState = "pending"
	QueueDispatching QueueItemState = "dispatching"
	QueueSent        QueueItemState = "sent"
	QueueFailed      QueueItemState = "failed"
	QueueUnknown     QueueItemState = "unknown"
)

func isTerminalState(s QueueItemState) bool {
	return s == QueueSent || s == QueueFailed || s == QueueUnknown
}

// QueueAttachment mirrors the FE attachment shape (file:// url + meta).
type QueueAttachment struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
}

// QueueSendConfig captures the model/agent/variant a message was composed with,
// so a later switch doesn't retroactively change a queued message.
type QueueSendConfig struct {
	ProviderID string `json:"providerID,omitempty"`
	ModelID    string `json:"modelID,omitempty"`
	Variant    string `json:"variant,omitempty"`
	Agent      string `json:"agent,omitempty"`
}

// QueueItem is one queued message. ID and Order are backend-issued; Order is the
// monotonic FIFO commit sequence. OriginClientID is diagnostics-only and MUST
// NOT affect ordering, visibility, or dispatch eligibility.
//
// DispatchStartedAt records when Claim() transitioned the item to `dispatching`.
// It is the timestamp stale-dispatch recovery (recoverStaleDispatchingLocked)
// uses to detect abandoned dispatches after a network failure, browser crash,
// or vh-solara restart. CreatedAt is UNSAFE for that purpose because an item
// can sit `pending` for a long time before being claimed. The `omitempty` tag
// keeps on-disk backwards compatibility: a legacy queue.json written before
// this field existed deserializes with DispatchStartedAt==0, which recovery
// treats as "legacy item, recover immediately" — exactly the operator's
// restart-recovery case.
type QueueItem struct {
	ID                string            `json:"id"`
	Order             uint64            `json:"order"`
	State             QueueItemState    `json:"state"`
	Text              string            `json:"text"`
	Attachments       []QueueAttachment `json:"attachments"`
	SendConfig        QueueSendConfig   `json:"sendConfig,omitempty"`
	OriginClientID    string            `json:"originClientId,omitempty"`
	CreatedAt         int64             `json:"createdAt"`
	DispatchStartedAt int64             `json:"dispatchStartedAt,omitempty"`
	ResolvedAt        int64             `json:"resolvedAt,omitempty"`
	Detail            string            `json:"detail,omitempty"`
}

// queueFile is the on-disk shape. Order is persisted so the monotonic commit
// counter survives item removals (removing the highest-order item must not let a
// later enqueue reuse a lower order).
type queueFile struct {
	Order uint64      `json:"order"`
	Items []QueueItem `json:"items"`
}

// Sentinel errors for the store. The HTTP layer maps these to status codes.
var (
	errQueueNotFound     = errors.New("queue item not found")
	errQueueNotRemovable = errors.New("dispatching items cannot be removed while in flight")
	errQueueNotClaimed   = errors.New("item is not dispatching (claim first)")
	errQueueCannotRepend = errors.New("resolve cannot return an item to pending")
	// errQueueArchived signals that the sessionQueueStore has been tombstoned by
	// deleteStore (archive lifecycle). A retained pointer to an archived store
	// MUST NOT mutate or save(): doing so would resurrect archived-away messages
	// (BLK-1). Mutations check this right after acquiring st.mu and refuse.
	errQueueArchived = errors.New("session queue archived")
)

// sessionQueueStore owns ONE session's queue: a mutex, a lazy-loaded in-memory
// copy, and the on-disk queue.json path. All mutations persist the state
// transition before returning, so a successful response is always durable.
//
// `archived` is the BLK-1 tombstone: once deleteStore sets it (under both
// qr.mu and st.mu), NO retained pointer to this store can resurrect archived
// messages — every mutation checks `archived` right after acquiring st.mu and
// returns errQueueArchived without appending, mutating, or save()ing. A fresh
// store() lookup AFTER deleteStore creates a brand-new sessionQueueStore with
// archived==false (correct post-archive behavior); the tombstone only applies
// to the old retained pointer.
type sessionQueueStore struct {
	mu       sync.Mutex
	path     string
	items    []QueueItem
	order    uint64
	loaded   bool
	archived bool
}

// load reads queue.json once (lazy). A missing file is an empty queue (ok). A
// malformed/truncated file is an EXPLICIT error — never silent loss: the caller
// surfaces it so the operator can investigate instead of seeing items vanish.
func (s *sessionQueueStore) load() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.items = nil
			s.order = 0
			s.loaded = true
			return nil
		}
		return fmt.Errorf("queue: read %s: %w", s.path, err)
	}
	var doc queueFile
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("queue: malformed %s: %w", s.path, err)
	}
	s.items = doc.Items
	s.order = doc.Order
	// Normalize legacy on-disk items: a queue.json persisted BEFORE the
	// attachments-always-array contract had no `attachments` key (the field used
	// omitempty), so json.Unmarshal leaves QueueItem.Attachments nil. With the
	// omitempty tag now removed, a nil slice would serialize as
	// "attachments":null — breaking the contract the Enqueue nil→[]
	// normalization (above) establishes for NEW enqueues. Apply the same
	// nil→empty normalization here so EVERY item read from disk serializes as
	// "attachments":[] regardless of when it was written. Symmetric with Enqueue.
	for i := range s.items {
		if s.items[i].Attachments == nil {
			s.items[i].Attachments = []QueueAttachment{}
		}
	}
	// Defend against a file written with Order==0 but non-empty items: rebuild
	// the counter from the max observed order so the next enqueue stays
	// monotonic. (Also covers a hand-edited file.)
	var maxOrder uint64
	for _, it := range s.items {
		if it.Order > maxOrder {
			maxOrder = it.Order
		}
	}
	if maxOrder > s.order {
		s.order = maxOrder
	}
	s.loaded = true
	return nil
}

// save writes the queue atomically (temp file + fsync + rename) so a crash at
// any point never leaves queue.json truncated or partially written.
//
// Defense-in-depth (BLK-1): refuse to persist an archived store. Every mutation
// already checks `archived` before mutating and before calling save(), so this
// branch is unreachable in normal flow — but it is the last-resort guard if a
// future mutation path forgets the entry check: a tombstoned store must NEVER
// write queue.json back into existence (which would resurrect archived items).
func (s *sessionQueueStore) save() error {
	if s.archived {
		return errQueueArchived
	}
	doc := queueFile{Order: s.order, Items: s.items}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("queue: encode: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("queue: mkdir: %w", err)
	}
	// Ensure .vh-solara/.gitignore covers runtime data. Non-managed projects
	// (no project.jsonc) never reach EnsureLocalSetup, so this is their entry
	// point. Best-effort: a failure is logged and never blocks the queue save.
	if err := projectcfg.EnsureRuntimeGitignore(vhSolaraDir(s.path)); err != nil {
		vhlog.Warn("queue: ensure .vh-solara/.gitignore failed", "err", err)
	}
	return writeQueueAtomic(s.path, data, 0o644)
}

// staleDispatchThreshold is the maximum time a queue item may remain in the
// `dispatching` state before recovery treats it as abandoned. Must exceed the
// frontend dispatch timeout (12s in web/src/queueDrain.ts) to avoid recovering
// in-flight dispatches; 30s leaves a comfortable margin.
const staleDispatchThreshold = 30 * time.Second

// staleDispatchThresholdOverride is a TEST-ONLY override for the stale-dispatch
// threshold. The production default is the const above; this atomic is 0 in
// normal operation (and in any production deployment, which never calls
// SetStaleDispatchThresholdForTest). The in-process e2e queue-recovery test
// (tests/e2e) sets it to a small value (e.g. 200ms) via
// SetStaleDispatchThresholdForTest so the recovery contract can be exercised
// through the real HTTP stack without a 30-second wall-clock wait. It MUST
// remain an atomic (not a plain var) so the test-time write and the List()-time
// read can never race under `go test -race`.
var staleDispatchThresholdOverride atomic.Int64 // milliseconds; 0 = use const default

// currentStaleThreshold returns the effective stale-dispatch threshold: the
// test override if one is set, otherwise the production const. Used at the
// single recovery read site (recoverStaleDispatchingLocked) so the override is
// consulted on every List().
func currentStaleThreshold() time.Duration {
	if ms := staleDispatchThresholdOverride.Load(); ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return staleDispatchThreshold
}

// SetStaleDispatchThresholdForTest overrides the stale-dispatch threshold for
// the in-process e2e suite. TEST-ONLY: production code MUST NOT call this — the
// 30s default is a deliberate margin over the frontend's 12s dispatch timeout,
// and shortening it in production would recover genuinely in-flight dispatches.
// Pass d <= 0 (e.g. 0) to restore the default. Callers SHOULD defer-restore
// the default when done. Race-free (backed by sync/atomic).
func SetStaleDispatchThresholdForTest(d time.Duration) {
	if d <= 0 {
		staleDispatchThresholdOverride.Store(0)
		return
	}
	staleDispatchThresholdOverride.Store(int64(d / time.Millisecond))
}

// staleDispatchRecoveryDetail is the operator-facing diagnostic text recorded
// on any item recovered to `unknown` by stale-dispatch recovery. It explains
// why the item left `dispatching` without a confirmed outcome and warns against
// blind re-send: after transport failure it is impossible to know whether
// OpenCode received the POST, so resending may duplicate work (duplicated
// prompts, duplicated tool side-effects, duplicated file edits).
const staleDispatchRecoveryDetail = "Recovery: dispatch was interrupted and could not be confirmed. The prompt may have reached OpenCode; sending it again may duplicate work."

// recoverStaleDispatchingLocked transitions abandoned `dispatching` items to
// terminal `unknown`. Called under the store mutex by List() after disk load.
// NEVER produces `pending`. NEVER dispatches. NEVER re-issues the prompt POST.
// Returns changed=true if any item was recovered.
//
// The caller (List()) is responsible for persisting the recovery via the
// atomic save path when changed==true, and for rolling back ALL in-memory
// mutations if that save fails (mirrors the Resolve/Claim rollback pattern).
//
// Recovery rules:
//   - dispatching && DispatchStartedAt > 0 && now - DispatchStartedAt > threshold → unknown
//   - dispatching && DispatchStartedAt == 0 (legacy item, pre-this-fix on-disk
//     shape) → unknown (this is the restart-recovery case: an item stuck
//     dispatching across a vh-solara restart, with no timestamp to age)
//   - all other states: unchanged
//
// On recovery, sets ResolvedAt = now.UnixMilli() and Detail to the diagnostic
// text. The `now` parameter is injected so tests can drive the clock without
// wall-clock sleeps.
func (s *sessionQueueStore) recoverStaleDispatchingLocked(now time.Time) (changed bool, err error) {
	nowMs := now.UnixMilli()
	thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
	for i := range s.items {
		if s.items[i].State != QueueDispatching {
			continue
		}
		startedAt := s.items[i].DispatchStartedAt
		if startedAt > 0 && nowMs-startedAt <= thresholdMs {
			// In-flight (within threshold) — leave alone.
			continue
		}
		// Either stale (startedAt > 0 && elapsed > threshold) or legacy
		// (startedAt == 0, pre-this-fix on-disk item). Recover to terminal
		// unknown. NEVER pending. NEVER re-dispatch.
		s.items[i].State = QueueUnknown
		s.items[i].ResolvedAt = nowMs
		s.items[i].Detail = staleDispatchRecoveryDetail
		changed = true
	}
	return changed, nil
}

// Compaction retention (FIX-QUEUE-GC-5). Per-status TTL (measured from
// ResolvedAt — the terminal-state arrival time, NEVER CreatedAt) and per-
// status count cap. Retention order preserves ambiguous-recovery evidence
// (STUCK-1's recovered `unknown` items) the longest:
//
//	unknown (30d / 200) > failed (7d / 100) > sent (1h / 50)
//
// pending and dispatching are NEVER purged by compaction — they represent
// unsent work or active dispatch that the state machine must own.
const (
	sentItemTTL    = 1 * time.Hour
	sentItemCap    = 50
	failedItemTTL  = 7 * 24 * time.Hour
	failedItemCap  = 100
	unknownItemTTL = 30 * 24 * time.Hour
	unknownItemCap = 200
)

// Compaction TTL overrides — TEST-ONLY. Zero (the default) means "use the
// const default." Atomic (not a plain var) so the test-time write and the
// compaction-time read can never race under `go test -race` — mirrors
// staleDispatchThresholdOverride. Production code MUST NOT call
// SetCompactionTTLsForTest; the 1h/7d/30d defaults are the deliberate
// retention policy.
var (
	sentTTLOverride    atomic.Int64 // nanoseconds; 0 = use const default
	failedTTLOverride  atomic.Int64
	unknownTTLOverride atomic.Int64
)

func currentSentTTL() time.Duration {
	if ns := sentTTLOverride.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return sentItemTTL
}

func currentFailedTTL() time.Duration {
	if ns := failedTTLOverride.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return failedItemTTL
}

func currentUnknownTTL() time.Duration {
	if ns := unknownTTLOverride.Load(); ns > 0 {
		return time.Duration(ns)
	}
	return unknownItemTTL
}

// SetCompactionTTLsForTest overrides the per-status compaction TTLs for the
// duration of a test, so the retention contract can be exercised without
// 1h/7d/30d wall-clock waits. TEST-ONLY. Pass d <= 0 for a given status to
// restore its default. Callers SHOULD defer-restore the defaults when done
// (e.g. `defer SetCompactionTTLsForTest(0, 0, 0)`). Race-free (sync/atomic).
func SetCompactionTTLsForTest(sentTTL, failedTTL, unknownTTL time.Duration) {
	if sentTTL <= 0 {
		sentTTLOverride.Store(0)
	} else {
		sentTTLOverride.Store(int64(sentTTL))
	}
	if failedTTL <= 0 {
		failedTTLOverride.Store(0)
	} else {
		failedTTLOverride.Store(int64(failedTTL))
	}
	if unknownTTL <= 0 {
		unknownTTLOverride.Store(0)
	} else {
		unknownTTLOverride.Store(int64(unknownTTL))
	}
}

// compactTerminalItemsLocked removes expired and excess TERMINAL items
// (sent/failed/unknown) from s.items. It NEVER touches pending or
// dispatching — those represent unsent work or active dispatch that the
// state machine must own. Called under s.mu by List() (after stale-dispatch
// recovery) and Resolve() (after the terminal transition). The compaction
// scan is O(n) where n is bounded by the caps (~200 max); the brief
// explicitly forbids a dedicated high-frequency ticker.
//
// Returns changed=true if any item was removed.
//
// Two passes per status, applied independently (an item has exactly one
// State, so the per-status passes operate on disjoint item sets — map
// iteration order is irrelevant):
//
//  1. TTL pass: a terminal item with ResolvedAt > 0 whose age
//     (`now - ResolvedAt`) strictly exceeds the status TTL is marked for
//     removal. Items with ResolvedAt <= 0 (legacy/migration artifact with
//     no valid terminal timestamp) are CONSERVATIVE — they survive the TTL
//     pass. Purging them by an unreliable age would lose evidence. Future
//     ResolvedAt (clock skew) also survives.
//
//  2. Count-cap pass: if the survivors exceed the cap, the OLDEST are
//     removed. Ordered by (effective-time asc, Order asc). Items with
//     missing ResolvedAt are treated as fresh (`now`) for the sort so the
//     cap removes them LAST (conservative), with Order as the deterministic
//     tiebreaker within that group.
//
// The `now` parameter is injected so tests can drive the clock without
// wall-clock sleeps.
func (s *sessionQueueStore) compactTerminalItemsLocked(now time.Time) (changed bool) {
	nowMs := now.UnixMilli()
	type statusCfg struct {
		ttl time.Duration
		cap int
	}
	configs := map[QueueItemState]statusCfg{
		QueueSent:    {currentSentTTL(), sentItemCap},
		QueueFailed:  {currentFailedTTL(), failedItemCap},
		QueueUnknown: {currentUnknownTTL(), unknownItemCap},
	}
	// Removal set keyed by index into the ORIGINAL s.items slice. We can't
	// shrink s.items during iteration without invalidating later indices, so
	// we collect removals and rebuild the slice in one pass at the end.
	remove := make(map[int]bool)
	for status, cfg := range configs {
		ttlMs := int64(cfg.ttl / time.Millisecond)
		// Phase 1 — TTL pass. Mark expired items of this status. Conservative
		// on missing ResolvedAt (<= 0 survives) and on clock skew (future
		// ResolvedAt survives).
		for i, it := range s.items {
			if it.State != status {
				continue
			}
			if it.ResolvedAt <= 0 {
				continue
			}
			if nowMs-it.ResolvedAt > ttlMs {
				remove[i] = true
			}
		}
		// Phase 2 — count-cap pass. Collect survivors of this status, ordered
		// oldest-first, and mark the excess for removal.
		type idxEntry struct {
			i   int
			key int64 // ResolvedAt if > 0, else nowMs (conservative: fresh)
			ord uint64
		}
		var survivors []idxEntry
		for i, it := range s.items {
			if it.State != status || remove[i] {
				continue
			}
			key := it.ResolvedAt
			if key <= 0 {
				key = nowMs // conservative: treat as fresh so cap removes last
			}
			survivors = append(survivors, idxEntry{i, key, it.Order})
		}
		if len(survivors) <= cfg.cap {
			continue
		}
		sort.Slice(survivors, func(a, b int) bool {
			if survivors[a].key != survivors[b].key {
				return survivors[a].key < survivors[b].key
			}
			return survivors[a].ord < survivors[b].ord
		})
		excess := len(survivors) - cfg.cap
		for k := 0; k < excess; k++ {
			remove[survivors[k].i] = true
		}
	}
	if len(remove) == 0 {
		return false
	}
	kept := make([]QueueItem, 0, len(s.items)-len(remove))
	for i, it := range s.items {
		if !remove[i] {
			kept = append(kept, it)
		}
	}
	s.items = kept
	return true
}

// persistAfterCompaction persists the current in-memory state after a
// recovery+compaction cycle. When compaction emptied the queue, it deletes
// queue.json instead of writing an empty-items document — matching the
// lazy-creation pattern where a queue that never had items has no file. An
// empty-items file is harmless, but deleting it is cleaner and keeps the
// on-disk footprint minimal. Idempotent on removal: a missing file is the
// target state, not an error. Caller MUST hold s.mu.
//
// The archived guard on the remove branch is defense-in-depth mirroring
// save()'s last-resort guard: even if a future mutation path forgets the
// entry-time archived check, an archived store must NEVER os.Remove a
// queue.json that a fresh post-archive store at the same path may own (the
// two stores hold different mutexes; the removal would not be serialized
// against the fresh store's writes — silent data loss). Returns
// errQueueArchived (not nil) so a future missing entry guard surfaces as a
// loud error rather than silent success — matches save()'s pattern.
func (s *sessionQueueStore) persistAfterCompaction(compactChanged bool) error {
	if compactChanged && len(s.items) == 0 {
		if s.archived {
			// Tombstoned store: a fresh store may have already written
			// queue.json at this path post-archive. Removing it would be
			// silent data loss. Surface as errQueueArchived so a future
			// missing entry guard is loud, not silent.
			return errQueueArchived
		}
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("queue: remove emptied %s: %w", s.path, err)
		}
		return nil
	}
	return s.save()
}

// List returns a copy of all items in FIFO (order) order. It is the single
// chokepoint for stale-dispatch recovery AND terminal-item compaction: the
// SPA fetches the queue on session open, stream reconnect, focus/visibility,
// polling, and at vh-solara restart — so every entry path that would surface
// a stuck item first runs recovery, then compaction bounds disk growth from
// accumulated terminal items. Recovery transitions abandoned `dispatching`
// items to terminal `unknown` (never `pending`, never re-dispatched);
// compaction purges expired/excess `sent`/`failed`/`unknown` items (never
// `pending`/`dispatching`). Both are persisted atomically.
func (s *sessionQueueStore) List() ([]QueueItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		// BLK-1 / GC-5: List() now persists recovery+compaction, so it is a
		// mutating op and needs the same tombstone guard as Enqueue/Remove/
		// Claim/Resolve. A retained pointer to a store whose deleteStore
		// (archive) has completed must NOT run compaction persistence —
		// especially the empty-queue os.Remove branch, which could delete a
		// queue.json that a FRESH post-archive store at the same path has
		// written (the two stores hold different mutexes, so the removal is
		// not serialized against the fresh store's writes). A fresh store()
		// lookup AFTER deleteStore creates a brand-new sessionQueueStore with
		// archived==false; the tombstone only applies to retained pre-archive
		// pointers.
		return nil, errQueueArchived
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	// Snapshot the pre-mutation items so a save failure during recovery OR
	// compaction persistence rolls back ALL in-memory mutations (mirrors
	// Resolve/Claim rollback, extended to cover compaction's slice shrink).
	// Without this, a save failure would leave recovered/compacted state in
	// memory while disk still has the pre-mutation state, and a later
	// successful mutation would persist the mutated state — silently
	// committing transitions whose persistence failed. The shallow struct
	// copy is sufficient: recovery+compaction only mutate scalar fields or
	// drop entries, never the Attachments slice.
	preMutation := make([]QueueItem, len(s.items))
	copy(preMutation, s.items)
	recoverChanged, err := s.recoverStaleDispatchingLocked(time.Now())
	if err != nil {
		return nil, err
	}
	compactChanged := s.compactTerminalItemsLocked(time.Now())
	if recoverChanged || compactChanged {
		if err := s.persistAfterCompaction(compactChanged); err != nil {
			// Roll back ALL in-memory mutations from recovery AND compaction
			// so the store stays consistent with disk (neither was durably
			// committed).
			s.items = preMutation
			return nil, err
		}
	}
	out := make([]QueueItem, len(s.items))
	copy(out, s.items)
	return out, nil
}

// Enqueue appends a new pending item. The backend issues the ID and the
// monotonic order. Returns the created item.
func (s *sessionQueueStore) Enqueue(text string, attachments []QueueAttachment, cfg QueueSendConfig, originClientID string) (QueueItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		// BLK-1: a retained pointer to a store whose deleteStore (archive) has
		// completed must NOT append/save — its s.items are the stale pre-archive
		// set and save() would resurrect archived-away messages.
		return QueueItem{}, errQueueArchived
	}
	if err := s.load(); err != nil {
		return QueueItem{}, err
	}
	// Normalize nil→empty so the wire shape is always "attachments":[] (never
	// null, never omitted). Go marshals a nil slice as `null`; with the omitempty
	// tag removed above, a nil would serialize as "attachments":null. The sole
	// FE consumer (buildParts) iterates this field — the contract must be an array.
	if attachments == nil {
		attachments = []QueueAttachment{}
	}
	s.order++
	item := QueueItem{
		ID:             newQueueID(),
		Order:          s.order,
		State:          QueuePending,
		Text:           text,
		Attachments:    attachments,
		SendConfig:     cfg,
		OriginClientID: originClientID,
		CreatedAt:      time.Now().UnixMilli(),
	}
	s.items = append(s.items, item)
	if err := s.save(); err != nil {
		// Roll back the in-memory append so the store stays consistent with disk
		// (the item was never durably committed).
		s.items = s.items[:len(s.items)-1]
		s.order--
		return QueueItem{}, err
	}
	return item, nil
}

// Remove deletes an item by id. Operators may dismiss any item that is not
// actively in flight: `pending` (cancel before dispatch), and terminal states
// `sent`/`failed`/`unknown` (clear a recovered or completed item from view).
// `dispatching` is the sole non-removable state — the dispatch may be in
// flight, so the state machine must own its transition to a terminal state
// first. Survivor persistence is atomic (temp-file + fsync + rename via
// save()); on save failure the in-memory slice rolls back so the store stays
// consistent with disk.
func (s *sessionQueueStore) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return errQueueArchived
	}
	if err := s.load(); err != nil {
		return err
	}
	for i, it := range s.items {
		if it.ID == id {
			if it.State == QueueDispatching {
				return errQueueNotRemovable
			}
			// Snapshot the pre-remove slice so a save failure rolls the in-memory
			// state back (mirrors Enqueue/Claim/Resolve rollback): the removal was
			// never durably committed, so the store must stay consistent with disk.
			// Without this, a save failure would leave memory without the item
			// while disk still has it, and a later successful mutation would
			// persist the shortened slice — silently deleting an item whose remove
			// request failed.
			orig := s.items
			candidate := make([]QueueItem, len(orig)-1)
			copy(candidate[:i], orig[:i])
			copy(candidate[i:], orig[i+1:])
			s.items = candidate
			if err := s.save(); err != nil {
				s.items = orig
				return err
			}
			return nil
		}
	}
	return errQueueNotFound
}

// Claim atomically moves the OLDEST pending item to `dispatching` and returns
// it. This is the cross-client boundary: serialized by the mutex, exactly one
// caller wins a given item. Returns (QueueItem{}, nil) when no pending item
// exists.
func (s *sessionQueueStore) Claim() (QueueItem, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, false, errQueueArchived
	}
	if err := s.load(); err != nil {
		return QueueItem{}, false, err
	}
	for i := range s.items {
		if s.items[i].State == QueuePending {
			// Record the dispatch-start timestamp in the SAME in-memory
			// mutation + atomic save as the pending→dispatching transition, so
			// a crash after Claim returns but before dispatch leaves a
			// recoverable timestamp on disk (recoverStaleDispatchingLocked
			// uses it to detect abandoned dispatches).
			s.items[i].State = QueueDispatching
			s.items[i].DispatchStartedAt = time.Now().UnixMilli()
			if err := s.save(); err != nil {
				// Roll back BOTH the state and the timestamp so the store
				// stays consistent with disk (neither was durably committed).
				s.items[i].State = QueuePending
				s.items[i].DispatchStartedAt = 0
				return QueueItem{}, false, err
			}
			item := s.items[i]
			return item, true, nil
		}
	}
	return QueueItem{}, false, nil
}

// Resolve records a terminal outcome (sent/failed/unknown) on an item. It can
// never repend: the target MUST be terminal, and a pending item must be claimed
// first (a resolve on pending is a logic error — the item was never dispatched).
// Resolving an already-terminal item is allowed (idempotent re-report after a
// network blip) and updates the state/detail. After the terminal transition,
// compactTerminalItemsLocked runs so a freshly-terminal item that pushes the
// queue over a cap is trimmed in the same atomic save.
func (s *sessionQueueStore) Resolve(id string, target QueueItemState, detail string) (QueueItem, error) {
	if !isTerminalState(target) {
		return QueueItem{}, errQueueCannotRepend
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, errQueueArchived
	}
	if err := s.load(); err != nil {
		return QueueItem{}, err
	}
	for i := range s.items {
		if s.items[i].ID == id {
			if s.items[i].State == QueuePending {
				return QueueItem{}, errQueueNotClaimed
			}
			// Snapshot BEFORE any mutation so a save/remove failure restores
			// the pre-resolve in-memory view across BOTH the terminal
			// transition AND any compaction removals (mirrors the existing
			// rollback, extended to cover compaction's slice shrink). Without
			// this, a save failure would leave the new terminal state in
			// memory while disk still has the prior state, and a later
			// successful mutation would persist the resolved state — silently
			// committing a transition whose persistence failed.
			preSnapshot := make([]QueueItem, len(s.items))
			copy(preSnapshot, s.items)
			s.items[i].State = target
			s.items[i].Detail = detail
			s.items[i].ResolvedAt = time.Now().UnixMilli()
			resolved := s.items[i] // capture before compaction may shrink s.items
			compactChanged := s.compactTerminalItemsLocked(time.Now())
			if err := s.persistAfterCompaction(compactChanged); err != nil {
				s.items = preSnapshot
				return QueueItem{}, err
			}
			return resolved, nil
		}
	}
	return QueueItem{}, errQueueNotFound
}

// queueRegistry owns the per-(project,session) stores. One store per session
// keeps contention to a single session's operations; the registry mutex only
// guards the map itself.
type queueRegistry struct {
	mu     sync.Mutex
	stores map[string]*sessionQueueStore
}

func newQueueRegistry() *queueRegistry {
	return &queueRegistry{stores: map[string]*sessionQueueStore{}}
}

// queuePath returns the on-disk path for a session's queue under the project's
// .vh-solara runtime dir (peer to attachments/).
func queuePath(root, sessionID string) string {
	return filepath.Join(root, ".vh-solara", "sessions", sessionID, "queue.json")
}

// vhSolaraDir returns the .vh-solara directory that owns a queue path
// (<root>/.vh-solara/sessions/<sid>/queue.json → <root>/.vh-solara). Used by
// save() to ensure that project's .vh-solara/.gitignore without needing the
// project root stored on the store (the store only carries s.path).
func vhSolaraDir(p string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(p)))
}

func storeKey(root, sessionID string) string {
	return root + "\x00" + sessionID
}

// store returns the (lazily-created) store for (root, sessionID).
func (qr *queueRegistry) store(root, sessionID string) *sessionQueueStore {
	key := storeKey(root, sessionID)
	qr.mu.Lock()
	defer qr.mu.Unlock()
	st := qr.stores[key]
	if st == nil {
		st = &sessionQueueStore{path: queuePath(root, sessionID)}
		qr.stores[key] = st
	}
	return st
}

// deleteStore is the idempotent web-owned cleanup primitive for one session's
// queue. It drops the in-memory store for (root, sessionID), tombstones it
// (BLK-1), removes its queue.json, AND attempts empty-only rmdir of the parent
// session directory (.vh-solara/sessions/<id>/). Today the sole caller is the
// archive lifecycle (archive.go); FIX-QUEUE-GC slices 2-5 will route additional
// cleanup paths (session.delete events, orphan reconciliation, terminal
// dismissal, automatic compaction) through this same primitive.
//
// Cleanup contract (FIX-QUEUE-GC-1):
//   - Idempotent: a missing queue.json, a missing session directory, or a
//     missing registry entry are all valid starting states. Repeated calls are
//     no-ops. Neither os.Remove error (ENOENT, non-empty dir, etc.) is surfaced
//     — the contract is "best-effort: queue.json is gone; session directory is
//     gone IF empty".
//   - Empty-only rmdir: if the parent session directory still holds anything
//     (attachments/ subdir, an atomic-write temp file from writeQueueAtomic,
//     or any other peer artifact), os.Remove fails on every platform and the
//     directory survives. That failure is intentionally swallowed.
//   - NEVER os.RemoveAll: the attachment lifecycle (peer attachments/ subdir)
//     is unproven to be free of retained OpenCode transcript file://
//     references, so recursively deleting the session directory could orphan
//     live attachment data. Queue GC is scoped to queue files only.
//   - Filesystem cleanup runs even when no store is registered (mirrors the
//     original best-effort file-removal contract) so a hand-seeded queue.json
//     from a pre-startup persistence state still gets removed.
//
// The REGISTRY lock is held across BOTH the map-removal AND the os.Remove so a
// concurrent store()/Enqueue (which needs the registry lock to create a new
// sessionQueueStore at the same path) cannot race with the file removal. The
// old-store mutex is additionally held for old-store serialization, but locking
// only the OLD st.mu would be insufficient: a racer creates a NEW store object
// with a DIFFERENT mutex, loads the not-yet-removed file, enqueues, and save()s
// — resurrecting the queue or silently losing a durably-enqueued item. Holding
// qr.mu across the whole operation closes that window. Disk I/O under the
// global registry lock is acceptable here because archive is a rare operator
// action, not a per-message hot path.
//
// BLK-1 tombstone: while holding BOTH qr.mu AND st.mu, st.archived is set to
// true BEFORE the map entry is removed and BEFORE os.Remove. This is the
// definitive closure of the archive-resurrection class: a RETAINED pointer to
// the old store (obtained via an earlier store() call, before archive) still
// points at this object. Its mutations acquire only st.mu (not qr.mu), so once
// deleteStore releases st.mu, the retained pointer's Enqueue/Claim/Resolve/
// Remove observe archived==true and return errQueueArchived WITHOUT appending,
// mutating, or save()ing — so it cannot write queue.json back into existence
// (which would resurrect the archived-away messages). A fresh store() lookup
// AFTER deleteStore creates a brand-new sessionQueueStore (archived==false,
// loaded==false); the tombstone applies only to the old retained pointer.
func (qr *queueRegistry) deleteStore(root, sessionID string) {
	key := storeKey(root, sessionID)
	path := queuePath(root, sessionID)
	dir := filepath.Dir(path)
	qr.mu.Lock()
	defer qr.mu.Unlock()
	st := qr.stores[key]
	if st == nil {
		// No in-memory store to tombstone; just ensure the file is gone and
		// attempt empty-only rmdir of the parent session directory.
		_ = os.Remove(path)
		_ = os.Remove(dir)
		return
	}
	// Hold st.mu across the tombstone set, map removal, AND both os.Remove
	// calls so any retained pointer to this store observes archived==true
	// before it can mutate/save. qr.mu is already held, so a concurrent
	// store() cannot create a new entry until this whole block completes
	// (B2).
	st.mu.Lock()
	st.archived = true
	delete(qr.stores, key)
	_ = os.Remove(path)
	// Empty-only rmdir of the parent session directory. If attachments/,
	// an atomic-write temp file from writeQueueAtomic, or anything else is
	// present, os.Remove fails and the directory survives — that is the
	// correct, safe behavior. The error is intentionally swallowed: this is
	// best-effort cleanup, NEVER os.RemoveAll (attachment lifecycle is
	// unproven against retained OpenCode transcript file:// references).
	_ = os.Remove(dir)
	st.mu.Unlock()
}

// CleanupSession is the public web-owned cleanup helper for one session's
// queue. It is the single web-layer entry point that both the direct /vh/archive
// handler and the session.delete event subscriber call so that queue cleanup
// runs regardless of which path removed the session (operator archive click,
// external-client archive via time.archived, OpenCode live session.deleted, or
// hydrate prune). It is a thin pass-through to the idempotent deleteStore
// primitive (FIX-QUEUE-GC-1).
//
// GC-2 contract:
//   - The /vh/archive handler calls this DIRECTLY (archive correctness must not
//     depend on best-effort event delivery — see Settled Assumption #5).
//   - The session.delete subscriber installed in aggFor also calls this. The
//     two calls compose: deleteStore is idempotent, so a direct+event pair for
//     the same session is a benign no-op the second time.
//   - Keep this wrapper as the single name callers route through, so future
//     GC slices (orphan reconciliation, terminal-item dismissal, compaction)
//     have one obvious hook.
func (qr *queueRegistry) CleanupSession(root, sessionID string) {
	qr.deleteStore(root, sessionID)
}

// reconcileOrphanQueues is the durable backstop (FIX-QUEUE-GC-3) for GC-2's
// best-effort session.delete event subscriber. GC-2 fires CleanupSession inline
// as session.delete events stream in, but store.emit()'s fan-out is
// nonblocking and drops events on a full subscriber buffer — so an event can
// be lost, leaving an orphan queue.json on disk whose session ID is no longer
// in the authoritative active set. This function scans the filesystem (NOT the
// loaded queueRegistry entries — orphans by definition aren't loaded) and
// removes every queue.json whose session ID is NOT in activeSessions.
//
// FAIL-CLOSED contract (the single most important rule):
//   - If activeSessions == nil, this returns nil immediately and deletes
//     NOTHING. A nil map means "the caller could not obtain an authoritative
//     active-session set" (hydrate failed, store unavailable, or any other
//     uncertainty). Deleting against an incomplete set would murder live
//     sessions' queues. The empty non-nil map (map with zero entries) is the
//     OPPOSITE case — "hydrate succeeded and reported zero active sessions" —
//     and correctly results in every on-disk queue being treated as an orphan.
//   - The caller (reconcileQueuesForAgg in server.go) is responsible for
//     producing activeSessions ONLY from a successful post-hydrate
//     store.SessionIDs() call and for gating on HydratedOnce() before calling.
//     The nil-check here is the second line of defense.
//
// Scan discipline:
//   - os.ReadDir of <root>/.vh-solara/sessions. If the directory does not
//     exist, there is nothing to reconcile — return nil. Any other scan error
//     is returned to the caller (who logs it); no deletion happens on scan
//     failure because the loop body never runs.
//   - For each entry that is a directory, the entry name IS the session ID
//     (queuePath = .../sessions/<id>/queue.json). Non-directory entries
//     (stray files at the sessions/ level) are ignored.
//   - For a session ID NOT in activeSessions, stat its queue.json. If the
//     queue.json does not exist (e.g. an attachments-only directory — GC-3
//     does not own attachment lifecycle), skip without error. Only
//     directories that actually contain a queue.json are reconciled.
//   - CleanupSession is idempotent and race-safe with concurrent Enqueue/
//     Claim/Resolve/Remove and with atomic writes (see deleteStore): it takes
//     qr.mu, tombstones any loaded store, removes the file, and attempts an
//     empty-only rmdir. A concurrent mutator on a retained store pointer
//     observes archived==true and refuses to re-save, so the orphan cannot be
//     resurrected. A file that vanishes between stat and CleanupSession is
//     not an error (deleteStore's os.Remove is best-effort).
//
// Idempotent: a second reconciliation pass finds nothing to do. Safe to call
// from multiple goroutines (qr.mu serializes the per-session work); the
// production caller dispatches each pass to a fresh goroutine so hydrate's
// goroutine is never blocked.
func (qr *queueRegistry) reconcileOrphanQueues(root string, activeSessions map[string]bool) error {
	// FAIL-CLOSED: a nil active set means "no authoritative inventory." Delete
	// nothing. The empty non-nil map (len==0) intentionally falls through and
	// deletes every on-disk queue — that is the "hydrate succeeded with zero
	// sessions" case, which is safe and correct.
	if activeSessions == nil {
		return nil
	}
	sessionsDir := filepath.Join(root, ".vh-solara", "sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		if os.IsNotExist(err) {
			// No sessions directory at all — nothing to reconcile. Not an error.
			return nil
		}
		return fmt.Errorf("queue reconcile: scan %s: %w", sessionsDir, err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			// Stray file at the sessions/ level (not a session directory) —
			// ignore. GC-3 owns only <id>/queue.json reconciliation.
			continue
		}
		sid := e.Name()
		if activeSessions[sid] {
			// Live session — its queue.json must survive.
			continue
		}
		// Candidate orphan. Stat its queue.json before cleanup: a session
		// directory may legitimately contain only attachments/ (no queue.json
		// was ever written, or it was already cleaned up). GC-3 must not touch
		// attachment-only directories.
		qPath := queuePath(root, sid)
		if _, statErr := os.Stat(qPath); statErr != nil {
			if os.IsNotExist(statErr) {
				continue
			}
			// A non-NotExist stat error is unexpected but not fatal to the
			// whole pass — skip this entry and continue with the rest. Log
			// for observability; do not return (the other orphans still need
			// cleaning, and a transient permission error on one entry should
			// not block the whole reconciliation).
			vhlog.Warn("queue reconcile: stat skipped", "path", qPath, "err", statErr)
			continue
		}
		qr.CleanupSession(root, sid)
	}
	return nil
}

// newQueueID issues a backend-owned queue item id. crypto/rand gives global
// uniqueness for diagnostics; the monotonic Order (not the id) governs FIFO.
func newQueueID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "q-" + hex.EncodeToString(b[:])
}

// writeQueueAtomic writes data to path atomically: temp file in the same dir →
// write → fsync → chmod → rename → best-effort dir fsync. On POSIX the rename
// is atomic, so a crash at any earlier point leaves the previous path
// byte-intact (at worst the temp lingers). Mirrors pkg/projectcfg/atomic.go,
// which is unexported and so cannot be reused from package web.
func writeQueueAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("queue: atomic write %s: create temp: %w", path, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("queue: atomic write %s: write temp: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("queue: atomic write %s: fsync temp: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("queue: atomic write %s: close temp: %w", path, err)
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return fmt.Errorf("queue: atomic write %s: chmod temp: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("queue: atomic write %s: rename: %w", path, err)
	}
	syncQueueDirBestEffort(dir)
	return nil
}

// syncQueueDirBestEffort fsyncs dir, ignoring all errors (tmpfs/network FS may
// not support dir fsync; this is durability, not correctness).
func syncQueueDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
