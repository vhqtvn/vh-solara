package state

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"testing"
)

// This file pins the STRUCTURAL INVARIANT that the running-count index
// (Store.RunningRoots) can NEVER diverge from per-session activity and the
// subtreeBusy index. It is the regression suite for the phantom "1 running"
// bug: a live daemon reported count:1 while every session was idle and
// subtreeBusy==0 on all roots — RunningRoots held a phantom that no
// per-session activity backed and subtreeBusyCount did not count.
//
// Root cause (pre-fix): RunningRoots read the legacy root-keyed busyCount,
// which had asymmetric maintenance vs the proven-correct incremental
// subtreeBusyCount — specifically a REPARENT gap (a busy session moved
// R→R2 left busyCount[R] stranded) and a PHANTOM-STATUS gap (a busy status
// for an unknown id created a stray busyCount entry). The fix retires
// busyCount and derives RunningRoots + the finished-unread trigger from
// subtreeBusyCount, so divergence is impossible by construction.
//
// referenceBusyRootCount is the INDEPENDENT ground truth for "how many roots
// have a busy/retry session anywhere in their subtree": it counts over
// s.sessions + s.activity only (it does NOT consult subtreeBusyCount OR
// busyCount), mirroring RootCount's orphan-inclusive root definition. A root
// is busy iff any session in its subtree (including itself) is busy/retry.
func referenceBusyRootCount(s *Store) int {
	sub := referenceSubtreeBusyCount(s) // independent O(n) recompute over sessions+activity
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for id, se := range s.sessions {
		if se.parentID == "" || s.sessions[se.parentID] == nil {
			// id is a live root (orphan-inclusive). It is busy iff its subtree
			// (incl itself) holds any busy/retry session.
			if sub[id] > 0 {
				n++
			}
		}
	}
	return n
}

// assertBusyIndexesAgree asserts the three views of "how many roots are busy"
// all agree: Store.RunningRoots (the /vh/running-sessions source), the
// incremental subtreeBusyCount index (summed over live roots), and the
// independent reference recomputed from per-session activity. Any divergence
// is a phantom — the exact bug class this suite pins.
func assertBusyIndexesAgree(t *testing.T, s *Store, trace string) {
	t.Helper()
	want := referenceBusyRootCount(s)
	if got := s.RunningRoots(); got != want {
		t.Fatalf("busy-index divergence after [%s]: RunningRoots()=%d but reference (per-session activity) says %d busy roots "+
			"(tree: %s)\nsubtreeBusyCountDiff: %s",
			trace, got, want, dumpTree(s), subtreeBusyCountDiff(s))
	}
}

// TestBusyEquivalence_ReparentThenIdleNoPhantom is the CRUX regression for the
// live phantom. It reproduces the exact production sequence: a busy child is
// reparented across roots (busyCount's asymmetric site) and then goes idle.
// Pre-fix, busyCount[oldRoot] stranded at 1 → RunningRoots() reported a phantom
// 1 while every session was idle and subtreeBusyCount was 0 everywhere.
//
// Sequence:
//  1. roots R, R2; child C under R.
//  2. C busy  → subtree busy under R.
//  3. reparent C → R2 (subtreeBusyCount correct; busyCount[R] stranded pre-fix).
//  4. C idle  → only R2's count decrements; R's stranded phantom persists pre-fix.
//
// Post-fix, RunningRoots() must be 0 (no phantom) at every step, agreeing with
// per-session activity and subtreeBusyCount.
func TestBusyEquivalence_ReparentThenIdleNoPhantom(t *testing.T) {
	s := New(100)
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("R2", "")))
	s.Apply(ev("session.created", evSessionCreated("C", "R")))

	// C busy under R.
	s.Apply(ev("session.status", evStatus("C", "busy")))
	assertBusyIndexesAgree(t, s, "C busy under R")
	if got, want := s.RunningRoots(), 1; got != want {
		t.Fatalf("C busy under R: RunningRoots=%d want %d", got, want)
	}

	// Reparent C R→R2. subtreeBusyCount shifts R→0, R2→1. Pre-fix busyCount[R]
	// stayed 1 (the asymmetric gap) so RunningRoots over-reported 2 here.
	s.Apply(ev("session.updated", evSessionUpdated("C", "R2")))
	assertBusyIndexesAgree(t, s, "reparent C R→R2")
	if got, want := s.RunningRoots(), 1; got != want {
		t.Fatalf("after reparent C→R2: RunningRoots=%d want %d (R2's subtree busy; R idle)", got, want)
	}

	// C idle. Pre-fix this is the phantom: busyCount[R] stranded at 1 while
	// every session is idle and subtreeBusyCount is 0 on every root.
	s.Apply(ev("session.status", evStatus("C", "idle")))
	assertBusyIndexesAgree(t, s, "C idle after reparent (phantom check)")
	if got, want := s.RunningRoots(), 0; got != want {
		t.Fatalf("PHANTOM: after reparent-then-idle, RunningRoots=%d want %d (no session is busy anywhere)", got, want)
	}
}

