package web

// Shutdown-window admission tests for the two HTTP-driven bgWG arms (review
// DEFER F6 on the 919c4c2 WaitGroup-reuse fix — the same defect class the
// posthydrate gate closed): before this slice, handleArchive's cascade launch
// and handleQueueList's reconcile dispatch both called bgWG.Add with NO
// shutdownStarted gate. They were covered only by the production
// caller-drains-HTTP ordering, but the drain has a race window (a request
// already inside the handler when Shutdown starts), and an Add landing in
// Shutdown's waiter wake window panics ("sync: WaitGroup is reused before
// previous Wait has returned" — the scheduled-CI signature), while an Add
// after the Wait returned leaks an untracked goroutine racing the caller's
// teardown.
//
// Both tests set the flag the way Shutdown's first act does (white-box,
// watcherMu-guarded — the "controlled Shutdown" option) rather than racing a
// real Shutdown against a request, keeping them deterministic: no interleaving
// construction is needed because the asserted behavior is a REFUSAL, not a
// join. Sibling proofs:
//   - TestShutdownJoinsListSpawnedReconcile (queue_msg_reconcile_shutdown_
//     test.go) drives the IDENTICAL seeding shape with the flag CLEAR and
//     observes the spawn fire — the vacuity guard for the queue arm here: the
//     candidate seed does trigger a spawn pre-flag, so "no lookup fires" in
//     this test means the gate refused it, not that nothing was eligible.
//   - The archive 200 path is covered by the archive_job_test.go family; here
//     the 503 status + "server shutting down" body are unique to the gate (no
//     other path in handleArchive produces either), so the observed response
//     proves the refusal came from the gate.

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// setShutdownStarted flips the bg-admission flag exactly the way Shutdown's
// first act does (watcherMu-guarded set) WITHOUT running the rest of Shutdown
// — the deterministic stand-in for "a Shutdown began just before the request
// reached the handler". The test's t.Cleanup Shutdown fallback remains
// idempotent against it (Shutdown sets the flag again and proceeds).
func setShutdownStarted(srv *Server) {
	srv.watcherMu.Lock()
	srv.shutdownStarted = true
	srv.watcherMu.Unlock()
}

// TestShutdownWindowArchiveHandlerRefusesWith503 pins the archive arm's
// refusal contract: once shutdownStarted is set, POST /vh/archive must be
// REFUSED with 503 "server shutting down" — not accepted-then-dropped (the
// 200 {ok:true, affected} is a job-acceptance contract for an async cascade)
// and not admitted into bgWG (the WaitGroup-reuse panic class). Outcome
// assertions: the observed status+body, archiveJobsActive stays 0 (its
// increment is synchronous inside the handler, before the response is
// written — so a job admitted by this request would be visible immediately),
// and no SetArchived PATCH reaches the fake upstream within the one-sided
// negative window (an admitted cascade PATCHes within milliseconds).
func TestShutdownWindowArchiveHandlerRefusesWith503(t *testing.T) {
	// Fixture hygiene (same as the sibling shutdown tests): isolate ALL
	// stateBaseDir() persistence before NewServer.
	t.Setenv("VH_STATE_DIR", t.TempDir())
	root := t.TempDir()

	// Minimal fake OpenCode: count archive PATCHes (PATCH /session/{id}) so a
	// buggily-admitted cascade is observable. Nothing else on this path needs
	// the upstream — the gate fires before any store/upstream work, and the
	// defense-in-depth refusal fires before the cascade exists.
	var patches int64
	mux := http.NewServeMux()
	mux.HandleFunc("/session/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			atomic.AddInt64(&patches, 1)
		}
		http.Error(w, "not found", http.StatusNotFound)
	})
	oc := httptest.NewServer(mux)
	t.Cleanup(oc.Close)

	agg := aggregator.New(oc.URL, 20)
	srv, err := NewServer(agg, oc.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the flag already set
	})
	t.Chdir(root) // projectRoot("") → root (the default project)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// THE WINDOW: shutdown has started; the POST arrives anyway (the drain
	// race shape).
	setShutdownStarted(srv)

	body, _ := json.Marshal(map[string]any{"sessionID": "r"})
	req, err := http.NewRequest(http.MethodPost, web.URL+"/vh/archive", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Outcome: refused with 503 + the gate's body — never a 200 job
	// acceptance (status 503 and this body are produced ONLY by the shutdown
	// gates in handleArchive).
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("POST /vh/archive during shutdown: got %d, want 503 (the handler-top gate must refuse the job-acceptance contract, not honor it)", resp.StatusCode)
	}
	var respBody bytes.Buffer
	if _, err := respBody.ReadFrom(resp.Body); err != nil {
		t.Fatal(err)
	}
	if got := respBody.String(); got != "server shutting down\n" {
		t.Fatalf("POST /vh/archive during shutdown: body %q, want %q", got, "server shutting down\n")
	}

	// No cascade was admitted: archiveJobsActive is incremented synchronously
	// inside the handler BEFORE the response is written, so 0 here is
	// deterministic, not a settle.
	if got := atomic.LoadInt64(&srv.archiveJobsActive); got != 0 {
		t.Fatalf("archiveJobsActive = %d after the refused POST, want 0 — a cascade job was admitted during shutdown", got)
	}

	// One-sided negative window (the sibling tests' 300ms discipline): an
	// admitted cascade reaches its first SetArchived PATCH within
	// milliseconds; none may ever arrive.
	time.Sleep(300 * time.Millisecond)
	if got := atomic.LoadInt64(&patches); got != 0 {
		t.Fatalf("fake upstream saw %d archive PATCHes after the refused POST, want 0 — a cascade job ran despite the shutdown gate", got)
	}
}

