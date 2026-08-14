package state

// Regression tests for the transcript "missing middle" bug (observed live on
// ses_0aad61b2bffeVy4HNWjnI0dr1A, 834 msgs): in sessions with MORE than
// WindowMaxCount messages, a full-history re-hydration (the reconnect//vh/reload
// path) corrupted sm.order because reconcileMessagesLocked BLIND-APPENDED every
// non-resident fetched id to the END of sm.order. The bounded cold load had
// already resident the newest WindowMaxCount, so the full fetch's ~730 OLDER
// messages landed AFTER the newer tail → [newest-100][older-730][live]. Every
// last=newest consumer (projectMessageWindow, projectMessagePage,
// latestAssistantResidentLocked, ...) then served an old block followed by live
// messages with the true recent middle unreachable.
//
// The pinned invariant: after ANY hydrate/reconcile + live append, the window
// and page projections equal the TRUE chronological newest messages, and
// sm.order is chronological by time.created (NEVER by string message id —
// opencode's ascending id scheme wrapped globally on 2026-08-14, so id ordering
// is not a chronological key).

import (
	"encoding/json"
	"fmt"
	"testing"
)

// ordMsg builds a MessageWithParts whose info carries a DISTINCT time.created
// (unix-ms). time.created is the only chronological key used by the fix.
func ordMsg(id string, createdMs int64) MessageWithParts {
	info := json.RawMessage(fmt.Sprintf(`{"id":%q,"sessionID":"s","role":"user","time":{"created":%d}}`, id, createdMs))
	part := json.RawMessage(`{"id":"` + id + `-p0","type":"text","text":"x"}`)
	return MessageWithParts{Info: info, Parts: []json.RawMessage{part}}
}

// ordMsgAssistant is ordMsg with role=assistant + completed + a text part, so
// the messages-loaded gate has a resident newest assistant (mirrors real
// transcripts, where user/assistant alternate).
func ordMsgAssistant(id string, createdMs int64) MessageWithParts {
	info := json.RawMessage(fmt.Sprintf(`{"id":%q,"sessionID":"s","role":"assistant","time":{"created":%d,"completed":%d},"finish":"stop"}`, id, createdMs, createdMs+500))
	part := json.RawMessage(`{"id":"` + id + `-p0","type":"text","text":"x"}`)
	return MessageWithParts{Info: info, Parts: []json.RawMessage{part}}
}

// ordList builds m1..mN (oldest-first) alternating user/assistant, with
// strictly increasing time.created starting at baseMs.
func ordList(baseMs int64, n int) []MessageWithParts {
	out := make([]MessageWithParts, n)
	for i := 0; i < n; i++ {
		if i%2 == 1 {
			out[i] = ordMsgAssistant(fmt.Sprintf("m%d", i+1), baseMs+int64(i)*1000)
		} else {
			out[i] = ordMsg(fmt.Sprintf("m%d", i+1), baseMs+int64(i)*1000)
		}
	}
	return out
}

// seqIDs builds the expected id list ["m<from>".."m<to>"], inclusive.
func seqIDs(from, to int) []string {
	out := make([]string, 0, to-from+1)
	for i := from; i <= to; i++ {
		out = append(out, fmt.Sprintf("m%d", i))
	}
	return out
}

// assertOrderChronological fails unless sm.order's time.created keys are
// non-decreasing (keyless placeholder entries — no info yet — are tolerated at
// the END only, matching their append-only insertion).
func assertOrderChronological(t *testing.T, s *Store, sid string) {
	t.Helper()
	s.mu.RLock()
	defer s.mu.RUnlock()
	sm := s.messages[sid]
	if sm == nil {
		t.Fatalf("session %s: no message state", sid)
	}
	prev := -1.0
	for i, id := range sm.order {
		me := sm.byID[id]
		if me == nil {
			continue // defensive
		}
		created, ok := messageCreatedFromInfo(me.info)
		if !ok {
			continue // keyless placeholder (part-before-info); excluded from the key check
		}
		if created < prev {
			t.Fatalf("sm.order not chronological at [%d] id=%s: created %v after %v", i, id, created, prev)
		}
		prev = created
	}
}

