package state

import (
	"encoding/json"
	"strconv"
	"sync"
	"testing"
)

// This file pins the upstream interest-filtering contract added by the
// event-delivery latency fix (Option A): a subscriber whose Interest excludes
// high-volume message-class events (message.*/part.*/messages.*) must never
// have them enqueued, so a token-delta flood cannot fill its channel and starve
// it of the structural/notification events it does want. The downstream web
// sendable() is a defensive compatibility check only; the guarantee tested here
// is that excluded events never ENTER the channel.

// structuralInterest drops ALL message-class events (the tree-only Stream 1).
func structuralInterest() Interest {
	return Interest{MessageSessions: map[string]bool{}}
}

// drainAll collects every currently-buffered event (unlike drainKind(ch, ""),
// which drains-and-DISCARDS). Used where a test must inspect the full set of
// delivered events.
func drainAll(ch <-chan ClientEvent) []ClientEvent {
	var out []ClientEvent
	for {
		select {
		case e := <-ch:
			out = append(out, e)
		default:
			return out
		}
	}
}

// TestSubscribeWithStructuralInterestFiltersTokenFlood is the core latency-fix
// proof (acceptance gate #1). A structural-only subscriber with a SMALL buffer
// (8, well under 256) is flooded with message.part.delta/message.upsert events
// it does not want, then a trailing session.created is emitted. Without the
// upstream filter the flood would overflow the 8-slot channel and close the
// subscriber (or queue the structural event behind the flood). With the filter
// the structural event arrives promptly and no message-class event is ever
// received.
func TestSubscribeWithStructuralInterestFiltersTokenFlood(t *testing.T) {
	s := New(100)
	ch, unsub := s.SubscribeWith(8, structuralInterest())
	defer unsub()
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	drainKind(ch, "") // discard the seed session.upsert

	// Flood: 200 token deltas for a background session (re-emitted as
	// part.upsert) + 50 message.upsert events. All message-class → must be
	// filtered upstream and never enter the 8-slot channel.
	for i := 0; i < 200; i++ {
		s.Apply(ev("message.part.delta", `{"sessionID":"bg","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
	}
	for i := 0; i < 50; i++ {
		s.Apply(ev("message.updated", `{"info":{"id":"m`+strconv.Itoa(i)+`","sessionID":"bg","role":"assistant"}}`))
	}

	// Drain everything that DID make it into the channel: none may be message-class.
	got := drainAll(ch)
	if len(got) == 0 {
		t.Fatal("expected at least the structural activity event from the flood's first delta; got empty channel")
	}
	for _, e := range got {
		if isMessageClassKind(e.Kind) {
			t.Fatalf("structural-only subscriber received message-class event %s — upstream filter failed", e.Kind)
		}
	}

	// The trailing structural event arrives promptly (channel never filled).
	s.Apply(ev("session.created", `{"info":{"id":"late"}}`))
	select {
	case e := <-ch:
		if e.Kind != KindSessionUpsert {
			t.Fatalf("want trailing session.upsert, got %s", e.Kind)
		}
	default:
		t.Fatal("trailing session.upsert not promptly delivered — flood should not have filled the channel")
	}

	// Subscriber must NOT have been closed by the token pressure.
	select {
	case _, ok := <-ch:
		if !ok {
			t.Fatal("subscriber was closed by excluded token pressure — nonblocking fanout fired on filtered events")
		}
	default:
		// open + empty: the expected post-filter state
	}
}

// TestSubscribeWithActiveSessionInterest is acceptance gate #2: an active-session
// subscriber (Stream 2) receives message/part/messages.loaded for its subscribed
// session, NOT for other sessions, while structural/notification/control events
// still flow for every session.
func TestSubscribeWithActiveSessionInterest(t *testing.T) {
	s := New(100)
	ch, unsub := s.SubscribeWith(64, Interest{MessageSessions: map[string]bool{"A": true}})
	defer unsub()
	s.Apply(ev("session.created", `{"info":{"id":"A"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"B"}}`))

	// Message/part/loaded for A (subscribed) — must be delivered.
	s.Apply(ev("message.updated", `{"info":{"id":"mA","sessionID":"A","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"pA","sessionID":"A","messageID":"mA","type":"text","text":"hi"}}`))
	s.EmitMessagesLoaded("A", 0, 0)

	// Message/part/loaded for B (NOT subscribed) — must be filtered upstream.
	s.Apply(ev("message.updated", `{"info":{"id":"mB","sessionID":"B","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"pB","sessionID":"B","messageID":"mB","type":"text","text":"x"}}`))
	s.EmitMessagesLoaded("B", 0, 0)

	// Structural activity for B must still flow to this subscriber.
	s.Apply(ev("session.idle", `{"sessionID":"B"}`))

	var sawA, sawLoadedA, sawB, sawIdleB bool
	for _, e := range drainAll(ch) {
		switch e.Kind {
		case KindMessageUpsert, KindPartUpsert:
			var p struct{ SessionID string }
			_ = json.Unmarshal(e.Payload, &p)
			if p.SessionID == "A" {
				sawA = true
			}
			if p.SessionID == "B" {
				sawB = true
			}
		case KindMessagesLoaded:
			var p struct{ SessionID string }
			_ = json.Unmarshal(e.Payload, &p)
			if p.SessionID == "A" {
				sawLoadedA = true
			}
			if p.SessionID == "B" {
				sawB = true
			}
		case KindActivity:
			var p struct{ SessionID string }
			_ = json.Unmarshal(e.Payload, &p)
			if p.SessionID == "B" {
				sawIdleB = true
			}
		}
	}
	if !sawA {
		t.Fatal("active-session subscriber must receive its session's message/part events")
	}
	if !sawLoadedA {
		t.Fatal("active-session subscriber must receive messages.loaded for its session")
	}
	if sawB {
		t.Fatal("active-session subscriber must NOT receive another session's message/part/loaded events")
	}
	if !sawIdleB {
		t.Fatal("structural activity event for B must still flow to the active-session subscriber")
	}
}

// TestSubscribeWithFirehoseInterestDeliversEverything pins that the zero/nil
// Interest (and an explicit nil MessageSessions) is the firehose: every event,
// including message-class for all sessions. This is the backward-compatible
// path the alerts engine and existing tests rely on.
func TestSubscribeWithFirehoseInterestDeliversEverything(t *testing.T) {
	s := New(100)
	zeroCh, zeroUnsub := s.SubscribeWith(64, Interest{})
	defer zeroUnsub()
	nilCh, nilUnsub := s.SubscribeWith(64, Interest{MessageSessions: nil})
	defer nilUnsub()

	s.Apply(ev("session.created", `{"info":{"id":"A"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"mA","sessionID":"A","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"pA","sessionID":"A","messageID":"mA","type":"text","text":"hi"}}`))

	countMsgClass := func(evs []ClientEvent) int {
		var n int
		for _, e := range evs {
			if isMessageClassKind(e.Kind) {
				n++
			}
		}
		return n
	}
	if n := countMsgClass(drainAll(zeroCh)); n == 0 {
		t.Fatal("zero-Interest (firehose) subscriber must receive message-class events")
	}
	if n := countMsgClass(drainAll(nilCh)); n == 0 {
		t.Fatal("Interest{MessageSessions:nil} (firehose) subscriber must receive message-class events")
	}
}

// TestSubscribeWithInterestReplayGapProtection is acceptance gate #3: the
// subscribe-before-replay/snapshot ordering means a structural event emitted in
// the window between Subscribe and Replay/Snapshot is observable both via the
// replay ring and the live channel — nothing is lost across the boundary. The
// interest filter must not perturb this invariant (it only governs the live
// channel, not the ring).
func TestSubscribeWithInterestReplayGapProtection(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"seed"}}`))

	// Subscribe (structural-only), capture the head as the resume cursor, then
	// emit a structural event in the gap — exactly handleStream's order.
	ch, unsub := s.SubscribeWith(64, structuralInterest())
	defer unsub()
	cursor := s.Head()
	s.Apply(ev("session.created", `{"info":{"id":"gap"}}`))

	// Replay from cursor: the gap event must be present (ring invariant,
	// independent of any subscriber interest).
	evs, _, ok := s.Replay(cursor)
	if !ok {
		t.Fatal("replay must be ok (cursor within ring)")
	}
	var sawGapReplay bool
	for _, e := range evs {
		if e.Kind == KindSessionUpsert {
			var p struct{ ID string }
			_ = json.Unmarshal(e.Payload, &p)
			if p.ID == "gap" {
				sawGapReplay = true
			}
		}
	}
	if !sawGapReplay {
		t.Fatal("replay lost the structural event emitted in the subscribe/replay gap")
	}

	// Live channel also received it (structural → passes the interest filter).
	select {
	case e := <-ch:
		if e.Kind != KindSessionUpsert {
			t.Fatalf("want gap session.upsert on live channel, got %s", e.Kind)
		}
	default:
		t.Fatal("gap structural event did not reach the live channel")
	}
}

// TestSubscribeWithStructuralInterestConcurrentFloodNoRace is acceptance gate
// #4: under concurrency, a high-volume token producer must not starve a
// structural-only subscriber of a concurrent structural event, and there must be
// no data races on subscriber close/remove. Run with -race.
func TestSubscribeWithStructuralInterestConcurrentFloodNoRace(t *testing.T) {
	s := New(1000)
	ch, unsub := s.SubscribeWith(64, structuralInterest())
	defer unsub()
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	drainKind(ch, "")

	// 4 goroutines each flooding token deltas for a background session.
	var wg sync.WaitGroup
	wg.Add(4)
	for g := 0; g < 4; g++ {
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				s.Apply(ev("message.part.delta", `{"sessionID":"bg","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
			}
		}()
	}

	// A structural event concurrent with the flood.
	s.Apply(ev("session.created", `{"info":{"id":"late"}}`))

	wg.Wait()

	// The structural event must be observable WITHOUT draining the flood: the
	// message-class deltas never entered the channel, so session.upsert is
	// promptly readable. No message-class event may have leaked through.
	var sawLate bool
	for _, e := range drainAll(ch) {
		if isMessageClassKind(e.Kind) {
			t.Fatalf("structural-only subscriber received message-class event under concurrent flood: %s", e.Kind)
		}
		if e.Kind == KindSessionUpsert {
			var p struct{ ID string }
			_ = json.Unmarshal(e.Payload, &p)
			if p.ID == "late" {
				sawLate = true
			}
		}
	}
	if !sawLate {
		t.Fatal("concurrent structural session.upsert not observable — token flood starved it (upstream filter failed under concurrency)")
	}
}

// --- benchmarks (acceptance gate #5): reducer vs fanout cost by event kind ---
//
// These isolate where the per-event lock-held time goes for message.part.delta
// (the highest-volume kind), to decide the follow-up between Option C
// (delta-coalescing: cut reducer JSON work) and Option D (fanout outside lock:
// cut per-subscriber channel-send cost). Three variants split reducer from
// fanout:
//   - no subscribers           → reducer + ring push only (the floor).
//   - 8 structural-only subs   → + interest check only (filtered out, ~no send) —
//     the Option A win: the active background-flood producer pays ~no fanout
//     cost for tree-only subscribers.
//   - 8 interested subs        → + N nonblocking channel sends under lock — the
//     residual fanout cost Option D targets (the active-session Stream 2 that
//     DOES want the deltas).

func benchApplyPartDelta(b *testing.B, subs int, interest Interest) {
	s := New(10000)
	s.Apply(ev("session.created", `{"info":{"id":"s"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s","role":"assistant"}}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
	for n := 0; n < subs; n++ {
		_, unsub := s.SubscribeWith(256, interest)
		defer unsub()
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Apply(ev("message.part.delta", `{"sessionID":"s","messageID":"m1","partID":"p1","field":"text","delta":"x"}`))
	}
}

func BenchmarkApplyPartDeltaNoSubs(b *testing.B) {
	benchApplyPartDelta(b, 0, Interest{})
}

func BenchmarkApplyPartDeltaStructuralSubs(b *testing.B) {
	// Structural-only subscribers: filtered out of message-class events, so the
	// producer pays only the per-subscriber wants() check (no channel send).
	benchApplyPartDelta(b, 8, structuralInterest())
}

func BenchmarkApplyPartDeltaInterestedSubs(b *testing.B) {
	// Interested subscribers: each delta is delivered → N nonblocking sends
	// under lock (the Option D residual).
	benchApplyPartDelta(b, 8, Interest{MessageSessions: map[string]bool{"s": true}})
}

// BenchmarkApplySessionCreated is a cheap-reducer baseline: structural event,
// light reducer, one emit. Frames the per-event lock floor independent of the
// delta reducer's JSON work.
func BenchmarkApplySessionCreated(b *testing.B) {
	s := New(10000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Apply(ev("session.created", `{"info":{"id":"s`+strconv.Itoa(i)+`"}}`))
	}
}
