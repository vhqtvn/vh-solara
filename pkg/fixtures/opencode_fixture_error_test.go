package fixtures

// API-level coverage for the /fixture/error endpoint (opencode.go
// handleFixtureError): the HTTP-drivable error-activity seam behind the
// TreeRow .dot.error e2e (web/tests/e2e/tree-row-dots.spec.ts). Extends the
// opencode_test.go seam (startFixtureHTTP + postJSON + countEvents) — the
// same in-process harness the /fixture/reset pins use. No busy/idle endpoint
// pin existed before this file; error gets one because it ADDS fixture
// surface (a new emit route), unlike busy/idle which were already pinned
// end-to-end by their e2e consumers.

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestFixtureErrorEndpoint pins the /fixture/error contract end to end at the
// fixture seam: query validation, response shape (busy/idle parity), the
// session.error terminal emit on the real /event bus, the no-busy-mirror
// hygiene, and the /fixture/reset pairing that clears the error state.
func TestFixtureErrorEndpoint(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)
	ch, unsub := f.subscribe()
	defer unsub()

	// 1. Validation: missing session -> 400 "missing session" — the exact
	//    busy/idle handler shape (handleFixtureBusy/handleFixtureIdle).
	resp, body := postJSON(t, srv, "/fixture/error", "")
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "missing session") {
		t.Fatalf("missing session: got %d/%q, want 400/\"missing session\"", resp.StatusCode, body)
	}

	// 2. Arm error: 200 + {"error":"demo"} — mirrors busy's {"busy":sid} and
	//    idle's {"idle":sid} response shape.
	resp, body = postJSON(t, srv, "/fixture/error?session=demo", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/fixture/error?session=demo: got %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), `"error":"demo"`) {
		t.Fatalf("/fixture/error body = %q, want {\"error\":\"demo\"}", body)
	}

	// 3. The emit: exactly one session.error for the session on the real
	//    /event bus (the event the aggregator store routes to
	//    setActivityLocked(sid, ActivityError) — the ONLY ActivityError
	//    source; a session.status type:"error" would normalize to idle).
	//    300ms is ample: emit fans out synchronously inside the handler,
	//    before writeJSON returns, so the payload is already buffered when
	//    postJSON returns.
	errs := countEvents(t, ch, time.Now().Add(300*time.Millisecond), `"session.error"`, `"demo"`)
	if errs != 1 {
		t.Fatalf("expected exactly 1 session.error for demo, got %d", errs)
	}

	// 4. Fixture-side hygiene: session.error mirrors NOTHING into the busy
	//    map (emit's terminal arm deletes; unlike busy, whose e2e stickiness
	//    depends on the /session/status mirror, error is never a statuses
	//    truth). Same-package read under the fixture lock.
	f.mu.Lock()
	_, mirrored := f.busy["demo"]
	f.mu.Unlock()
	if mirrored {
		t.Fatal("f.busy[\"demo\"] present after /fixture/error — session.error must not mirror a busy-map entry")
	}

	// 5. Reset pairing: /fixture/reset must clear the error state the way it
	//    clears busy — through its own session.idle fan-out (opencode.go
	//    handleFixtureReset), which the aggregator applies as an activity
	//    error→idle transition. Fixture-side there is no residual error state
	//    (step 4), so the idle emit IS the clear driver; assert it fired, and
	//    that the reset batch carries no session.error. Collect the batch
	//    ONCE and count both terminals inside it — a per-terminal countEvents
	//    window would drain a prohibited session.error while counting idles,
	//    leaving the later error window vacuously green.
	postJSON(t, srv, "/fixture/reset?session=demo", "")
	sawIdle, sawErr := false, 0
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case raw := <-ch:
			if !strings.Contains(raw, `"demo"`) {
				continue
			}
			if strings.Contains(raw, `"session.idle"`) {
				sawIdle = true
			}
			if strings.Contains(raw, `"session.error"`) {
				sawErr++
			}
		case <-time.After(200 * time.Millisecond):
		}
	}
	if !sawIdle {
		t.Fatal("expected the reset's session.idle for demo (the error→idle clear driver)")
	}
	if sawErr != 0 {
		t.Fatalf("reset must not emit session.error; saw %d inside the reset batch", sawErr)
	}
}
