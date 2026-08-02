package aggregator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// TestEnsureMessagesSyncAsyncSingleFlight closes GAP-1: the per-session
// msgInflight single-flight contract is SHARED between EnsureMessages (sync) and
// EnsureMessagesAsync (async), but only sync↔sync (TestEnsureMessagesSyncSingleFlightWaiter)
// and async↔async (TestEnsureMessagesAsyncSingleFlight) were characterized. These
// two subtests exercise the cross-path cases the doc at aggregator.go:354-360
// calls load-bearing: the winner (sync OR async) must emit messages.loaded so a
// deduped async caller doesn't wedge, and a sync waiter must observe the loaded
// state via the under-lock re-check after parking on the shared done chan.
//
// Deterministic rendezvous: a hold channel keeps the winner's GET observably in
// flight (so the second caller definitely finds the registered slot), and the
// msgGateHook seam parks the second caller until the test confirms the winner's
// GET is in flight — eliminating the scheduling race where the second caller
// might otherwise register first and invert the winner/waiter assignment.
//
//	SyncWinnerAsyncWaiter: EnsureMessages wins; EnsureMessagesAsync dedupes.
//	  Asserts exactly 1 upstream GET; session loaded; messages.loaded emitted
//	  (the load-bearing completion signal for the deduped async caller — without
//	  it the SSE client would wedge on the loading state forever).
//
//	AsyncWinnerSyncWaiter: EnsureMessagesAsync wins; EnsureMessages waits on the
//	  shared done chan, then takes the under-lock re-check (loaded → nil). Asserts
//	  exactly 1 upstream GET; session loaded; messages.loaded emitted.
func TestEnsureMessagesSyncAsyncSingleFlight(t *testing.T) {
	const sid = "xflight"
	// A single user message: enough for SetSessionMessages to publish a cold
	// batch (ColdBatchEmitted) and mark the session loaded.
	const successBody = `[{"info":{"id":"m1","sessionID":"xflight","role":"user"},"parts":[{"id":"p1","sessionID":"xflight","messageID":"m1","type":"text","text":"loaded"}]}]`

	cases := []struct {
		name         string
		winnerIsSync bool
	}{
		{"SyncWinnerAsyncWaiter", true},
		{"AsyncWinnerSyncWaiter", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				mu        sync.Mutex
				fullCount int
			)
			hold := make(chan struct{})      // close to release the winner's GET
			gotGET := make(chan struct{}, 1) // signal: winner's GET entered the handler

			mux := http.NewServeMux()
			mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
				// Contract-agnostic (Part-A modernization): cold-load now sends
				// ?limit (MessagesTail), so count + signal + serve unconditionally.
				mu.Lock()
				fullCount++
				mu.Unlock()
				select {
				case gotGET <- struct{}{}:
				default:
				}
				<-hold
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(successBody))
			})
			mux.Handle("/", fixtures.New().Handler())
			oc := httptest.NewServer(mux)
			defer oc.Close()

			agg := New(oc.URL, 100)
			ch, unsub := agg.Store().Subscribe(128)
			defer unsub()

			// Hook rendezvous: the FIRST caller (the winner) proceeds through
			// unimpeded; the SECOND caller (the waiter / dedupe) is parked until
			// the test confirms the winner's GET is in flight (and thus its slot
			// is registered in msgInflight), then released. This eliminates the
			// scheduling race where the second caller might register first.
			var hookCalls int32
			secondProceed := make(chan struct{})
			agg.SetMsgGateHook(func(string) {
				if atomic.AddInt32(&hookCalls, 1) == 2 {
					<-secondProceed
				}
			})

			// Launch the WINNER. The sync winner blocks until its GET completes;
			// the async winner returns immediately after spawning its fetch
			// goroutine. Either way the slot is registered before the GET issues.
			winnerReturned := make(chan struct{})
			var syncWinnerErr error
			if tc.winnerIsSync {
				go func() {
					syncWinnerErr = agg.EnsureMessages(context.Background(), sid)
					close(winnerReturned)
				}()
			} else {
				agg.EnsureMessagesAsync(sid)
			}

			// Wait until the winner's GET is observably in flight. The slot is
			// registered (msgInflight[sid] = done) BEFORE client.Messages, so
			// observing the GET in flight proves the slot exists.
			select {
			case <-gotGET:
			case <-time.After(3 * time.Second):
				t.Fatal("winner's GET never entered the handler")
			}

			// Launch the SECOND caller on a goroutine (it parks in the hook).
			secondReturned := make(chan struct{})
			var syncSecondErr error
			if tc.winnerIsSync {
				// winner is sync → second caller is async (dedupes via the shared slot)
				go func() {
					agg.EnsureMessagesAsync(sid)
					close(secondReturned)
				}()
			} else {
				// winner is async → second caller is sync (waits on <-done)
				go func() {
					syncSecondErr = agg.EnsureMessages(context.Background(), sid)
					close(secondReturned)
				}()
			}

			// Wait until the second caller is parked in the hook (call #2).
			if !waitHookCalls(&hookCalls, 2, 3*time.Second) {
				t.Fatalf("second caller never entered the hook: hookCalls=%d", atomic.LoadInt32(&hookCalls))
			}

			// Release the second caller. It acquires msgMu, finds the registered
			// slot (winner still in flight), and either parks on <-done (sync) or
			// returns immediately (async dedupe).
			close(secondProceed)

			// Release the winner's GET. It completes: SetSessionMessages marks
			// loaded, defer clears slot + closes done, and EmitMessagesLoaded
			// fires (the load-bearing completion signal for a deduped async
			// caller). The sync waiter (if any) wakes on <-done and takes the
			// under-lock re-check (loaded → nil).
			close(hold)

			// Wait for the sync winner goroutine to exit (sync-winner case only).
			if tc.winnerIsSync {
				select {
				case <-winnerReturned:
				case <-time.After(3 * time.Second):
					t.Fatal("sync winner did not return after hold released")
				}
			}
			// Wait for the second caller to exit.
			select {
			case <-secondReturned:
			case <-time.After(3 * time.Second):
				t.Fatal("second caller did not return after hold released")
			}

			// Assert: the sync caller (whichever role) observed nil — the waiter
			// woke to a loaded session, the winner succeeded.
			if tc.winnerIsSync {
				if syncWinnerErr != nil {
					t.Fatalf("sync winner: want nil error, got %v", syncWinnerErr)
				}
			} else {
				if syncSecondErr != nil {
					t.Fatalf("sync waiter: want nil error, got %v", syncSecondErr)
				}
			}

			// Assert: exactly 1 upstream GET — the sync↔async single-flight
			// collapsed the two callers to one fetch.
			mu.Lock()
			got := fullCount
			mu.Unlock()
			if got != 1 {
				t.Fatalf("upstream full GETs: want 1 (single-flight), got %d", got)
			}

			// Assert: session is loaded.
			if !agg.Store().IsMessagesLoaded(sid) {
				t.Fatal("session must be loaded after the winner's fetch")
			}

			// Assert: messages.loaded was emitted. This is the load-bearing
			// completion contract for a deduped async caller — without it, an
			// async caller that deduped against a sync winner would never
			// receive the completion signal and its SSE client would wedge on
			// the loading state (aggregator.go:354-360).
			var sawLoaded bool
			dl := time.Now().Add(2 * time.Second)
			for time.Now().Before(dl) && !sawLoaded {
				select {
				case e := <-ch:
					if e.Kind == "messages.loaded" {
						sawLoaded = true
					}
				case <-time.After(20 * time.Millisecond):
				}
			}
			if !sawLoaded {
				t.Fatal("messages.loaded must be emitted so a deduped async caller unwedges")
			}

			// Assert: the in-flight slot is cleared.
			agg.msgMu.Lock()
			_, stillInflight := agg.msgInflight[sid]
			agg.msgMu.Unlock()
			if stillInflight {
				t.Fatal("in-flight slot must be cleared after both callers complete")
			}
		})
	}
}

