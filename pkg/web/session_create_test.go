package web

// Create-certainty Slice 1 — worker route/cache contract tests (beside the
// verbs_test.go replay/in-flight precedents). The PRIMARY ACCEPTANCE GATE is
// TestSessionCreateRecoveryLookupMissNeverCreates: a recovery-lookup miss
// causes ZERO upstream creates — the receipt GET is a pure lookup, never
// execute-on-miss (the deliberate difference from WithIdempotency).

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// getj issues a plain GET and decodes the JSON body (no CSRF needed on GET).
func getj(t *testing.T, url string) (int, map[string]any, http.Header) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out, resp.Header
}

// wantState asserts the uniform receipt envelope fields.
func wantState(t *testing.T, where string, st int, out map[string]any, wantSt int, wantStateVal string) {
	t.Helper()
	if st != wantSt {
		t.Fatalf("%s: status want %d, got %d (body %v)", where, wantSt, st, out)
	}
	if out["protocol"] != sessionCreateProtocol || out["version"] != float64(sessionCreateVersion) {
		t.Fatalf("%s: envelope want protocol=%s version=%d, got %v", where, sessionCreateProtocol, sessionCreateVersion, out)
	}
	if out["state"] != wantStateVal {
		t.Fatalf("%s: state want %q, got %v (body %v)", where, wantStateVal, out["state"], out)
	}
}

func TestSessionCreateCapabilities(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st, out, h := getj(t, web.URL+"/vh/session/create/capabilities")
	if st != 200 {
		t.Fatalf("capabilities: want 200, got %d (%v)", st, out)
	}
	if cc := h.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("capabilities: Cache-Control want no-store, got %q", cc)
	}
	if out["protocol"] != sessionCreateProtocol || out["version"] != float64(1) || out["recovery_only"] != true {
		t.Fatalf("capabilities body mismatch: %v", out)
	}
	// Non-mutating posture: POST is method-not-allowed (and never reaches upstream).
	stp, _, _ := post(t, web.URL+"/vh/session/create/capabilities", `{}`, nil)
	if stp != http.StatusMethodNotAllowed {
		t.Fatalf("capabilities POST: want 405, got %d", stp)
	}
	if f.creates != 0 {
		t.Fatalf("capabilities must never create, got creates=%d", f.creates)
	}
}

func TestSessionCreateFreshMintsReceipt(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st, out, h := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-fresh"}`, nil)
	wantState(t, "fresh create", st, out, 200, sessionCreateStateCreated)
	if out["replayed"] != false {
		t.Fatalf("fresh create: replayed want false, got %v", out["replayed"])
	}
	if out["sessionID"] != "new_sess" {
		t.Fatalf("fresh create: sessionID want new_sess, got %v", out["sessionID"])
	}
	if h.Get("X-VH-Idempotent-Replay") != "" {
		t.Fatal("fresh create must not carry the legacy replay header")
	}
	if f.creates != 1 {
		t.Fatalf("fresh create: want exactly one upstream create, got %d", f.creates)
	}
	// Create-only protocol: NO prompt is ever dispatched (spawn semantics stay
	// on /vh/spawn), and no permission watcher is armed (RegisterFailFast is
	// never called by this route — asserted structurally by perm tests).
	if len(f.prompts) != 0 {
		t.Fatalf("create route must never prompt, got %d prompts", len(f.prompts))
	}
}

func TestSessionCreateReplaySameSessionIDNoReexecute(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st1, out1, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-replay"}`, nil)
	if st1 != 200 {
		t.Fatalf("first create: want 200, got %d", st1)
	}
	st2, out2, h2 := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-replay"}`, nil)
	wantState(t, "replay create", st2, out2, 200, sessionCreateStateCreated)
	if out2["replayed"] != true {
		t.Fatalf("replay: replayed want true, got %v", out2["replayed"])
	}
	if out1["sessionID"] != out2["sessionID"] {
		t.Fatalf("replay must return the SAME session id: %v vs %v", out1["sessionID"], out2["sessionID"])
	}
	if h2.Get("X-VH-Idempotent-Replay") != "" {
		t.Fatal("create protocol must not set the legacy replay header (body boolean is the only marker)")
	}
	if f.creates != 1 {
		t.Fatalf("replay must not re-execute, got creates=%d", f.creates)
	}
}