// TestShutdownWindowQueueListSkipsReconcileSpawnButStillLists pins the queue
// arm's refusal contract: once shutdownStarted is set, GET
// /vh/session/{sid}/queue still answers 200 with the items (the refusal must
// NOT degrade the read), but the reconcile spawn is skipped — observable as
// the spawned pass's first upstream act (the exact-id message GET — the
// rendezvous TestShutdownJoinsListSpawnedReconcile observes with this same
// seeding shape) never firing. The skipped pass is best-effort cleanup
// retried on the FE's next poll; `unknown` items are terminal and never
// resent, so nothing is lost.
func TestShutdownWindowQueueListSkipsReconcileSpawnButStillLists(t *testing.T) {
	// Same fixture shape as TestShutdownJoinsListSpawnedReconcile (the
	// pre-flag proof this test's seeding is spawn-eligible).
	t.Setenv("VH_STATE_DIR", t.TempDir())
	root := t.TempDir()

	// Rendezvous inverted: the fake's exact-message handler signals entry. If
	// the (buggily admitted) pass reaches its lookup, this fires; the
	// assertion is that it never does.
	lookupEntered := make(chan struct{}, 1)
	enterLookup := func() {
		select {
		case lookupEntered <- struct{}{}:
		default:
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/session/{id}/message/{mid}", func(w http.ResponseWriter, r *http.Request) {
		enterLookup()
		http.Error(w, "not found", http.StatusNotFound)
	})
	oc := httptest.NewServer(mux)
	t.Cleanup(oc.Close)

	agg := aggregator.New(oc.URL, 20)
	srv, err := NewServer(agg, oc.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the flag already set
	})
	t.Chdir(root) // projectRoot("") → root (the default project)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	_ = srv.aggFor("") // install the default aggregator so aggForExisting finds it

	// Seed a reconcile candidate directly into the store (the
	// delivered-but-stuck shape — identical to the join test's seed):
	// unknown + correlation id + not terminal ⇒ List traffic WOULD spawn the
	// passive reconciler with the flag clear.
	st := srv.queues.store(root, "s1")
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:            "rc-1",
		Order:         1,
		State:         QueueUnknown,
		Text:          "stuck",
		OpencodeMsgID: "msg_stuck",
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// THE WINDOW: shutdown has started; the FE's poll arrives anyway.
	setShutdownStarted(srv)

	resp, err := http.Get(web.URL + "/vh/session/s1/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Outcome: the read is unaffected — 200, and the items still list.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET queue during shutdown: got %d, want 200 (the spawn refusal must not degrade the read)", resp.StatusCode)
	}
	var listed struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0].ID != "rc-1" {
		t.Fatalf("GET queue during shutdown: items = %+v, want exactly [rc-1] — the response must still carry the items", listed.Items)
	}

	// Outcome: the spawn was refused. One-sided negative window (the sibling
	// tests' 300ms discipline — same as their "still parked" observations,
	// here "never entered"): an admitted pass issues its exact-id lookup
	// within milliseconds (the join test observes it with this same seed);
	// it must never fire.
	select {
	case <-lookupEntered:
		t.Fatal("the list-spawned reconciler was dispatched during shutdown — tryBgAdd must refuse the bgWG admission once shutdownStarted is set")
	case <-time.After(300 * time.Millisecond):
		// No lookup fired: the spawn was refused.
	}
}

