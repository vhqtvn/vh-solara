package aggregator

// older_page_singleflight_test.go — P2-AGG-004 proof: the pageInflight
// collapsed-waiter in EnsureOlderMessages must PROPAGATE the winner's
// MessagesBefore failure instead of returning nil unconditionally. Before the
// fix the waiter did `<-done; return nil`, so a winner whose upstream
// GET ?before=<cursor> failed still woke its collapsed waiter to a
// success-shaped nil — the boundary-demand HTTP handler
// (pkg/web/messages_http.go) then re-projected as if the older page had merged.
//
// This test forces the winner to fail (HTTP 500) while a waiter is collapsed
// onto the same slot and asserts the waiter returns the winner's non-nil error.
//
// Determinism: the pageGateHook seam (mirrors SetMsgGateHook) fires the instant
// a collapsed waiter has committed to the slot (released pageMu, about to park
// on <-slot.done). The test waits for that signal — PROVING the waiter collapsed
// rather than becoming a fresh winner — BEFORE releasing the winner's GET,
// eliminating the scheduling race that would otherwise let the waiter run its
// slot lookup only after the winner's defer reclaimed the slot.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestEnsureOlderMessagesCollapsedWaiterPropagatesWinnerError is the P2-AGG-004
// crux: a collapsed waiter must return the winner's (non-nil) MessagesBefore
// error, NOT nil.
func TestEnsureOlderMessagesCollapsedWaiterPropagatesWinnerError(t *testing.T) {
	fake := fixtures.New()
	const sid = "olderfail"
	n := state.WindowMaxCount + 50 // > WindowMaxCount so a strictly-older page exists
	fake.SeedChronologicalMessages(sid, n)
	fixtureHandler := fake.Handler()

	// hold keeps the winner's older-page GET observably in flight so the waiter
	// definitely finds the registered slot and collapses. gotGET signals the GET
	// entered the handler — the slot is registered in pageInflight BEFORE the
	// GET issues, so observing the GET in flight proves the slot exists.
	hold := make(chan struct{})
	gotGET := make(chan struct{}, 1)
	var (
		mu            sync.Mutex
		olderGETCount int
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("before") != "" {
			// Older-page GET (MessagesBefore): count, signal, block, then FAIL.
			mu.Lock()
			olderGETCount++
			mu.Unlock()
			select {
			case gotGET <- struct{}{}:
			default:
			}
			<-hold
			http.Error(w, "simulated upstream failure", http.StatusInternalServerError)
			return
		}
		// Cold-load GET (MessagesTail, no ?before): delegate to the fixture so
		// EnsureMessages succeeds and establishes a resident floor + anchor.
		fixtureHandler.ServeHTTP(w, r)
	})
	mux.Handle("/", fixtureHandler)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	// 1. Bounded cold-load → resident = newest WindowMaxCount; establish the
	//    oldest-resident anchor the older-page cursor is built from.
	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}
	oid, otime, ok := agg.Store().OldestResidentCursorTuple(sid)
	if !ok {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after cold-load")
	}

	// pageGateHook rendezvous: fires once, when the waiter has committed to the
	// collapse. waiterCollapsed is the deterministic "the waiter collapsed"
	// signal the test waits for before releasing the winner.
	waiterCollapsed := make(chan struct{}, 1)
	agg.SetPageGateHook(func(string) {
		select {
		case waiterCollapsed <- struct{}{}:
		default:
		}
	})

	// 2. Launch the WINNER. Its MessagesBefore GET blocks on hold → its slot is
	//    registered in pageInflight for the whole wait.
	winnerReturned := make(chan struct{})
	var winnerErr error
	go func() {
		winnerErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(winnerReturned)
	}()

	// Wait until the winner's older-page GET is observably in flight. The slot
	// is registered (pageInflight[sid] = slot) BEFORE a.client.MessagesBefore,
	// so observing the GET proves the slot exists.
	select {
	case <-gotGET:
	case <-time.After(3 * time.Second):
		t.Fatal("winner's older-page GET never entered the handler")
	}

	// 3. Launch the WAITER while the winner is in flight. It finds the
	//    registered slot and collapses onto <-slot.done (the pageGateHook fires
	//    the instant it commits).
	waiterReturned := make(chan struct{})
	var waiterErr error
	go func() {
		waiterErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(waiterReturned)
	}()

	// Deterministically confirm the waiter COLLAPSED (found the winner's slot)
	// before releasing the winner. This is the load-bearing rendezvous: without
	// it, the waiter might run its slot lookup only after the winner's defer
	// reclaimed the slot, becoming a fresh winner (issuing its own GET) instead
	// of collapsing.
	select {
	case <-waiterCollapsed:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter never collapsed onto the winner's slot (pageGateHook did not fire)")
	}

	// 4. Release the winner's GET → it returns 500 → MessagesBefore fails → the
	//    winner publishes slot.err and returns err; the defer closes slot.done,
	//    waking the waiter, which returns slot.err (non-nil).
	close(hold)

	// 5. Wait for both callers to return.
	select {
	case <-winnerReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("winner did not return after hold released")
	}
	select {
	case <-waiterReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not return after hold released")
	}

	// 6. CRUX — the collapsed waiter must PROPAGATE the winner's failure (NOT
	//    return nil). Before P2-AGG-004 the waiter did `<-done; return nil` and
	//    this assertion failed.
	if waiterErr == nil {
		t.Fatal("CRUX FAIL: collapsed waiter returned nil on winner failure (must propagate the winner's error)")
	}
	t.Logf("CRUX PASS: collapsed waiter propagated winner failure: %v", waiterErr)

	// Sanity: the winner itself also returned its MessagesBefore error.
	if winnerErr == nil {
		t.Fatal("winner must return its MessagesBefore error")
	}

	// Stronger: the waiter's err is the SAME error value the winner published —
	// slot.err is set to the winner's err, and the waiter returns slot.err. This
	// proves the err traveled through the shared slot (the collapse path), NOT
	// via a fresh fetch by the waiter (which would produce a distinct error
	// value from a second GET).
	if waiterErr != winnerErr {
		t.Fatalf("waiter err must equal winner err (same slot-published value): winner=%v waiter=%v", winnerErr, waiterErr)
	}

	// Assert: exactly ONE upstream older-page GET — the waiter collapsed and did
	// NOT issue its own fetch (single-flight held).
	mu.Lock()
	got := olderGETCount
	mu.Unlock()
	if got != 1 {
		t.Fatalf("upstream older-page GETs: want 1 (single-flight collapse), got %d", got)
	}

	// Assert: the pageInflight slot is reclaimed after completion.
	agg.pageMu.Lock()
	_, stillInflight := agg.pageInflight[sid]
	agg.pageMu.Unlock()
	if stillInflight {
		t.Fatal("pageInflight slot must be cleared after both callers complete")
	}
}

