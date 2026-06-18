package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestWorkerRegistrationSecret verifies the registration guard: with a secret
// configured, a wrong/missing X-VH-Worker-Secret is rejected before the upgrade,
// and a correct one passes the guard (the upgrade then fails only because the
// test request isn't a real WebSocket).
func TestWorkerRegistrationSecret(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	d.RegSecret = "topsecret"

	for _, tc := range []struct {
		name, secret string
		set          bool
	}{
		{"missing", "", false},
		{"wrong", "nope", true},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/vh-solara/ws", nil)
		if tc.set {
			req.Header.Set("X-VH-Worker-Secret", tc.secret)
		}
		d.handleWorkerWS(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s secret: want 401, got %d", tc.name, rec.Code)
		}
	}

	// Correct secret passes the guard (no 401); the non-WS upgrade then fails.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/vh-solara/ws", nil)
	req.Header.Set("X-VH-Worker-Secret", "topsecret")
	d.handleWorkerWS(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Errorf("correct secret should pass the guard, got 401")
	}
}

// TestOpenRegistrationWhenNoSecret confirms the historical behavior: with no
// RegSecret, registration is open (the guard doesn't 401).
func TestOpenRegistrationWhenNoSecret(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	rec := httptest.NewRecorder()
	d.handleWorkerWS(rec, httptest.NewRequest("GET", "/vh-solara/ws", nil))
	if rec.Code == http.StatusUnauthorized {
		t.Errorf("no secret configured should not 401")
	}
}
