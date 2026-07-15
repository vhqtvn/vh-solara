package state

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestRingReplaySemantics(t *testing.T) {
	s := New(3) // small ring to force rotation
	for i := 0; i < 5; i++ {
		s.Apply(ev("session.created", `{"info":{"id":"s`+string(rune('0'+i))+`"}}`))
	}
	// seq is now 5; ring holds seqs 3,4,5.

	// Current client (cursor == head): no replay, ok.
	if evs, _, ok := s.Replay(5); !ok || len(evs) != 0 {
		t.Fatalf("cursor at head: want ok,0 got ok=%v,n=%d", ok, len(evs))
	}
	// Cursor within buffer: replay the tail.
	if evs, _, ok := s.Replay(3); !ok || len(evs) != 2 {
		t.Fatalf("cursor=3: want ok,2 got ok=%v,n=%d", ok, len(evs))
	}
	// Cursor too old (dropped from ring): not ok -> caller sends snapshot.
	if _, _, ok := s.Replay(1); ok {
		t.Fatal("cursor=1 older than buffer: want not ok")
	}
}

func TestSubscribeReceivesLiveEvents(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(8)
	defer unsub()

	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	select {
	case got := <-ch:
		if got.Kind != KindSessionUpsert {
			t.Fatalf("want %s, got %s", KindSessionUpsert, got.Kind)
		}
		if got.Seq == 0 {
			t.Fatal("seq should be non-zero")
		}
	default:
		t.Fatal("expected a live event on the subscription")
	}
}

// --- Direct ringBuffer.since() contract tests --------------------------------
//
// These pin the ring-level replay contract INDEPENDENTLY of the store, so the
// behavior is locked before any structural change to the buffer. They mirror how
// the store drives the ring: head is the Seq of the most recent pushed event
// (Store passes s.seq), and events are pushed in strictly increasing Seq order.

// ringEv builds an identifiable event for seq s. Kind/Payload are distinct per
// seq so a returned event can be matched beyond just its Seq.
func ringEv(seq int) ClientEvent {
	return ClientEvent{
		Seq:     uint64(seq),
		Kind:    fmt.Sprintf("k%d", seq),
		Payload: json.RawMessage(fmt.Sprintf(`{"i":%d}`, seq)),
	}
}

// pushSeqRange pushes events with Seq lo..hi (inclusive) into r.
func pushSeqRange(r *ringBuffer, lo, hi int) {
	for s := lo; s <= hi; s++ {
		r.push(ringEv(s))
	}
}

// seqsOf extracts the Seq slice from a batch of events.
func seqsOf(evs []ClientEvent) []uint64 {
	out := make([]uint64, len(evs))
	for i, e := range evs {
		out[i] = e.Seq
	}
	return out
}

func TestRingSinceEmpty(t *testing.T) {
	r := newRingBuffer(4)

	// cursor >= head on a fresh (head==0) ring: client is "current", ok, empty.
	if evs, head, ok := r.since(0, 0); !ok || len(evs) != 0 || head != 0 {
		t.Fatalf("since(0,0) on empty: want ok,0,head=0 got ok=%v,n=%d,head=%d", ok, len(evs), head)
	}

	// Synthetic gap on an empty ring (cursor < head but nothing buffered): the
	// caller must snapshot. This pins the count==0 -> not-ok branch reachable
	// only when cursor < head.
	if _, _, ok := r.since(0, 5); ok {
		t.Fatal("since(0,5) on empty ring: want not ok (no buffer to replay)")
	}
}

func TestRingSincePartial(t *testing.T) {
	// count < cap: push 3 events (seqs 1..3), head==3.
	r := newRingBuffer(4)
	pushSeqRange(r, 1, 3)

	// since(0) -> all, in insertion order.
	evs, _, ok := r.since(0, 3)
	if !ok || !eqSeqs(evs, []uint64{1, 2, 3}) {
		t.Fatalf("since(0,3): want ok [1 2 3] got ok=%v %v", ok, seqsOf(evs))
	}
	// since(newest) -> empty (client current).
	if evs, _, ok := r.since(3, 3); !ok || len(evs) != 0 {
		t.Fatalf("since(3,3): want ok,empty got ok=%v n=%d", ok, len(evs))
	}
	// since(mid) -> tail after it.
	if evs, _, ok := r.since(2, 3); !ok || !eqSeqs(evs, []uint64{3}) {
		t.Fatalf("since(2,3): want ok [3] got ok=%v %v", ok, seqsOf(evs))
	}
	if evs, _, ok := r.since(1, 3); !ok || !eqSeqs(evs, []uint64{2, 3}) {
		t.Fatalf("since(1,3): want ok [2 3] got ok=%v %v", ok, seqsOf(evs))
	} else if len(evs) >= 1 && (evs[0].Kind != "k2" || string(evs[0].Payload) != `{"i":2}`) {
		// Identifiability: returned events carry the right Kind/Payload for their Seq.
		t.Fatalf("since(1,3) first event identity mismatch: %+v", evs[0])
	}
}

