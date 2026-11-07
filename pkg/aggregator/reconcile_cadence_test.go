package aggregator

// reconcile_cadence_test.go — the tree reconcile must not re-fetch the full
// archived list on every tick. OpenCode ignores ?archived=true and returns ALL
// of a project's sessions, so doing it per tick on 10k+-session projects kept
// OpenCode's single JS thread pinned. The archived refresh is spaced by
// archivedSnapshotInterval (hydrate always refreshes), and onConnected fires
// once per OpenCode connection.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// patchArchiveSession archives id via the fixture's native PATCH /session/<id>
// (sets time.archived, mirroring real OpenCode — the same route
// orphan_snapshot_test.go drives). After this, /session excludes id and
// /session?archived=true includes it.
func patchArchiveSession(t *testing.T, baseURL, id string) {
	t.Helper()
	patchBody := fmt.Sprintf(`{"time":{"archived":%d}}`, time.Now().UnixMilli())
	req, err := http.NewRequest(http.MethodPatch, baseURL+"/session/"+id, strings.NewReader(patchBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("archive %s: %v", id, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("archive %s: expected 200, got %d", id, resp.StatusCode)
	}
}

// listCounter counts live (/session?limit=) vs archived (?archived=true) list
// requests, delegating everything to the fixture.
type listCounter struct {
	inner    http.Handler
	live     atomic.Int64
	archived atomic.Int64
}

func (c *listCounter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("archived") == "true" {
		c.archived.Add(1)
	} else {
		c.live.Add(1)
	}
	c.inner.ServeHTTP(w, r)
}

func runCountingAggregator(t *testing.T, tree, idle, archived time.Duration) (*Aggregator, *listCounter, func()) {
	t.Helper()
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	mux := http.NewServeMux()
	mux.Handle("/session", cnt) // exact path: only the list endpoint
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = tree
	agg.treeReconcileIdleInterval = idle // set before Run: read by the reconcile goroutine
	agg.archivedSnapshotInterval = archived
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		oc.Close()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
		oc.Close()
	}
	return agg, cnt, stop
}

func waitLiveTicks(t *testing.T, cnt *listCounter, atLeast int64) {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for cnt.live.Load() < atLeast {
		if time.Now().After(end) {
			t.Fatalf("tree reconcile ticked only %d times, want >= %d", cnt.live.Load(), atLeast)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// Many tree ticks, long archived interval → the archived list is fetched once
// (by hydrate), not once per tick.
func TestTreeReconcile_ArchivedRefreshNotPerTick(t *testing.T) {
	_, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, 0, time.Hour)
	defer stop()
	waitLiveTicks(t, cnt, 12) // hydrate + ≥11 reconcile ticks
	if got := cnt.archived.Load(); got != 1 {
		t.Errorf("archived list fetched %d times across %d live-list fetches; want exactly 1 (hydrate only)", got, cnt.live.Load())
	}
}

// Regression (cold-start duplicate): the reconcile ticker spawns before the
// first hydrate runs, so a tick can observe lastArchivedRefresh==0 ("never
// refreshed yet") while the hydrate's own archived-snapshot fetch is still in
// flight — and fire a duplicate /session?archived=true concurrent with it.
// The handler below gates the release on an EVENT, not a timer: it holds
// archived responses until the live-list count reaches 3 (hydrate's own live
// fetch is #1, so ≥2 reconcile ticks have completed their live fetch and
// reached the archived-due decision) before letting them through. On ungated
// code the first tick's due-check necessarily passes while the hold is open
// (its live fetch made the count 2 < 3, so no archived response has completed
// and lastArchivedRefresh is still 0) and its duplicate is counted at handler
// entry — ≥2 archived arrivals are banked before any release, making the RED
// (archived != 1) deterministic on schedules where ≥2 ticks complete their
// live fetch before the cap. If extreme CPU starvation fires the 3s cap
// first, the red is NOT guaranteed — the hold-exit flag below detects that
// escape and fails the run as an explicit INCONCLUSIVE instead of a silent
// green. What remains inherently scheduler-bound is the instruction-level
// ordering between one tick's live-fetch return and its due-check
// (unobservable from the HTTP handler), which is why the release waits for a
// whole extra tick's live fetch instead of trying to catch the check itself.
// The hold is also bounded (see the handler): ungated code deadlocks the
// release condition itself — the duplicate fetch freezes the single reconcile
// goroutine and the live count with it — so the cap turns that hang into the
// count failure above. archivedSnapshotDue must hold the tick off until a
// hydrate has completed (gate added there).
func TestTreeReconcile_NoArchivedDupWhileColdStartSnapshotInFlight(t *testing.T) {
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	// t1b-F1(A): which condition ended a hold — the live>=3 handshake
	// (the adversarial schedule was established) or the 3s cap (it was
	// NOT; the run is inconclusive, see the assertion after the count).
	var holdExitByDeadline atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("archived") == "true" {
			// t1b-F1(B): count the archived arrival at handler ENTRY,
			// before the hold — the accounting is then immune to release
			// ordering (event vs cap, and in which order held responses
			// are let through): the count reflects arrivals, not
			// completions.
			cnt.archived.Add(1)
			// Event-based release: hold archived responses until ≥2
			// reconcile ticks have completed their live fetch (hydrate's
			// live fetch is #1) — i.e. ticks have reached the archived-due
			// decision while the hydrate's own fetch is still in flight
			// and lastArchivedRefresh is still 0. The hold is bounded (and
			// well under waitForAnyHydrateCompleted's timeout): on ungated
			// code the duplicate tick fetch is itself held, which freezes
			// the single reconcile goroutine and with it the live count —
			// the cap lets every handler complete so the test fails on the
			// fetch count instead of hanging the server close.
			deadline := time.Now().Add(3 * time.Second)
			for cnt.live.Load() < 3 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			// t1b-F1(A): record which hold-exit condition fired. On
			// ungated code the cap exit is the designed red path (the
			// count assertion below fires); on gated code a cap exit
			// means the harness never established the schedule — the
			// post-run assertion turns that into a loud inconclusive.
			if cnt.live.Load() < 3 {
				holdExitByDeadline.Store(true)
			}
			cnt.inner.ServeHTTP(w, r)
			return
		}
		cnt.live.Add(1)
		cnt.inner.ServeHTTP(w, r)
	})
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.treeReconcileIdleInterval = 0
	agg.archivedSnapshotInterval = time.Hour
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
	}
	defer stop()

	waitLiveTicks(t, cnt, 12)
	got := cnt.archived.Load()
	if got != 1 {
		t.Errorf("archived list fetched %d times across %d live-list fetches; want exactly 1 (hydrate's in-flight fetch, no tick duplicate)", got, cnt.live.Load())
	}
	// t1b-F1(A): a green count alone is not proof. If the hold exited via
	// its 3s cap rather than the live>=3 handshake, the harness never
	// established the adversarial schedule, so archived==1 says nothing
	// about the gate — fail LOUDLY as inconclusive instead of banking a
	// false green. (On ungated code the cap exit is the designed red path
	// and the count error above already fired, so the got==1 guard keeps
	// this from masking that red with a confusing message.)
	if got == 1 && holdExitByDeadline.Load() {
		t.Fatalf("INCONCLUSIVE: held archived response(s) exited via the 3s cap before the live>=3 handshake (live=%d) — the cold-start overlap schedule was never established, so archived==1 is not a gate proof", cnt.live.Load())
	}
}