// TestEnsureOlderMessagesCollapsedWaiterReturnsNilOnWinnerSuccess is the
// paired guard for P2-AGG-004: a collapsed waiter must still return nil when the
// winner SUCCEEDS (the fix must not invert the success path). Mirrors the
// failure test, but the winner's GET serves a real strictly-older page (delegated
// to the fixture) and the waiter must collapse → nil.
func TestEnsureOlderMessagesCollapsedWaiterReturnsNilOnWinnerSuccess(t *testing.T) {
	fake := fixtures.New()
	const sid = "olderok"
	n := state.WindowMaxCount + 50 // > WindowMaxCount so a strictly-older page exists
	fake.SeedChronologicalMessages(sid, n)
	fixtureHandler := fake.Handler()

	// hold keeps the winner's older-page GET in flight so the waiter collapses.
	hold := make(chan struct{})
	gotGET := make(chan struct{}, 1)
	var (
		mu            sync.Mutex
		olderGETCount int
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
		isOlder := r.URL.Query().Get("before") != ""
		if isOlder {
			mu.Lock()
			olderGETCount++
			mu.Unlock()
			select {
			case gotGET <- struct{}{}:
			default:
			}
			<-hold // park the winner's older-page GET until the waiter has collapsed
		}
		// Serve every message GET (cold-load AND older-page, after release) from
		// the fixture so the winner SUCCEEDS and the merge lands.
		fixtureHandler.ServeHTTP(w, r)
	})
	mux.Handle("/", fixtureHandler)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}
	oid, otime, ok := agg.Store().OldestResidentCursorTuple(sid)
	if !ok {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after cold-load")
	}

	waiterCollapsed := make(chan struct{}, 1)
	agg.SetPageGateHook(func(string) {
		select {
		case waiterCollapsed <- struct{}{}:
		default:
		}
	})

	// Launch the WINNER (its older-page GET parks on hold).
	winnerReturned := make(chan struct{})
	var winnerErr error
	go func() {
		winnerErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(winnerReturned)
	}()
	select {
	case <-gotGET:
	case <-time.After(3 * time.Second):
		t.Fatal("winner's older-page GET never entered the handler")
	}

	// Launch the WAITER → it collapses.
	waiterReturned := make(chan struct{})
	var waiterErr error
	go func() {
		waiterErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(waiterReturned)
	}()
	select {
	case <-waiterCollapsed:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter never collapsed onto the winner's slot (pageGateHook did not fire)")
	}

	// Release the winner → it merges the older page and succeeds.
	close(hold)

	select {
	case <-winnerReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("winner did not return after hold released")
	}
	select {
	case <-waiterReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not return after hold released")
	}

	// Guard: winner succeeded.
	if winnerErr != nil {
		t.Fatalf("winner must succeed (delegate to fixture): %v", winnerErr)
	}
	// CRUX (success path): the collapsed waiter returns nil — the fix propagates
	// the winner's err, which is nil on success, so the success contract holds.
	if waiterErr != nil {
		t.Fatalf("CRUX FAIL: collapsed waiter returned non-nil on winner success (must be nil): %v", waiterErr)
	}
	t.Logf("CRUX PASS: collapsed waiter returned nil on winner success (success contract preserved)")

	// Exactly one older-page GET (single-flight held).
	mu.Lock()
	got := olderGETCount
	mu.Unlock()
	if got != 1 {
		t.Fatalf("upstream older-page GETs: want 1 (single-flight collapse), got %d", got)
	}

	agg.pageMu.Lock()
	_, stillInflight := agg.pageInflight[sid]
	agg.pageMu.Unlock()
	if stillInflight {
		t.Fatal("pageInflight slot must be cleared after both callers complete")
	}
}

