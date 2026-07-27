// Package state: the message-windows concern — the window/cold-batch
// projection + ABA-guard surface of the store, mechanically extracted from
// store.go (reference model: subtree_indexes.go / snapshots.go). This file
// owns:
//   - the window/page projectors (projectMessageWindow / projectMessagePage)
//     and their pure helpers (messageSerializedBytes / messageIDFromInfo);
//   - the SnapshotMessagesPage read accessor (historical-page endpoint backing
//     store) and the MessagePageResult envelope type;
//   - the wholesale cold-batch path (captureMessagesBatchLocked +
//     packageMessagesBatch + publishColdBatch) and its ColdBatchStatus outcome
//     type;
//   - bumpMsgRev — the Store-wide monotonic revision token bumper called from
//     every reducer mutation site (Constraint C2); and
//   - the WindowMaxCount / WindowMaxBytes tunable defaults.
//
// The Store struct and its single s.mu RWMutex stay in store.go and are shared
// across this whole package (same-package file split; no protocol change). The
// msgRev / nextMsgRev / windowMaxCount / windowMaxBytes STRUCT FIELDS stay on
// the Store struct (same-package cross-file access from this concern); only the
// functions that read/write them move here.
//
// Behavior-preserving verbatim move. The Discipline B double-lock
// capture-validate pattern on publishColdBatch (capture token under Lock →
// package lock-free → re-acquire Lock and emit ONLY if token unchanged, the ABA
// guard against a deleted-then-recreated session) is preserved byte-for-byte;
// the coldBatchAfterCaptureHook test seam and the 12 cold-batch
// characterization tests are the net.
package state

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// WindowMaxCount and WindowMaxBytes are the operator-tunable bounds for the
// initial message-window projection (the cold-load tail) AND the historical
// page endpoint. They serve TWO distinct roles after GAP-S5:
//
//  1. The DEFAULT per-instance bound: New() copies these into
//     s.windowMaxCount / s.windowMaxBytes, which are the fields actually read
//     by the store's projection paths (captureMessagesBatchLocked,
//     materializeSnapshot, SnapshotMessagesPage). Tests shrink the INSTANCE
//     field (via withWindowBounds(t, s, ...)), not this global, so a -race run
//     cannot observe a global mutation racing a lingering goroutine.
//
//  2. The cross-package clamp ceiling: pkg/web/messages_http.go reads these
//     directly to clamp ?limit= / ?max_bytes= query params so a single
//     historical page never exceeds the initial window's footprint. That path
//     is a request-entry read of an effectively-constant ceiling — no test
//     shrinks it (the pkg/state tests that need a smaller bound pass an
//     explicit limit/maxBytes to the pure projector or set the instance
//     field), so the global read is race-free in practice.
//
// The defaults (100 messages / 1 MiB) are the operator-recommended dual
// bound: whichever hits first stops the window. The projector always includes
// at least the newest complete message even when the byte budget is exceeded
// (the oversized_item case).
var (
	WindowMaxCount = 100
	WindowMaxBytes = 1 << 20 // 1 MiB
)

// messageSerializedBytes returns the raw message-value byte size of a
// projection: len(Info) + sum(len(Parts)). This is the size measure the window
// projector budgets against. It is an APPROXIMATE content budget: it omits the
// marshaled-JSON envelope framing (the {"info":...,"parts":[...]} object/array
// keys, commas, braces the wire payload adds per message), so a window accepted
// at exactly maxBytes produces a decompressed wire payload slightly ABOVE
// maxBytes. The framing overhead is small and bounded per message; the per-part
// 1 MiB text cap (commit 516186b) is the hard OOM guardrail, and this aggregate
// cap delivers the order-of-magnitude bound the slice targets. Pure: no
// allocation, no store access.
func messageSerializedBytes(m MessageWithParts) int {
	n := len(m.Info)
	for _, p := range m.Parts {
		n += len(p)
	}
	return n
}

