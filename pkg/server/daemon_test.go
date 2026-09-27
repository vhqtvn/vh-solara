package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/vhqtvn/vh-solara/pkg/version"
)

// dialReq builds a GET for the worker WS endpoint with an optional worker
// version header. Tests that expect to get PAST the version guard must set a
// version the controller allows (at/above floor, or a dev shape like "test").
func dialReq(workerVersion string, set bool) *http.Request {
	req := httptest.NewRequest("GET", "/vh-solara/ws", nil)
	if set {
		req.Header.Set(version.HeaderWorkerVersion, workerVersion)
	}
	return req
}

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
		req := dialReq("test", true) // allowed version: isolates the secret guard
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
	req := dialReq("test", true)
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
	d.handleWorkerWS(rec, dialReq("test", true))
	if rec.Code == http.StatusUnauthorized {
		t.Errorf("no secret configured should not 401")
	}
}

// TestWorkerVersionGuardRefusalMatrix is the controller-side boundary matrix:
// a missing version header (pre-boundary worker) or a clean version below the
// floor is refused with 426 + a reason naming the floor; at/above-floor and
// dev-shaped versions ("dev"/"test"/make's "+dev" stamp) pass the version
// guard and proceed to the (here failing) WS upgrade.
func TestWorkerVersionGuardRefusalMatrix(t *testing.T) {
	d := NewDaemon(":0", ":0", "")

	for _, tc := range []struct {
		name    string
		version string
		set     bool
		refuse  bool
	}{
		{"no version header (old build)", "", false, true},
		{"empty version header", "", true, true},
		{"below floor 0.1.0 (old fielded worker)", "0.1.0", true, true},
		{"below floor 1.66.9", "1.66.9", true, true},
		{"prerelease of floor", "1.67.0-rc.1", true, true},
		{"at floor", "1.67.0", true, false},
		{"above floor", "1.68.3", true, false},
		{"v-prefixed above floor", "v1.68.3", true, false},
		{"dev build", "dev", true, false},
		{"test build", "test", true, false},
		{"make +dev stamp", "v1.66.3+dev", true, false},
	} {
		rec := httptest.NewRecorder()
		d.handleWorkerWS(rec, dialReq(tc.version, tc.set))
		if tc.refuse {
			if rec.Code != http.StatusUpgradeRequired {
				t.Errorf("%s: want 426, got %d (body %q)", tc.name, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), version.MinWorkerVersion) {
				t.Errorf("%s: refusal body must name the floor %q, got %q",
					tc.name, version.MinWorkerVersion, rec.Body.String())
			}
		} else if rec.Code == http.StatusUpgradeRequired {
			// Passed the version guard; only the non-WS upgrade may fail.
			t.Errorf("%s: should pass the version guard, got 426 (body %q)", tc.name, rec.Body.String())
		}
	}
}

// TestWorkerVersionGuardOrderingAfterSecret pins the guard ORDER: the secret
// check runs BEFORE the version check, so a wrong secret yields 401 even when
// the version is also refusing — auth before compatibility.
func TestWorkerVersionGuardOrderingAfterSecret(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	d.RegSecret = "topsecret"

	rec := httptest.NewRecorder()
	req := dialReq("0.1.0", true) // would 426 on its own
	req.Header.Set("X-VH-Worker-Secret", "nope")
	d.handleWorkerWS(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("bad secret + below-floor version: want 401 (secret guard first), got %d", rec.Code)
	}

	// And the mirrored case: correct secret + below-floor version ⇒ 426.
	rec = httptest.NewRecorder()
	req = dialReq("0.1.0", true)
	req.Header.Set("X-VH-Worker-Secret", "topsecret")
	d.handleWorkerWS(rec, req)
	if rec.Code != http.StatusUpgradeRequired {
		t.Errorf("correct secret + below-floor version: want 426, got %d", rec.Code)
	}
}

// TestControllerVersionAdvertisedOnWire pins that an allowed dial gets the
// controller's version stamped on the 101 upgrade response — the header whose
// absence makes workers refuse a pre-boundary controller. This performs a
// REAL gorilla dial against handleWorkerWS: the header must survive the
// actual hijack path (gorilla writes the 101 itself — only Upgrade's
// responseHeader argument reaches the wire, so a plain recorder cannot prove
// this).
func TestControllerVersionAdvertisedOnWire(t *testing.T) {
	for _, tc := range []struct {
		name string
		d    *Daemon
		want string
	}{
		{"explicit version", func() *Daemon { d := NewDaemon(":0", ":0", ""); d.Version = "1.68.2"; return d }(), "1.68.2"},
		{"NewDaemon default (dev)", NewDaemon(":0", ":0", ""), "dev"},
		{"literal zero-value Daemon", &Daemon{}, "dev"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(tc.d.handleWorkerWS))
		wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/vh-solara/ws"
		conn, resp, err := websocket.DefaultDialer.Dial(wsURL, dialHeaders("test"))
		if err != nil {
			srv.Close()
			t.Fatalf("%s: dial: %v", tc.name, err)
		}
		got := resp.Header.Get(version.HeaderControllerVersion)
		conn.Close()
		srv.Close()
		if got != tc.want {
			t.Errorf("%s: 101 response must advertise %q via %s, got %q",
				tc.name, tc.want, version.HeaderControllerVersion, got)
		}
	}
}

// dialHeaders builds the worker-dial header set with an allowed version —
// the shape every real worker now sends.
func dialHeaders(workerVersion string) http.Header {
	h := http.Header{}
	h.Set(version.HeaderWorkerVersion, workerVersion)
	return h
}
