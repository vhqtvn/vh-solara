package state

import (
	"encoding/json"
	"testing"
)

// TestMessagesLoadedInProgressNewestMasksOlderCompletedEmpty settles card
// defer-s5-d-f1-resident-masking. The question: when a session's resident
// messages contain an OLDER COMPLETED assistant with ZERO parts (the gap the
// re-fetch guard exists to recover — "completed" does NOT imply "has all
// parts"; the same class as the activity-idle path that stamps time.completed
// WITHOUT adding parts) AND a NEWER IN-PROGRESS assistant (no time.completed,
// parts still streaming), does IsMessagesLoaded mask the gap to true?
//
// The masking site is latestAssistantResidentLocked's newest->oldest walk: it
// returns on the FIRST assistant it meets. If that first assistant is the newer
// in-progress one, the `!completed -> return true` branch fires before the
// older completed-empty assistant is ever examined — masking its 0-parts gap.
//
// Per the function's own contract ("false when the newest COMPLETED assistant
// message has zero resident parts") the correct result here is FALSE: the
// newest COMPLETED assistant is the OLDER message, which has zero parts, so the
// session is NOT resident and the open path must re-fetch to recover the parts.
func TestMessagesLoadedInProgressNewestMasksOlderCompletedEmpty(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// Resident set: OLDER completed assistant with 0 parts (the gap), then a
	// NEWER in-progress assistant (no time.completed). Slice order == sm.order
	// == creation order, so the newest->oldest walk meets "newer" first.
	s.SetSessionMessages(sid, []MessageWithParts{
		{
			Info: json.RawMessage(`{"id":"older","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
			// no Parts — a completed assistant whose parts were never fetched
		},
		{
			Info: json.RawMessage(`{"id":"newer","sessionID":"sess","role":"assistant","time":{"created":5}}`),
			// no time.completed -> in-progress; no Parts
		},
	})

	// CONTRACT: the OLDER completed assistant has zero resident parts, so the
	// session is not messages-loaded — the open path must re-fetch to recover
	// the missing parts. The newer in-progress assistant must NOT mask this gap.
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE: the older completed assistant has 0 resident parts (the newer in-progress assistant must not mask the gap)")
	}
	if g := s.Snapshot(nil).Gate[sid]; g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be FALSE: the older completed assistant has 0 resident parts (newer in-progress must not mask)")
	}
}
