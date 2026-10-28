package web

// SSE stream orchestration, moved verbatim from server.go (slice 13 of the
// server.go split): the stream class label (streamClassLabel), the part
// window-filter key (partWindowKey), the jittered SSE retry-hint constants
// (sseRetryBaseMs, sseRetryJitterMs, sseRetryHintMs), and the /vh/stream
// handler itself (handleStream: subscribe-before-baseline, replay vs fresh
// snapshot branches, per-stream delivery ordinals, transient no-ID frames,
// ticker pacing, and the pins/labels/archive-failures bootstrap fanout).
// Byte-for-byte move — sequencing, cursor precedence, and frame emission are
// unchanged; only the declarations moved.

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// streamClassLabel — short human label for the /vh/stream class used by the
// VH_DEBUG "stream baseline" lines (Slice 1 webperf build1). Mirrors
// diagnostics.ClassifyStream's int space.
func streamClassLabel(class int) string {
	switch class {
	case diag.StreamClassTree:
		return "tree"
	case diag.StreamClassSelected:
		return "selected"
	default:
		return "firehose"
	}
}

// partWindowKey extracts the (sessionID, messageID) parent key from a
// part-class event payload. All part payloads carry both ids at the top level
// (part.upsert = the raw part envelope; part.append / part.delete reducer
// payloads). ok is false when the payload is unparseable or lacks either id —
// the sendable window filter treats that as NOT eligible for dropping
// (conservative pass-through; never drop what cannot be attributed).
func partWindowKey(payload []byte) (sid, mid string, ok bool) {
	var p struct {
		SessionID string `json:"sessionID"`
		MessageID string `json:"messageID"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return "", "", false
	}
	if p.SessionID == "" || p.MessageID == "" {
		return "", "", false
	}
	return p.SessionID, p.MessageID, true
}

// SSE retry-hint bounds (F3, remote-latency brief 2026-10-12). The hello
// frame advertises base + uniform per-connection jitter so a fleet of panes
// reconnecting after a drop spreads its attempts across [base, base+jitter)
// instead of retrying in lockstep every base ms (measured: 2,254 useless
// controller-side tunnel-down rejections, 11.3% of stream opens). Kept LOW on
// purpose: this hint also governs healthy blip recovery (daemon restart), and
// the heavy damping for sustained outages lives client-side (the SPA's
// CONNECTING-streak takeover onto its bounded manual backoff).
const (
	sseRetryBaseMs   = 2000
	sseRetryJitterMs = 1000
)

// sseRetryHintMs returns the per-connection SSE retry hint: base + jitter.
func sseRetryHintMs() int {
	return sseRetryBaseMs + rand.Intn(sseRetryJitterMs)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// PROBE 3 (latency diagnostics): wrap the ResponseWriter with a
	// counting/timing writer that preserves http.Flusher. Per-class (tree /
	// selected-session / firehose — NOT per-session-id) aggregates feed the
	// bounded diagnostics registry: bytes, writes, write/flush duration,
	// inter-arrival gap, ping duration, snapshot-vs-replay path, and
	// disconnect reason. IMPORTANT CAVEAT: a successful Write here only means
	// bytes reached local TCP buffering; correlate with yamux (Probe 4),
	// tunnel ws (Probe 5), and controller io.Copy (Probe 6) for full
	// attribution. The wrapper adds pure-atomic overhead on Write/Flush and a
	// scoped-mutex IncidentRing push ONLY when a slow threshold is crossed.
	streamClass := diag.ClassifyStream(messageFilter(r))
	sw := diag.NewStreamStatsWriter(w, streamClass)
	w = sw
	flusher = sw // route Flush through the probe (sw implements http.Flusher)
	sw.RecordOpen()
	var discReason int = diag.DiscRequestCtxClosed // default: browser closed
	defer func() { sw.RecordDisconnect(discReason) }()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	h.Set("Connection", "keep-alive")

	// Honest conn: flush a no-op SSE comment IMMEDIATELY so the client's onopen
	// fires at handler entry (Go sends response headers on the first Write/Flush;
	// without this, onopen is delayed until the trailing snapshot flush, so ALL
	// pre-flush work — including Snapshot compute — is silently charged to the
	// client's `conn` measurement and `server/snap` reads ~0ms). The comment line
	// is ignored by EventSource (a `:`-prefixed line per the SSE spec) but it
	// forces the headers out, making `conn` transport-only (DNS/TCP/tunnel-
	// setup/slot-queuing) and letting subsequent server compute show up honestly
	// in `server/snap`. Do NOT move/remove the existing snapshot flush below.
	//
	// SSE retry hint: tells the browser's native EventSource auto-reconnect (the
	// CONNECTING state on a transient drop) to wait before reconnecting. This
	// is what lets a session stream (Stream2) absorb a transient tunnel blip via
	// native auto-reconnect — which sends Last-Event-ID → the server's replay
	// branch → missed deltas are caught up WITHOUT a fresh snapshot. A fatal
	// CLOSED (non-retryable) still falls to the client's manual retry path,
	// which passes cursor= explicitly. The hint is harmless for Stream1 in the
	// transient case (its onerror lets the native CONNECTING retry run; only a
	// sustained CONNECTING streak or a CLOSED gives up into the manual path).
	//
	// F3 (remote-latency brief, 2026-10-12): the retry is now JITTERED
	// per connection. The fixed 2000 made every pane's EventSource retry in
	// lockstep during tunnel-down windows — 2,254 controller-side rejections
	// (11.3% of stream opens) in a ~2.9h snapshot, each a useless instant 502.
	// Jitter de-synchronizes the fleet (attempt spread over [2s, 3s)); the SPA
	// side additionally takes over a looping CONNECTING streak after 3 failures
	// and moves it onto its bounded manual backoff (web/src/sync/{tree-transport,
	// session-stream}.ts), which caps the native infinite loop. Deliberately NOT
	// escalated server-side: a tunnel-down storm never reaches this handler (the
	// controller 502s first), so per-key failure state here would add shared
	// mutable state without damping the measured storm.
	fmt.Fprintf(w, ": hello\nretry: %d\n\n", sseRetryHintMs())
	flusher.Flush()

	// Prefer the Last-Event-ID header (sent automatically by EventSource on
	// reconnect) over the cursor query param. Both may be compound
	// ("globalSeq.ordinal") or legacy numeric — parseResumeCursor extracts the
	// global seq for store.Replay, discarding the connection-local ordinal.
	cursorStr := r.Header.Get("Last-Event-ID")
	if cursorStr == "" {
		cursorStr = r.URL.Query().Get("cursor")
	}
	cursor, hasCursor := parseResumeCursor(cursorStr)

	agg := s.aggFor(reqDir(r))
	store := agg.Store()

	// Priority separation: high-volume message/part events are streamed ONLY for
	// the subscribed sessions (the active session via ?sessions=); structural
	// (session/activity/status) and notification (permission/question) events are
	// ALWAYS streamed. This keeps the important channels — sessions list, open
	// session, notifications — flowing even when a busy project floods the feed
	// with background subagent token-deltas. ?sessions=all opts back into the
	// full firehose.
	filter := messageFilter(r)
	filter = s.projectScopedFilter(agg, filter)
	sendable := func(kind string, payload []byte) bool {
		// Window filter (2026-08-20 stale-rows follow-up): part-class
		// re-publications (compaction prune re-publishing old completed TOOL
		// parts — decision O1 in docs/ai/wire-protocols/compaction-burst-axis.md
		// — and warm full-history reconcile diffs) for messages OUTSIDE the
		// client snapshot window are dropped at egress. The FE already holds
		// such events as keyless shadows (never rendered, never ordered;
		// 281a2f2 + bcc578c), so this is a bandwidth/CPU optimization only:
		//   - message-class events pass UNCHANGED even for out-of-window
		//     parents (cold clients converge via snapshot + message events);
		//   - the filter applies to the firehose (filter == nil) too, since
		//     every client shadows out-of-window parts identically;
		//   - drops happen BEFORE the delivery ordinal increments, so no O3
		//     ordinal gap is created;
		//   - residual: any client-held row outside the server's CURRENT
		//     window — a load-older'd row, or a stale pre-reconnect snapshot
		//     whose rows have since slid out — misses in-place part updates,
		//     as does a cursor-replaying client whose drops are judged against
		//     the window at DELIVERY time; all converge on the next page fetch
		//     or fresh snapshot (pages carry current full parts).
		if strings.HasPrefix(kind, "part.") {
			if sid, mid, ok := partWindowKey(payload); ok && !store.MessageInWindow(sid, mid) {
				return false
			}
		}
		if filter == nil { // "all"
			return true
		}
		if !strings.HasPrefix(kind, "message.") && !strings.HasPrefix(kind, "part.") && !strings.HasPrefix(kind, "messages.") {
			return true // structural + notifications: always
		}
		var p struct {
			SessionID string `json:"sessionID"`
		}
		_ = json.Unmarshal(payload, &p)
		return p.SessionID != "" && filter[p.SessionID]
	}

	// Subscribe before resolving the resume baseline so no event slips through
	// the gap between snapshot/replay and the live tail.
	//
	// Push the interest filter UPSTREAM into the store subscription: irrelevant
	// token-delta floods (re-emitted by the store as part.upsert) never enter
	// this stream's channel. Before this, a structural-only tree stream's 256-slot
	// channel could fill with background message/part events it discards at the
	// egress sendable() check below, queueing a trailing session.upsert behind
	// them ("session appeared late"). The downstream sendable() stays as a
	// DEFENSIVE compatibility check (do not remove); the important guarantee is
	// that excluded events never enter the channel. filter == nil (?sessions=all)
	// → firehose Interest; a non-nil filter (incl. empty, the tree-only Stream 1)
	// → message-class events restricted to the selected sessions.
	interest := state.Interest{MessageSessions: filter}
	// Slice 2 (part-append-streaming — spec §3): thread the per-connection
	// part_delta=1 opt-in into the store subscription so the part-delta flush
	// path (flushPartDeltasLocked → emitPartAppend) knows whether to deliver
	// KindPartAppend suffixes (opted-in) or synthesized full part.upsert
	// (legacy) for allowlisted text/reasoning fields. One encoding per
	// connection, established once here at stream open.
	interest.WantsPartDelta = wantsPartDelta(r)
	ch, unsub := store.SubscribeWith(256, interest)
	defer unsub()

	var baseline uint64

	// Phase 2 tree=2: per-connection emitter for the server-owned session tree.
	// Non-nil only when wantsTree2(r). Created once and reused for the replay,
	// reconnect-snapshot, and live-tail Translate paths below (carries E_c + seq).
	var treeEmitter *state.TreeEmitter
	if wantsTree2(r) {
		treeEmitter = state.NewTreeEmitter(store, reqDir(r))
	}

	// O3: per-connection delivery ordinal for Inv1 gap detection. Incremented
	// ONLY for Inv1-relevant logical source events that the FE observes on the
	// given stream:
	//   - tree stream (treeEmitter != nil): tree.op ops (hasOps) OR tree-counted
	//     detail kinds (state.IsTreeCountedKind — TREE_STREAM_KINDS +
	//     session.upsert/delete). Non-counted detail kinds (todo) emit via
	//     writeRawNoID — they do NOT advance the ordinal because the FE has NO
	//     live listener for them (todo is consumed via snapshot + 5s poll).
	//     Snapshots (tree.snapshot/snapshot.complete) carry ordinal 0 and are
	//     NOT gap-checked.
	//   - session/firehose stream (treeEmitter == nil): message-class events
	//     (state.IsMessageClassKind) + the initial snapshot. Structural frames
	//     (status/activity/...) are emitted via writeRawNoID — they do NOT
	//     advance the ordinal because the FE session-stream listener registers
	//     NO structural listener (it consumes structural via the tree stream).
	// A gap in this ordinal is DIRECTLY actionable as real loss. The ordinal
	// resets on every fresh connection (it is NOT part of the resume cursor);
	// global resume still replays from the global seq component.
	var ordinal uint64

	events, head, replayOK := store.Replay(cursor)
	// PWA warm-resume fallback attribution (2026-10-28 diagnostics card): the
	// fresh branch has THREE distinct causes that the journal line previously
	// conflated (and that partial.ringGap on the wire STILL conflates — its
	// semantics are deliberately unchanged here). replayOKAtEntry + the scan
	// below disambiguate them for the JOURNAL only:
	//   cursorless             — the client had no cursor (first open / fresh request).
	//   ring_eviction          — store.Replay itself said !ok (cursor older than
	//                            the retained ring window): events were missed.
	//   compatibility_fallback — Replay was ok but the §4.3 scan below flipped
	//                            replayOK (a part.append suffix sits in the
	//                            replay range of a non-opted-in connection): a
	//                            fresh snapshot is served despite NO events
	//                            being missed — the S0 gate-(d) discriminator.
	//   none                   — the replay branch served the cursor normally.
	replayOKAtEntry := replayOK
	// partAppendInRange: does the replay range contain a KindPartAppend? Now
	// scanned for opted-in connections too (logging-only; the flip below still
	// applies ONLY to non-opted-in, byte-for-byte the previous control flow).
	partAppendInRange := false
	// Slice 2 (part-append-streaming — spec §4.3): a LEGACY (non-opted-in)
	// connection whose replay range contains a KindPartAppend must NOT interpret
	// those suffix frames — it would lose the full-text reference a legacy
	// client needs. Detect "replay range contains a kind the client did not
	// negotiate" and fall back to a fresh snapshot (the legacy client's
	// catch-up path) by clearing replayOK. Opted-in clients replay
	// KindPartAppend normally (the suffix is their negotiated format). This is
	// the no-mixed-repair invariant from spec §4: legacy never sees part.append
	// on the wire, live OR replay.
	//
	// Slice 7 metric hygiene: do NOT increment Stream2ReplayFallback here.
	// Flipping replayOK=false routes this connection into the snapshot branch
	// below, where the single PROBE 8 increment (the `hasCursor && !replayOK`
	// site) records the fallback ONCE for BOTH fallback reasons (ring-gap
	// cursor-too-old AND this §4.3 suffix-in-legacy-replay case). Incrementing
	// here too double-counted a single §4.3 fallback (once here, once at the
	// unified site). This is a METRIC-only change: replayOK still flips, so the
	// connection still takes the snapshot path exactly as before.
	if hasCursor && replayOK {
		for _, ev := range events {
			if ev.Kind == state.KindPartAppend {
				partAppendInRange = true
				if !wantsPartDelta(r) {
					replayOK = false
				}
				break
			}
		}
	}
	fallbackReason := "none"
	if hasCursor && !replayOK {
		if replayOKAtEntry {
			fallbackReason = "compatibility_fallback"
		} else {
			fallbackReason = "ring_eviction"
		}
	} else if !hasCursor {
		fallbackReason = "cursorless"
	}
	if hasCursor && replayOK {
		for _, ev := range events {
			if sendable(ev.Kind, ev.Payload) {
				if treeEmitter != nil {
					// tree=2 replay (L-14/M5): Prepare → checked deliver → (on
					// success) the legacy detail frame. Prepare leaves committed
					// cache state unchanged; deliverTreeOps commits only after a
					// full checked write. Any failure aborts the replay response
					// (the connection terminates) so a dropped/partial frame
					// cannot poison the emitter's cache. The SSE id
					// (Last-Event-ID) uses ev.Seq (STORE seq) — NOT op.Seq()
					// (emitter seq) — so store.Replay(cursor) works in the same
					// number space on the next reconnect (§5.5).
					//
					// O3 (T1C-F1, Stream-1 gate): the ordinal advances ONLY when
					// the FE observes at least one frame for this event — i.e.
					//   counted = hasOps (FE tree.op listener) OR
					//             state.IsTreeCountedKind(ev.Kind) (FE detail
					//             listener: TREE_STREAM_KINDS + session.upsert/
					//             delete).
					// tree.orphan's detail frame is always suppressed, but its
					// tree.op ops (when produced) are observed → counted via
					// hasOps. Non-counted kinds with no ops (todo — consumed by
					// the FE via snapshot+poll, NO live listener) are STILL
					// EMITTED but via writeRawNoID: no ordinal advance, no id
					// line, so they don't create an invisible ordinal gap that
					// spurious-reconnects the FE (checkTreeOrdinalGap). This is
					// the Stream-1 mirror of the Stream-2 IsMessageClassKind
					// gate below; IsTreeCountedKind is the single source of
					// truth (see its doc comment + the FE TREE_STREAM_KINDS const).
					prepared, err := treeEmitter.Prepare(ev)
					if err != nil {
						vhlog.Warn("tree=2 replay: prepare failed, aborting stream", "seq", ev.Seq, "err", err)
						return
					}
					hasOps := prepared != nil && len(prepared.Ops) > 0
					if hasOps || state.IsTreeCountedKind(ev.Kind) {
						ordinal++
						id := compoundSSEID(ev.Seq, ordinal)
						if hasOps {
							if err := deliverTreeOps(w, treeEmitter, prepared, id); err != nil {
								vhlog.Warn("tree=2 replay: delivery failed, aborting stream", "seq", ev.Seq, "err", err)
								return
							}
						}
						// Phase 3 Step A.5 (GAP 3): emit the legacy detail frame
						// alongside tree.op so cross-session detail consumers stay
						// populated. tree.orphan is server-internal (translated to
						// node.facet above; no client detail listener) — skip it.
						if ev.Kind != state.KindTreeOrphanCheck {
							writeEvent(w, id, ev.Kind, ev.Payload)
						}
					} else {
						// Non-counted detail frame (todo): still deliver to the
						// client but WITHOUT advancing the ordinal / stamping an
						// id (the FE has no live listener that advances
						// treeLastDeliveryOrdinal for it). tree.orphan with no ops
						// falls here too and is skipped (no detail frame).
						if ev.Kind != state.KindTreeOrphanCheck {
							writeRawNoID(w, ev.Kind, ev.Payload)
						}
					}
				} else {
					// O3 Finding 1: Stream-2 (session/firehose, treeEmitter==nil)
					// ordinal alignment. The ordinal advances ONLY for message-
					// class events — the kinds the FE session-stream listener
					// registers for (snapshot + the 7 message/part/messages
					// kinds). Structural frames (status/activity/unread/
					// permission/question/session.upsert) are still EMITTED but
					// WITHOUT advancing the ordinal: the FE has NO listener for
					// them on Stream 2 (it consumes structural via the tree
					// stream), so an ordinal bump here would be invisible and
					// force a spurious resync on the next message event
					// (checkSesOrdinalGap sees ordinal > expected).
					//
					// SINGLE SOURCE OF TRUTH: state.IsMessageClassKind is the
					// canonical classifier, shared with the store's Interest
					// filter. web/src/sync/session-stream.ts
					// registerSessionMessageListeners registers exactly these
					// kinds; keep both sides in sync.
					//
					// writeRawNoID emits the structural frame with NO id line
					// so it neither advances the ordinal nor moves the client's
					// Last-Event-ID resume cursor (structural events on Stream 2
					// are not tracked by sesCursor — the FE ignores them).
					if state.IsMessageClassKind(ev.Kind) {
						ordinal++
						writeEvent(w, compoundSSEID(ev.Seq, ordinal), ev.Kind, ev.Payload)
					} else {
						writeRawNoID(w, ev.Kind, ev.Payload)
					}
				}
			}
		}
		baseline = head
		sw.RecordReplayPath() // PROBE 3: cursor-replay baseline branch
		// Slice 1 (webperf build1) + PWA warm-resume attribution (2026-10-28):
		// the stream-baseline journal line distinguishing the cursor-replay
		// baseline branch from the fresh-snapshot branch. Now ALWAYS-ON (one
		// Info line per stream open — negligible) and carrying
		// fallback_reason/part_append_in_range so worker logs alone can
		// attribute every fresh fallback without VH_DEBUG and correlate
		// against the client stream-open diag records (ts join ±100 ms).
		vhlog.Info("stream baseline",
			"path", "replay",
			"class", streamClassLabel(streamClass),
			"fallback_reason", fallbackReason,
			"part_append_in_range", partAppendInRange,
			"cursor", cursor,
			"replayed", len(events),
			"head", head)
		// Phase 3 Step B (C-F1): tree=2 resume/reconnect must ALSO bootstrap
		// the full session-detail snapshot and re-seed the tree frontier,
		// mirroring the fresh-connect path (GAP 3, committed 3903b131). The
		// tree flat map is NEVER persisted (§11) and detail maps are not
		// persisted, so a client reconnecting with a valid cursor but EMPTY
		// in-memory detail (e.g. native EventSource auto-reconnect after a
		// page reload, or any path that resumes with a valid cursor) would
		// otherwise receive only ring deltas — leaving structure + detail
		// unpopulated. Emit tree.snapshot (frontier re-seed, cause "reconnect")
		// + the raw legacy detail snapshot AFTER the replayed deltas so both
		// projections flow on every tree=2 connect path (fresh, replay,
		// ring-gap). The replayed tree.op/detail events above (seq N+1..head)
		// are superseded by these authoritative snapshots at head; the live-tail
		// baseline guard (ev.Seq > baseline) prevents re-forwarding. Mirrors the
		// fresh-connect block below. Under tree=2 this reconnect block
		// runs whenever a treeEmitter is attached (the `if treeEmitter != nil`
		// guard below); the proj=1 reconnect snapshot that earlier revisions
		// gated on wantsProject(r) was deleted in Phase 4 (commit a0e825c), so
		// there is no proj=1 path here.
		if treeEmitter != nil {
			// Q5 capture consolidation: ONE store WRITE-lock span (the B-F1
			// buffered-delta flush + capture inside SnapshotWithTree/Partial)
			// derives BOTH the tree frontier and the detail snapshot with the
			// SAME {epoch, seq}, so the two projections can no longer diverge
			// across an interleaving writer (the false-confidence failure that
			// blocked a truthworthy completion signal). baseline is the captured
			// seq (tree.Seq == detail.Seq), dropping the third store.Head() lock.
			// Slice-A D7: tree-only reconnect (sessions absent → filter={}) ships a
			// FRONTIER-SCOPED partial detail (global Q/P/unread + frontier
			// sessions/gate/activity/lastAgents/currentVerbs; messages omitted).
			// Session-selected/firehose reconnect keeps the full capture. Both
			// paths share ONE write-lock capture + {epoch,seq} with the tree
			// projection.
			var detailSnap state.Snapshot
			var treeSnap *state.TreeSnapshot
			if filter != nil && len(filter) == 0 {
				detailSnap, treeSnap = store.SnapshotWithTreePartial(treeEmitter, "reconnect")
			} else {
				detailSnap, treeSnap = store.SnapshotWithTree(treeEmitter, filter, "reconnect")
			}
			treeOK := false
			if rb, err := json.Marshal(treeSnap); err == nil {
				wire := maybeCompressSnapshot(rb, wantsCompress(r))
				writeRaw(w, compoundSSEID(treeSnap.Seq, 0), "tree.snapshot", wire)
				sw.RecordSnapshotPath(len(wire))
				treeOK = true
			} else {
				vhlog.Warn("tree=2 resume tree.snapshot: marshal failed", "err", err)
			}
			// Legacy detail snapshot, shipped RAW (not gzip64) so it does NOT
			// race tree.snapshot's async gzip64 decode on the client's shared
			// treeSnapshotDecoding flag (same rationale as fresh-connect).
			detailOK := false
			if db, err := json.Marshal(detailSnap); err == nil {
				writeRaw(w, compoundSSEID(detailSnap.Seq, 0), "snapshot", db)
				detailOK = true
			} else {
				vhlog.Warn("tree=2 resume detail snapshot: marshal failed", "err", err)
			}
			// Q5 completion signal: emitted ONLY when BOTH projections marshaled
			// and were handed to (unchecked) writeRaw — the contract is "both
			// projections of this capture were sent"; write errors on these
			// frames are undetected (only the tree.op path via deliverTreeOps
			// is write-checked). A marshal failure skips a projection, so the
			// boundary must NOT fire (no false atomicity claim).
			if treeOK && detailOK {
				writeSnapshotComplete(w, treeSnap.Epoch, treeSnap.Seq, compoundSSEID(treeSnap.Seq, 0))
			}
			baseline = treeSnap.Seq
		}
	} else {
		// Fresh client or cursor too old: send a full snapshot, then live-tail.
		// PROBE 8: when the client HAD a cursor but the shared replay ring
		// evicted it (hasCursor && !replayOK), this is a silent fallback to a
		// fresh snapshot — the exact signal that reveals whether the single
		// 4096-event shared ring is evicting Stream2 cursors under multi-
		// session load (the deferred per-session-ring finding).
		if hasCursor && !replayOK {
			diag.IncStream2ReplayFallback()
		}
		// Slice 1 (webperf build1) + PWA warm-resume attribution (2026-10-28):
		// the fresh-snapshot twin of the replay branch's "stream baseline"
		// journal line — always-on (one Info line per stream open) and now
		// carrying fallback_reason, the discriminator the S0 gate-(d) analysis
		// identified as missing: ring_eviction (real gap) vs
		// compatibility_fallback (§4.3 part.append in a legacy replay range, NO
		// events missed) vs cursorless (no resume cursor at all). The wire
		// partial.ringGap stamp is deliberately UNCHANGED (it still conflates
		// both fallback causes; fixing its semantics is a separate card).
		vhlog.Info("stream baseline",
			"path", "fresh",
			"class", streamClassLabel(streamClass),
			"fallback_reason", fallbackReason,
			"part_append_in_range", partAppendInRange,
			"had_cursor", hasCursor,
			"cursor", cursor,
			"head", head)
		// NON-BLOCKING hydration: kick the upstream fetch off in the background
		// (EnsureMessagesAsync) so the snapshot sends immediately, then forward
		// message.*/part.* deltas + messages.loaded over this same connection as
		// the fetch reconciles. Subscribe-before-trigger is preserved (we
		// subscribed above) so no completion event slips through the gap.
		s.triggerMessageLoad(agg, filter)
		if wantsTree2(r) {
			// Phase 2 tree=2: emit a frontier snapshot (roots + active-path +
			// direct-children-of-loaded placeholders) instead of the legacy
			// wholesale/projected snapshot. treeEmitter was created above.
			// When the client HAD a cursor but the ring evicted it
			// (hasCursor && !replayOK), this is a ring-gap reconnect → cause
			// "reconnect" so the client knows to wholesale-replace its tree
			// (§5.5). A fresh client (no cursor) gets cause "initial".
			cause := "initial"
			if hasCursor && !replayOK {
				cause = "reconnect"
			}
			// Q5 capture consolidation: ONE store WRITE-lock span (the B-F1
			// buffered-delta flush + capture inside SnapshotWithTree/Partial)
			// derives BOTH the tree frontier and the detail snapshot with the
			// SAME {epoch, seq} — the hard prerequisite for the truthworthy
			// completion signal. baseline is the captured seq (tree.Seq ==
			// detail.Seq), dropping the third store.Head() lock.
			// Slice-A D7: tree-only cold/ring-gap (sessions absent → filter={})
			// ships the frontier-scoped partial detail (see reconnect-site comment
			// above). Session-selected/firehose keeps the full capture.
			var detailSnap state.Snapshot
			var treeSnap *state.TreeSnapshot
			if filter != nil && len(filter) == 0 {
				detailSnap, treeSnap = store.SnapshotWithTreePartial(treeEmitter, cause)
				// D1: stamp the ring-gap signal ONLY when the cursor existed but the
				// shared ring evicted it (hasCursor && !replayOK) — the missed deltas
				// were lost, so the client mechanically invalidates buried detail not
				// in scope. A fresh (no-cursor) connect leaves it false.
				if detailSnap.Partial != nil && hasCursor && !replayOK {
					detailSnap.Partial.RingGap = true
				}
			} else {
				detailSnap, treeSnap = store.SnapshotWithTree(treeEmitter, filter, cause)
			}
			treeOK := false
			if rb, err := json.Marshal(treeSnap); err == nil {
				wire := maybeCompressSnapshot(rb, wantsCompress(r))
				writeRaw(w, compoundSSEID(treeSnap.Seq, 0), "tree.snapshot", wire)
				sw.RecordSnapshotPath(len(wire))
				treeOK = true
			} else {
				vhlog.Warn("tree snapshot: marshal failed", "err", err)
			}
			// Phase 3 Step A.5 (GAP 3): ALSO emit a legacy detail snapshot to
			// bootstrap the client's detail maps (state.sessions/permissions/
			// questions/todos/lastAgents/currentVerbs/unread). tree=2 replaces
			// the STRUCTURE projection only; session-detail is orthogonal (§10).
			// The legacy snapshot for a tree-only Stream 1 client (filter={}
			// from sessions=) carries all sessions' detail but NO messages
			// (Snapshot skips messages when messagesFor is non-nil and empty).
			// Shipped RAW (not gzip64) so it does NOT race the tree.snapshot's
			// gzip64 decode on the shared treeSnapshotDecoding flag — the legacy
			// snapshot listener runs synchronously while tree.snapshot's async
			// decode proceeds in parallel; both populate different stores
			// (state.sessions vs treeMap) so there is no clobber.
			detailOK := false
			if db, err := json.Marshal(detailSnap); err == nil {
				writeRaw(w, compoundSSEID(detailSnap.Seq, 0), "snapshot", db)
				detailOK = true
			} else {
				vhlog.Warn("tree=2 detail snapshot: marshal failed", "err", err)
			}
			// Q5 completion signal: emitted ONLY when BOTH projections marshaled
			// and were handed to (unchecked) writeRaw — the contract is "both
			// projections of this capture were sent"; write errors on these
			// frames are undetected (only the tree.op path via deliverTreeOps
			// is write-checked). A marshal failure skips a projection, so the
			// boundary must NOT fire (no false atomicity claim).
			if treeOK && detailOK {
				writeSnapshotComplete(w, treeSnap.Epoch, treeSnap.Seq, compoundSSEID(treeSnap.Seq, 0))
			}
			baseline = treeSnap.Seq
		} else {
			// Legacy (non-tree) clients: send the full wholesale snapshot.
			snap := store.Snapshot(filter)
			b, err := json.Marshal(snap)
			if err != nil {
				// Cannot fail for a well-typed *state.Snapshot today; log and skip
				// the malformed snapshot write rather than emitting a nil/"null"
				// frame. baseline still advances to snap.Seq so the live tail does
				// not replay events already covered by the (would-be) snapshot.
				vhlog.Warn("stream snapshot: marshal failed, skipping snapshot write", "err", err)
			} else {
				// gzip64-wrap the snapshot when the client opted in (z=1) AND it is large
				// enough to benefit (a warm open of a loaded session — the megabyte-scale
				// transcript inlined at snap.Messages[sid]). Small/cold/messageless
				// snapshots fall under the threshold and ship raw. The envelope mirrors
				// the cold-load messages.batch gzip64 shape so the client decodes via the
				// same path; this is what cuts a warm open's end-to-end `snap` transport
				// ~3.4x (the controller tunnel does not compress at any lower layer).
				// Phase 3-D: record true wire bytes (was len(b), the pre-compression
				// marshaled length — overstated ~3x). snapshot_bytes now reflects the
				// actual bytes written, keeping the diag self-consistent with Phase-1
				// per-path wire counters.
				// O3: the snapshot IS Inv1-relevant for the session stream (the FE's
				// sesLastDeliveryOrdinal advances for it), so increment the ordinal.
				ordinal++
				wire := maybeCompressSnapshot(b, wantsCompress(r))
				writeRaw(w, compoundSSEID(snap.Seq, ordinal), "snapshot", wire)
				sw.RecordSnapshotPath(len(wire)) // PROBE 3: initial snapshot branch + wire bytes
			}
			baseline = snap.Seq
		}
	}
	// Phase 3: bootstrap the worker-wide pinned-sessions view on EVERY fresh
	// /vh/stream connect (both the replay/reconnect branch above and the fresh
	// branch). Pins are a SEPARATE store from this connection's state.Store:
	// they are worker-wide (one pins.json under stateBaseDir), not per-project,
	// and they are NOT carried in the replay ring. So a reconnecting client
	// cannot catch up on pins via state replay — this pins.snapshot frame IS
	// the catch-up (live pin mutations arrive later as transient pins.updated
	// frames, which are also not replayed). Emitted with NO id line (orthogonal
	// to the state-store resume cursor) AFTER the state bootstrap block and
	// BEFORE the live-tail loop drains the subscribe channel (the SubscribeWith
	// call above already created `ch`, so a mutation landing between this snapshot
	// read and the live-tail drain is covered EITHER by this snapshot OR by the
	// queued live pins.updated frame already waiting in `ch`). The payload is
	// the public pin projection ({revision, initialized, orderedSessionIds});
	// projectBySessionId is
	// intentionally omitted (server-internal routing map). Phase 5's stream.ts
	// listener will dispatch on event "pins.snapshot".
	if pb, err := json.Marshal(pinsPublicRespFromDoc(s.pins.Snapshot())); err == nil {
		writeRawNoID(w, "pins.snapshot", pb)
	} else {
		vhlog.Warn("pins.snapshot bootstrap: marshal failed, skipping pins frame", "err", err)
	}
	// Slice 3: bootstrap the per-project labels view (groups + tags +
	// tagIdsByRootSessionId) for THIS stream's project on EVERY fresh /vh/stream
	// connect, the direct analogue of the pins.snapshot block above (but
	// per-project: pins are worker-wide, labels are NOT). Labels are a SEPARATE
	// store from this connection's state.Store (<stateBaseDir>/projects/<key>/
	// labels.json, resolved from reqDir(r)) and NOT carried in the replay ring,
	// so a reconnecting client catches up on labels via THIS snapshot frame
	// (live label mutations arrive later as transient labels.updated frames,
	// also not replayed). Emitted with NO id line AFTER the state bootstrap
	// block and the pins snapshot, BEFORE the live-tail loop drains the
	// subscribe channel (SubscribeWith already created `ch`, so
	// subscribe-before-snapshot ordering holds — identical guarantee to pins).
	// LabelsDoc IS the wire shape (no private projection needed), and
	// projectByRootSessionId is private to labelsFile and never crosses the wire.
	// A nil store (unresolvable project) emits an empty-doc snapshot so the
	// client always receives the frame and stays in sync.
	streamLabelsDoc := emptyLabelsDoc()
	if st := s.labelsForDir(reqDir(r)); st != nil {
		streamLabelsDoc = st.Snapshot()
	}
	if lb, err := json.Marshal(streamLabelsDoc); err == nil {
		writeRawNoID(w, "labels.snapshot", lb)
	} else {
		vhlog.Warn("labels.snapshot bootstrap: marshal failed, skipping labels frame", "err", err)
	}
	// Slice 1 (archive-failure visibility): bootstrap the per-project archive-
	// failures view for THIS stream's project on EVERY fresh /vh/stream connect,
	// the direct analogue of the labels.snapshot block above (and per-project
	// like labels, NOT worker-wide like pins). The registry is in-memory +
	// current-daemon-only (no persistence, no replay ring), so a reconnecting
	// client catches up on stuck archive roots via THIS snapshot frame (live
	// record/clear arrive later as transient archive-failures.updated frames,
	// also not replayed). Emitted with NO id line AFTER the labels snapshot,
	// BEFORE the live-tail loop drains the subscribe channel (same ordering
	// guarantee as pins/labels: SubscribeWith already created `ch`, so a
	// mutation landing between this snapshot read and the live-tail drain is
	// covered EITHER by this snapshot OR by the queued live updated frame).
	// Filtered to reqDir(r) — only this project's failures cross the wire
	// (tenant isolation). The DTO carries classified reason tokens only (never
	// raw opencode.Error.Body).
	streamArchiveFailuresDoc := s.archiveFailuresDocForDir(reqDir(r))
	if afb, err := json.Marshal(streamArchiveFailuresDoc); err == nil {
		writeRawNoID(w, "archive-failures.snapshot", afb)
	} else {
		vhlog.Warn("archive-failures.snapshot bootstrap: marshal failed, skipping frame", "err", err)
	}
	flusher.Flush()

	// 15s keepalive ping ticker. A NAMED ping event (not an SSE `:` comment) so
	// an EventSource client can observe it and detect a dead-but-open connection.
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				discReason = diag.DiscSubscriberChannelClosed // PROBE 3
				return                                        // dropped as a slow consumer; client will reconnect + resume
			}
			if ev.Kind == state.KindNotice || ev.Kind == kindPinsUpdated || ev.Kind == kindLabelsUpdated || ev.Kind == kindArchiveFailuresUpdated || ev.Kind == kindLiveness {
				// Transient fan-out (state.KindNotice, the Phase 3
				// pins.updated full-state frame, the Slice 3 labels.updated
				// full-state frame, the Slice 1 archive-failures.updated
				// full-state frame, or the slice-4 liveness sentinel probe
				// echo): not part of the replayable view and it
				// reuses the current head seq, so forward it WITHOUT the
				// seq-baseline guard and WITHOUT an id line (don't move the
				// resume cursor). A resuming client never replays it —
				// pins/labels/archive-failures catch up via the snapshot
				// bootstrap frames emitted above on connect. The SSE event name
				// is ev.Kind itself, so a notice stays "notice", a pins.updated
				// becomes "pins.updated", a labels.updated becomes
				// "labels.updated", an archive-failures.updated becomes
				// "archive-failures.updated", and a liveness echo becomes
				// "vh.liveness" — the client dispatches on the name.
				writeRawNoID(w, ev.Kind, ev.Payload)
				flusher.Flush()
				continue
			}
			if ev.Seq <= baseline {
				continue // already covered by snapshot/replay
			}
			baseline = ev.Seq
			if !sendable(ev.Kind, ev.Payload) {
				continue // background message/part for an unsubscribed session
			}
			if treeEmitter != nil {
				// Phase 2 tree=2 live (L-14/M5): Prepare → checked deliver →
				// (on success) the legacy detail frame + per-event flush. On
				// any ambiguous failure (marshal/short write/write error) abort
				// the connection rather than continuing after an advanced
				// baseline — a dropped/partial frame must not poison the
				// emitter's cache. The emitter's per-connection E_c decides
				// whether a child op or only a count facet is shipped (§5.4).
				// The SSE id (Last-Event-ID) uses ev.Seq (STORE seq) so the
				// client's cursor matches store.Replay on reconnect (§5.5).
				//
				// O3 (T1C-F1, Stream-1 gate): identical to the replay-loop tree
				// branch above — counted = hasOps || IsTreeCountedKind. Non-
				// counted detail kinds (todo) emit via writeRawNoID so they don't
				// create an invisible ordinal gap. See the replay-loop comment
				// for the full single-source-of-truth rationale.
				prepared, err := treeEmitter.Prepare(ev)
				if err != nil {
					vhlog.Warn("tree=2 live: prepare failed, aborting stream", "seq", ev.Seq, "err", err)
					return
				}
				hasOps := prepared != nil && len(prepared.Ops) > 0
				if hasOps || state.IsTreeCountedKind(ev.Kind) {
					ordinal++
					id := compoundSSEID(ev.Seq, ordinal)
					if hasOps {
						if err := deliverTreeOps(w, treeEmitter, prepared, id); err != nil {
							vhlog.Warn("tree=2 live: delivery failed, aborting stream", "seq", ev.Seq, "err", err)
							return
						}
					}
					if ev.Kind != state.KindTreeOrphanCheck {
						writeEvent(w, id, ev.Kind, ev.Payload)
					}
				} else {
					if ev.Kind != state.KindTreeOrphanCheck {
						writeRawNoID(w, ev.Kind, ev.Payload)
					}
				}
				flusher.Flush()
				continue
			}
			// O3 Finding 1: Stream-2 (session/firehose, treeEmitter==nil) ordinal
			// alignment — see the identical branch in the replay loop above for the
			// full rationale. Message-class events advance the ordinal; structural
			// frames are emitted via writeRawNoID (no ordinal advance, no id line).
			if state.IsMessageClassKind(ev.Kind) {
				ordinal++
				writeEvent(w, compoundSSEID(ev.Seq, ordinal), ev.Kind, ev.Payload)
			} else {
				writeRawNoID(w, ev.Kind, ev.Payload)
			}
			flusher.Flush()
		case <-ticker.C:
			// A NAMED ping event (not an SSE ` : comment`) so the client can observe
			// it — EventSource hides comments, so the client uses these pings to
			// detect a dead-but-open connection and force a reconnect. No id line,
			// so Last-Event-ID (the resume cursor) is untouched.
			pingStart := time.Now() // PROBE 3: ping write+flush duration sentinel
			io.WriteString(w, "event: ping\ndata: {}\n\n")
			flusher.Flush()
			sw.RecordPing(time.Since(pingStart))
		}
	}
}