// TestEnsureOlderMessagesCollapsedMultipleWaitersAllReceiveWinnerError is the
// multi-waiter (N>=2) extension of the P2-AGG-004 crux: the single-flight
// broadcast must deliver the winner's error to EVERY collapsed waiter, not just
// one. The collapse path does `<-slot.done; return slot.err`, and slot.err is
// published by the winner BEFORE close(slot.done) — so the close→receive memory
// edge hands ALL waiters the SAME winner-published error value. A bare
// chan error could not do this (a send reaches one receiver; close yields the
// zero value), which is why the slot struct is the carrier.
//
// This mirrors the N=1 crux but spawns numWaiters (3) waiters collapsed onto the
// SAME slot before the winner resolves, then asserts ALL of them receive the
// winner's non-nil error (the identical value, proving it traveled through
// slot.err and not a fresh fetch) and that exactly ONE upstream GET fired.
func TestEnsureOlderMessagesCollapsedMultipleWaitersAllReceiveWinnerError(t *testing.T) {
	fake := fixtures.New()
	const sid = "olderfailmulti"
	n := state.WindowMaxCount + 50 // > WindowMaxCount so a strictly-older page exists
	fake.SeedChronologicalMessages(sid, n)
	fixtureHandler := fake.Handler()

	// hold keeps the winner's older-page GET observably in flight so all waiters
	// definitely find the registered slot and collapse.
	hold := make(chan struct{})
	gotGET := make(chan struct{}, 1)
	var (
		mu            sync.Mutex
		olderGETCount int
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("before") != "" {
			// Older-page GET (MessagesBefore): count, signal, block, then FAIL.
			mu.Lock()
			olderGETCount++
			mu.Unlock()
			select {
			case gotGET <- struct{}{}:
			default:
			}
			<-hold
			http.Error(w, "simulated upstream failure", http.StatusInternalServerError)
			return
		}
		fixtureHandler.ServeHTTP(w, r)
	})
	mux.Handle("/", fixtureHandler)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}
	oid, otime, ok := agg.Store().OldestResidentCursorTuple(sid)
	if !ok {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after cold-load")
	}

	const numWaiters = 3
	// pageGateHook rendezvous: fires once per collapsed waiter. collapsedN
	// (buffered to numWaiters) collects one signal per collapse so the test can
	// deterministically confirm ALL numWaiters collapsed before releasing the
	// winner — eliminating the scheduling race where a waiter might run its
	// slot lookup only after the winner's defer reclaimed the slot.
	collapsedN := make(chan struct{}, numWaiters)
	agg.SetPageGateHook(func(string) {
		select {
		case collapsedN <- struct{}{}:
		default:
		}
	})

	// 1. Launch the WINNER. Its MessagesBefore GET blocks on hold → its slot is
	//    registered in pageInflight for the whole wait.
	winnerReturned := make(chan struct{})
	var winnerErr error
	go func() {
		winnerErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(winnerReturned)
	}()
	select {
	case <-gotGET:
	case <-time.After(3 * time.Second):
		t.Fatal("winner's older-page GET never entered the handler")
	}

	// 2. Launch numWaiters WAITERS collapsed onto the SAME slot. A WaitGroup
	//    + per-index error slice collects each waiter's returned error.
	var wg sync.WaitGroup
	waiterErrs := make([]error, numWaiters)
	wg.Add(numWaiters)
	for i := 0; i < numWaiters; i++ {
		i := i
		go func() {
			defer wg.Done()
			waiterErrs[i] = agg.EnsureOlderMessages(sid, oid, otime)
		}()
	}

	// 3. Deterministically confirm ALL numWaiters collapsed before releasing.
	for i := 0; i < numWaiters; i++ {
		select {
		case <-collapsedN:
		case <-time.After(3 * time.Second):
			t.Fatalf("waiter %d never collapsed onto the winner's slot (pageGateHook did not fire)", i)
		}
	}

	// 4. Release the winner's GET → 500 → MessagesBefore fails → winner publishes
	//    slot.err and returns err; the defer closes slot.done, waking ALL waiters,
	//    each of which returns slot.err (the SAME non-nil value).
	close(hold)

	select {
	case <-winnerReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("winner did not return after hold released")
	}
	wg.Wait()

	// 5. CRUX — ALL N waiters must PROPAGATE the winner's failure. Before
	//    P2-AGG-004 a bare chan would either deadlock the 2nd+ waiter or hand it
	//    nil; the slot struct is the broadcast carrier this exercises.
	if winnerErr == nil {
		t.Fatal("winner must return its MessagesBefore error")
	}
	for i, wErr := range waiterErrs {
		if wErr == nil {
			t.Fatalf("CRUX FAIL: waiter %d returned nil on winner failure (must propagate)", i)
		}
		// Same error VALUE → it traveled through the shared slot.err (the
		// collapse path), NOT via a fresh fetch by the waiter (which would
		// produce a distinct error value from a second GET).
		if wErr != winnerErr {
			t.Fatalf("waiter %d err must equal winner err (shared slot-published value): winner=%v waiter=%v", i, winnerErr, wErr)
		}
	}
	t.Logf("CRUX PASS: all %d collapsed waiters propagated winner failure: %v", numWaiters, winnerErr)

	// 6. Assert exactly ONE upstream older-page GET — all waiters collapsed and
	//    none issued their own fetch (single-flight held across N).
	mu.Lock()
	got := olderGETCount
	mu.Unlock()
	if got != 1 {
		t.Fatalf("upstream older-page GETs: want 1 (single-flight collapse), got %d", got)
	}

	// Assert: the pageInflight slot is reclaimed after completion.
	agg.pageMu.Lock()
	_, stillInflight := agg.pageInflight[sid]
	agg.pageMu.Unlock()
	if stillInflight {
		t.Fatal("pageInflight slot must be cleared after all callers complete")
	}
}