// TestShutdownWindowArchiveLaunchSiteRefusesWhenFlagLandsMidHandler pins the
// DEFENSE-IN-DEPTH launch-site refusal specifically (review G1 on f770c85b):
// the sibling test above sets shutdownStarted BEFORE dispatch, so only the
// handler-top gate (archive.go watcherMu read → 503) ever fires — it passes
// even if the launch-site tryBgAdd gate were deleted. This test drives the
// window BETWEEN the two gates: the request passes the top gate with the flag
// clear, then Shutdown starts while the handler is parked at the cascade
// launch's bgMu.Lock, and the launch-site tryBgAdd must refuse (503, no job)
// instead of an un-gated bgWG.Add landing in Shutdown's drain window.
//
// Rendezvous (deterministic, white-box, in-package):
//
//	test goroutine holds srv.bgMu → dispatch POST /vh/archive → handler passes
//	the top gate, does its store-local work, and PARKS at bgMu.Lock → poll
//	watcherOn[""] (armed by aggFor's ensurePermissionWatcher AFTER the top gate
//	and BEFORE the park — NewServer does not pre-arm it) to observe the
//	handler is past the top gate → setShutdownStarted → release bgMu → the
//	handler reaches tryBgAdd with the flag set → refused, deterministically.
//
// Lock-order safety: the only nested edge the test adds is bgMu→watcherMu
// (hold bgMu, then setShutdownStarted takes watcherMu) — the same legal edge
// tryBgAdd documents (server.go); no watcherMu holder ever acquires bgMu.
//
// WRONG-GATE DISCRIMINATOR (load-bearing): the launch-site refusal logs a
// line UNIQUE to that branch ("[archive] cascade admission refused at
// launch…" via the STDLIB log package — archive.go imports "log", NOT vhlog,
// so the capture must use log.SetOutput; a vhlog sink would see nothing); the
// top gate logs nothing. Status 503 + "server shutting down" alone cannot
// distinguish the gates — if the handler had NOT passed the top gate when the
// flag was set (scheduling), the TOP gate would produce the identical
// response. The watcherOn poll makes that ordering deterministic, and the
// log-line assertion makes any residual miss a VISIBLE failure, never a
// false green.
func TestShutdownWindowArchiveLaunchSiteRefusesWhenFlagLandsMidHandler(t *testing.T) {
	// Fixture hygiene (same as the sibling shutdown tests): isolate ALL
	// stateBaseDir() persistence before NewServer.
	t.Setenv("VH_STATE_DIR", t.TempDir())
	root := t.TempDir()

	// Minimal fake OpenCode: count archive PATCHes (PATCH /session/{id}) so a
	// buggily-admitted cascade is observable. Nothing else on this path needs
	// the upstream — the refusal fires before the cascade exists.
	var patches int64
	mux := http.NewServeMux()
	mux.HandleFunc("/session/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			atomic.AddInt64(&patches, 1)
		}
		http.Error(w, "not found", http.StatusNotFound)
	})
	oc := httptest.NewServer(mux)
	t.Cleanup(oc.Close)

	agg := aggregator.New(oc.URL, 20)
	srv, err := NewServer(agg, oc.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the in-body Shutdown below
	})
	t.Chdir(root) // projectRoot("") → root (the default project)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// Seed the live store with root "r" (archive_job_test.go's Apply pattern).
	// MANDATORY: with an empty store Descendants("r") returns nil and the
	// handler diverts into the resumeArchiveAffected network fallback
	// (archive.go) instead of reaching the launch site's bgMu park. A single
	// live root keeps affected = ["r"] (Descendants includes the id itself).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))

	// Capture the STDLIB log sink around the rendezvous (the launch-site line
	// is log.Printf; see the doc comment). lockedWriter is the package's
	// shared sink-swapping helper (stream_baseline_fallback_reason_test.go);
	// log.SetOutput is process-wide, and these tests never call t.Parallel().
	var logMu sync.Mutex
	var logBuf bytes.Buffer
	prevLog := log.Writer() // stdlib log.SetOutput returns no previous sink (vhlog's does)
	log.SetOutput(lockedWriter{&logMu, &logBuf})
	defer log.SetOutput(prevLog)

	// THE RENDEZVOUS, step 1: hold bgMu so the dispatched handler must park at
	// the cascade launch's bgMu.Lock — it cannot sneak past the park.
	srv.bgMu.Lock()

	// Step 2: dispatch the real mux-routed POST (with CSRF) on its own
	// goroutine — the handler will park, so the dispatch must not block us.
	type respErr struct {
		resp *http.Response
		err  error
	}
	respCh := make(chan respErr, 1)
	body, _ := json.Marshal(map[string]any{"sessionID": "r"})
	req, err := http.NewRequest(http.MethodPost, web.URL+"/vh/archive", bytes.NewReader(body))
	if err != nil {
		srv.bgMu.Unlock()
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	go func() {
		resp, err := http.DefaultClient.Do(req)
		respCh <- respErr{resp, err}
	}()

	// Step 3: observe the handler is PAST the top gate before setting the
	// flag. aggFor("") arms the default permission watcher — watcherOn[""]
	// flips false→true under watcherMu — and aggFor runs after the top gate
	// and before the bgMu park; NewServer leaves watcherOn empty, so the flip
	// is caused by THIS request alone. Once observed, the handler passed the
	// top gate with the flag clear and is parked (or imminently parking) at
	// the launch site — setting the flag now lands exactly in the mid-handler
	// window between the two gates.
	deadline := time.Now().Add(5 * time.Second)
	for {
		srv.watcherMu.Lock()
		pastTopGate := srv.watcherOn[""]
		srv.watcherMu.Unlock()
		if pastTopGate {
			break
		}
		if time.Now().After(deadline) {
			srv.bgMu.Unlock() // unwedge the parked handler before Fatal/cleanup
			t.Fatal(`POST /vh/archive never armed watcherOn[""] within 5s — the handler did not reach aggFor (unexpected early refusal/error on the path)`)
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Step 4: THE WINDOW — shutdown starts while the handler is parked at the
	// launch site (the drain-race shape: a request already inside the handler
	// when Shutdown begins).
	setShutdownStarted(srv)

	// Step 5: release the park. The handler proceeds under its bgMu hold to
	// tryBgAdd, which sees the flag and refuses — nothing is written to the
	// ResponseWriter yet, so the 503 keeps the job-acceptance contract honest.
	srv.bgMu.Unlock()

	select {
	case r := <-respCh:
		if r.err != nil {
			t.Fatal(r.err)
		}
		resp := r.resp
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("POST /vh/archive with shutdown starting mid-handler: got %d, want 503 (the launch-site gate must refuse, not accept-then-drop)", resp.StatusCode)
		}
		var respBody bytes.Buffer
		if _, err := respBody.ReadFrom(resp.Body); err != nil {
			t.Fatal(err)
		}
		if got := respBody.String(); got != "server shutting down\n" {
			t.Fatalf("POST /vh/archive with shutdown starting mid-handler: body %q, want %q", got, "server shutting down\n")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("POST /vh/archive never returned — the handler wedged at the launch site (bgMu deadlock?)")
	}

	// WRONG-GATE DISCRIMINATOR — the assertion that makes this test immune to
	// passing for the wrong reason: the launch-site refusal logs a line UNIQUE
	// to that branch; the top gate logs nothing. A missing line means the 503
	// came from the TOP gate (the flag beat the handler to it) or the
	// launch-site gate was deleted — either way, FAIL, never a false green.
	// The root=/affected=1 fragments additionally bind the line to THIS
	// request's store walk (the seeded single root), proving the handler did
	// the store-local work between the gates before parking.
	logMu.Lock()
	captured := logBuf.String()
	logMu.Unlock()
	if !strings.Contains(captured, "[archive] cascade admission refused at launch") {
		t.Fatalf("launch-site refusal log line missing — the 503 came from the WRONG GATE (handler-top) or the launch-site tryBgAdd gate is gone. Captured stdlib log: %q", captured)
	}
	if !strings.Contains(captured, `root="r"`) || !strings.Contains(captured, "affected=1") {
		t.Fatalf("launch-site refusal log line does not bind to this request's seeded root (want root=%q affected=1): %q", "r", captured)
	}

	// No cascade was admitted: archiveJobsActive is incremented synchronously
	// inside the handler BEFORE the response is written, so 0 here is
	// deterministic, not a settle.
	if got := atomic.LoadInt64(&srv.archiveJobsActive); got != 0 {
		t.Fatalf("archiveJobsActive = %d after the launch-site refusal, want 0 — a cascade job was admitted during shutdown", got)
	}

	// No Slice-2 registry entry leaked for the seeded root (the launch site
	// skips the registration together with the job; read under bgMu).
	srv.bgMu.Lock()
	_, registered := srv.archiveJobsActiveRoots[archiveFailureKey{Dir: "", ID: "r"}]
	entries := len(srv.archiveJobsActiveRoots)
	srv.bgMu.Unlock()
	if registered || entries != 0 {
		t.Fatalf("archiveJobsActiveRoots after the launch-site refusal: registered=%v entries=%d, want none — the refusal must skip the registry together with the job", registered, entries)
	}

	// One-sided negative window (the sibling tests' 300ms discipline): an
	// admitted cascade reaches its first SetArchived PATCH within
	// milliseconds; none may ever arrive.
	time.Sleep(300 * time.Millisecond)
	if got := atomic.LoadInt64(&patches); got != 0 {
		t.Fatalf("fake upstream saw %d archive PATCHes after the launch-site refusal, want 0 — a cascade job ran despite the shutdown gate", got)
	}

	// Clean teardown: Shutdown must complete within its budget — a leaked
	// bgMu holder or an un-joined bg goroutine (the exact defect class the
	// gate exists to prevent) would hang or error here.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("Shutdown after the launch-site refusal: %v — a bg goroutine or lock holder leaked past the refusal", err)
	}
}