// TestBusyEquivalence_PhantomStatusThenCreateNoStrayRoot pins the second
// asymmetric site: a session.status{busy} arriving for an id NOT YET in the
// live tree. Pre-fix the busyCount++ ran outside the live-tree guard, creating
// a stray busyCount[phantomID] entry that RunningRoots counted as a root even
// after the id was created as a CHILD (so it should never have been a root).
func TestBusyEquivalence_PhantomStatusThenCreateNoStrayRoot(t *testing.T) {
	s := New(100)
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// Phantom busy status for C before C exists.
	s.Apply(ev("session.status", evStatus("C", "busy")))
	// C must not be counted as a running root: it is not in the live tree.
	assertBusyIndexesAgree(t, s, "phantom status for unknown C")
	if got, want := s.RunningRoots(), 0; got != want {
		t.Fatalf("phantom busy status for unknown id must not create a running root: RunningRoots=%d want %d", got, want)
	}

	// Now create C as a CHILD of R. Its busy contribution belongs to R's subtree.
	s.Apply(ev("session.created", evSessionCreated("C", "R")))
	assertBusyIndexesAgree(t, s, "create C (busy) under R")
	if got, want := s.RunningRoots(), 1; got != want {
		t.Fatalf("C busy under R: RunningRoots=%d want %d", got, want)
	}

	// Idle C: R's subtree goes idle. No stray root entry should remain.
	s.Apply(ev("session.status", evStatus("C", "idle")))
	assertBusyIndexesAgree(t, s, "C idle (no stray phantom root)")
	if got, want := s.RunningRoots(), 0; got != want {
		t.Fatalf("PHANTOM: after phantom-status→create→idle, RunningRoots=%d want %d (stray root entry)", got, want)
	}
}

