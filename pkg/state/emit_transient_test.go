package state

// emit_transient_test.go — Phase 3 of server-managed pinned sessions.
//
// The web layer's worker-wide pins.updated fan-out needs a transient emit
// (live-only, not replayed, no seq advance — same contract as EmitNotice) that
// carries a CALLER-SUPPLIED kind so it becomes a distinct SSE `event:` name on
// the wire. EmitTransient(kind, payload) is that primitive; EmitNotice is now a
// thin wrapper that hardcodes KindNotice.
//
// These tests pin the four guarantees EmitTransient shares with EmitNotice plus
// the one property that distinguishes it (the kind is preserved on the wire):
//   1. fans out to a LIVE subscriber with the GIVEN kind (not hardcoded notice);
//   2. does NOT advance the store seq (resume cursors stay monotonic);
//   3. is NOT recorded to the replay ring (a reconnecting client never replays
//      it — it catches up via a fresh bootstrap snapshot in the relevant domain);
//   4. bypasses the per-subscriber Interest filter (full-state fan-out reaches
//      every live subscriber regardless of message-class interest);
//   5. EmitNotice still behaves as before (delegates to EmitTransient with
//      KindNotice).

import (
	"encoding/json"
	"testing"
)

// TestEmitTransientFansOutWithGivenKind is the core Phase 3 contract: the
// caller-supplied kind becomes ClientEvent.Kind on the wire (so the web layer's
// live-tail loop can forward it as a distinct SSE event name). A custom kind
// such as "pins.updated" must arrive intact, not be coerced to "notice".
func TestEmitTransientFansOutWithGivenKind(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainKind(ch, "") // drop any subscribe-time backlog (none expected)

	const kind = "pins.updated"
	payload := json.RawMessage(`{"revision":3,"initialized":true,"orderedSessionIds":["a","b"]}`)
	s.EmitTransient(kind, payload)

	select {
	case ev := <-ch:
		if ev.Kind != kind {
			t.Fatalf("EmitTransient kind: got %q, want %q (the kind must be preserved on the wire)", ev.Kind, kind)
		}
		if string(ev.Payload) != string(payload) {
			t.Fatalf("EmitTransient payload: got %s, want %s", ev.Payload, payload)
		}
	default:
		t.Fatal("EmitTransient did not reach the live subscriber")
	}
}

// TestEmitTransientDoesNotAdvanceSeq pins that a transient emit reuses the
// current head seq and does NOT advance it — so a subsequent Replay(cursor)
// taken before the emit sees no gap and no duplicate, and the resume cursor is
// untouched. This is what lets the web layer forward it with no `id:` line.
func TestEmitTransientDoesNotAdvanceSeq(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(256)
	defer unsub()
	// Seed one real (seq-advancing) event so the head is nonzero.
	s.Apply(ev("session.created", `{"info":{"id":"seed"}}`))
	drainKind(ch, "")

	before := s.Head()
	s.EmitTransient("pins.updated", []byte(`{}`))
	after := s.Head()
	if before != after {
		t.Fatalf("EmitTransient advanced seq: before=%d after=%d (transient emits must not move the head)", before, after)
	}
}

// TestEmitTransientNotReplayed pins the no-replay guarantee: a subscriber that
// captures a cursor, then misses a transient emit (it had unsubscribed or had
// not connected yet), must NOT receive that transient event via Replay(cursor).
// This is the contract the web layer relies on for pins — a reconnecting client
// catches up via the pins.snapshot bootstrap frame, never via replay.
func TestEmitTransientNotReplayed(t *testing.T) {
	s := New(100)
	// Seed a real event and capture the cursor at head.
	s.Apply(ev("session.created", `{"info":{"id":"seed"}}`))
	cursor := s.Head()

	// Emit a transient event AFTER the cursor — it must NOT land in the ring.
	s.EmitTransient("pins.updated", []byte(`{"revision":7}`))

	evs, _, ok := s.Replay(cursor)
	if !ok {
		t.Fatal("Replay(cursor) must be ok (cursor within ring)")
	}
	for _, e := range evs {
		if e.Kind == "pins.updated" {
			t.Fatalf("transient pins.updated was replayed from the ring — it must be live-only; got event seq=%d", e.Seq)
		}
	}
}

// TestEmitTransientBypassesInterest pins that a transient fan-out reaches every
// LIVE subscriber unconditionally, regardless of Interest. The web layer fans
// pins.updated to ALL project stores; a tree-only (structural) subscriber on a
// project's stream must still receive it (pins are worker-wide, not a
// message-class event the Interest filter governs). Mirrors how EmitNotice
// already bypasses Interest.
func TestEmitTransientBypassesInterest(t *testing.T) {
	s := New(100)
	// A structural-only subscriber that drops ALL message-class events.
	ch, unsub := s.SubscribeWith(64, structuralInterest())
	defer unsub()
	drainKind(ch, "")

	s.EmitTransient("pins.updated", []byte(`{"revision":1}`))

	select {
	case ev := <-ch:
		if ev.Kind != "pins.updated" {
			t.Fatalf("structural subscriber got %s, want pins.updated (transient fan-out must bypass Interest)", ev.Kind)
		}
	default:
		t.Fatal("structural-only subscriber did not receive the transient pins.updated — Interest filter blocked it (must bypass)")
	}
}

// TestEmitNoticeStillDelegates pins that EmitNotice is now a thin wrapper over
// EmitTransient(KindNotice, payload) and preserves the established "notice"
// behavior: fans out with KindNotice, live-only.
func TestEmitNoticeStillDelegates(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainKind(ch, "")

	s.EmitNotice([]byte(`{"text":"hi"}`))

	select {
	case ev := <-ch:
		if ev.Kind != KindNotice {
			t.Fatalf("EmitNotice kind: got %q, want %q (wrapper must preserve the notice kind)", ev.Kind, KindNotice)
		}
		if string(ev.Payload) != `{"text":"hi"}` {
			t.Fatalf("EmitNotice payload: got %s", ev.Payload)
		}
	default:
		t.Fatal("EmitNotice did not reach the live subscriber (wrapper regression)")
	}
}

// TestEmitTransientDropsSlowSubscriber pins the slow-consumer contract shared
// with EmitNotice: a subscriber whose channel is full is dropped (closed +
// removed) rather than blocking the emit. PROBE 2 counts the drop. This keeps a
// transient fan-out bounded — it never stalls the PUT handler.
func TestEmitTransientDropsSlowSubscriber(t *testing.T) {
	s := New(100)
	// Buffer of 1, never drained → the second emit overflows it.
	ch, unsub := s.Subscribe(1)
	defer unsub()
	drainKind(ch, "")

	s.EmitTransient("pins.updated", []byte(`{}`)) // fills the 1-slot buffer
	s.EmitTransient("pins.updated", []byte(`{}`)) // overflow → drop

	// The dropped subscriber's channel must be closed.
	select {
	case _, ok := <-ch:
		if ok {
			// Drain the one buffered event, then expect close.
			select {
			case _, ok2 := <-ch:
				if ok2 {
					t.Fatal("slow subscriber was not closed after the overflow drop")
				}
			default:
				t.Fatal("slow subscriber channel not closed after overflow (still open with room)")
			}
		}
	default:
		t.Fatal("slow subscriber channel closed before delivering the first buffered event")
	}
}