// messageIDFromInfo extracts the envelope id from a message info JSON blob. Used
// by the window projector to populate OldestLoadedID (the historical-page
// cursor). Returns "" on parse failure (the projector treats this as "no id
// available" — the client falls back to its own oldest-known id).
func messageIDFromInfo(info json.RawMessage) string {
	var env messageInfoEnvelope
	if json.Unmarshal(info, &env) == nil {
		return env.ID
	}
	return ""
}

// projectMessageWindow bounds a session's message list (creation-ordered, oldest
// first) to a recent tail of at most maxCount messages whose aggregate
// serialized size does not exceed maxBytes. Messages stay atomic: a message is
// NEVER split or truncated for windowing (the per-part text cap is a separate,
// earlier guardrail). The newest message is ALWAYS included, even if it alone
// exceeds the byte budget (the oversized case — the projector returns it alone
// and signals oversized_item + actual_bytes/budget_bytes so a client can render
// a diagnostic without a freeze).
//
// PURE and DETERMINISTIC: same input list → same bounded list + same WindowMeta.
// This is what preserves the monotonic revision-validation contract under
// windowing (no false staleness discard): the same captured state always
// projects to the same bytes, so publishColdBatch's msgRev equality check is
// sound. The projector performs NO store access and NO lock acquisition — it
// operates on an already-captured []MessageWithParts.
//
// The result preserves creation order (oldest first), matching the wire shape
// the client expects for prepend-on-load-more.
func projectMessageWindow(list []MessageWithParts, maxCount, maxBytes int) ([]MessageWithParts, WindowMeta) {
	meta := WindowMeta{}
	n := len(list)
	if n == 0 {
		// Empty (but PRESENT) session transcript. Return a non-nil empty slice
		// (NOT nil) so the caller can distinguish "0-message session, emit an
		// empty batch so the client knows it loaded as empty" from "session
		// gone (sm==nil), emit nothing." This matches the pre-windowing
		// behavior where captureMessagesBatchLocked returned make([]MessageWithParts, 0, ...).
		return []MessageWithParts{}, meta
	}
	if maxCount < 1 {
		maxCount = 1 // always include at least the newest
	}
	// The newest message is ALWAYS in the window (even if oversized). Walk
	// older messages newest-to-oldest, stopping at the first bound hit.
	newest := list[n-1]
	newestSize := messageSerializedBytes(newest)
	accCap := maxCount
	if n < accCap {
		accCap = n
	}
	tail := make([]MessageWithParts, 0, accCap)
	tail = append(tail, newest)
	accumulated := newestSize
	oldestID := messageIDFromInfo(newest.Info)

	if newestSize > maxBytes {
		// Oversized newest: return it ALONE. has_older reflects whether older
		// messages exist beyond this one. The diagnostics let a client explain
		// WHY it sees a single oversized item instead of the expected window.
		meta.MessageCount = 1
		meta.SerializedBytes = newestSize
		meta.OldestLoadedID = oldestID
		meta.HasOlder = n > 1
		meta.OversizedItem = true
		meta.ActualBytes = newestSize
		meta.BudgetBytes = maxBytes
		return tail, meta
	}

	countLimited := false
	bytesLimited := false
	for i := n - 2; i >= 0; i-- {
		m := list[i]
		size := messageSerializedBytes(m)
		if len(tail)+1 > maxCount {
			countLimited = true
			break
		}
		if accumulated+size > maxBytes {
			bytesLimited = true
			break
		}
		tail = append(tail, m)
		accumulated += size
		oldestID = messageIDFromInfo(m.Info)
	}
	meta.MessageCount = len(tail)
	meta.SerializedBytes = accumulated
	meta.OldestLoadedID = oldestID
	meta.HasOlder = countLimited || bytesLimited
	meta.CountLimited = countLimited
	meta.BytesLimited = bytesLimited
	// tail was built newest-first; reverse to creation order (oldest first).
	for i, j := 0, len(tail)-1; i < j; i, j = i+1, j-1 {
		tail[i], tail[j] = tail[j], tail[i]
	}
	return tail, meta
}

