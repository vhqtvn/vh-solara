package web

// stream_epoch_handshake_test.go — F1 follow-up to the P2 re-seed fix: the
// epoch handshake on stream opens. P2 (d85a7cc) closed the cursor > head
// window (a cursor from a previous daemon lifetime that sits ABOVE the
// restarted-low head). This slice closes the REMAINING window: a cursor from
// a previous store lifetime that sits BELOW the current head — numerically
// replayable, so the old code served a plausible-but-wrong delta replay over
// state from the dead store while the client silently missed the new store's
// re-hydration and appeared converged.
//
// The contract (docs/design/server-owned-tree.md §5.5 item 3): the client
// declares its epoch on stream opens (&epoch=<Snapshot.epoch>, omitted when
// unknown); the server treats a DECLARED epoch that differs from the store's
// lifetime epoch as not-replayable — the same fresh fallback P2 established
// (snapshot + message-load kick on session streams, ringGap-stamped partial
// re-seed trio on tree streams) — journaled as fallback_reason=epoch_mismatch.
//
// Branch coverage (the slice's declared risk is the resume-cursor precedence
// chain, so ordinary reconnects are pinned FIRST):
//
//   epoch match + valid cursor  — replay branch, unchanged (the handshake
//                                 must NOT disturb same-epoch resume).
//   epoch ABSENT + valid cursor — byte-identical old behavior (old clients,
//                                 first connects; strictly additive change).
//                                 The cursor > head case with an absent epoch
//                                 stays pinned by the P2 tests
//                                 (TestSessionStream_FreshSnapshotOnStaleEpochCursor,
//                                 TestTreeResume_StaleEpochCursorFreshFallback).
//   epoch MISMATCH + cursor<head — fresh fallback + triggerMessageLoad +
//                                 fallback_reason=epoch_mismatch (the crux;
//                                 RED against the pre-fix server which takes
//                                 the replay branch here).
//   epoch MISMATCH + cursor>head — epoch_mismatch WINS the discriminator
//                                 (a mismatched cursor is meaningless against
//                                 this store regardless of its numeric side).
//   tree=2 mismatch             — full re-seed trio, partial.ringGap stamped
//                                 (the D1 site: hasCursor && !replayOK), and
//                                 NO tree.op replay of post-cursor deltas.
//
// Plus the P4 "stream open" journal line now carries the RAW epoch param
// (client-shape evidence, mirroring the raw cursor string).

