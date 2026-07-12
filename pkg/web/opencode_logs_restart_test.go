package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// newTestServer builds a web Server backed by a dead OpenCode URL (the
// aggregator + reverse proxy are lazy, so construction never dials it). The
// caller wires the lifecycle (and optionally the restart hook) on the returned
// server before calling Handler().
func newTestServer(t *testing.T) *Server {
	t.Helper()
	const deadURL = "http://127.0.0.1:1"
	srv, err := NewServer(aggregator.New(deadURL, 100), deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv
}

// --- GET /vh/opencode/logs ---

// TestOpenCodeLogsOwned verifies that for an owned topology (HasLogTail=true),
// the endpoint returns the ring tail as text/plain with a 200 status. Data
// written to the lifecycle ring (via Ring().Append) must appear in the response.
func TestOpenCodeLogsOwned(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	life.Ring().Append("line one\n")
	life.Ring().Append("line two\n")

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode/logs")
	if err != nil {
		t.Fatalf("GET /vh/opencode/logs: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "line one") || !strings.Contains(string(body), "line two") {
		t.Errorf("body = %q, want both log lines", string(body))
	}
}

// TestOpenCodeLogsMaxParam verifies the ?max= query param bounds the response.
// Writing 8192 bytes and requesting ?max=100 must yield exactly 100 bytes
// (the last 100). The default (no ?max) yields at most ocLogMaxDefault (4096).
func TestOpenCodeLogsMaxParam(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	// Write 8192 bytes of recognisable content (a repeating marker). The last
	// 100 bytes are the tail we expect from ?max=100.
	payload := strings.Repeat("x", 8192)
	life.Ring().Append(payload)

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// ?max=100 → exactly 100 bytes.
	res, err := http.Get(web.URL + "/vh/opencode/logs?max=100")
	if err != nil {
		t.Fatalf("GET ?max=100: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if len(body) != 100 {
		t.Errorf("?max=100 body len = %d, want 100", len(body))
	}

	// No ?max → default 4096 (the last 4096 of the 8192-byte payload).
	res2, err := http.Get(web.URL + "/vh/opencode/logs")
	if err != nil {
		t.Fatalf("GET (default max): %v", err)
	}
	defer res2.Body.Close()
	body2, _ := io.ReadAll(res2.Body)
	if len(body2) != ocLogMaxDefault {
		t.Errorf("default body len = %d, want %d", len(body2), ocLogMaxDefault)
	}
}

// TestOpenCodeLogsExternal verifies that an external topology (HasLogTail=false)
// gets an honest 501 with a JSON error, NOT fake data or an empty 200.
func TestOpenCodeLogsExternal(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyExternal)
	life.SetUnknown()
	srv.SetOpenCodeLifecycle(life)

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode/logs")
	if err != nil {
		t.Fatalf("GET /vh/opencode/logs: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", res.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body["error"] == "" {
		t.Error("error field is empty; want a topology explanation")
	}
}

// TestOpenCodeLogsNilLifecycle verifies the fixture/local-mode posture: a
// server with no lifecycle wired returns 503, not a nil-deref panic.
func TestOpenCodeLogsNilLifecycle(t *testing.T) {
	srv := newTestServer(t)
	// Deliberately do NOT call SetOpenCodeLifecycle.
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode/logs")
	if err != nil {
		t.Fatalf("GET /vh/opencode/logs: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
}

// --- POST /vh/opencode/restart ---

// TestOpenCodeRestartOwned verifies that for an owned topology (CanRestart=true)
// with a restart hook wired, a CSRF-tagged POST triggers the hook and returns
// 200 with the post-restart Snapshot. The hook simulates the lifecycle
// transitions the real restartOpencodeLocked performs (starting → ready).
func TestOpenCodeRestartOwned(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	hookCalled := false
	srv.SetRestartOpenCode(func(ctx context.Context) error {
		hookCalled = true
		life.SetStarting()
		life.SetReady()
		return nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
	req.Header.Set("X-VH-CSRF", "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if !hookCalled {
		t.Error("restart hook was not called")
	}
	var snap oclife.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snap.State != oclife.StateReady {
		t.Errorf("snapshot state = %q, want %q", snap.State, oclife.StateReady)
	}
}

// TestOpenCodeRestartExternal verifies that an external topology (CanRestart=false)
// gets a 405 with a JSON error, NOT a deferred failure from the restart hook.
func TestOpenCodeRestartExternal(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyExternal)
	life.SetUnknown()
	srv.SetOpenCodeLifecycle(life)

	// Wire a hook that would fail if called — the capability check must fire
	// BEFORE it, so this proves the 405 is from the capability guard, not a
	// hook error.
	srv.SetRestartOpenCode(func(ctx context.Context) error {
		t.Error("restart hook should not be called for external topology")
		return nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
	req.Header.Set("X-VH-CSRF", "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", res.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body["error"] == "" {
		t.Error("error field is empty; want a topology explanation")
	}
}

// TestOpenCodeRestartNilLifecycle verifies the fixture/local-mode posture: a
// server with no lifecycle wired returns 503.
func TestOpenCodeRestartNilLifecycle(t *testing.T) {
	srv := newTestServer(t)
	// Deliberately do NOT call SetOpenCodeLifecycle.
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
	req.Header.Set("X-VH-CSRF", "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
}

// TestOpenCodeRestartNoCSRF verifies that a POST without the X-VH-CSRF header
// is rejected by csrfGuard with 403 before reaching the handler. This is the
// CSRF protection contract for state-changing /vh/* verbs.
func TestOpenCodeRestartNoCSRF(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	srv.SetRestartOpenCode(func(ctx context.Context) error {
		t.Error("restart hook should not be called without CSRF header")
		return nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// POST WITHOUT the X-VH-CSRF header.
	res, err := http.Post(web.URL+"/vh/opencode/restart", "text/plain", nil)
	if err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403 (CSRF)", res.StatusCode)
	}
}

// TestOpenCodeRestartError verifies that when the restart hook returns an error,
// the endpoint responds 500 with the error message. The lifecycle is expected to
// be in the "failed" state (set by the real restartOpencodeLocked); this test
// only checks the HTTP contract.
func TestOpenCodeRestartError(t *testing.T) {
	srv := newTestServer(t)
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	srv.SetRestartOpenCode(func(ctx context.Context) error {
		life.SetFailed("simulated restart failure", nil)
		return errSimulatedRestart
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
	req.Header.Set("X-VH-CSRF", "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.StatusCode)
	}
}

var errSimulatedRestart = &simulatedErr{"simulated restart failure"}

type simulatedErr struct{ msg string }

func (e *simulatedErr) Error() string { return e.msg }
