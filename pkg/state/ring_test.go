package state

import "testing"

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