// MessagePageResult is the response envelope for the historical-page endpoint
// (GET /vh/session/{sessionId}/messages?before=...). It is DISTINCT from the
// cold-load messages.batch envelope: the client treats the items[] as a
// PREPEND/MERGE-BY-ID source (NEVER a wholesale replace) and MUST NOT confuse
// this response with a messages.batch or messages.loaded event. The endpoint
// never emits SSE events of any kind — it is a one-shot HTTP read.
//
// The fields mirror the bounded-window metadata contract (WindowMeta) but add
// the page-specific cursor echoes (request_before, newest_id, boundary_found)
// the prepend path needs. session_id / daemon_epoch / baseline_seq travel on
// the envelope so a client can correlate the page with a snapshot cursor. The
// stampMeta middleware stamps X-VH-Seq / X-VH-Epoch response headers at
// REQUEST ENTRY (before the handler runs); BaselineSeq below is captured at the
// actual SnapshotMessagesPage RLock (inside the handler). On a quiescent warm
// session the two seq values match; under a concurrent mutation during the
// request they can diverge (BaselineSeq is the more accurate capture cursor).
// The Contract-B freshness check (Phase 4 client) uses BaselineSeq — NOT
// X-VH-Seq — as the authoritative page-capture watermark and discards a page
// whose capture raced with a session mutation.
type MessagePageResult struct {
	// SessionID is the session this page belongs to. Always set on the wire.
	SessionID string `json:"session_id"`
	// ProjectID is the project directory (reqDir / ?dir=) the request resolved
	// to. Empty for the default project (the SPA fills it client-side).
	ProjectID string `json:"project_id,omitempty"`
	// DaemonEpoch is the store epoch at capture, so a client detects a daemon
	// restart (epoch change) that invalidates all historical cursors.
	DaemonEpoch string `json:"daemon_epoch"`
	// RequestBefore echoes the ?before=<id> cursor the client sent. Empty when
	// the client sent no cursor (the projector returns an empty page in that
	// case, since the initial-window path is the documented source of the
	// first cursor).
	RequestBefore string `json:"request_before,omitempty"`
	// BaselineSeq is the store seq captured under RLock at the moment
	// SnapshotMessagesPage read the transcript — the authoritative page-capture
	// watermark for Contract-B. The X-VH-Seq response header is stamped
	// earlier (at request entry by the stampMeta middleware); the two match on
	// a quiescent warm session but can diverge under concurrent mutation
	// (BaselineSeq is the more accurate cursor). The Phase 4 client compares
	// BaselineSeq against its connection cursor to discard stale pages.
	BaselineSeq uint64 `json:"baseline_seq"`
	// Items is the page, creation-ordered (oldest first) so the client can
	// prepend the slice verbatim after a one-item overlap dedup. ALWAYS non-nil
	// (empty [] when the page is empty) so the client distinguishes "empty
	// page" from "missing field".
	Items []MessageWithParts `json:"items"`
	// BoundaryFound is true when RequestBefore was located in the ordered
	// transcript at capture time. False means the cursor is stale (the message
	// was deleted, or the client sent a cursor it never received) — the client
	// refetches from a known-good cursor. Distinct from HasOlder: an oldest
	// message with no older neighbors has BoundaryFound=true, HasOlder=false.
	BoundaryFound bool `json:"boundary_found"`
	// OldestID is the message id of the OLDEST item in the page (the new
	// ?before= cursor for the NEXT historical page). Empty when the page is
	// empty.
	OldestID string `json:"oldest_id,omitempty"`
	// NewestID is the message id of the NEWEST item in the page (= RequestBefore
	// when boundary_found, since the boundary message is the page overlap).
	// Empty when the page is empty.
	NewestID string `json:"newest_id,omitempty"`
	// HasOlder is true when older messages exist beyond this page. The client
	// uses this (NOT boundary_found) to decide whether to render a "Load older"
	// affordance below the prepended page.
	HasOlder bool `json:"has_older"`
	// MessageCount is len(Items); carried explicitly so a client reads it
	// without decoding the items array.
	MessageCount int `json:"message_count"`
	// SerializedBytes is the sum of len(Info)+sum(len(Parts)) across the page
	// — same raw-value size measure as WindowMeta.SerializedBytes. A client
	// uses this to decide whether to evict far pages under the resident cache
	// byte budget.
	SerializedBytes int `json:"serialized_bytes"`
	// CountLimited / BytesLimited signal WHY the page stopped, mirroring
	// WindowMeta. A "Load older" affordance is meaningful iff HasOlder (which
	// is set when either limit fires AND older messages exist).
	CountLimited bool `json:"count_limited"`
	BytesLimited bool `json:"bytes_limited"`
	// OversizedItem / ActualBytes / BudgetBytes mirror WindowMeta: set ONLY in
	// the oversized-anchor case (the ?before= message alone exceeds the byte
	// budget). The page returns the anchor alone so the client never sees a
	// silent gap, and signals the overflow so it can explain the single-item
	// page.
	OversizedItem bool `json:"oversized_item,omitempty"`
	ActualBytes   int  `json:"actual_bytes,omitempty"`
	BudgetBytes   int  `json:"budget_bytes,omitempty"`
}