func TestSessionCreateConcurrentSameKeyInFlight409(t *testing.T) {
	f := &fakeOC{}
	// Keep the original channel reference: the seam is one-shot (consumed by
	// the first create, which nils f.createHold), so closing f.createHold
	// itself would close a nil channel.
	hold := make(chan struct{})
	f.createHold = hold
	f.createEntered = make(chan struct{}, 1)
	web, _ := newVerbServer(t, f)

	type res struct {
		st  int
		out map[string]any
	}
	first := make(chan res, 1)
	go func() {
		st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-conc"}`, nil)
		first <- res{st, out}
	}()
	<-f.createEntered // the first create is parked inside upstream

	// Concurrent SAME-key duplicate → 409 in_flight (never a second execution).
	st2, out2, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-conc"}`, nil)
	wantState(t, "concurrent same-key", st2, out2, http.StatusConflict, sessionCreateStateInFlight)
	if out2["code"] != sessionCreateCodeInFlight {
		t.Fatalf("in-flight 409 code want %q, got %v", sessionCreateCodeInFlight, out2["code"])
	}

	// A DIFFERENT key proceeds normally while the first is held (conflict
	// isolation: one key's flight never blocks another key's create).
	st3, out3, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-other"}`, nil)
	wantState(t, "other key during flight", st3, out3, 200, sessionCreateStateCreated)

	close(hold)
	r1 := <-first
	wantState(t, "held create after release", r1.st, r1.out, 200, sessionCreateStateCreated)
	if r1.out["replayed"] != false {
		t.Fatalf("first (held) create is fresh, replayed want false, got %v", r1.out["replayed"])
	}
	if f.creates != 2 {
		t.Fatalf("want 2 creates (held + other), got %d", f.creates)
	}
}

func TestSessionCreateRecoveryHitReturnsIDWithoutReexecuting(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-rec"}`, nil)
	if st != 200 {
		t.Fatalf("create: want 200, got %d", st)
	}
	st2, out2, _ := getj(t, web.URL+"/vh/session/create/receipt?key=k-rec")
	wantState(t, "recovery hit", st2, out2, 200, sessionCreateStateCreated)
	if out2["replayed"] != true {
		t.Fatalf("recovery hit: replayed want true, got %v", out2["replayed"])
	}
	if out2["sessionID"] != out["sessionID"] {
		t.Fatalf("recovery hit must return the same id: %v vs %v", out2["sessionID"], out["sessionID"])
	}
	if f.creates != 1 {
		t.Fatalf("recovery hit must not re-execute, got creates=%d", f.creates)
	}
}

// TestSessionCreateRecoveryLookupMissNeverCreates is THE PRIMARY ACCEPTANCE
// GATE of the create-certainty protocol: a recovery-lookup miss causes ZERO
// upstream creates. Three miss classes are proven: a never-used key, an
// EXPIRED receipt (past the idemCache TTL), and an EVICTED/replaced receipt.
// The receipt GET must stay a pure lookup in all three — unlike
// WithIdempotency's execute-on-miss, recovery NEVER falls through to create.
func TestSessionCreateRecoveryLookupMissNeverCreates(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)

	// (a) Never-used key: pure miss, zero creates.
	st, out, _ := getj(t, web.URL+"/vh/session/create/receipt?key=never-used")
	wantState(t, "never-used key", st, out, http.StatusNotFound, sessionCreateStateUnavailable)
	if f.creates != 0 {
		t.Fatalf("GATE: lookup on a never-used key must not create, got creates=%d", f.creates)
	}

	// Mint a real receipt to mutate below.
	st, out, _ = post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-gate"}`, nil)
	if st != 200 || f.creates != 1 {
		t.Fatalf("setup create: st=%d creates=%d", st, f.creates)
	}
	key := sessionCreateCacheKey("", "k-gate")

	// (b) Expired receipt: honest miss, no silent re-execute via recovery.
	srv.idem.mu.Lock()
	if e, ok := srv.idem.done[key]; ok {
		e.at = time.Now().Add(-11 * time.Minute) // past the 10-minute TTL
		srv.idem.done[key] = e
	} else {
		srv.idem.mu.Unlock()
		t.Fatalf("GATE setup: receipt entry missing for %q", key)
	}
	srv.idem.mu.Unlock()
	st, out, _ = getj(t, web.URL+"/vh/session/create/receipt?key=k-gate")
	wantState(t, "expired receipt", st, out, http.StatusNotFound, sessionCreateStateUnavailable)
	if f.creates != 1 {
		t.Fatalf("GATE: lookup after expiry must not re-create, got creates=%d", f.creates)
	}

	// (c) Evicted/replaced receipt (e.g. cache cleared): honest miss again.
	srv.idem.mu.Lock()
	delete(srv.idem.done, key)
	srv.idem.mu.Unlock()
	st, out, _ = getj(t, web.URL+"/vh/session/create/receipt?key=k-gate")
	wantState(t, "evicted receipt", st, out, http.StatusNotFound, sessionCreateStateUnavailable)
	if f.creates != 1 {
		t.Fatalf("GATE: lookup after eviction must not re-create, got creates=%d", f.creates)
	}
}

