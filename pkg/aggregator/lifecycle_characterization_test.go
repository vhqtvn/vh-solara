package aggregator

// lifecycle_characterization_test.go — concurrency characterization tests
// gating the lifecycle/hydration/cold-seed cluster split proposed by the
// Go refactor brief. These close the three HIGH/MEDIUM gaps the aggregator
// concurrency map (`.opencode/state/workstreams/refactor-maintainability/
// aggregator-concurrency-map.md` §7) identifies as mandatory pre-split gates:
//
//   - GAP-3 (HIGH): Stop() during in-flight cold-seed + async fetch — the full
//     teardown path that ALSO closes the store (TestEnsureMessagesAsyncShutdownCancels
//     covers runCtx-only cancel, NOT store.Close()).
//   - GAP-4 (HIGH): concurrent RunManaged() vs Stop() race on the seedMu-guarded
//     `cancel` field — mandatory if a seedMu lock-split is ever attempted.
//   - GAP-5 (MEDIUM): onHydrate fires exactly once on success, NEVER on failure —
//     the fail-closed discipline the web-layer queue-GC depends on.
//
// Pure additive: this file touches no source. It reuses helpers from
// aggregator_test.go (slowFullMessageHandler, waitSlotCleared) and
// messages_singleflight_test.go (waitHookCalls, waitSlotCleared).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// gap3GateHandler wraps the fixture handler and GATES both cold-seed tail
// fetches (GET /session/:id/message?limit=..., issued by seedColdLastAgents'
// G6 workers) and async full fetches (GET /session/:id/message with NO ?limit=,
// issued by EnsureMessagesAsync's G7 goroutine). Each gated fetch is counted and
// held in flight on <-release until the test closes it, so Stop() can be driven
// to land mid-fetch on both G4/G6 and G7 at once — the dimension
// TestEnsureMessagesAsyncShutdownCancels does not cover (it cancels runCtx only;
// it never calls the full Stop() path that also closes the store).
type gap3GateHandler struct {
	inner     http.Handler
	mu        sync.Mutex
	tailCount int // cold-seed ?limit= fetches gated
	fullCount int // async no-?limit= fetches gated
	release   chan struct{}
}

func newGap3GateHandler(inner http.Handler) *gap3GateHandler {
	return &gap3GateHandler{inner: inner, release: make(chan struct{})}
}

func (h *gap3GateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") &&
		strings.HasSuffix(r.URL.Path, "/message") {
		isTail := r.URL.Query().Get("limit") != ""
		h.mu.Lock()
		if isTail {
			h.tailCount++
		} else {
			h.fullCount++
		}
		h.mu.Unlock()
		// Hold the fetch in flight until the test releases. Stop() cancels
		// runCtx, which aborts the aggregator's HTTP client transport
		// client-side (the GET returns a ctx-canceled error promptly); this
		// gate keeps the SERVER-side handler goroutine alive until the test
		// releases it, so the leak check at the end can drain it.
		<-h.release
		// Fall through to inner so the response is well-formed for any client
		// still listening (the aggregator's client tore down on ctx-cancel, so
		// this write usually goes to a closed connection — harmless).
	}
	h.inner.ServeHTTP(w, r)
}

func (h *gap3GateHandler) tailN() int { h.mu.Lock(); defer h.mu.Unlock(); return h.tailCount }
func (h *gap3GateHandler) fullN() int { h.mu.Lock(); defer h.mu.Unlock(); return h.fullCount }