func TestRingSinceExactlyFull(t *testing.T) {
	// count == cap with NO overflow (cap pushes). head wraps back to 0 and must
	// still read oldest-first as items[0..cap).
	r := newRingBuffer(4)
	pushSeqRange(r, 1, 4)

	evs, _, ok := r.since(0, 4)
	if !ok || !eqSeqs(evs, []uint64{1, 2, 3, 4}) {
		t.Fatalf("since(0,4) exactly-full: want ok [1 2 3 4] got ok=%v %v", ok, seqsOf(evs))
	}
}

func TestRingSinceOverflow(t *testing.T) {
	// cap=4, push 7 events (3 overflow). Retained window is seqs 4..7, head==7.
	r := newRingBuffer(4)
	pushSeqRange(r, 1, 7)

	// Cursor older than the window -> gap -> not ok (caller snapshots).
	if _, _, ok := r.since(0, 7); ok {
		t.Fatal("since(0,7): cursor predates window, want not ok (gap)")
	}
	if _, _, ok := r.since(2, 7); ok {
		t.Fatal("since(2,7): cursor predates window, want not ok (gap)")
	}
	// Cursor exactly one before the oldest retained -> NOT a gap, full window.
	if evs, _, ok := r.since(3, 7); !ok || !eqSeqs(evs, []uint64{4, 5, 6, 7}) {
		t.Fatalf("since(3,7): want ok [4 5 6 7] got ok=%v %v", ok, seqsOf(evs))
	}
	// Cursors inside the window return the tail in oldest->newest order.
	if evs, _, ok := r.since(4, 7); !ok || !eqSeqs(evs, []uint64{5, 6, 7}) {
		t.Fatalf("since(4,7): want ok [5 6 7] got ok=%v %v", ok, seqsOf(evs))
	}
	if evs, _, ok := r.since(5, 7); !ok || !eqSeqs(evs, []uint64{6, 7}) {
		t.Fatalf("since(5,7): want ok [6 7] got ok=%v %v", ok, seqsOf(evs))
	}
	if evs, _, ok := r.since(6, 7); !ok || !eqSeqs(evs, []uint64{7}) {
		t.Fatalf("since(6,7): want ok [7] got ok=%v %v", ok, seqsOf(evs))
	}
	// since(newest) -> empty (current).
	if evs, _, ok := r.since(7, 7); !ok || len(evs) != 0 {
		t.Fatalf("since(7,7): want ok,empty got ok=%v n=%d", ok, len(evs))
	}
	// No duplicates / no gaps: the full in-window replay is strictly increasing
	// and contiguous across the retained window.
	if evs, _, ok := r.since(3, 7); !ok {
		t.Fatalf("since(3,7): want ok")
	} else if !contiguousIncreasing(seqsOf(evs)) {
		t.Fatalf("since(3,7) replay not contiguous+increasing: %v", seqsOf(evs))
	}
}

func TestRingSinceRealCapacity(t *testing.T) {
	// Exercise the production capacity (4096) to guard against off-by-one at the
	// real ring size. Push 5000 events; retained window is 901..5000.
	const cap = 4096
	r := newRingBuffer(cap)
	pushSeqRange(r, 1, 5000)
	const head = 5000
	oldest := 5000 - cap + 1 // 901

	// Cursor predating the window -> gap.
	if _, _, ok := r.since(uint64(oldest-2), head); ok {
		t.Fatalf("since(%d,%d): want not ok (gap)", oldest-2, head)
	}
	// Cursor exactly one before oldest -> full retained window, in order.
	evs, _, ok := r.since(uint64(oldest-1), head)
	if !ok || len(evs) != cap {
		t.Fatalf("since(%d,%d): want ok,%d events got ok=%v,%d", oldest-1, head, cap, ok, len(evs))
	}
	if !eqSeqs(evs, rangeSeqs(oldest, head)) {
		t.Fatalf("since(%d,%d): retained window mismatch", oldest-1, head)
	}
	// Tail near the head.
	if evs, _, ok := r.since(4999, head); !ok || !eqSeqs(evs, []uint64{5000}) {
		t.Fatalf("since(4999,%d): want ok [5000] got ok=%v %v", head, ok, seqsOf(evs))
	}
}

// eqSeqs compares a []ClientEvent's seqs to a literal.
func eqSeqs(evs []ClientEvent, want []uint64) bool {
	return eqU64(seqsOf(evs), want)
}

func eqU64(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contiguousIncreasing(s []uint64) bool {
	for i := 1; i < len(s); i++ {
		if s[i] != s[i-1]+1 {
			return false
		}
	}
	return len(s) == 0 || s[0] > 0
}

func rangeSeqs(lo, hi int) []uint64 {
	out := make([]uint64, 0, hi-lo+1)
	for s := lo; s <= hi; s++ {
		out = append(out, uint64(s))
	}
	return out
}
