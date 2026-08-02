package state

import (
	"sync"
	"testing"
	"time"
)

// TestProjectCountsEquivalentToIndividualAccessors proves the coherent
// ProjectCounts() triple is a faithful replacement for the three individual
// locked accessors on a quiescent store: the (roots, running, unread) it
// returns must equal (RootCount(), RunningRoots(), UnreadRoots()) exactly, and
// must satisfy the unread ⊆ idle invariant (unread <= roots − running). The
// atomicity advantage (a single RLock so a busy↔idle writer cannot interleave
// between the reads) is STRUCTURAL; this test pins the value-equivalence half
// and is the seed run under `go test -race`. The atomicity-under-concurrency
// half is pinned by TestProjectCountsConcurrentInvariant.
func TestProjectCountsEquivalentToIndividualAccessors(t *testing.T) {
	s := New(100)
	defer s.Close()

	// Empty store: all three counts are 0.
	if r, ru, u := s.ProjectCounts(); r != 0 || ru != 0 || u != 0 {
		t.Fatalf("empty store: ProjectCounts=(%d,%d,%d), want (0,0,0)", r, ru, u)
	}
	assertProjectCountsEquiv(t, s)

	// Mixed population using the SAME ev(...)/evStatus(...) seed helpers as
	// store_test.go / unread_transition_test.go:
	//   R1 — root, busy via child C1 (subtreeBusyCount[R1] = 1)
	//   R2 — root, driven to finished-unread via an ordinary busy→idle on C2
	//   R3 — root, idle, not unread
	// Children (C1, C2) must NOT inflate roots/running/unread.
	s.Apply(ev("session.created", `{"info":{"id":"R1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"C1","parentID":"R1"}}`))
	s.Apply(ev("session.status", evStatus("C1", "busy")))

	s.Apply(ev("session.created", `{"info":{"id":"R2"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"C2","parentID":"R2"}}`))
	s.Apply(ev("session.status", evStatus("C2", "busy")))
	s.Apply(ev("session.status", evStatus("C2", "idle"))) // ordinary busy→idle → R2 unread

	s.Apply(ev("session.created", `{"info":{"id":"R3"}}`))

	// Expected: roots 3, running 1 (R1), unread 1 (R2); idle = 2 ⊇ unread 1.
	if r, ru, u := s.RootCount(), s.RunningRoots(), s.UnreadRoots(); r != 3 || ru != 1 || u != 1 {
		t.Fatalf("setup invariant: individual (roots,running,unread)=(%d,%d,%d), want (3,1,1)", r, ru, u)
	}
	assertProjectCountsEquiv(t, s)

	// Ack R2 → unread clears; running/roots unchanged. Equivalence must hold.
	s.AckUnread("R2")
	if u := s.UnreadRoots(); u != 0 {
		t.Fatalf("setup invariant: UnreadRoots want 0 after ack, got %d", u)
	}
	assertProjectCountsEquiv(t, s)
}

// assertProjectCountsEquiv fails the test if ProjectCounts() diverges from the
// three individual accessors or violates the unread ⊆ idle invariant.
func assertProjectCountsEquiv(t *testing.T, s *Store) {
	t.Helper()
	wantRoots, wantRunning, wantUnread := s.RootCount(), s.RunningRoots(), s.UnreadRoots()
	gotRoots, gotRunning, gotUnread := s.ProjectCounts()
	if gotRoots != wantRoots || gotRunning != wantRunning || gotUnread != wantUnread {
		t.Fatalf("ProjectCounts=(%d,%d,%d) != individual (RootCount,RunningRoots,UnreadRoots)=(%d,%d,%d)",
			gotRoots, gotRunning, gotUnread, wantRoots, wantRunning, wantUnread)
	}
	if gotUnread > gotRoots-gotRunning {
		t.Fatalf("invariant violated: unread %d > idle %d (roots %d − running %d)",
			gotUnread, gotRoots-gotRunning, gotRoots, gotRunning)
	}
}

// TestProjectCountsConcurrentInvariant hammers ProjectCounts() readers against a
// busy↔idle writer and asserts the unread ⊆ idle invariant (unread <= roots −
// running) holds on EVERY read. The invariant is STRUCTURAL: ProjectCounts()
// takes a single RLock, and every busy↔idle transition (markUnreadLocked on
// busy→idle, clearUnreadLocked on idle→busy) completes under one write lock, so
// a reader can never observe a mid-transition state where unread > idle. Run
// under `go test -race` to also verify the read path is data-race-free. Bounded
// to a fixed iteration count + a fixed time window after the established
// grace_timer_test.go concurrent pattern, so it is non-flaky.
func TestProjectCountsConcurrentInvariant(t *testing.T) {
	s := New(100)
	defer s.Close()

	// One root R with a child C the writer flips busy↔idle. Readers assert the
	// invariant on every ProjectCounts() call.
	s.Apply(ev("session.created", `{"info":{"id":"R"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"C","parentID":"R"}}`))

	const readers = 4
	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Writer: flip C busy↔idle via the ordinary status path (the path that
	// marks R unread on busy→idle and clears it on idle→busy) for a bounded
	// number of iterations.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 400; i++ {
			select {
			case <-stop:
				return
			default:
			}
			s.Apply(ev("session.status", evStatus("C", "busy")))
			s.Apply(ev("session.status", evStatus("C", "idle")))
		}
	}()

	// Readers: assert unread <= roots − running on every ProjectCounts() call
	// until stopped. t.Errorf (not Fatal) is safe from a goroutine.
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				roots, running, unread := s.ProjectCounts()
				if unread > roots-running {
					t.Errorf("invariant violated: unread %d > idle %d (roots %d, running %d)",
						unread, roots-running, roots, running)
					return
				}
			}
		}()
	}

	// Bounded race window (matches grace_timer_test.go's accepted non-flaky
	// window). The writer exits after its 400 iterations; the sleep covers the
	// window, then we stop the readers and wait for clean shutdown.
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()
}