func (h *gap3GateHandler) waitForTail(want int, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if h.tailN() >= want {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return h.tailN() >= want
}

func (h *gap3GateHandler) waitForFull(want int, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if h.fullN() >= want {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return h.fullN() >= want
}

func (h *gap3GateHandler) releaseAll() { close(h.release) }

// waitForHydratedOnce polls HydratedOnce() (lock-free atomic) until it is true
// or the timeout lapses. Used by the GAP-3 test to deterministically observe
// that Run's first hydrate has completed (and thus startColdSeed has been
// dispatched) before driving Stop().
func waitForHydratedOnce(a *Aggregator, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if a.HydratedOnce() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return a.HydratedOnce()
}

// waitSeedDoneCleared polls a.seedDone (under seedMu) until it is nil (the
// cold-seed goroutine's defer has run) or the timeout lapses. The GAP-3
// invariant: Stop() must let the in-flight G4 cold-seed goroutine exit cleanly,
// and its defer is the only thing that clears seedDone.
func waitSeedDoneCleared(a *Aggregator, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		a.seedMu.Lock()
		done := a.seedDone
		a.seedMu.Unlock()
		if done == nil {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	a.seedMu.Lock()
	done := a.seedDone
	a.seedMu.Unlock()
	return done == nil
}

// waitForGoroutineBounded polls runtime.NumGoroutine (with GC to drain
// finalizer goroutines) until it falls back to <= baseline+tolerance or the
// timeout lapses. The aggregator spawns G1..G7 (see the concurrency map §1);
// after Stop() + ctx-cancel + a settle window they must ALL have exited. The
// tolerance covers transient httptest server-side connection handlers draining
// after the client disconnected; a persistent leak of even one aggregator
// goroutine (e.g. a ticker that did not observe ctx-cancel) keeps the count
// elevated for the full window and surfaces as a failure.
func waitForGoroutineBounded(baseline, tolerance int, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		runtime.GC()
		if runtime.NumGoroutine() <= baseline+tolerance {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	runtime.GC()
	return runtime.NumGoroutine() <= baseline+tolerance
}

// TestStopDuringInFlightColdSeedAndAsyncFetch closes GAP-3: Stop() must cleanly
// cancel in-flight cold-seed goroutines (G4 driving the G6 tail-fetch fan-out)
// AND in-flight async message-fetch goroutines (G7) without panicking into a
// closed store or leaking goroutines.
//
// TestEnsureMessagesAsyncShutdownCancels covers the runCtx-only cancel path
// (manually assigns agg.runCtx, cancels it, asserts silent exit). It does NOT
// exercise the full Stop() path that ALSO closes the store (Store.Close() tears
// down SSE subscribers). This test drives the production teardown sequence —
// RunManaged arms cancel, Run runs the full reconnect loop, EnsureMessagesAsync
// spawns G7, the cold-seed spawns G4→G6 — and then calls Stop() while BOTH a
// cold-seed tail fetch and an async full fetch are observably in flight.
//
// Asserts:
//  1. No panic (reaching the post-Stop assertions proves no "send on closed
//     channel" / "use of closed store" surfaced from the concurrent teardown).
//  2. Run returned (cancel propagated through runCtx).
//  3. msgInflight[sid] cleared (G7's defer ran — the slot is reclaimed even on
//     the ctx-cancel silent-exit path).
//  4. seedDone cleared (G4's defer ran — the cold-seed slot is reclaimed).
//  5. No goroutine leak (G1/G2/G3/G3a/G4/G6/G7 all exit; NumGoroutine returns
//     to near-baseline after a settle window).
func TestStopDuringInFlightColdSeedAndAsyncFetch(t *testing.T) {
	h := newGap3GateHandler(fixtures.New().Handler())
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Baseline goroutine count with only test plumbing live (httptest server
	// accept loop + test goroutine + finalizers). The aggregator's G1..G7 are
	// spawned by Run below; the post-Stop count must return to this baseline
	// (within tolerance) to prove none leak.
	runtime.GC()
	baseline := runtime.NumGoroutine()

	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(context.Background())
		close(runDone)
	}()

	// Wait for the first hydrate to complete so startColdSeed has dispatched
	// G4 (which fans out G6 tail-fetch workers). The cold-seed is background,
	// so HydratedOnce()==true is the earliest reliable signal it was launched.
	if !waitForHydratedOnce(agg, 5*time.Second) {
		t.Fatal("aggregator never completed initial hydrate (Run not running?)")
	}

	// Wait until the cold-seed's tail fetch (G6) is observably in flight. The
	// gate holds it there, so Stop() below lands mid-fetch — the dimension the
	// existing shutdown test does not cover.
	if !h.waitForTail(1, 5*time.Second) {
		t.Fatal("cold-seed tail fetch never entered (G4/G6 not dispatched?)")
	}

	// Trigger an async message fetch (G7) for a cold session. demo is NOT
	// loaded after a cold hydrate (cold-seed only tails; the full history fetch
	// happens on first open), so this spawns a fresh G7 full-fetch goroutine.
	agg.EnsureMessagesAsync(context.Background(), "demo")
	if !h.waitForFull(1, 5*time.Second) {
		t.Fatal("async full fetch never entered (G7 not dispatched?)")
	}

	// BOTH G4 (cold-seed, via G6 tail workers) AND G7 (async full fetch) are
	// observably in flight. Stop() cancels runCtx — which both seedCtx and
	// fetchCtx derive from — aborting the in-flight GETs client-side via the
	// transport's ctx watch, AND closes the store. This is the full teardown
	// path; if any goroutine writes to the store after Close or sends on a
	// closed subscriber channel, it panics here.
	agg.Stop()

	// Release the server-side gates so the (now client-canceled) handler
	// goroutines exit too — keeps the goroutine-leak check below honest.
	h.releaseAll()

	// Assert (1)+(2): no panic, and Run returned (runCtx cancellation
	// propagated through cancel() → managed ctx → Run's loop guard).
	select {
	case <-runDone:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after Stop() (cancel not propagated to runCtx?)")
	}

	// Assert (3): the async-fetch in-flight slot is cleared. G7's defer (the
	// same one TestEnsureMessagesAsyncShutdownCancels checks) must run on the
	// Stop() path too — even though the store is now closed, the defer's
	// msgMu critical section + ClearColdFetchActive are post-Close-safe.
	if !waitSlotCleared(agg, "demo", 3*time.Second) {
		t.Fatal("msgInflight[\"demo\"] not cleared after Stop (G7 defer did not run?)")
	}

	// Assert (4): the cold-seed slot is cleared. G4's defer (the only code
	// path that nils seedDone) must run on Stop()'s ctx-cancel path.
	if !waitSeedDoneCleared(agg, 3*time.Second) {
		t.Fatal("seedDone not cleared after Stop (G4 defer did not run?)")
	}

	// Assert (5): no goroutine leak. After a settle window with GC, the count
	// returns to near-baseline: G1/G2/G3/G3a/G4/G6/G7 have all observed
	// ctx-cancel and exited. The tolerance covers transient httptest
	// connection-handler goroutines draining after the client disconnect.
	if !waitForGoroutineBounded(baseline, 6, 5*time.Second) {
		t.Fatalf("goroutine leak after Stop: baseline=%d, now=%d (G1..G7 should all have exited)", baseline, runtime.NumGoroutine())
	}
}

// TestRunManagedVsStop closes GAP-4: the seedMu-guarded `cancel` field is the
// ONLY happens-before edge between `go a.RunManaged(ctx)` (which writes
// a.cancel under seedMu inside RunManaged) and a concurrent `a.Stop()` (which
// reads a.cancel under seedMu). The web layer's aggMu provides NO such edge —
// it orders only the goroutine launch, not RunManaged's subsequent body. This
// test drives the two concurrently in a tight loop under -race to surface any
// data race on the field; it is the test most likely to catch a wrong seedMu
// lock-split.
//
// Verification command: `go test -race -count=100 -run TestRunManagedVsStop ./pkg/aggregator/`
//
// Each iteration: a FRESH aggregator (RunManaged is one-shot per aggregator),
// RunManaged on a goroutine, Stop() concurrently. A parent ctx guarantees Run
// returns this iteration even when Stop wins the race and reads cancel==nil
// (the default-aggregator nil-cancel path): without parentCancel, Run would
// keep looping against the now-closed store forever. The even/odd jitter via
// runtime.Gosched() lets the scheduler produce both orderings across iterations
// (Stop-before-arm = nil-cancel branch; Stop-after-arm = armed-cancel branch),
// both of which exercise the seedMu-guarded field access under -race.
func TestRunManagedVsStop(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	const n = 20
	runtime.GC()
	baseline := runtime.NumGoroutine()

	for i := 0; i < n; i++ {
		agg := New(oc.URL, 100)
		// Parent ctx guarantees deterministic cleanup this iteration even when
		// Stop wins the race (nil-cancel path: Stop closes the store but never
		// calls cancel, so Run would otherwise block on the closed store).
		parent, parentCancel := context.WithCancel(context.Background())
		runDone := make(chan struct{})
		go func() {
			agg.RunManaged(parent)
			close(runDone)
		}()
		// Jitter: even iterations yield so RunManaged's goroutine can arm
		// cancel first (armed-cancel branch); odd iterations race Stop in
		// before RunManaged schedules (nil-cancel branch). Both branches
		// acquire seedMu around the cancel field — the race under test.
		if i&1 == 0 {
			runtime.Gosched()
		}
		// Concurrent Stop: reads a.cancel under seedMu while RunManaged's
		// goroutine may be writing it under seedMu. Under -race this surfaces
		// any missing guard immediately.
		agg.Stop()
		// Guarantee Run returns this iteration regardless of which branch won.
		parentCancel()
		select {
		case <-runDone:
			// good — clean state this iteration
		case <-time.After(5 * time.Second):
			t.Fatalf("iter %d: Run did not return after Stop+parentCancel", i)
		}
	}

	// No goroutine leak across iterations: each Run + its G1/G2/G3 children
	// must have exited before the next iteration. A stuck ticker (G1/G2 that
	// did not observe ctx-cancel) would elevate the count for the full window.
	if !waitForGoroutineBounded(baseline, 10, 5*time.Second) {
		t.Fatalf("goroutine leak across %d iterations: baseline=%d, now=%d", n, baseline, runtime.NumGoroutine())
	}
}

// TestOnHydrateFiringDiscipline closes GAP-5: the onHydrate callback fires
// EXACTLY ONCE on a successful hydrate and NEVER on a failed hydrate. This is
// the fail-closed discipline the web-layer queue-GC (FIX-QUEUE-GC-3) depends on:
// it reads onHydrate as the signal that the store now holds the authoritative
// active-session set, and deletes on-disk queue.json files whose session IDs
// are NOT in that set. A spurious fire on failure would let it delete queues
// against an unauthoritative (empty/partial) set; a missed or double fire on
// success would either strand orphans or double-reconcile.
//
// hydrate's fire-site (aggregator.go hydrate tail) is reached ONLY on full
// success — every error path (ListSessions, the per-session Messages fetches
// inside hydrate are swallowed, but the early ListSessions return is the hard
// gate) returns before it. This test pins both branches.
func TestOnHydrateFiringDiscipline(t *testing.T) {
	t.Run("SuccessFiresExactlyOnce", func(t *testing.T) {
		oc := httptest.NewServer(fixtures.New().Handler())
		defer oc.Close()

		agg := New(oc.URL, 100)
		var count atomic.Int32
		agg.SetOnHydrate(func() {
			count.Add(1)
		})

		if err := agg.Rehydrate(context.Background()); err != nil {
			t.Fatalf("rehydrate: %v", err)
		}
		// onHydrate is invoked synchronously at the tail of a successful
		// hydrate (read under seedMu, invoked OUTSIDE the lock, on the same
		// goroutine that ran hydrate). By the time Rehydrate returns, the
		// counter must reflect exactly one fire — not 0 (missed) and not 2+
		// (double-fire from a retry/loop).
		if got := count.Load(); got != 1 {
			t.Fatalf("onHydrate fires: want exactly 1 on success, got %d", got)
		}
		if !agg.HydratedOnce() {
			t.Fatal("HydratedOnce must be true after a successful hydrate (fail-closed gate for queue-GC)")
		}
		// Let the background cold-seed finish so no G4 outlives the test.
		agg.waitColdSeed()
	})

	t.Run("FailureDoesNotFire", func(t *testing.T) {
		// /session returns 500 → hydrate fails at ListSessions and returns the
		// error BEFORE reaching the onHydrate fire-site (which sits after
		// store.Hydrate + the enrichment fan-out). This is the fail-closed
		// guarantee: a partial/failed hydrate leaves hydratedOnce=false and
		// fires nothing, so the web-layer queue-GC deletes NOTHING.
		mux := http.NewServeMux()
		mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "upstream down", http.StatusInternalServerError)
		})
		mux.Handle("/", fixtures.New().Handler())
		oc := httptest.NewServer(mux)
		defer oc.Close()

		agg := New(oc.URL, 100)
		var count atomic.Int32
		agg.SetOnHydrate(func() {
			count.Add(1)
		})

		err := agg.Rehydrate(context.Background())
		if err == nil {
			t.Fatal("Rehydrate must surface the ListSessions failure (hydrate returns it directly)")
		}
		// The fail-closed invariant: onHydrate must NOT fire on failure.
		if got := count.Load(); got != 0 {
			t.Fatalf("onHydrate must NOT fire on failure (fail-closed for queue-GC), got %d", got)
		}
		if agg.HydratedOnce() {
			t.Fatal("HydratedOnce must stay false after a failed hydrate (no authoritative session set)")
		}
	})
}
