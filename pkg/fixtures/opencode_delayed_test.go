package fixtures

// DelayedPersist + SimulateRestart fixture tests (send-net-resilience
// slice 2a): the two new fixture capabilities the resilience e2e relies on —
//
//   - DelayedPersist: prompt_async answers 204 IMMEDIATELY and commits the
//     user message only after a controlled delay — the observable
//     "2xx-but-not-persisted-yet" window (exact-GET 404 before the delay,
//     200 after; caller-id-wins holds);
//   - SimulateRestart before the commit: the pending delayed commit VANISHES
//     (the un-flushed write-ahead model — post-restart-404 topology), while
//     already-committed messages SURVIVE.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// waitFor polls cond every 10ms until it returns true or the deadline passes
// (failure).
func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition never became true: %s (waited %s)", what, timeout)
}

func TestPromptAsyncDelayedPersistCommitsAfterDelay(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncDelayedPersist)
	f.SetPromptAsyncPersistDelay(150 * time.Millisecond)
	srv := startFixtureHTTP(t, f)

	const sid = "dly-1"
	const mid = "msg_delayedpersist01"
	body := `{"parts":[{"type":"text","text":"later"}],"messageID":` + jsonQuote(mid) + `}`

	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("prompt_async: got %d want 204 IMMEDIATELY (persistence is async)", resp.StatusCode)
	}

	// Inside the delay window: nothing persisted, exact-GET 404s.
	if n := f.UserMessageCount(sid); n != 0 {
		t.Fatalf("UserMessageCount during delay = %d, want 0", n)
	}
	gr, _ := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("exact-GET during delay = %d, want 404", gr.StatusCode)
	}

	// After the delay: committed under the caller's EXACT id, exact-GET 200s.
	waitFor(t, "delayed commit", 2*time.Second, func() bool { return f.UserMessageCount(sid) == 1 })
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET after delay = %d, want 200 (body=%s)", gr.StatusCode, gb)
	}
	var got struct {
		Info struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"info"`
	}
	if err := json.Unmarshal(gb, &got); err != nil {
		t.Fatal(err)
	}
	if got.Info.ID != mid || got.Info.Role != "user" {
		t.Fatalf("caller-id-wins after delayed commit: got info{ID:%q Role:%q}", got.Info.ID, got.Info.Role)
	}
}

func TestPromptAsyncDelayedPersistRestartVanishesBeforeCommit(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncDelayedPersist)
	f.SetPromptAsyncPersistDelay(200 * time.Millisecond)
	srv := startFixtureHTTP(t, f)

	const sid = "dly-2"
	const mid = "msg_restartvanish02"
	body := `{"parts":[{"type":"text","text":"doomed"}],"messageID":` + jsonQuote(mid) + `}`

	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("prompt_async: got %d want 204", resp.StatusCode)
	}

	// Restart BEFORE the delay elapses: the pending commit is un-flushed
	// write-ahead state and MUST vanish.
	f.SimulateRestart()

	// Wait WELL past the original delay: the commit must never land.
	time.Sleep(400 * time.Millisecond)
	if n := f.UserMessageCount(sid); n != 0 {
		t.Fatalf("UserMessageCount after restart+delay = %d, want 0 (pending commit must vanish)", n)
	}
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("exact-GET after restart = %d, want PERMANENT 404 (body=%s)", gr.StatusCode, gb)
	}
}

func TestPromptAsyncDelayedPersistResetDiscardsPendingCommit(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncDelayedPersist)
	f.SetPromptAsyncPersistDelay(200 * time.Millisecond)
	srv := startFixtureHTTP(t, f)

	const sid = "dly-4"
	const mid = "msg_resetdiscard04"
	body := `{"parts":[{"type":"text","text":"stale"}],"messageID":` + jsonQuote(mid) + `}`

	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("prompt_async: got %d want 204", resp.StatusCode)
	}

	// /fixture/reset BEFORE the delay elapses: the baseline is restored (here:
	// no baseline, so an empty transcript) and resetGen bumps. The pending
	// delayed commit belongs to the PRE-reset world and must be discarded —
	// landing it would re-pollute the restored transcript with no
	// message.removed to clear it (defer-delayedpersist-resetgen-fence).
	resetViaHTTP(t, srv, sid)

	// Wait WELL past the original delay: the commit must never land.
	time.Sleep(400 * time.Millisecond)
	if n := f.UserMessageCount(sid); n != 0 {
		t.Fatalf("UserMessageCount after reset+delay = %d, want 0 (pending commit must be discarded on reset)", n)
	}
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusNotFound {
		t.Fatalf("exact-GET after reset = %d, want PERMANENT 404 (body=%s)", gr.StatusCode, gb)
	}
}

// TestPromptAsyncDelayedPersistCommitWithoutResetStillLands is the control for
// the resetGen fence: with NO reset in flight the captured generation still
// matches after the delay, so the commit lands normally (the fence must not
// over-discard).
func TestPromptAsyncDelayedPersistCommitWithoutResetStillLands(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncDelayedPersist)
	f.SetPromptAsyncPersistDelay(60 * time.Millisecond)
	srv := startFixtureHTTP(t, f)

	const sid = "dly-5"
	const mid = "msg_noreset05"
	body := `{"parts":[{"type":"text","text":"fresh"}],"messageID":` + jsonQuote(mid) + `}`

	resp, _ := postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("prompt_async: got %d want 204", resp.StatusCode)
	}

	waitFor(t, "commit without reset", 2*time.Second, func() bool { return f.UserMessageCount(sid) == 1 })
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET without reset = %d, want 200 (body=%s)", gr.StatusCode, gb)
	}
}

// resetViaHTTP drives the real POST /fixture/reset?session=<sid> handler.
func resetViaHTTP(t *testing.T, srv *httptest.Server, sid string) {
	t.Helper()
	resp, _ := postJSON(t, srv, "/fixture/reset?session="+url.QueryEscape(sid), "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fixture reset: got %d want 200", resp.StatusCode)
	}
}

func TestPromptAsyncSimulateRestartPreservesCommitted(t *testing.T) {
	f := New()
	f.SetPromptAsyncMode(PromptAsyncDelayedPersist)
	f.SetPromptAsyncPersistDelay(20 * time.Millisecond)
	srv := startFixtureHTTP(t, f)

	const sid = "dly-3"
	const mid = "msg_committedsurv03"
	body := `{"parts":[{"type":"text","text":"keep"}],"messageID":` + jsonQuote(mid) + `}`
	postJSON(t, srv, "/session/"+sid+"/prompt_async", body)
	waitFor(t, "commit", 2*time.Second, func() bool { return f.UserMessageCount(sid) == 1 })

	// Restart AFTER the commit: the durable store survives.
	f.SimulateRestart()
	gr, gb := get(t, srv, "/session/"+sid+"/message/"+mid)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("exact-GET for a COMMITTED message after restart = %d, want 200 (body=%s)", gr.StatusCode, gb)
	}
	if n := f.UserMessageCount(sid); n != 1 {
		t.Fatalf("UserMessageCount after restart = %d, want 1 (committed survives)", n)
	}
}