// projectMessagePage paginates a session's FULL message list (creation-ordered,
// oldest first) into a single historical page anchored at the `before` cursor.
// The page is INCLUSIVE of `before` as a one-item OVERLAP (the newest item in
// the page), followed by strictly-older messages bounded by (maxCount, maxBytes)
// — mirroring projectMessageWindow's dual bound. The overlap lets a client
// robustly dedup against its resident window (it prepends items whose ids are
// NOT already present), so continuity is preserved even if the resident cache
// evicted the boundary message.
//
// Contract:
//   - `before` is REQUIRED. An empty cursor returns an empty page with
//     boundary_found=false (the initial window is the documented source of the
//     first cursor; a missing cursor is a client bug or a stale-cache fetch).
//   - `before` not found in the list returns an empty page with
//     boundary_found=false (the client refetches from a known-good cursor;
//     Contract-B's dirty-flag is the primary guard against resurrecting a
//     deleted-then-recreated message).
//   - If the anchor (`before`) alone exceeds maxBytes, the page returns it
//     ALONE with oversized_item + actual_bytes/budget_bytes (the same
//     atomic-message guarantee as projectMessageWindow).
//   - `limit` bounds TOTAL page size (overlap + older), matching
//     projectMessageWindow's maxCount semantics.
//
// PURE and DETERMINISTIC: same input list + cursor → same page + same metadata.
// This is what makes the page a point-in-time Contract-B snapshot the client can
// validate against its cursor (no server-side retry loop needed; the GET is a
// read). No store access, no lock.
//
// The result preserves creation order (oldest first) so the client can prepend
// the slice verbatim.
func projectMessagePage(list []MessageWithParts, before string, maxCount, maxBytes int) MessagePageResult {
	res := MessagePageResult{Items: []MessageWithParts{}, RequestBefore: before}
	if before == "" || len(list) == 0 {
		return res // boundary_found stays false
	}
	if maxCount < 1 {
		maxCount = 1 // always include at least the anchor
	}
	if maxBytes < 1 {
		maxBytes = 1 // avoid the oversized short-circuit firing on any non-empty anchor
	}
	// Find the anchor index (linear scan; list is creation-ordered oldest-first,
	// so the scan is stable across message id reuse — the FIRST match wins, and
	// ids are unique within a session's lifetime).
	anchorIdx := -1
	for i := range list {
		if messageIDFromInfo(list[i].Info) == before {
			anchorIdx = i
			break
		}
	}
	if anchorIdx < 0 {
		return res // before not found; boundary_found stays false
	}
	res.BoundaryFound = true
	// The anchor is the page's newest item (the overlap). Walk older messages
	// newest-to-oldest from index < anchorIdx, dual-bounded.
	anchor := list[anchorIdx]
	anchorSize := messageSerializedBytes(anchor)
	page := make([]MessageWithParts, 0, maxCount)
	page = append(page, anchor)
	res.NewestID = before
	res.OldestID = before
	res.SerializedBytes = anchorSize

	if anchorSize > maxBytes {
		// Oversized anchor: return it ALONE. has_older reflects whether older
		// messages exist beyond the anchor (i.e. anchorIdx > 0).
		res.Items = page
		res.HasOlder = anchorIdx > 0
		res.OversizedItem = true
		res.ActualBytes = anchorSize
		res.BudgetBytes = maxBytes
		res.MessageCount = 1
		return res
	}

	countLimited := false
	bytesLimited := false
	for i := anchorIdx - 1; i >= 0; i-- {
		m := list[i]
		size := messageSerializedBytes(m)
		if len(page)+1 > maxCount {
			countLimited = true
			break
		}
		if res.SerializedBytes+size > maxBytes {
			bytesLimited = true
			break
		}
		page = append(page, m)
		res.SerializedBytes += size
		res.OldestID = messageIDFromInfo(m.Info)
	}
	res.HasOlder = countLimited || bytesLimited
	res.CountLimited = countLimited
	res.BytesLimited = bytesLimited
	// page was built newest-first (anchor, older, older...); reverse to
	// creation order (oldest first) for the client's verbatim prepend.
	for i, j := 0, len(page)-1; i < j; i, j = i+1, j-1 {
		page[i], page[j] = page[j], page[i]
	}
	res.Items = page
	res.MessageCount = len(page)
	return res
}

