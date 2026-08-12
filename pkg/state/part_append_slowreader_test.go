package state

// part_append_slowreader_test.go — Slice 4 deliverable 2: deterministic proof
// that emitPartAppend's slow-reader drop branch (the 256-event subscriber
// channel overflow path) fires under a burst, drops the subscriber, and that a
// cursorless reconnect snapshot reaches the authoritative current state with NO
// manual-reload semantics.
//
// This closes the slice-2 D-F1 untested branch (emitPartAppend's select-default
// close+drop+IncSubscriberDrops) and proves the spec §4.2 overload fallback:
// bounded queue, deterministic disconnect, automatic snapshot repair.
//
// See docs/ai/wire-protocols/part-append-streaming.md §4.2 (overload fallback)
// and tmp/agent-runs/part-stream-redesign-brief/brief.md slice 4 ("bounded
// queue, bounded lag or deterministic disconnect, auto snapshot repair, no
// manual reload").
//
// Run with -race to validate the close+delete-from-map-while-iterating fanout
// under emitPartAppend is race-free (the whole burst is single-goroutine here —
// Apply is synchronous — but -race confirms the s.mu-guarded map mutation is
// safe by construction):
//
//	go test -race -run TestPartAppend_SlowReader ./pkg/state/

import (
	"strings"
	"testing"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// TestPartAppend_SlowReaderDropThenReconnectSnapshot is the slice-4 slow-reader
// recovery proof. It exercises emitPartAppend's slow-reader branch directly:
//
//   - An opted-in subscriber with the production 256-event buffer is NOT drained
//     while a burst of > 256 part.append flushes is driven. The 257th flush
//     overflows the channel → emitPartAppend's select-default branch closes the
//     channel, deletes the subscriber from s.subs, and increments
//     SubscriberDrops (the existing backpressure sentinel).
//   - The authoritative store state survives the drop (the accumulator + me.parts
//     hold the full accumulated text — only the subscriber was severed).
//   - A cursorless reconnect (re-subscribe + Snapshot) delivers the authoritative
//     accumulated field text — the full state the dropped subscriber missed, with
//     no manual-reload step (spec §4.2: the client reconnects and re-snapshots).
//   - The reconnected subscriber receives the live tail again — the post-reconnect
//     stream is healthy and authoritative.
func TestPartAppend_SlowReaderDropThenReconnectSnapshot(t *testing.T) {
	s := seedPartStream(t, time.Nanosecond) // every delta flushes

	dropsBefore := diag.Default.Emit.SubscriberDrops.Load()

	// Opted-in subscriber with the PRODUCTION 256-event buffer, NOT drained.
	// Each delta flush → one KindPartAppend into this channel. After 256 the
	// channel is full; the 257th flush hits emitPartAppend's select-default
	// slow-reader branch (close + delete + IncSubscriberDrops).
	sub, stop := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop()

	const nDeltas = 300 // > 256 → guaranteed overflow regardless of seed timing
	const deltaLen = 16
	delta := strings.Repeat("b", deltaLen)
	for i := 0; i < nDeltas; i++ {
		applyDelta(s, "sess", "m1", "p1", "text", delta)
	}

	// 1. Subscriber was dropped: SubscriberDrops incremented by the slow-reader
	//    branch in emitPartAppend.
	dropsAfter := diag.Default.Emit.SubscriberDrops.Load()
	if dropsAfter <= dropsBefore {
		t.Fatalf("slow-reader drop not recorded: SubscriberDrops before=%d after=%d (want after>before)", dropsBefore, dropsAfter)
	}

	// 2. The channel was CLOSED by the slow-reader branch. A closed channel with
	//    buffered events still returns them with ok=true until exhausted, so drain
	//    with the comma-ok form and assert we eventually hit ok=false (closed).
	//    (drainAll cannot be used here — a closed channel is always "ready", which
	//    would make its select-default loop run forever.)
	nBuffered := 0
	sawClosed := false
	for {
		_, ok := <-sub
		if !ok {
			sawClosed = true
			break
		}
		nBuffered++
		if nBuffered > 10000 { // safety bound; never expected to hit
			break
		}
	}
	if !sawClosed {
		t.Fatalf("slow-reader-dropped subscriber channel must be CLOSED; still open after %d reads", nBuffered)
	}
	// The buffer was full (256 events) when the 257th flush triggered the close,
	// so exactly 256 buffered suffixes remain readable on the closed channel.
	if nBuffered != 256 {
		t.Errorf("buffered events on closed channel: got %d, want 256 (the channel capacity — it filled before overflow)", nBuffered)
	}

	// 3. Cursorless reconnect delivers the AUTHORITATIVE current state. The drop
	//    only severed the subscriber; the accumulator + me.parts kept growing on
	//    every flush (flushPartDeltasLocked runs independent of subscribers). The
	//    expected final field text is nDeltas*deltaLen bytes of "b".
	wantText := strings.Repeat("b", nDeltas*deltaLen)
	snap := s.Snapshot(map[string]bool{"sess": true})
	if gotText := partText(snap, "sess", "p1"); gotText != wantText {
		t.Fatalf("cursorless reconnect snapshot field text: got %d bytes, want %d bytes (authoritative current state not reached — no manual reload)",
			len(gotText), len(wantText))
	}

	// 4. A fresh subscriber (the reconnected client) receives the live tail
	//    again — the post-reconnect stream is healthy and continues from the
	//    authoritative base. This is the spec §4.2 repair: reconnect → snapshot
	//    → resume live-tail, with no manual-reload step.
	sub2, stop2 := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer stop2()
	applyDelta(s, "sess", "m1", "p1", "text", "TAIL")
	liveSuffixes := drainKind(sub2, KindPartAppend)
	if len(liveSuffixes) != 1 {
		t.Fatalf("post-reconnect live tail: want 1 part.append suffix, got %d", len(liveSuffixes))
	}
	liveStart, liveText := partAppendSuffix(t, liveSuffixes[0].Payload)
	// The post-reconnect suffix starts at the authoritative base length (the
	// snapshot field byte length) — contiguous resume, no byte re-send.
	if liveStart != len(wantText) {
		t.Errorf("post-reconnect live suffix start: got %d want %d (authoritative base length)", liveStart, len(wantText))
	}
	if liveText != "TAIL" {
		t.Errorf("post-reconnect live suffix text: got %q want %q", liveText, "TAIL")
	}

	// 5. The post-reconnect authoritative state includes the tail byte.
	snap2 := s.Snapshot(map[string]bool{"sess": true})
	if got := partText(snap2, "sess", "p1"); got != wantText+"TAIL" {
		t.Errorf("post-reconnect+tail snapshot: got %d bytes, want %d bytes", len(got), len(wantText)+len("TAIL"))
	}
}