// TestSessionCreatePostAfterExpiryReexecutes pins the DOCUMENTED asymmetry
// (see session_create.go's honest-tradeoff block): POST remains execute-on-miss
// like any idempotent verb — after the receipt expires, a same-key POST
// executes again. This is exactly why the Slice-2 client contract forbids
// re-POSTing an ambiguous operation and routes recovery through the receipt
// GET only.
func TestSessionCreatePostAfterExpiryReexecutes(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	st, _, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-asym"}`, nil)
	if st != 200 || f.creates != 1 {
		t.Fatalf("setup: st=%d creates=%d", st, f.creates)
	}
	key := sessionCreateCacheKey("", "k-asym")
	srv.idem.mu.Lock()
	if e, ok := srv.idem.done[key]; ok {
		e.at = time.Now().Add(-11 * time.Minute)
		srv.idem.done[key] = e
	}
	srv.idem.mu.Unlock()
	st2, out2, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-asym"}`, nil)
	wantState(t, "post after expiry", st2, out2, 200, sessionCreateStateCreated)
	if out2["replayed"] != false {
		t.Fatalf("post after expiry is a FRESH execution (replayed=false), got %v", out2["replayed"])
	}
	if f.creates != 2 {
		t.Fatalf("documented asymmetry: expired-key POST re-executes, want creates=2, got %d", f.creates)
	}
}

func TestSessionCreateUpstreamFailureStaysUnknown(t *testing.T) {
	f := &fakeOC{createStatus: http.StatusInternalServerError}
	web, _ := newVerbServer(t, f)
	body := `{"idempotency_key":"k-unk"}`
	st, out, _ := post(t, web.URL+"/vh/session/create", body, nil)
	wantState(t, "upstream failure", st, out, http.StatusAccepted, sessionCreateStateUnknown)
	if _, has := out["sessionID"]; has {
		t.Fatalf("unknown must NEVER carry a sessionID, got %v", out["sessionID"])
	}
	// Recovery lookup returns the cached unknown — still no id, still no create.
	st2, out2, _ := getj(t, web.URL+"/vh/session/create/receipt?key=k-unk")
	wantState(t, "unknown receipt", st2, out2, http.StatusAccepted, sessionCreateStateUnknown)
	if out2["replayed"] != true {
		t.Fatalf("unknown receipt: replayed want true, got %v", out2["replayed"])
	}
	// Even a same-key POST replays the cached unknown — the client that
	// (wrongly) re-POSTs must not trigger a second upstream create.
	st3, out3, _ := post(t, web.URL+"/vh/session/create", body, nil)
	wantState(t, "unknown replay POST", st3, out3, http.StatusAccepted, sessionCreateStateUnknown)
	if out3["replayed"] != true {
		t.Fatalf("unknown replay POST: replayed want true, got %v", out3["replayed"])
	}
	if f.creates != 1 {
		t.Fatalf("unknown must be cached (no second upstream create), got creates=%d", f.creates)
	}
}

