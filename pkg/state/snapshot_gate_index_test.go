package state

import "testing"

// TestSnapshotGateReadsSubtreeIndex is the M1 / L-05 standing-check (drift
// detector) for the canonical-subtreeBusyCount collapse.
//
// After the collapse, the snapshot/gate projection (GateFacts.SubtreeBusy) and
// SendableNow MUST source the subtree-busy fact from the maintained
// subtreeBusyCount index, not from an independent recompute. This test FAILS if:
//
//   - the gate value disagrees with subtreeBusyCount[id] > 0 (the projection
//     recomputed subtree busy independently instead of reading the index), or
//   - the gate value disagrees with the now-test/reference-only
//     computeSubtreeBusyLocked recompute — keeping that recompute genuinely
//     differential and pinning the {Busy,Retry} classification both authorities
//     share, or
//   - the index itself drifted from the reference recompute (an index
//     maintenance regression).
//
// The tree is non-trivial: a mix of busy, retry, idle, a multi-level cascade,
// and an ActivityError carve-out (error is NOT busy/retry in either authority).
func TestSnapshotGateReadsSubtreeIndex(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idle1","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grand","parentID":"idle1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"err","parentID":"root"}}`))

	// child busy + grand retry make root/idle1/child/grand subtrees busy.
	s.Apply(ev("session.status", `{"sessionID":"child","status":{"type":"busy"}}`))
	s.Apply(ev("session.status", `{"sessionID":"grand","status":{"type":"retry"}}`))
	// ActivityError carve-out: set via the internal chokepoint (session.status
	// normalizes "error"→idle). error must NOT count as busy/retry in EITHER
	// authority, so err's subtree stays idle despite err's non-idle activity.
	s.mu.Lock()
	s.setActivityLocked("err", ActivityError)
	s.mu.Unlock()

	// Snapshot the two authorities in ONE read-lock span (avoid recursive
	// RLock via copySubtreeBusyCount) for a race-clean comparison.
	s.mu.RLock()
	idx := make(map[string]int, len(s.subtreeBusyCount))
	for k, v := range s.subtreeBusyCount {
		idx[k] = v
	}
	ref := s.computeSubtreeBusyLocked() // test/reference-only differential recompute
	s.mu.RUnlock()

	snap := s.Snapshot(nil)

	// Expected per-node subtree-busy:
	//   root   = true  (child busy, grand retry)
	//   child  = true  (self busy)
	//   idle1  = true  (grand retry)
	//   grand  = true  (self retry)
	//   err    = false (ActivityError carve-out; no busy descendants)
	want := map[string]bool{
		"root":  true,
		"child": true,
		"idle1": true,
		"grand": true,
		"err":   false,
	}
	for id, w := range want {
		gate := snap.Gate[id].SubtreeBusy
		fromIndex := idx[id] > 0
		if gate != fromIndex {
			t.Errorf("session %q: gate=%v but index=%v — gate did not read the maintained index (want=%v)",
				id, gate, fromIndex, w)
		}
		if fromIndex != ref[id] {
			t.Errorf("session %q: index(%v) disagrees with reference recompute(%v) — index maintenance drifted",
				id, fromIndex, ref[id])
		}
		if gate != w {
			t.Errorf("session %q: gate=%v want=%v", id, gate, w)
		}
	}

	// SendableNow — the third retargeted caller — must also read the index.
	// root is otherwise sendable (idle, no inflight assistant turn, no pending
	// question/permission), so its sendability is governed SOLELY by subtree
	// busy: blocked while the subtree is busy, free once it quiesces.
	if sendable, _, exists := s.SendableNow("root"); !exists || sendable {
		t.Errorf("root with a busy subtree must be non-sendable; got sendable=%v exists=%v", sendable, exists)
	}
	s.Apply(ev("session.idle", `{"sessionID":"child"}`))
	s.Apply(ev("session.idle", `{"sessionID":"grand"}`))
	if sendable, _, exists := s.SendableNow("root"); !exists || !sendable {
		t.Errorf("root with a quiesced subtree must be sendable; got sendable=%v exists=%v", sendable, exists)
	}
}