// waitHookCalls polls *calls until it reaches want or the timeout lapses.
// Used by the single-flight characterization tests to deterministically observe
// that a caller has parked inside the msgGateHook rendezvous.
func waitHookCalls(calls *int32, want int32, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if atomic.LoadInt32(calls) >= want {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return atomic.LoadInt32(calls) >= want
}

// waitSlotCleared polls msgInflight[sid] under msgMu until it is gone or the
// timeout lapses. Used by the TOCTOU test to wait for a prior winner's defer to
// reclaim its slot before releasing the parked late caller.
func waitSlotCleared(a *Aggregator, sid string, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		a.msgMu.Lock()
		_, ok := a.msgInflight[sid]
		a.msgMu.Unlock()
		if !ok {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	a.msgMu.Lock()
	_, ok := a.msgInflight[sid]
	a.msgMu.Unlock()
	return !ok
}

// TestEnsureMessagesTOCTOURecheck closes GAP-2: the doc comments at
// aggregator.go:412-414 (EnsureMessages hook site), 556-564 (EnsureMessagesAsync
// under-lock re-check), and 294-302 (SetMsgGateHook) all reference this test
// name as the proof that the under-lock IsMessagesLoaded re-check closes the
// TOCTOU window between the unlocked fast-path read and msgMu acquisition. The
// msgGateHook seam was built for it; the test never landed.
//
// Schedule: a PRIOR winner is in flight (slot registered, GET in flight). A LATE
// caller enters; its msgGateHook fires at the START of the TOCTOU window (after
// the unlocked fast-path read, before msgMu acquisition) and PARKS there while
// the prior winner completes its FULL lifecycle:
//
//  1. GET returns → SetSessionMessages marks msgLoaded[sid]=true (under store.mu).
//  2. EmitMessagesLoaded fires (winner emits completion for any deduped caller).
//  3. defer acquires msgMu, deletes msgInflight[sid], releases msgMu.
//  4. defer ClearColdFetchActive(sid); defer close(done).
//
// The late caller is then released. It acquires msgMu AFTER the winner's defer
// released it. The under-lock re-check observes msgLoaded==true → returns nil
// WITHOUT becoming a fresh winner / issuing a redundant GET. Without the
// re-check, the late caller would find no slot (defer cleared it) and become a
// FRESH winner, issuing a second GET whose warm-resync reconcile
// (ColdBatchWarmReconcile) would authoritatively clobber live-arrived content
// — the C-F2 symptom via a different path.
//
// Both sync (EnsureMessages) and async (EnsureMessagesAsync) variants: each
// exercises its own under-lock re-check site (aggregator.go:432 / 565).
func TestEnsureMessagesTOCTOURecheck(t *testing.T) {
	const sid = "toctou"
	const successBody = `[{"info":{"id":"m1","sessionID":"toctou","role":"user"},"parts":[{"id":"p1","sessionID":"toctou","messageID":"m1","type":"text","text":"loaded"}]}]`

	cases := []struct {
		name  string
		async bool // true = EnsureMessagesAsync; false = EnsureMessages
	}{
		{"Sync", false},
		{"Async", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				mu        sync.Mutex
				fullCount int
			)
			hold := make(chan struct{}) // close to release the winner's GET
			gotGET := make(chan struct{}, 1)
			gateLate := make(chan struct{}) // close to release the late caller from the hook

			mux := http.NewServeMux()
			mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
				// Contract-agnostic (Part-A modernization): cold-load now sends
				// ?limit (MessagesTail), so count + signal + serve unconditionally.
				mu.Lock()
				fullCount++
				mu.Unlock()
				select {
				case gotGET <- struct{}{}:
				default:
				}
				<-hold
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(successBody))
			})
			mux.Handle("/", fixtures.New().Handler())
			oc := httptest.NewServer(mux)
			defer oc.Close()

			agg := New(oc.URL, 100)

			// Hook: the FIRST caller (the winner) proceeds; the SECOND caller
			// (the late caller) PARKS at the start of the TOCTOU window until
			// the test releases it AFTER the winner has fully completed.
			var hookCalls int32
			agg.SetMsgGateHook(func(string) {
				if atomic.AddInt32(&hookCalls, 1) == 2 {
					<-gateLate
				}
			})

			// Launch the WINNER (same path as the late caller — both sync or
			// both async — so each variant exercises its own re-check site).
			winnerReturned := make(chan struct{})
			if tc.async {
				agg.EnsureMessagesAsync(sid)
			} else {
				go func() {
					_ = agg.EnsureMessages(context.Background(), sid)
					close(winnerReturned)
				}()
			}

			// Wait until the winner's GET is in flight (slot is registered).
			select {
			case <-gotGET:
			case <-time.After(3 * time.Second):
				t.Fatal("winner's GET never entered the handler")
			}

			// Launch the LATE caller on a goroutine. Its hook fires (call #2)
			// and parks at the start of the TOCTOU window.
			lateReturned := make(chan struct{})
			if tc.async {
				go func() {
					agg.EnsureMessagesAsync(sid)
					close(lateReturned)
				}()
			} else {
				go func() {
					_ = agg.EnsureMessages(context.Background(), sid)
					close(lateReturned)
				}()
			}

			// Wait until the late caller is parked in the hook.
			if !waitHookCalls(&hookCalls, 2, 3*time.Second) {
				t.Fatalf("late caller never entered the hook: hookCalls=%d", atomic.LoadInt32(&hookCalls))
			}

			// Release the winner's GET. It completes its FULL lifecycle:
			// SetSessionMessages (marks loaded) → EmitMessagesLoaded → defer
			// (clears slot + cold-fetch marker + closes done).
			close(hold)

			// Wait until the winner's slot is cleared (defer has run). The late
			// caller is still parked in the hook, so it cannot race this.
			if !waitSlotCleared(agg, sid, 3*time.Second) {
				t.Fatal("winner's slot was not cleared after hold released (defer did not run?)")
			}

			// Sanity: the winner has loaded the session.
			if !agg.Store().IsMessagesLoaded(sid) {
				t.Fatal("winner must have loaded the session before the late caller is released")
			}

			// For the sync winner, wait for its EnsureMessages goroutine to exit.
			if !tc.async {
				select {
				case <-winnerReturned:
				case <-time.After(3 * time.Second):
					t.Fatal("sync winner did not return after hold released")
				}
			}

			// NOW release the late caller. It acquires msgMu (after the winner's
			// defer released it), takes the under-lock re-check:
			// IsMessagesLoaded==true → returns nil WITHOUT becoming a fresh
			// winner / issuing a GET.
			close(gateLate)

			// Wait for the late caller to return.
			select {
			case <-lateReturned:
			case <-time.After(3 * time.Second):
				t.Fatal("late caller did not return after gateLate released")
			}

			// Assert: exactly 1 upstream GET (the winner's). The late caller did
			// NOT issue a redundant GET — proving it took the under-lock re-check
			// branch rather than becoming a fresh winner. A second GET would
			// warm-resync reconcile (ColdBatchWarmReconcile) and authoritatively
			// clobber any live-arrived content (C-F2).
			mu.Lock()
			got := fullCount
			mu.Unlock()
			if got != 1 {
				t.Fatalf("upstream full GETs: want 1 (TOCTOU re-check collapsed the late caller), got %d", got)
			}

			// Assert: session still loaded.
			if !agg.Store().IsMessagesLoaded(sid) {
				t.Fatal("session must remain loaded")
			}

			// Assert: in-flight slot is clear.
			agg.msgMu.Lock()
			_, stillInflight := agg.msgInflight[sid]
			agg.msgMu.Unlock()
			if stillInflight {
				t.Fatal("in-flight slot must be clear after both callers complete")
			}
		})
	}
}