import (
	"bufio"
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// openSessionStreamEpoch opens /vh/stream?sessions=<sid> with an optional
// cursor and an optional declared epoch, deadline-bounded. Mirrors
// openSessionStreamReq (session_stream_replay_test.go) with the epoch param
// added; kept local so the P2 helper stays byte-for-byte.
func openSessionStreamEpoch(t *testing.T, webURL, sid string, cursor uint64, hasCursor bool, epoch string, deadline time.Duration) (*bufio.Reader, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	t.Cleanup(cancel)
	url := webURL + "/vh/stream?sessions=" + sid
	if hasCursor {
		url += "&cursor=" + strconv.FormatUint(cursor, 10)
	}
	if epoch != "" {
		url += "&epoch=" + epoch
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewReader(resp.Body), cancel
}

// TestStreamEpoch_MatchValidCursorReplays — a DECLARED epoch that matches the
// store's lifetime epoch changes nothing: the reconnect takes the ordinary
// replay branch (deltas from the ring, NOT a fresh snapshot). This is the
// precedence-chain pin: the handshake must only ever flip cross-lifetime
// cursors.
func TestStreamEpoch_MatchValidCursorReplays(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	cursor := srv.agg.Store().Head()
	// Advance head past the cursor so the replay window is non-empty.
	srv.agg.Store().Apply(statusBusyEvent("s1"))
	if srv.agg.Store().Head() <= cursor {
		t.Fatalf("setup: head %d must exceed cursor %d", srv.agg.Store().Head(), cursor)
	}

	lines := captureBaselines(t, func() {
		reader, _ := openSessionStreamEpoch(t, web.URL, "s1", cursor, true, srv.agg.Store().Epoch(), 500*time.Millisecond)
		first := firstFrameEvent(t, reader)
		if first == "snapshot" {
			t.Fatal("epoch match + valid cursor: want REPLAY (delta event), got snapshot — the handshake must not flip same-epoch resume")
		}
		if first != "status" && first != "activity" {
			t.Fatalf("epoch match + valid cursor: want first replayed event 'status' or 'activity', got %q", first)
		}
	})

	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=replay") || !strings.Contains(line, "fallback_reason=none") {
		t.Errorf("epoch match: journal must say path=replay fallback_reason=none: %q", line)
	}
}

// TestStreamEpoch_AbsentParamStillReplays — an ABSENT epoch param (old client
// build, or a first-ever connect) with a valid cursor below head keeps the
// exact pre-change behavior: the replay branch. Strictly-additive pin.
func TestStreamEpoch_AbsentParamStillReplays(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	cursor := srv.agg.Store().Head()
	srv.agg.Store().Apply(statusBusyEvent("s1"))

	reader, _ := openSessionStreamEpoch(t, web.URL, "s1", cursor, true, "", 500*time.Millisecond)
	first := firstFrameEvent(t, reader)
	if first == "snapshot" {
		t.Fatal("absent epoch + valid cursor: want REPLAY (byte-identical old behavior), got snapshot")
	}
	if first != "status" && first != "activity" {
		t.Fatalf("absent epoch + valid cursor: want 'status' or 'activity', got %q", first)
	}
}

// TestStreamEpoch_MismatchBelowHeadFreshFallback — THE CRUX. A cursor from a
// previous store lifetime that sits numerically BELOW the current head is
// exactly the case the ring comparison cannot see (it looks replayable): the
// server MUST NOT serve the plausible-but-wrong delta replay over the dead
// store's history — it must force the fresh fallback (authoritative snapshot
// + the message-load kick) with journal attribution
// fallback_reason=epoch_mismatch.
//
// Red-first: against the pre-fix server this connect takes the replay branch
// (first frame is a replayed delta, not a snapshot) and the journal says
// path=replay fallback_reason=none.
func TestStreamEpoch_MismatchBelowHeadFreshFallback(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	fake.setMessage("s1", `[{"info":{"id":"m1","sessionID":"s1","role":"user"},"parts":[{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":"hi"}]}]`)

	// A cursor from the PREVIOUS daemon lifetime — numerically below head.
	cursor := srv.agg.Store().Head()
	srv.agg.Store().Apply(statusBusyEvent("s1"))
	srv.agg.Store().Apply(statusBusyEvent("s1"))
	if srv.agg.Store().Head() <= cursor {
		t.Fatalf("setup: head %d must exceed cursor %d (the plausible-but-wrong window)", srv.agg.Store().Head(), cursor)
	}

	sawLoaded := false
	lines := captureBaselines(t, func() {
		reader, _ := openSessionStreamEpoch(t, web.URL, "s1", cursor, true, "previous-store-lifetime", 3*time.Second)

		if first := firstFrameEvent(t, reader); first != "snapshot" {
			t.Fatalf("epoch mismatch + cursor<head: want first frame 'snapshot' (fresh re-seed), got %q — the server replayed a cross-lifetime cursor", first)
		}
		// triggerMessageLoad fired: the async fetch's messages.loaded
		// completion flows on THIS connection (the message-load kick the
		// frozen-transcript incident was missing).
		for {
			ev, _ := readSSEFrameSilent(reader)
			if ev == "" {
				break
			}
			if ev == "messages.loaded" {
				sawLoaded = true
				break
			}
		}
		if !sawLoaded {
			t.Fatal("epoch mismatch: messages.loaded never arrived — triggerMessageLoad did not fire on the fresh fallback")
		}
	})
	waitFor(t, func() bool { return fake.msgGetsCount("s1") > 0 },
		"epoch mismatch: message GET reached the fake (triggerMessageLoad)")

	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") {
		t.Errorf("epoch mismatch: journal must say path=fresh: %q", line)
	}
	if !strings.Contains(line, "fallback_reason=epoch_mismatch") {
		t.Errorf("epoch mismatch: journal must attribute fallback_reason=epoch_mismatch: %q", line)
	}
	if !strings.Contains(line, "had_cursor=true") {
		t.Errorf("epoch mismatch: had_cursor must be true: %q", line)
	}
}

// TestStreamEpoch_MismatchBeatsCursorExceedsHead — when the declared epoch
// mismatches AND the cursor exceeds head (both discriminators apply), the
// epoch arm wins: the mismatch is the more fundamental cause (the cursor is
// meaningless against this store because it belongs to another lifetime, not
// merely because of its numeric side).
func TestStreamEpoch_MismatchBeatsCursorExceedsHead(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")
	head := srv.agg.Store().Head()
	staleCursor := head + 500

	lines := captureBaselines(t, func() {
		reader, _ := openSessionStreamEpoch(t, web.URL, "s1", staleCursor, true, "previous-store-lifetime", 500*time.Millisecond)
		if first := firstFrameEvent(t, reader); first != "snapshot" {
			t.Fatalf("epoch mismatch + cursor>head: want first frame 'snapshot', got %q", first)
		}
	})
	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") || !strings.Contains(line, "fallback_reason=epoch_mismatch") {
		t.Errorf("epoch mismatch + cursor>head: journal must say path=fresh fallback_reason=epoch_mismatch (epoch arm wins): %q", line)
	}
	if strings.Contains(line, "stale_cursor_exceeds_head") {
		t.Errorf("epoch mismatch + cursor>head: stale_cursor_exceeds_head must NOT win the discriminator: %q", line)
	}
}

