package state

// The deltaBuf-survives-reconcile guard (reconcileMessagesLocked's
// `if !(coldLoad && len(me.liveTouchedParts) > 0)` discard branch) fires only
// when delta text is STILL UNFLUSHED in the accumulator at reconcile time: a
// flushed part is protected by the per-part body guard alone, and every
// Snapshot read flushes the accumulator, so the pkg/web integration tests can
// never observe this branch (see the NOTE at pkg/web/integration_test.go on
// TestStreamAsyncHydrationDeltaPrecedenceDuringFetch). This file closes that
// gap from inside the package: withFlushInterval(time.Hour) keeps the second
// delta unflushed deterministically, so the cold reconcile runs while the
// accumulator still holds live text the stale fetched body must not discard.

import (
	"encoding/json"
	"testing"
	"time"
)

// staleColdFetch builds the fetched cold-load list: m1/p1 with the pre-live
// "fetched-stale" body the reconcile must not let win over live text.
func staleColdFetch() []MessageWithParts {
	return []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m1","sessionID":"a","role":"user","time":{"created":1}}`),
		Parts: []json.RawMessage{
			json.RawMessage(`{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"fetched-stale"}`),
		},
	}}
}

// seedColdStreamingSession builds the "mid-cold-fetch streaming" state: part
// p1 of message m1 carries a live-accumulated deltaBuf whose FIRST delta
// flushed ("live-" — first delta of a burst always flushes) but whose second
// ("newer") is still unflushed (throttled at time.Hour). me.parts lags the
// accumulator — exactly the state a cold reconcile can catch mid-throttle.
// coldWindow controls whether the deltas arrive INSIDE a cold-fetch window
// (MarkColdFetchStart set → appendPartDeltaLocked tags liveTouchedParts) or
// outside it (no tag — the negative control).
func seedColdStreamingSession(s *Store, coldWindow bool) {
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"A"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":""}}`))
	if coldWindow {
		s.MarkColdFetchStart("a")
	}
	applyDelta(s, "a", "m1", "p1", "text", "live-")
	applyDelta(s, "a", "m1", "p1", "text", "newer")
}

// TestColdReconcilePreservesUnflushedDeltaBuf pins the deltaBuf guard: on a
// cold-load reconcile whose fetched part body is stale, UNFLUSHED accumulator
// text that was live-tagged during the fetch window must survive the
// reconcile — the discard branch (`me.deltaBuf = nil`) must NOT run — and the
// stale fetched body must not overwrite the part. This is the pkg/state
// closure of the branch the pkg/web delta-precedence test cannot reach
// (Snapshot reads flush the accumulator there, so only the already-flushed
// part-body guard is observable in that package).
func TestColdReconcilePreservesUnflushedDeltaBuf(t *testing.T) {
	s := mustNew(t, withFlushInterval(DefaultConfig(1000), time.Hour))
	seedColdStreamingSession(s, true)

	// Preconditions (same-package read under RLock): the accumulator holds
	// "live-newer" UNFLUSHED while me.parts lags at "live-", and p1 is
	// live-touched (tagged because coldFetchActive was set when the deltas
	// arrived). If the throttle ever regressed to flushing every delta, the
	// precondition fails here and the test must be rebuilt around whatever
	// keeps text unflushed — it must never silently pass via a flush.
	s.mu.RLock()
	me := s.messages["a"].byID["m1"]
	if buf := me.deltaBuf["p1\x00text"]; buf == nil || buf.String() != "live-newer" {
		t.Fatalf("precondition: unflushed deltaBuf want %q, got %v", "live-newer", buf)
	}
	if txt := partTextFromRaw(t, me.parts["p1"]); txt != "live-" {
		t.Fatalf("precondition: flushed part text want %q (accumulator must be AHEAD of me.parts), got %q", "live-", txt)
	}
	if !me.liveTouchedParts["p1"] {
		t.Fatal("precondition: p1 must be live-touched (coldFetchActive was set when the deltas applied)")
	}
	s.mu.RUnlock()

	// The cold reconcile through the production entrypoint (aggregator cold
	// load with cursor exhaustion evidence), fetched body stale vs the live
	// accumulator.
	res := s.SetSessionMessagesExhausted("a", staleColdFetch(), true)
	if res.Status != ColdBatchEmitted {
		t.Fatalf("cold batch status: want ColdBatchEmitted, got %v", res.Status)
	}

	// THE GUARD (deltaBuf survives): the discard branch did NOT run — the
	// accumulator still holds the unflushed live text. (Accumulators are kept
	// across flushes, so this holds even if the cold-batch capture flushed
	// the text into me.parts on its way out.)
	s.mu.RLock()
	me = s.messages["a"].byID["m1"]
	if buf := me.deltaBuf["p1\x00text"]; buf == nil || buf.String() != "live-newer" {
		t.Fatalf("deltaBuf guard failed: unflushed accumulator discarded by cold reconcile (want %q, got %v)", "live-newer", buf)
	}
	if txt := partTextFromRaw(t, me.parts["p1"]); txt == "fetched-stale" {
		t.Fatal("part-body guard failed: stale fetched body overwrote the live part")
	}
	s.mu.RUnlock()

	// User-visible outcome: the preserved accumulator carries the live text
	// past the reconcile — the next projection materializes "live-newer", not
	// "fetched-stale" and not the lagging flushed base "live-".
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "live-newer" {
		t.Fatalf("post-reconcile projection: want %q, got %q", "live-newer", got)
	}
}

// TestColdReconcileDiscardsDeltaBufWithoutLiveTouch is the in-test NEGATIVE
// CONTROL for the guard above: identical streaming state, but the deltas
// arrive OUTSIDE any cold-fetch window (no MarkColdFetchStart), so nothing is
// live-touched and the cold reconcile takes the discard branch — the
// accumulator is dropped and the fetched body is authoritative. Pinning both
// directions proves the positive test discriminates the guard itself, not
// some incidental accumulator survival.
func TestColdReconcileDiscardsDeltaBufWithoutLiveTouch(t *testing.T) {
	s := mustNew(t, withFlushInterval(DefaultConfig(1000), time.Hour))
	seedColdStreamingSession(s, false)

	res := s.SetSessionMessagesExhausted("a", staleColdFetch(), true)
	if res.Status != ColdBatchEmitted {
		t.Fatalf("cold batch status: want ColdBatchEmitted, got %v", res.Status)
	}

	s.mu.RLock()
	me := s.messages["a"].byID["m1"]
	if len(me.deltaBuf) != 0 {
		t.Fatalf("negative control: deltaBuf must be discarded without live-touch, still holds %d entries", len(me.deltaBuf))
	}
	if txt := partTextFromRaw(t, me.parts["p1"]); txt != "fetched-stale" {
		t.Fatalf("negative control: fetched body must be authoritative without live-touch, got %q", txt)
	}
	s.mu.RUnlock()
}