// SnapshotMessagesPage is the Store accessor backing the historical-page HTTP
// endpoint (GET /vh/session/{sessionId}/messages?before=...). It captures the
// FULL per-session message list under a read lock (a point-in-time consistent
// view, NOT the bounded window Snapshot carries), paginates it via
// projectMessagePage outside the lock, and stamps the envelope with the session
// id + daemon epoch + baseline seq so the client can correlate the page with a
// snapshot cursor and run its Contract-B freshness check.
//
// Pure read: performs NO writeback and bumps NO msgRev (mirrors Snapshot). The
// Contract-B freshness contract is enforced CLIENT-SIDE (Phase 4): the server
// stamps X-VH-Seq / X-VH-Epoch via the stampMeta middleware at request entry,
// and the client discards the page if the session mutated during the flight
// (the dirty-flag mechanism, NOT a server-side retry loop).
//
// limit / maxBytes <= 0 fall back to the package WindowMaxCount / WindowMaxBytes
// defaults so the endpoint is safe to call with no query params beyond `before`.
func (s *Store) SnapshotMessagesPage(sid, before string, limit, maxBytes int) MessagePageResult {
	if limit <= 0 {
		limit = s.windowMaxCount
	}
	if maxBytes <= 0 {
		maxBytes = s.windowMaxBytes
	}
	s.mu.RLock()
	sm := s.messages[sid]
	epoch := s.epoch
	seq := s.seq
	var full []MessageWithParts
	if sm != nil {
		// Defensive copy of info + each part, exactly as captureMessagesBatchLocked
		// does — the slice escapes the lock and is read during pagination, so a
		// concurrent writer must not observe in-place mutation.
		full = make([]MessageWithParts, 0, len(sm.order))
		for _, mid := range sm.order {
			me := sm.byID[mid]
			if me == nil {
				continue
			}
			parts := make([]json.RawMessage, 0, len(me.partOrder))
			for _, pid := range me.partOrder {
				parts = append(parts, append([]byte(nil), me.parts[pid]...))
			}
			full = append(full, MessageWithParts{
				Info:  append([]byte(nil), me.info...),
				Parts: parts,
			})
		}
	}
	s.mu.RUnlock()
	res := projectMessagePage(full, before, limit, maxBytes)
	res.SessionID = sid
	res.DaemonEpoch = epoch
	res.BaselineSeq = seq
	return res
}

// bumpMsgRev advances the Store-wide monotonic token and assigns it to the
// owning session's msgRev[sid]. Called under s.mu for EVERY mutation capable
// of changing a session's cold-batch/snapshot message projection (message/part
// upsert+delete, streaming part-delta append + its write-side throttle flush
// into me.parts, history reconcile). Snapshot never calls this: it is a pure
// read projection under RLock that captures the buffered deltas onto fresh
// copies and overlays them during a lock-free materialization (see
// projectPartCaptured) with no writeback. Store-wide (not per-session) so
// the token is globally non-repeating: a deleted-then-recreated session can
// never reuse an old in-flight batch's token (the ABA fix). Exactly one bump
// per logical change.
func (s *Store) bumpMsgRev(sid string) {
	s.nextMsgRev++
	s.msgRev[sid] = s.nextMsgRev
}