// The retry branch: hydrate's own archived-snapshot fetch is best-effort —
// a failure leaves lastArchivedRefresh==0 and the snapshot stale, and the
// next reconcile tick (gate open, "never refreshed") must retry it. The
// handler below fails the FIRST archived arrival with a 500, then
// succeeds. The failed arrival is hydrate's own fetch: the
// completed-hydrate gate holds ticks off until after hydrate's fan-out, so
// no tick can reach the archived endpoint first. Both arrivals are counted
// (the failed one too — it is the retry trigger the assertion observes).
func TestTreeReconcile_RetriesArchivedSnapshotAfterHydrateFetchFailed(t *testing.T) {
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	var failArchived atomic.Bool
	failArchived.Store(true)
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("archived") == "true" {
			cnt.archived.Add(1)
			if failArchived.CompareAndSwap(true, false) {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			cnt.inner.ServeHTTP(w, r)
			return
		}
		cnt.ServeHTTP(w, r)
	})
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	// t1b-F2: seed a real archived session via the fixture's native PATCH
	// (sets time.archived, mirroring real OpenCode) BEFORE the aggregator
	// starts, so the store-state verifier below can prove the retry's
	// response was APPLIED, not just dispatched.
	patchArchiveSession(t, oc.URL, "demo")

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.treeReconcileIdleInterval = 0
	agg.archivedSnapshotInterval = time.Hour
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
	}
	defer stop()

	// Hydrate's attempt (#1) failed; the next tick's retry (#2) must
	// succeed and refresh the snapshot. Long archived interval: any
	// further fetch beyond the retry is a spacing bug, but ≥2 is the
	// contract under test here.
	end := time.Now().Add(5 * time.Second)
	for cnt.archived.Load() < 2 {
		if time.Now().After(end) {
			t.Fatalf("archived fetch count %d; want >= 2 (hydrate's failed attempt + the tick's successful retry)", cnt.archived.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}

	// t1b-F2: ≥2 arrivals pins DISPATCH only — the count cannot tell a
	// retry whose response was processed from one whose response was
	// discarded. Pin APPLICATION: arrival #1 failed, so nothing has set
	// lastArchivedRefresh yet, and the 1h interval blocks any refresh
	// beyond the first success — a nonzero value can ONLY be the
	// successful retry's apply (refreshArchivedSnapshot's Store runs
	// after the snapshot rebuild). A discard-response mutant that skips
	// the apply is caught here, not by the count above.
	applyEnd := time.Now().Add(5 * time.Second)
	for agg.lastArchivedRefresh.Load() == 0 {
		if time.Now().After(applyEnd) {
			t.Fatalf("retry dispatched (archived arrivals: %d) but never applied: lastArchivedRefresh still 0", cnt.archived.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
	// lastArchivedRefresh is stored after RefreshArchivedSnapshot, so a
	// nonzero value already implies the snapshot rebuild ran. Store-state
	// proof the applied snapshot is the real archived set: demo
	// (PATCH-archived above) is in it, so the sweep flags its live child
	// sub; the unrelated live root other is never flagged (e88f19e gate).
	if !agg.Store().IsOrphanFlagged("sub") {
		t.Errorf("retry applied but snapshot is wrong: sub should be orphan-flagged (demo in the archived set) after the successful retry")
	}
	if agg.Store().IsOrphanFlagged("other") {
		t.Errorf("live root other should NOT be orphan-flagged")
	}
}

// The reconnect-overlap benigncy (t1a-F1): hydration.go documents that
// anyHydrateCompleted is sticky, so on every hydrate AFTER the first the
// completed-hydrate gate is already open while that hydrate's own
// archived-snapshot fetch is still in flight — a reconcile tick whose
// interval has elapsed may then overlap that fetch. Documented BENIGN:
// refreshArchivedSnapshot's fetch runs outside any store lock and the apply
// is store-locked and idempotent, so neither side can deadlock or corrupt
// the snapshot. Nothing exercised that claim. This test makes the overlap
// DETERMINISTIC — a tick's refresh is parked mid-flight (held at the
// handler, counted at entry per the cold-start test's discipline), then
// agg.Rehydrate (the same hydrate seam the reconnect loop at lifecycle.go
// and POST /vh/reload drive) runs its own archived fetch while the tick's
// is still in flight — and asserts the documented outcome on release.
//
// f3 hardening (review 81a0a8df F1/F2/F3): the original final assertions
// could be satisfied by PRE-overlap state — the initial hydrate already set
// lastArchivedRefresh, the archived snapshot, and sub's orphan flag, so a
// skip-apply-under-overlap mutant was unobservable. Now a synthetic LIVE
// child of the archived demo ("sub2") is injected into /session responses
// only AFTER the initial hydrate completed: sub2 is state that hydrate
// NEVER saw, so every sub2-derived assertion below can only be satisfied by
// an apply that consumed post-arming responses. The fixture itself has no
// second parent→child edge to archive (POST /session creates parentless
// roots, which the e88f19e gate never flags), so the discrimination is
// injected at this test's own /session wrapper — the fixture's real
// archived list keeps flowing untouched. Attribution is exact, not
// timing-based: ReconcileSessions never ADDS unknown ids (ghost-evict
// only), so sub2 enters the store precisely at the rehydrate's
// store.Hydrate, and is orphan-flagged precisely by an archived-snapshot
// sweep — i.e. by one of the two overlap applies. The tick's own apply
// (unawaited by RunManaged's Stop, which does not join runTreeReconcile)
// gets a dedicated witness: the archived spacing is stretched to 1h BEFORE
// the tick is released, so after release the only possible
// lastArchivedRefresh writer is the parked tick's completing apply.
func TestRehydrateArchivedRefreshOverlapIsBenign(t *testing.T) {
	fx := fixtures.New()
	fxHandler := fx.Handler()
	// Hold-gate state, all under one mutex so the handler stays race-free.
	// Once armed, the first two archived arrivals are parked (response
	// withheld), each on its own release channel; arrivals are counted at
	// handler ENTRY while the armed window is open.
	var mu sync.Mutex
	armed := false
	arrivals := 0 // archived arrivals while armed (the overlap-window count)
	// shapeLive arms the f3 discriminator: while set, every LIVE /session
	// response gets the synthetic sub2 row appended (see the live branch
	// below). Armed only after the initial hydrate completed, so sub2 is
	// post-arming state by construction.
	shapeLive := false
	holds := []chan struct{}{}
	closeHolds := func(indices ...int) { // idempotent per slot
		mu.Lock()
		defer mu.Unlock()
		for _, i := range indices {
			if i < len(holds) && holds[i] != nil {
				close(holds[i])
				holds[i] = nil
			}
		}
	}
	// disarm closes the armed window: later archived arrivals pass through
	// unheld and uncounted. EVERY early-failure path must disarm before
	// releasing parked holds — a goroutine unblocked during teardown (e.g.
	// a Rehydrate that was blocked on a held lock) can still issue a late
	// archived fetch, and it must never park on a channel the dying test
	// will not close (httptest.Server.Close waits for it otherwise).
	disarm := func() {
		mu.Lock()
		armed = false
		mu.Unlock()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("archived") != "true" {
			// f3-F1/F3 discriminator injection. The fixture has no second
			// parent→child edge (POST /session mints parentless roots, and a
			// root is never orphan-flagged — the e88f19e gate), so a second
			// natively-archived session would change the archived list with
			// NO observable store effect. Instead: while shapeLive is armed,
			// append sub2 — a LIVE child of the (pre-start) archived demo —
			// to the fixture's real live list. The initial hydrate never sees
			// sub2 (shaping is armed only after waitForAnyHydrateCompleted),
			// and the tick's own live path cannot introduce it
			// (ReconcileSessions evicts ghosts, it never adds unknown ids),
			// so sub2 enters the store exactly at the rehydrate's
			// store.Hydrate — and is orphan-flagged exactly by an
			// archived-snapshot sweep. That makes IsOrphanFlagged("sub2") a
			// fully-attributed witness of an overlap APPLY, impossible to
			// satisfy from pre-overlap state.
			mu.Lock()
			shape := shapeLive
			mu.Unlock()
			if !shape {
				fxHandler.ServeHTTP(w, r)
				return
			}
			rec := httptest.NewRecorder()
			fxHandler.ServeHTTP(rec, r)
			var rows []map[string]any
			if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &rows) != nil {
				http.Error(w, "fixture live list undecodable under shaping", http.StatusInternalServerError)
				return
			}
			now := float64(time.Now().UnixMilli())
			sub2 := map[string]any{
				"id": "sub2", "projectID": "proj", "parentID": "demo",
				"title": "Subagent: overlap discriminator",
				"time":  map[string]any{"created": now - 100, "updated": now - 50},
			}
			if len(rows) > 0 {
				sub2["directory"] = rows[0]["directory"]
			}
			rows = append(rows, sub2)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if err := json.NewEncoder(w).Encode(rows); err != nil {
				return // client went away; nothing else to do
			}
			return
		}
		mu.Lock()
		var release chan struct{}
		if armed {
			arrivals++ // entry-side count: immune to release ordering
			if len(holds) < 2 {
				release = make(chan struct{})
				holds = append(holds, release)
			}
		}
		mu.Unlock()
		if release != nil {
			<-release // park this fetch mid-flight until the test releases it
		}
		fxHandler.ServeHTTP(w, r)
	})
	mux.Handle("/", fxHandler)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	// Seed the archived set via the fixture's native PATCH: demo archived,
	// its live child sub stays in /session. After the overlap the store
	// verifiers must see sub orphan-flagged with its chain terminating at
	// the archived demo — the snapshot was rebuilt correctly DESPITE the
	// concurrent refreshes.
	patchArchiveSession(t, oc.URL, "demo")

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.treeReconcileIdleInterval = 0
	agg.archivedSnapshotInterval = time.Millisecond // every tick due → the tick refresh arrives promptly once armed (stretched to 1h later, before the tick's release, to isolate its apply as the only remaining refresher)
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
	}
	defer stop()

	// f3 discriminator FIRST (between the initial hydrate and the hold-gate
	// arming): from here on, live /session responses carry sub2 — state the
	// initial hydrate never saw. Everything the overlap applies from this
	// point is distinguishable from pre-overlap state.
	mu.Lock()
	shapeLive = true
	mu.Unlock()

	// Arm the hold, then wait for the next tick's refresh to park
	// (interval=1ms ⇒ every tick is due; the single reconcile goroutine
	// then blocks in the held fetch, so at most this one parks).
	mu.Lock()
	armed = true
	mu.Unlock()
	tickWait := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		held := len(holds)
		mu.Unlock()
		if held >= 1 {
			break
		}
		if time.Now().After(tickWait) {
			disarm()
			closeHolds(0, 1)
			cancel()
			t.Fatalf("no tick archived refresh arrived to hold (armed arrivals: %d)", func() int { mu.Lock(); defer mu.Unlock(); return arrivals }())
		}
		time.Sleep(time.Millisecond)
	}

	// f3-F2 attribution baseline. The reconcile goroutine — the only
	// periodic archived refresher — is parked inside the held tick fetch,
	// and no other hydrate is running, so between now and the rehydrate's
	// return the ONLY possible lastArchivedRefresh writer is the
	// rehydrate's own apply. (A pre-arming tick fetch cannot still be in
	// flight: the reconcile goroutine is serial — one archived fetch at a
	// time — and it is the one now parked.)
	tPre := agg.lastArchivedRefresh.Load()

	// With the tick's refresh parked mid-flight, run a full hydrate
	// (Rehydrate = the reconnect loop's hydrate seam): its own archived
	// fetch arrives WHILE the tick's is still in flight — arrival #2 of
	// the overlap.
	rehydrateDone := make(chan error, 1)
	go func() { rehydrateDone <- agg.Rehydrate(context.Background()) }()
	overlapWait := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		held, seen := len(holds), arrivals
		mu.Unlock()
		if held == 2 {
			break
		}
		if time.Now().After(overlapWait) {
			disarm()
			closeHolds(0, 1)
			cancel()
			t.Fatalf("overlap never formed: %d held, %d armed arrivals", held, seen)
		}
		time.Sleep(time.Millisecond)
	}

	// Release in a chosen order: the rehydrate's fetch (arrival #2) FIRST —
	// its apply (store.RefreshArchivedSnapshot + lastArchivedRefresh) must
	// complete while the tick's fetch is still parked mid-flight — then
	// the tick's. The armed window closes here: later arrivals (the next
	// tick's refresh after the tick's release) pass through uncounted.
	disarm()
	closeHolds(1) // the rehydrate's fetch (arrival #2)
	select {
	case err := <-rehydrateDone:
		if err != nil {
			closeHolds(0)
			cancel()
			t.Fatalf("Rehydrate over an in-flight tick refresh failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		// Release the parked tick so server close does not hang on it;
		// the rehydrate goroutine may still leak — that IS the deadlock
		// this assertion exists to catch.
		closeHolds(0)
		cancel()
		t.Fatal("Rehydrate deadlocked against the parked tick refresh")
	}

	// f3-F1/F2: Rehydrate returned nil — but nil only proves DISPATCH. A
	// mutant that discards the apply when a refresh is concurrently in
	// flight (the exact overlap condition here: the tick's fetch is still
	// parked) would also return nil, and the OLD assertions could not tell.
	// The attribution baseline tPre makes this discriminating: the parked
	// reconcile goroutine cannot write, so a value strictly greater than
	// tPre can ONLY be the rehydrate's own apply — and since
	// lastArchivedRefresh is stored AFTER store.RefreshArchivedSnapshot,
	// advancement proves the store apply ran, not just the fetch.
	if got := agg.lastArchivedRefresh.Load(); got <= tPre {
		closeHolds(0)
		cancel()
		t.Fatalf("Rehydrate returned nil but its archived-snapshot apply never landed (lastArchivedRefresh %d, not > pre-spawn %d) — an apply-discard under the overlap would look exactly like this", got, tPre)
	}
	// f3-F1/F3: the applied snapshot carried POST-arming state. sub2 was
	// added to the store by this rehydrate's store.Hydrate (its live list
	// was shaped), and its archived apply then swept the snapshot — so the
	// sweep MUST have orphan-flagged sub2 (parent demo is in the archived
	// set). No pre-overlap write can satisfy this: the initial hydrate
	// never saw sub2, and the tick's live path cannot add it. This is the
	// discriminating replacement for the old pre-overlap-satisfiable
	// snapshot assertions.
	if !agg.Store().IsOrphanFlagged("sub2") {
		closeHolds(0)
		cancel()
		t.Fatalf("rehydrate nil'd and advanced lastArchivedRefresh, but sub2 is not orphan-flagged: the apply did not consume the post-arming responses (pre-overlap state would look exactly like this)")
	}

	// f3-F2: completion witness for the PARKED TICK's apply. tRh is the
	// value the rehydrate's apply just wrote; the tick's fetch is STILL
	// parked, so the witness starts definitionally false — it cannot pass
	// vacuously. Stretch the archived spacing BEFORE the release: with a
	// 1h interval no later tick can refresh the snapshot, so after the
	// release the ONLY possible writer is the parked tick's own completing
	// apply. (RunManaged's Stop does not join runTreeReconcile, which is
	// why this apply needs its own witness at all.) The interval write is
	// race-free: the reconcile goroutine is parked on the hold channel,
	// and this write happens-before close(holds[0]) happens-before its
	// receive happens-before its next archivedSnapshotDue read.
	//
	// Wall-clock hazard (tPre/tRh witnesses): strict > on time.Now().UnixNano()
	// means an NTP step-backward can only false-RED loudly, never false-green.
	tRh := agg.lastArchivedRefresh.Load()
	agg.archivedSnapshotInterval = time.Hour
	closeHolds(0) // the tick's fetch (arrival #1) — its apply lands asynchronously
	tickApplyEnd := time.Now().Add(5 * time.Second)
	for agg.lastArchivedRefresh.Load() <= tRh {
		if time.Now().After(tickApplyEnd) {
			// Hard fail: the rehydrate's earlier apply can already satisfy
			// the post-tick asserts below — falling through invites false-comfort.
			cancel()
			t.Fatalf("the parked tick's archived apply never landed after release: lastArchivedRefresh %d never advanced past the rehydrate's %d — a tick-side apply discard would look exactly like this", agg.lastArchivedRefresh.Load(), tRh)
		}
		time.Sleep(2 * time.Millisecond)
	}
	// The tick's apply re-ran the sweep over the same post-arming state:
	// sub2 stays flagged and its chain still terminates at the archived
	// demo. (lastArchivedRefresh advanced ⟹ RefreshArchivedSnapshot ran
	// first, so these are direct asserts — no poll needed.)
	if !agg.Store().IsOrphanFlagged("sub2") {
		t.Errorf("sub2 not orphan-flagged after the tick's apply: the tick-side snapshot rebuild dropped the post-arming state")
	}
	if !agg.Store().ChainTerminatesAtArchived("sub2") {
		t.Errorf("sub2's parent chain should terminate at archived demo after the overlap applies")
	}

	// Exactly the documented pair: the parked tick refresh + the
	// rehydrate's own fetch. No third archived arrival can squeeze into
	// the armed window (the single reconcile goroutine was parked; one
	// hydrate = one fetch) — a third would mean a spacing/storm defect.
	mu.Lock()
	gotArrivals := arrivals
	mu.Unlock()
	if gotArrivals != 2 {
		t.Errorf("armed window saw %d archived arrivals, want exactly 2 (the tick's refresh + the rehydrate's fetch)", gotArrivals)
	}
	// The overlap applied: lastArchivedRefresh nonzero. Kept as the cheap
	// corruption sentinel (zero would mean an overlap apply CLEARED it);
	// the discriminating advancement proofs are the tPre/tRh witnesses
	// above, which this is strictly weaker than.
	if agg.lastArchivedRefresh.Load() == 0 {
		t.Errorf("lastArchivedRefresh == 0 after the overlap: no successful archived refresh was applied")
	}
	// Store state after the benign overlap: the snapshot is the real
	// archived set (demo in it), so the sweep flags its live child and the
	// chain verifier confirms the termination. Poll: the tick's apply
	// lands asynchronously after its release.
	flagEnd := time.Now().Add(5 * time.Second)
	for !agg.Store().IsOrphanFlagged("sub") {
		if time.Now().After(flagEnd) {
			t.Errorf("sub not orphan-flagged after the overlap: snapshot not rebuilt from the archived set")
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !agg.Store().ChainTerminatesAtArchived("sub") {
		t.Errorf("sub's parent chain should terminate at archived demo after the overlap")
	}
	if agg.Store().IsOrphanFlagged("other") {
		t.Errorf("live root other should NOT be orphan-flagged")
	}
}

// Control: with a short archived interval the reconcile does refresh it
// periodically (the gate is spacing, not disabling).
func TestTreeReconcile_ArchivedRefreshStillPeriodic(t *testing.T) {
	_, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, 0, 10*time.Millisecond)
	defer stop()
	end := time.Now().Add(5 * time.Second)
	for cnt.archived.Load() < 3 {
		if time.Now().After(end) {
			t.Fatalf("archived refresh ran %d times; want periodic refreshes (>= 3)", cnt.archived.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// onConnected fires once per connection, after that connection's first
// successful hydrate — not on reconcile ticks.
func TestOnConnectedFiresOncePerConnection(t *testing.T) {
	fx := fixtures.New()
	oc := httptest.NewServer(fx.Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.statusReconcileInterval = time.Hour
	var fired atomic.Int64
	agg.SetOnConnected(func() {
		if !agg.AnyHydrateCompleted() {
			t.Error("onConnected fired before the connection's hydrate completed")
		}
		fired.Add(1)
	})

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	time.Sleep(100 * time.Millisecond) // ~20 reconcile ticks on the same connection
	if got := fired.Load(); got != 1 {
		t.Errorf("onConnected fired %d times on one connection, want 1", got)
	}
	cancel()
	<-runDone
	agg.Stop()
	agg.waitColdSeed()
}

// With no live archive tombstone the reconcile skips its full /session fetch
// until the idle interval elapses; a fresh archive (tombstone) brings the fast
// cadence back so clobber-revert detection keeps its timing.
func TestTreeReconcile_IdleUntilTombstone(t *testing.T) {
	agg, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, time.Hour, time.Hour)
	defer stop()

	base := cnt.live.Load()
	time.Sleep(100 * time.Millisecond) // ~20 ticks, no tombstone
	if got := cnt.live.Load(); got > base+1 {
		t.Fatalf("idle reconcile still fetched /session every tick: %d -> %d", base, got)
	}

	agg.Store().RemoveSessions([]string{"other"}) // arms a live tombstone
	waitLiveTicks(t, cnt, cnt.live.Load()+5)      // fast cadence resumes
}