func TestSessionCreateClientCancelStillCompletesReceipt(t *testing.T) {
	f := &fakeOC{}
	hold := make(chan struct{}) // original ref: the seam nils f.createHold on consumption
	f.createHold = hold
	f.createEntered = make(chan struct{}, 1)
	web, _ := newVerbServer(t, f)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		web.URL+"/vh/session/create", strings.NewReader(`{"idempotency_key":"k-cancel"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1")
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
	}()
	<-f.createEntered
	// The browser gives up mid-flight. The worker-owned create must NOT be
	// aborted by the disconnect (cancellation-independence).
	cancel()
	close(hold) // the upstream create now completes server-side

	deadline := time.Now().Add(3 * time.Second)
	for {
		st, out, _ := getj(t, web.URL+"/vh/session/create/receipt?key=k-cancel")
		if st == 200 && out["state"] == sessionCreateStateCreated {
			if out["replayed"] != true {
				t.Fatalf("post-cancel receipt: replayed want true, got %v", out["replayed"])
			}
			if f.creates != 1 {
				t.Fatalf("post-cancel: want exactly one create, got %d", f.creates)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("receipt never resolved to created after client cancel (last: %d %v)", st, out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSessionCreateRejectsUnsupportedParams(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)

	// prompt/parts/title/parentID/permission_policy are spawn semantics —
	// rejected BEFORE upstream, and the rejection is a CLAIMED receipt.
	st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-bad","prompt":"hi"}`, nil)
	wantState(t, "prompt rejected", st, out, http.StatusBadRequest, sessionCreateStateRejected)
	if f.creates != 0 {
		t.Fatalf("rejected request must never reach upstream, got creates=%d", f.creates)
	}
	st2, out2, _ := getj(t, web.URL+"/vh/session/create/receipt?key=k-bad")
	wantState(t, "rejected receipt", st2, out2, http.StatusBadRequest, sessionCreateStateRejected)
	if out2["replayed"] != true {
		t.Fatalf("rejected receipt: replayed want true, got %v", out2["replayed"])
	}
	// A same-key RETRY (even corrected) deterministically replays the
	// rejection — a corrected attempt must mint a NEW key (Slice 2 contract).
	st3, out3, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-bad"}`, nil)
	wantState(t, "rejected replay", st3, out3, http.StatusBadRequest, sessionCreateStateRejected)
	if out3["replayed"] != true || f.creates != 0 {
		t.Fatalf("rejected replay: replayed=%v creates=%d, want true/0", out3["replayed"], f.creates)
	}

	// permission_policy is refused the same way (no watcher can be armed).
	st4, out4, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-perm","permission_policy":"fail_fast"}`, nil)
	wantState(t, "permission_policy rejected", st4, out4, http.StatusBadRequest, sessionCreateStateRejected)

	// Missing key: unclaimable request → plain 400 envelope.
	st5, out5, _ := post(t, web.URL+"/vh/session/create", `{}`, nil)
	wantState(t, "missing key", st5, out5, http.StatusBadRequest, sessionCreateStateRejected)

	// Malformed JSON: plain 400 envelope.
	st6, out6, _ := post(t, web.URL+"/vh/session/create", `{not json`, nil)
	wantState(t, "malformed JSON", st6, out6, http.StatusBadRequest, sessionCreateStateRejected)

	if f.creates != 0 {
		t.Fatalf("no rejected shape may reach upstream, got creates=%d", f.creates)
	}
}