// captureMessagesBatchLocked builds the wholesale-batch projection for one
// session (the same MessageWithParts {Info, Parts} shape, in sm.order /
// me.partOrder order, that the snapshot serialization uses) and returns it
// together with the current per-session message revision. Caller must hold s.mu.
//
// Every json.RawMessage whose backing bytes escape the lock (me.info and each
// me.parts[pid]) is COPIED. Message/part mutations today REPLACE map values
// (they never mutate a backing array in place), so the copy is defensive; but it
// is required for the -race detector (packaging reads these bytes outside s.mu)
// and bulletproofs any future in-place mutation. Returns a nil list when there
// is no message state (e.g. an empty cold fetch, or the session was deleted
// between reconcile and capture) — the caller treats nil as "nothing to emit".
// The returned list is the BOUNDED recent-window tail (projectMessageWindow),
// not the full transcript: the cold-load messages.batch ships only the initial
// window, and older messages arrive via the historical HTTP page endpoint. The
// returned WindowMeta describes the window (has_older, limits, oversized) so
// packageMessagesBatch can carry it in the outer payload without decompression.
// The revision token is still the FULL-state msgRev[sid] (the bound is pure and
// deterministic, so the revision gate's equality check remains sound).
func (s *Store) captureMessagesBatchLocked(sid string) ([]MessageWithParts, uint64, WindowMeta) {
	sm := s.messages[sid]
	if sm == nil {
		return nil, s.msgRev[sid], WindowMeta{} // defensive: no message state (empty fetch / deleted)
	}
	full := make([]MessageWithParts, 0, len(sm.order))
	for _, mid := range sm.order {
		me := sm.byID[mid]
		if me == nil {
			continue
		}
		parts := make([]json.RawMessage, 0, len(me.partOrder))
		for _, pid := range me.partOrder {
			parts = append(parts, append([]byte(nil), me.parts[pid]...))
		}
		full = append(full, MessageWithParts{
			Info:  append([]byte(nil), me.info...),
			Parts: parts,
		})
	}
	bounded, meta := projectMessageWindow(full, s.windowMaxCount, s.windowMaxBytes)
	return bounded, s.msgRev[sid], meta
}

// packageMessagesBatch performs the APPLICATION-COMPRESSED encoding of a
// captured message projection into a KindMessagesBatch payload. It is PURE: no
// store access, no lock, no s.mu — this is the work that was previously done
// under the write lock (the root cause of the cold-load contention) and now runs
// outside it. Returns nil on any marshal/gzip error (already logged) so the
// caller can skip emitting a malformed batch.
//
// The payload shape (mirroring the SSE snapshot precedent at server.go:1075-1093,
// which also marshals/compresses AFTER returning from the store lock):
//
//	{"sessionID": sid, "encoding":"gzip64", "data":"<base64-gzip>", "window": {...}}
//
// sessionID stays PLAIN TEXT so payloadSessionID (store interest filter) and
// sendable() (web egress filter) keep extracting it — replacing the whole
// payload with a base64 blob would silently drop the batch for Stream-2
// (open-session) subscribers. Only the heavy messages array is compressed:
// "data" is base64( gzip( {"messages":[...]} ) ). base64 is required because
// SSE data: fields are text/UTF-8 and raw gzip bytes are not valid UTF-8.
// Always-compress policy (the batch only fires for cold-loads, which are
// non-trivial by nature, so there is no small-payload case worth a threshold).
//
// "window" carries the WindowMeta ALONGSIDE sessionID/encoding/data so a client
// reads has_older / count / limits WITHOUT decompressing the gzip'd messages
// array (decompression is the expensive step the window is meant to defer).
func packageMessagesBatch(sid string, list []MessageWithParts, window WindowMeta) json.RawMessage {
	if list == nil {
		return nil
	}
	inner, err := json.Marshal(struct {
		Messages []MessageWithParts `json:"messages"`
	}{Messages: list})
	if err != nil {
		// Cannot fail for this well-typed anonymous struct today, but a silent
		// discard would mask a future regression (e.g. a non-marshalable field
		// added to MessageWithParts). Bail rather than emit a malformed batch.
		vhlog.Warn("messages.batch: marshal inner failed", "sessionID", sid, "err", err)
		return nil
	}
	// gzip the inner messages JSON, then base64-encode so the bytes survive
	// SSE's text/UTF-8 data: framing. Default compression level: the batch is
	// only emitted on cold-load, so the marginal CPU is fine and gzip's default
	// (DefaultCompression) gives the best size/speed tradeoff.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	_, _ = gw.Write(inner) // gzip.Writer.Write does not return a meaningful error mid-stream
	if err := gw.Close(); err != nil {
		// gzip.Close flushes the trailer; on failure buf holds an incomplete
		// gzip stream whose base64 would be undecodable on the client. The
		// *bytes.Buffer backing writer cannot fail today, but do not silently
		// swallow a future regression — skip emitting (the client re-fetches on
		// the next cold load) instead of corrupt bytes.
		vhlog.Warn("messages.batch: gzip close failed", "sessionID", sid, "err", err)
		return nil
	}
	payload, err := json.Marshal(struct {
		SessionID string     `json:"sessionID"`
		Encoding  string     `json:"encoding"`
		Data      string     `json:"data"`
		Window    WindowMeta `json:"window"`
	}{SessionID: sid, Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes()), Window: window})
	if err != nil {
		vhlog.Warn("messages.batch: marshal payload failed", "sessionID", sid, "err", err)
		return nil
	}
	return payload
}