// TestStreamEpoch_TreeMismatchFreshFallback — the tree=2 variant of the crux.
// A declared-epoch mismatch with a cursor below head must route to the fresh
// fallback: the full re-seed trio (tree.snapshot cause "reconnect", partial
// detail with ringGap:true stamped at the D1 site, snapshot.complete), ZERO
// tree.op replay of the post-cursor delta (the pre-fix server replays it),
// and journal attribution epoch_mismatch.
func TestStreamEpoch_TreeMismatchFreshFallback(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Capture a cursor below head: fresh connect, then advance the store.
	resp1, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	initial := drainIdle(startSSEReader(t, resp1.Body), 600*time.Millisecond)
	resp1.Body.Close()
	cursor := lastEventIDOf(initial, "tree.snapshot")
	if cursor == "" {
		t.Fatalf("fresh connect: no tree.snapshot id; events=%v", eventNames(initial))
	}
	applyCreate(store, "C2", "R") // a delta the pre-fix server would replay
	if store.Head() <= mustParseCursor(t, cursor) {
		t.Fatalf("setup: head %d must exceed cursor %s", store.Head(), cursor)
	}

	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2&epoch=previous-store-lifetime", nil)
	req.Header.Set("Last-Event-ID", cursor)

	var events []sseEvent
	var ch <-chan sseEvent
	var resp *http.Response
	lines := captureBaselines(t, func() {
		var err error
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		ch = startSSEReader(t, resp.Body)
		events = drainIdle(ch, 600*time.Millisecond)
	})
	defer resp.Body.Close()

	// Full trio present.
	treeIdx, detailIdx, completeIdx := -1, -1, -1
	for i, e := range events {
		switch e.event {
		case "tree.snapshot":
			if treeIdx < 0 {
				treeIdx = i
			}
		case "snapshot":
			if detailIdx < 0 {
				detailIdx = i
			}
		case "snapshot.complete":
			if completeIdx < 0 {
				completeIdx = i
			}
		}
	}
	if treeIdx < 0 || detailIdx < 0 || completeIdx < 0 {
		t.Fatalf("epoch-mismatch tree reconnect: want the full trio; events=%v", eventNames(events))
	}
	if !strings.Contains(events[detailIdx].data, `"ringGap":true`) {
		t.Errorf("epoch-mismatch detail snapshot must carry partial.ringGap:true (D1 stamping site: hasCursor && !replayOK); data=%.200s", events[detailIdx].data)
	}
	// NO tree.op replay of the post-cursor delta: the fresh branch's
	// snapshot covers C2; the replay branch (pre-fix) would emit tree.op
	// events referencing C2 before the trio.
	for _, e := range events {
		if e.event == "tree.op" && strings.Contains(e.data, `"C2"`) {
			t.Errorf("epoch-mismatch tree reconnect must NOT replay tree.op for C2 (fresh branch, not replay): %v", eventNames(events))
			break
		}
	}

	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") || !strings.Contains(line, "fallback_reason=epoch_mismatch") {
		t.Errorf("epoch-mismatch tree reconnect: journal must say path=fresh fallback_reason=epoch_mismatch: %q", line)
	}
}

// TestStreamEpoch_OpenJournalCarriesEpoch — the P4 "stream open" line carries
// the RAW epoch param value (client-shape evidence mirroring the raw cursor
// string): present when declared, so a capture can distinguish a
// handshake-capable client from a legacy one without VH_DEBUG.
func TestStreamEpoch_OpenJournalCarriesEpoch(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	var mu sync.Mutex
	var buf bytes.Buffer
	prev := vhlog.SetOutput(lockedWriter{&mu, &buf})
	defer vhlog.SetOutput(prev)

	resp, err := http.Get(web.URL + "/vh/stream?sessions=s1&epoch=declared-epoch-7")
	if err != nil {
		t.Fatal(err)
	}
	drainIdle(startSSEReader(t, resp.Body), 400*time.Millisecond)
	resp.Body.Close()

	mu.Lock()
	defer mu.Unlock()
	var openLine string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, `"stream open"`) {
			openLine = l
			break
		}
	}
	if openLine == "" {
		t.Fatal("no stream open journal line captured")
	}
	if !strings.Contains(openLine, "epoch=declared-epoch-7") {
		t.Errorf("stream open line must carry the raw epoch param: %s", openLine)
	}
}

// mustParseCursor parses a compound ("seq.ordinal") or plain SSE id into the
// store-seq component for setup assertions.
func mustParseCursor(t *testing.T, s string) uint64 {
	t.Helper()
	seq, _ := parseResumeCursor(s)
	if seq == 0 {
		t.Fatalf("setup: unparseable cursor %q", s)
	}
	return seq
}