// TestEnsureOlderMessagesCollapsedMultipleWaitersAllReceiveNilOnWinnerSuccess is
// the paired success guard for the multi-waiter case: when the winner SUCCEEDS,
// every collapsed waiter must still receive nil (the broadcast must not invert
// the success path for any waiter). Mirrors the N=1 success guard but spawns
// numWaiters (3) waiters.
func TestEnsureOlderMessagesCollapsedMultipleWaitersAllReceiveNilOnWinnerSuccess(t *testing.T) {
	fake := fixtures.New()
	const sid = "olderokmulti"
	n := state.WindowMaxCount + 50 // > WindowMaxCount so a strictly-older page exists
	fake.SeedChronologicalMessages(sid, n)
	fixtureHandler := fake.Handler()

	hold := make(chan struct{})
	gotGET := make(chan struct{}, 1)
	var (
		mu            sync.Mutex
		olderGETCount int
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
		isOlder := r.URL.Query().Get("before") != ""
		if isOlder {
			mu.Lock()
			olderGETCount++
			mu.Unlock()
			select {
			case gotGET <- struct{}{}:
			default:
			}
			<-hold // park the winner's older-page GET until all waiters have collapsed
		}
		// Serve every message GET (cold-load AND older-page, after release) from
		// the fixture so the winner SUCCEEDS and the merge lands.
		fixtureHandler.ServeHTTP(w, r)
	})
	mux.Handle("/", fixtureHandler)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}
	oid, otime, ok := agg.Store().OldestResidentCursorTuple(sid)
	if !ok {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after cold-load")
	}

	const numWaiters = 3
	collapsedN := make(chan struct{}, numWaiters)
	agg.SetPageGateHook(func(string) {
		select {
		case collapsedN <- struct{}{}:
		default:
		}
	})

	// Launch the WINNER (its older-page GET parks on hold).
	winnerReturned := make(chan struct{})
	var winnerErr error
	go func() {
		winnerErr = agg.EnsureOlderMessages(sid, oid, otime)
		close(winnerReturned)
	}()
	select {
	case <-gotGET:
	case <-time.After(3 * time.Second):
		t.Fatal("winner's older-page GET never entered the handler")
	}

	// Launch numWaiters WAITERS → they all collapse onto the SAME slot.
	var wg sync.WaitGroup
	waiterErrs := make([]error, numWaiters)
	wg.Add(numWaiters)
	for i := 0; i < numWaiters; i++ {
		i := i
		go func() {
			defer wg.Done()
			waiterErrs[i] = agg.EnsureOlderMessages(sid, oid, otime)
		}()
	}
	for i := 0; i < numWaiters; i++ {
		select {
		case <-collapsedN:
		case <-time.After(3 * time.Second):
			t.Fatalf("waiter %d never collapsed onto the winner's slot (pageGateHook did not fire)", i)
		}
	}

	// Release the winner → it merges the older page and succeeds.
	close(hold)

	select {
	case <-winnerReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("winner did not return after hold released")
	}
	wg.Wait()

	// Guard: winner succeeded.
	if winnerErr != nil {
		t.Fatalf("winner must succeed (delegate to fixture): %v", winnerErr)
	}
	// CRUX (success path): ALL N collapsed waiters return nil — slot.err is the
	// winner's nil, broadcast to every waiter via close(slot.done).
	for i, wErr := range waiterErrs {
		if wErr != nil {
			t.Fatalf("CRUX FAIL: waiter %d returned non-nil on winner success (must be nil): %v", i, wErr)
		}
	}
	t.Logf("CRUX PASS: all %d collapsed waiters returned nil on winner success (success contract preserved)", numWaiters)

	// Exactly one older-page GET (single-flight held across all waiters).
	mu.Lock()
	got := olderGETCount
	mu.Unlock()
	if got != 1 {
		t.Fatalf("upstream older-page GETs: want 1 (single-flight collapse), got %d", got)
	}

	agg.pageMu.Lock()
	_, stillInflight := agg.pageInflight[sid]
	agg.pageMu.Unlock()
	if stillInflight {
		t.Fatal("pageInflight slot must be cleared after all callers complete")
	}
}