// coldBatchAfterCaptureHook is a test-only seam. When non-nil, publishColdBatch
// invokes it AFTER capturing the projection under the lock and releasing the
// lock, BEFORE packaging. A test sets it to block (e.g. on a channel) so it can
// apply a concurrent same-session mutation between capture and publish, then
// assert the stale prepared batch is discarded and the retry emits the newer
// state. Nil in production.
var coldBatchAfterCaptureHook func(sid string)

// ColdBatchStatus is the outcome of a cold-load messages.batch publication
// (publishColdBatch / SetSessionMessages). It makes publication success
// EXPLICIT so the aggregator callers can gate EmitMessagesLoaded correctly:
// messages.loaded must follow a valid messages.batch, and must NOT fire when
// the session disappeared or packaging failed (Finding 3 — without this the
// aggregator UNCONDITIONALLY called EmitMessagesLoaded, so messages.loaded
// could be delivered with no preceding messages.batch, breaking the
// one-batch-before-loaded ordering contract the client relies on).
type ColdBatchStatus int

const (
	// ColdBatchEmitted: a revision-VALID KindMessagesBatch was published. The
	// caller SHOULD follow with EmitMessagesLoaded (one-batch-then-loaded).
	ColdBatchEmitted ColdBatchStatus = iota
	// ColdBatchWarmReconcile: reconcileMessagesLocked ran the WARM path (the
	// session was already loaded — a daemon reconnect), so no wholesale batch
	// is emitted (individual upserts/deletes were emitted inside reconcile).
	// The caller SHOULD follow with EmitMessagesLoaded (the client needs the
	// completion signal to exit the loading state).
	ColdBatchWarmReconcile
	// ColdBatchSessionGone: there was no message state to emit — the session
	// was deleted between reconcile and capture, or the fetch returned an empty
	// result for a now-gone session. The caller MUST NOT call
	// EmitMessagesLoaded: the session is gone, and emitting loaded (or an empty
	// batch to satisfy ordering) would reintroduce state after session.delete.
	ColdBatchSessionGone
	// ColdBatchPackagingFailed: marshal/gzip failed (already logged). No batch
	// was emitted. The caller MUST NOT call EmitMessagesLoaded; the client
	// re-fetches on the next cold load.
	ColdBatchPackagingFailed
)

