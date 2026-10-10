package fixtures

// Reply-hold latch close-discipline tests (send-net-resilience cluster D,
// defer G2). The pre-fix defect: handleFixtureReplyHoldRelease and
// handleFixtureReplyHoldReset closed f.replyHoldWake while
// f.replyHoldParked stays TRUE until the woken parked handler re-acquires
// the mutex — a second release (double-click / e2e parallelization) or a
// reset arriving inside that window closed an ALREADY-CLOSED channel and
// panicked the process. The fix nils the channel under the same mutex when
// closing; these tests pin the corrected state machine (no double close,
// parked-flag transitions, posthumous payload retention) and drive the
// exact double-release / release-then-reset windows that used to panic.
//
// The double-release windows below are serialized deterministically with
// GOMAXPROCS(1): the two back-to-back handler calls run on THIS goroutine
// with no yield point between them, so the parked handler's post-wake
// re-lock cannot interleave — the second call deterministically observes
// parked=true (the pre-fix double-close condition).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

func armReplyHold(t *testing.T, f *FakeOpenCode, kind string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/fixture/reply-hold/arm", strings.NewReader(`{"kind":"`+kind+`"}`))
	f.handleFixtureReplyHoldArm(httptest.NewRecorder(), req)
}

func releaseReplyHold(t *testing.T, f *FakeOpenCode, mode string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/fixture/reply-hold/release", strings.NewReader(`{"mode":"`+mode+`"}`))
	rec := httptest.NewRecorder()
	f.handleFixtureReplyHoldRelease(rec, req)
	return rec
}

func resetReplyHold(t *testing.T, f *FakeOpenCode) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/fixture/reply-hold/reset", nil)
	f.handleFixtureReplyHoldReset(httptest.NewRecorder(), req)
}

// waitUntilParked blocks until the latch reports a parked handler (the park
// goroutine consumed the arm and blocked on the wake).
func waitUntilParked(t *testing.T, f *FakeOpenCode) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.replyHoldMu.Lock()
		p := f.replyHoldParked
		f.replyHoldMu.Unlock()
		if p {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("reply never parked")
		}
		time.Sleep(time.Millisecond)
	}
}

// parkInBackground parks a live (non-cancelled) reply handler in a
// background goroutine and returns a channel delivering its recorder once
// the handler returns. kind must match the armed latch kind.
func parkInBackground(t *testing.T, f *FakeOpenCode, kind, id string, apply func()) <-chan *httptest.ResponseRecorder {
	t.Helper()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/reply", nil).WithContext(context.Background())
		rec := httptest.NewRecorder()
		f.parkReplyHold(rec, req, kind, id, apply)
		done <- rec
	}()
	waitUntilParked(t, f)
	return done
}

// latchWakeIsNil asserts the corrected close discipline: a closed wake
// channel is nil'd under the mutex, so no path can close it again.
func latchWakeIsNil(f *FakeOpenCode) bool {
	f.replyHoldMu.Lock()
	defer f.replyHoldMu.Unlock()
	return f.replyHoldWake == nil
}

// TestFixtureReplyHoldDoubleReleaseNoDoubleClose drives the exact pre-fix
// panic window: release ×2 back-to-back while the parked handler has not yet
// re-locked. Pre-fix the second close(f.replyHoldWake) panicked the test
// binary; post-fix both releases answer ok and the wake is nil'd.
func TestFixtureReplyHoldDoubleReleaseNoDoubleClose(t *testing.T) {
	old := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(old)

	f := New()
	armReplyHold(t, f, "permission")
	done := parkInBackground(t, f, "permission", "dbl-1", func() {})

	r1 := releaseReplyHold(t, f, "pass")
	r2 := releaseReplyHold(t, f, "pass")
	if r1.Code != http.StatusOK || r2.Code != http.StatusOK {
		t.Fatalf("release ×2: want 200/200, got %d/%d", r1.Code, r2.Code)
	}
	if !latchWakeIsNil(f) {
		t.Fatal("release must nil the wake channel under the same mutex (double-close guard)")
	}

	// The parked handler completes with the pass posture (503, pending
	// intact) and clears the parked flag.
	select {
	case rec := <-done:
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("parked handler (pass posture): want 503, got %d", rec.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("parked handler never returned after release")
	}
	f.replyHoldMu.Lock()
	stillParked := f.replyHoldParked
	f.replyHoldMu.Unlock()
	if stillParked {
		t.Fatal("woken handler must clear replyHoldParked")
	}
}

// TestFixtureReplyHoldResetAfterReleaseNoDoubleClose drives the other
// pre-fix panic window: release (closes the wake) immediately followed by
// reset (which closed again while parked was still true).
func TestFixtureReplyHoldResetAfterReleaseNoDoubleClose(t *testing.T) {
	old := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(old)

	f := New()
	armReplyHold(t, f, "question")
	done := parkInBackground(t, f, "question", "rr-1", func() {})

	if r := releaseReplyHold(t, f, "pass"); r.Code != http.StatusOK {
		t.Fatalf("release: want 200, got %d", r.Code)
	}
	resetReplyHold(t, f) // pre-fix: close of the already-closed wake → panic

	select {
	case rec := <-done:
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("parked handler (pass posture): want 503, got %d", rec.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("parked handler never returned after reset")
	}
}

// TestFixtureReplyHoldApplyLifecycle pins the latch's corrected state
// machine end-to-end: park → release(apply) → applied + 200; then
// re-arm → park → ctx-dead → posthumous release(apply) applies the
// CAPTURED payload; reset is idempotent.
func TestFixtureReplyHoldApplyLifecycle(t *testing.T) {
	f := New()

	// Live park, apply posture.
	armReplyHold(t, f, "permission")
	applied := 0
	done := parkInBackground(t, f, "permission", "live-1", func() { applied++ })
	if r := releaseReplyHold(t, f, "apply"); r.Code != http.StatusOK {
		t.Fatalf("release(apply): want 200, got %d", r.Code)
	}
	select {
	case rec := <-done:
		if rec.Code != http.StatusOK {
			t.Fatalf("parked handler (apply posture): want 200, got %d", rec.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("parked handler never returned")
	}
	if applied != 1 {
		t.Fatalf("apply posture must run the captured apply exactly once (ran %d)", applied)
	}

	// Context-dead park keeps the captured payload for a POSTHUMOUS release.
	armReplyHold(t, f, "permission")
	ctx, cancel := context.WithCancel(context.Background())
	posthumousDone := make(chan bool, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/reply", nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		parked := f.parkReplyHold(rec, req, "permission", "dead-1", func() { applied++ })
		posthumousDone <- parked
	}()
	waitUntilParked(t, f)
	cancel()
	select {
	case <-posthumousDone:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx-dead park never returned")
	}
	f.replyHoldMu.Lock()
	idHeld := f.replyHoldID
	f.replyHoldMu.Unlock()
	if idHeld != "dead-1" {
		t.Fatalf("ctx-dead park must retain the captured id for posthumous release (got %q)", idHeld)
	}
	// Posthumous apply: the captured apply runs; the response says so.
	if r := releaseReplyHold(t, f, "apply"); r.Code != http.StatusOK {
		t.Fatalf("posthumous release(apply): want 200, got %d", r.Code)
	} else if !strings.Contains(r.Body.String(), `"posthumous":true`) {
		t.Fatalf("posthumous release must report posthumous:true, got %s", r.Body.String())
	}
	if applied != 2 {
		t.Fatalf("posthumous apply must run the captured apply (applied=%d)", applied)
	}

	// Reset with nothing parked: idempotent hygiene.
	resetReplyHold(t, f)
	resetReplyHold(t, f)
}
