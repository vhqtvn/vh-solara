// message_window_msgrev_aba_test.go — the msgRev ABA characterization for the
// DELETE race, card task-2026-11-07t15-07-21-store-merge-verify-first
// (verify-first stage 1, deliverable 3c). BINDING design basis:
// tmp/agent-runs/store-merge/eligibility.md (Q1 caller-2 receipts; Q3 case 3c).
//
// GUARD LOCATION (located from code; the research's recollection — "server-side
// ABA guard on messages.batch" — MATCHES the code): the guard is
// publishColdBatch's Discipline-B double-lock capture-validate loop in
// pkg/state/message_window.go (captureMessagesBatchLocked captures the
// projection + msgRev[sid] under s.mu; packaging runs outside the lock; the
// re-acquire validates s.msgRev[sid] == captured token and DISCARDS on
// mismatch). deletePartLocked bumps msgRev on every part deletion
// (reducers.go deletePartLocked → bumpMsgRev), so a delete racing the package
// invalidates the captured projection.
//
// CONTRACT PINNED ("a stale-msgRev batch replay must not apply"): the CLIENT
// batch consumer (web/src/sync/reducers.ts messages.batch →
// prependMessagesIfAbsent) merge-if-absents whatever arrives — the merge alone
// cannot distinguish a pre-delete capture from a post-delete one. The ONLY
// thing preventing a pre-delete capture from resurrecting a deleted part on
// every cold client is this server-side guard discarding it BEFORE emission.
// This test pins that enforcement point: a batch captured while a message
// still had BOTH parts, raced by the deletion of ONE of them, must NEVER be
// emitted — the repackage carries exactly the surviving part, byte-faithful.
//
// Distinction from the existing cold-batch staleness tests (store_test.go):
// TestColdBatchInvalidatedByPartRemoved deletes the ONLY part of the ONLY
// message and asserts part-count 0; TestColdBatchDiscardsStaleAfterConcurrent
// Mutation races a part UPDATE. THIS test is the MULTI-PART resurrection
// shape: one of two parts deleted mid-packaging → the emitted batch carries
// the SURVIVOR with its live body and omits the deleted sibling — the exact
// no-resurrection input the client-side merge (and any future admission
// widening of it, eligibility Q4 invariant 4) depends on.
package state

import (
	"encoding/json"
	"testing"
)

// seedTwoPartSession seeds sid with one assistant message m1 carrying p1
// ("KEEP") + p2 ("DOOMED") — the seedOnePartSession shape extended to the
// multi-part resurrection fixture.
func seedTwoPartSession(s *Store, sid string) {
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"`+sid+`","messageID":"m1","type":"text","text":"KEEP"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p2","sessionID":"`+sid+`","messageID":"m1","type":"text","text":"DOOMED"}}`))
}

// TestColdBatchMsgRevDeleteRaceNeverEmitsPreDeleteCapture: the msgRev ABA
// guard must never emit a batch whose capture predates a part deletion.
//
// Mechanism (via the coldBatchAfterCaptureHook seam — the shared
// startBlockedColdBatch primitive):
//  1. publishColdBatch (goroutine) captures the projection carrying m1 with
//     p1+p2, releases the lock, and BLOCKS in the hook before packaging.
//  2. The main goroutine applies message.part.removed for p2 —
//     deletePartLocked removes the part AND bumps msgRev[sid].
//  3. The hook is released; validation re-reads msgRev[sid], sees it changed,
//     DISCARDS the stale capture (the pre-delete projection), and the retry
//     captures the post-delete state, which validates and is emitted.
//
// Assertions: exactly ONE batch emitted (the stale capture never landed); its
// single message m1 carries p1 with text "KEEP" (byte-faithful survivor) and
// p2 ZERO times (no pre-delete resurrection shape can ever reach a client).
func TestColdBatchMsgRevDeleteRaceNeverEmitsPreDeleteCapture(t *testing.T) {
	s := New(100)
	seedTwoPartSession(s, "aba")
	ch, unsub := s.Subscribe(256) // firehose: see every message-class event
	defer unsub()
	drainAll(ch) // drop subscribe-time backlog

	capturedCh, releaseCh := startBlockedColdBatch(t, "aba")
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("aba")
		close(done)
	}()
	<-capturedCh // the pre-delete projection (p1+p2) is captured; packaging blocked

	// The racing delete: server processes it mid-packaging. deletePartLocked
	// bumps msgRev — the stale capture's token no longer matches.
	s.Apply(ev("message.part.removed", `{"sessionID":"aba","messageID":"m1","partID":"p2"}`))

	close(releaseCh)
	<-done // publishColdBatch returned → a revision-valid batch was published

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch (pre-delete capture discarded), got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message (m1), got %d", len(msgs))
	}
	var keepCount, doomedCount, totalParts int
	for _, part := range msgs[0].Parts {
		var pe struct {
			ID   string `json:"id"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(part, &pe); err != nil {
			t.Fatalf("unmarshal part: %v", err)
		}
		totalParts++
		switch pe.ID {
		case "p1":
			keepCount++
			if pe.Text != "KEEP" {
				t.Fatalf("survivor p1 body: want KEEP, got %q", pe.Text)
			}
		case "p2":
			doomedCount++
		}
	}
	if totalParts != 1 || keepCount != 1 {
		t.Fatalf("want exactly the survivor p1, got %d part(s), p1 ×%d", totalParts, keepCount)
	}
	if doomedCount != 0 {
		t.Fatalf("deleted part p2 leaked into the emitted batch %d time(s) — a stale-msgRev replay reached emission", doomedCount)
	}
}