// publishColdBatch packages and emits a session's cold-load KindMessagesBatch
// with the marshal+gzip+base64 pipeline performed OUTSIDE s.mu, while
// GUARANTEEING a stale prepared batch can never overwrite newer live deltas.
// This is the unlocked-packaging counterpart to reconcileMessagesLocked: that
// mutates under the lock and returns coldLoad=true; the caller then invokes this.
//
// The risk it mitigates: the client treats messages.batch as a WHOLESALE
// REPLACEMENT (stream.ts:201-217). If the projection were captured under the
// lock, the lock released, compressed outside, and then emitted under a NEW
// sequence number, a live part/message delta that landed during compression
// would be OVERWRITTEN by the stale batch on the client. The per-session message
// revision (bumped by every message/part mutation + reconcile) is the staleness
// gate.
//
// Three-phase loop:
//  1. Under s.mu.Lock(): capture the reconciled ordered projection (copying the
//     escaping json.RawMessage bytes) + the current revision; release the lock.
//  2. Outside the lock: marshal {messages:[...]}, gzip, base64, envelope. (This
//     is the work that previously blocked all Apply ingestion for a large
//     transcript.)
//  3. Under s.mu.Lock() again: re-read the revision. If UNCHANGED, the captured
//     projection is still current → emit. If CHANGED, a live mutation (message/
//     part upsert/delete, a buffered part-delta append, or another reconcile)
//     landed during packaging → DISCARD the prepared payload and retry.
//
// Bounded retry with FAIL-SAFE: after maxColdBatchRetries capture/repackage
// cycles all detect a changed revision (a session changing so fast it never
// converges), the last resort repackages ONCE UNDER s.mu so the emitted batch is
// guaranteed current at emit time. This trades a single locked compression (the
// old behavior, for this rare case only) for correctness — it never emits
// knowingly-stale data and never gives up without delivering a valid batch.
//
// Returns a ColdBatchStatus so the caller can gate EmitMessagesLoaded: a loaded
// event is correct ONLY after ColdBatchEmitted (or a genuine warm reconcile
// handled by the caller, ColdBatchWarmReconcile). SessionGone / PackagingFailed
// MUST NOT trigger a loaded event (Finding 3).
func (s *Store) publishColdBatch(sid string) ColdBatchStatus {
	const maxColdBatchRetries = 8
	for attempt := 0; attempt < maxColdBatchRetries; attempt++ {
		s.mu.Lock()
		list, rev, window := s.captureMessagesBatchLocked(sid)
		s.mu.Unlock()

		// Test seam: block here so a test can race a same-session mutation in
		// the gap between capture and validation. Nil in production (zero cost).
		if coldBatchAfterCaptureHook != nil {
			coldBatchAfterCaptureHook(sid)
		}

		if list == nil {
			// No message state (e.g. an empty cold fetch, or the session was
			// deleted between reconcile and capture): nothing to emit. The
			// session is still marked loaded; the client renders an empty
			// transcript. (Matches the old emitMessagesBatchLocked no-op.) The
			// caller must NOT follow with messages.loaded when the session is
			// gone (Finding 3).
			return ColdBatchSessionGone
		}
		payload := packageMessagesBatch(sid, list, window)
		if payload == nil {
			// Marshal/gzip failed (already logged). Do not emit a malformed
			// batch; the client re-fetches on the next cold load.
			return ColdBatchPackagingFailed
		}

		s.mu.Lock()
		unchanged := s.msgRev[sid] == rev
		if unchanged {
			s.emit(KindMessagesBatch, payload)
			s.mu.Unlock()
			return ColdBatchEmitted // delivered a revision-VALID batch
		}
		s.mu.Unlock()
		// Revision changed during packaging → the captured projection is stale.
		// Discard the payload and retry from the current state (bounded by
		// maxColdBatchRetries, then the fail-safe locked repackage below).
	}
	// Pathological fast-changing session: retry never converged. FAIL SAFE by
	// repackaging ONCE under s.mu so the emitted batch is current at emit time
	// (reverting to the old locked-compression behavior for this rare case
	// rather than emitting knowingly-stale data or skipping the batch).
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _, window := s.captureMessagesBatchLocked(sid)
	if list == nil {
		return ColdBatchSessionGone
	}
	payload := packageMessagesBatch(sid, list, window)
	if payload == nil {
		return ColdBatchPackagingFailed
	}
	s.emit(KindMessagesBatch, payload)
	return ColdBatchEmitted
}