// TestBusyEquivalence_EveryTerminalTransition drives busy→terminal on every
// path identified in the root-cause analysis and asserts the three busy views
// agree (zero phantom) after each. Each subcase is independently seeded so a
// failure names the exact divergent transition.
func TestBusyEquivalence_EveryTerminalTransition(t *testing.T) {
	cases := []struct {
		name string
		// seed builds the initial busy state on a fresh store and returns it.
		seed func(s *Store)
		// terminal drives the busy subtree to a terminal/idle state.
		terminal func(s *Store)
	}{
		{
			name: "archive busy non-root child",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "busy")))
			},
			terminal: func(s *Store) {
				s.Apply(ev("session.updated", evSessionArchived("C")))
			},
		},
		{
			name: "RemoveSessions busy non-root child",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "busy")))
			},
			terminal: func(s *Store) {
				s.RemoveSessions([]string{"C"})
			},
		},
		{
			name: "archive busy root",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.status", evStatus("R", "busy")))
			},
			terminal: func(s *Store) {
				s.Apply(ev("session.updated", evSessionArchived("R")))
			},
		},
		{
			name: "delete busy root",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.status", evStatus("R", "busy")))
			},
			terminal: func(s *Store) {
				s.Apply(ev("session.deleted", evSessionDeleted("R")))
			},
		},
		{
			name: "delete busy non-root child",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "busy")))
			},
			terminal: func(s *Store) {
				s.Apply(ev("session.deleted", evSessionDeleted("C")))
			},
		},
		{
			name: "retry non-root child then idle",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "retry")))
			},
			terminal: func(s *Store) {
				s.Apply(ev("session.status", evStatus("C", "idle")))
			},
		},
		{
			name: "MarkIdle busy non-root child",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "busy")))
			},
			terminal: func(s *Store) {
				s.MarkIdle("C")
			},
		},
		{
			name: "SetActivityFromStatuses idle reconcile",
			seed: func(s *Store) {
				s.Apply(ev("session.created", evSessionCreated("R", "")))
				s.Apply(ev("session.created", evSessionCreated("C", "R")))
				s.Apply(ev("session.status", evStatus("C", "busy")))
			},
			terminal: func(s *Store) {
				// Empty status map → every known session reconciled to idle.
				s.SetActivityFromStatuses(map[string]json.RawMessage{})
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(100)
			defer s.Close()
			tc.seed(s)
			assertBusyIndexesAgree(t, s, tc.name+" [seed]")
			tc.terminal(s)
			// After the terminal transition the seeded busy subtree must be
			// fully idle → 0 running roots, no phantom, all three views agree.
			assertBusyIndexesAgree(t, s, tc.name+" [terminal]")
			if got, want := s.RunningRoots(), 0; got != want {
				t.Fatalf("%s: after terminal, RunningRoots=%d want %d", tc.name, got, want)
			}
			// Cross-check: the incremental subtreeBusyCount index is itself
			// correct (matches the independent reference) — a divergence here
			// would mean the bug moved rather than was eliminated.
			if diff := subtreeBusyCountDiff(s); diff != "" {
				t.Fatalf("%s: subtreeBusyCount diverged from reference after terminal: %s", tc.name, diff)
			}
		})
	}
}

// TestBusyEquivalence_RandomSequenceDifferential is the property-test sibling
// that strengthens TestSubtreeBusyCountProperty: after EVERY random mutation,
// Store.RunningRoots() must equal the independently-recomputed busy-root count.
// Pre-fix this caught the reparent/phantom divergence because RunningRoots read
// the divergent busyCount; post-fix RunningRoots derives from subtreeBusyCount
// so it agrees by construction (the assertion still pins the contract against
// future regressions). It reuses the same mutation driver as the subtreeBusy
// property test (applyRandomMutation), with a distinct base seed so the
// explored sequences differ from TestSubtreeBusyCountProperty's seed=1 run.
func TestBusyEquivalence_RandomSequenceDifferential(t *testing.T) {
	const (
		seqs  = 200
		steps = 40
		seed  = 7 // distinct from TestSubtreeBusyCountProperty's seed=1
	)
	t.Logf("busy-equivalence random differential: seqs=%d steps=%d seed=%d", seqs, steps, seed)
	for i := 0; i < seqs; i++ {
		runBusyEquivalenceSequence(t, seed+int64(i), steps)
	}
}

// runBusyEquivalenceSequence runs n random mutations (reusing the subtreeBusy
// property test's mutation driver) and asserts RunningRoots agrees with the
// reference after each. Mirrors runRandomSequence's setup (New(200),
// defer Close cancels any grace timers armed by the assistant-completed
// mutation so no async fire races a later test).
func runBusyEquivalenceSequence(t *testing.T, seed int64, n int) {
	t.Helper()
	s := New(200)
	defer s.Close()
	rng := rand.New(rand.NewSource(seed))
	env := newTestEnv()
	for step := 0; step < n; step++ {
		desc := applyRandomMutation(t, s, env, rng)
		trace := fmt.Sprintf("seq seed=%d step=%d: %s", seed, step, desc)
		// The load-bearing assertion: RunningRoots == reference busy-root count.
		assertBusyIndexesAgree(t, s, trace)
	}
}