// TestSessionCreateReplayRefusesInadmissibleBody is the B1 regression: the
// replay short-circuit must never answer before v1 admissibility validation.
// A completed receipt for key K does not license a replay for an INADMISSIBLE
// body — re-POSTing K with an unsupported field is refused 400 at the boundary
// (no replayed created/unknown receipt, no execution, and no disturbance of the
// cached entry: recovery and a later admissible same-key POST still see the
// original outcome). The undisturbed entry may be created OR unknown.
func TestSessionCreateReplayRefusesInadmissibleBody(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)

	// (a) Created entry: create succeeds with key K (exactly one upstream)…
	st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-b1"}`, nil)
	wantState(t, "setup create", st, out, 200, sessionCreateStateCreated)
	if f.creates != 1 {
		t.Fatalf("setup: want exactly one upstream create, got %d", f.creates)
	}
	// …then re-POST the SAME key with an unsupported field: refused 400 with
	// the rejected body shape — NOT the cached created receipt.
	st2, out2, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-b1","prompt":"hi"}`, nil)
	wantState(t, "inadmissible replay", st2, out2, http.StatusBadRequest, sessionCreateStateRejected)
	if out2["replayed"] != false {
		t.Fatalf("inadmissible replay must not replay the created receipt, got replayed=%v", out2["replayed"])
	}
	if _, has := out2["sessionID"]; has {
		t.Fatalf("inadmissible replay must not leak the session id, got %v", out2["sessionID"])
	}
	if f.creates != 1 {
		t.Fatalf("inadmissible replay must not execute, got creates=%d", f.creates)
	}
	// The refusal is a pure boundary rejection: the cached created receipt is
	// UNDISTURBED (not overwritten with rejected) — recovery still resolves
	// the original id, and a later ADMISSIBLE same-key POST still replays it.
	st3, out3, _ := getj(t, web.URL+"/vh/session/create/receipt?key=k-b1")
	wantState(t, "receipt after refusal", st3, out3, 200, sessionCreateStateCreated)
	if out3["sessionID"] != out["sessionID"] || out3["replayed"] != true {
		t.Fatalf("receipt after refusal: want %v replayed=true, got %v", out["sessionID"], out3)
	}
	st4, out4, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-b1"}`, nil)
	wantState(t, "admissible replay after refusal", st4, out4, 200, sessionCreateStateCreated)
	if out4["replayed"] != true {
		t.Fatalf("admissible replay after refusal: replayed want true, got %v", out4["replayed"])
	}
	if f.creates != 1 {
		t.Fatalf("admissible replay after refusal must not execute, got creates=%d", f.creates)
	}

	// (b) Unknown entry: same refusal shape (neither created nor unknown may
	// replay for an inadmissible body, and neither may be overwritten).
	f2 := &fakeOC{createStatus: http.StatusInternalServerError}
	web2, _ := newVerbServer(t, f2)
	st5, out5, _ := post(t, web2.URL+"/vh/session/create", `{"idempotency_key":"k-b1u"}`, nil)
	wantState(t, "setup unknown", st5, out5, http.StatusAccepted, sessionCreateStateUnknown)
	st6, out6, _ := post(t, web2.URL+"/vh/session/create", `{"idempotency_key":"k-b1u","prompt":"hi"}`, nil)
	wantState(t, "inadmissible replay on unknown", st6, out6, http.StatusBadRequest, sessionCreateStateRejected)
	if out6["replayed"] != false {
		t.Fatalf("inadmissible replay on unknown: replayed want false, got %v", out6["replayed"])
	}
	if f2.creates != 1 {
		t.Fatalf("inadmissible replay on unknown must not execute, got creates=%d", f2.creates)
	}
	st7, out7, _ := getj(t, web2.URL+"/vh/session/create/receipt?key=k-b1u")
	wantState(t, "unknown receipt after refusal", st7, out7, http.StatusAccepted, sessionCreateStateUnknown)
}

