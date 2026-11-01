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
	"net/http"
	"net/http/httptest"
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