// TestHydrateFullHistoryAfterBoundedColdLoadKeepsTrueNewestWindow is THE
// regression test for the missing-middle bug. It reproduces the exact observed
// sequence — bounded cold load (≤ WindowMaxCount newest) → full-history hydrate
// (as every OpenCode event-stream reconnect does) → live append — and pins the
// end-state invariant: window/page projections equal the true chronological
// newest messages.
func TestHydrateFullHistoryAfterBoundedColdLoadKeepsTrueNewestWindow(t *testing.T) {
	// Small canary first: the corruption is independent of WindowMaxCount —
	// ANY strict-newest resident subset followed by a full-history reconcile
	// corrupts under blind-append. 6 messages, resident tail = newest 3.
	t.Run("small-canary", func(t *testing.T) {
		const n = 6
		full := ordList(1_786_000_000_000, n)
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))

		// Bounded cold load: newest 3 only (m4..m6).
		st.SetSessionMessages("s", append([]MessageWithParts(nil), full[n-3:]...))

		// Reconnect hydrate: FULL history (m1..m6). Pre-fix this appended
		// m1..m3 AFTER m4..m6.
		st.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"s","title":"S"}`)},
			map[string][]MessageWithParts{"s": append([]MessageWithParts(nil), full...)})

		// Live append newer than everything fetched.
		st.Apply(ev("message.updated", `{"info":{"id":"mLive","sessionID":"s","role":"user","time":{"created":1786000006000}}}`))

		assertOrderChronological(t, st, "s")
		if got, want := len(st.messages["s"].order), n+1; got != want {
			t.Fatalf("resident count: want %d, got %d", want, got)
		}
		// The snapshot window must be fully chronological, newest last.
		win := st.Snapshot(map[string]bool{"s": true}).Messages["s"]
		if got, want := msgIDs(win), []string{"m1", "m2", "m3", "m4", "m5", "m6", "mLive"}; !equalStrings(got, want) {
			t.Fatalf("snapshot window: want %v, got %v (missing-middle corruption)", want, got)
		}
	})

	// The realistic shape: total > WindowMaxCount, cold load bounded to the
	// newest WindowMaxCount, then the full-history reconnect hydrate, then a
	// live append — exactly the observed ses_0aad61b2 sequence.
	t.Run("over-window-max", func(t *testing.T) {
		total := WindowMaxCount + 50 // 150 > 100 → the cold-load tail is a strict subset
		const baseMs = 1_786_000_000_000
		full := ordList(baseMs, total)
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))

		// 1. Bounded cold load: SetSessionMessages with the newest
		//    WindowMaxCount only (what MessagesTail(sid, WindowMaxCount)
		//    serves) → resident m51..m150.
		st.SetSessionMessages("s", append([]MessageWithParts(nil), full[total-WindowMaxCount:]...))

		// 2. Reconnect hydrate: FULL history for every loaded session (what
		//    a.client.Messages serves; the pre-fix reconcile appended the
		//    fetched m1..m50 AFTER the m51..m150 tail).
		st.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"s","title":"S"}`)},
			map[string][]MessageWithParts{"s": append([]MessageWithParts(nil), full...)})

		// 3. Live append: a message newer than everything fetched.
		liveMs := baseMs + int64(total)*1000
		st.Apply(ev("message.updated", fmt.Sprintf(`{"info":{"id":"mLive","sessionID":"s","role":"user","time":{"created":%d}}}`, liveMs)))

		// sm.order must be the full chronological transcript m1..m150, mLive.
		assertOrderChronological(t, st, "s")
		st.mu.RLock()
		got := append([]string(nil), st.messages["s"].order...)
		st.mu.RUnlock()
		want := append(seqIDs(1, total), "mLive")
		if !equalStrings(got, want) {
			t.Fatalf("sm.order: want chronological %v.., got %v.. (order corrupted by full-history hydrate)", want[:3], got[:3])
		}

		// The served /vh/snapshot window = the TRUE newest WindowMaxCount:
		// m52..m150 + mLive, oldest-first.
		win := st.Snapshot(map[string]bool{"s": true}).Messages["s"]
		if len(win) != WindowMaxCount {
			t.Fatalf("window count: want %d, got %d", WindowMaxCount, len(win))
		}
		if got, want := msgIDs(win), append(seqIDs(52, total), "mLive"); !equalStrings(got, want) {
			t.Fatalf("snapshot window: want newest %v (m52 first), got %v (missing middle)", want[:3], got[:3])
		}

		// The historical page anchored mid-transcript returns the TRUE older
		// block: before=m120, limit=30 → m91..m120 inclusive overlap.
		page := st.SnapshotMessagesPage("s", "m120", 30, 1<<20)
		if !page.BoundaryFound {
			t.Fatal("page boundary_found: want true (m120 resident)")
		}
		if got, want := msgIDs(page.Items), seqIDs(91, 120); !equalStrings(got, want) {
			t.Fatalf("page before=m120: want %v, got %v", want, got)
		}

		// Idempotence: a SECOND full-history hydrate (upsert-only reconcile)
		// must not disturb the order.
		st.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"s","title":"S"}`)},
			map[string][]MessageWithParts{"s": append([]MessageWithParts(nil), full...)})
		assertOrderChronological(t, st, "s")
		st.mu.RLock()
		got2 := append([]string(nil), st.messages["s"].order...)
		st.mu.RUnlock()
		if !equalStrings(got2, want) {
			t.Fatalf("second hydrate disturbed order: want %v.., got %v..", want[:3], got2[:3])
		}
	})
}

// TestReconcileInsertStableForEqualCreated pins the tie behavior: messages
// sharing time.created keep LISTING order (the opencode listing is
// chronological oldest-first). The tiebreak is arrival/listing order — never
// string-id ordering (wrap hazard).
func TestReconcileInsertStableForEqualCreated(t *testing.T) {
	const baseMs = 1_786_000_000_000
	full := ordList(baseMs, 4) // m1..m4, created = base+0k..base+3k
	// m50a / m50b share created = base+1_500 (strictly between m2's base+1k
	// and m3's base+2k) but arrive LAST in the fetched listing — the shape
	// that separates ordered insert from blind-append.
	tieMs := int64(baseMs + 1_500)
	older := []MessageWithParts{ordMsg("m50a", tieMs), ordMsg("m50b", tieMs)}
	list := append(append([]MessageWithParts(nil), full...), older...)

	st := New(1024)
	st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
	// Cold load resident = m1..m4 (the newest four).
	st.SetSessionMessages("s", append([]MessageWithParts(nil), full...))
	// Hydrate delivers the whole list; m50a/m50b are non-resident with a
	// created BETWEEN residents — they must insert between m2 and m3 in
	// listing order, not append after m4.
	st.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"s","title":"S"}`)},
		map[string][]MessageWithParts{"s": list})

	assertOrderChronological(t, st, "s")
	st.mu.RLock()
	got := append([]string(nil), st.messages["s"].order...)
	st.mu.RUnlock()
	// m1=(base+0k) m2=(base+1k) m50a=m50b=(base+1.5k) m3=(base+2k) m4=(base+3k).
	want := []string{"m1", "m2", "m50a", "m50b", "m3", "m4"}
	if !equalStrings(got, want) {
		t.Fatalf("tie insert: want %v, got %v", want, got)
	}
}