// TestSessionCreateInadmissibleBodyDoesNotOpenProject is the tier1_b-F1
// regression: Agg(dir) must be deferred until a fresh ADMISSIBLE claim
// succeeds. For a previously-UNOPENED ?dir=, resolving the aggregator
// creates+starts it, opens the managed project, and launches RunManaged —
// external runtime activity that an inadmissible body's 400 must NOT trigger
// (the refusal must land BEFORE any such activity, not after it). Observable
// seam: SetAggHook, the production per-project callback aggFor fires exactly
// when a directory's aggregator is touched (default and lazily-created). Also
// proves the converse: an admissible fresh claim DOES resolve the aggregator
// exactly once, and a replay never re-resolves it.
func TestSessionCreateInadmissibleBodyDoesNotOpenProject(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)

	var hookMu sync.Mutex
	aggOpens := map[string]int{}
	srv.SetAggHook(func(dir string, _ *aggregator.Aggregator) {
		hookMu.Lock()
		aggOpens[dir]++
		hookMu.Unlock()
	})
	opens := func(dir string) int {
		hookMu.Lock()
		defer hookMu.Unlock()
		return aggOpens[dir]
	}

	// (a) NOVEL dir + inadmissible body (supported-param violation): 400 and
	// ZERO aggregator contact for that dir.
	st, out, _ := post(t, web.URL+"/vh/session/create?dir=/novel-f1", `{"idempotency_key":"k-f1","prompt":"x"}`, nil)
	wantState(t, "inadmissible novel dir", st, out, http.StatusBadRequest, sessionCreateStateRejected)
	if n := opens("/novel-f1"); n != 0 {
		t.Fatalf("inadmissible body must never resolve the novel dir's aggregator: aggHook fired %d time(s) for /novel-f1", n)
	}
	if f.creates != 0 {
		t.Fatalf("inadmissible body must never reach upstream, got creates=%d", f.creates)
	}

	// (b) Admissible fresh claim on another NOVEL dir: the aggregator IS
	// resolved — exactly once — on the admitted path only.
	st2, out2, _ := post(t, web.URL+"/vh/session/create?dir=/novel-f1-ok", `{"idempotency_key":"k-f1-ok"}`, nil)
	wantState(t, "admitted novel dir", st2, out2, 200, sessionCreateStateCreated)
	if n := opens("/novel-f1-ok"); n != 1 {
		t.Fatalf("admitted create must resolve the aggregator exactly once, aggHook fired %d time(s) for /novel-f1-ok", n)
	}
	if f.creates != 1 {
		t.Fatalf("admitted create: want exactly one upstream create, got %d", f.creates)
	}

	// (c) Replay of the admitted key: answered from the cache WITHOUT
	// re-resolving the aggregator (replay paths never call Agg).
	st3, out3, _ := post(t, web.URL+"/vh/session/create?dir=/novel-f1-ok", `{"idempotency_key":"k-f1-ok"}`, nil)
	wantState(t, "replay novel dir", st3, out3, 200, sessionCreateStateCreated)
	if out3["replayed"] != true {
		t.Fatalf("replay: replayed want true, got %v", out3["replayed"])
	}
	if n := opens("/novel-f1-ok"); n != 1 {
		t.Fatalf("replay must not re-resolve the aggregator, aggHook fired %d time(s) for /novel-f1-ok", n)
	}
	if f.creates != 1 {
		t.Fatalf("replay must not re-execute, got creates=%d", f.creates)
	}
}

