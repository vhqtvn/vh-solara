// Package state: the subscriptions concern — the live-tail publisher / fanout
// surface of the store, mechanically extracted from store.go (reference model:
// snapshots.go, subtree_indexes.go). Every symbol here is part of the reactive
// surface: subscriber registration (Subscribe / SubscribeWith), the emit fanout
// under s.mu (emit / EmitTransient / EmitNotice / EmitMessagesLoaded /
// EmitMessagesError / EmitOrphanCheck / emitOrphanCheckLocked), the interest
// filter (Interest / wants / isMessageClassKind / payloadSessionID) + the
// subscriber type, and teardown (Close). The Store struct and its single s.mu
// RWMutex stay in store.go and are shared across this whole package (same-package
// file split; no protocol change).
//
// emit() preserves the PURE-ATOMICS / no-alloc / no-block invariant for its
// diagnostics because it runs under s.mu on every event (the fanout loop itself
// is byte-for-byte unchanged). Close calls cancelAllGraceLocked (grace concern,
// which stays in store.go) as a same-package cross-file call — the same pattern
// by which descendantsLocked is shared across snapshots.go and store.go.
// Behavior-preserving verbatim move.
package state

import (
	"encoding/json"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// subscriber is one live-tail consumer registration: its buffered channel plus
// the Interest that governs which emitted events are enqueued. Held under s.mu.
type subscriber struct {
	ch       chan ClientEvent
	interest Interest
}

// Interest expresses which events a live-tail subscriber wants, evaluated at
// fanout time so irrelevant high-volume events never enter the subscriber's
// channel. The zero value means "all events" (the historical Subscribe
// behavior): structural, notification, control, AND every message/part event
// for every session.
//
// A non-zero Interest restricts ONLY the message-class events
// (message.*/part.*/messages.*) to the sessions listed in MessageSessions.
// Structural/notification/control events (session.*, activity, status, todo,
// unread.*, activity.verb, permission.*, question.*, notice) are ALWAYS
// delivered — they are the channels an operator must not lose behind a token
// flood. This mirrors the web layer's sendable() priority separation, pushed
// upstream from SSE egress into the store fanout.
//
// MessageSessions == nil means "deliver all message-class events too" (the
// firehose, matching the web layer's ?sessions=all). A non-nil map (including an
// empty one) means "deliver message-class events only for sessions in the set"
// (an empty set drops ALL message-class events — the tree-only Stream 1).
type Interest struct {
	// MessageSessions is the allow-set of session ids for message-class events.
	// nil = all (firehose); non-nil (incl. empty) = only the listed sessions.
	MessageSessions map[string]bool
	// WantsPartDelta (slice 2 of part-append-streaming — see
	// docs/ai/wire-protocols/part-append-streaming.md §3) is the per-connection
	// opt-in for the KindPartAppend suffix wire format, mirroring the web layer's
	// `part_delta=1` query flag (which itself mirrors `z=1`/wantsCompress).
	// When true, the store's part-delta flush path (flushPartDeltasLocked →
	// emitPartAppend) delivers KindPartAppend suffix frames to THIS subscriber
	// for allowlisted top-level fields (text/reasoning); when false (the legacy
	// default), the same flush delivers a synthesized full KindPartUpsert at the
	// same seq. One encoding per connection — never both for the same
	// (part,field). Established once at /vh/stream open.
	WantsPartDelta bool
}

// wants reports whether a subscriber with this interest wants an event of the
// given kind whose payload sessionID is sid ("" when the event is not
// message-class or has no sessionID). It is the SINGLE place that maps an event
// kind to a delivery class, so the kind→class rule is not duplicated across the
// codebase (the web layer's sendable() stays only as a defensive double-check).
func (i Interest) wants(kind, sid string) bool {
	if !IsMessageClassKind(kind) {
		return true // structural/notification/control: always delivered
	}
	if i.MessageSessions == nil {
		return true // firehose: all message-class events
	}
	return sid != "" && i.MessageSessions[sid]
}

// IsMessageClassKind reports whether kind is a message/part/messages event —
// the ONLY kinds subject to per-session interest filtering. Every other kind
// (session.*, activity, status, todo, unread.*, activity.verb, permission.*,
// question.*, notice) is delivered to every subscriber unconditionally. Listed
// by exact Kind constant (not string-prefix matching) so the set is explicit,
// typed, and greppable.
//
// O3 SINGLE SOURCE OF TRUTH: this is the canonical ordinal-counted kind set
// shared between the store's Interest filter (wants, below) and the web
// layer's per-connection delivery ordinal (pkg/web/server.go Stream-2
// stamping). The FE session-stream listener (web/src/sync/session-stream.ts
// registerSessionMessageListeners) registers exactly these kinds; a future
// change to one side MUST update the other.
func IsMessageClassKind(kind string) bool {
	switch kind {
	case KindMessageUpsert, KindMessageDelete,
		KindPartUpsert, KindPartDelete, KindPartAppend,
		KindMessagesLoaded, KindMessagesError,
		KindMessagesBatch:
		return true
	}
	return false
}

// IsTreeCountedKind reports whether kind is a tree-stream ordinal-counted DETAIL
// kind — the kinds the FE tree-stream listener observes AND uses to advance
// treeLastDeliveryOrdinal. It is the Stream-1 mirror of IsMessageClassKind
// (Stream 2): the canonical per-stream classifier the web layer's per-connection
// delivery ordinal gates on.
//
// The set is EXACTLY: web/src/sync/tree-transport.ts TREE_STREAM_KINDS (11 kinds:
// status, activity, activity.verb, lastAgent.set, permission.blocked,
// permission.upsert, permission.delete, question.upsert, question.delete,
// unread.set, unread.clear) PLUS session.upsert / session.delete (2 kinds —
// registered in the separate registerAuxiliaryListeners loop). 13 kinds total.
//
// Kinds NOT listed here reach the tree branch but must NOT advance the ordinal:
//   - KindTodo: consumed by the FE via snapshot + 5s poll (NO live listener —
//     the residual the O3 tree-branch gate closes; an invisible ordinal bump
//     here forced a spurious connect(true) on the next tree event).
//   - KindTreeOrphanCheck: server-internal; its detail frame is suppressed. It
//     MAY still produce tree.op ops (node.facet) — the delivery boundary's
//     hasOps term (not this classifier) advances the ordinal for those.
//
// O3 SINGLE SOURCE OF TRUTH: shared between the store (this classifier) and the
// web layer's per-connection tree delivery ordinal (pkg/web/server.go Stream-1
// stamping, treeEmitter != nil replay + live-tail branches). The FE tree-stream
// listeners (registerTreeStreamListeners TREE_STREAM_KINDS loop +
// registerAuxiliaryListeners session.upsert/delete loop) register exactly these
// kinds AND advance treeLastDeliveryOrdinal for them; a future change to one
// side MUST update the other.
func IsTreeCountedKind(kind string) bool {
	switch kind {
	case KindStatus, KindActivity, KindActivityVerb, KindLastAgentSet,
		KindPermissionBlocked, KindPermissionSet, KindPermissionClear,
		KindQuestionSet, KindQuestionClear,
		KindUnreadSet, KindUnreadClear,
		KindSessionUpsert, KindSessionDelete:
		return true
	}
	return false
}

// payloadSessionID extracts the top-level "sessionID" from a message-class
// event payload (one JSON unmarshal). Returns "" when absent or unparseable;
// callers treat "" as "not in any allow-set" (the event is dropped for filtered
// subscribers), matching the web layer's sendable() semantics.
func payloadSessionID(payload json.RawMessage) string {
	var p struct {
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.SessionID
}

// emit stamps, records, and fans out a client event. Caller must hold s.mu.
//
// Interest filtering is applied HERE (upstream of the channel) so a
// subscriber whose Interest excludes the event never has it enqueued — a slow
// high-volume producer (background subagent token deltas, re-emitted as
// part.upsert) cannot fill a structural-only subscriber's channel and starve it
// of the session.upsert/activity/status events it actually wants. The
// payload's sessionID is resolved ONCE per emit (at most one JSON unmarshal,
// regardless of subscriber count) and only for message-class events.
// Nonblocking fanout is preserved for INCLUDED events: a full channel still
// closes+removes that subscriber, never blocking the producer.
func (s *Store) emit(kind string, payload json.RawMessage) {
	s.seq++
	ev := ClientEvent{Seq: s.seq, Kind: kind, Payload: payload, ingestNano: s.curEmitIngest}
	s.ring.push(ev)
	sid := ""
	if IsMessageClassKind(kind) {
		sid = payloadSessionID(payload)
	}
	// PROBE 2 (latency diagnostics): emit-boundary aggregates. PURE ATOMICS
	// only — no mutex, no channel, no allocation, no blocking — because this
	// runs under s.mu on every event. Records per-class count/bytes (fixed 5
	// classes), per-source count (live/hydrate/daemon — fixed 3), ingest→emit
	// age histogram when an ingest t0 was carried, and subscriber drops (the
	// existing backpressure sentinel — the drop itself is unchanged, only
	// counted). The fan-out loop below is byte-for-byte unchanged.
	//
	// Finding 2: the slow-emit IncidentRing capture was REMOVED from this
	// boundary. The ring's scoped mutex (IncidentRing.mu) and the dynamic
	// "emit_age:"+kind label allocation violated the hard lock-free / no-alloc
	// invariant for code that runs under s.mu. The atomic-CAS EmitAge
	// histogram stays (it is pure atomics) and still attributes slow emits in
	// the aggregate; per-incident detail for this boundary is simply not recorded.
	// Slow-incident capture is retained on the SSE/yamux/ws boundaries (their
	// mutex acquire happens OUTSIDE any held store lock).
	emitMono := diag.MonoNow()
	cls := diag.ClassifyEmitKind(kind)
	diag.Default.Emit.ClassCount[cls].Inc()
	diag.Default.Emit.ClassBytes[cls].Add(uint64(len(payload)))
	diag.Default.Emit.SourceCount[s.curEmitSource].Inc()
	if s.curEmitIngest > 0 {
		age := emitMono - s.curEmitIngest
		if age >= 0 {
			diag.Default.Emit.EmitAge.Observe(age)
		}
	}
	for id, sub := range s.subs {
		if !sub.interest.wants(kind, sid) {
			continue // excluded by interest: never enters this channel
		}
		select {
		case sub.ch <- ev:
		default:
			// Slow consumer: drop it. The client will reconnect and re-snapshot.
			// PROBE 2: count the existing drop (the backpressure sentinel).
			diag.Default.Emit.SubscriberDrops.Inc()
			close(sub.ch)
			delete(s.subs, id)
		}
	}
}

// emitPartAppend (slice 2 of part-append-streaming — see
// docs/ai/wire-protocols/part-append-streaming.md §2/§3) is the per-flush
// dual-fanout for a streaming text field on an opted-in connection. It is the
// O(L²)→O(L) lever: instead of re-emitting the FULL accumulated field text to
// every subscriber every flush (~30ms), it records ONE KindPartAppend SUFFIX
// event in the ring + delivers the suffix to opted-in subscribers and a
// synthesized full KindPartUpsert at the SAME seq to legacy subscribers.
//
// One encoding per connection (spec §3): an opted-in subscriber
// (interest.WantsPartDelta) receives suffixEv; a legacy subscriber receives
// legacyEv. Neither receives both for the same flush. The ring records ONLY the
// suffix event — the legacy upsert is synthesized at fanout time and is NOT
// separately in the ring, so a legacy connection whose replay range contains a
// KindPartAppend falls back to a fresh snapshot (spec §4.3, enforced in the web
// layer's handleStream). Both events share the SAME seq (one seq advance per
// flush), preserving the monotonic global sequence + ring insertion order.
//
// suffixPayload is the {sessionID,messageID,partID,field,start,text} suffix
// frame (delivered to opted-in + recorded in the ring); fullUpsert is the full
// authoritative part JSON (delivered to legacy only). Caller holds s.mu.
func (s *Store) emitPartAppend(suffixPayload, fullUpsert json.RawMessage) {
	s.seq++
	seq := s.seq
	// The suffix event is what opted-in clients replay and what §4.3 detects.
	suffixEv := ClientEvent{Seq: seq, Kind: KindPartAppend, Payload: suffixPayload, ingestNano: s.curEmitIngest}
	s.ring.push(suffixEv)
	// The legacy event shares the SAME seq but is NOT separately in the ring —
	// legacy replay containing a KindPartAppend falls back to snapshot (§4.3).
	legacyEv := ClientEvent{Seq: seq, Kind: KindPartUpsert, Payload: fullUpsert, ingestNano: s.curEmitIngest}
	// part.append carries sessionID, so the interest filter keys on the suffix.
	sid := payloadSessionID(suffixPayload)
	// PROBE 2 (latency diagnostics): emit-boundary aggregates, identical
	// invariant to emit() — PURE ATOMICS only (no mutex/channel/alloc/blocking)
	// because this runs under s.mu on every flush. The bytes accounted here are
	// the CANONICAL suffix bytes (ClassBytes[EmitClassPart] —
	// ClassifyEmitKind("part.append")→EmitClassPart). Per-subscriber WIRE bytes
	// are accounted separately by the SSE StreamStatsWriter probe; the
	// emit-level figure reflects the O(L) ring cost, which is the slice-4
	// success metric (ring bytes no longer scale with accumulated field length).
	emitMono := diag.MonoNow()
	cls := diag.ClassifyEmitKind(KindPartAppend)
	diag.Default.Emit.ClassCount[cls].Inc()
	diag.Default.Emit.ClassBytes[cls].Add(uint64(len(suffixPayload)))
	diag.Default.Emit.SourceCount[s.curEmitSource].Inc()
	if s.curEmitIngest > 0 {
		age := emitMono - s.curEmitIngest
		if age >= 0 {
			diag.Default.Emit.EmitAge.Observe(age)
		}
	}
	for id, sub := range s.subs {
		if !sub.interest.wants(KindPartAppend, sid) {
			continue // excluded by interest: never enters this channel
		}
		// One encoding per connection: opted-in → suffix, legacy → full upsert.
		out := suffixEv
		if !sub.interest.WantsPartDelta {
			out = legacyEv
		}
		select {
		case sub.ch <- out:
		default:
			// Slow consumer: drop it. The client will reconnect and re-snapshot.
			// PROBE 2: count the existing drop (the backpressure sentinel).
			diag.Default.Emit.SubscriberDrops.Inc()
			close(sub.ch)
			delete(s.subs, id)
		}
	}
}

// EmitTransient fans out a transient event of the given kind to live
// subscribers. It is the generic, kind-parameterized form of EmitNotice. Like
// EmitNotice it:
//   - does NOT record to the replay ring (a resuming client never replays it —
//     it catches up via a fresh bootstrap snapshot in the relevant domain);
//   - does NOT advance seq (reuses the current head seq, so resume cursors stay
//     monotonic — no gap, no duplicate-advance);
//   - bypasses the per-subscriber Interest filter (a transient event reaches
//     every LIVE subscriber unconditionally, mirroring EmitNotice — Interest is
//     a message-class flood filter, irrelevant to a worker-wide full-state
//     fan-out).
//
// The caller-supplied kind is carried as ClientEvent.Kind and becomes the SSE
// `event:` name on the wire. Callers that need a REPLAYABLE event must use
// emit() (recorded, seq-stamped) — NOT this. EmitTransient is for full-state,
// transient fan-out where a fresh bootstrap snapshot is the catch-up (e.g. the
// web layer's pins.updated, caught up by the pins.snapshot bootstrap frame on
// reconnect). Safe to call from any goroutine.
func (s *Store) EmitTransient(kind string, payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Finding 4 (generalized from EmitNotice): EmitTransient deliberately
	// bypasses s.emit (it must NOT record to the ring or advance seq — it is
	// transient). But it still reports into Probe 2's atomic class/source
	// counters so transient events are accounted. Class is derived from the
	// kind via ClassifyEmitKind (notice → structural; an unknown kind such as
	// "pins.updated" → EmitClassOther — best-effort, never panics). Source is
	// daemon-generated (the default). PURE ATOMICS only — consistent with the
	// emit() boundary invariant (this runs under s.mu).
	cls := diag.ClassifyEmitKind(kind)
	diag.Default.Emit.ClassCount[cls].Inc()
	diag.Default.Emit.ClassBytes[cls].Add(uint64(len(payload)))
	diag.Default.Emit.SourceCount[diag.SourceDaemonGenerated].Inc()
	// Fan out WITHOUT recording to the ring or advancing seq: a transient
	// event is a live alert, not part of the replayable view. Reusing the
	// current head seq keeps resume cursors monotonic (no gap, no
	// duplicate-advance).
	ev := ClientEvent{Seq: s.seq, Kind: kind, Payload: payload}
	for id, sub := range s.subs {
		select {
		case sub.ch <- ev:
		default:
			// Slow consumer: drop it. PROBE 2: count the existing drop.
			diag.Default.Emit.SubscriberDrops.Inc()
			close(sub.ch)
			delete(s.subs, id)
		}
	}
}

// EmitNotice fans out a transient notice event to live subscribers. Unlike the
// view events, a notice is not recorded into any snapshot — it is delivered only
// to currently-connected clients (resuming clients won't replay it). Safe to
// call from any goroutine.
//
// This is the notice-specific form of the generic EmitTransient (which takes a
// caller-supplied kind): EmitNotice hardcodes KindNotice for the established
// "notice" wire channel. New full-state transient fan-outs that need their OWN
// SSE event name (e.g. the web layer's pins.updated) call EmitTransient with
// their kind, and that kind becomes the SSE `event:` name on the wire (the web
// loop forwards transient events with no `id:` line, so the resume cursor is
// untouched).
func (s *Store) EmitNotice(payload json.RawMessage) {
	s.EmitTransient(KindNotice, payload)
}

// EmitMessagesLoaded fans out a messages.loaded completion event for ONE
// session: the authoritative "this session's full message history has been
// fetched and reconciled" signal. Recorded in the ring (replayable) so it
// composes with the seq-baseline guard like any view event. The aggregator
// emits this after a successful EnsureMessagesAsync fetch — including when the
// fetch returned zero or byte-identical messages, so a connected client never
// wedges on its loading state waiting for a message.* delta that never comes.
//
// fetchMs/reconcileMs split the window the client already measures as `hydrate`
// (first snapshot → this event): fetchMs = the upstream OpenCode GET
// /session/:id/message round-trip; reconcileMs = the daemon-side
// SetSessionMessages (decode + id-level diff + emit). They are carried verbatim
// on the payload so the Servers panel can show where a session-switch stall
// lives without a second probe. Non-negative; the only production caller is the
// aggregator's EnsureMessagesAsync. Safe to call from any goroutine.
func (s *Store) EmitMessagesLoaded(sid string, fetchMs, reconcileMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit(KindMessagesLoaded, rawObj(map[string]interface{}{
		"sessionID":   sid,
		"fetchMs":     fetchMs,
		"reconcileMs": reconcileMs,
	}))
}

// EmitMessagesError fans out a messages.error for ONE session: an on-demand
// hydration fetch failed and the session is NOT marked loaded (a later
// selection / transport reconnect retries). Emitted so a connected client can
// surface the failure instead of wedging on the loading state. Safe to call
// from any goroutine.
func (s *Store) EmitMessagesError(sid string, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit(KindMessagesError, rawObj(map[string]interface{}{"sessionID": sid, "error": errMsg}))
}

// EmitOrphanCheck emits a KindTreeOrphanCheck event for each id (Phase 2 §9.2),
// prompting the tree emitter to recompute the orphan facet and emit a
// node.facet{flags:{orphan}} for each known connection node whose status
// changed. Used by the archive handler after archive/un-archive (when a root's
// archive state flips and descendants may become/clear orphan). Under the
// cascade-delete model, descendants are already gone after archive → this is a
// no-op for the archive path, but correct for the unarchive path where
// descendants re-enter via Rehydrate and for any future archive-keep path.
func (s *Store) EmitOrphanCheck(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emitOrphanCheckLocked(ids)
}

// emitOrphanCheckLocked is the locked variant. Caller holds s.mu (write).
func (s *Store) emitOrphanCheckLocked(ids []string) {
	for _, id := range ids {
		s.emit(KindTreeOrphanCheck, rawObj(map[string]interface{}{"id": id}))
	}
}

// Subscribe registers a live-tail consumer that receives ALL events (the zero
// Interest). Returns the channel and an unsubscribe func. The channel is closed
// if the consumer falls too far behind (nonblocking fanout is preserved).
//
// Backward-compatible entry point: internal consumers that need every event
// (the alerts engine) and existing tests use it unchanged. Use SubscribeWith to
// restrict message-class events to a session allow-set.
func (s *Store) Subscribe(buffer int) (<-chan ClientEvent, func()) {
	return s.SubscribeWith(buffer, Interest{})
}

// SubscribeWith registers a live-tail consumer whose Interest is applied AT
// FANOUT: events the interest excludes never enter the channel, so a slow
// high-volume producer (e.g. a background subagent's token-delta flood, which
// the store re-emits as part.upsert events) cannot fill a structural-only
// subscriber's channel and starve it of the session.upsert/activity/status
// events it actually wants. The nonblocking guarantee is preserved for included
// events — a full channel still closes+removes the subscriber, never blocking
// the producer. See Interest for the kind→class mapping.
func (s *Store) SubscribeWith(buffer int, interest Interest) (<-chan ClientEvent, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.next
	s.next++
	sub := &subscriber{ch: make(chan ClientEvent, buffer), interest: interest}
	s.subs[id] = sub
	return sub.ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if cur, ok := s.subs[id]; ok {
			close(cur.ch)
			delete(s.subs, id)
		}
	}
}

// Close tears down all live subscribers: each subscriber's channel is closed
// and dropped from the registry. This forces downstream SSE handleStream loops
// (which range over their subscriber channel) to exit cleanly so the browser
// reconnects and re-snapshots against a freshly-built aggregator. It is the
// teardown half of a project reload: after the aggregator's Run context is
// cancelled, Close severs any in-flight client streams for the old store.
//
// Safe to call from any goroutine; idempotent (closing an already-closed set is
// a no-op because the map is cleared under s.mu). New subscribers registered
// after Close get a fresh, open channel — Close is one-shot, not sticky.
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Stop every pending completion-grace timer so no callback fires after
	// teardown against a torn-down store.
	s.cancelAllGraceLocked()
	// P7: stop every pending stop-settle timer for the same reason.
	s.cancelAllStopTimersLocked()
	for id, sub := range s.subs {
		close(sub.ch)
		delete(s.subs, id)
	}
}