func TestSessionCreateKeyNamespaces(t *testing.T) {
	f := &fakeOC{uniqueCreateIDs: true}
	web, _ := newVerbServer(t, f)

	// Route namespace: the SAME opaque key used on /vh/spawn (raw idemCache
	// key) and on the create protocol (namespaced key) are independent
	// operations — both execute.
	post(t, web.URL+"/vh/spawn", `{"idempotency_key":"shared"}`, nil)
	st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"shared"}`, nil)
	wantState(t, "create after spawn with same opaque key", st, out, 200, sessionCreateStateCreated)
	if f.creates != 2 {
		t.Fatalf("route namespaces must isolate: want 2 creates, got %d", f.creates)
	}

	// Directory namespace: the same key under two dirs mints two independent
	// receipts, each resolvable only under its own dir.
	stA, outA, _ := post(t, web.URL+"/vh/session/create?dir=/ns/a", `{"idempotency_key":"ns"}`, nil)
	stB, outB, _ := post(t, web.URL+"/vh/session/create?dir=/ns/b", `{"idempotency_key":"ns"}`, nil)
	if stA != 200 || stB != 200 {
		t.Fatalf("dir namespaces: want 200/200, got %d/%d", stA, stB)
	}
	if outA["sessionID"] == outB["sessionID"] {
		t.Fatalf("dir namespaces must mint independent receipts, both %v", outA["sessionID"])
	}
	stRA, outRA, _ := getj(t, web.URL+"/vh/session/create/receipt?key=ns&dir=/ns/a")
	if stRA != 200 || outRA["sessionID"] != outA["sessionID"] {
		t.Fatalf("receipt under dir A: want %v, got %d %v", outA["sessionID"], stRA, outRA["sessionID"])
	}
	// Cross-dir lookup is an honest miss (and never a create).
	createsBefore := f.creates
	stMiss, outMiss, _ := getj(t, web.URL+"/vh/session/create/receipt?key=ns&dir=/ns/c")
	wantState(t, "cross-dir miss", stMiss, outMiss, http.StatusNotFound, sessionCreateStateUnavailable)
	if f.creates != createsBefore {
		t.Fatalf("cross-dir miss must not create, got delta %d", f.creates-createsBefore)
	}
}

// TestSessionCreatePayloadConflict409 pins the identity-conflict branch via a
// white-box seed: a completed entry payload-bound to a DIFFERENT normalized
// payload (a future-v2 shape) conflicts with a v1 POST for the same key —
// rejected WITHOUT execution. Not reachable through the public v1 surface
// (every admissible POST normalizes to the same "{}"), which is why the seed
// is direct.
func TestSessionCreatePayloadConflict409(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	srv.idem.mu.Lock()
	srv.idem.done[sessionCreateCacheKey("", "k-cf")] = idemEntry{
		status: 200,
		body: jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateCreated, SessionID: "future_sess",
		}),
		at:      time.Now(),
		payload: `{"future":"v2"}`,
	}
	srv.idem.mu.Unlock()

	st, out, _ := post(t, web.URL+"/vh/session/create", `{"idempotency_key":"k-cf"}`, nil)
	wantState(t, "payload conflict", st, out, http.StatusConflict, sessionCreateStateRejected)
	if out["code"] != sessionCreateCodeConflict {
		t.Fatalf("conflict code want %q, got %v", sessionCreateCodeConflict, out["code"])
	}
	if f.creates != 0 {
		t.Fatalf("conflict must be rejected without execution, got creates=%d", f.creates)
	}
}

func TestSessionCreateMethodAndCSRFPosture(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)

	// GET on the mutating endpoint → 405, never a create.
	st, _, _ := getj(t, web.URL+"/vh/session/create")
	if st != http.StatusMethodNotAllowed {
		t.Fatalf("GET /vh/session/create: want 405, got %d", st)
	}
	// POST on the read-only receipt endpoint → 405.
	stp, _, _ := post(t, web.URL+"/vh/session/create/receipt?key=x", `{}`, nil)
	if stp != http.StatusMethodNotAllowed {
		t.Fatalf("POST receipt: want 405, got %d", stp)
	}
	// Receipt without a key → 400 envelope.
	stg, outg, _ := getj(t, web.URL+"/vh/session/create/receipt")
	wantState(t, "receipt missing key", stg, outg, http.StatusBadRequest, sessionCreateStateRejected)
	// POST without the CSRF header → 403 (guarded like every mutating /vh/*).
	resp, err := http.Post(web.URL+"/vh/session/create", "application/json", strings.NewReader(`{"idempotency_key":"k-csrf"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-CSRF create: want 403, got %d", resp.StatusCode)
	}
	if f.creates != 0 {
		t.Fatalf("method/CSRF rejections must never create, got creates=%d", f.creates)
	}
}

// TestSessionCreateUnregisteredSiblingServesSpaShell pins the E15
// compatibility fact Slice 2's capability discovery depends on: an
// UNREGISTERED capability URL (an unknown /vh path, e.g. a future version's
// route on a v1 server) falls through to the same-origin SPA shell HTML — not
// a JSON 404. (In cold-build tests the shell is the tracked placeholder
// banner; both it and a real build are text/html.)
func TestSessionCreateUnregisteredSiblingServesSpaShell(t *testing.T) {
	f := &fakeOC{}
	web, _ := newVerbServer(t, f)
	resp, err := http.Get(web.URL + "/vh/session/create/v9/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unregistered capability URL: want 200 (SPA shell), got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("unregistered capability URL: want text/html shell, got %q", ct)
	}
}
